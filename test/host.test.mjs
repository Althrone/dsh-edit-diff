import fs from 'node:fs'
import vm from 'node:vm'

const src = fs.readFileSync('dsh-edit-diff/index.js', 'utf8')
const body = src
  .replace(/^import .*$/gm, '')
  .replace(/^export /gm, '')
  .replace(/process\.exit[\s\S]*$/, '')

const sandbox = { console, Date, JSON, Map, Set, Math, String, Number, Array, Object, Error, setTimeout }
sandbox.watch = () => ({ on() {}, close() {} })
const context = vm.createContext(sandbox)
vm.runInContext(body + '\n;globalThis.__t = { definition, editFromCall, diffTest: null };', context)

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

// 编辑解析
check('edit old/new', (() => {
  const e = editFromCall({ name: 'edit', arguments: JSON.stringify({ file_path: 'a.ts', old_string: 'x', new_string: 'y' }) })
  return [e.path, e.command, e.oldStr, e.newStr]
})(), ['a.ts', 'edit', 'x', 'y'])

check('write', (() => {
  const e = editFromCall({ name: 'write', arguments: { path: 'b.md', content: 'hi' } })
  return [e.command, e.line, e.newStr]
})(), ['write', 1, 'hi'])

check('create', (() => {
  const e = editFromCall({ name: 'str_replace_editor', arguments: { command: 'create', path: 'c', file_text: 'z' } })
  return [e.command, e.line]
})(), ['create', 1])

check('insert', (() => {
  const e = editFromCall({ name: 'str_replace_editor', arguments: { command: 'insert', path: 'c', insert_line: 4, new_str: 'z' } })
  return [e.command, e.line]
})(), ['insert', 5])

check('view is not an edit', editFromCall({ name: 'str_replace_editor', arguments: { command: 'view', path: 'c' } }), null)
check('read tool ignored', editFromCall({ name: 'read', arguments: { path: 'c' } }), null)

// schema 垫片
check('stateSchema accepts init state', (() => {
  const s = definition.init({ id: 's1' })
  definition.stateSchema.parse(s)
  return s
})(), { sessionId: 's1', pending: null, last: null })

check('stateSchema rejects garbage', (() => {
  try {
    definition.stateSchema.parse({ nope: true })
    return 'accepted'
  } catch {
    return 'rejected'
  }
})(), 'rejected')

check('viewSchema accepts null', (() => { definition.wire.viewSchema.parse(null); return 'ok' })(), 'ok')

// 折叠：成功的 edit → last 带行号
check('fold successful edit', (() => {
  let state = definition.init({ id: 's1' })
  state = definition.apply(state, {
    type: 'tool/call',
    time: 100,
    data: { callId: 'call1', name: 'edit', arguments: JSON.stringify({ file_path: 'a.ts', old_string: 'x', new_string: 'y' }) },
  })
  state = definition.apply(state, {
    type: 'tool/result',
    time: 200,
    data: { message: { source: { callId: 'call1' }, isError: false } },
  })
  const view = definition.wire.view(state)
  return [view.path, view.command, view.line, view.ts, state.pending]
})(), ['a.ts', 'edit', null, 200, null])

check('failed edit is not followed', (() => {
  let state = definition.init({ id: 's1' })
  state = definition.apply(state, {
    type: 'tool/call',
    time: 100,
    data: { callId: 'c2', name: 'write', arguments: { path: 'z', content: 'q' } },
  })
  state = definition.apply(state, {
    type: 'tool/result',
    time: 200,
    data: { message: { source: { callId: 'c2' }, isError: true } },
  })
  return [state.pending, definition.wire.view(state)]
})(), [null, null])

check('init exposes stateVersion', typeof definition.stateVersion, 'number')
check('projection key', definition.key, 'editDiff')

console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
