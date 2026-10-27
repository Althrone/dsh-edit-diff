import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 验证 shell 监听路径对「删除」的处理：fs.watch 的 rename 事件 + 扩展名过滤。
// 这是 noteShellChange 的真实前提。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-watch-'))
const file = path.join(dir, 'probe.c')
fs.writeFileSync(file, 'int main(void){return 0;}\n')

const SHELL_IGNORE = /(^|\/)(node_modules|\.git|dist|lib|build|out|__pycache__|\.dsh)(\/|$)/
const SHELL_TEXT_EXT = new Set(['c', 'h', 'ts', 'md', 'py', 'js'])

const events = []
const watcher = fs.watch(dir, { recursive: true, persistent: false }, (eventType, filename) => {
  if (typeof filename !== 'string' || filename.length === 0) return
  const rel = String(filename).replace(/\\/g, '/')
  const ignored = SHELL_IGNORE.test('/' + rel)
  const dot = rel.lastIndexOf('.')
  const ext = dot < 0 ? '' : rel.slice(dot + 1).toLowerCase()
  const accepted = !ignored && SHELL_TEXT_EXT.has(ext) && rel.length > 0
  events.push({ eventType, rel, ext, accepted })
})

await new Promise((r) => setTimeout(r, 300))
fs.unlinkSync(file)
await new Promise((r) => setTimeout(r, 600))
watcher.close()

let failures = 0
function check(name, fn) {
  try {
    if (fn() === false) throw new Error('returned false')
    console.log('ok   ' + name)
  } catch (error) {
    failures++
    console.log('FAIL ' + name + ': ' + error.message)
  }
}

console.log('raw events: ' + JSON.stringify(events))

check('删除产生了至少一个事件', () => {
  if (events.length === 0) throw new Error('no events captured for a delete')
})

check('事件带上了文件名（否则无法定位是哪个文件）', () => {
  if (!events.some((e) => typeof e.rel === 'string' && e.rel.length > 0)) {
    throw new Error('filename was empty')
  }
})

check('删除的文件通过了扩展名过滤', () => {
  const hit = events.find((e) => e.rel.includes('probe.c'))
  if (hit === undefined) throw new Error('probe.c never appeared in events')
  if (!hit.accepted) throw new Error('probe.c was filtered out')
})

check('忽略规则仍然生效（node_modules 下的不算）', () => {
  const ignored = SHELL_IGNORE.test('/node_modules/x/index.js')
  if (!ignored) throw new Error('node_modules not ignored')
})

check('非文本后缀被拒绝', () => {
  const dot = 'a.exe'.lastIndexOf('.')
  const ext = 'a.exe'.slice(dot + 1).toLowerCase()
  if (SHELL_TEXT_EXT.has(ext)) throw new Error('exe should not be watched')
})

try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
