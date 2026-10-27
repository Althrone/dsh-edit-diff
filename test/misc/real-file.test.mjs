import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

// 用真实文件 + 真实 oldStr/newStr 验证 diff 的「还原修改前」逻辑。
// client.js 的做法：读当前内容 → indexOf(newStr) → 替换回 oldStr → 得到修改前内容。

const src = fs.readFileSync('dsh-edit-diff/client.js', 'utf8')
const start = src.indexOf('    function diffLines(')
const end = src.indexOf('    function changedSpan(')
const helpers = src.slice(start, end)

const sandbox = { console, Math, Array, String, Number, Object, MAX_DIFF_CELLS: 4_000_000 }
vm.createContext(sandbox)
vm.runInContext(helpers + '\n;globalThis.__d = { diffLines, toSideBySide };', sandbox)
const { diffLines, toSideBySide } = sandbox.__d

let failures = 0
function check(name, fn) {
  try {
    const value = fn()
    if (value === false) throw new Error('returned false')
    console.log('ok   ' + name)
  } catch (error) {
    failures++
    console.log('FAIL ' + name + ': ' + error.message)
  }
}

// 真实字符串：与刚才那次 edit 完全一致
const oldStr = `    const char *words[] = {"alpha", "beta", "alpha", "gamma", "beta", "alpha"};
    size_t n = sizeof(words) / sizeof(words[0]);`
const newStr = `    const char *words[] = {"alpha", "beta", "alpha", "gamma", "beta", "alpha",
                           "delta", "epsilon", "delta", "zeta"};
    size_t n = sizeof(words) / sizeof(words[0]);`

const current = [
  '#include <stdio.h>',
  '#include <stdlib.h>',
  '',
  'int main(void)',
  '{',
  '    const char *words[] = {"alpha", "beta", "alpha", "gamma", "beta", "alpha",',
  '                           "delta", "epsilon", "delta", "zeta"};',
  '    size_t n = sizeof(words) / sizeof(words[0]);',
  '',
  '    for (size_t i = 0; i < n; i++) {',
  '        printf("%s\\n", words[i]);',
  '    }',
  '    return EXIT_SUCCESS;',
  '}',
  '',
].join('\n')

// 用临时文件承载同样的内容，测试不依赖工作区里可能被删掉的文件。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-diff-'))
const file = path.join(dir, 'sample.c')
fs.writeFileSync(file, current)

// 复刻 client 的还原步骤
function reconstructBefore(text, o, n) {
  if (n.length > 0) {
    const idx = text.indexOf(n)
    if (idx >= 0) return text.slice(0, idx) + o + text.slice(idx + n.length)
  }
  return text
}

const before = reconstructBefore(current, oldStr, newStr)

check('newStr 能在当前文件里找到（定位成立）', () => {
  if (current.indexOf(newStr) < 0) throw new Error('newStr not found in current file')
})

check('还原出的 before 确实不含新增词', () => {
  if (before.includes('epsilon')) throw new Error('before still has the newly added words')
  if (!before.includes('gamma')) throw new Error('before is missing original content')
})

check('还原出的 before 行数比当前少 1 行', () => {
  const a = before.split('\n').length
  const b = current.split('\n').length
  if (b - a !== 1) throw new Error(`expected before to be 1 line shorter, got ${a} vs ${b}`)
})

check('diff 恰好标记出 1 删 2 增', () => {
  const ops = diffLines(before, current)
  const dels = ops.filter((o) => o.type === 'del').length
  const adds = ops.filter((o) => o.type === 'add').length
  if (dels !== 1) throw new Error('del count = ' + dels)
  if (adds !== 2) throw new Error('add count = ' + adds)
})

check('并排行对：配对行两侧都有内容，多出的行只在单侧', () => {
  const rows = toSideBySide(diffLines(before, current))
  const changed = rows.filter((r) => r.type !== 'eq')
  if (changed.length !== 2) throw new Error('changed rows = ' + changed.length)
  // 1 删 2 增 → 第一行是 mod（两侧都有），第二行是 add（只有右侧）
  const mods = changed.filter((r) => r.type === 'mod')
  const adds = changed.filter((r) => r.type === 'add')
  const dels = changed.filter((r) => r.type === 'del')
  if (mods.length !== 1) throw new Error('mod rows = ' + mods.length)
  if (adds.length !== 1) throw new Error('add rows = ' + adds.length)
  if (dels.length !== 0) throw new Error('del rows = ' + dels.length)
  if (mods[0].left === undefined || mods[0].right === undefined) {
    throw new Error('mod row must have both sides')
  }
  if (adds[0].right === undefined) throw new Error('add row must have a right side')
  if (adds[0].left !== undefined) throw new Error('add row must leave the left side empty')
})

check('左右行号连续且右侧多于左侧（净增 1 行）', () => {
  const rows = toSideBySide(diffLines(before, current))
  const last = rows[rows.length - 1]
  const beforeLines = before.split('\n').length
  const currentLines = current.split('\n').length
  if (last.leftNo !== beforeLines) throw new Error(`last leftNo ${last.leftNo} != ${beforeLines}`)
  if (last.rightNo !== currentLines) throw new Error(`last rightNo ${last.rightNo} != ${currentLines}`)
})

check('没有触发 LCS 降级（降级会把左右全部标成删/增，含 0 个 eq）', () => {
  const ops = diffLines(before, current)
  const eq = ops.filter((o) => o.type === 'eq').length
  const dels = ops.filter((o) => o.type === 'del').length
  if (eq === 0) throw new Error('LCS fell back: no unchanged lines')
  // 降级时删除数会等于 before 的全部行数
  if (dels === before.split('\n').length) throw new Error('LCS fell back: every line marked deleted')
})

try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
