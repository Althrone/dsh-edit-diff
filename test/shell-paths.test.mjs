import fs from 'node:fs'
import vm from 'node:vm'

// 验证 shell 命令的路径解析：命令文本里能提取出哪些被写入的文件。

const src = fs.readFileSync('dsh-edit-diff/index.js', 'utf8')
const body = src.replace(/^import .*$/gm, '').replace(/^export /gm, '')

const sandbox = {
  console, Date, JSON, Map, Set, Math, String, Number, Array, Object, Error, setTimeout, Buffer,
  process: { cwd: () => 'C:/work' },
  statSync: () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }) },
  readFileSync: () => '',
}
sandbox.watch = () => ({ on() {}, close() {} })
vm.createContext(sandbox)
vm.runInContext(body + '\n;globalThis.__t = { extractCommandPaths, looksLikePath };', sandbox)
const { extractCommandPaths, looksLikePath } = sandbox.__t

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

function paths(cmd, workdir = 'D:/Project/cline') {
  return extractCommandPaths(cmd, workdir)
}

check('重定向写入', () => {
  const got = paths('echo hello > src/app.ts')
  if (!got.includes('D:/Project/cline/src/app.ts')) throw new Error(JSON.stringify(got))
})

check('PowerShell 追加', () => {
  const got = paths('Add-Content -Path notes.md -Value "x"')
  if (!got.includes('D:/Project/cline/notes.md')) throw new Error(JSON.stringify(got))
})

check('Set-Content', () => {
  const got = paths('Set-Content -Path config.json -Value "{}"')
  if (!got.includes('D:/Project/cline/config.json')) throw new Error(JSON.stringify(got))
})

check('python 脚本改文件', () => {
  const got = paths('python fix.py --target data.csv')
  if (!got.includes('D:/Project/cline/fix.py')) throw new Error('script itself: ' + JSON.stringify(got))
  if (!got.includes('D:/Project/cline/data.csv')) throw new Error('target: ' + JSON.stringify(got))
})

check('多条命令串联', () => {
  const got = paths('cp a.c b.c; sed -i s/x/y/ b.c')
  if (!got.includes('D:/Project/cline/a.c')) throw new Error('a.c missing: ' + JSON.stringify(got))
  if (!got.includes('D:/Project/cline/b.c')) throw new Error('b.c missing: ' + JSON.stringify(got))
})

check('绝对路径保留', () => {
  const got = paths('cat D:\\other\\file.md')
  if (!got.includes('D:/other/file.md')) throw new Error(JSON.stringify(got))
})

check('忽略 URL', () => {
  const got = paths('curl https://example.com/api.json -o out.json')
  if (got.some((p) => p.includes('example.com'))) throw new Error('URL leaked: ' + JSON.stringify(got))
  if (!got.includes('D:/Project/cline/out.json')) throw new Error('out.json missing: ' + JSON.stringify(got))
})

check('忽略开关参数', () => {
  const got = paths('npm run build --production')
  if (got.length !== 0) throw new Error('flags leaked: ' + JSON.stringify(got))
})

check('忽略非文本后缀', () => {
  const got = paths('gcc -o app.exe main.c')
  if (got.some((p) => p.endsWith('.exe'))) throw new Error('binary leaked: ' + JSON.stringify(got))
  if (!got.some((p) => p.endsWith('main.c'))) throw new Error('main.c missing')
})

check('忽略纯单词（无扩展名无分隔符）', () => {
  const got = paths('git status')
  if (got.length !== 0) throw new Error(JSON.stringify(got))
})

check('去重', () => {
  const got = paths('touch a.ts && echo x >> a.ts')
  const count = got.filter((p) => p.endsWith('a.ts')).length
  if (count !== 1) throw new Error('duplicated: ' + count)
})

check('多个文件', () => {
  const got = paths('python gen.py --out result.json --log run.log')
  const want = ['gen.py', 'result.json', 'run.log']
  for (const w of want) {
    if (!got.some((p) => p.endsWith(w))) throw new Error(w + ' missing: ' + JSON.stringify(got))
  }
})

check('上限保护', () => {
  const many = Array.from({ length: 100 }, (_, i) => 'f' + i + '.ts').join(' ')
  const got = extractCommandPaths('touch ' + many, 'D:/w')
  if (got.length > 32) throw new Error('no cap: ' + got.length)
})

check('空命令安全', () => {
  if (extractCommandPaths('', 'D:/w').length !== 0) throw new Error('empty cmd produced paths')
  if (extractCommandPaths('ls', '').length !== 0) throw new Error('empty workdir produced paths')
})

check('looksLikePath 判定', () => {
  const yes = ['a.ts', 'src/b.js', 'D:/x/y.md', './z.py', 'data.csv']
  const no = ['true', '--flag', 'https://x/y.json', 'abcdef']
  for (const y of yes) if (!looksLikePath(y)) throw new Error('should match: ' + y)
  for (const n of no) if (looksLikePath(n)) throw new Error('should not match: ' + n)
})

console.log('\n样例：')
for (const cmd of [
  'echo hi > src/app.ts',
  'Add-Content -Path notes.md -Value "x"',
  'python fix.py --target data.csv',
]) {
  console.log('  ' + cmd)
  console.log('    -> ' + JSON.stringify(paths(cmd)))
}

console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
