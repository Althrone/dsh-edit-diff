import fs from 'node:fs'
import vm from 'node:vm'

// 复刻修复后的 client rows 计算，验证新建文件与各种不一致场景。

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

const sandbox = { console, Math, Array, String, Number, Object, Int32Array, MAX_DIFF_CELLS: 4_000_000 }
vm.createContext(sandbox)
vm.runInContext(
  extractFn(clientSrc, 'diffLines') + '\n\n' + extractFn(clientSrc, 'toSideBySide') +
  '\n;globalThis.__c = { diffLines, toSideBySide };',
  sandbox,
)
const { diffLines, toSideBySide } = sandbox.__c

// 与 client.js 中 rows 的逻辑保持一致（修复后）
function computeRows(text, oldStr, newStr, command) {
  const norm = (s) => String(s).replace(/\r\n/g, '\n')
  const after = norm(text)
  const target = norm(newStr)
  const original = norm(oldStr)

  let before = after
  const wholesale = command === 'create' || command === 'write' || command === 'patch'
  if (wholesale) {
    before = ''
  } else if (target.length > 0) {
    const idx = after.indexOf(target)
    if (idx >= 0) {
      before = after.slice(0, idx) + original + after.slice(idx + target.length)
    } else {
      before = ''
    }
  } else if (original.length > 0 && after.length === 0) {
    before = original
  }
  return { before, rows: toSideBySide(diffLines(before, after)) }
}

// 测试自带样例内容，不依赖工作区里可能被删掉的临时文件。
const disk = [
  '#include <stdio.h>',
  '#include <stdlib.h>',
  '',
  '#define TABLE_SIZE 97',
  '',
  'typedef struct Node {',
  '    char *name;',
  '    int count;',
  '    struct Node *next;',
  '} Node;',
  '',
  '/** Longest collision chain. */',
  'size_t table_longest_chain(Node **buckets)',
  '{',
  '    size_t longest = 0;',
  '    for (size_t i = 0; i < TABLE_SIZE; i++) {',
  '        size_t depth = 0;',
  '        for (Node *cur = buckets[i]; cur != NULL; cur = cur->next) {',
  '            depth++;',
  '        }',
  '        if (depth > longest) {',
  '            longest = depth;',
  '        }',
  '    }',
  '    return longest;',
  '}',
  '',
].join('\n')
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

check('new file: left side empty, everything added', () => {
  const r = computeRows(disk, '', disk, 'write')
  if (r.before !== '') throw new Error('before should be empty, got ' + r.before.length + ' chars')
  const eq = r.rows.filter((x) => x.type === 'eq').length
  const add = r.rows.filter((x) => x.type === 'add').length
  if (eq !== 0) throw new Error('expected 0 eq rows, got ' + eq)
  if (add === 0) throw new Error('expected add rows')
  const leftFilled = r.rows.filter((x) => x.left !== undefined).length
  if (leftFilled !== 0) throw new Error('left column should be empty, got ' + leftFilled + ' filled')
  return true
})

check('CRLF vs LF mismatch still shows all-add', () => {
  const crlf = disk.replace(/\n/g, '\r\n')
  const r = computeRows(crlf, '', disk, 'write')
  const leftFilled = r.rows.filter((x) => x.left !== undefined).length
  if (leftFilled !== 0) throw new Error('left column has ' + leftFilled + ' filled rows')
})

check('trailing newline differences never leave rows on the left', () => {
  for (const variant of [disk + '\n', disk.replace(/\n$/, '')]) {
    const r = computeRows(variant, '', disk, 'write')
    const leftFilled = r.rows.filter((x) => x.left !== undefined).length
    if (leftFilled !== 0) throw new Error('left column has ' + leftFilled + ' filled rows')
    const add = r.rows.filter((x) => x.type === 'add').length
    if (add === 0) throw new Error('expected add rows')
  }
  return true
})

check('edit: reconstructs the before-content', () => {
  const oldStr = 'int x = 1;'
  const newStr = 'int x = 42;'
  const before = 'a\nint x = 1;\nb'
  const after = 'a\nint x = 42;\nb'
  const r = computeRows(after, oldStr, newStr, 'edit')
  if (r.before !== before) {
    throw new Error('mismatch: got ' + JSON.stringify(r.before) + ' want ' + JSON.stringify(before))
  }
  const types = r.rows.map((x) => x.type)
  if (!types.includes('mod')) throw new Error('expected a mod row, got ' + types.join(','))
  return true
})

check('locate failure does not fake identical panes', () => {
  const r = computeRows('completely different content', 'gone text', 'text that no longer exists', 'edit')
  if (r.before === 'completely different content') throw new Error('before fell back to text')
  const eq = r.rows.filter((x) => x.type === 'eq').length
  if (eq !== 0) throw new Error('expected 0 eq, got ' + eq)
})

check('real follow-new.c row count matches line count', () => {
  const r = computeRows(disk, '', disk, 'write')
  const lines = disk.split('\n').length
  if (r.rows.length !== lines) throw new Error('rows=' + r.rows.length + ' lines=' + lines)
  console.log('     rows=' + r.rows.length + ' all add, left column empty')
  return true
})

check('insert is not treated as wholesale write', () => {
  const after = 'a\nNEW\nb'
  const r = computeRows(after, '', 'NEW\n', 'insert')
  if (r.before === '') throw new Error('insert should not be treated as wholesale')
})

console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
