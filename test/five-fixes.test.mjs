import fs from 'node:fs'
import vm from 'node:vm'

// 验证五项修复：
//   1) shell 提示归入调试模式
//   2) 一键折叠按钮
//   3) 折叠后 +N −M 仍显示
//   4) 行同步恢复
//   5) 设置项在设置页

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

function makeReact() {
  const createElement = (type, props, ...children) => {
    if (typeof type === 'function') {
      const out = type({ ...(props ?? {}), children })
      return { type: 'RENDERED', props: {}, children: [out] }
    }
    return { type, props: props ?? {}, children }
  }
  const store = new Map()
  globalThis.__store = store
  return {
    createElement,
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useMemo: (fn) => fn(),
    useRef: (v) => ({ current: v ?? null }),
    useEffect: () => {},
  }
}

function load({ snapshot = { last: null, files: [] }, localStorage } = {}) {
  const React = makeReact()
  const loaders = []
  const sandbox = {
    console, Date, JSON, Math, Map, Set, String, Number, Array, Object, Error,
    AbortController, Int32Array, encodeURIComponent, decodeURIComponent,
    document: { body: { hasAttribute: () => false } },
    window: { __ModuleLoader__: { load: (d) => loaders.push(d) } },
  }
  if (localStorage !== undefined) sandbox.localStorage = localStorage
  vm.createContext(sandbox)
  // vm 里 globalThis 指向 sandbox 自身，但为保险起见再显式挂一次，
  // 因为 client 用的是 globalThis.localStorage。
  vm.runInContext('globalThis.localStorage = globalThis.localStorage', sandbox)
  vm.runInContext(src, sandbox)
  const mod = loaders[0].factory(() => React)

  const face = { getSnapshot: () => snapshot, subscribe: () => () => {} }
  const regs = []
  mod.apply({
    effect: (fn) => { fn(); return () => {} },
    on: () => () => {},
    logger: { info() {}, warn() {} },
    locale: { register: () => () => {}, bind: () => (k) => k },
    sessions: {
      binding: () => ({ session: { projections: { faceOf: () => face } } }),
      list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} },
    },
    sidebarRight: { openResource() {}, openTab() {} },
    sidebarRightTabs: { register: () => () => {} },
    slots: {
      inject: (k, fn) => { fn(); return () => {} },
      register: (d, c) => { regs.push({ def: d, component: c }); return () => {} },
    },
    remote: { workspaceFiles: { read: async () => ({ ok: false }) } },
  })
  return { regs, body: regs.find((r) => r.def.name === 'sidebar.right.pane.tab') }
}

function collect(node, pred, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) collect(n, pred, out); return out }
  if (pred(node)) out.push(node)
  for (const c of node.children ?? []) collect(c, pred, out)
  return out
}

const shellEntry = {
  path: 'D:/p/shell.md',
  command: 'shell',
  line: null,
  oldStr: '',
  newStr: '',
  ts: 1,
  beforeKnown: false,
  beforeText: null,
  afterText: 'SHELL CONTENT\n',
}

check('1) 未开调试时不显示 shell 提示', () => {
  const store = { getItem: () => null, setItem: () => {} }
  const { body } = load({ snapshot: { last: shellEntry, files: [shellEntry] }, localStorage: store })
  const tree = body.component({ sessionId: 's1' })
  const texts = collect(tree, () => false).length >= 0 ? JSON.stringify(tree) : ''
  if (/没有修改前后/.test(texts)) throw new Error('shell notice shown while debug is off')
})

check('1) shell 无基线时默认给中性说明，调试模式才给内部原因', () => {
  const body = src.slice(src.indexOf('function FileSection'), src.indexOf('// ── 插件体'))
  if (!/notice = beforeKnown \? null : \(debug \? tr\('shell'\) : tr\('noBaseline'\)\)/.test(body)) {
    throw new Error('shell notice branch is not gated correctly')
  }
})

check('2) 有一键折叠按钮', () => {
  const { body } = load({
    snapshot: {
      last: null,
      files: [{ path: 'a.md', command: 'edit', line: 1, oldStr: 'x', newStr: 'y', ts: 1, beforeKnown: true, beforeText: 'A\n' }],
    },
    localStorage: { getItem: () => null, setItem: () => {} },
  })
  const tree = body.component({ sessionId: 's1' })
  const buttons = collect(tree, (n) => n.props?.['data-cline-collapse-all'] === true)
  if (buttons.length !== 1) throw new Error('collapse-all button count = ' + buttons.length)
})

check('2) 一键折叠按钮有可访问性属性', () => {
  const { body } = load({
    snapshot: {
      last: null,
      files: [{ path: 'a.md', command: 'edit', line: 1, oldStr: 'x', newStr: 'y', ts: 1, beforeKnown: true, beforeText: 'A\n' }],
    },
    localStorage: { getItem: () => null, setItem: () => {} },
  })
  const tree = body.component({ sessionId: 's1' })
  const b = collect(tree, (n) => n.props?.['data-cline-collapse-all'] === true)[0]
  if (b === undefined) throw new Error('no button')
  if (b.props.type !== 'button') throw new Error('not a button element')
  if (b.props['aria-expanded'] === undefined) throw new Error('missing aria-expanded')
})

check('3) 折叠后统计仍是最新值', () => {
  const body = src.slice(src.indexOf('function FileSection'), src.indexOf('// ── 插件体'))
  // 现在折叠时也计算 rows（只是不渲染），所以统计天然是最新的。
  const rowsBlock = body.slice(body.indexOf('const rows = useMemo'), body.indexOf('const stats = useMemo'))
  if (/if \(collapsed \|\| text === undefined\) return \[\]/.test(rowsBlock)) {
    throw new Error('rows still short-circuits on collapsed — stats would go stale')
  }
  if (!/if \(text === undefined\) return \[\]/.test(rowsBlock)) {
    throw new Error('rows no longer guards on text alone')
  }
})

check('3) 折叠时仍会读取文件（统计需要最新内容）', () => {
  const body = src.slice(src.indexOf('function FileSection'), src.indexOf('// ── 插件体'))
  const fxBlock = body.slice(body.indexOf('readWholeFile'), body.indexOf('readWholeFile') - 500)
  if (/if \(collapsed\) return undefined/.test(body.slice(0, 3000))) {
    throw new Error('reading is skipped while collapsed — header counts cannot update')
  }
})

check('4) 行同步 effect 存在且在 return 之前', () => {
  if (!/linkVerticalScroll\(left, right\)/.test(src)) throw new Error('linkVerticalScroll never called')
  const body = src.slice(src.indexOf('function FileSection'), src.indexOf('// ── 插件体'))
  const syncIdx = body.indexOf('linkVerticalScroll(left, right)')
  const retIdx = body.indexOf('if (collapsed) return h(')
  if (syncIdx < 0) throw new Error('sync call missing in FileSection')
  if (retIdx >= 0 && syncIdx > retIdx) throw new Error('sync registered after early return')
})

check('4) 行同步依赖 panesRendered', () => {
  if (!/const panesRendered = !collapsed && notice === null/.test(src)) {
    throw new Error('panesRendered guard missing')
  }
})

check('5) 设置在插件详情页，两个控件都在里面', () => {
  const { regs } = load({ localStorage: { getItem: () => null, setItem: () => {} } })
  const page = regs.filter((r) => r.def.name === 'plugins.row.config')
  if (page.length !== 1) throw new Error('plugins.row.config registrations=' + page.length)
  if (page[0].def.key !== 'dsh-edit-diff#dsh-edit-diff') throw new Error('key=' + page[0].def.key)
  // 组件里应同时渲染 FollowSetting 与 DebugSetting
  const tree = page[0].component({})
  const json = JSON.stringify(tree)
  if (!/select/.test(json)) throw new Error('follow select missing from settings page')
  if (!/checkbox/.test(json)) throw new Error('debug checkbox missing from settings page')
})

check('5) 不再注册到通用设置页', () => {
  const { regs } = load({ localStorage: { getItem: () => null, setItem: () => {} } })
  const general = regs.filter((r) => r.def.name === 'settings.general.item')
  if (general.length !== 0) {
    throw new Error('general settings polluted: ' + general.length)
  }
})

check('debug / follow 偏好各自独立存储', () => {
  if (!/FOLLOW_KEY = 'dsh-edit-diff:follow'/.test(src)) throw new Error('follow key wrong')
  if (!/DEBUG_KEY = 'dsh-edit-diff:debug'/.test(src)) throw new Error('debug key wrong')
})

check('locale 有三项新文案（英中各一）', () => {
  for (const key of ['collapseAll', 'expandAll', 'fileCount', 'debug']) {
    const n = (src.match(new RegExp('\\b' + key + ':', 'g')) ?? []).length
    if (n < 2) throw new Error(key + ' count=' + n)
  }
})

console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
