import fs from 'node:fs'
import vm from 'node:vm'

// 回归：两个用户反馈的问题
//   1) 临时文件（.p.txt / .shell-probe-N.c）不该出现在改动列表
//   2) 无法对比的条目不该渲染成「空的展开栏」

const hostSrc = fs.readFileSync('dsh-edit-diff/index.js', 'utf8')
const clientSrc = fs.readFileSync('dsh-edit-diff/client.js', 'utf8')

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
  body + '\n;globalThis.__h = { definition, beforeByCall, isScratchPath };',
  hs,
)
const { definition, beforeByCall, isScratchPath } = hs.__h

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

check('临时文件名被识别', () => {
  const scratch = [
    'D:/Project/cline/.p.txt',
    'D:/Project/cline/.probe.txt',
    'D:/Project/cline/.shell-probe-1.c',
    'D:/Project/cline/.sc-3.c',
    'D:/Project/cline/.mt-a.md',
  ]
  for (const p of scratch) {
    if (!isScratchPath(p)) throw new Error('not filtered: ' + p)
  }
})

check('正常文件名不被误伤', () => {
  const normal = [
    'D:/Project/cline/index.js',
    'D:/Project/cline/src/client.js',
    'D:/Project/cline/README.md',
    'D:/Project/cline/a.b/c.js',
  ]
  for (const p of normal) {
    if (isScratchPath(p)) throw new Error('wrongly filtered: ' + p)
  }
})

/** 构造一条 turnFiles 记录并取 wire view。 */
function viewWith(entries) {
  const SID = 's1'
  let s = definition.init({ id: SID })
  s = definition.apply(s, { type: 'turn/start', time: 1, data: {} })
  // 直接注入 turnFiles（模拟投影已累积的状态）
  s = { ...s, turnFiles: entries }
  return definition.wire.view(s)
}

check('临时文件不进 wire view', () => {
  const v = viewWith({
    'D:/w/.p.txt': { path: 'D:/w/.p.txt', tool: 'shell', command: 'shell', line: null, oldStr: '', newStr: '', ts: 1, beforeKnown: false },
    'D:/w/.shell-probe-1.c': { path: 'D:/w/.shell-probe-1.c', tool: 'shell', command: 'shell', line: null, oldStr: '', newStr: '', ts: 2, beforeKnown: false },
    'D:/w/real.js': { path: 'D:/w/real.js', tool: 'edit', command: 'edit', line: 1, oldStr: 'a', newStr: 'b', ts: 3, beforeKnown: true, beforeText: 'a\n' },
  })
  const paths = v.files.map((f) => f.path)
  if (paths.some((p) => p.startsWith('D:/w/.'))) {
    throw new Error('scratch leaked: ' + JSON.stringify(paths))
  }
  if (!paths.includes('D:/w/real.js')) throw new Error('real file missing')
})

check('无基线且无 afterText 的条目被剔除（避免空栏）', () => {
  const v = viewWith({
    'D:/w/orphan.js': { path: 'D:/w/orphan.js', tool: 'shell', command: 'shell', line: null, oldStr: '', newStr: '', ts: 1, beforeKnown: false },
  })
  if (v.files.length !== 0) {
    throw new Error('unusable entry kept: ' + JSON.stringify(v.files.map((f) => f.path)))
  }
})

check('无基线的条目一律不列出（哪怕有 afterText）', () => {
  const v = viewWith({
    'D:/w/shell.js': { path: 'D:/w/shell.js', tool: 'shell', command: 'shell', line: null, oldStr: '', newStr: '', ts: 1, beforeKnown: false, afterText: 'NEW\n' },
  })
  if (v.files.length !== 0) {
    throw new Error('entry without baseline still listed: ' + JSON.stringify(v.files.map((f) => f.path)))
  }
})

check('内容相同的条目不列出（无 +0 −0）', () => {
  const v = viewWith({
    'D:/w/same.js': { path: 'D:/w/same.js', tool: 'edit', command: 'edit', line: 1, oldStr: 'a', newStr: 'a', ts: 1, beforeKnown: true, beforeText: 'X\n', afterText: 'X\n' },
  })
  if (v.files.length !== 0) throw new Error('no-op entry kept')
})

check('内容变化的条目列出', () => {
  const v = viewWith({
    'D:/w/changed.js': { path: 'D:/w/changed.js', tool: 'edit', command: 'edit', line: 1, oldStr: 'a', newStr: 'b', ts: 1, beforeKnown: true, beforeText: 'X\n', afterText: 'Y\n' },
  })
  if (v.files.length !== 1) throw new Error('changed entry dropped')
})

check('客户端：无基线时给中性提示而不是空白', () => {
  // 源码断言：notice 的 shell 分支必须有非 debug 的兜底文案
  const fnBody = clientSrc.slice(clientSrc.indexOf('function FileSection'), clientSrc.indexOf('// ── 插件体'))
  if (!/tr\('noBaseline'\)/.test(fnBody)) throw new Error('no neutral notice for missing baseline')
})

check('客户端：最后一道空内容保险存在', () => {
  if (!/notice = tr\('noChanges'\)/.test(clientSrc)) {
    throw new Error('no last-resort notice when rows are empty')
  }
})

check('locale 提供两条新文案（中英各一）', () => {
  for (const key of ['noBaseline', 'noChanges']) {
    const n = (clientSrc.match(new RegExp('\\b' + key + ':', 'g')) ?? []).length
    if (n < 2) throw new Error(key + ' locale count=' + n)
  }
})

check('设置注册在插件详情页而非通用设置', () => {
  if (!clientSrc.includes("'plugins.row.config'")) throw new Error('plugin config page missing')
  if (clientSrc.includes("'settings.general.item'")) throw new Error('general settings polluted')
})

console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
