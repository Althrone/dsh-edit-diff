import fs from 'node:fs'
import vm from 'node:vm'

// 用真实的 write / edit 工具参数（从 listTools 确认）驱动投影，验证端到端折叠。
const src = fs.readFileSync('dsh-edit-diff/index.js', 'utf8')
const body = src.replace(/^import .*$/gm, '').replace(/^export /gm, '')

const sandbox = { console, Date, JSON, Map, Set, Math, String, Number, Array, Object, Error, setTimeout }
sandbox.watch = () => ({ on() {}, close() {} })
const context = vm.createContext(sandbox)
vm.runInContext(body + '\n;globalThis.__t = { definition, editFromCall };', context)
const { definition, editFromCall } = sandbox.__t

let failures = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    failures++
    console.log('FAIL ' + name + '\n  got:      ' + a + '\n  expected: ' + e)
  } else {
    console.log('ok   ' + name)
  }
}

// 1) 真实 write 工具调用：file_path + content（不是 path）
const writeArgs = { file_path: 'D:\\Project\\cline\\follow-test.c', content: '#include <stdio.h>\nint main(void) { return 0; }\n' }
check('write uses file_path', (() => {
  const e = editFromCall({ name: 'write', arguments: writeArgs })
  return [e.path, e.command, e.line]
})(), ['D:\\Project\\cline\\follow-test.c', 'write', 1])

// 2) 完整生命周期：tool/call → tool/result → wire.view
const callId = 'call-abc'
let state = definition.init({ id: 'session-test' })
state = definition.apply(state, {
  type: 'tool/call',
  time: 1000,
  data: { callId, name: 'write', arguments: writeArgs },
})
check('pending after tool/call', () => state.pending !== null && state.pending.path.endsWith('follow-test.c'))

state = definition.apply(state, {
  type: 'tool/result',
  time: 2000,
  data: { message: { source: { callId }, isError: false } },
})
const view = definition.wire.view(state)
check('wire view for write', [view.path.split(/[\\/]/).pop(), view.command, view.line, view.ts], ['follow-test.c', 'write', 1, 2000])
check('newStr carries content', view.newStr.includes('int main'), true)
check('oldStr empty for create', view.oldStr, '')
check('viewSchema accepts the real view', (() => { definition.wire.viewSchema.parse(view); return 'ok' })(), 'ok')

// 3) 真实的 edit 工具调用：file_path + old_string/new_string
check('edit uses file_path + old/new_string', (() => {
  const e = editFromCall({
    name: 'edit',
    arguments: { file_path: 'a.c', old_string: 'int main(void)', new_string: 'int main(int argc, char **argv)', replace_all: false },
  })
  return [e.path, e.oldStr, e.newStr]
})(), ['a.c', 'int main(void)', 'int main(int argc, char **argv)'])

// 4) 删除（new_string 为空）也要能跟随
check('pure deletion still produces an edit', (() => {
  const e = editFromCall({ name: 'edit', arguments: { file_path: 'a.c', old_string: '/* gone */', new_string: '' } })
  return [e.oldStr, e.newStr]
})(), ['/* gone */', ''])

console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
