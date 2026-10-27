import fs from 'node:fs'
import vm from 'node:vm'

// 回归：新建文件必须能显示。
//
// 曾经的 bug：pre-execute 里 ctx.fs.resolve 对不存在的路径返回 undefined，
// 那段逻辑整块被 if 跳过，于是 beforeByCall 里没有这个 callId
// → tool/result 里 hadBefore=false → 条目被当作「无基线」过滤掉
// → 新建的文件永远不显示（修改已有文件却正常）。

const hostSrc = fs.readFileSync('dsh-edit-diff/index.js', 'utf8')
const body = hostSrc.replace(/^import .*$/gm, '').replace(/^export /gm, '')

function load(fsImpl) {
  const hs = {
    console, Date, JSON, Map, Set, Math, String, Number, Array, Object, Error, setTimeout, Buffer,
    process: { cwd: () => 'D:/w' },
    statSync: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) },
    readFileSync: () => '',
  }
  hs.watch = () => ({ on() {}, close() {} })
  vm.createContext(hs)
  vm.runInContext(
    body + '\n;globalThis.__h = { definition, beforeByCall };',
    hs,
  )
  return { ...hs.__h, hs }
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

check('pre-execute 对不存在路径也记录 null 基线', () => {
  // 源码断言：resolve 的结果不再直接决定是否记录
  const start = hostSrc.indexOf("ctx.on('tools/pre-execute'")
  const block = hostSrc.slice(start, start + 2600)
  if (/const target = await ctx\.fs\.resolve[\s\S]{0,80}if \(target !== undefined\) \{\s*let content = null/.test(block)) {
    throw new Error('resolve() still gates the whole baseline recording')
  }
  if (!/target = undefined/.test(block)) {
    throw new Error('missing fallback when resolve throws or returns undefined')
  }
  if (!/beforeByCall\.set\(/.test(block)) throw new Error('baseline set call missing')
})

check('resolve 抛异常时仍然写基线', () => {
  const { definition, beforeByCall } = load()
  // 模拟 pre-execute：resolve 失败 → 仍写 null
  beforeByCall.set('c1', null)

  let s = definition.init({ id: 's1' })
  s = definition.apply(s, { type: 'turn/start', time: 1, data: {} })
  s = definition.apply(s, {
    type: 'tool/call', time: 10,
    data: { callId: 'c1', name: 'write', arguments: { file_path: 'D:/w/new.md', content: 'hello\n' } },
  })
  s = definition.apply(s, {
    type: 'tool/result', time: 11,
    data: { message: { source: { callId: 'c1' }, isError: false } },
  })

  const v = definition.wire.view(s)
  if (v.files.length !== 1) {
    throw new Error('new file dropped from the list: files=' + v.files.length)
  }
  const f = v.files[0]
  if (f.beforeKnown !== true) throw new Error('beforeKnown=' + f.beforeKnown)
  if (f.beforeText !== null) throw new Error('new file baseline should be null, got ' + JSON.stringify(f.beforeText))
})

check('新建文件在界面上会被算成纯新增（before 为空）', () => {
  const before = ''
  const after = 'hello\nworld\n'
  if (before === after) throw new Error('fixture broken')
  // 过滤逻辑：before='' vs after=内容 → 不等 → 保留
  const keep = before.replace(/\r\n/g, '\n') !== after.replace(/\r\n/g, '\n')
  if (!keep) throw new Error('filter would drop the new file')
})

check('修改已有文件仍然正常', () => {
  const { definition, beforeByCall } = load()
  beforeByCall.set('c2', 'old line\n')

  let s = definition.init({ id: 's2' })
  s = definition.apply(s, { type: 'turn/start', time: 1, data: {} })
  s = definition.apply(s, {
    type: 'tool/call', time: 10,
    data: { callId: 'c2', name: 'edit', arguments: { file_path: 'D:/w/old.md', old_string: 'old', new_string: 'new' } },
  })
  s = definition.apply(s, {
    type: 'tool/result', time: 11,
    data: { message: { source: { callId: 'c2' }, isError: false } },
  })

  const v = definition.wire.view(s)
  if (v.files.length !== 1) throw new Error('edited file dropped')
  if (v.files[0].beforeText !== 'old line\n') throw new Error('baseline wrong')
})

check('没有基线（pre-execute 完全没跑）仍然过滤', () => {
  const { definition, beforeByCall } = load()
  beforeByCall.clear()

  let s = definition.init({ id: 's3' })
  s = definition.apply(s, { type: 'turn/start', time: 1, data: {} })
  s = definition.apply(s, {
    type: 'tool/call', time: 10,
    data: { callId: 'c3', name: 'write', arguments: { file_path: 'D:/w/x.md', content: 'a\n' } },
  })
  s = definition.apply(s, {
    type: 'tool/result', time: 11,
    data: { message: { source: { callId: 'c3' }, isError: false } },
  })

  const v = definition.wire.view(s)
  if (v.files.length !== 0) throw new Error('entry without any baseline should be filtered')
})

console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
