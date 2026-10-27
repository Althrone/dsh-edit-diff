import fs from 'node:fs'
import vm from 'node:vm'

// 用真实文件内容验证「会话内基线 + 持续对比」的完整链路。
// 模拟：多次编辑，基线应始终是会话最初的内容。

const hostSrc = fs.readFileSync('dsh-edit-diff/index.js', 'utf8')
const clientSrc = fs.readFileSync('dsh-edit-diff/client.js', 'utf8')

const hostBody = hostSrc.replace(/^import .*$/gm, '').replace(/^export /gm, '')
const hs = {
  console, Date, JSON, Map, Set, Math, String, Number, Array, Object, Error, setTimeout, Buffer,
}
hs.watch = () => ({ on() {}, close() {} })
vm.createContext(hs)
vm.runInContext(hostBody + '\n;globalThis.__h = { definition, beforeByCall, normPath };', hs)
const { definition, beforeByCall } = hs.__h

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
vm.runInContext(
  extractFn(clientSrc, 'diffLines') + '\n\n' + extractFn(clientSrc, 'toSideBySide') +
  '\n;globalThis.__c={diffLines,toSideBySide};',
  cs,
)
const { diffLines, toSideBySide } = cs.__c

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

const PATH = 'follow-new.md'

/** 走一次编辑，返回新 state。preEditContent 是这次编辑前磁盘上的内容。 */
function edit(state, callId, preEditContent, args) {
  beforeByCall.set(callId, preEditContent)
  let s = definition.apply(state, {
    type: 'tool/call',
    time: 100,
    data: { callId, name: 'edit', arguments: args },
  })
  s = definition.apply(s, {
    type: 'tool/result',
    time: 200,
    data: { message: { source: { callId }, isError: false } },
  })
  return s
}

const V1 = '# 标题\n\n原始正文\n\n- 项目一\n- 项目二\n'
const V2 = '# 标题（改）\n\n原始正文\n\n- 项目一\n- 项目二\n'
const V3 = V2 + '\n## 版本记录\n\n- v2\n'
const V4 = V3.replace('- 项目二', '- 项目二（修正）')

let st = definition.init({ id: 's1' })

st = edit(st, 'c1', V1, { file_path: PATH, old_string: '# 标题', new_string: '# 标题（改）' })
check('first edit: baseline is V1', () => {
  const v = definition.wire.view(st).last
  if (v.beforeKnown !== true) throw new Error('no baseline')
  if (v.beforeText !== V1) throw new Error('got ' + JSON.stringify(v.beforeText?.slice(0, 30)))
})

st = edit(st, 'c2', V2, { file_path: PATH, old_string: '- 项目二', new_string: '- 项目二\n\n## 版本记录\n\n- v2' })
check('second edit: baseline still V1 (no drift)', () => {
  const v = definition.wire.view(st).last
  if (v.beforeText !== V1) throw new Error('drifted to ' + JSON.stringify(v.beforeText?.slice(0, 30)))
})

st = edit(st, 'c3', V3, { file_path: PATH, old_string: '- 项目二', new_string: '- 项目二（修正）' })
check('third edit: baseline still V1', () => {
  const v = definition.wire.view(st).last
  if (v.beforeText !== V1) throw new Error('drifted')
})

check('full-conversation diff: V1 -> V4 shows the accumulated change', () => {
  const v = definition.wire.view(st).last
  const rows = toSideBySide(diffLines(v.beforeText, V4))
  const changed = rows.filter((r) => r.type !== 'eq').length
  if (changed === 0) throw new Error('no changes detected')
  console.log('     rows=' + rows.length + ' changed=' + changed)
  return true
})

check('using a mid-state as baseline would hide earlier edits', () => {
  const fromV1 = toSideBySide(diffLines(V1, V4)).filter((r) => r.type !== 'eq').length
  const fromV3 = toSideBySide(diffLines(V3, V4)).filter((r) => r.type !== 'eq').length
  if (fromV1 <= fromV3) throw new Error('conversation baseline should reveal strictly more')
  console.log('     from V1: ' + fromV1 + '   from V3: ' + fromV3)
  return true
})

check('new file: baseline stays null through the conversation', () => {
  beforeByCall.clear()
  let s = definition.init({ id: 's2' })
  s = edit(s, 'n1', null, { file_path: 'x.c', content: 'line1\n' })
  let v = definition.wire.view(s).last
  if (v.beforeText !== null) throw new Error('first: ' + JSON.stringify(v.beforeText))
  s = edit(s, 'n2', 'line1\n', { file_path: 'x.c', old_string: 'a', new_string: 'b' })
  v = definition.wire.view(s).last
  if (v.beforeText !== null) throw new Error('later: ' + JSON.stringify(v.beforeText))
})

check('baseline survives across many edits (conversation scope)', () => {
  beforeByCall.clear()
  let s = definition.init({ id: 's3' })
  s = edit(s, 'm1', 'ORIGINAL', { file_path: 'y.c', old_string: 'a', new_string: 'b' })
  for (let i = 2; i <= 8; i++) {
    s = edit(s, 'm' + i, 'mid-' + i, { file_path: 'y.c', old_string: 'a', new_string: 'b' })
  }
  const v = definition.wire.view(s).last
  if (v.beforeText !== 'ORIGINAL') throw new Error('lost after many edits: ' + JSON.stringify(v.beforeText))
})

console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
