import fs from 'node:fs'
import vm from 'node:vm'

// 会话内基线：同一文件被多次编辑时，每次都对比会话最初的样子。
// 基线现在存在投影 state 内（不依赖全局表 / session id 匹配）。

const hostSrc = fs.readFileSync('dsh-edit-diff/index.js', 'utf8')
const body = hostSrc.replace(/^import .*$/gm, '').replace(/^export /gm, '')

const sandbox = {
  console, Date, JSON, Map, Set, Math, String, Number, Array, Object, Error, setTimeout, Buffer,
}
sandbox.watch = () => ({ on() {}, close() {} })
vm.createContext(sandbox)
vm.runInContext(body + '\n;globalThis.__h = { definition, beforeByCall, normPath };', sandbox)
const { definition, beforeByCall, normPath } = sandbox.__h

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

/** 走一次编辑，返回新 state。 */
function edit(state, callId, path, preEditContent, editInfo = {}) {
  beforeByCall.set(callId, preEditContent)
  let s = definition.apply(state, {
    type: 'tool/call',
    time: 100,
    data: {
      callId,
      name: 'edit',
      arguments: {
        file_path: path,
        old_string: editInfo.oldStr ?? 'old',
        new_string: editInfo.newStr ?? 'new',
      },
    },
  })
  s = definition.apply(s, {
    type: 'tool/result',
    time: 200,
    data: { message: { source: { callId }, isError: false } },
  })
  return s
}

const SID = 's1'
const PATH = 'a.c'

check('首次编辑：基线是编辑前内容', () => {
  beforeByCall.clear()
  let s = definition.init({ id: SID })
  s = edit(s, 'c1', PATH, 'ORIGINAL')
  const v = definition.wire.view(s).last
  if (v.beforeKnown !== true) throw new Error('no baseline flag')
  if (v.beforeText !== 'ORIGINAL') throw new Error('got ' + JSON.stringify(v.beforeText))
})

check('第二次编辑：仍对比会话最初的版本', () => {
  beforeByCall.clear()
  let s = definition.init({ id: SID })
  s = edit(s, 'c1', PATH, 'V1')
  s = edit(s, 'c2', PATH, 'V2')   // 编辑前是 V2，基线应保持 V1
  const v = definition.wire.view(s).last
  if (v.beforeText !== 'V1') throw new Error('drift: ' + JSON.stringify(v.beforeText))
})

check('第三次编辑：基线仍然是 V1', () => {
  beforeByCall.clear()
  let s = definition.init({ id: SID })
  s = edit(s, 'c1', PATH, 'V1')
  s = edit(s, 'c2', PATH, 'V2')
  s = edit(s, 'c3', PATH, 'V3')
  const v = definition.wire.view(s).last
  if (v.beforeText !== 'V1') throw new Error('drift: ' + JSON.stringify(v.beforeText))
})

check('不同文件各自独立基线', () => {
  beforeByCall.clear()
  let s = definition.init({ id: SID })
  s = edit(s, 'c1', 'a.c', 'A-original')
  s = edit(s, 'c2', 'b.c', 'B-content')
  const v = definition.wire.view(s).last
  if (v.beforeText !== 'B-content') throw new Error('wrong baseline: ' + JSON.stringify(v.beforeText))
})

check('不同会话互不影响', () => {
  beforeByCall.clear()
  let s1 = definition.init({ id: 'sess-A' })
  s1 = edit(s1, 'c1', 'a.c', 'SESSION-A')
  let s2 = definition.init({ id: 'sess-B' })
  s2 = edit(s2, 'c2', 'a.c', 'SESSION-B')
  const v2 = definition.wire.view(s2).last
  if (v2.beforeText !== 'SESSION-B') throw new Error('sessions bled: ' + JSON.stringify(v2.beforeText))
})

check('新建文件（基线 null）保持为 null', () => {
  beforeByCall.clear()
  let s = definition.init({ id: SID })
  s = edit(s, 'c1', 'new.c', null)
  const v = definition.wire.view(s).last
  if (v.beforeKnown !== true) throw new Error('should know the baseline')
  if (v.beforeText !== null) throw new Error('got ' + JSON.stringify(v.beforeText))
})

check('新建后再编辑：基线仍是 null（整段都是新增）', () => {
  beforeByCall.clear()
  let s = definition.init({ id: SID })
  s = edit(s, 'c1', 'new.c', null)
  s = edit(s, 'c2', 'new.c', 'partial content')
  const v = definition.wire.view(s).last
  if (v.beforeText !== null) throw new Error('got ' + JSON.stringify(v.beforeText))
})

check('没有基线时不带 beforeKnown', () => {
  beforeByCall.clear()
  let s = definition.init({ id: 's9' })
  s = definition.apply(s, {
    type: 'tool/call',
    time: 1,
    data: { callId: 'x', name: 'edit', arguments: { file_path: 'z.c', old_string: 'a', new_string: 'b' } },
  })
  s = definition.apply(s, {
    type: 'tool/result',
    time: 2,
    data: { message: { source: { callId: 'x' }, isError: false } },
  })
  const v = definition.wire.view(s).last
  if (v.beforeKnown !== undefined) throw new Error('should not claim a baseline')
})

check('轮次语义：编辑基线由投影 state 在 turn/start 重置', () => {
  // 每轮对比的是「上一轮结束时的状态」，所以基线随轮次滚动。
  // 投影内部处理（turn/start 清空 baselines），shell 用全局表由 turn-stopping 清。
  if (!/event\.type === 'turn\/start'/.test(hostSrc)) {
    throw new Error('projection does not reset baselines on turn/start')
  }
  if (!hostSrc.includes("'agent/turn-stopping'")) {
    throw new Error('shell baseline cleanup on turn-stopping missing')
  }
  if (!hostSrc.includes("'session/disposed'")) {
    throw new Error('session/disposed cleanup missing')
  }
})

check('失败结果不清空已有基线', () => {
  beforeByCall.clear()
  let s = definition.init({ id: SID })
  s = edit(s, 'c1', PATH, 'V1')
  // 第二次失败
  beforeByCall.set('c2', 'V2')
  s = definition.apply(s, {
    type: 'tool/call',
    time: 3,
    data: { callId: 'c2', name: 'edit', arguments: { file_path: PATH, old_string: 'x', new_string: 'y' } },
  })
  s = definition.apply(s, {
    type: 'tool/result',
    time: 4,
    data: { message: { source: { callId: 'c2' }, isError: true } },
  })
  // 第三次成功，基线应仍是 V1
  s = edit(s, 'c3', PATH, 'V3')
  const v = definition.wire.view(s).last
  if (v.beforeText !== 'V1') throw new Error('baseline lost after a failed edit: ' + JSON.stringify(v.beforeText))
})

console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
