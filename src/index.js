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

// ── 规则模型 ──
// 每条规则 = 匹配条件（when）+ 动作（action）；设置里按数组顺序自上而下匹配，
// 第一条「条件命中且未被用尽」的规则生效（先匹配先用）。规则用尽
// （maxAttempts>0 且该规则本簇尝试次数达标）后自动跳到下一条。
// when：rate-limit（429/限流）| quota（额度耗尽）| auth（鉴权失败）|
//       context（上下文超限）| server（5xx）| transport（传输/网络错误）|
//       interrupted（崩溃孤儿轮）| any（任意兜底）
// action：continue（按原模型继续）| continue-with（换到指定 provider/model 继续）|
//         compact（压缩上下文后继续；无可压缩区间/压缩失败则停止并通知）|
//         stop（停止自动续跑并通知会话）
const RULE_WHENS = ['rate-limit', 'quota', 'auth', 'context', 'server', 'transport', 'interrupted', 'any']
const RULE_ACTIONS = ['continue', 'continue-with', 'compact', 'stop']
const WHEN_LABELS = {
  'rate-limit': '限流（429）',
  quota: '额度耗尽',
  auth: '鉴权失败',
  context: '上下文超限',
  server: '服务端错误（5xx）',
  transport: '传输/网络错误',
  interrupted: '崩溃孤儿轮',
  any: '任意失败',
}

const DEFAULT_RULES = [
  { id: 'r-rate-limit',  when: 'rate-limit',  action: 'continue', provider: '', model: '', maxAttempts: 5 },
  { id: 'r-quota',       when: 'quota',       action: 'stop',     provider: '', model: '', maxAttempts: 0 },
  { id: 'r-auth',        when: 'auth',        action: 'stop',     provider: '', model: '', maxAttempts: 0 },
  { id: 'r-context',     when: 'context',     action: 'compact',  provider: '', model: '', maxAttempts: 2 },
  { id: 'r-interrupted', when: 'interrupted', action: 'continue', provider: '', model: '', maxAttempts: 0 },
  { id: 'r-any',         when: 'any',         action: 'continue', provider: '', model: '', maxAttempts: 0 },
]

const DEFAULTS = {
  enabled: true,
  prompt: '继续',
  maxAttempts: 50,       // per session, within one failure cluster; reset on a completed turn
  cooldownMs: 5000,      // min gap between continues for the same session
  backoffBaseMs: 2000,   // base * 2^attempt (attempt = count before this continue)
  backoffMaxMs: 30000,
  rules: DEFAULT_RULES,  // 有序规则表：先匹配先用；含默认策略（限流退避续跑、额度/鉴权/上下文停止、其余继续）
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

/** Map a failure class (or turn kind) onto a rule `when` token. */
function classToWhen(kind, cls) {
  if (kind === 'interrupted') return 'interrupted'
  if (kind === 'error') {
    if (cls && cls.cls === 'unknown') return 'transport'
    if (cls && cls.cls) return cls.cls
  }
  return undefined
}

/**
 * First matching, not-yet-exhausted rule (array order = priority; first match
 * wins). A rule is exhausted when maxAttempts > 0 and this cluster already used
 * that many continues under it. Pure; unit-tested via __internals.
 */
function firstMatchingRule(rules, kind, cls, ruleAttempts) {
  const when = classToWhen(kind, cls)
  if (!when) return null
  for (const rule of rules || []) {
    if (!rule || (rule.when !== when && rule.when !== 'any')) continue
    const cap = Number(rule.maxAttempts) || 0
    if (cap > 0 && (ruleAttempts && ruleAttempts[rule.id] || 0) >= cap) continue
    return rule
  }
  return null
}

// ── 失败分类（turn/end reason=`error` 时 reason.error 为结构化 LlmFailure）──
// 宿主已归一化的机器路由码：QUOTA（额度/余额耗尽，终态）、RATE_LIMIT（限流，瞬态）、
// CONTEXT_WINDOW_EXCEEDED（上下文超限，终态）、INVALID_CREDENTIAL / MISSING_CREDENTIAL（凭证）、
// UNKNOWN（其他错误的兜底）。LlmFailure 还带 status（HTTP 状态码）与
// providerRetryAfterMs（服务商要求的等待毫秒）。429 到底是额度还是限流：
// 宿主适配器把「余额/额度/欠费」类文案归为 QUOTA，其余 429 归为 RATE_LIMIT；
// 插件再对 429 做一次文案兜底判定。

const QUOTA_WORDS = [
  'quota', 'insufficient', 'balance', 'credit', 'billing', 'arrears',
  'exhausted', 'arrearage', '额度', '余额', '欠费', '充值',
]

/**
 * Classify one LlmFailure into a routing class for the continue policy.
 * Returns `{ cls, status, code }` — cls ∈ quota | auth | context | rate-limit |
 * server | unknown. Pure; unit-tested via __internals.
 */
function classifyFailure(failure) {
  if (!failure || typeof failure !== 'object') return { cls: 'unknown', status: undefined, code: undefined }
  const code = typeof failure.code === 'string' ? failure.code : undefined
  const status = Number.isFinite(failure.status) ? failure.status : undefined
  const msg = typeof failure.message === 'string' ? failure.message.toLowerCase() : ''
  if (code === 'CONTEXT_WINDOW_EXCEEDED') return { cls: 'context', status, code }
  if (code === 'QUOTA' || status === 402 || (status === 429 && QUOTA_WORDS.some((w) => msg.includes(w))))
    return { cls: 'quota', status, code }
  if (code === 'INVALID_CREDENTIAL' || code === 'MISSING_CREDENTIAL' || status === 401 || status === 403)
    return { cls: 'auth', status, code }
  if (code === 'RATE_LIMIT' || status === 429) return { cls: 'rate-limit', status, code }
  if (status !== undefined && status >= 500) return { cls: 'server', status, code }
  return { cls: 'unknown', status, code }
}

/** Human-readable one-liner for a rule-driven stop (or classified failure). */
function failureNoticeText(cls, whenLabel) {
  const tag = [cls && cls.code, cls && cls.status !== undefined ? 'HTTP ' + cls.status : null]
    .filter(Boolean).join('/')
  const head = whenLabel ? `自动续跑按规则停止（${whenLabel}` : '自动续跑按规则停止'
  return head + (tag ? `：${tag}）——请人工介入后手动继续` : '）——请人工介入后手动继续')
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
  return {
    attempts: 0, lastContinueAt: null, lastTurn: null, toolCalls: 0, toolResults: 0,
    timer: null, pendingContinue: false, overrideTurn: undefined,
    ruleAttempts: {},      // ruleId → 本失败簇内该规则已执行的续跑次数
    continueOverride: null, // 本次续跑轮应用的 {provider, model, via}（来自命中的规则）
    compacting: false,     // 压缩进行中（阻止并发决策）
  }
}

/**
 * Pure decision for a `turn/end` event, driven by the ordered rule table.
 * Returns the action apply should take:
 *  - {type:'reset'}                     completed → zero attempts, clear pending
 *  - {type:'schedule', delay, attempt, cls, rule, override?}  send 继续 after `delay`
 *  - {type:'cap'}                       global cap or every rule exhausted → stop + notify
 *  - {type:'abort-notify', cls, rule}   matched rule says stop → one-line notice
 *  - {type:'skip', reason}              not eligible / pending / cooldown
 *  - {type:'noop'}                      kind unknown
 *
 * `failure` is the structured LlmFailure from reason=`error` (may be absent).
 * Rate-limited continues honor `providerRetryAfterMs` when the provider sent one.
 */
function decideTurnEnd(st, kind, eff, now, failure) {
  if (kind === 'completed') return { type: 'reset' }
  if (kind === undefined) return { type: 'noop' }
  // 只有 error（结构化失败）与 interrupted（崩溃孤儿）参与规则匹配；其余结束原因一律不续
  if (kind !== 'error' && kind !== 'interrupted') return { type: 'skip', reason: 'reason-not-retryable', kind }
  if (st.compacting) return { type: 'skip', reason: 'compacting' }
  const cls = kind === 'error' ? classifyFailure(failure) : { cls: undefined, status: undefined, code: undefined }
  const rule = firstMatchingRule(eff.rules, kind, cls, st.ruleAttempts)
  if (!rule) return { type: 'cap' } // 没有可用规则（全部用尽或表为空）→ 视作达上限
  if (rule.action === 'stop') return { type: 'abort-notify', cls, rule }
  // continue / continue-with / compact
  if (st.timer !== null) return { type: 'skip', reason: 'pending' }
  if (st.attempts >= eff.maxAttempts) return { type: 'cap' }
  if (!withinCooldown(now, st.lastContinueAt, eff)) return { type: 'skip', reason: 'cooldown' }
  const attempt = st.attempts + 1
  let delay = computeBackoff(st.attempts, eff)
  if (cls && cls.cls === 'rate-limit' && failure && Number.isFinite(failure.providerRetryAfterMs))
    delay = Math.max(delay, failure.providerRetryAfterMs)
  const override = rule.action === 'continue-with' && rule.model
    ? { provider: rule.provider || '', model: rule.model, via: rule.id }
    : null
  return { type: 'schedule', delay, attempt, cls, rule, override, compact: rule.action === 'compact' }
}

/** Validate/sanitize one rule entry; returns null when unusable. */
function sanitizeRule(entry, i) {
  if (!entry || typeof entry !== 'object') return null
  const when = RULE_WHENS.includes(entry.when) ? entry.when : null
  const action = RULE_ACTIONS.includes(entry.action) ? entry.action : null
  if (!when || !action) return null
  const id = typeof entry.id === 'string' && entry.id !== '' ? entry.id.slice(0, 64) : `r-${i}-${Date.now().toString(36)}`
  const rule = {
    id,
    when,
    action,
    provider: typeof entry.provider === 'string' ? entry.provider.trim() : '',
    model: typeof entry.model === 'string' ? entry.model.trim() : '',
    maxAttempts: Number.isFinite(entry.maxAttempts) && entry.maxAttempts > 0 ? Math.floor(entry.maxAttempts) : 0,
  }
  if (rule.action === 'continue-with' && !rule.model) return null // 换模型必须有目标模型
  return rule
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
  if (Array.isArray(body.rules)) {
    const rules = body.rules.slice(0, 20).map(sanitizeRule).filter(Boolean)
    if (rules.length > 0) patch.rules = rules
  }
  if (typeof body.notifyOnCap === 'boolean') patch.notifyOnCap = body.notifyOnCap
  return patch
}

function settingsSchema() {
  if (!Schema) return null
  return Schema.object({
    enabled: Schema.boolean().default(true),
    prompt: Schema.string().default('继续'),
    maxAttempts: Schema.number().min(1).default(50),
    cooldownMs: Schema.number().min(0).default(5000),
    backoffBaseMs: Schema.number().min(0).default(2000),
    backoffMaxMs: Schema.number().min(1000).default(30000),
    rules: Schema.array(Schema.object({
      id: Schema.string().default(''),
      when: Schema.string().default('any'),
      action: Schema.string().default('continue'),
      provider: Schema.string().default(''),
      model: Schema.string().default(''),
      maxAttempts: Schema.number().default(0),
    })).default(DEFAULT_RULES),
    notifyOnCap: Schema.boolean().default(true),
  })
}

module.exports = {
  name: 'dsh-continue',
  inject: ['agents', 'settings', 'webServer', 'llm', 'agentDefaultModel', 'compaction'],
  __internals: {
    reasonKind, computeBackoff, withinCooldown, isExcluded,
    decideTurnEnd, classifyFailure, failureNoticeText, firstMatchingRule, classToWhen,
    sanitizeRule, sanitizePatch, newSessionState, readActivityTail,
    DEFAULTS, DEFAULT_RULES, RULE_WHENS, RULE_ACTIONS, dshHome, EXCLUDE_ID_PREFIXES, settingsSchema,
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
      rules: Array.isArray(eff.rules) ? eff.rules : DEFAULT_RULES,
      notifyOnCap: eff.notifyOnCap,
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

    /** Post one folded plugin notice line into the source session. */
    const notifySession = (session, text) => {
      if (!session || typeof session.append !== 'function') return
      try {
        session.append('user/message', {
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: 'dsh-continue', form: 'notice', summary: text },
        })
      } catch (e) { trace('notify-failed', { message: String(e && e.message) }) }
    }

    const notifyCap = (session, eff) => {
      if (!eff.notifyOnCap) return
      notifySession(session, `自动续跑已达上限（${eff.maxAttempts} 次），请人工介入`)
    }

    // 终态失败（规则动作=stop）不重试，但要让用户知道命中了哪条规则、为什么。
    const notifyStop = (session, cls, rule) => notifySession(session, failureNoticeText(cls, rule && WHEN_LABELS[rule.when]))

    // ── compact 动作执行流：先压缩上下文，成功再排续跑 ──
    // 压缩走宿主 ctx.compaction.compactIfNeeded(agent, 'context-overflow')——
    // 官方为「provider 确认的上下文超限」准备的入口。结果三分支：
    //   compacted → 排一次续跑（经正常冷却/退避）；
    //   null（无需/无法安全压缩）或失败 → 停止并投通知（继续只会原样再炸）。
    // 进行中置 st.compacting 防并发决策。
    const runCompactThenContinue = (session, st, eff, kind, unpaired, action) => {
      const sid = session && session.id
      void (async () => {
        try {
          const agent = ctx.agents && typeof ctx.agents.get === 'function' ? ctx.agents.get(sid) : undefined
          if (!agent || !ctx.compaction || typeof ctx.compaction.compactIfNeeded !== 'function') {
            trace('compact-unavailable', { sessionId: sid, ruleId: action.rule.id })
            notifySession(session, '上下文超限：宿主未挂载压缩服务，自动续跑停止——请手动压缩或新开会话')
            return
          }
          st.compacting = true
          const controller = new AbortController()
          const result = await ctx.compaction.compactIfNeeded(agent, 'context-overflow', controller.signal)
          st.compacting = false
          if (result) {
            trace('compact-done', {
              sessionId: sid, ruleId: action.rule.id,
              replaced: result.replaced ? result.replaced.length : undefined,
            })
            scheduleContinue(session, st, eff, kind, unpaired, action)
          } else {
            trace('compact-noop', { sessionId: sid, ruleId: action.rule.id })
            notifySession(session, '上下文超限：没有可安全压缩的区间，自动续跑停止——请手动压缩或新开会话')
          }
        } catch (e) {
          st.compacting = false
          trace('compact-failed', { sessionId: sid, ruleId: action.rule.id, message: String(e && e.message) })
          notifyStop(session, action.cls, action.rule)
        }
      })()
    }

    const scheduleContinue = (session, st, eff, kind, unpaired, action) => {
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
          if (action && action.rule) st.ruleAttempts[action.rule.id] = (st.ruleAttempts[action.rule.id] || 0) + 1
          // 标记待归属：下一个 turn/start 视为本次续跑发起的轮次，模型覆盖只作用于它
          st.pendingContinue = true
          if (action && action.override) st.continueOverride = { ...action.override }
          trace('continue-sent', {
            sessionId: sid, attempt, prompt: eff.prompt, trigger: kind, unpaired,
            ruleId: action && action.rule ? action.rule.id : undefined,
            via: action && action.override ? action.override.via : undefined,
          })
        } catch (e) {
          trace('continue-failed', { sessionId: sid, attempt, message: String(e && e.message) })
        }
      }, delay)
      if (typeof st.timer.unref === 'function') st.timer.unref()
      const ov = action && action.override
      trace('scheduled', {
        sessionId: sid, attempt, delay, trigger: kind, unpaired,
        ruleId: action && action.rule ? action.rule.id : undefined,
        modelPlan: ov ? `${ov.via}:${ov.model}` : undefined,
      })
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
          // 归属：若上一个失败簇刚被我们投了续跑，这个新轮次就是续跑轮 → 模型覆盖只作用于它
          if (st.pendingContinue) {
            st.pendingContinue = false
            st.overrideTurn = event.data && event.data.turn
            trace('override-armed', { sessionId: sid, turn: st.overrideTurn })
          }
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

        const reason = event.data && event.data.reason
        const kind = reasonKind(reason)
        const turn = event.data && event.data.turn
        const unpaired = Math.max(0, st.toolCalls - st.toolResults)
        st.lastTurn = turn
        st.overrideTurn = undefined // 轮次已关，模型覆盖随之失效
        st.continueOverride = null
        // reason=`error` 时结构化失败挂在 reason.error（容忍 failure 命名）
        const failure = kind === 'error' && reason && typeof reason === 'object'
          ? (reason.error || reason.failure)
          : undefined

        const action = decideTurnEnd(st, kind, eff, Date.now(), failure)
        if (action.type === 'reset') {
          if (st.attempts !== 0 || st.timer !== null) {
            trace('settle', { sessionId: sid, kind, attempts: st.attempts, unpaired })
          }
          cancelTimer(st)
          st.attempts = 0
          st.toolCalls = 0
          st.toolResults = 0
          st.ruleAttempts = {} // 失败簇结束，各规则计数归零
          return
        }
        if (action.type === 'schedule') {
          trace('detect', {
            sessionId: sid, kind, turn, attempts: st.attempts, unpaired,
            ruleId: action.rule && action.rule.id, ruleAction: action.rule && action.rule.action,
            failureClass: action.cls && action.cls.cls, code: action.cls && action.cls.code, status: action.cls && action.cls.status,
          })
          if (action.compact) runCompactThenContinue(session, st, eff, kind, unpaired, action)
          else scheduleContinue(session, st, eff, kind, unpaired, action)
          return
        }
        if (action.type === 'abort-notify') {
          trace('abort-notify', {
            sessionId: sid, kind, turn, ruleId: action.rule && action.rule.id, when: action.rule && action.rule.when,
            failureClass: action.cls && action.cls.cls, code: action.cls && action.cls.code, status: action.cls && action.cls.status,
          })
          notifyStop(session, action.cls, action.rule)
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

    // ── 续跑轮模型覆盖 ──
    // 命中 continue-with 规则的续跑轮：通过 agent/request 瀑布（同 dsh-llm-retry
    // 的注册方式）把该轮次的模型请求替换为规则指定的 provider/model。归属：
    // scheduleContinue 成功投递后置 pendingContinue + continueOverride，turn/start
    // 时把该轮次号记入 overrideTurn；用户手敲消息先启动的轮次不会被覆盖。
    // 热路径上只做一次 Map 查找，其余情况立即 next()。
    ctx.effect(() => {
      const dispose = ctx.on('agent/request', (payload, next) => {
        let st, ov
        try { st = payload && payload.agent && payload.agent.id ? states.get(payload.agent.id) : null } catch { return next() }
        if (!st || st.overrideTurn !== payload.turn) return next()
        ov = st.continueOverride
        if (!ov || !ov.model) return next()
        return next().then((config) => {
          try {
            if (!config || typeof config !== 'object') return config
            const patched = { ...config, model: ov.model }
            if (ov.provider) patched.provider = ov.provider
            if (patched.provider === config.provider && patched.model === config.model) return config
            trace('model-overridden', {
              sessionId: payload.agent.id, turn: payload.turn, via: ov.via,
              from: `${config.provider}/${config.model}`, to: `${patched.provider}/${patched.model}`,
            })
            return patched
          } catch { return config }
        })
      })
      return () => { try { dispose() } catch {} }
    }, 'dsh-continue: continue-turn model override')

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
              compactionArmed: Boolean(ctx.compaction && typeof ctx.compaction.compactIfNeeded === 'function'),
              activityFile: displayPath(activityFile),
              perSession: perSession.slice(-PERSESSION_TAIL),
              activityTail,
            })
            return
          }

          // GET /dsh-continue/api/models — provider/model catalog for the settings
          // dropdowns (llm.listProviders + per-provider listModels; both optional so
          // the endpoint degrades to an empty catalog on hosts without the service).
          if (req.method === 'GET' && apiPath.endsWith('/dsh-continue/api/models')) {
            const out = { default: null, providers: [] }
            try {
              if (ctx.agentDefaultModel && typeof ctx.agentDefaultModel.currentSelection === 'function')
                out.default = ctx.agentDefaultModel.currentSelection()
            } catch {}
            try {
              const providers = ctx.llm && typeof ctx.llm.listProviders === 'function' ? ctx.llm.listProviders() : []
              for (const p of providers || []) {
                let models = []
                try { models = (await ctx.llm.listModels(p.id)) || [] } catch {}
                out.providers.push({
                  id: p.id, name: p.name || p.id,
                  models: models.map((m) => ({ id: m.id, name: m.name || m.id })),
                })
              }
            } catch {}
            sendJson(res, 200, out)
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
