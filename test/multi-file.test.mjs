import fs from 'node:fs'
import vm from 'node:vm'

// 验证两个修复：
//   1) 一轮内改多个文件 → wire view 的 files 全部列出
//   2) 内容没变的改动 → 不出现在 files 里（不再显示 +0 −0）

const src = fs.readFileSync('dsh-edit-diff/index.js', 'utf8')
const body = src.replace(/^import .*$/gm, '').replace(/^export /gm, '')

const sandbox = {
  console, Date, JSON, Map, Set, Math, String, Number, Array, Object, Error, setTimeout, Buffer,
  process: { cwd: () => 'D:/w' },
  statSync: fs.statSync,
  readFileSync: fs.readFileSync,
}
sandbox.watch = () => ({ on() {}, close() {} })
vm.createContext(sandbox)
vm.runInContext(
  body + '\n;globalThis.__t = { definition, beforeByCall, noteShellChange, shellChangesBySession, turnBaseline, normPath };',
  sandbox,
)
const { definition, beforeByCall, noteShellChange, shellChangesBySession, turnBaseline, normPath } = sandbox.__t

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

const SID = 'sx'
const scratch = []

function writeFile(name, content) {
  // 不用点号开头：插件会过滤这类临时产物（见 isScratchPath）。
  const p = 'D:/Project/cline/mt-' + name
  fs.writeFileSync(p, content)
  scratch.push(p)
  return p
}

function edit(state, callId, path, preEdit, newStr = 'CHANGED') {
  beforeByCall.set(callId, preEdit)
  let s = definition.apply(state, {
    type: 'tool/call', time: Date.now(),
    data: { callId, name: 'edit', arguments: { file_path: path, old_string: 'x', new_string: newStr } },
  })
  s = definition.apply(s, {
    type: 'tool/result', time: Date.now() + 1,
    data: { message: { source: { callId }, isError: false } },
  })
  return s
}

check('一轮改三个文件：files 全部列出', () => {
  beforeByCall.clear()
  let s = definition.init({ id: SID })
  s = edit(s, 'c1', 'a.md', 'OLD-A', 'NEW-A')
  s = edit(s, 'c2', 'b.md', 'OLD-B', 'NEW-B')
  s = edit(s, 'c3', 'c.md', 'OLD-C', 'NEW-C')
  const v = definition.wire.view(s)
  if (v.files.length !== 3) throw new Error('files=' + v.files.length)
  const paths = v.files.map((f) => f.path).sort()
  if (!paths.includes('a.md') || !paths.includes('b.md') || !paths.includes('c.md')) {
    throw new Error('missing paths: ' + JSON.stringify(paths))
  }
})

check('同一文件多次编辑只占一个条目', () => {
  beforeByCall.clear()
  let s = definition.init({ id: SID })
  s = edit(s, 'c1', 'a.md', 'OLD', 'NEW1')
  s = edit(s, 'c2', 'a.md', 'OLD', 'NEW2')
  s = edit(s, 'c3', 'a.md', 'OLD', 'NEW3')
  const v = definition.wire.view(s)
  if (v.files.length !== 1) throw new Error('files=' + v.files.length)
})

check('内容没变的编辑不出现在 files 里', () => {
  beforeByCall.clear()
  let s = definition.init({ id: SID })
  // 编辑前后内容相同 → 应被过滤
  s = edit(s, 'c1', 'same.md', 'SAME CONTENT', 'SAME CONTENT')
  const v = definition.wire.view(s)
  if (v.files.length !== 0) {
    throw new Error('unchanged file leaked: ' + JSON.stringify(v.files.map((f) => f.path)))
  }
})

check('有变化的文件仍然出现', () => {
  beforeByCall.clear()
  let s = definition.init({ id: SID })
  s = edit(s, 'c1', 'changed.md', 'OLD', 'NEW')
  const v = definition.wire.view(s)
  if (v.files.length !== 1) throw new Error('changed file missing')
})

check('混合：变化的留下，没变的过滤掉', () => {
  beforeByCall.clear()
  let s = definition.init({ id: SID })
  s = edit(s, 'c1', 'a.md', 'OLD-A', 'NEW-A')
  s = edit(s, 'c2', 'b.md', 'SAME', 'SAME')
  s = edit(s, 'c3', 'c.md', 'OLD-C', 'NEW-C')
  const v = definition.wire.view(s)
  if (v.files.length !== 2) throw new Error('files=' + v.files.length + ' ' + JSON.stringify(v.files.map((f) => f.path)))
})

check('CRLF 差异不算内容变化', () => {
  beforeByCall.clear()
  let s = definition.init({ id: SID })
  s = edit(s, 'c1', 'crlf.md', 'a\nb\n', 'a\r\nb\r\n')
  const v = definition.wire.view(s)
  if (v.files.length !== 0) throw new Error('CRLF-only change leaked')
})

check('新建文件（基线 null）保留', () => {
  beforeByCall.clear()
  let s = definition.init({ id: SID })
  s = edit(s, 'c1', 'new.md', null, 'CONTENT')
  const v = definition.wire.view(s)
  if (v.files.length !== 1) throw new Error('new file filtered out')
  if (v.files[0].beforeText !== null) throw new Error('baseline lost')
})

check('shell 改动也进 files（内容真变了）', () => {
  beforeByCall.clear()
  shellChangesBySession.clear()
  turnBaseline.clear()
  const f = writeFile('shell1.md', 'CONTENT AFTER\n')
  turnBaseline.set(FALLBACK_SESSION_KEY_OR('(default)'), new Map([[normPath(f), 'CONTENT BEFORE\n']]))
  noteShellChange('(default)', f)
  let s = definition.init({ id: '(default)' })
  s = definition.apply(s, { type: 'animation/frame', time: 1, data: {} })
  const v = definition.wire.view(s)
  if (v.files.length !== 1) throw new Error('shell change missing: ' + v.files.length)
})

check('shell 误报（内容没变）被丢弃', () => {
  beforeByCall.clear()
  shellChangesBySession.clear()
  turnBaseline.clear()
  const content = 'IDENTICAL\n'
  const f = writeFile('shell2.md', content)
  turnBaseline.set('(default)', new Map([[normPath(f), content]]))
  noteShellChange('(default)', f)
  const list = shellChangesBySession.get('(default)')
  if (list !== undefined && list.size > 0) {
    throw new Error('false positive recorded: ' + JSON.stringify([...list.keys()]))
  }
})

check('turn/start 清空 files 与 shell 表', () => {
  beforeByCall.clear()
  shellChangesBySession.clear()
  let s = definition.init({ id: SID })
  s = edit(s, 'c1', 'a.md', 'OLD', 'NEW')
  if (definition.wire.view(s).files.length === 0) throw new Error('precondition failed')
  s = definition.apply(s, { type: 'turn/start', time: 99, data: {} })
  if (definition.wire.view(s).files.length !== 0) throw new Error('files not cleared on turn/start')
})

check('wire view schema 接受新结构', () => {
  beforeByCall.clear()
  let s = definition.init({ id: SID })
  s = edit(s, 'c1', 'a.md', 'OLD', 'NEW')
  definition.wire.viewSchema.parse(definition.wire.view(s))
})

check('view 结构是 { last, files }', () => {
  beforeByCall.clear()
  let s = definition.init({ id: SID })
  s = edit(s, 'c1', 'a.md', 'OLD', 'NEW')
  const v = definition.wire.view(s)
  if (!('last' in v) || !('files' in v)) throw new Error('shape: ' + Object.keys(v).join(','))
})

function FALLBACK_SESSION_KEY_OR(fb) {
  return fb
}

for (const f of scratch) {
  try { fs.unlinkSync(f) } catch {}
}
console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
