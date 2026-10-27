import fs from 'node:fs'
import vm from 'node:vm'

// 验证高亮器的实际分词结果。直接调用真实实现，不复制逻辑。

const src = fs.readFileSync('dsh-edit-diff/client.js', 'utf8')

function extract(name) {
  const start = src.indexOf('    function ' + name + '(')
  if (start < 0) throw new Error('not found: ' + name)
  const parenOpen = src.indexOf('(', start)
  let parens = 0
  let index = parenOpen
  for (; index < src.length; index++) {
    if (src[index] === '(') parens++
    else if (src[index] === ')') { parens--; if (parens === 0) break }
  }
  const bodyOpen = src.indexOf('{', index)
  let depth = 0
  for (index = bodyOpen; index < src.length; index++) {
    if (src[index] === '{') depth++
    else if (src[index] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(start, index + 1)
}

// 抓 LANGS 常量
const langsStart = src.indexOf('    const LANGS = {')
let depth = 0
let langsEnd = src.indexOf('{', langsStart)
for (let i = langsEnd; i < src.length; i++) {
  if (src[i] === '{') depth++
  else if (src[i] === '}') { depth--; if (depth === 0) { langsEnd = i + 1; break } }
}
const langsSrc = src.slice(langsStart, langsEnd)

const sandbox = { console, RegExp }
vm.createContext(sandbox)
vm.runInContext(
  langsSrc + '\n\n' +
  extract('tokenizeLine') + '\n\n' +
  extract('tokenColor') + '\n\n' +
  extract('languageOf') +
  '\n;globalThis.__t = { LANGS, tokenizeLine, tokenColor, languageOf };',
  sandbox,
)
const { tokenizeLine, languageOf } = sandbox.__t

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

function kinds(line, lang) {
  return tokenizeLine(line, lang).filter((p) => p.kind !== null).map((p) => p.kind + ':' + p.text)
}

check('语言识别', () => {
  const map = { 'a.c': 'c', 'b.h': 'c', 'c.cpp': 'c', 'd.ts': 'js', 'e.js': 'js', 'f.py': 'py', 'g.rs': 'rust', 'h.sh': 'sh', 'i.json': 'json', 'j.md': null, 'k.txt': null }
  for (const [path, want] of Object.entries(map)) {
    const got = languageOf(path)
    if (got !== want) throw new Error(path + ' → ' + got + ', want ' + want)
  }
})

check('C: 预处理器 #include 被识别', () => {
  const k = kinds('#include <stdio.h>', 'c')
  if (!k.some((x) => x.startsWith('preproc:'))) throw new Error(JSON.stringify(k))
})

check('C: 关键字与类型区分', () => {
  const k = kinds('int main(void)', 'c')
  if (!k.includes('type:int')) throw new Error('no type:int → ' + JSON.stringify(k))
  if (!k.includes('type:void')) throw new Error('no type:void → ' + JSON.stringify(k))
})

check('C: 控制流关键字', () => {
  const k = kinds('for (size_t i = 0; i < n; i++) {', 'c')
  if (!k.includes('keyword:for')) throw new Error(JSON.stringify(k))
})

check('C: 字符串不误判关键字', () => {
  const k = kinds('printf("if for while");', 'c')
  const inString = k.filter((x) => x.startsWith('keyword:'))
  if (inString.length > 0) throw new Error('keywords inside string: ' + JSON.stringify(inString))
  if (!k.some((x) => x.startsWith('string:'))) throw new Error('no string token')
})

check('C: 行注释整段', () => {
  const k = kinds('int x = 1; // if return', 'c')
  if (!k.some((x) => x.startsWith('comment:'))) throw new Error(JSON.stringify(k))
})

check('C: 块注释', () => {
  const k = kinds('/* int x */ return 0;', 'c')
  if (!k.some((x) => x.startsWith('comment:'))) throw new Error(JSON.stringify(k))
})

check('C: 数字含十六进制', () => {
  const k = kinds('x = 0xFF + 42;', 'c')
  if (!k.includes('number:0xFF')) throw new Error(JSON.stringify(k))
  if (!k.includes('number:42')) throw new Error(JSON.stringify(k))
})

check('JS: 字符串模板与关键字', () => {
  const k = kinds('const s = `hi ${name}`;', 'js')
  if (!k.includes('keyword:const')) throw new Error(JSON.stringify(k))
  if (!k.some((x) => x.startsWith('string:'))) throw new Error(JSON.stringify(k))
})

check('PY: # 注释', () => {
  const k = kinds('def f(x):  # comment', 'py')
  if (!k.includes('keyword:def')) throw new Error(JSON.stringify(k))
  if (!k.some((x) => x.startsWith('comment:'))) throw new Error(JSON.stringify(k))
})

check('未知语言原样返回', () => {
  const parts = tokenizeLine('hello if world', null)
  if (parts.length !== 1 || parts[0].kind !== null) throw new Error(JSON.stringify(parts))
})

check('分词能无损还原原行（关键：不能丢字符）', () => {
  const lines = [
    '#include <stdio.h>',
    'int main(void) { return 0; }',
    '    printf("%-6s -> %d\\n", "alpha", count);',
    'if (a == "b") { /* c */ x = 0x1F; }',
    'def f(x): return x  # note',
    '',
    '   ',
  ]
  for (const line of lines) {
    for (const lang of ['c', 'js', 'py', 'rust', 'sh', 'json']) {
      const parts = tokenizeLine(line, lang)
      const joined = parts.map((p) => p.text).join('')
      if (joined !== line) {
        throw new Error('[' + lang + '] ' + JSON.stringify(line) + '\n  got ' + JSON.stringify(joined))
      }
    }
  }
})

check('空行不报错', () => {
  const parts = tokenizeLine('', 'c')
  if (parts.map((p) => p.text).join('') !== '') throw new Error('empty line broken')
})

check('C: 函数声明与调用着色', () => {
  const declared = kinds('int main(void)', 'c')
  if (!declared.includes('call:main')) throw new Error('main not marked as call → ' + JSON.stringify(declared))

  const called = kinds('printf("%d", x);', 'c')
  if (!called.includes('call:printf')) throw new Error('printf not marked as call → ' + JSON.stringify(called))

  const spaced = kinds('table_free (buckets);', 'c')
  if (!spaced.includes('call:table_free')) throw new Error('call with space before ( missed')
})

check('C: 关键字不会被误判成函数名', () => {
  for (const line of ['if (x) {', 'for (i = 0;', 'while (1) {', 'sizeof(int)', 'switch (c) {']) {
    const k = kinds(line, 'c')
    const calls = k.filter((x) => x.startsWith('call:'))
    if (calls.length > 0) throw new Error(JSON.stringify(line) + ' → ' + JSON.stringify(calls))
  }
})

check('JS: 函数名着色', () => {
  const k = kinds('function foo() { return bar(1); }', 'js')
  if (!k.includes('call:foo')) throw new Error('foo missing → ' + JSON.stringify(k))
  if (!k.includes('call:bar')) throw new Error('bar missing → ' + JSON.stringify(k))
  if (k.includes('call:function')) throw new Error('`function` keyword was marked as a call')
})

check('字符串里的函数名不被着色', () => {
  const k = kinds('puts("call_me()");', 'c')
  if (k.includes('call:call_me')) throw new Error('function name inside a string was coloured')
  if (!k.includes('call:puts')) throw new Error('puts should still be a call')
})

check('Rust: fn 名与宏调用', () => {
  const k = kinds('fn main() { println!("hi"); }', 'rust')
  if (!k.includes('call:main')) throw new Error('main missing → ' + JSON.stringify(k))
  if (!k.includes('call:println')) throw new Error('println! not matched as call')
})

// 跨行块注释：注释里的 `word (` 不能被当成函数调用。
check('跨行块注释内的词不着色', () => {
  // 第 1 行开注释未闭合，第 2 行整行都在注释内
  const first = tokenizeLine('/**', 'c', false)
  if (first.inBlock !== true) throw new Error('unclosed /* did not enter block state')

  const inside = tokenizeLine(' * see bucket (chain) here', 'c', true)
  const leaked = inside.filter((p) => p.kind === 'call')
  if (leaked.length > 0) throw new Error('comment word coloured as call: ' + JSON.stringify(leaked.map((p) => p.text)))
  if (!inside.some((p) => p.kind === 'comment')) throw new Error('comment line not marked as comment')

  // 闭合行之后恢复
  const closing = tokenizeLine(' */', 'c', true)
  if (closing.inBlock !== false) throw new Error('*/ did not leave block state')
  const after = tokenizeLine('int main(void)', 'c', false)
  if (!kinds('int main(void)', 'c').includes('call:main')) throw new Error('state corrupted after block')
})

check('单行块注释仍然有效', () => {
  const parts = tokenizeLine('/* note */ printf("x");', 'c', false)
  if (parts.inBlock === true) throw new Error('closed block comment left state open')
  const calls = parts.filter((p) => p.kind === 'call').map((p) => p.text)
  if (!calls.includes('printf')) throw new Error('code after closed comment lost highlighting')
})

console.log('\n样例（C 语言）:')
for (const line of ['#include <stdio.h>', 'int main(void)', '    for (size_t i = 0; i < n; i++) {', '        printf("%-6s -> %d\\n", words[i], count);', '    return EXIT_SUCCESS;  // done']) {
  const parts = tokenizeLine(line, 'c')
  console.log('  ' + JSON.stringify(parts.map((p) => (p.kind === null ? p.text : '[' + p.kind + ':' + p.text + ']'))))
}

console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
