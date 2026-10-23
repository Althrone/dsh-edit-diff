import fs from 'node:fs'
import vm from 'node:vm'

// 验证左右两栏的纵向联动。
// 联动逻辑是模块级函数 linkVerticalScroll，这里直接调用真实实现，
// 而不是复制一份到测试里自我验证。

const src = fs.readFileSync('dsh-edit-diff/client.js', 'utf8')

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

// 把 factory 整体跑起来，从返回值里拿不到内部函数，
// 所以用「提取源码片段」的方式单独求值这两个函数。
// 参数里也可能出现 { }（默认值），所以从「行尾第一个 : 函数体起点」开始找左花括号。
function extract(name) {
  const start = src.indexOf('    function ' + name + '(')
  if (start < 0) throw new Error('not found: ' + name)
  // 先跳过参数表，再找函数体的左花括号。
  const parenOpen = src.indexOf('(', start)
  let parens = 0
  let index = parenOpen
  for (; index < src.length; index++) {
    if (src[index] === '(') parens++
    else if (src[index] === ')') {
      parens--
      if (parens === 0) break
    }
  }
  const bodyOpen = src.indexOf('{', index)
  let depth = 0
  for (index = bodyOpen; index < src.length; index++) {
    if (src[index] === '{') depth++
    else if (src[index] === '}') {
      depth--
      if (depth === 0) break
    }
  }
  return src.slice(start, index + 1)
}

const sandbox = { console }
vm.createContext(sandbox)
vm.runInContext(
  extract('mirrorScroll') + '\n\n' + extract('linkVerticalScroll') +
  '\n;globalThis.__t = { mirrorScroll, linkVerticalScroll };',
  sandbox,
)
const { linkVerticalScroll } = sandbox.__t

function makeScroller(name) {
  const listeners = new Map()
  return {
    name,
    scrollTop: 0,
    scrollLeft: 0,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn)
    },
    emit(type) {
      for (const fn of listeners.get(type) ?? []) fn()
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0
    },
  }
}

check('滚左栏 → 右栏跟随', () => {
  const left = makeScroller('left')
  const right = makeScroller('right')
  const unlink = linkVerticalScroll(left, right)
  left.scrollTop = 250
  left.emit('scroll')
  unlink()
  if (right.scrollTop !== 250) throw new Error('right=' + right.scrollTop + ' expected 250')
})

check('滚右栏 → 左栏跟随', () => {
  const left = makeScroller('left')
  const right = makeScroller('right')
  const unlink = linkVerticalScroll(left, right)
  right.scrollTop = 80
  right.emit('scroll')
  unlink()
  if (left.scrollTop !== 80) throw new Error('left=' + left.scrollTop + ' expected 80')
})

check('不产生无限递归（guard 生效）', () => {
  const left = makeScroller('left')
  const right = makeScroller('right')
  // 让两侧的 scroll 监听互相触发：没有 guard 会栈溢出。
  const unlink = linkVerticalScroll(left, right)
  let calls = 0
  const origEmit = left.emit.bind(left)
  left.emit = (type) => { calls++; if (calls > 50) throw new Error('infinite loop'); origEmit(type) }
  left.scrollTop = 10
  left.emit('scroll')
  unlink()
  if (calls > 2) throw new Error('recursion depth ' + calls)
})

check('横向 scrollLeft 不被同步（两栏水平独立）', () => {
  const left = makeScroller('left')
  const right = makeScroller('right')
  const unlink = linkVerticalScroll(left, right)
  left.scrollLeft = 400
  left.scrollTop = 100
  left.emit('scroll')
  unlink()
  if (right.scrollLeft !== 0) throw new Error('right.scrollLeft=' + right.scrollLeft + ' should stay 0')
  if (right.scrollTop !== 100) throw new Error('vertical did not sync')
})

check('两侧各挂一个 scroll 监听', () => {
  const left = makeScroller('left')
  const right = makeScroller('right')
  const unlink = linkVerticalScroll(left, right)
  const l = left.listenerCount('scroll')
  const r = right.listenerCount('scroll')
  unlink()
  if (l !== 1) throw new Error('left listeners=' + l)
  if (r !== 1) throw new Error('right listeners=' + r)
})

check('解绑后不再同步', () => {
  const left = makeScroller('left')
  const right = makeScroller('right')
  const unlink = linkVerticalScroll(left, right)
  unlink()
  if (left.listenerCount('scroll') !== 0) throw new Error('left listener left behind')
  if (right.listenerCount('scroll') !== 0) throw new Error('right listener left behind')
  left.scrollTop = 300
  left.emit('scroll')
  if (right.scrollTop !== 0) throw new Error('still syncing after unlink')
})

console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
