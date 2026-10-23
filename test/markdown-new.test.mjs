import fs from 'node:fs'
import vm from 'node:vm'

// 验证 .md 新建文件在 diff 标签里的处理：
// 1) languageOf('*.md') 必须返回 null（走纯文本，不误染色）
// 2) 新建语义：左栏全空，全部为新增

const clientSrc = fs.readFileSync('dsh-edit-diff/client.js', 'utf8')

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

const sandbox = { console, Math, Array, String, Number, Object, Int32Array, MAX_DIFF_CELLS: 4_000_000, RegExp }
vm.createContext(sandbox)
vm.runInContext(
  extractFn(clientSrc, 'diffLines') + '\n\n' +
  extractFn(clientSrc, 'toSideBySide') + '\n\n' +
  extractFn(clientSrc, 'languageOf') +
  '\n;globalThis.__c = { diffLines, toSideBySide, languageOf };',
  sandbox,
)
const { diffLines, toSideBySide, languageOf } = sandbox.__c

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

check('markdown has no highlight language (plain text path)', () => {
  for (const p of ['a.md', 'b.markdown', 'c.mdx']) {
    const lang = languageOf(p)
    if (lang !== null) throw new Error(p + ' -> ' + lang + ', want null')
  }
})

check('c file still highlights', () => {
  if (languageOf('a.c') !== 'c') throw new Error('c lost its language')
})

const md = fs.readFileSync('follow-new.md', 'utf8')

// 新建语义
const after = md.replace(/\r\n/g, '\n')
const before = '' // wholesale write
const rows = toSideBySide(diffLines(before, after))

check('new markdown: left column entirely empty', () => {
  const leftFilled = rows.filter((r) => r.left !== undefined).length
  if (leftFilled !== 0) throw new Error('left has ' + leftFilled + ' filled rows')
})

check('new markdown: every row is an add', () => {
  const notAdd = rows.filter((r) => r.type !== 'add').length
  if (notAdd !== 0) throw new Error(notAdd + ' rows are not adds')
})

check('row count matches line count', () => {
  const lines = after.split('\n').length
  if (rows.length !== lines) throw new Error('rows=' + rows.length + ' lines=' + lines)
})

check('markdown syntax is preserved verbatim (no mangling)', () => {
  const joined = rows.map((r) => r.right).join('\n')
  if (joined !== after) throw new Error('content changed by diff')
})

check('tables / code fences / checkboxes survive', () => {
  if (!after.includes('| 操作 | 复杂度 |')) throw new Error('table lost')
  if (!after.includes('```c')) throw new Error('code fence lost')
  if (!after.includes('- [x] 最长链统计')) throw new Error('checkbox lost')
  if (!after.includes('> 为什么用无符号字符')) throw new Error('blockquote lost')
})

console.log('\nrows=' + rows.length + '，左栏全空，右栏全为新增')
console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
