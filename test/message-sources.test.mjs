/**
 * Host-composition regressions for the two ways this plugin used to break a
 * profile that arranges compaction differently:
 *
 *  1. `compaction` declared in `inject`. Whether the host plane mounts a
 *     compaction backend is composition, not a dependency of this plugin: the
 *     web bundle disables `compaction-basic` (the backend lives in each agent
 *     preset's isolated realm) and a profile may mount its own backend there
 *     (e.g. `@aiwayds/dsh-dcp`). The old workaround re-enabled `compaction-basic`
 *     from this package's bundle patch — which wins the row over any bundle
 *     listed before it (`dsh.profile.bundles` order, last write wins) — and
 *     killed dsh-dcp with
 *     `service "compaction" has been registered at <BasicCompactionEngine>`.
 *
 *  2. `source.kind: 'plugin'`. dsh 0.1.7 removed that catch-all; the native v4
 *     admission refuses the row, so the resumed turn died before it started
 *     (`format v4 message requires a producer-owned source kind`, code UNKNOWN)
 *     and nothing was written to the session log.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The plugin writes its activity ledger under $DSH_HOME/dsh-continue — keep the
// suite off the developer's real home.
const home = mkdtempSync(join(tmpdir(), 'dsh-continue-sources-'))
mkdirSync(join(home, 'dsh-continue'), { recursive: true })
process.env.DSH_HOME = home
process.on('exit', () => { try { rmSync(home, { recursive: true, force: true }) } catch {} })

const require = createRequire(import.meta.url)
const plugin = require('../src/index.js')
const { compactionArmedIn, compactionOf } = plugin.__internals

/** Mirrors the host's native V4 admission (dsh-session-format-v3-to-v4). */
function assertProducerOwnedSource(message) {
  const source = message && message.source
  assert.ok(source && typeof source === 'object', 'every durable message needs a source object')
  assert.equal(typeof source.kind, 'string', 'source.kind must be a string')
  assert.ok(source.kind.length > 0, 'source.kind must not be empty')
  assert.notEqual(source.kind, 'plugin', "the 'plugin' catch-all was removed in dsh 0.1.7")
}

/** Minimal host: captures the session/event handlers, appends, and follow-ups. */
function makeHost({ compaction } = {}) {
  const handlers = {}
  const appended = []
  const followups = []
  const agent = { id: 'session-test', followup: (message) => followups.push(message) }
  const appendedOps = []
  const session = { id: 'session-test', append: (type, message, opts) => { appended.push({ type, message }); appendedOps.push(opts) } }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    settings: { register: () => ({ get: () => ({}), update: async () => {}, watch: () => {} }) },
    connection: { requestRejection: () => undefined },
    effect: (factory) => { const d = factory(); return typeof d === 'function' ? d : () => {} },
    on: (name, handler) => { (handlers[name] = handlers[name] || []).push(handler); return () => {} },
    get: (name) => (name === 'compaction' ? compaction : undefined),
    agents: { get: () => agent },
    sessions: {},
    webServer: { register: () => {} },
  }
  // backoff/cooldown at 0 keeps the scheduling path immediate for the test.
  plugin.apply(ctx, { enabled: true, backoffBaseMs: 0, cooldownMs: 0 })
  const emit = (event) => { for (const handler of handlers['session/event'] || []) handler(session, event) }
  return { ctx, session, agent, appended, appendedOps, followups, emit }
}

const turnEnd = (failure) => ({ type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: failure } } })
const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

test('plugin.inject does not declare the optional compaction service', () => {
  assert.ok(!plugin.inject.includes('compaction'),
    'compaction is host composition: declaring it parks this fiber when no host-plane backend is mounted')
  assert.ok(plugin.inject.includes('agents'))
})

test('compaction lookup degrades instead of throwing', () => {
  assert.equal(compactionOf({ get: () => undefined }), undefined)
  assert.equal(compactionOf({}), undefined, 'a context without get() must not blow up')
  assert.equal(
    compactionOf({ get: () => { throw new Error('cannot get property "compaction" without inject') } }),
    undefined,
    'the bare property read throws without inject — the lookup must swallow it')
  assert.equal(typeof compactionOf({ get: () => ({ compactIfNeeded() {} }) }).compactIfNeeded, 'function')

  assert.equal(compactionArmedIn({ get: () => undefined }), false)
  assert.equal(compactionArmedIn({ get: () => ({}) }), false, 'a backend without compactIfNeeded is not armed')
  assert.equal(compactionArmedIn({ get: () => ({ compactIfNeeded() {} }) }), true)
})

test('session notices carry a producer-owned source kind and a surfaceOp marker', async () => {
  const { appended, appendedOps, emit } = makeHost()
  emit(turnEnd({ code: 'QUOTA', message: 'Insufficient Balance' }))
  await tick() // notices post on a later tick — a sync append from inside session/event dispatch is rejected by the host
  assert.equal(appended.length, 1, 'the quota rule must post one stop notice')
  assert.equal(appended[0].type, 'user/message')
  assertProducerOwnedSource(appended[0].message)
  assert.equal(appended[0].message.source.kind, 'dsh-continue')
  assert.equal(appendedOps[0] && appendedOps[0].surfaceOp, 'append',
    'user/message is surface-eligible: the append must carry { surfaceOp: "append" }')
})

test('the auto-continue message carries a producer-owned source kind', async () => {
  const { followups, emit } = makeHost()
  emit(turnEnd({ code: 'RATE_LIMIT', status: 429, message: 'slow down' }))
  await tick()
  assert.equal(followups.length, 1, 'the rate-limit rule must resume the session once')
  assert.equal(followups[0].role, 'user')
  assertProducerOwnedSource(followups[0])
  assert.equal(followups[0].source.kind, 'dsh-continue')
})

test('a context rule without a host backend notifies instead of compacting', async () => {
  const { appended, emit } = makeHost()
  emit(turnEnd({ code: 'CONTEXT_WINDOW_EXCEEDED', message: 'too long' }))
  await tick()
  assert.equal(appended.length, 1, 'the compact rule must report the missing backend')
  assert.match(appended[0].message.content[0].text, /未挂载压缩服务/)
  assertProducerOwnedSource(appended[0].message)
})

test('a mounted host backend is still used by the compact rule', async () => {
  const calls = []
  const { appended, emit } = makeHost({
    compaction: { compactIfNeeded: async (...args) => { calls.push(args); return null } },
  })
  emit(turnEnd({ code: 'CONTEXT_WINDOW_EXCEEDED', message: 'too long' }))
  await tick()
  assert.equal(calls.length, 1, 'the mounted backend must be called')
  assert.equal(calls[0][1], 'context-overflow')
  assert.ok(appended.length >= 1, 'a null result still stops with a notice')
  for (const row of appended) assertProducerOwnedSource(row.message)
})
