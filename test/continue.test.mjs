import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const I = require('../src/index.js').__internals
const {
  reasonKind, computeBackoff, withinCooldown, isExcluded,
  decideTurnEnd, classifyFailure, firstMatchingRule, sanitizeRule, sanitizePatch,
  newSessionState, DEFAULTS, DEFAULT_RULES,
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

// ── withinCooldown ──────────────────────────────────────────────────────

test('withinCooldown: null lastAt passes; within window blocked; beyond passes', () => {
  const e = eff({ cooldownMs: 5000 })
  assert.equal(withinCooldown(1000, null, e), true)
  assert.equal(withinCooldown(5999, 1000, e), false)
  assert.equal(withinCooldown(6000, 1000, e), true)
})

// ── isExcluded ───────────────────────────────────────────────────────────

test('isExcluded: subagent origin + review prefix excluded; foreground not', () => {
  assert.equal(isExcluded({ id: 's1', header: { origin: 'subagent' } }), true)
  assert.equal(isExcluded({ id: 'hermes-loop-review-abc' }), true)
  assert.equal(isExcluded({ id: 'session-xyz' }), false)
  assert.equal(isExcluded(null), true)
  assert.equal(isExcluded({ id: '' }), true)
})

// ── classifyFailure ──────────────────────────────────────────────────────

test('classifyFailure: quota by code QUOTA / 402 / 429+额度文案', () => {
  const { classifyFailure } = I
  assert.equal(classifyFailure({ code: 'QUOTA', status: 429, message: 'x' }).cls, 'quota')
  assert.equal(classifyFailure({ code: 'UNKNOWN', status: 402, message: 'x' }).cls, 'quota')
  assert.equal(classifyFailure({ code: 'UNKNOWN', status: 429, message: 'Insufficient Balance' }).cls, 'quota')
  assert.equal(classifyFailure({ code: 'UNKNOWN', status: 429, message: 'rate limit exceeded, please retry' }).cls, 'rate-limit')
})

test('classifyFailure: auth / context / rate-limit / server / unknown', () => {
  const { classifyFailure } = I
  assert.equal(classifyFailure({ code: 'UNKNOWN', status: 401, message: 'x' }).cls, 'auth')
  assert.equal(classifyFailure({ code: 'INVALID_CREDENTIAL', message: 'x' }).cls, 'auth')
  assert.equal(classifyFailure({ code: 'CONTEXT_WINDOW_EXCEEDED', message: 'too long' }).cls, 'context')
  assert.equal(classifyFailure({ code: 'RATE_LIMIT', message: 'x' }).cls, 'rate-limit')
  assert.equal(classifyFailure({ code: 'UNKNOWN', status: 503, message: 'x' }).cls, 'server')
  assert.equal(classifyFailure({ code: 'UNKNOWN', message: 'fetch failed' }).cls, 'unknown')
  assert.equal(classifyFailure(undefined).cls, 'unknown')
})

// ── firstMatchingRule（有序 + 先命中先用 + 用尽跳下一条）──────────────────

test('firstMatchingRule: array order wins; any is catch-all', () => {
  const rules = [
    { id: 'a', when: 'rate-limit', action: 'continue', maxAttempts: 0 },
    { id: 'b', when: 'any', action: 'stop', maxAttempts: 0 },
  ]
  assert.equal(firstMatchingRule(rules, 'error', { cls: 'rate-limit' }, {}).id, 'a')
  assert.equal(firstMatchingRule(rules, 'error', { cls: 'quota' }, {}).id, 'b') // 兜底
  assert.equal(firstMatchingRule(rules, 'interrupted', { cls: undefined }, {}).id, 'b')
})

test('firstMatchingRule: exhausted rule is skipped, next match applies', () => {
  const rules = [
    { id: 'a', when: 'rate-limit', action: 'continue', maxAttempts: 2 },
    { id: 'b', when: 'rate-limit', action: 'continue-with', model: 'm2', maxAttempts: 0 },
  ]
  assert.equal(firstMatchingRule(rules, 'error', { cls: 'rate-limit' }, { a: 0 }).id, 'a')
  assert.equal(firstMatchingRule(rules, 'error', { cls: 'rate-limit' }, { a: 1 }).id, 'a')
  assert.equal(firstMatchingRule(rules, 'error', { cls: 'rate-limit' }, { a: 2 }).id, 'b') // a 用尽 → b
  assert.equal(firstMatchingRule(rules, 'error', { cls: 'rate-limit' }, { a: 2, b: 9 }).id, 'b') // b 不限
})

test('firstMatchingRule: transport↔unknown mapping; interrupted matching; null when nothing', () => {
  const rules = [{ id: 't', when: 'transport', action: 'continue', maxAttempts: 0 }]
  assert.equal(firstMatchingRule(rules, 'error', { cls: 'unknown' }, {}).id, 't')
  assert.equal(firstMatchingRule(rules, 'error', { cls: 'server' }, {}), null)
  const iv = [{ id: 'i', when: 'interrupted', action: 'continue', maxAttempts: 0 }]
  assert.equal(firstMatchingRule(iv, 'interrupted', { cls: undefined }, {}).id, 'i')
  assert.equal(firstMatchingRule(iv, 'error', { cls: 'rate-limit' }, {}), null)
})

// ── decideTurnEnd（规则驱动）──────────────────────────────────────────────

test('decideTurnEnd: completed → reset; unknown kind → noop; aborted → skip', () => {
  const st = newSessionState()
  assert.equal(decideTurnEnd(st, 'completed', eff(), 0).type, 'reset')
  assert.equal(decideTurnEnd(st, undefined, eff(), 0).type, 'noop')
  const a = decideTurnEnd(st, 'aborted', eff(), 0)
  assert.equal(a.type, 'skip')
  assert.equal(a.reason, 'reason-not-retryable')
})

test('decideTurnEnd: default rules — 5xx/transport continue, quota stop, interrupted continue', () => {
  const st = newSessionState()
  const a = decideTurnEnd(st, 'error', eff(), 1000, { code: 'UNKNOWN', status: 503, message: 'x' })
  assert.equal(a.type, 'schedule')
  assert.equal(a.rule.id, 'r-any')
  const b = decideTurnEnd(newSessionState(), 'error', eff(), 1000, { code: 'QUOTA', message: 'x' })
  assert.equal(b.type, 'abort-notify')
  assert.equal(b.rule.id, 'r-quota')
  const c = decideTurnEnd(newSessionState(), 'interrupted', eff(), 1000)
  assert.equal(c.type, 'schedule')
  assert.equal(c.rule.id, 'r-interrupted')
  // 429 额度 vs 限流在规则层分叉
  const d = decideTurnEnd(newSessionState(), 'error', eff(), 1000, { code: 'RATE_LIMIT', status: 429, message: 'slow down' })
  assert.equal(d.type, 'schedule')
  assert.equal(d.rule.id, 'r-rate-limit')
})

test('decideTurnEnd: continue-with rule attaches override {provider, model, via}', () => {
  const e = eff({ rules: [{ id: 'x', when: 'rate-limit', action: 'continue-with', provider: 'p2', model: 'm2', maxAttempts: 0 }] })
  const a = decideTurnEnd(newSessionState(), 'error', e, 1000, { code: 'RATE_LIMIT', message: 'x' })
  assert.equal(a.type, 'schedule')
  assert.deepEqual(a.override, { provider: 'p2', model: 'm2', via: 'x' })
  // continue 规则不带 override
  const b = decideTurnEnd(newSessionState(), 'error', eff(), 1000, { code: 'RATE_LIMIT', message: 'x' })
  assert.equal(b.override, null)
})

test('decideTurnEnd: rule exhaustion falls through, then global cap', () => {
  const rules = [
    { id: 'a', when: 'rate-limit', action: 'continue', maxAttempts: 2 },
    { id: 'b', when: 'rate-limit', action: 'continue-with', provider: '', model: 'm2', maxAttempts: 2 },
  ]
  const e = eff({ rules })
  // a 已用 2 次 → 命中 b
  const st = newSessionState(); st.ruleAttempts = { a: 2 }
  const r1 = decideTurnEnd(st, 'error', e, 1000, { code: 'RATE_LIMIT', message: 'x' })
  assert.equal(r1.type, 'schedule')
  assert.equal(r1.rule.id, 'b')
  assert.equal(r1.override.model, 'm2')
  // a、b 都用尽 → cap
  st.ruleAttempts = { a: 2, b: 2 }
  assert.equal(decideTurnEnd(st, 'error', e, 1000, { code: 'RATE_LIMIT', message: 'x' }).type, 'cap')
})

test('decideTurnEnd: pending timer / cooldown / global maxAttempts still guard', () => {
  const st = newSessionState(); st.timer = {}
  assert.equal(decideTurnEnd(st, 'error', eff(), 1000, { code: 'RATE_LIMIT', message: 'x' }).reason, 'pending')
  const st2 = newSessionState(); st2.lastContinueAt = 1000
  assert.equal(decideTurnEnd(st2, 'error', eff({ cooldownMs: 5000 }), 2000, { code: 'RATE_LIMIT', message: 'x' }).reason, 'cooldown')
  const st3 = newSessionState(); st3.attempts = DEFAULTS.maxAttempts
  assert.equal(decideTurnEnd(st3, 'error', eff(), 1000, { code: 'RATE_LIMIT', message: 'x' }).type, 'cap')
})

test('decideTurnEnd: rate-limit honors providerRetryAfterMs', () => {
  const a = decideTurnEnd(newSessionState(), 'error', eff({ backoffBaseMs: 1000, backoffMaxMs: 2000 }), 1000,
    { code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 60000, message: 'slow down' })
  assert.equal(a.type, 'schedule')
  assert.ok(a.delay >= 60000)
})

// ── sanitizeRule / sanitizePatch ─────────────────────────────────────────

test('sanitizeRule: invalid when/action/continue-with-without-model rejected', () => {
  assert.equal(sanitizeRule({ when: 'nope', action: 'continue' }), null)
  assert.equal(sanitizeRule({ when: 'quota', action: 'dance' }), null)
  assert.equal(sanitizeRule({ when: 'quota', action: 'continue-with', model: '' }), null)
  const ok = sanitizeRule({ when: 'rate-limit', action: 'continue-with', provider: ' p ', model: ' m ', maxAttempts: 3 })
  assert.equal(ok.provider, 'p'); assert.equal(ok.model, 'm'); assert.equal(ok.maxAttempts, 3)
  assert.ok(ok.id.length > 0)
})

test('sanitizePatch: rules sanitized, garbage dropped; legacy keys ignored', () => {
  const patch = sanitizePatch({
    rules: [
      { when: 'quota', action: 'stop' },
      { when: 'bogus', action: 'continue' },
      { when: 'any', action: 'continue-with', model: 'm1' },
      'junk',
    ],
    retryOnError: false, followupModel: 'x', fallbackAfterAttempts: 9,
  })
  assert.equal(patch.rules.length, 2)
  assert.equal(patch.rules[0].when, 'quota')
  assert.equal(patch.rules[1].model, 'm1')
  assert.equal(patch.retryOnError, undefined)
  assert.equal(patch.followupModel, undefined)
  assert.equal(patch.fallbackAfterAttempts, undefined)
})

// ── DEFAULTS ─────────────────────────────────────────────────────────────

test('DEFAULTS: rule-driven settings with sensible default table', () => {
  assert.equal(DEFAULTS.maxAttempts, 50)
  assert.equal(DEFAULTS.enabled, true)
  assert.ok(Array.isArray(DEFAULTS.rules) && DEFAULTS.rules.length === 6)
  assert.equal(DEFAULT_RULES[0].when, 'rate-limit')
  assert.equal(DEFAULT_RULES[0].action, 'continue')
  assert.equal(DEFAULT_RULES[1].when, 'quota')
  assert.equal(DEFAULT_RULES[1].action, 'stop')
})

// ── sequence: cap then completed-resets ──────────────────────────────────

test('sequence: N errors schedule N continues, then global cap; completed resets', () => {
  const st = newSessionState()
  const e = eff({ maxAttempts: 3 })
  for (let i = 0; i < 3; i++) {
    const a = decideTurnEnd(st, 'error', e, i * 100000, { code: 'UNKNOWN', message: 'fetch failed' })
    assert.equal(a.type, 'schedule', `iteration ${i}`)
    assert.equal(a.attempt, i + 1)
    st.attempts = a.attempt
    if (a.rule) st.ruleAttempts[a.rule.id] = (st.ruleAttempts[a.rule.id] || 0) + 1
  }
  assert.equal(decideTurnEnd(st, 'error', e, 999999, { code: 'UNKNOWN', message: 'x' }).type, 'cap')
  assert.equal(decideTurnEnd(st, 'completed', e, 9999999).type, 'reset')
  st.attempts = 0
  assert.equal(decideTurnEnd(st, 'error', e, 99999999, { code: 'UNKNOWN', message: 'x' }).type, 'schedule')
})

// ── compact 动作 ─────────────────────────────────────────────────────────

test('decideTurnEnd: context rule action=compact → schedule with compact flag', () => {
  const e = eff({ rules: [{ id: 'c', when: 'context', action: 'compact', provider: '', model: '', maxAttempts: 2 }] })
  const a = decideTurnEnd(newSessionState(), 'error', e, 1000, { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'too long' })
  assert.equal(a.type, 'schedule')
  assert.equal(a.compact, true)
  assert.equal(a.override, null)
  assert.equal(a.rule.id, 'c')
})

test('decideTurnEnd: default rules — context now compacts (≤2), not stops', () => {
  const a = decideTurnEnd(newSessionState(), 'error', eff(), 1000, { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'x' })
  assert.equal(a.type, 'schedule')
  assert.equal(a.compact, true)
  assert.equal(a.rule.id, 'r-context')
})

test('decideTurnEnd: compacting in progress → skip', () => {
  const st = newSessionState(); st.compacting = true
  const a = decideTurnEnd(st, 'error', eff(), 1000, { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'x' })
  assert.equal(a.type, 'skip')
  assert.equal(a.reason, 'compacting')
})

test('sanitizeRule: compact accepted; DEFAULT_RULES context row uses compact', () => {
  const r = sanitizeRule({ when: 'context', action: 'compact', maxAttempts: 2 })
  assert.equal(r.action, 'compact')
  assert.equal(DEFAULT_RULES[3].when, 'context')
  assert.equal(DEFAULT_RULES[3].action, 'compact')
  assert.equal(DEFAULT_RULES[3].maxAttempts, 2)
})
