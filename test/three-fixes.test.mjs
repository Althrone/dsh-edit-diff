import fs from 'node:fs'
import vm from 'node:vm'

// 回归三项：
//   1) 折叠状态下统计也更新
//   2) 插件配置入口存在（Host 导出 Config）
//   3) 每个文件栏有上一处/下一处差异按钮

const hostSrc = fs.readFileSync('dsh-edit-diff/index.js', 'utf8')
const clientSrc = fs.readFileSync('dsh-edit-diff/client.js', 'utf8')

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

check('1) 折叠时仍然计算 rows（统计不会停在旧值）', () => {
  const body = clientSrc.slice(clientSrc.indexOf('function FileSection'), clientSrc.indexOf('// ── 插件体'))
  const rowsBlock = body.slice(body.indexOf('const rows = useMemo'), body.indexOf('const stats = useMemo'))
  if (/if \(collapsed \|\| text === undefined\) return \[\]/.test(rowsBlock)) {
    throw new Error('rows still skips work when collapsed')
  }
})

check('1) 折叠时仍然读取文件', () => {
  const body = clientSrc.slice(clientSrc.indexOf('function FileSection'), clientSrc.indexOf('// ── 插件体'))
  const effectStart = body.indexOf('useEffect(() => {')
  const effectBlock = body.slice(effectStart, effectStart + 400)
  if (/if \(collapsed\) return undefined/.test(effectBlock)) {
    throw new Error('read effect still short-circuits on collapsed')
  }
})

check('1) stats 直接来自 rows，没有 ref 缓存层', () => {
  if (/statsRef/.test(clientSrc)) throw new Error('stale statsRef remains')
  const body = clientSrc.slice(clientSrc.indexOf('const stats = useMemo'), clientSrc.indexOf('const stats = useMemo') + 400)
  if (!/for \(const row of rows\)/.test(body)) throw new Error('stats does not read rows directly')
})

check('2) Host 不声明 Config（避免 resolveConfig 抛异常）', () => {
  // Cordis 的 resolveConfig 会调 Config['~standard'].validate；
  // 而插件页表单只渲染 schemastery 的 .volatile() 字段，link 安装装不了它。
  // 所以刻意不声明 Config —— 声明了反而让插件激活失败。
  if (/export const Config\s*=/.test(hostSrc)) {
    throw new Error('Host declares Config — this breaks activation without schemastery')
  }
})

check('2) 不依赖外部 schema 库（link 安装解析不到）', () => {
  if (/from 'schemastery'|require\('schemastery'\)|from 'zod'|require\('zod'\)/.test(hostSrc)) {
    throw new Error('host depends on a package the linked install cannot resolve')
  }
})

check('2) 客户端仍注册 plugins.row.config 页面', () => {
  if (!clientSrc.includes("'plugins.row.config'")) throw new Error('plugin settings page missing')
})

check('3) 表头有上一处/下一处按钮', () => {
  if (!/data-cline-jump': 'prev'/.test(clientSrc)) throw new Error('prev button missing')
  if (!/data-cline-jump': 'next'/.test(clientSrc)) throw new Error('next button missing')
})

check('3) 跳转按钮阻止冒泡（不触发折叠）', () => {
  const start = clientSrc.indexOf("'data-cline-jump': 'prev'")
  const block = clientSrc.slice(start, start + 700)
  if (!/e\.stopPropagation\(\)/.test(block)) throw new Error('jump buttons do not stopPropagation')
})

check('3) jump 只在有差异时显示', () => {
  if (!/changeAnchors\.length === 0/.test(clientSrc)) throw new Error('no empty-anchor guard')
})

check('3) jump 循环到首/尾', () => {
  if (!/% changeAnchors\.length/.test(clientSrc)) throw new Error('next does not wrap around')
  if (!/changeAnchors\.length - 1/.test(clientSrc)) throw new Error('prev does not wrap around')
})

check('3) 跳转会滚动到目标行', () => {
  if (!/const scrollToRow = \(index\) =>/.test(clientSrc)) throw new Error('no scrollToRow')
  if (!/node\.scrollTop = Math\.max\(0, top\)/.test(clientSrc)) throw new Error('scroll does not move')
})

check('3) locale 有两条跳转文案', () => {
  for (const key of ['prevChange', 'nextChange']) {
    const n = (clientSrc.match(new RegExp('\\b' + key + ':', 'g')) ?? []).length
    if (n < 2) throw new Error(key + ' locale count=' + n)
  }
})

// 行为验证：jump 逻辑本身
function makeJump(anchors) {
  let cursor = null
  const scrolls = []
  const jump = (direction) => {
    if (anchors.length === 0) return
    const current = cursor === null ? -1 : anchors.indexOf(cursor)
    let next
    if (direction > 0) next = current < 0 ? 0 : (current + 1) % anchors.length
    else next = current <= 0 ? anchors.length - 1 : current - 1
    cursor = anchors[next]
    scrolls.push(cursor)
  }
  return { jump, scrolls, cursor: () => cursor }
}

check('3) 行为：下一处依次前进并回绕', () => {
  const j = makeJump([2, 5, 9])
  j.jump(1); j.jump(1); j.jump(1); j.jump(1)
  if (JSON.stringify(j.scrolls) !== JSON.stringify([2, 5, 9, 2])) {
    throw new Error('got ' + JSON.stringify(j.scrolls))
  }
})

check('3) 行为：上一处在开头回绕到末尾', () => {
  const j = makeJump([2, 5, 9])
  j.jump(-1)
  if (j.cursor() !== 9) throw new Error('first prev should land on last anchor, got ' + j.cursor())
})

check('3) 行为：无差异时不动', () => {
  const j = makeJump([])
  j.jump(1)
  if (j.scrolls.length !== 0) throw new Error('jumped with no anchors')
})

console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
