import fs from 'node:fs'
import vm from 'node:vm'

// 验证折叠的两种操作互不干扰：
//   · 点单个表头 → 只折叠自己
//   · 点「全部折叠」 → 影响所有分组

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

/** 带真实状态管理的 mock，能模拟多次点击。 */
function makeRuntime() {
  const states = []
  let idx = 0
  const createElement = (type, props, ...children) => {
    if (typeof type === 'function') {
      idx = 0
      const out = type({ ...(props ?? {}), children })
      return { type: 'RENDERED', props: {}, children: [out] }
    }
    return { type, props: props ?? {}, children }
  }
  const React = {
    createElement,
    useState: (init) => {
      const i = idx++
      if (states[i] === undefined) {
        states[i] = { value: typeof init === 'function' ? init() : init }
      }
      const slot = states[i]
      return [slot.value, (next) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next
      }]
    },
    useMemo: (fn) => fn(),
    useRef: (v) => ({ current: v ?? null }),
    useEffect: () => {},
  }
  return { React, states }
}

function collect(node, pred, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) collect(n, pred, out); return out }
  if (pred(node)) out.push(node)
  for (const c of node.children ?? []) collect(c, pred, out)
  return out
}

function load(snapshot) {
  const { React } = makeRuntime()
  const loaders = []
  const sandbox = {
    console, Date, JSON, Math, Map, Set, String, Number, Array, Object, Error,
    AbortController, Int32Array, encodeURIComponent, decodeURIComponent,
    document: { body: { hasAttribute: () => false } },
    localStorage: { getItem: () => null, setItem: () => {} },
    window: { __ModuleLoader__: { load: (d) => loaders.push(d) } },
  }
  vm.createContext(sandbox)
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
  return regs.find((r) => r.def.name === 'sidebar.right.pane.tab')
}

const threeFiles = {
  last: null,
  files: [
    { path: 'a.md', command: 'edit', line: 1, oldStr: 'x', newStr: 'y', ts: 1, beforeKnown: true, beforeText: 'A\n' },
    { path: 'b.md', command: 'edit', line: 1, oldStr: 'x', newStr: 'y', ts: 2, beforeKnown: true, beforeText: 'B\n' },
    { path: 'c.md', command: 'edit', line: 1, oldStr: 'x', newStr: 'y', ts: 3, beforeKnown: true, beforeText: 'C\n' },
  ],
}

check('每个分组的表头各自有独立的 onClick（不是同一个函数）', () => {
  const body = load(threeFiles)
  const tree = body.component({ sessionId: 's1' })
  const headers = collect(tree, (n) => n.props?.['data-cline-file-header'] !== undefined)
  if (headers.length !== 3) throw new Error('headers=' + headers.length)
  const fns = headers.map((h) => h.props.onClick)
  if (fns.some((f) => typeof f !== 'function')) throw new Error('some header lacks onClick')
  // 不能是全等的同一个函数引用
  if (fns[0] === fns[1] || fns[1] === fns[2]) {
    throw new Error('headers share the same onClick — single click would toggle everything')
  }
})

check('源码里表头不再直接调用全局折叠', () => {
  const fileBody = src.slice(src.indexOf('function FileSection'), src.indexOf('// ── 插件体'))
  // 去掉注释行再检查，否则注释里提到 setAllCollapsed 会误判
  const code = fileBody
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
  if (/setAllCollapsed/.test(code)) {
    throw new Error('FileSection still calls setAllCollapsed — a header click would collapse all')
  }
  if (/onToggle/.test(code)) {
    throw new Error('FileSection still uses onToggle prop')
  }
})

check('表头点击只改自己的 localOverride', () => {
  const fileBody = src.slice(src.indexOf('function FileSection'), src.indexOf('// ── 插件体'))
  if (!/const toggleSelf = \(\) => setLocalOverride/.test(fileBody)) {
    throw new Error('toggleSelf does not only touch local state')
  }
  if (!/onClick: toggleSelf/.test(fileBody)) throw new Error('header onClick is not toggleSelf')
})

check('「全部折叠」通过 defaultCollapsed + allToken 生效', () => {
  if (!/defaultCollapsed: allCollapsed/.test(src)) throw new Error('defaultCollapsed not passed')
  if (!/allToken,/.test(src)) throw new Error('allToken not passed')
  const fileBody = src.slice(src.indexOf('function FileSection'), src.indexOf('// ── 插件体'))
  if (!/useEffect\(\(\) => \{\s*setLocalOverride\(undefined\)/.test(fileBody)) {
    throw new Error('local override is never cleared on all-token change')
  }
})

check('全部折叠按钮同时递增 token', () => {
  const btn = src.slice(src.indexOf('data-cline-collapse-all'), src.indexOf('data-cline-collapse-all') + 600)
  if (!/setAllCollapsed\(\(v\) => !v\)/.test(btn)) throw new Error('button does not toggle allCollapsed')
  if (!/setAllToken\(\(t\) => t \+ 1\)/.test(btn)) throw new Error('button does not bump token')
})

check('渲染期不直接 setState（改用 effect）', () => {
  const fileBody = src.slice(src.indexOf('function FileSection'), src.indexOf('// ── 插件体'))
  // 渲染期间直接调用 setLocalOverride 的模式应只出现在 effect / 回调里
  const directSet = fileBody.match(/^\s{6}setLocalOverride\(/gm) ?? []
  if (directSet.length > 0) {
    throw new Error(directSet.length + ' 处渲染期直接 setLocalOverride')
  }
})

check('表头带 aria-expanded 反映自身状态', () => {
  const fileBody = src.slice(src.indexOf('function FileSection'), src.indexOf('// ── 插件体'))
  if (!/'aria-expanded': collapsed \? 'false' : 'true'/.test(fileBody)) {
    throw new Error('header lacks aria-expanded')
  }
})

console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
