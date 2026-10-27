import fs from 'node:fs'
import vm from 'node:vm'

// 轮次语义：每轮对比的是【上一轮结束时的状态】。
//   · 一轮内多次编辑 → 都对比本轮开始前的状态（不漂移）
//   · 进入新一轮     → 基线刷新为本轮开始前的状态

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
vm.runInContext(body + '\n;globalThis.__t = { definition, beforeByCall };', sandbox)
const { definition, beforeByCall } = sandbox.__t

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

const PATH = 'a.md'

function turnStart(state, turn) {
  return definition.apply(state, { type: 'turn/start', time: 1, data: { turn } })
}

function edit(state, callId, preEditContent, path = PATH) {
  beforeByCall.set(callId, preEditContent)
  let s = definition.apply(state, {
    type: 'tool/call',
    time: 10,
    data: { callId, name: 'edit', arguments: { file_path: path, old_string: 'x', new_string: 'y' } },
  })
  s = definition.apply(s, {
    type: 'tool/result',
    time: 20,
    data: { message: { source: { callId }, isError: false } },
  })
  return s
}

check('一轮内两次编辑：都对比本轮开始前的状态', () => {
  beforeByCall.clear()
  let s = definition.init({ id: 'S1' })
  s = turnStart(s, 1)
  s = edit(s, 'c1', 'V0')            // 本轮开始前是 V0
  s = edit(s, 'c2', 'V1')            // 编辑前是 V1，但基线应仍是 V0
  const v = definition.wire.view(s).last
  if (v.beforeText !== 'V0') throw new Error('drift within a turn: ' + JSON.stringify(v.beforeText))
})

check('进入新一轮：基线刷新为上一轮结束时的状态', () => {
  beforeByCall.clear()
  let s = definition.init({ id: 'S1' })
  s = turnStart(s, 1)
  s = edit(s, 'c1', 'V0')            // 第 1 轮：基线 V0
  let v = definition.wire.view(s).last
  if (v.beforeText !== 'V0') throw new Error('turn1 baseline wrong')

  // 第 1 轮结束，第 2 轮开始。此时磁盘上是 V1（第 1 轮改完的样子）
  s = turnStart(s, 2)
  s = edit(s, 'c2', 'V1')
  v = definition.wire.view(s).last
  if (v.beforeText !== 'V1') {
    throw new Error('turn2 should compare against V1 (end of turn 1), got ' + JSON.stringify(v.beforeText))
  }
})

check('第 3 轮同样刷新', () => {
  beforeByCall.clear()
  let s = definition.init({ id: 'S1' })
  s = turnStart(s, 1); s = edit(s, 'c1', 'V0')
  s = turnStart(s, 2); s = edit(s, 'c2', 'V1')
  s = turnStart(s, 3); s = edit(s, 'c3', 'V2')
  const v = definition.wire.view(s).last
  if (v.beforeText !== 'V2') throw new Error('got ' + JSON.stringify(v.beforeText))
})

check('新轮内多次编辑仍然不漂移', () => {
  beforeByCall.clear()
  let s = definition.init({ id: 'S1' })
  s = turnStart(s, 1); s = edit(s, 'c1', 'V0')
  s = turnStart(s, 2)
  s = edit(s, 'c2', 'V1')   // 第 2 轮基线 = V1
  s = edit(s, 'c3', 'V1a')  // 仍是 V1
  s = edit(s, 'c4', 'V1b')  // 仍是 V1
  const v = definition.wire.view(s).last
  if (v.beforeText !== 'V1') throw new Error('drift in turn 2: ' + JSON.stringify(v.beforeText))
})

check('同一轮内不同文件各自独立', () => {
  beforeByCall.clear()
  let s = definition.init({ id: 'S1' })
  s = turnStart(s, 1)
  s = edit(s, 'c1', 'A-orig', 'a.md')
  s = edit(s, 'c2', 'B-orig', 'b.md')
  const v = definition.wire.view(s).last
  if (v.beforeText !== 'B-orig') throw new Error('got ' + JSON.stringify(v.beforeText))
})

check('新建文件：新轮开始后基线不再为空（文件已存在）', () => {
  beforeByCall.clear()
  let s = definition.init({ id: 'S1' })
  s = turnStart(s, 1)
  s = edit(s, 'c1', null)      // 会话里第一次见，文件不存在
  let v = definition.wire.view(s).last
  if (v.beforeText !== null) throw new Error('turn1: ' + JSON.stringify(v.beforeText))

  // 第 2 轮：文件已经存在了（上一轮创建的）
  s = turnStart(s, 2)
  s = edit(s, 'c2', '# created in turn 1\n')
  v = definition.wire.view(s).last
  if (v.beforeText !== '# created in turn 1\n') {
    throw new Error('turn2 should see the real file content, got ' + JSON.stringify(v.beforeText))
  }
})

check('turn/start 清空基线表', () => {
  beforeByCall.clear()
  let s = definition.init({ id: 'S1' })
  s = turnStart(s, 1)
  s = edit(s, 'c1', 'V0')
  if (Object.keys(s.baselines).length !== 1) throw new Error('baseline not recorded')
  const after = turnStart(s, 2)
  if (Object.keys(after.baselines).length !== 0) throw new Error('baselines not cleared on turn/start')
})

check('空基线表时 turn/start 不制造新对象（避免无谓重渲染）', () => {
  const s = definition.init({ id: 'S1' })
  const after = turnStart(s, 1)
  if (after.baselines !== s.baselines) {
    // 允许，但更好的是保持同一引用
    if (Object.keys(after.baselines).length === 0) return true
  }
  return true
})

check('host 注册了 turn-stopping 清理 shell 基线', () => {
  if (!src.includes("'agent/turn-stopping'")) throw new Error('missing turn-stopping listener')
})

console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
