import fs from 'node:fs'

// 回归：FileSection 里任何 Hook 都不能出现在提前 return 之后。
// 之前的 bug：折叠时 return 跳过了两个 useMemo，React 抛错导致整块消失。

const src = fs.readFileSync('dsh-edit-diff/client.js', 'utf8')

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

// 抽出 FileSection 函数体
const start = src.indexOf('function FileSection(props)')
const endMarker = src.indexOf('// ── 插件体')
const body = src.slice(start, endMarker)
const lines = body.split('\n')

/** 找出所有 Hook 调用的行号（0-based）。 */
const hookLines = []
const hookRe = /\b(useState|useMemo|useEffect|useRef|useCallback|useContext)\s*\(/
lines.forEach((l, i) => {
  if (hookRe.test(l) && !l.trim().startsWith('//') && !l.trim().startsWith('*')) {
    hookLines.push({ line: i, text: l.trim().slice(0, 60) })
  }
})

/** 找出组件函数体的顶层提前 return（缩进 6 格 = 组件体内一层）。
 *  必须排除 useEffect 回调里的 return（那些在更深的缩进里，或者紧跟 useEffect）。 */
const earlyReturns = []
let insideUseEffect = 0
lines.forEach((l, i) => {
  const t = l.trim()
  // 追踪是否在 useEffect 回调里（用大括号深度粗略判断）
  if (/^useEffect\(\(\) => \{$/.test(t)) insideUseEffect = 1
  else if (insideUseEffect > 0) {
    // 数一行里的 { 和 }
    const opens = (l.match(/\{/g) ?? []).length
    const closes = (l.match(/\}/g) ?? []).length
    insideUseEffect += opens - closes
    if (insideUseEffect < 0) insideUseEffect = 0
    return
  }
  // 顶层 return：缩进正好 6 个空格
  if (/^ {6}if \(.*\) return /.test(l)) {
    earlyReturns.push({ line: i, text: t.slice(0, 60) })
  }
})

check('FileSection 里没有 Hook 出现在提前 return 之后', () => {
  if (earlyReturns.length === 0) {
    console.log('     （没有提前 return，本检查自动通过）')
    return true
  }
  const firstReturn = earlyReturns[0].line
  const after = hookLines.filter((h) => h.line > firstReturn)
  if (after.length > 0) {
    throw new Error(
      '这些 Hook 在提前 return 之后，会在折叠时被跳过：\n' +
      after.map((h) => '  line ' + h.line + ': ' + h.text).join('\n'),
    )
  }
  console.log('     ' + hookLines.length + ' 个 Hook 全部在第一个 return (line ' + firstReturn + ') 之前')
  return true
})

check('Hooks 调用数量前后一致（折叠与展开相同）', () => {
  // 只要没有条件调用 Hook 就算通过；这里检查 Hook 是否被包在 if 里
  let conditional = 0
  lines.forEach((l, i) => {
    const t = l.trim()
    if (!hookRe.test(l)) return
    // 往回看 2 行，若出现 if/else 起始且没有闭合，可能是条件调用
    for (let k = Math.max(0, i - 2); k < i; k++) {
      if (/^\s*if \(.+\) \{\s*$/.test(lines[k]) || /^\s*\} else \{\s*$/.test(lines[k])) {
        conditional++
        break
      }
    }
  })
  if (conditional > 0) throw new Error(conditional + ' 处 Hook 可能在条件块里')
  return true
})

check('折叠分支仍返回表头', () => {
  const collapsedReturn = lines.find((l) => l.includes('if (collapsed) return h('))
  if (collapsedReturn === undefined) {
    throw new Error('no collapsed branch that renders something')
  }
  if (!/header/.test(collapsedReturn)) {
    throw new Error('collapsed branch does not render header: ' + collapsedReturn.trim())
  }
})

check('header 定义在折叠分支之前', () => {
  const headerIdx = lines.findIndex((l) => l.includes('const header = h('))
  const retIdx = lines.findIndex((l) => l.includes('if (collapsed) return h('))
  if (headerIdx < 0) throw new Error('header not defined')
  if (retIdx < 0) throw new Error('no collapsed return')
  if (headerIdx > retIdx) throw new Error('header defined after the collapsed return')
})

console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
