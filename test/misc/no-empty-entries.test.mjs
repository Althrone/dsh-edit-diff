import fs from 'node:fs'
import vm from 'node:vm'

// 回归：无法对比的条目不该出现在列表里。
//
// 用户反馈：出现了写着「这次改动没有记录到前后内容」的空栏目。
// 根因是「没有基线」的条目仍被放行到列表，而它永远算不出 diff。

const hostSrc = fs.readFileSync('dsh-edit-diff/index.js', 'utf8')
const body = hostSrc.replace(/^import .*$/gm, '').replace(/^export /gm, '')

const hs = {
  console, Date, JSON, Map, Set, Math, String, Number, Array, Object, Error, setTimeout, Buffer,
  process: { cwd: () => 'D:/w' },
  statSync: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) },
  readFileSync: () => '',
}
hs.watch = () => ({ on() {}, close() {} })
vm.createContext(hs)
vm.runInContext(
  body + '\n;globalThis.__h = { definition, turnBaseline };',
  hs,
)
const { definition, turnBaseline } = hs.__h

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

function viewWith(entries) {
  let s = definition.init({ id: 's1' })
  s = definition.apply(s, { type: 'turn/start', time: 1, data: {} })
  s = { ...s, turnFiles: entries }
  return definition.wire.view(s)
}

const base = { tool: 'edit', command: 'edit', line: 1, oldStr: 'a', newStr: 'b' }

check('无基线 + 有 afterText → 不列出', () => {
  const v = viewWith({
    'D:/w/a.js': { ...base, path: 'D:/w/a.js', ts: 1, beforeKnown: false, afterText: 'NEW\n' },
  })
  if (v.files.length !== 0) throw new Error('listed despite no baseline')
})

check('无基线 + 无 afterText → 不列出', () => {
  const v = viewWith({
    'D:/w/b.js': { ...base, path: 'D:/w/b.js', ts: 1, beforeKnown: false },
  })
  if (v.files.length !== 0) throw new Error('listed despite having nothing')
})

check('有基线 + 内容变化 → 列出', () => {
  const v = viewWith({
    'D:/w/c.js': { ...base, path: 'D:/w/c.js', ts: 1, beforeKnown: true, beforeText: 'A\n', afterText: 'B\n' },
  })
  if (v.files.length !== 1) throw new Error('not listed')
})

check('有基线 + 内容相同 → 不列出', () => {
  const v = viewWith({
    'D:/w/d.js': { ...base, path: 'D:/w/d.js', ts: 1, beforeKnown: true, beforeText: 'A\n', afterText: 'A\n' },
  })
  if (v.files.length !== 0) throw new Error('no-op listed')
})

check('有基线 + 无 afterText + 有 newStr → 用 newStr 比较', () => {
  const v = viewWith({
    'D:/w/e.js': { ...base, path: 'D:/w/e.js', ts: 1, beforeKnown: true, beforeText: 'A\n', newStr: 'B\n' },
  })
  if (v.files.length !== 1) throw new Error('newStr comparison broken')
})

check('新建文件（基线 null）→ 列出', () => {
  const v = viewWith({
    'D:/w/f.js': { ...base, path: 'D:/w/f.js', ts: 1, beforeKnown: true, beforeText: null, afterText: 'NEW\n' },
  })
  if (v.files.length !== 1) throw new Error('created file dropped')
})

// 源码层：noteShellChange 在没有基线时不应记录
check('noteShellChange 无基线时直接返回', () => {
  const start = hostSrc.indexOf('function noteShellChange')
  const block = hostSrc.slice(start, start + 2200)
  if (!/if \(base === undefined\) return/.test(block)) {
    throw new Error('noteShellChange still records entries without a baseline')
  }
})

check('wire view 不再给无基线条目开例外', () => {
  const start = hostSrc.indexOf('view: (state) => {')
  const block = hostSrc.slice(start, start + 1200)
  if (/beforeKnown !== true\) return true/.test(block)) {
    throw new Error('the "keep when afterText exists" exemption is back')
  }
})

console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
