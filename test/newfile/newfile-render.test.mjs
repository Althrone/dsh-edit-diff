import fs from 'node:fs'
import vm from 'node:vm'

// 端到端：新建文件（beforeText=null）必须渲染出完整正文。
//
// 这个测试用真实的 hook 运行时（每个组件实例独立槽位），
// 走完「渲染 → 读文件 → setState → 再渲染」的完整流程。
// 之前的 bug 是文件被过滤掉 / 读了不渲染，靠它才看出来。

const clientSrc = fs.readFileSync('dsh-edit-diff/client.js', 'utf8')

const CONTENT = '# 新建验证 A\n\n验证 0.13.0。\n\n- 第一条\n- 第二条\n'

function makeRuntime() {
  const instances = new Map()
  let current = null
  let cursor = 0

  function renderComponent(fn, props) {
    const id = fn.name || 'anonymous'
    let inst = instances.get(id)
    if (inst === undefined) {
      inst = { states: [], effects: [], cleanups: [] }
      instances.set(id, inst)
    }
    const savedCur = current
    const savedCursor = cursor
    current = inst
    cursor = 0
    try {
      for (const c of inst.cleanups) if (typeof c === 'function') c()
      inst.cleanups = []
      inst.effects = []
      const out = fn(props)
      for (const e of inst.effects) {
        const c = e()
        if (typeof c === 'function') inst.cleanups.push(c)
      }
      return out
    } finally {
      current = savedCur
      cursor = savedCursor
    }
  }

  function useState(init) {
    const inst = current
    const i = cursor++
    if (inst.states.length <= i) {
      inst.states[i] = typeof init === 'function' ? init() : init
    }
    return [inst.states[i], (next) => {
      inst.states[i] = typeof next === 'function' ? next(inst.states[i]) : next
    }]
  }
  function useMemo(fn) { cursor++; return fn() }
  function useRef(v) {
    const inst = current
    const i = cursor++
    if (inst.states.length <= i || inst.states[i] === undefined) inst.states[i] = { current: v ?? null }
    return inst.states[i]
  }
  function useEffect(fn) { current.effects.push(fn); cursor++ }

  const createElement = (type, props, ...children) => {
    if (typeof type === 'function') {
      return { type: 'R', props: {}, children: [renderComponent(type, { ...(props ?? {}), children })] }
    }
    return { type, props: props ?? {}, children }
  }
  return { React: { createElement, useState, useMemo, useRef, useEffect }, renderComponent }
}

function collectText(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string') { out.push(node); return out }
  if (typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) collectText(n, out); return out }
  for (const c of node.children ?? []) collectText(c, out)
  return out
}

async function run({ entry, debug = false, readFails = false }) {
  const { React, renderComponent } = makeRuntime()
  const loaders = []
  const sandbox = {
    console, Date, JSON, Math, Map, Set, String, Number, Array, Object, Error,
    AbortController, Int32Array, encodeURIComponent, decodeURIComponent,
    document: { body: { hasAttribute: () => false } },
    localStorage: {
      getItem: (k) => (k === 'dsh-edit-diff:debug' && debug ? '1' : null),
      setItem: () => {},
    },
    window: { __ModuleLoader__: { load: (d) => loaders.push(d) } },
  }
  vm.createContext(sandbox)
  vm.runInContext(clientSrc, sandbox)
  const mod = loaders[0].factory(() => React)

  const snapshot = { last: entry, files: [entry] }
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
    remote: {
      workspaceFiles: {
        read: async () => {
          if (readFails) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
          return { ok: true, value: { text: CONTENT, lines: CONTENT.split('\n').length, eof: true } }
        },
      },
    },
  })
  const body = regs.find((r) => r.def.name === 'sidebar.right.pane.tab')
  let tree = null
  for (let i = 0; i < 5; i++) {
    tree = renderComponent(body.component, { sessionId: 's1' })
    await new Promise((r) => setTimeout(r, 5))
  }
  return collectText(tree)
}

const newFile = {
  path: 'D:/Project/cline/new-a.md',
  tool: 'write',
  command: 'write',
  line: 1,
  oldStr: '',
  newStr: CONTENT,
  ts: 11,
  beforeText: null,
  beforeKnown: true,
}

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

const texts = await run({ entry: newFile })

check('新建文件出现在列表', () => {
  if (!texts.includes('new-a.md')) throw new Error('filename missing: ' + JSON.stringify(texts.slice(0, 12)))
})

check('统计显示纯新增行数', () => {
  if (!texts.includes('+7')) throw new Error('expected +7, got ' + JSON.stringify(texts.filter((t) => t.startsWith('+'))))
})

check('正文渲染出文件内容', () => {
  if (!texts.some((t) => t.includes('新建验证'))) throw new Error('body content missing')
})

check('左栏为空（纯新增）', () => {
  if (!texts.includes('original')) throw new Error('left pane header missing')
  if (!texts.includes('current')) throw new Error('right pane header missing')
})

check('没有卡在 loading 或 empty', () => {
  if (texts.includes('loading')) throw new Error('still loading')
  if (texts.includes('empty')) throw new Error('still empty')
})

const textsDebug = await run({ entry: newFile, debug: true })
check('debug 模式下正文仍然渲染（不被诊断顶掉）', () => {
  const dbg = textsDebug.find((t) => t.includes('rows='))
  if (dbg === undefined) throw new Error('debug line missing')
  if (!textsDebug.some((t) => t.includes('新建验证'))) {
    throw new Error('debug line replaced the diff body')
  }
})

const textsFail = await run({ entry: newFile, readFails: true })
check('读文件失败时给出可见提示（不是空白）', () => {
  const hasNotice = textsFail.some(
    (t) => t.length > 2 && !t.startsWith('+') && !t.startsWith('−') && !t.endsWith('.md') && !/^[▶▲▼]$/.test(t)
      && !/^(original|current|collapseAll|fileCount|\d+)$/.test(t),
  )
  if (!hasNotice) throw new Error('blank panel on read failure: ' + JSON.stringify(textsFail))
})

console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
