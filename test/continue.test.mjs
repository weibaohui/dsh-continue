import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const I = require('../src/index.js').__internals
const {
  reasonKind, shouldRetry, computeBackoff, withinCooldown, isExcluded,
  decideTurnEnd, sanitizePatch, newSessionState, DEFAULTS,
} = I

const eff = (over = {}) => ({ ...DEFAULTS, ...over })

// ── reasonKind ──────────────────────────────────────────────────────────

test('reasonKind tolerates {kind} object, bare string, and null', () => {
  assert.equal(reasonKind({ kind: 'error' }), 'error')
  assert.equal(reasonKind('completed'), 'completed')
  assert.equal(reasonKind(null), undefined)
  assert.equal(reasonKind(undefined), undefined)
  assert.equal(reasonKind({}), undefined)
})

// ── shouldRetry ─────────────────────────────────────────────────────────

test('shouldRetry: error/interrupted respect flags; others never retry', () => {
  assert.equal(shouldRetry('error', eff()), true)
  assert.equal(shouldRetry('interrupted', eff()), true)
  assert.equal(shouldRetry('aborted', eff()), false)
  assert.equal(shouldRetry('completed', eff()), false)
  assert.equal(shouldRetry('max-tokens', eff()), false)
  assert.equal(shouldRetry('error', eff({ retryOnError: false })), false)
  assert.equal(shouldRetry('interrupted', eff({ retryOnInterrupted: false })), false)
})

// ── computeBackoff ──────────────────────────────────────────────────────

test('computeBackoff: base 0 yields 0', () => {
  assert.equal(computeBackoff(0, eff({ backoffBaseMs: 0 })), 0)
  assert.equal(computeBackoff(5, eff({ backoffBaseMs: 0, backoffMaxMs: 1000 })), 0)
})

test('computeBackoff: monotonic in attempt while below cap, and capped', () => {
  const e = eff({ backoffBaseMs: 1000, backoffMaxMs: 100000 })
  let prev = -1
  for (let a = 0; a < 8; a++) {
    const v = computeBackoff(a, e)
    assert.ok(v >= prev, `attempt ${a}: ${v} >= ${prev}`)
    prev = v
  }
})

test('computeBackoff: never exceeds cap * 1.2 (clamped + jitter)', () => {
  const e = eff({ backoffBaseMs: 100000, backoffMaxMs: 5000 }) // base huge → always capped at 5000
  for (let a = 0; a < 5; a++) {
    const v = computeBackoff(a, e)
    assert.ok(v >= 5000, `attempt ${a}: ${v} >= 5000`)
    assert.ok(v <= Math.ceil(5000 * 1.2), `attempt ${a}: ${v} <= ${Math.ceil(5000 * 1.2)}`)
  }
})

// ── withinCooldown ──────────────────────────────────────────────────────

test('withinCooldown: null lastAt passes; within window blocked; beyond passes', () => {
  const e = eff({ cooldownMs: 5000 })
  assert.equal(withinCooldown(1000, null, e), true)
  assert.equal(withinCooldown(5999, 1000, e), false) // 4999 elapsed, not >= 5000
  assert.equal(withinCooldown(6000, 1000, e), true)  // 5000 >= 5000
})

// ── isExcluded ───────────────────────────────────────────────────────────

test('isExcluded: subagent origin + review prefix excluded; foreground not', () => {
  assert.equal(isExcluded({ id: 's1', header: { origin: 'subagent' } }), true)
  assert.equal(isExcluded({ id: 'hermes-loop-review-abc' }), true)
  assert.equal(isExcluded({ id: 'session-xyz' }), false)
  assert.equal(isExcluded({ id: 'foreground-1', header: { origin: 'web' } }), false)
  assert.equal(isExcluded(null), true)
  assert.equal(isExcluded({ id: '' }), true)
})

// ── decideTurnEnd ────────────────────────────────────────────────────────

test('decideTurnEnd: completed → reset', () => {
  const st = newSessionState()
  st.attempts = 2
  assert.equal(decideTurnEnd(st, 'completed', eff(), 0).type, 'reset')
})

test('decideTurnEnd: error below cap → schedule with attempt+1', () => {
  const st = newSessionState() // attempts 0
  const a = decideTurnEnd(st, 'error', eff(), 1000)
  assert.equal(a.type, 'schedule')
  assert.equal(a.attempt, 1)
  assert.ok(a.delay >= 0)
})

test('decideTurnEnd: at cap → cap', () => {
  const st = newSessionState()
  st.attempts = DEFAULTS.maxAttempts
  assert.equal(decideTurnEnd(st, 'error', eff(), 1000).type, 'cap')
})

test('decideTurnEnd: pending timer → skip pending', () => {
  const st = newSessionState()
  st.timer = { /* truthy: a scheduled continue not yet fired */ }
  assert.equal(decideTurnEnd(st, 'error', eff(), 1000).type, 'skip')
  assert.equal(decideTurnEnd(st, 'error', eff(), 1000).reason, 'pending')
})

test('decideTurnEnd: within cooldown → skip cooldown', () => {
  const st = newSessionState()
  st.lastContinueAt = 1000
  // now=2000, cooldown=5000 → not enough
  const a = decideTurnEnd(st, 'error', eff({ cooldownMs: 5000 }), 2000)
  assert.equal(a.type, 'skip')
  assert.equal(a.reason, 'cooldown')
})

test('decideTurnEnd: non-retryable reason → skip', () => {
  const st = newSessionState()
  const a = decideTurnEnd(st, 'aborted', eff(), 1000)
  assert.equal(a.type, 'skip')
  assert.equal(a.reason, 'reason-not-retryable')
})

test('decideTurnEnd: undefined kind → noop', () => {
  const st = newSessionState()
  assert.equal(decideTurnEnd(st, undefined, eff(), 1000).type, 'noop')
})

test('decideTurnEnd: retryOnError=false + error → skip (reason-not-retryable)', () => {
  const st = newSessionState()
  const a = decideTurnEnd(st, 'error', eff({ retryOnError: false }), 1000)
  assert.equal(a.type, 'skip')
  assert.equal(a.reason, 'reason-not-retryable')
})

// ── sanitizePatch ───────────────────────────────────────────────────────

test('sanitizePatch: typed filtering only; garbage ignored', () => {
  const patch = sanitizePatch({
    enabled: true, prompt: '继续', maxAttempts: 5, cooldownMs: 1000,
    backoffBaseMs: 200, backoffMaxMs: 5000, retryOnError: false, retryOnInterrupted: true, notifyOnCap: false,
    junk: 'x',
  })
  assert.deepEqual(patch, {
    enabled: true, prompt: '继续', maxAttempts: 5, cooldownMs: 1000,
    backoffBaseMs: 200, backoffMaxMs: 5000, retryOnError: false, retryOnInterrupted: true, notifyOnCap: false,
  })
})

test('sanitizePatch: empty prompt rejected; bad backoffMax rejected', () => {
  const patch = sanitizePatch({ prompt: '', backoffMaxMs: 500, maxAttempts: 0 })
  assert.deepEqual(patch, {})
})

// ── Event-sequence simulation: cap then completed-resets ─────────────────

test('sequence: 3 errors schedule 3 continues, 4th hits cap; completed resets', () => {
  const st = newSessionState()
  const e = eff()
  const now = 0
  // first three errors → schedule (attempt 1,2,3)
  for (let i = 0; i < DEFAULTS.maxAttempts; i++) {
    const a = decideTurnEnd(st, 'error', e, now + i * 100000)
    assert.equal(a.type, 'schedule', `iteration ${i}`)
    assert.equal(a.attempt, i + 1)
    st.attempts = a.attempt // simulate the scheduled continue having fired & incremented
  }
  // 4th error → cap (attempts == max)
  assert.equal(decideTurnEnd(st, 'error', e, now + 999999).type, 'cap')
  // a completed turn resets attempts to 0
  assert.equal(decideTurnEnd(st, 'completed', e, now + 9999999).type, 'reset')
  st.attempts = 0
  // after reset, error schedules again (attempt 1)
  assert.equal(decideTurnEnd(st, 'error', e, now + 99999999).type, 'schedule')
})

test('sequence: turn/start cancels pending (timer cleared) so next error can schedule', () => {
  const st = newSessionState()
  const e = eff()
  // error → schedule
  assert.equal(decideTurnEnd(st, 'error', e, 0).type, 'schedule')
  st.timer = { pending: true } // host sets the timer field when it schedules
  // before it fires, a new turn/start happens (user typed 继续): host clears timer
  st.timer = null
  // next error can schedule again, attempt still 0 (continue never fired)
  const a = decideTurnEnd(st, 'error', e, 100000)
  assert.equal(a.type, 'schedule')
  assert.equal(a.attempt, 1)
})
