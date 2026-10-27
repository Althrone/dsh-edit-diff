import fs from 'node:fs'
import vm from 'node:vm'

// 验证 diff body 从【投影】读数据，而不是从导航参数。
// 这修的是「标签开过一次后参数不再刷新 → 永远显示空」的 bug。

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
  return {
    createElement,
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useMemo: (fn) => fn(),
    useRef: () => ({ current: null }),
    useEffect: () => {},
  }
}

function load(snapshot) {
  const React = makeReact()
  const loaders = []
  const sandbox = {
    console, Date, JSON, Math, Map, Set, String, Number, Array, Object, Error,
    AbortController, Int32Array, encodeURIComponent, decodeURIComponent,
    document: { body: { hasAttribute: () => false } },
    window: { __ModuleLoader__: { load: (d) => loaders.push(d) } },
  }
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox)
  const mod = loaders[0].factory(() => React)

  const listeners = new Set()
  const face = {
    getSnapshot: () => snapshot,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
  }

  const regs = []
  const sessions = {
    binding: () => ({ session: { projections: { faceOf: () => face } } }),
    list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} },
  }

  mod.apply({
    effect: (fn) => { fn(); return () => {} },
    on: () => () => {},
    logger: { info() {}, warn() {} },
    locale: { register: () => () => {}, bind: () => (k) => k },
    sessions,
    sidebarRight: { openResource() {}, openTab() {} },
    sidebarRightTabs: { register: () => () => {} },
    slots: {
      inject: (k, fn) => { fn(); return () => {} },
      register: (d, c) => { regs.push({ def: d, component: c }); return () => {} },
    },
    remote: { workspaceFiles: { read: async () => ({ ok: false }) } },
  })

  const body = regs.find((r) => r.def.name === 'sidebar.right.pane.tab')
  return { body, face, listeners }
}

function collectFileHeaders(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const n of node) collectFileHeaders(n, out)
    return out
  }
  if (node.props?.['data-cline-file-header'] !== undefined) {
    out.push(node.props['data-cline-file-header'])
  }
  for (const c of node.children ?? []) collectFileHeaders(c, out)
  return out
}

function collectText(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string') { out.push(node); return out }
  if (typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) collectText(n, out); return out }
  for (const c of node.children ?? []) collectText(c, out)
  return out
}

// 带文件的投影快照
const withFiles = {
  last: { path: 'D:/p/a.md', command: 'edit', line: 1, oldStr: 'x', newStr: 'y', ts: 5, beforeKnown: true, beforeText: 'OLD\n' },
  files: [
    { path: 'D:/p/a.md', command: 'edit', line: 1, oldStr: 'x', newStr: 'y', ts: 5, beforeKnown: true, beforeText: 'OLD\n' },
    { path: 'D:/p/b.md', command: 'write', line: 1, oldStr: '', newStr: 'NEW\n', ts: 6, beforeKnown: true, beforeText: null },
  ],
}

check('body 从投影读文件，不依赖导航参数', () => {
  const { body } = load(withFiles)
  const tree = body.component({
    sessionId: 's1',
    useTabInfo: () => ({ tab: { navigation: { params: {}, revision: 0 }, contentId: 'x' } }),
  })
  const headers = collectFileHeaders(tree)
  if (headers.length !== 2) {
    throw new Error('expected 2 file groups, got ' + headers.length + ' — params 为空时投影仍应喂数据')
  }
})

check('参数完全为空也能显示（原来的 bug 场景）', () => {
  const { body } = load(withFiles)
  const tree = body.component({
    sessionId: 's1',
    // 模拟标签复用后参数没更新
    useTabInfo: () => ({ tab: { navigation: { params: {}, revision: 0 }, contentId: '' } }),
  })
  const texts = collectText(tree)
  if (texts.some((t) => /还没有记录/.test(t))) {
    throw new Error('still showing the empty notice despite projection data')
  }
  if (collectFileHeaders(tree).length === 0) throw new Error('no groups rendered')
})

check('投影为空时才显示空提示', () => {
  const { body } = load({ last: null, files: [] })
  const tree = body.component({
    sessionId: 's1',
    useTabInfo: () => ({ tab: { navigation: { params: {}, revision: 0 }, contentId: '' } }),
  })
  const texts = collectText(tree)
  if (texts.length === 0) throw new Error('no empty notice')
})

check('取不到会话绑定时不崩，显示空提示', () => {
  const React = makeReact()
  const loaders = []
  const sandbox = {
    console, Date, JSON, Math, Map, Set, String, Number, Array, Object, Error,
    AbortController, Int32Array, encodeURIComponent, decodeURIComponent,
    document: { body: { hasAttribute: () => false } },
    window: { __ModuleLoader__: { load: (d) => loaders.push(d) } },
  }
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox)
  const mod = loaders[0].factory(() => React)
  const regs = []
  mod.apply({
    effect: (fn) => { fn(); return () => {} },
    on: () => () => {},
    logger: { info() {}, warn() {} },
    locale: { register: () => () => {}, bind: () => (k) => k },
    sessions: {
      binding: () => undefined,
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
  const body = regs.find((r) => r.def.name === 'sidebar.right.pane.tab')
  const tree = body.component({
    sessionId: 's1',
    useTabInfo: () => ({ tab: { navigation: { params: {}, revision: 0 }, contentId: '' } }),
  })
  if (collectText(tree).length === 0) throw new Error('crashed or rendered nothing')
})

check('slot 注册提供 sessionId（inject）', () => {
  const { body } = load(withFiles)
  if (typeof body.def.inject !== 'function') {
    throw new Error('register() must declare inject(sessionId)')
  }
  const injected = body.def.inject('sess-42')
  if (injected?.sessionId !== 'sess-42') {
    throw new Error('inject did not pass sessionId: ' + JSON.stringify(injected))
  }
})

check('源码不再从 params 取文件列表', () => {
  if (/params\.files/.test(src)) throw new Error('still reads params.files')
  if (/entries\.map/.test(src)) throw new Error('legacy entries path remains')
})

// ── 分组表头的细节（原 grouped.test.mjs 的断言）──

check('表头只显示文件名，不显示完整路径', () => {
  const { body } = load({
    last: null,
    files: [{ path: 'D:/very/long/path/to/notes.md', command: 'edit', line: 1, oldStr: 'x', newStr: 'y', ts: 1, beforeKnown: true, beforeText: 'A\n' }],
  })
  const tree = body.component({
    sessionId: 's1',
    useTabInfo: () => ({ tab: { navigation: { params: {}, revision: 0 }, contentId: '' } }),
  })
  const texts = collectText(tree)
  if (!texts.includes('notes.md')) throw new Error('basename missing: ' + JSON.stringify(texts))
  if (texts.some((t) => t.includes('D:/very/long'))) throw new Error('full path leaked')
})

check('表头可点击且有可访问性属性', () => {
  const { body } = load({
    last: null,
    files: [{ path: 'a.md', command: 'edit', line: 1, oldStr: 'x', newStr: 'y', ts: 1, beforeKnown: true, beforeText: 'A\n' }],
  })
  const tree = body.component({
    sessionId: 's1',
    useTabInfo: () => ({ tab: { navigation: { params: {}, revision: 0 }, contentId: '' } }),
  })
  let ok = false
  ;(function walk(n) {
    if (n === null || n === undefined || typeof n !== 'object') return
    if (Array.isArray(n)) { for (const x of n) walk(x); return }
    if (n.props?.['data-cline-file-header'] !== undefined) {
      if (typeof n.props.onClick === 'function' && n.props.role === 'button' && n.props.tabIndex === 0) ok = true
    }
    for (const c of n.children ?? []) walk(c)
  })(tree)
  if (!ok) throw new Error('header lacks onClick/role/tabIndex')
})

check('tab 类型不声明 multiple', () => {
  const t = (() => {
    const React = makeReact()
    const loaders = []
    const sandbox = {
      console, Date, JSON, Math, Map, Set, String, Number, Array, Object, Error,
      AbortController, Int32Array, encodeURIComponent, decodeURIComponent,
      document: { body: { hasAttribute: () => false } },
      window: { __ModuleLoader__: { load: (d) => loaders.push(d) } },
    }
    vm.createContext(sandbox)
    vm.runInContext(src, sandbox)
    const mod = loaders[0].factory(() => React)
    const types = []
    mod.apply({
      effect: (fn) => { fn(); return () => {} },
      on: () => () => {},
      logger: { info() {}, warn() {} },
      locale: { register: () => () => {}, bind: () => (k) => k },
      sessions: { binding: () => undefined, list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} } },
      sidebarRight: { openResource() {}, openTab() {} },
      sidebarRightTabs: { register: (d) => { types.push(d); return () => {} } },
      slots: { inject: (k, fn) => { fn(); return () => {} }, register: () => () => {} },
      remote: { workspaceFiles: { read: async () => ({ ok: false }) } },
    })
    return types[0]
  })()
  if (t === undefined) throw new Error('no tab type')
  if (t.multiple === true) throw new Error('multiple must not be set')
})

console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
