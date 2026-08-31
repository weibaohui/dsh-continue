/**
 * dsh-plugin-dsh-continue - Browser half.
 *
 * Single surface: the host settings page section. All interactive controls
 * are host primitives (@deepseek-ai/dsh-client-ui-primitives); all colors
 * come from the ui-theme `--dsw-*` token layers so light/dark follows the
 * shell; all copy comes from the locale registry (`zh`/`en`). The client is
 * read-only against the activity ledger — it never writes continues itself;
 * the host owns the event loop and the agent.followup call.
 */

// React is a loader platform module. Under plain Node (contract tests) a
// minimal createElement/hook shim keeps the source loadable for assertions.
let __React = null
try { __React = require('react') } catch {}
if (!__React || typeof __React.createElement !== 'function') {
  __React = {
    createElement(type, props, ...kids) {
      return { type, props: props || {}, kids: kids.flat(9).filter(k => k !== null && k !== undefined && k !== false && k !== true || true) }
    },
    useState(init) { const v = [typeof init === 'function' ? init() : init]; return [v[0], x => { v[0] = typeof x === 'function' ? x(v[0]) : x }] },
    useEffect() {}, useMemo(fn) { return fn() }, useRef(v = null) { return { current: v } },
  }
}
const { createElement: h, useState, useEffect, useMemo, useRef } = __React

// Platform module — always present in the loader's seeded require table.
// Under plain Node (tests) it is absent; a tagged-element shim keeps the
// tree structurally testable while every real surface ships primitives.
let P = null
try { P = require('@deepseek-ai/dsh-client-ui-primitives') } catch {}

// NOTE: no class components in this module. A `class X extends
// React.Component` error boundary defined here silently killed rendering in
// the plugin loader — render-time crashes are handled by the try/catch inside
// SettingsSection and recorded into globalThis.__skErrors instead.

/** Idempotent stylesheet injection. */
function ensureStyles() {
  if (typeof document === 'undefined' || document.getElementById('dshcont-styles')) return
  const holder = document.createElement('div')
  holder.id = 'dshcont-styles'
  holder.style.display = 'none'
  holder.innerHTML = STYLE
  document.head.appendChild(holder)
}

const prim = (name) => P && P[name]
  ? P[name]
  : function Shim(props) {
      const { children, ...rest } = props
      return h('button', { ...rest, 'data-p-shim': name }, children)
    }

// ── Locale ───────────────────────────────────────────────────────────────

const NS = 'dshContinue'

const ZH = {
  title: '自动续跑',
  armed: '已就绪',
  notArmed: '未就绪',
  secBasics: '基础',
  secRules: '续跑规则（从上到下匹配，先命中先用）',
  rulesHint: '每条规则 = 匹配条件 + 动作。某轮失败时从上往下找第一条命中的规则执行；该规则设了次数上限且用尽后，自动继续往下找。所有规则都不适用时按达到全局上限处理。',
  ruleWhen: '匹配条件',
  ruleAction: '动作',
  ruleMaxAttempts: '本规则最多执行（次，0 = 不限）',
  ruleUp: '上移',
  ruleDown: '下移',
  ruleRemove: '删除',
  addRule: '添加规则',
  noRules: '暂无规则——至少保留一条「任意失败」兜底规则，否则失败时不会自动续跑。',
  when_rateLimit: '限流（429）',
  when_quota: '额度耗尽',
  when_auth: '鉴权失败',
  when_context: '上下文超限',
  when_server: '服务端错误（5xx）',
  when_transport: '传输 / 网络错误',
  when_interrupted: '崩溃孤儿轮',
  when_any: '任意失败（兜底）',
  act_continue: '继续续跑',
  'act_continue-with': '换模型继续',
  act_compact: '压缩后继续（先压缩上下文，成功再续跑）',
  act_stop: '停止并通知',
  enabled: '启用自动续跑',
  promptLabel: '续跑 prompt',
  promptHint: '检测到传输错误/崩溃孤儿轮时，向同一会话投递的文本',
  maxAttemptsLabel: '续跑上限（次）',
  maxAttemptsHint: '同一会话在一次失败簇内最多续跑次数；成功一轮后归零',
  cooldownLabel: '冷却（毫秒）',
  backoffBaseLabel: '退避基数（毫秒）',
  backoffMaxLabel: '退避上限（毫秒）',
  backoffHint: '每次续跑前等待 base * 2^attempt，上限封顶',
  retryOnError: '传输错误时续跑',
  retryOnInterrupted: '崩溃孤儿轮时续跑',
  retryOnRateLimit: '限流（429）时续跑',
  retryOnQuota: '额度耗尽时续跑',
  retryOnAuth: '鉴权失败时续跑',
  followupModelLabel: '续跑模型（可选）',
  followupModelHint: '续跑轮改用此模型；选「沿用当前」= 不切换',
  followupProviderLabel: '续跑 provider（可选）',
  followupProviderHint: '配合续跑模型的路由；选「沿用当前」= 不切换',
  fallbackAfterLabel: '连续失败 N 次后换模型',
  fallbackAfterHint: '同一失败簇内续跑 N 次仍失败，后续续跑自动改用备用模型（备用模型选「沿用当前」= 不切换）',
  fallbackProviderLabel: '备用 provider（可选）',
  fallbackModelLabel: '备用模型（可选）',
  catalogUnavailable: '模型目录不可用',
  followupUseCurrent: '沿用当前',
  followupCurrentSetting: '当前设置',
  notifyOnCap: '达上限时通知会话',
  save: '保存',
  saved: '设置已保存',
  notConfigured: '未就绪——宿主未挂载',
  sessionsTitle: '会话计数',
  sessionId: '会话',
  attemptsCol: '续跑次数',
  lastCol: '上次续跑',
  pendingCol: '挂起',
  noSessions: '暂无被追踪的会话',
  activityTitle: '活动日志（尾部）',
  noActivity: '暂无活动',
  loading: '…',
  now: '刚刚',
  operationFailed: '操作失败',
  hint: '当某一轮以传输错误收尾或被关成崩溃孤儿，插件自动向同一会话再投一次「续跑 prompt」。是否重发副作用工具由 agent 自身判断，插件只管上限/冷却/退避护栏。',
}

const EN = {
  title: 'Auto-continue',
  armed: 'armed',
  notArmed: 'not armed',
  secBasics: 'Basics',
  secRules: 'Continue rules (matched top-down; first hit wins)',
  rulesHint: 'Each rule = a match condition + an action. On a failed turn the engine walks the list and runs the first rule that matches and is not exhausted (its own attempt cap, if set). When nothing applies, the global cap handling kicks in.',
  ruleWhen: 'Match condition',
  ruleAction: 'Action',
  ruleMaxAttempts: 'Max runs for this rule (0 = unlimited)',
  ruleUp: 'Up',
  ruleDown: 'Down',
  ruleRemove: 'Remove',
  addRule: 'Add rule',
  noRules: 'No rules — keep at least one "any failure" fallback rule, otherwise failed turns will not auto-continue.',
  when_rateLimit: 'Rate limit (429)',
  when_quota: 'Quota exhausted',
  when_auth: 'Auth failure',
  when_context: 'Context window exceeded',
  when_server: 'Server error (5xx)',
  when_transport: 'Transport / network error',
  when_interrupted: 'Crash-orphan turn',
  when_any: 'Any failure (fallback)',
  act_continue: 'Continue (current model)',
  'act_continue-with': 'Continue with another model',
  act_compact: 'Compact then continue',
  act_stop: 'Stop and notify',
  enabled: 'Enable auto-continue',
  promptLabel: 'Continue prompt',
  promptHint: 'Text re-sent to the same session on transport error / crash-orphan turn',
  maxAttemptsLabel: 'Max attempts',
  maxAttemptsHint: 'Max continues per session in one failure cluster; resets on a completed turn',
  cooldownLabel: 'Cooldown (ms)',
  backoffBaseLabel: 'Backoff base (ms)',
  backoffMaxLabel: 'Backoff cap (ms)',
  backoffHint: 'Wait base * 2^attempt before each continue, capped',
  retryOnError: 'Retry on transport error',
  retryOnInterrupted: 'Retry on crash-orphan turn',
  retryOnRateLimit: 'Retry on rate limit (429)',
  retryOnQuota: 'Retry on quota exhaustion',
  retryOnAuth: 'Retry on auth failure',
  followupModelLabel: 'Continue model (optional)',
  followupModelHint: 'Continue turns use this model; "keep current" = no switch',
  followupProviderLabel: 'Continue provider (optional)',
  followupProviderHint: 'Provider route for the continue model; "keep current" = no switch',
  fallbackAfterLabel: 'Switch model after N failures',
  fallbackAfterHint: 'After N failed continues in one cluster, later continues switch to the fallback model ("keep current" = no switch)',
  fallbackProviderLabel: 'Fallback provider (optional)',
  fallbackModelLabel: 'Fallback model (optional)',
  catalogUnavailable: 'Model catalog unavailable',
  followupUseCurrent: 'Keep current',
  followupCurrentSetting: 'current setting',
  notifyOnCap: 'Notify session on cap',
  save: 'Save',
  saved: 'Settings saved',
  notConfigured: 'Not armed — host not mounted',
  sessionsTitle: 'Session counters',
  sessionId: 'Session',
  attemptsCol: 'Continues',
  lastCol: 'Last continue',
  pendingCol: 'Pending',
  noSessions: 'No tracked sessions',
  activityTitle: 'Activity log (tail)',
  noActivity: 'No activity yet',
  loading: '…',
  now: 'now',
  operationFailed: 'Operation failed',
  hint: 'When a turn ends in a transport error or is closed as a crash-orphan, the plugin re-sends the continue prompt to the same session. Whether to re-issue a side-effecting tool is the agent own call; this plugin only enforces cap/cooldown/backoff.',
}

// ── Pure helpers ────────────────────────────────────────────────────────

const API = '/dsh-continue/api'

async function getJson(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error('HTTP ' + r.status)
  return r.json()
}

function formatTime(ms) {
  if (!ms) return '-'
  const diff = Date.now() - ms
  if (diff < 0) return t_now()
  const m = Math.floor(diff / 60000)
  if (m > 60) return Math.floor(m / 60) + 'h'
  if (m > 0) return m + 'm'
  const s = Math.floor(diff / 1000)
  return s <= 5 ? t_now() : s + 's'
}
// locale-bound at render; default to EN.now until t() resolved
let t_now = () => 'now'

function shortId(sid) {
  if (!sid || typeof sid !== 'string') return '-'
  return sid.length <= 16 ? sid : sid.slice(0, 8) + '…' + sid.slice(-4)
}

// ── Token-based stylesheet (light/dark adaptive by construction) ────────

const STYLE = `<style>
.dc-page{position:relative;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:var(--dsw-font-sm-14,14px)}
.dc-body{display:flex;flex-direction:column;gap:14px}
.dc-toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.dc-spacer{flex:1}
.dc-hint{color:var(--dsw-alias-label-secondary)}
.dc-dir{color:var(--dsw-alias-label-tertiary);font-size:var(--dsw-font-xs-13,12px)}
.dc-tag{display:inline-flex;align-items:center;padding:2px 9px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:11.5px}
.dc-tag.accent{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}
.dc-card{display:flex;flex-direction:column;gap:10px;padding:16px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dc-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dc-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dc-field{display:flex;flex-direction:column;gap:4px}
.dc-toggles{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px}
.dc-toggle{display:flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:13px;cursor:pointer}
.dc-toggle.on{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dc-spin{width:22px;height:22px;border-radius:50%;border:3px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary));animation:dcspin .7s linear infinite}
@keyframes dcspin{to{transform:rotate(360deg)}}
.dc-table{width:100%;border-collapse:collapse;font-size:12.5px}
.dc-table th{text-align:left;padding:6px 8px;color:var(--dsw-alias-label-tertiary);font-weight:500;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dc-table td{padding:6px 8px;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1)}
.dc-log{max-height:240px;overflow:auto;display:flex;flex-direction:column;gap:2px;font-size:12px}
.dc-log-line{display:flex;gap:8px;padding:2px 4px;color:var(--dsw-alias-label-secondary)}
.dc-log-ev{color:var(--dsw-alias-state-business-primary);min-width:120px;font-family:var(--dsw-font-family-mono,monospace)}
.dc-log-time{color:var(--dsw-alias-label-tertiary);min-width:64px;font-family:var(--dsw-font-family-mono,monospace)}
.dc-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;padding:6px 16px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;cursor:pointer;font-family:var(--dsw-font-family);white-space:nowrap}
.dc-btn:hover{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-interactive-bg-hover)}
.dc-btn:disabled{opacity:.5;cursor:not-allowed}
.dc-btn-primary{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:var(--dsw-alias-label-primary-inverted,#fff)}
.dc-btn-primary:hover{filter:brightness(1.08);background:var(--dsw-alias-state-business-primary)}
.dc-input{min-height:32px;padding:6px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;font-family:var(--dsw-font-family);outline:none;box-sizing:border-box}
.dc-input:focus{border-color:var(--dsw-alias-state-business-primary)}
.dc-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:40;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:8px 18px;font-size:13px;box-shadow:var(--dsw-shadow-lv2)}
.dc-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dc-flow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:10px 12px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px}
.dc-pill{display:inline-flex;align-items:center;padding:3px 10px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:11.5px}
.dc-pill.hl{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}
.dc-arrow{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dc-step{display:flex;gap:10px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.dc-badge{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;border-radius:50%;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-inverted,#fff);font-size:12px;font-weight:600;flex-shrink:0;margin-top:2px}
.dc-step-body{display:flex;flex-direction:column;gap:8px;flex:1}
.dc-step-title{font-size:13px;color:var(--dsw-alias-label-primary);font-weight:500}
.dc-gap{display:flex;flex-direction:column;gap:8px}
</style>`

// ── Small building blocks ────────────────────────────────────────────────

const Tag = ({ tone, children }) =>
  h('span', { className: 'dc-tag' + (tone ? ' ' + tone : '') }, children)

function ButtonLite({ primary, small, children, ...rest }) {
  const cls = 'dc-btn' + (primary ? ' dc-btn-primary' : '') + (small ? ' dc-btn-sm' : '')
  if (prim('Button')) {
    return h(P.Button, { variant: primary ? 'primary' : 'outline', size: small ? 'sm' : 'md', className: cls, ...rest }, children)
  }
  return h('button', { className: cls, ...rest }, children)
}

function InToast({ text }) {
  return h('div', { className: 'dc-toast' }, text)
}

function num(v, fallback) { const n = Number(v); return Number.isFinite(n) ? n : fallback }

// ── Settings section: the single entrance (host settings page section) ──

function SettingsSection({ t }) {
  t_now = () => t('now')
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)
  const [toastText, setToastText] = useState(null)
  const [enabled, setEnabled] = useState(true)
  const [prompt, setPrompt] = useState('继续')
  const [maxAttempts, setMaxAttempts] = useState(50)
  const [cooldownMs, setCooldownMs] = useState(5000)
  const [backoffBaseMs, setBackoffBaseMs] = useState(2000)
  const [backoffMaxMs, setBackoffMaxMs] = useState(30000)
  const [rules, setRules] = useState(null)                  // null = 尚未加载
  const [modelCatalog, setModelCatalog] = useState(null)
  const [notifyOnCap, setNotifyOnCap] = useState(true)

  const onToast = (text, ms = 3000) => { setToastText(text); setTimeout(() => setToastText(null), ms) }
  const refresh = () => getJson(API + '/status').then(d => {
    setStatus(d)
    const s = d && d.settings || {}
    setEnabled(s.enabled !== false)
    if (typeof s.prompt === 'string') setPrompt(s.prompt)
    setMaxAttempts(num(s.maxAttempts, 50))
    setCooldownMs(num(s.cooldownMs, 5000))
    setBackoffBaseMs(num(s.backoffBaseMs, 2000))
    setBackoffMaxMs(num(s.backoffMaxMs, 30000))
    setRules(Array.isArray(s.rules) && s.rules.length > 0 ? s.rules : [])
    setNotifyOnCap(s.notifyOnCap !== false)
  }).catch(() => {})
  const refreshCatalog = () => getJson(API + '/models')
    .then(d => setModelCatalog(d && Array.isArray(d.providers) && d.providers.length > 0 ? d : null))
    .catch(() => setModelCatalog(null))
  useEffect(() => {
    refresh()
    refreshCatalog()
    const timer = setInterval(refresh, 15000)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, [])

  const doSave = async () => {
    setBusy(true)
    try {
      const payloadRules = (rules || []).map(r => ({
        id: r.id || '', when: r.when, action: r.action,
        provider: r.provider || '', model: r.model || '',
        maxAttempts: Number(r.maxAttempts) || 0,
      }))
      const r = await fetch(API + '/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, prompt, maxAttempts, cooldownMs, backoffBaseMs, backoffMaxMs, rules: payloadRules, notifyOnCap }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status)
      onToast(t('saved'), 2200)
      refresh()
    } catch (e) { onToast(e.message || t('operationFailed'), 4000) }
    finally { setBusy(false) }
  }

  let body
  try {
    const toggle = (key, label, getter, setter) => h('label', { key, className: 'dc-toggle' + (getter() ? ' on' : '') },
      h('input', { type: 'checkbox', checked: getter(), onChange: e => setter(e.target.checked) }), label)

    // ── 规则编辑 ──
    const WHEN_KEYS = { 'rate-limit': 'when_rateLimit', quota: 'when_quota', auth: 'when_auth', context: 'when_context', server: 'when_server', transport: 'when_transport', interrupted: 'when_interrupted', any: 'when_any' }
    const RULE_WHEN_VALUES = ['rate-limit', 'quota', 'auth', 'context', 'server', 'transport', 'interrupted', 'any']
    const RULE_ACTION_VALUES = ['continue', 'continue-with', 'compact', 'stop']
    const updateRule = (idx, patch) => setRules(rs => (rs || []).map((r, i2) => i2 === idx ? { ...r, ...patch } : r))
    const moveRule = (idx, dir) => setRules(rs => {
      const rs2 = [...(rs || [])]; const j = idx + dir
      if (j < 0 || j >= rs2.length) return rs2
      const tmp = rs2[idx]; rs2[idx] = rs2[j]; rs2[j] = tmp
      return rs2
    })
    const removeRule = (idx) => setRules(rs => (rs || []).filter((_, i2) => i2 !== idx))
    const addRule = () => setRules(rs => [...(rs || []), {
      id: 'r-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      when: 'any', action: 'continue', provider: '', model: '', maxAttempts: 0,
    }])

    // ── provider+model 选择器：一律下拉（实时目录），不提供手填。
    // 目录缺失时仅显示「沿用当前」与已存值（当前设置），保证受控 select 有匹配项。──
    const catalog = modelCatalog
    const modelPickerPair = (providerVal, onProvider, modelVal, onModel) => {
      const pe = catalog && providerVal ? catalog.providers.find(p => p.id === providerVal) : null
      const missingProvider = providerVal && !(catalog && catalog.providers.some(p => p.id === providerVal))
      const missingModel = providerVal && modelVal && !(pe && pe.models.some(m => m.id === modelVal))
      const pf = h('select', { className: 'dc-input', value: providerVal, style: { width: '100%' },
          onChange: e => {
            const v = e.target.value
            onProvider(v)
            const np = catalog ? catalog.providers.find(p => p.id === v) : null
            if (!np || !np.models.some(m => m.id === modelVal)) onModel('')
          } },
          h('option', { value: '' }, t('followupUseCurrent') + (catalog && catalog.default && catalog.default.provider ? '（' + catalog.default.provider + '）' : '')),
          catalog ? catalog.providers.map(p => h('option', { key: p.id, value: p.id }, p.name && p.name !== p.id ? p.name + '（' + p.id + '）' : p.id)) : null,
          missingProvider ? h('option', { key: '__prov__', value: providerVal }, providerVal + '（' + t('followupCurrentSetting') + '）') : null)
      const mf = h('select', { className: 'dc-input', value: providerVal ? modelVal : '', disabled: !providerVal, style: { width: '100%' },
          onChange: e => onModel(e.target.value) },
          !providerVal
            ? h('option', { value: '' }, t('followupUseCurrent') + (catalog && catalog.default && catalog.default.model ? '（' + catalog.default.model + '）' : ''))
            : [h('option', { key: '__keep__', value: '' }, t('followupUseCurrent')),
               pe ? pe.models.map(m => h('option', { key: m.id, value: m.id }, m.name && m.name !== m.id ? m.name + '（' + m.id + '）' : m.id)) : null,
               missingModel ? h('option', { key: '__custom__', value: modelVal }, modelVal + '（' + t('followupCurrentSetting') + '）') : null])
      return { pf, mf }
    }
    const ruleRow = (rule, i, total) => {
      const picker = modelPickerPair(rule.provider || '', v => updateRule(i, { provider: v }), rule.model || '', v => updateRule(i, { model: v }))
      return h('div', { key: rule.id || i, className: 'dc-step' },
        h('span', { className: 'dc-badge' }, String(i + 1)),
        h('div', { className: 'dc-step-body' },
          h('div', { className: 'dc-row' },
            h('div', { className: 'dc-field' },
              h('label', { className: 'dc-dir' }, t('ruleWhen')),
              h('select', { className: 'dc-input', value: rule.when, onChange: e => updateRule(i, { when: e.target.value }) },
                RULE_WHEN_VALUES.map(w => h('option', { key: w, value: w }, t(WHEN_KEYS[w]))))),
            h('div', { className: 'dc-field' },
              h('label', { className: 'dc-dir' }, t('ruleAction')),
              h('select', { className: 'dc-input', value: rule.action, onChange: e => updateRule(i, { action: e.target.value }) },
                RULE_ACTION_VALUES.map(a => h('option', { key: a, value: a }, t('act_' + a))))),
            h('div', { className: 'dc-field' },
              h('label', { className: 'dc-dir' }, t('ruleMaxAttempts')),
              h('input', { className: 'dc-input', type: 'number', min: 0, value: rule.maxAttempts || 0, onChange: e => updateRule(i, { maxAttempts: Math.max(0, num(e.target.value, 0)) }), style: { width: 110 } }))),
          rule.action === 'continue-with'
            ? h('div', { className: 'dc-row' },
                h('div', { className: 'dc-field', style: { flex: 1, minWidth: 200 } },
                  h('label', { className: 'dc-dir' }, t('fallbackProviderLabel')),
                  picker.pf),
                h('div', { className: 'dc-field', style: { flex: 1, minWidth: 200 } },
                  h('label', { className: 'dc-dir' }, t('fallbackModelLabel')),
                  picker.mf))
            : null,
          h('div', { className: 'dc-toolbar' },
            h('button', { className: 'dc-btn', onClick: () => moveRule(i, -1), disabled: i === 0, title: t('ruleUp') }, '↑'),
            h('button', { className: 'dc-btn', onClick: () => moveRule(i, 1), disabled: i === total - 1, title: t('ruleDown') }, '↓'),
            h('button', { className: 'dc-btn', onClick: () => removeRule(i), title: t('ruleRemove') }, '✕'))))
    }

    body = status === null
      ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: 24, color: 'var(--dsw-alias-label-secondary)' } },
          h('div', { className: 'dc-spin' }), t('loading'))
      : h('div', { className: 'dc-body' },
          h('div', { className: 'dc-head' },
            h(Tag, { tone: status.armed ? 'accent' : '' }, status.armed ? t('armed') : t('notArmed')),
            h('span', { className: 'dc-spacer' }),
            !status.armed && h(Tag, null, t('notConfigured'))),
          h('div', { className: 'dc-hint' }, t('hint')),
          // ── 卡1：基础 ──
          h('div', { className: 'dc-card' },
            h('div', { className: 'dc-title' }, t('secBasics')),
            toggle('enabled', t('enabled'), () => enabled, setEnabled),
            h('div', { className: 'dc-field' },
              h('label', { className: 'dc-dir' }, t('promptLabel')),
              h('input', { className: 'dc-input', value: prompt, onChange: e => setPrompt(e.target.value), style: { width: '100%' } }),
              h('div', { className: 'dc-dir' }, t('promptHint')))),
          // ── 卡2：有序规则表（先命中先用） ──
          h('div', { className: 'dc-card' },
            h('div', { className: 'dc-title' }, t('secRules')),
            h('div', { className: 'dc-dir' }, t('rulesHint')),
            !rules || rules.length === 0
              ? h('div', { className: 'dc-hint' }, t('noRules'))
              : rules.map((rule, i) => ruleRow(rule, i, rules.length)),
            h('div', { className: 'dc-toolbar' },
              h(ButtonLite, { small: true, onClick: addRule }, '+ ' + t('addRule')))),
          // ── 卡3：护栏 ──
          h('div', { className: 'dc-card' },
            h('div', { className: 'dc-title' }, t('secGuards')),
            h('div', { className: 'dc-row' },
              h('div', { className: 'dc-field' },
                h('label', { className: 'dc-dir' }, t('maxAttemptsLabel')),
                h('input', { className: 'dc-input', type: 'number', min: 1, value: maxAttempts, onChange: e => setMaxAttempts(Math.max(1, num(e.target.value, 50))), style: { width: 120 } })),
              toggle('notifyOnCap', t('notifyOnCap'), () => notifyOnCap, setNotifyOnCap)),
            h('div', { className: 'dc-row' },
              h('div', { className: 'dc-field' },
                h('label', { className: 'dc-dir' }, t('cooldownLabel')),
                h('input', { className: 'dc-input', type: 'number', min: 0, value: cooldownMs, onChange: e => setCooldownMs(Math.max(0, num(e.target.value, 5000))), style: { width: 120 } })),
              h('div', { className: 'dc-field' },
                h('label', { className: 'dc-dir' }, t('backoffBaseLabel')),
                h('input', { className: 'dc-input', type: 'number', min: 0, value: backoffBaseMs, onChange: e => setBackoffBaseMs(Math.max(0, num(e.target.value, 2000))), style: { width: 120 } })),
              h('div', { className: 'dc-field' },
                h('label', { className: 'dc-dir' }, t('backoffMaxLabel')),
                h('input', { className: 'dc-input', type: 'number', min: 1000, value: backoffMaxMs, onChange: e => setBackoffMaxMs(Math.max(1000, num(e.target.value, 30000))), style: { width: 120 } }))),
            h('div', { className: 'dc-dir' }, t('backoffHint')),
            h('div', { className: 'dc-dir' }, t('maxAttemptsHint'))),
          // ── Session counters ──
          h('div', { className: 'dc-card' },
            h('div', { className: 'dc-head' }, h('span', { className: 'dc-dir' }, t('sessionsTitle'))),
            (status.perSession === undefined || status.perSession.length === 0)
              ? h('div', { className: 'dc-hint' }, t('noSessions'))
              : h('table', { className: 'dc-table' },
                  h('thead', null, h('tr', null,
                    h('th', null, t('sessionId')), h('th', null, t('attemptsCol')),
                    h('th', null, t('lastCol')), h('th', null, t('pendingCol')))),
                  h('tbody', null, status.perSession.map(s => h('tr', { key: s.sessionId },
                    h('td', { style: { fontFamily: 'var(--dsw-font-family-mono,monospace)' } }, shortId(s.sessionId)),
                    h('td', null, String(s.attempts || 0)),
                    h('td', null, formatTime(s.lastContinueAt)),
                    h('td', null, s.pending ? '●' : '-')))))),
          // ── Activity tail ──
          h('div', { className: 'dc-card' },
            h('div', { className: 'dc-head' }, h('span', { className: 'dc-dir' }, t('activityTitle'))),
            (!status.activityTail || status.activityTail.length === 0)
              ? h('div', { className: 'dc-hint' }, t('noActivity'))
              : h('div', { className: 'dc-log' }, status.activityTail.map((l, i) => {
                  const at = l.at ? new Date(l.at).toLocaleTimeString() : ''
                  const ev = l.event || ''
                  const data = l.event ? ' ' + Object.keys(l).filter(k => k !== 'at' && k !== 'event').map(k => k + '=' + (typeof l[k] === 'string' ? l[k] : JSON.stringify(l[k]))).join(' ') : ''
                  return h('div', { key: i, className: 'dc-log-line' },
                    h('span', { className: 'dc-log-time' }, at),
                    h('span', { className: 'dc-log-ev' }, ev),
                    h('span', null, data))
                }))),
          h('div', { className: 'dc-toolbar' },
            h(ButtonLite, { primary: true, disabled: busy, onClick: doSave }, t('save'))))
  } catch (renderErr) {
    ;(globalThis.__skErrors = globalThis.__skErrors || []).push('body: ' + (renderErr && renderErr.message))
    body = h('div', { className: 'dc-card', style: { color: 'var(--dsw-alias-state-error-primary)' } },
      '\u26A0\uFE0F ' + String((renderErr && renderErr.message) || renderErr))
  }

  return h('div', { className: 'dc-page' },
    h('div', { className: 'dc-body' }, body),
    toastText && h(InToast, { text: toastText }),
  )
}

function SettingsSlotComponent(props) {
  useEffect(ensureStyles, [])
  return h(SettingsSection, { t: props.__t })
}

// ── Plugin plane contract ────────────────────────────────────────────────

const CLIENT_NAME = 'dsh-plugin-dsh-continue'

module.exports = {
  name: CLIENT_NAME,
  inject: ['slots', 'locale'],
  __internals: { NS, ZH, EN, shortId },
  __boot(container, opts = {}) {
    ensureStyles()
    let t = opts.t || ((key, vars) => {
      let out = EN[key] ?? key
      if (vars) for (const [k, v] of Object.entries(vars)) out = out.split('{' + k + '}').join(String(v))
      return out
    })
    const root = require('react-dom/client').createRoot(container)
    root.render(h(SettingsSection, { t }))
    return root
  },
  apply(ctx) {
    let t = (key, vars) => {
      let out = EN[key] ?? key
      if (vars) for (const [k, v] of Object.entries(vars)) out = out.split('{' + k + '}').join(String(v))
      return out
    }
    try {
      if (ctx.locale && typeof ctx.locale.register === 'function') {
        ctx.locale.register(NS, 'zh', ZH)
        ctx.locale.register(NS, 'en', EN)
        const bound = typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : null
        if (bound) {
          t = (key, vars) => {
            let out = bound(key) || key
            if (vars) for (const [k, v] of Object.entries(vars)) out = out.split('{' + k + '}').join(String(v))
            return out
          }
          globalThis.__dshContinueLocaleLive = true
        }
      }
    } catch (e) { try { console.error('[dsh-continue] locale init:', e) } catch {} }
    ctx.effect(() => {
      try {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: CLIENT_NAME,
          order: 96,
          locale: NS,
          label: () => t('title'),
          inject: () => ({}),
        }, function SettingsSectionSlot() {
          return h(SettingsSlotComponent, { __t: t })
        }))
      } catch (e) { (globalThis.__skErrors = globalThis.__skErrors || []).push('settings:' + (e && e.message)); throw e }
    }, 'dsh-continue: settings section')
  },
}
