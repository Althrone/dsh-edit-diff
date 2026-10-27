import fs from 'node:fs'
import vm from 'node:vm'

// 改名后的一致性检查：包名、模块 id、tab kind、投影 key 必须互相吻合。

const dir = 'dsh-edit-diff'
const pkg = JSON.parse(fs.readFileSync(dir + '/package.json', 'utf8'))
const client = fs.readFileSync(dir + '/client.js', 'utf8')
const host = fs.readFileSync(dir + '/index.js', 'utf8')
const patch = fs.readFileSync(dir + '/cordis.patch.yml', 'utf8')

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

check('package name is dsh-edit-diff', () => {
  if (pkg.name !== 'dsh-edit-diff') throw new Error('name=' + pkg.name)
})

check('client module id equals package name', () => {
  const m = client.match(/id:\s*'([^']+)'/)
  if (m === null) throw new Error('no module id found')
  if (m[1] !== pkg.name) throw new Error(m[1] + ' !== ' + pkg.name)
})

check('host export name matches package name', () => {
  const m = host.match(/export const name = '([^']+)'/)
  if (m === null) throw new Error('no host name export')
  if (m[1] !== pkg.name) throw new Error(m[1] + ' !== ' + pkg.name)
})

check('patch row uses the new package name', () => {
  if (!patch.includes("name: 'dsh-edit-diff'")) throw new Error('patch still references old name')
  if (patch.includes('dsh-cline-follow')) throw new Error('patch has stale id')
})

check('no stale identifiers anywhere', () => {
  for (const [label, text] of [['client', client], ['host', host], ['patch', patch]]) {
    if (text.includes('dsh-cline-follow')) throw new Error(label + ' still has dsh-cline-follow')
    if (text.includes('clineFollow')) throw new Error(label + ' still has clineFollow')
  }
})

check('projection key is editDiff on both halves', () => {
  if (!client.includes("PROJECTION_KEY = 'editDiff'")) throw new Error('client projection key wrong')
  if (!host.includes("key: 'editDiff'")) throw new Error('host projection key wrong')
})

check('tab kind is editDiff.tab and matches TAB_ID', () => {
  if (!client.includes("const KIND = 'editDiff.tab'")) throw new Error('KIND wrong')
  const tabId = client.match(/const TAB_ID = '([^']+)'/)
  if (tabId === null) throw new Error('no TAB_ID')
  if (!/^[a-z0-9-]+\/[a-z]+$/.test(tabId[1])) throw new Error('TAB_ID looks odd: ' + tabId[1])
})

// 真正跑一次 client factory，确认注册出来的 kind 是新的
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
  window: { __ModuleLoader__: { load: (d) => loaders.push(d) } },
}
vm.createContext(sandbox)
vm.runInContext(client, sandbox)

const mod = loaders[0].factory(() => React)
const tabTypes = []
const ctx = {
  effect: (fn) => { fn(); return () => {} },
  on: () => () => {},
  logger: { info() {}, warn() {} },
  locale: { register: () => () => {}, bind: () => (k) => k },
  sessions: { list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} }, binding: () => undefined },
  sidebarRight: { openResource() {}, openTab() {} },
  sidebarRightTabs: { register: (d) => { tabTypes.push(d); return () => {} } },
  slots: { inject: (k, fn) => { fn(); return () => {} }, register: () => () => {} },
  remote: { workspaceFiles: { read: async () => ({ ok: false }) } },
}
mod.apply(ctx)

check('factory registers the renamed tab type', () => {
  if (tabTypes.length !== 1) throw new Error('tabTypes=' + tabTypes.length)
  const t = tabTypes[0]
  if (t.kind !== 'editDiff.tab') throw new Error('kind=' + t.kind)
  if (t.title() !== 'Edit Diff') throw new Error('title=' + t.title())
  if (t.patterns !== undefined) throw new Error('must not declare patterns')
})

check('factory does not touch documentPreviews', () => {
  if (ctx.documentPreviews !== undefined) throw new Error('touched documentPreviews')
})

check('locale dicts use the new title', () => {
  if (!client.includes("title: 'Edit Diff'")) throw new Error('en title not updated')
})

console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
