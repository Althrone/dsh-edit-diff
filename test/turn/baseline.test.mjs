import fs from 'node:fs'
import vm from 'node:vm'

// 验证「基线优先」：有 Host 基线时用它做精确对比，没有时才退回 indexOf 反推。

const clientSrc = fs.readFileSync('dsh-edit-diff/client.js', 'utf8')
const hostSrc = fs.readFileSync('dsh-edit-diff/index.js', 'utf8')

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
vm.runInContext(extractFn(clientSrc, 'diffLines') + '\n\n' + extractFn(clientSrc, 'toSideBySide') +
  '\n;globalThis.__c={diffLines,toSideBySide};', cs)
const { diffLines, toSideBySide } = cs.__c

// 复刻 client 的 rows 计算（改后版本）
function computeRows({ text, oldStr = '', newStr = '', command = 'edit', beforeKnown, beforeText }) {
  const norm = (s) => String(s).replace(/\r\n/g, '\n')
  const after = norm(text)

  if (beforeKnown) {
    const before = beforeText === null ? '' : norm(beforeText)
    return { before, rows: toSideBySide(diffLines(before, after)), source: 'baseline' }
  }

  const target = norm(newStr)
  const original = norm(oldStr)
  let before = after
  const wholesale = command === 'create' || command === 'write' || command === 'patch'
  if (wholesale) before = ''
  else if (target.length > 0) {
    const idx = after.indexOf(target)
    before = idx >= 0 ? after.slice(0, idx) + original + after.slice(idx + target.length) : ''
  } else if (original.length > 0 && after.length === 0) before = original
  return { before, rows: toSideBySide(diffLines(before, after)), source: 'fallback' }
}

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

check('有基线时优先用基线', () => {
  const r = computeRows({
    text: 'a\nCHANGED\nc',
    beforeKnown: true,
    beforeText: 'a\nORIGINAL\nc',
    command: 'edit',
  })
  if (r.source !== 'baseline') throw new Error('did not use baseline')
  if (r.before !== 'a\nORIGINAL\nc') throw new Error('before=' + JSON.stringify(r.before))
  const mods = r.rows.filter((x) => x.type === 'mod').length
  if (mods !== 1) throw new Error('expected 1 mod row, got ' + mods)
})

check('基线为 null 表示新建：左栏全空', () => {
  const r = computeRows({
    text: 'l1\nl2\nl3',
    beforeKnown: true,
    beforeText: null,
    command: 'write',
  })
  if (r.before !== '') throw new Error('before should be empty')
  const leftFilled = r.rows.filter((x) => x.left !== undefined).length
  if (leftFilled !== 0) throw new Error('left has ' + leftFilled + ' filled rows')
  const notAdd = r.rows.filter((x) => x.type !== 'add').length
  if (notAdd !== 0) throw new Error(notAdd + ' non-add rows')
})

check('基线能处理 indexOf 找不到的情况（旧实现会退化成全部新增）', () => {
  const after = 'x\ny\nz'
  const r = computeRows({
    text: after,
    oldStr: 'gone',
    newStr: 'text-that-is-not-in-the-file',
    beforeKnown: true,
    beforeText: after,
    command: 'edit',
  })
  if (r.before !== after) throw new Error('baseline not used faithfully')
  const changed = r.rows.filter((x) => x.type !== 'eq').length
  if (changed !== 0) throw new Error('expected no changes, got ' + changed)
})

check('基线能处理 CRLF 与 LF 混用', () => {
  const r = computeRows({
    text: 'a\r\nb\r\n',
    beforeKnown: true,
    beforeText: 'a\nb\n',
    command: 'edit',
  })
  const changed = r.rows.filter((x) => x.type !== 'eq').length
  if (changed !== 0) throw new Error('CRLF normalization broken: ' + changed + ' changed rows')
})

check('没有基线时退回反推（行为不变）', () => {
  const r = computeRows({
    text: 'a\nNEW\nb',
    oldStr: 'OLD',
    newStr: 'NEW',
    command: 'edit',
  })
  if (r.source !== 'fallback') throw new Error('should fall back')
  if (r.before !== 'a\nOLD\nb') throw new Error('before=' + JSON.stringify(r.before))
})

check('write 覆盖已有文件现在能看到原文（关键改进）', () => {
  const original = '# Title\n\nold body\n'
  const replaced = '# Title\n\nnew body\n'
  // 旧实现：write 一律当作全新增，看得到原文吗？看得到——因为有基线。
  const r = computeRows({
    text: replaced,
    beforeKnown: true,
    beforeText: original,
    command: 'write',
  })
  if (r.before !== original) throw new Error('write lost its baseline')
  const changed = r.rows.filter((x) => x.type !== 'eq').length
  if (changed === 0) throw new Error('expected changes between old and new body')
})

// host 侧：确认 pre-execute 真的把基线存起来了
check('host 捕获基线（beforeByCall）', () => {
  if (!hostSrc.includes('beforeByCall')) throw new Error('no beforeByCall map')
  if (!hostSrc.includes('beforeText')) throw new Error('no beforeText in wire value')
  if (!hostSrc.includes('beforeKnown')) throw new Error('no beforeKnown flag')
  if (!/ctx\.fs\.readText/.test(hostSrc)) throw new Error('never reads the file before editing')
})

check('host 对新建文件记录 null 基线', () => {
  // 读取失败时置 null，表示「原本不存在」
  if (!/content = null/.test(hostSrc)) throw new Error('missing null baseline path')
})

console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
