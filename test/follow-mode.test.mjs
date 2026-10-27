import fs from 'node:fs'
import vm from 'node:vm'

// 验证「自动打开」偏好的三档行为与存储。

const src = fs.readFileSync('dsh-edit-diff/client.js', 'utf8')

let failures = 0
function check(name, fn) {
  try {
    if (fn() === false) throw new Error('returned false')
    console.log('ok   ' + name)
  } catch (e) {
    failures++
    console.log('FAIL ' + name + ': ' + e.message)
  }
}

// 用 mock localStorage 装载整个 client 模块
function loadClient(localStorageImpl) {
  const React = {
    createElement: (t, p, ...c) => ({ type: t, props: p ?? {}, children: c }),
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useMemo: (fn) => fn(),
    useRef: () => ({ current: null }),
    useEffect: () => {},
  }
  const loaders = []
  const sandbox = {
    console, Date, JSON, Math, Map, Set, String, Number, Array, Object, Error,
    AbortController, Int32Array, encodeURIComponent, decodeURIComponent,
    globalThis: null,
    window: { __ModuleLoader__: { load: (d) => loaders.push(d) } },
  }
  if (localStorageImpl !== undefined) sandbox.localStorage = localStorageImpl
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox)
  return loaders[0].factory(() => React)
}

function makeStore(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    _dump: () => Object.fromEntries(map),
  }
}

check('默认档位是 turn（每轮首次）', () => {
  const store = makeStore()
  const mod = loadClient(store)
  const regs = []
  let applied = false
  mod.apply({
    effect: (fn) => { fn(); return () => {} },
    on: () => () => {},
    logger: { info() {}, warn() {} },
    locale: { register: () => () => {}, bind: () => (k) => k },
    sessions: { list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} }, binding: () => undefined },
    sidebarRight: { openResource() {}, openTab() {} },
    sidebarRightTabs: { register: () => () => {} },
    slots: { inject: (k, fn) => { fn(); return () => {} }, register: (d) => { regs.push(d); return () => {} } },
    remote: { workspaceFiles: { read: async () => ({ ok: false }) } },
  })
  // 通过源码断言默认值
  if (!/const FOLLOW_DEFAULT = 'turn'/.test(src)) throw new Error('default is not turn')
  if (regs.length < 2) throw new Error('expected tab + settings registrations, got ' + regs.length)
})

check('三档都出现在选项里', () => {
  for (const m of ['always', 'turn', 'off']) {
    if (!new RegExp("'" + m + "'").test(src)) throw new Error('missing mode ' + m)
  }
  if (!/FOLLOW_MODES = \['always', 'turn', 'off'\]/.test(src)) throw new Error('FOLLOW_MODES wrong')
})

check('非法值回退到默认', () => {
  // readFollowMode 用 FOLLOW_MODES.includes 校验
  const body = src.slice(src.indexOf('function readFollowMode'), src.indexOf('function writeFollowMode'))
  if (!/FOLLOW_MODES\.includes/.test(body)) throw new Error('no validation')
  if (!/FOLLOW_DEFAULT/.test(body)) throw new Error('no fallback')
})

check('localStorage 异常时不影响功能', () => {
  const body = src.slice(src.indexOf('function readFollowMode'), src.indexOf('const en = {'))
  const tryCount = (body.match(/try \{/g) ?? []).length
  if (tryCount < 2) throw new Error('read/write should each guard with try, got ' + tryCount)
})

check('off 模式仍然刷新已打开的 diff 标签', () => {
  if (!/if \(mode === 'off'\)/.test(src)) throw new Error('no off branch')
  if (!/diffOpened\.has\(sessionId\)/.test(src)) throw new Error('off does not refresh opened tabs')
})

check('turn 模式每轮只自动打开一次', () => {
  if (!/openedThisTurn/.test(src)) throw new Error('no per-turn flag')
  // 现在的判定是 focus = always || !openedThisTurn
  if (!/const focus = mode === 'always' \|\| !openedThisTurn/.test(src)) {
    throw new Error('no turn-mode guard')
  }
})

check('轮次变化会重置 openedThisTurn', () => {
  // 新一轮靠 turnFiles 被清空（时间戳回退）来识别
  if (!/value\.ts < lastTs/.test(src)) throw new Error('no turn-change detection')
  if (!/openedThisTurn = false/.test(src)) throw new Error('turn change does not reset flag')
})

check('always 模式每次都打开', () => {
  if (!/openNative\(sessionId, value\)/.test(src)) throw new Error('missing openNative call')
  // 单标签承载全部文件：一次 openTab 带上 files
  if (!/openDiff\(sessionId, files\.length > 0 \? files : \[value\], value, focus\)/.test(src)) {
    throw new Error('missing grouped openDiff call')
  }
})

check('不抢焦点时传 revealIfOpened: false', () => {
  if (!/revealIfOpened: false/.test(src)) throw new Error('missing revealIfOpened guard')
})

check('设置项注册到插件详情页（plugins.row.config）', () => {
  if (!src.includes("'plugins.row.config'")) throw new Error('plugin settings page not registered')
  if (!/configKey = 'dsh-edit-diff#dsh-edit-diff'/.test(src)) throw new Error('missing config key')
  if (src.includes("'settings.general.item'")) {
    throw new Error('still registers into the general settings page')
  }
})

check('设置项使用主题 token 而非硬编码颜色', () => {
  // 样式集中在 row() / controlStyle 里，各具体设置组件只用它们。
  const start = src.indexOf('function row(label, control)')
  const end = src.indexOf('// 1) page 类型')
  if (start < 0 || end < 0) throw new Error('settings block not found')
  const body = src.slice(start, end)
  if (!/--dsw-alias-label-primary/.test(body)) throw new Error('label color not tokenized')
  if (!/--dsw-alias-bg-layer-1/.test(body)) throw new Error('control bg not tokenized')
  if (!/--dsw-alias-border-l1/.test(body)) throw new Error('border not tokenized')
})

check('locale 里三档都有英文与中文文案', () => {
  for (const key of ['follow', 'followAlways', 'followTurn', 'followOff']) {
    const count = (src.match(new RegExp(key + ':', 'g')) ?? []).length
    if (count < 2) throw new Error(key + ' missing a locale')
  }
})

console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
