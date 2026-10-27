import fs from 'node:fs'
import vm from 'node:vm'

// 用刚才四次真实修改的形态，验证插件对每种方式的捕获能力。

const hostSrc = fs.readFileSync('dsh-edit-diff/index.js', 'utf8')
const clientSrc = fs.readFileSync('dsh-edit-diff/client.js', 'utf8')

const hostBody = hostSrc.replace(/^import .*$/gm, '').replace(/^export /gm, '')
const hs = {
  console, Date, JSON, Map, Set, Math, String, Number, Array, Object, Error, setTimeout, Buffer,
  statSync: fs.statSync,
  readFileSync: fs.readFileSync,
  process: { cwd: () => 'D:/Project/cline' },
}
hs.watch = () => ({ on() {}, close() {} })
vm.createContext(hs)
vm.runInContext(
  hostBody + '\n;globalThis.__h = { definition, beforeByCall, normPath, extractCommandPaths };',
  hs,
)
const { definition, beforeByCall, extractCommandPaths } = hs.__h

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

function simulateEdit({ callId, toolName, args, preEditContent, state }) {
  // 基线现在由投影 state 自己累积：这里只模拟 pre-execute 存下的单次基线。
  beforeByCall.set(callId, preEditContent)
  let s = definition.apply(state, {
    type: 'tool/call',
    time: 1,
    data: { callId, name: toolName, arguments: args },
  })
  s = definition.apply(s, {
    type: 'tool/result',
    time: 2,
    data: { message: { source: { callId }, isError: false } },
  })
  return { state: s, view: definition.wire.view(s).last }
}

const agent = { session: { id: 'S1' } }
const PATH = 'D:/Project/cline/track-test.md'

const V0 = '# 修改方式测试\n\n用于验证插件能捕获各种文件修改手段。\n\n## 初始内容\n\n- 第一项\n- 第二项\n'
const V1 = V0.replace('- 第一项', '- 第一项（已修改）')
const V2 = '# 修改方式测试（已全量覆盖）\n\n这是用 write 工具整体覆盖后的内容。\n\n## 新章节\n\n- 全新的第一项\n- 全新的第二项\n- 全新的第三项\n'

check('method1 write new file: baseline is null', () => {
  beforeByCall.clear()
  const s0 = definition.init({ id: 'M1' })
  const { view: v } = simulateEdit({
    callId: 'c1', toolName: 'write',
    args: { file_path: PATH, content: V0 },
    preEditContent: null, state: s0,
  })
  if (v.beforeKnown !== true) throw new Error('no baseline flag')
  if (v.beforeText !== null) throw new Error('new file should have null baseline')
})

check('method2 edit replace: baseline is pre-edit content', () => {
  beforeByCall.clear()
  const s0 = definition.init({ id: 'M2' })
  const { view: v } = simulateEdit({
    callId: 'c2', toolName: 'edit',
    args: { file_path: PATH, old_string: '- 第一项', new_string: '- 第一项（已修改）' },
    preEditContent: V0, state: s0,
  })
  if (v.beforeText !== V0) throw new Error('baseline should be the pre-edit content')
})

check('method3 write overwrite: baseline is conversation-start content', () => {
  beforeByCall.clear()
  let st = definition.init({ id: 'M3' })
  const first = simulateEdit({ callId: 'a', toolName: 'edit', args: { file_path: PATH, old_string: 'x', new_string: 'y' }, preEditContent: V0, state: st })
  st = first.state
  const { view: v } = simulateEdit({
    callId: 'c3', toolName: 'write',
    args: { file_path: PATH, content: V2 },
    preEditContent: V1, state: st,
  })
  if (v.beforeText !== V0) throw new Error('baseline should stay V0, got ' + JSON.stringify(v.beforeText))
})

check('method4 shell: command text yields the target file', () => {
  const got = extractCommandPaths(
    "node -e \"require('fs').appendFileSync('D:/Project/cline/track-test.md','x')\"",
    'D:/Project/cline',
  )
  if (!got.some((p) => p.endsWith('track-test.md'))) throw new Error(JSON.stringify(got))
})

check('method4 shell: common write commands all resolve', () => {
  const cases = [
    ['echo hi >> track-test.md', 'track-test.md'],
    ['Add-Content -Path track-test.md -Value x', 'track-test.md'],
    ['Set-Content track-test.md "x"', 'track-test.md'],
    ['python gen.py --out track-test.md', 'track-test.md'],
  ]
  for (const [cmd, want] of cases) {
    const got = extractCommandPaths(cmd, 'D:/Project/cline')
    if (!got.some((p) => p.endsWith(want))) throw new Error(cmd + ' -> ' + JSON.stringify(got))
  }
})

check('same conversation 3 edits: always compare against the first content', () => {
  beforeByCall.clear()
  let st = definition.init({ id: 'M5' })
  st = simulateEdit({ callId: 'r1', toolName: 'edit', args: { file_path: PATH, old_string: 'a', new_string: 'b' }, preEditContent: V0, state: st }).state
  st = simulateEdit({ callId: 'r2', toolName: 'write', args: { file_path: PATH, content: V1 }, preEditContent: V0, state: st }).state
  const { view: v } = simulateEdit({ callId: 'r3', toolName: 'edit', args: { file_path: PATH, old_string: 'c', new_string: 'd' }, preEditContent: V1, state: st })
  if (v.beforeText !== V0) throw new Error('drifted: ' + JSON.stringify(v.beforeText))
})

function extractFn(src, name) {
  const start = src.indexOf('    function ' + name + '(')
  if (start < 0) throw new Error('not found: ' + name)
  const parenOpen = src.indexOf('(', start)
  let parens = 0
  let index = parenOpen
  for (; index < src.length; index++) {
    if (src[index] === '(') parens++
    else if (src[index] === ')') { parens--; if (parens === 0) break }
  }
  const bodyOpen = src.indexOf('{', index)
  let depth = 0
  for (index = bodyOpen; index < src.length; index++) {
    if (src[index] === '{') depth++
    else if (src[index] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(start, index + 1)
}

const cs = { console, Math, Array, String, Number, Object, Int32Array, MAX_DIFF_CELLS: 4_000_000 }
vm.createContext(cs)
vm.runInContext(extractFn(clientSrc, 'diffLines') + '\n\n' + extractFn(clientSrc, 'toSideBySide') +
  '\n;globalThis.__c={diffLines,toSideBySide};', cs)
const { diffLines, toSideBySide } = cs.__c

check('render: write overwrite shows real deletions and additions', () => {
  const rows = toSideBySide(diffLines(V0, V2))
  const dels = rows.filter((r) => r.left !== undefined && r.type !== 'eq').length
  const adds = rows.filter((r) => r.right !== undefined && r.type !== 'eq').length
  if (dels === 0) throw new Error('no deletions captured')
  if (adds === 0) throw new Error('no additions captured')
  console.log('     deletions=' + dels + ' additions=' + adds)
  return true
})

check('render: equal rows have both sides and match', () => {
  const rows = toSideBySide(diffLines(V0, V1))
  const eqRows = rows.filter((r) => r.type === 'eq')
  if (eqRows.length === 0) throw new Error('no equal rows')
  for (const r of eqRows) {
    if (r.left === undefined || r.right === undefined) throw new Error('eq row missing a side')
    if (r.left !== r.right) throw new Error('eq row sides differ')
  }
})

console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
