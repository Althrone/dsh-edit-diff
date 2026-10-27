import fs from 'node:fs'
import vm from 'node:vm'

// 用真实文件路径模拟本轮的两个新建文件，看 wire view 输出。

const src = fs.readFileSync('dsh-edit-diff/index.js', 'utf8')
const body = src.replace(/^import .*$/gm, '').replace(/^export /gm, '')

const hs = {
  console, Date, JSON, Map, Set, Math, String, Number, Array, Object, Error, setTimeout, Buffer,
  process: { cwd: () => 'D:/Project/cline' },
  statSync: (p) => fs.statSync(p),
  readFileSync: (p, enc) => fs.readFileSync(p, enc),
}
hs.watch = () => ({ on() {}, close() {} })
vm.createContext(hs)
vm.runInContext(body + '\n;globalThis.__h = { definition, beforeByCall };', hs)
const { definition, beforeByCall } = hs.__h

const SID = 'probe'
let s = definition.init({ id: SID })
s = definition.apply(s, { type: 'turn/start', time: Date.now(), data: {} })

const files = [
  ['call-a', 'D:/Project/cline/v131-a.md'],
  ['call-b', 'D:/Project/cline/v131-b.md'],
]

files.forEach(([callId, path], i) => {
  // 模拟 pre-execute：新建文件 resolve 失败 → null 基线
  beforeByCall.set(callId, null)
  s = definition.apply(s, {
    type: 'tool/call', time: Date.now() + i * 10,
    data: { callId, name: 'write', arguments: { file_path: path, content: 'x\n' } },
  })
  s = definition.apply(s, {
    type: 'tool/result', time: Date.now() + i * 10 + 1,
    data: { message: { source: { callId }, isError: false } },
  })
})

console.log('turnFiles 条目数: ' + Object.keys(s.turnFiles ?? {}).length)
for (const k of Object.keys(s.turnFiles ?? {})) {
  const f = s.turnFiles[k]
  console.log('  ' + k)
  console.log('    beforeKnown=' + f.beforeKnown + ' beforeText=' + JSON.stringify(f.beforeText) + ' cmd=' + f.command)
}

const v = definition.wire.view(s)
console.log('\nwire.view files 数量: ' + v.files.length)
for (const f of v.files) console.log('  保留: ' + f.path)
