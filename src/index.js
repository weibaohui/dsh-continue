'use strict'

/**
 * dsh-plugin-dsh-continue — Host half
 *
 * Auto-resume interrupted agent runs. When a session's turn ends in a
 * transport/connection error (`turn/end` reason `error`) or is closed as a
 * crash-orphan (`interrupted`), the plugin re-sends the configured prompt
 * (default "继续") to the SAME live session via `agent.followup(...)`, so a
 * flapping transport no longer forces the user to type 继续 by hand.
 *
 * Idempotency stays the agent's own responsibility — its system prompt
 * already forces "an interrupted tool call with no recorded result is only
 * retried when read-only/idempotent; otherwise verify external state first".
 * This plugin therefore owns only the STRUCTURAL guardrails: per-session
 * attempt cap, cooldown, exponential backoff, and turn/start cancellation of
 * any pending continue (so a user-typed 继续 or agent-resumed turn is never
 * doubled). It does NOT classify tools as read/write; that judgment is the
 * agent's.
 *
 * Detection rides the process-wide `session/event` stream (the same channel
 * hermes-loop uses). Audit trail is a self-owned JSONL ledger at
 * `$DSH_HOME/dsh-continue/activity.jsonl` — `ctx.logger` is filtered by the
 * host's log exporters and cannot serve as the ledger.
 */

const { randomUUID } = require('node:crypto')
const fsP = require('node:fs/promises')
const { join, resolve, sep } = require('node:path')
const { homedir } = require('node:os')
// settings 服务要求 schemastery schema（可调用 + toJSON；zod 不兼容，register 会抛错被吞）。
// 宿主沙箱内解析打包依赖可能抛 ERR_INTERNAL_ASSERTION（.pnpm 软链），因此优先沿
// dsh 全局安装取 settings 服务自用的那份副本，本地开发/测试再退回标准 require。
function loadSchemastery() {
  const errors = []
  const { createRequire } = require('node:module')
  for (const prefix of [process.env.DSH_GLOBAL_PREFIX, join(homedir(), '.local')].filter(Boolean)) {
    const hostCopy = join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.cjs')
    try { return createRequire(hostCopy)(hostCopy) } catch (e) { errors.push(String(e && e.code || e)) }
  }
  try { return require('@deepseek-ai/schemastery') } catch (e) { errors.push(String(e && e.code || e)) }
  if (process.env.DSHCONTINUE_DEBUG) console.warn(`[dsh-continue] schemastery unavailable: ${errors.join(' | ')}`)
  return null
}
const Schema = loadSchemastery()

const MAX_BODY_BYTES = 64 * 1024
const ACTIVITY_TAIL_LINES = 30
const PERSESSION_TAIL = 20

const DEFAULTS = {
  enabled: true,
  prompt: '继续',
  maxAttempts: 3,        // per session, within one failure cluster; reset on a completed turn
  cooldownMs: 5000,      // min gap between continues for the same session
  backoffBaseMs: 2000,   // base * 2^attempt (attempt = count before this continue)
  backoffMaxMs: 30000,
  retryOnError: true,
  retryOnInterrupted: true,
  notifyOnCap: true,     // post a plugin notice into the source session when cap reached
}

// ── Shared helpers (ported from dsh-sync / hermes-loop so conventions match) ──

function dshHome() { return process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh') }

function displayPath(p) {
  const home = homedir()
  if (p === home) return '~'
  if (p.startsWith(home + sep)) return '~' + p.slice(home.length)
  return p
}

function readJsonBody(req) {
  return new Promise((fulfil, reject) => {
    let size = 0, chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) { reject(new Error('request body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { fulfil(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch (error) { reject(new Error(`invalid JSON body: ${error && error.message}`)) }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

async function atomicWriteFile(file, content) {
  await fsP.mkdir(join(file, '..'), { recursive: true })
  const temp = join(join(file, '..'), `.${randomUUID()}.tmp`)
  await fsP.writeFile(temp, content)
  await fsP.rename(temp, file)
}

/**
 * Audit/activity trail: append one JSON line per event to the given jsonl
 * file. Plugin `ctx.logger` output is filtered by the host's log exporters,
 * so the plugin keeps its own record (same pattern as hermes-loop).
 * Rolling truncation: over 512KB keep the tail 2000 lines so boot rescan and
 * panel polling stay fast as the ledger ages.
 */
function makeTracer(file) {
  const MAX_BYTES = 512 * 1024
  const KEEP_LINES = 2000
  let approxSize = -1 // -1 = 未测量，首次 append 后 stat 校准
  return (event, data = {}) => {
    const line = JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n'
    fsP.mkdir(join(file, '..'), { recursive: true })
      .then(() => fsP.appendFile(file, line, 'utf8'))
      .then(() => {
        if (approxSize < 0) { approxSize = 0; fsP.stat(file).then((s) => { approxSize = s.size }).catch(() => {}); return }
        approxSize += line.length
        if (approxSize <= MAX_BYTES) return
        approxSize = 0
        return fsP.readFile(file, 'utf8')
          .then((raw) => atomicWriteFile(file, raw.trimEnd().split('\n').slice(-KEEP_LINES).join('\n') + '\n'))
      })
      .catch(() => {})
  }
}

async function readActivityTail(file, n = ACTIVITY_TAIL_LINES) {
  try {
    const raw = await fsP.readFile(file, 'utf8')
    const lines = raw.trimEnd().split('\n').filter(Boolean)
    const tail = lines.slice(-n)
    const out = []
    for (const l of tail) { try { out.push(JSON.parse(l)) } catch {} }
    return out
  } catch { return [] }
}

// ── Pure decision helpers (unit-tested via __internals) ──────────────────

/** `turn/end` reason arrives as `{kind: 'completed'}`; tolerate a bare string. */
function reasonKind(reason) {
  if (reason === null || reason === undefined) return undefined
  if (typeof reason === 'string') return reason
  if (typeof reason === 'object' && typeof reason.kind === 'string') return reason.kind
  return undefined
}

/** Whether this turn/end reason is one we auto-continue on. */
function shouldRetry(kind, eff) {
  if (kind === 'error') return eff.retryOnError !== false
  if (kind === 'interrupted') return eff.retryOnInterrupted !== false
  return false
}

/** Exponential backoff for the upcoming continue (attempt = pre-increment count). */
function computeBackoff(attempt, eff) {
  const base = Math.max(0, Number(eff.backoffBaseMs) || 0)
  const max = Math.max(0, Number(eff.backoffMaxMs) || 0) // hard ceiling, even if base > max
  const exp = base * Math.pow(2, Math.max(0, attempt))
  const clamped = Math.min(exp, max)
  const jitter = clamped * 0.2 * Math.random() // +0..20% (de-synchronize concurrent retries)
  return Math.round(clamped + jitter)
}

/** Cooldown gate: true if no prior continue, or enough time has passed. */
function withinCooldown(now, lastAt, eff) {
  if (lastAt === null || lastAt === undefined) return true
  const cd = Math.max(0, Number(eff.cooldownMs) || 0)
  return (now - lastAt) >= cd
}

const EXCLUDE_ID_PREFIXES = ['hermes-loop-review-']

/** Sessions we never auto-continue: subagent-origin (parent owns delegation)
 *  and known background-review agent ids. */
function isExcluded(session) {
  if (!session) return true
  const sid = session.id
  if (typeof sid !== 'string' || sid === '') return true
  for (const p of EXCLUDE_ID_PREFIXES) if (sid.startsWith(p)) return true
  if (session.header && session.header.origin === 'subagent') return true
  return false
}

/** Fresh per-session state. */
function newSessionState() {
  return { attempts: 0, lastContinueAt: null, lastTurn: null, toolCalls: 0, toolResults: 0, timer: null }
}

/**
 * Pure decision for a `turn/end` event. Returns the action apply should take:
 *  - {type:'reset'}               completed → zero attempts, clear pending
 *  - {type:'schedule', delay, attempt}  send 继续 after `delay`; will be attempt #`attempt`
 *  - {type:'cap'}                 attempt cap reached → stop + optionally notify
 *  - {type:'skip', reason}        not retryable / pending / cooldown
 *  - {type:'noop'}                kind unknown
 */
function decideTurnEnd(st, kind, eff, now) {
  if (kind === 'completed') return { type: 'reset' }
  if (kind === undefined) return { type: 'noop' }
  if (!shouldRetry(kind, eff)) return { type: 'skip', reason: 'reason-not-retryable', kind }
  if (st.timer !== null) return { type: 'skip', reason: 'pending' }
  if (st.attempts >= eff.maxAttempts) return { type: 'cap' }
  if (!withinCooldown(now, st.lastContinueAt, eff)) return { type: 'skip', reason: 'cooldown' }
  return { type: 'schedule', delay: computeBackoff(st.attempts, eff), attempt: st.attempts + 1 }
}

/** Build a sanitized settings patch from a raw PUT body (typed, lenient). */
function sanitizePatch(body) {
  const patch = {}
  if (body == null || typeof body !== 'object') return patch
  if (typeof body.prompt === 'string' && body.prompt !== '') patch.prompt = body.prompt
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
  if (typeof body.maxAttempts === 'number' && body.maxAttempts >= 1) patch.maxAttempts = body.maxAttempts
  if (typeof body.cooldownMs === 'number' && body.cooldownMs >= 0) patch.cooldownMs = body.cooldownMs
  if (typeof body.backoffBaseMs === 'number' && body.backoffBaseMs >= 0) patch.backoffBaseMs = body.backoffBaseMs
  if (typeof body.backoffMaxMs === 'number' && body.backoffMaxMs >= 1000) patch.backoffMaxMs = body.backoffMaxMs
  if (typeof body.retryOnError === 'boolean') patch.retryOnError = body.retryOnError
  if (typeof body.retryOnInterrupted === 'boolean') patch.retryOnInterrupted = body.retryOnInterrupted
  if (typeof body.notifyOnCap === 'boolean') patch.notifyOnCap = body.notifyOnCap
  return patch
}

function settingsSchema() {
  if (!Schema) return null
  return Schema.object({
    enabled: Schema.boolean().default(true),
    prompt: Schema.string().default('继续'),
    maxAttempts: Schema.number().min(1).default(3),
    cooldownMs: Schema.number().min(0).default(5000),
    backoffBaseMs: Schema.number().min(0).default(2000),
    backoffMaxMs: Schema.number().min(1000).default(30000),
    retryOnError: Schema.boolean().default(true),
    retryOnInterrupted: Schema.boolean().default(true),
    notifyOnCap: Schema.boolean().default(true),
  })
}

module.exports = {
  name: 'dsh-continue',
  inject: ['agents', 'settings', 'webServer'],
  __internals: {
    reasonKind, shouldRetry, computeBackoff, withinCooldown, isExcluded,
    decideTurnEnd, sanitizePatch, newSessionState, readActivityTail,
    DEFAULTS, dshHome, EXCLUDE_ID_PREFIXES, settingsSchema,
  },

  apply(ctx, config = {}) {
    const dh = dshHome()
    const pluginDir = join(dh, 'dsh-continue')
    const activityFile = join(pluginDir, 'activity.jsonl')
    const trace = makeTracer(activityFile)
    trace('armed', { pid: process.pid, config: { ...DEFAULTS, ...config } })

    // ── Settings namespace (schemastery; zod is incompatible) ──
    // 命名空间必须匹配 /^[a-z][a-z0-9-]*$/ —— 点号形式会被 settings 写入通道拒绝
    const SETTINGS_NS = 'dsh-continue'
    let settingsScope = null
    const settingsOverrides = {}
    const schema = settingsSchema()
    if (schema && ctx.settings && typeof ctx.settings.register === 'function') {
      try {
        settingsScope = ctx.settings.register(SETTINGS_NS, schema, { base: { ...DEFAULTS, ...config } })
        trace('settings-registered', {})
      } catch (e) {
        trace('settings-register-failed', { message: String(e && e.message || e) })
        ctx.logger.warn(`dsh-continue: settings register: ${e && e.message}`)
      }
    } else {
      trace('settings-register-skipped', { schema: Boolean(schema), settingsType: typeof ctx.settings })
    }
    const effective = () => {
      if (settingsScope && typeof settingsScope.get === 'function') {
        const v = settingsScope.get()
        if (v && typeof v === 'object') return { ...DEFAULTS, ...config, ...v }
      }
      return { ...DEFAULTS, ...config, ...settingsOverrides }
    }
    const safeSettings = (eff) => ({
      enabled: eff.enabled, prompt: eff.prompt, maxAttempts: eff.maxAttempts,
      cooldownMs: eff.cooldownMs, backoffBaseMs: eff.backoffBaseMs, backoffMaxMs: eff.backoffMaxMs,
      retryOnError: eff.retryOnError, retryOnInterrupted: eff.retryOnInterrupted, notifyOnCap: eff.notifyOnCap,
    })

    // ── Per-session state ──
    const states = new Map()
    const stateFor = (sid) => {
      let st = states.get(sid)
      if (!st) { st = newSessionState(); states.set(sid, st) }
      return st
    }

    const cancelTimer = (st) => {
      if (st.timer !== null) { try { clearTimeout(st.timer) } catch {} ; st.timer = null }
    }

    const notifyCap = (session, eff) => {
      if (!eff.notifyOnCap) return
      if (!session || typeof session.append !== 'function') return
      try {
        const summary = `自动续跑已达上限（${eff.maxAttempts} 次），请人工介入`
        session.append('user/message', {
          content: [{ type: 'text', text: summary }],
          source: { kind: 'plugin', plugin: 'dsh-continue', form: 'notice', summary },
        })
      } catch (e) { trace('notify-failed', { message: String(e && e.message) }) }
    }

    const scheduleContinue = (session, st, eff, kind, unpaired) => {
      const sid = session && session.id
      const delay = computeBackoff(st.attempts, eff)
      const attempt = st.attempts + 1
      st.timer = setTimeout(() => {
        st.timer = null
        const agent = ctx.agents && typeof ctx.agents.get === 'function' ? ctx.agents.get(sid) : undefined
        if (!agent || typeof agent.followup !== 'function') {
          trace('skip', { reason: 'not-live', sessionId: sid, attempt })
          return
        }
        const message = {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: String(eff.prompt) }],
          source: { kind: 'plugin', plugin: 'dsh-continue' },
        }
        try {
          agent.followup(message)
          st.attempts = attempt
          st.lastContinueAt = Date.now()
          trace('continue-sent', { sessionId: sid, attempt, prompt: eff.prompt, trigger: kind, unpaired })
        } catch (e) {
          trace('continue-failed', { sessionId: sid, attempt, message: String(e && e.message) })
        }
      }, delay)
      if (typeof st.timer.unref === 'function') st.timer.unref()
      trace('scheduled', { sessionId: sid, attempt, delay, trigger: kind, unpaired })
    }

    // ── Event handler ──
    const onSessionEvent = (session, event) => {
      try {
        const eff = effective()
        if (!eff.enabled) return
        if (!ctx.agents || typeof ctx.agents.get !== 'function') return
        if (isExcluded(session)) return
        const sid = session.id
        if (typeof sid !== 'string') return
        const st = stateFor(sid)

        if (event.type === 'turn/start') {
          // 用户/agent 已自启新一轮：取消挂起的续跑，避免双发；本轮工具计数清零
          cancelTimer(st)
          st.toolCalls = 0
          st.toolResults = 0
          return
        }
        if (event.type === 'tool/call') {
          st.toolCalls += 1
          return
        }
        if (event.type === 'tool/result') {
          st.toolResults += 1
          return
        }
        if (event.type !== 'turn/end') return

        const kind = reasonKind(event.data && event.data.reason)
        const turn = event.data && event.data.turn
        const unpaired = Math.max(0, st.toolCalls - st.toolResults)
        st.lastTurn = turn

        const action = decideTurnEnd(st, kind, eff, Date.now())
        if (action.type === 'reset') {
          if (st.attempts !== 0 || st.timer !== null) {
            trace('settle', { sessionId: sid, kind, attempts: st.attempts, unpaired })
          }
          cancelTimer(st)
          st.attempts = 0
          st.toolCalls = 0
          st.toolResults = 0
          return
        }
        if (action.type === 'schedule') {
          trace('detect', { sessionId: sid, kind, turn, attempts: st.attempts, unpaired })
          scheduleContinue(session, st, eff, kind, unpaired)
          return
        }
        if (action.type === 'cap') {
          trace('cap-reached', { sessionId: sid, attempts: st.attempts, kind, unpaired })
          notifyCap(session, eff)
          return
        }
        if (action.type === 'skip') {
          trace('skip', { reason: action.reason, sessionId: sid, kind, attempts: st.attempts })
          return
        }
        // noop / unknown kind
      } catch (e) { ctx.logger.warn(`dsh-continue: session/event handler: ${e && e.message}`) }
    }

    ctx.effect(() => {
      const dispose = ctx.on('session/event', onSessionEvent)
      return () => { try { dispose() } catch {} }
    }, 'dsh-continue: session/event subscription')

    // ── HTTP API ──
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/dsh-continue/api',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url || '/', 'http://dsh.local')
          const apiPath = url.pathname.replace(/\/+$/, '')

          // GET /dsh-continue/api/status
          if (req.method === 'GET' && apiPath.endsWith('/dsh-continue/api/status')) {
            const eff = effective()
            const perSession = []
            for (const [sid, st] of states) {
              perSession.push({
                sessionId: sid, attempts: st.attempts,
                lastContinueAt: st.lastContinueAt, lastTurn: st.lastTurn,
                pending: st.timer !== null, toolCalls: st.toolCalls, toolResults: st.toolResults,
              })
            }
            const activityTail = await readActivityTail(activityFile)
            sendJson(res, 200, {
              enabled: eff.enabled,
              settings: safeSettings(eff),
              armed: true,
              activityFile: displayPath(activityFile),
              perSession: perSession.slice(-PERSESSION_TAIL),
              activityTail,
            })
            return
          }

          // PUT /dsh-continue/api/settings
          if (req.method === 'PUT' && apiPath.endsWith('/dsh-continue/api/settings')) {
            const body = await readJsonBody(req)
            const patch = sanitizePatch(body)
            if (settingsScope && typeof settingsScope.update === 'function') await settingsScope.update(patch)
            else Object.assign(settingsOverrides, patch)
            const eff = effective()
            trace('settings-updated', { keys: Object.keys(patch) })
            sendJson(res, 200, { settings: safeSettings(eff) })
            return
          }

          sendJson(res, 404, { error: 'not found' })
        } catch (error) { sendJson(res, 400, { error: String(error && error.message || error) }) }
      },
    }), 'dsh-continue: api route')
  },
}
