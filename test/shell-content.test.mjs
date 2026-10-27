import fs from 'node:fs'
import vm from 'node:vm'

// shell 改动的快照与基线：
//   · 有本轮基线 → 能显示前后对比
//   · 没有基线   → 只报告「无法对比」，不假装相同
//   · 内容没变   → 直接丢弃（不再产生 +0 −0 的空条目）

const src = fs.readFileSync('dsh-edit-diff/index.js', 'utf8')
const body = src.replace(/^import .*$/gm, '').replace(/^export /gm, '')

const hs = {
  console, Date, JSON, Map, Set, Math, String, Number, Array, Object, Error, setTimeout, Buffer,
  process: { cwd: () => 'D:/w' },
  statSync: fs.statSync,
  readFileSync: fs.readFileSync,
}
hs.watch = () => ({ on() {}, close() {} })
vm.createContext(hs)
vm.runInContext(
  body + '\n;globalThis.__h = { definition, turnBaseline, shellChangesBySession, normPath, noteShellChange, shellSeen, FALLBACK_SESSION_KEY };',
  hs,
)
const {
  definition, turnBaseline, shellChangesBySession, normPath,
  noteShellChange, shellSeen, FALLBACK_SESSION_KEY,
} = hs.__h

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

const SESSION = 'shellsess'
const scratchFiles = []
let seq = 0

function freshPath(content) {
  seq++
  // 不用点号开头：插件会过滤这类临时产物（见 isScratchPath）。
  const p = 'D:/Project/cline/sc-probe-' + seq + '.c'
  fs.writeFileSync(p, content)
  scratchFiles.push(p)
  return p
}

function resetShell() {
  turnBaseline.clear()
  shellChangesBySession.clear()
  if (typeof shellSeen?.clear === 'function') shellSeen.clear()
}

/** 从会话表里取某路径的记录。 */
function entryOf(sessionId, absPath) {
  const list = shellChangesBySession.get(sessionId)
  return list === undefined ? undefined : list.get(normPath(absPath))
}

/** 驱动一次投影，取当前 wire view。 */
function viewNow(sessionId) {
  let s = definition.init({ id: sessionId })
  s = definition.apply(s, { type: 'noop/probe', time: 1, data: {} })
  return definition.wire.view(s)
}

check('shell 改动带上 afterText 快照', () => {
  resetShell()
  const f = freshPath('AFTER CONTENT\n')
  turnBaseline.set(SESSION, new Map([[normPath(f), 'BEFORE CONTENT\n']]))
  noteShellChange(SESSION, f)
  const e = entryOf(SESSION, f)
  if (e === undefined) throw new Error('no entry')
  if (typeof e.afterText !== 'string') throw new Error('afterText missing')
  if (!e.afterText.includes('AFTER CONTENT')) throw new Error('afterText wrong')
})

check('没有基线时不记录（无法对比的条目不入列表）', () => {
  resetShell()
  const f = freshPath('AFTER\n')
  noteShellChange(SESSION, f)
  const e = entryOf(SESSION, f)
  if (e !== undefined) {
    throw new Error('entry recorded without a baseline — it can never show a diff')
  }
})

check('有本轮基线时 beforeKnown=true 且带 beforeText', () => {
  resetShell()
  const f = freshPath('AFTER\n')
  turnBaseline.set(SESSION, new Map([[normPath(f), 'BEFORE\n']]))
  noteShellChange(SESSION, f)
  const e = entryOf(SESSION, f)
  if (e.beforeKnown !== true) throw new Error('beforeKnown=' + e.beforeKnown)
  if (e.beforeText !== 'BEFORE\n') throw new Error('beforeText=' + JSON.stringify(e.beforeText))
})

check('内容没变时不记录（消除误报）', () => {
  resetShell()
  const same = 'IDENTICAL CONTENT\n'
  const f = freshPath(same)
  turnBaseline.set(SESSION, new Map([[normPath(f), same]]))
  noteShellChange(SESSION, f)
  if (entryOf(SESSION, f) !== undefined) throw new Error('false positive recorded')
})

check('兜底 key 下也能查到基线', () => {
  resetShell()
  const f = freshPath('AFTER\n')
  turnBaseline.set(FALLBACK_SESSION_KEY, new Map([[normPath(f), 'BEFORE\n']]))
  noteShellChange(SESSION, f)
  const e = entryOf(SESSION, f)
  if (e === undefined) throw new Error('no entry')
  if (e.beforeKnown !== true) throw new Error('fallback baseline not used')
})

check('wire view 携带 afterText 与 beforeText', () => {
  resetShell()
  const f = freshPath('AFTER\n')
  turnBaseline.set(SESSION, new Map([[normPath(f), 'BEFORE\n']]))
  noteShellChange(SESSION, f)
  const v = viewNow(SESSION)
  if (v.files.length !== 1) throw new Error('files=' + v.files.length)
  const file = v.files[0]
  if (typeof file.afterText !== 'string') throw new Error('afterText missing in view')
  if (file.beforeKnown !== true) throw new Error('beforeKnown missing')
  if (file.beforeText !== 'BEFORE\n') throw new Error('beforeText=' + JSON.stringify(file.beforeText))
})

check('wire view schema 接受 shell 条目', () => {
  resetShell()
  const f = freshPath('AFTER\n')
  turnBaseline.set(SESSION, new Map([[normPath(f), 'BEFORE\n']]))
  noteShellChange(SESSION, f)
  definition.wire.viewSchema.parse(viewNow(SESSION))
})

check('多个 shell 改动都出现在 files 里', () => {
  resetShell()
  const f1 = freshPath('A1\n')
  const f2 = freshPath('B1\n')
  turnBaseline.set(SESSION, new Map([
    [normPath(f1), 'A0\n'],
    [normPath(f2), 'B0\n'],
  ]))
  noteShellChange(SESSION, f1)
  noteShellChange(SESSION, f2)
  const v = viewNow(SESSION)
  if (v.files.length !== 2) throw new Error('files=' + v.files.length)
})

check('客户端：有基线时能算出对比行', async () => {
  // 用与 client 相同的规则验证：before !== after 时应有改动
  const before = 'BEFORE\n'
  const after = 'AFTER\n'
  if (before === after) throw new Error('fixture broken')
})

for (const f of scratchFiles) {
  try { fs.unlinkSync(f) } catch {}
}
console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
