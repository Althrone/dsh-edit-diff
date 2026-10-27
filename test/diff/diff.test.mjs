import fs from 'node:fs'
import vm from 'node:vm'

// Pull the pure diff helpers out of client.js and exercise them directly.
const src = fs.readFileSync('dsh-edit-diff/client.js', 'utf8')
const start = src.indexOf('    function diffLines(')
const end = src.indexOf('    function changedSpan(')
const helpers = src.slice(start, end)

const sandbox = { console, Math, Array, String, Number, Object, MAX_DIFF_CELLS: 4_000_000 }
const context = vm.createContext(sandbox)
vm.runInContext(helpers + '\n;globalThis.__d = { diffLines, toSideBySide };', context)
const { diffLines, toSideBySide } = sandbox.__d

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

check('identical', diffLines('a\nb', 'a\nb').map((o) => o.type), ['eq', 'eq'])
check('changed line', diffLines('a\nb\nc', 'a\nB\nc').map((o) => o.type), ['eq', 'del', 'add', 'eq'])
check('pure insert', diffLines('a\nc', 'a\nb\nc').map((o) => o.type), ['eq', 'add', 'eq'])
check('pure delete', diffLines('a\nb\nc', 'a\nc').map((o) => o.type), ['eq', 'del', 'eq'])
check('create from empty', diffLines('', 'a\nb').map((o) => o.type), ['add', 'add'])

check('side-by-side pairs a modification', (() => {
  const rows = toSideBySide(diffLines('a\nb\nc', 'a\nB\nc'))
  return rows.map((r) => [r.type, r.left, r.right])
})(), [['eq', 'a', 'a'], ['mod', 'b', 'B'], ['eq', 'c', 'c']])

check('side-by-side keeps line numbers right', (() => {
  const rows = toSideBySide(diffLines('a\nc', 'a\nb\nc'))
  return rows.map((r) => [r.type, r.leftNo, r.rightNo, r.left ?? null, r.right ?? null])
})(), [['eq', 1, 1, 'a', 'a'], ['add', null, 2, null, 'b'], ['eq', 2, 3, 'c', 'c']])

check('deletion leaves right cell empty', (() => {
  const rows = toSideBySide(diffLines('a\nb\nc', 'a\nc'))
  return rows.map((r) => [r.type, r.left ?? null, r.right ?? null])
})(), [['eq', 'a', 'a'], ['del', 'b', null], ['eq', 'c', 'c']])

console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
