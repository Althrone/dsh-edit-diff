import fs from 'node:fs'
import vm from 'node:vm'

// 验证「同一轮内多次编辑不漂移」。
// 关键：基线现在存在投影 state 里，不依赖任何 session id 匹配。

const src = fs.readFileSync('dsh-edit-diff/index.js', 'utf8')
const body = src.replace(/^import .*$/gm, '').replace(/^export /gm, '')

const sandbox = {
  console, Date, JSON, Map, Set, Math, String, Number, Array, Object, Error, setTimeout, Buffer,
  process: { cwd: () => 'C:/w' },
  statSync: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) },
  readFileSync: () => '',
}
sandbox.watch = () => ({ on() {}, close() {} })
vm.createContext(sandbox)
vm.runInContext(body + '\n;globalThis.__t = { definition, beforeByCall, normPath };', sandbox)
const { definition, beforeByCall, normPath } = sandbox.__t

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

const SID = 'session-1'
const PATH = 'D:/w/a.py'

/**
 * 走一次完整编辑：pre-execute 存单次基线 → tool/call → tool/result。
 * 返回新的 state（代表会话持续推进）。
 */
function step(state, callId, preEditContent, args = {}) {
  beforeByCall.set(callId, preEditContent)
  let s = definition.apply(state, {
    type: 'tool/call',
    time: 1,
    data: {
      callId,
      name: 'edit',
      arguments: { file_path: PATH, old_string: 'x', new_string: 'y', ...args },
    },
  })
  s = definition.apply(s, {
    type: 'tool/result',
    time: 2,
    data: { message: { source: { callId }, isError: false } },
  })
  return s
}

const V0 = 'def a():\n    pass\n'
const V1 = 'def a():\n    pass\n\ndef b():\n    pass\n'
const V2 = V1 + '\ndef c():\n    pass\n'

check('第 1 次编辑：基线 = 编辑前内容', () => {
  beforeByCall.clear()
  let s = definition.init({ id: SID })
  s = step(s, 'c1', V0)
  const v = definition.wire.view(s).last
  if (v.beforeText !== V0) throw new Error('got ' + JSON.stringify(v.beforeText))
})

check('第 2 次编辑：基线仍是 V0（不漂移）', () => {
  beforeByCall.clear()
  let s = definition.init({ id: SID })
  s = step(s, 'c1', V0)
  s = step(s, 'c2', V1)   // 编辑前是 V1，但基线应保持 V0
  const v = definition.wire.view(s).last
  if (v.beforeText !== V0) {
    throw new Error('DRIFT: got ' + JSON.stringify(v.beforeText) + ', expected V0')
  }
})

check('第 3 次编辑：基线还是 V0', () => {
  beforeByCall.clear()
  let s = definition.init({ id: SID })
  s = step(s, 'c1', V0)
  s = step(s, 'c2', V1)
  s = step(s, 'c3', V2)
  const v = definition.wire.view(s).last
  if (v.beforeText !== V0) throw new Error('DRIFT: ' + JSON.stringify(v.beforeText))
})

check('不同文件各自独立基线', () => {
  beforeByCall.clear()
  let s = definition.init({ id: SID })
  s = step(s, 'c1', 'FILE-A-ORIGINAL')
  // 换文件
  beforeByCall.set('c2', 'FILE-B-ORIGINAL')
  s = definition.apply(s, {
    type: 'tool/call', time: 1,
    data: { callId: 'c2', name: 'edit', arguments: { file_path: 'D:/w/b.py', old_string: 'x', new_string: 'y' } },
  })
  s = definition.apply(s, {
    type: 'tool/result', time: 2,
    data: { message: { source: { callId: 'c2' }, isError: false } },
  })
  const v = definition.wire.view(s).last
  if (v.beforeText !== 'FILE-B-ORIGINAL') throw new Error('got ' + JSON.stringify(v.beforeText))
})

check('新建文件：基线为 null 且后续保持', () => {
  beforeByCall.clear()
  let s = definition.init({ id: SID })
  s = step(s, 'c1', null)   // 文件原本不存在
  let v = definition.wire.view(s).last
  if (v.beforeText !== null) throw new Error('first: ' + JSON.stringify(v.beforeText))
  s = step(s, 'c2', 'partial content')
  v = definition.wire.view(s).last
  if (v.beforeText !== null) throw new Error('after second edit: ' + JSON.stringify(v.beforeText))
})

check('没有基线时如实标记（不假装有）', () => {
  beforeByCall.clear()
  let s = definition.init({ id: SID })
  s = definition.apply(s, {
    type: 'tool/call', time: 1,
    data: { callId: 'x', name: 'edit', arguments: { file_path: 'D:/w/z.py', old_string: 'a', new_string: 'b' } },
  })
  s = definition.apply(s, {
    type: 'tool/result', time: 2,
    data: { message: { source: { callId: 'x' }, isError: false } },
  })
  const v = definition.wire.view(s).last
  if (v.beforeKnown !== undefined) throw new Error('should not claim a baseline')
})

check('旧检查点没有 baselines 字段也不崩', () => {
  beforeByCall.clear()
  // 手工构造一个没有 baselines 的旧 state
  const old = { sessionId: SID, pending: null, last: null }
  const s = step(old, 'c1', V0)
  const v = definition.wire.view(s).last
  if (v.beforeText !== V0) throw new Error('got ' + JSON.stringify(v.beforeText))
})

check('stateSchema 接受带 baselines 的 state', () => {
  beforeByCall.clear()
  let s = definition.init({ id: SID })
  s = step(s, 'c1', V0)
  definition.stateSchema.parse(s)
})

check('stateSchema 接受没有 baselines 的旧 state', () => {
  definition.stateSchema.parse({ sessionId: SID, pending: null, last: null })
})

check('基线表随 state 前进（不改动原对象）', () => {
  beforeByCall.clear()
  const s0 = definition.init({ id: SID })
  const s1 = step(s0, 'c1', V0)
  if (s0.baselines === s1.baselines) throw new Error('should create a new table')
  if (Object.keys(s0.baselines).length !== 0) throw new Error('original mutated')
  if (Object.keys(s1.baselines).length !== 1) throw new Error('baseline not recorded')
})

console.log('\n--- 场景复现：三次连续编辑（模拟真实对话）---')
beforeByCall.clear()
let st = definition.init({ id: SID })
st = step(st, 'e1', V0)
console.log('  编辑1: 基线 = V0 ? ' + (definition.wire.view(st).last.beforeText === V0))
st = step(st, 'e2', V1)
console.log('  编辑2: 基线 = V0 ? ' + (definition.wire.view(st).last.beforeText === V0))
st = step(st, 'e3', V2)
console.log('  编辑3: 基线 = V0 ? ' + (definition.wire.view(st).last.beforeText === V0))

console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
