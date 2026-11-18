/**
 * 回归测试（issue #10）：设置页 15 秒轮询不得覆盖用户正在编辑的表单项。
 *
 * 旧行为：setInterval(refresh, 15000) 每轮无条件用服务端 /status 回写全部表单
 * state（enabled/prompt/上限/冷却/退避/rules/notifyOnCap），用户改了规则还没点
 * 保存就被还原。新行为（dsh-sync 同款 dirtyRef 模式）：
 *   - 首次成功装载必回填（含首轮请求失败后的首个成功轮）；
 *   - 用户动过表单（原生 input/change 捕获监听置 dirtyRef）后，轮询只刷只读区
 *     （armed/会话计数/活动日志），表单项不再被回写；
 *   - 保存成功清掉 dirty，下一个轮询周期恢复「服务端值 → 表单」同步。
 *
 * client/index.js 在纯 Node 下可加载（文件头注释即为此设计）。这里用带状态、
 * 会真实执行 useEffect 的 React shim 经 __boot 挂载组件，mock fetch 与
 * setInterval，走完「装载 → 编辑 → 轮询 → 保存 → 再轮询」全流程断言。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'client', 'index.js'), 'utf8')

// ── 带状态的 React shim：useState/useRef 落在模块级数组（可从测试读/预置），
// useEffect 真实执行（render 返回后统一跑，模拟 React commit 后的 effect 阶段）。──
const hookState = []
let hookIdx = 0
const pendingEffects = []
const MiniReact = {
  createElement(type, props, ...kids) {
    return { type, props: props || {}, kids: kids.flat(9).filter(k => k !== null && k !== undefined && k !== false) }
  },
  useState(init) {
    const i = hookIdx++
    if (!(i in hookState)) hookState[i] = typeof init === 'function' ? init() : init
    const setter = v => { hookState[i] = typeof v === 'function' ? v(hookState[i]) : v }
    return [hookState[i], setter]
  },
  useRef(v = null) {
    const i = hookIdx++
    if (!(i in hookState)) hookState[i] = { current: v }
    return hookState[i]
  },
  useEffect(fn) { pendingEffects.push(fn) },
  useMemo(fn) { return fn() },
}

// hook 槽位（与组件体声明顺序一一对应；组件改 hook 顺序时这里会炸出来提醒同步）：
// 0 status 1 busy 2 toastText 3 enabled 4 prompt 5 maxAttempts 6 cooldownMs
// 7 backoffBaseMs 8 backoffMaxMs 9 rules 10 modelCatalog 11 notifyOnCap
// 12 loadedRef 13 dirtyRef 14 rootRef
const SLOT = { status: 0, enabled: 3, prompt: 4, maxAttempts: 5, rules: 9, dirtyRef: 13, rootRef: 14 }

function makeFakeRoot() {
  const listeners = {}
  return {
    listeners,
    addEventListener(type, fn, capture) { (listeners[type] = listeners[type] || []).push({ fn, capture }) },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter(x => x.fn !== fn) },
    dispatch(type) { for (const x of listeners[type] || []) x.fn({ type, target: {} }) },
  }
}

function bootClient({ serverSettings }) {
  const fakeRoot = makeFakeRoot()
  // rootRef 槽位预置假根节点（真实 React 里 ref 在 effect 前挂好，这里等效模拟）
  hookState[SLOT.rootRef] = { current: fakeRoot }
  let renderedEl = null
  const fakeRequire = (name) => {
    if (name === 'react') return MiniReact
    if (name === 'react-dom/client') return { createRoot: () => ({ render: el => { renderedEl = el } }) }
    throw new Error('unexpected require: ' + name)
  }
  new Function('require', 'module', 'exports', 'window', src)(fakeRequire, {}, {}, undefined)
  const t = (key, vars) => {
    let out = key
    if (vars) for (const [k, v] of Object.entries(vars)) out = out.split('{' + k + '}').join(String(v))
    return out
  }
  // fetch mock：/status 回 serverSettings；PUT /settings 采纳请求体并原样回显
  const putBodies = []
  const mk = (obj, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(obj), json: async () => obj })
  globalThis.__guardFetch = async (url, init = {}) => {
    const u = String(url)
    if (u.endsWith('/status')) return mk({ settings: serverSettings(), armed: true, perSession: [], activityTail: [] })
    if (u.endsWith('/models')) return mk({ providers: [] })
    if (u.endsWith('/settings') && (init.method || '') === 'PUT') {
      const body = JSON.parse(init.body)
      putBodies.push(body)
      serverSettings({ ...serverSettings(), ...body })
      return mk({ settings: serverSettings() })
    }
    return mk({}, 404)
  }
  const origFetch = globalThis.fetch
  const origSetInterval = globalThis.setInterval
  const origClearInterval = globalThis.clearInterval
  const interval = { fn: null, ms: 0 }
  globalThis.fetch = (...a) => globalThis.__guardFetch(...a)
  globalThis.setInterval = (fn, ms) => { interval.fn = fn; interval.ms = ms; return { unref() {} } }
  globalThis.clearInterval = () => {}
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', 'window', src)(fakeRequire, mod, mod.exports, undefined)
  mod.exports.__boot({ innerHTML: '' }, { t })
  assert.ok(renderedEl, '__boot 应触发根组件渲染')
  const render = () => {
    pendingEffects.length = 0
    hookIdx = 0
    const el = renderedEl.type(renderedEl.props)
    for (const fn of pendingEffects) { try { fn() } catch {} }
    return el
  }
  const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r)) }
  return {
    render, flush, interval, putBodies, fakeRoot,
    cleanup() {
      globalThis.fetch = origFetch
      globalThis.setInterval = origSetInterval
      globalThis.clearInterval = origClearInterval
      hookState.length = 0
      pendingEffects.length = 0
    },
  }
}

/** 深度收集渲染树里的宿主元素（type 为字符串的节点）。 */
function collect(el, out = []) {
  if (!el || typeof el !== 'object') return out
  if (Array.isArray(el)) { el.forEach(x => collect(x, out)); return out }
  out.push(el)
  for (const k of el.kids || []) collect(k, out)
  return out
}

test('15s 轮询不覆盖用户正在编辑的设置项；保存后同步恢复（issue#10）', async () => {
  let settings = {
    enabled: true, prompt: 'server-a', maxAttempts: 7, cooldownMs: 5000,
    backoffBaseMs: 2000, backoffMaxMs: 30000,
    rules: [{ id: 'r1', when: 'any', action: 'continue', provider: '', model: '', maxAttempts: 0, codes: '' }],
    notifyOnCap: true,
  }
  const env = bootClient({ serverSettings: (next) => { if (next) settings = next; return settings } })
  try {
    // ── 首次装载：服务端值回填表单，15s 定时器注册 ──
    env.render()
    await env.flush()
    env.render()
    await env.flush()
    assert.equal(env.interval.ms, 15000, '轮询周期仍是 15 秒')
    assert.equal(typeof env.interval.fn, 'function', 'refresh 已挂上 interval')
    assert.equal(hookState[SLOT.prompt], 'server-a', '首次装载回填服务端值')
    assert.equal(hookState[SLOT.maxAttempts], 7)
    assert.ok(Array.isArray(hookState[SLOT.rules]) && hookState[SLOT.rules][0].id === 'r1')
    assert.equal(hookState[SLOT.dirtyRef].current, false)

    // ── 用户编辑（原生 input 事件置脏 + onChange 改值）──
    env.fakeRoot.dispatch('input')
    const tree = env.render()
    const promptInput = collect(tree).find(e => e.type === 'input' && e.props.value === 'server-a' && typeof e.props.onChange === 'function')
    assert.ok(promptInput, '能找到 prompt 输入框')
    promptInput.props.onChange({ target: { value: 'user-edit' } })
    assert.equal(hookState[SLOT.prompt], 'user-edit')
    assert.equal(hookState[SLOT.dirtyRef].current, true, '原生捕获监听已置脏')

    // ── 15s 轮询：服务端值变了，但表单不被回写；只读区照常刷新 ──
    settings = { ...settings, prompt: 'server-b', maxAttempts: 99 }
    env.interval.fn()
    await env.flush()
    assert.equal(hookState[SLOT.prompt], 'user-edit', '脏标记下轮询不得覆盖未保存的编辑')
    assert.equal(hookState[SLOT.maxAttempts], 7, '其余表单项同样不回写')
    assert.equal(hookState[SLOT.status] && hookState[SLOT.status].settings && hookState[SLOT.status].settings.prompt, 'server-b', '只读状态区照常更新')
    // 再来一轮也不覆盖
    env.interval.fn()
    await env.flush()
    assert.equal(hookState[SLOT.prompt], 'user-edit')

    // ── 保存：PUT 带的是用户编辑值；成功后解除脏标记 ──
    const tree2 = env.render()
    const saveBtn = collect(tree2).find(e => e.props && e.props.primary === true && typeof e.props.onClick === 'function')
    assert.ok(saveBtn, '能找到保存按钮')
    saveBtn.props.onClick()
    await env.flush()
    assert.equal(env.putBodies.length, 1, '保存发出 PUT')
    assert.equal(env.putBodies[0].prompt, 'user-edit', '保存的是用户编辑后的值')
    assert.equal(hookState[SLOT.dirtyRef].current, false, '保存成功解除脏标记')

    // ── 保存后的轮询恢复「服务端值 → 表单」同步 ──
    settings = { ...settings, prompt: 'server-c', maxAttempts: 9 }
    env.interval.fn()
    await env.flush()
    assert.equal(hookState[SLOT.prompt], 'server-c', '保存后轮询恢复表单同步')
    assert.equal(hookState[SLOT.maxAttempts], 9)
  } finally {
    env.cleanup()
  }
})

test('首轮 /status 请求失败后，后续轮询仍会完成首次表单装载', async () => {
  let fail = true
  let settings = { enabled: false, prompt: 'late', maxAttempts: 3, cooldownMs: 5000, backoffBaseMs: 2000, backoffMaxMs: 30000, rules: [], notifyOnCap: true }
  const env = bootClient({
    serverSettings: (next) => {
      if (next) settings = next
      if (fail) throw new Error('HTTP 500')
      return settings
    },
  })
  try {
    env.render()
    await env.flush()
    assert.equal(hookState[SLOT.prompt], '继续', '首轮失败：表单保持初始值')
    assert.equal(hookState[SLOT.dirtyRef].current, false)
    fail = false
    env.interval.fn()
    await env.flush()
    assert.equal(hookState[SLOT.prompt], 'late', '首个成功轮补上装载')
    assert.equal(hookState[SLOT.maxAttempts], 3)
  } finally {
    env.cleanup()
  }
})
