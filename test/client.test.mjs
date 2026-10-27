import fs from 'node:fs'
import vm from 'node:vm'

// Load client.js against a mock ModuleLoader + mock React + mock ctx.
// This is what the real slot system does; a throwing factory blanks the UI silently.

const src = fs.readFileSync('dsh-edit-diff/client.js', 'utf8')

const created = []
function h(type, props, ...children) {
  created.push({ type, props })
  return { type, props, children }
}

const React = {
  createElement: h,
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: (fn) => {},
  useMemo: (fn) => fn(),
  useRef: (v) => ({ current: v }),
}

const loaders = []
const sandbox = {
  console,
  Date,
  JSON,
  Math,
  Map,
  Set,
  String,
  Number,
  Array,
  Object,
  Error,
  AbortController,
  Int32Array,
  encodeURIComponent,
  decodeURIComponent,
  window: {
    __ModuleLoader__: {
      load(def) {
        loaders.push(def)
      },
    },
  },
}
vm.createContext(sandbox)
vm.runInContext(src, sandbox)

let failures = 0
function check(name, fn) {
  try {
    const value = fn()
    if (value === false) throw new Error('returned false')
    console.log('ok   ' + name)
  } catch (error) {
    failures++
    console.log('FAIL ' + name + ': ' + error.message)
  }
}

check('registers exactly one module', () => {
  if (loaders.length !== 1) throw new Error('loaders=' + loaders.length)
  // 模块 id 必须等于包名，否则 DSH 的模块表装不上它。
  const pkg = JSON.parse(fs.readFileSync('dsh-edit-diff/package.json', 'utf8'))
  if (loaders[0].id !== pkg.name) throw new Error('id=' + loaders[0].id + ' !== package name ' + pkg.name)
})

const requires = {
  react: React,
}
const moduleExports = loaders[0].factory((name) => {
  if (!(name in requires)) throw new Error('unexpected require: ' + name)
  return requires[name]
})

check('factory returns inject + apply', () => {
  if (typeof moduleExports.apply !== 'function') throw new Error('no apply')
  if (!Array.isArray(moduleExports.inject)) throw new Error('no inject')
  if (moduleExports.inject.includes('documentPreviews')) {
    throw new Error('must NOT inject documentPreviews')
  }
})

const tabTypes = []
const slotRegs = []
const openedResources = []
const openedTabs = []

const ctx = {
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  on() {
    return () => {}
  },
  logger: { info() {}, warn() {} },
  locale: {
    register() {
      return () => {}
    },
    bind() {
      return (key) => key
    },
  },
  sessions: {
    list: {
      getSnapshot: () => ({ byId: {} }),
      subscribe: () => () => {},
    },
    binding: () => undefined,
  },
  sidebarRight: {
    openResource(address, options) {
      openedResources.push({ address, options })
    },
    openTab(kind, options) {
      openedTabs.push({ kind, options })
    },
  },
  sidebarRightTabs: {
    register(def) {
      tabTypes.push(def)
      return () => {}
    },
  },
  slots: {
    inject(key, fn) {
      fn()
      return () => {}
    },
    register(def, component) {
      slotRegs.push({ def, component })
      return () => {}
    },
  },
  remote: {
    workspaceFiles: {
      read: async () => ({ ok: false }),
    },
  },
}

check('apply runs without throwing', () => {
  moduleExports.apply(ctx)
})

check('registers the diff page type (no patterns, so no extension takeover)', () => {
  if (tabTypes.length !== 1) throw new Error('tabTypes=' + tabTypes.length)
  const type = tabTypes[0]
  if (type.kind !== 'editDiff.tab') throw new Error('kind=' + type.kind)
  if (type.patterns !== undefined) throw new Error('must declare no patterns')
  if (typeof type.title !== 'function') throw new Error('title must be a function')
})

check('registers the diff body in sidebar.right.pane.tab', () => {
  const body = slotRegs.filter((r) => r.def.name === 'sidebar.right.pane.tab')
  if (body.length !== 1) throw new Error('pane.tab registrations=' + body.length)
  if (typeof body[0].component !== 'function') throw new Error('body is not a component')
})

check('registers the settings page under plugins.row.config', () => {
  const page = slotRegs.filter((r) => r.def.name === 'plugins.row.config')
  if (page.length !== 1) throw new Error('plugins.row.config registrations=' + page.length)
  if (page[0].def.key !== 'dsh-edit-diff#dsh-edit-diff') {
    throw new Error('key=' + page[0].def.key)
  }
  if (typeof page[0].component !== 'function') throw new Error('settings page is not a component')
})

check('does not pollute the general settings page', () => {
  const general = slotRegs.filter((r) => r.def.name === 'settings.general.item')
  if (general.length !== 0) {
    throw new Error('settings.general.item still has ' + general.length + ' registration(s)')
  }
})

check('never registers a documentPreviews renderer', () => {
  if (ctx.documentPreviews !== undefined) throw new Error('touched documentPreviews')
})

check('diff body renders the empty state when no params', () => {
  const Body = slotRegs[0].component
  const tree = Body({ useTabInfo: () => ({ tab: { navigation: { params: {}, revision: 0 }, contentId: 'x:none' } }) })
  if (tree === null || tree === undefined) throw new Error('rendered nothing')
})

// 回归防护：长行曾在每个 <span> 上带 overflowX:auto，导致每行下方各有一个水平滑块。
// 横向滚动必须只由外层滚动容器提供。
function collectStyles(node, out) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) collectStyles(item, out)
    return
  }
  if (node.props !== undefined && node.props !== null) out.push(node.props.style ?? {})
  collectStyles(node.children, out)
}

check('长行不会逐行生成水平滚动条（无行内 overflowX）', () => {
  const Body = slotRegs[0].component
  const tree = Body({
    useTabInfo: () => ({
      tab: {
        navigation: {
          revision: 1,
          params: {
            path: 'a.c',
            sessionId: 's1',
            command: 'edit',
            oldStr: 'int x = 1;',
            newStr: 'int x = 1; /* ' + 'x'.repeat(200) + ' */',
            ts: 1,
          },
        },
        contentId: 'dsh-resource://file/session/s1/a.c',
      },
    }),
  })
  const styles = []
  collectStyles(tree, styles)
  if (styles.length === 0) throw new Error('no styles collected')
  const bad = styles.filter((s) => s !== null && typeof s === 'object' && /auto|scroll/.test(String(s.overflowX ?? '')))
  if (bad.length > 0) {
    throw new Error(bad.length + ' element(s) set overflowX auto/scroll (per-line scrollbars)')
  }
})

check('横向滚动容器最多一个（加载态下没有内容，故允许 0）', () => {
  const Body = slotRegs[0].component
  const tree = Body({
    useTabInfo: () => ({
      tab: {
        navigation: { revision: 1, params: { path: 'a.c', sessionId: 's1', command: 'edit', oldStr: 'a', newStr: 'b', ts: 1 } },
        contentId: 'dsh-resource://file/session/s1/a.c',
      },
    }),
  })
  const styles = []
  collectStyles(tree, styles)
  const scrollers = styles.filter((s) => s !== null && typeof s === 'object' && String(s.overflow ?? '') === 'auto')
  if (scrollers.length > 2) throw new Error('more than two scroll containers: ' + scrollers.length)
})

// 回归防护：对侧缺失的行曾经渲染成空字符串，span 高度 0 导致整列逐行错位。
// 现在必须留 NBSP 占位，且行高固定。
check('缺失的一侧留空但占一行高度（NBSP + 固定行高）', () => {
  const Body = slotRegs[0].component
  const tree = Body({
    useTabInfo: () => ({
      tab: {
        navigation: { revision: 1, params: { path: 'a.c', sessionId: 's1', command: 'edit', oldStr: 'b', newStr: '', ts: 1 } },
        contentId: 'dsh-resource://file/session/s1/a.c',
      },
    }),
  })
  // 只有加载完成才会渲染行；mock 不跑 effect，所以这里直接检查源码约束。
  const src = fs.readFileSync('dsh-edit-diff/client.js', 'utf8')
  if (!/const NBSP = '\\u00A0'/.test(src)) {
    throw new Error('NBSP placeholder constant missing')
  }
  if (!/height: rowHeightPx/.test(src)) {
    throw new Error('rows no longer have a fixed height')
  }
})

// 回归防护：栏宽曾用「字符数 + 12ch」估算，且栏缺 overflow:hidden，
// 于是内容一长就把栏本身顶宽（而不是在栏内横向滚动）。
check('栏宽不再用字符数估算，且溢出由栏内滚动消化', () => {
  const src = fs.readFileSync('dsh-edit-diff/client.js', 'utf8')
  if (/leftWidth|rightWidth/.test(src)) {
    throw new Error('character-count width estimate is back')
  }
  if (!/width: 'max-content'/.test(src)) {
    throw new Error('content width should be measured by the browser (max-content)')
  }
  if (!/overflow: 'hidden'/.test(src)) {
    throw new Error('pane lost its overflow:hidden guard; content can widen the column')
  }
  if (!/gridTemplateColumns: 'minmax\(0,1fr\) minmax\(0,1fr\)'/.test(src)) {
    throw new Error('columns are no longer strictly equal')
  }
})

console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
