import fs from 'node:fs'
import vm from 'node:vm'

// 验证左右两栏的联动：
//   - 纵向：逐行镜像 scrollTop
//   - 横向：共享「列位置」，按各自最大可滚动距离截断
// 联动逻辑是模块级函数，这里提取真实实现求值，而不是复制一份测试副本。

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

// 把 factory 整体跑起来拿不到内部函数，所以提取源码片段单独求值。
// 参数里也可能出现 { }（默认值），所以先跳过参数表，再找函数体的左花括号。
function extract(name) {
  const start = src.indexOf('    function ' + name + '(')
  if (start < 0) throw new Error('not found: ' + name)
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
  extract('mirrorScroll') + '\n\n' +
  extract('linkVerticalScroll') + '\n\n' +
  extract('linkHorizontalScroll') +
  '\n;globalThis.__t = { mirrorScroll, linkVerticalScroll, linkHorizontalScroll };',
  sandbox,
)
const { linkVerticalScroll, linkHorizontalScroll } = sandbox.__t

/**
 * 假滚动容器。
 * @param name - 名字，仅用于报错。
 * @param maxLeft - 最大可横向滚动距离（scrollWidth - clientWidth）。
 */
function makeScroller(name, maxLeft = 0) {
  const listeners = new Map()
  return {
    name,
    scrollTop: 0,
    scrollLeft: 0,
    clientWidth: 100,
    clientHeight: 100,
    scrollWidth: 100 + maxLeft,
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

// ── 纵向 ────────────────────────────────────────────────────────────

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
  const unlink = linkVerticalScroll(left, right)
  let calls = 0
  const origEmit = left.emit.bind(left)
  left.emit = (type) => { calls++; if (calls > 50) throw new Error('infinite loop'); origEmit(type) }
  left.scrollTop = 10
  left.emit('scroll')
  unlink()
  if (calls > 2) throw new Error('recursion depth ' + calls)
})

check('纵向仍同步、横向互不干扰地跟着列位置走', () => {
  const left = makeScroller('left', 0)
  const right = makeScroller('right', 0)
  const unlinkV = linkVerticalScroll(left, right)
  const unlinkH = linkHorizontalScroll(left, right)
  left.scrollLeft = 400
  left.scrollTop = 100
  left.emit('scroll')
  unlinkV(); unlinkH()
  // 两栏 max 都是 0，所以横向会被 clamp 回 0；纵向照常同步。
  if (right.scrollLeft !== 0) throw new Error('right.scrollLeft=' + right.scrollLeft + ' should be clamped to 0')
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

// ── 横向（用户指定的三种场景） ──────────────────────────────────────
//
// 短栏 max=50，长栏 max=100。

function pair() {
  const short = makeScroller('short', 50)
  const long = makeScroller('long', 100)
  const unlink = linkHorizontalScroll(short, long)
  return { short, long, unlink }
}

check('拖短栏到底：长栏跟到同一列', () => {
  const { short, long, unlink } = pair()
  short.scrollLeft = 50
  short.emit('scroll')
  unlink()
  if (long.scrollLeft !== 50) throw new Error('long=' + long.scrollLeft + ' expected 50')
})

check('短栏到底后再拖长栏：短栏被钉住，长栏继续右移', () => {
  const { short, long, unlink } = pair()
  short.scrollLeft = 50
  short.emit('scroll')
  long.scrollLeft = 100
  long.emit('scroll')
  unlink()
  if (short.scrollLeft !== 50) throw new Error('short=' + short.scrollLeft + ' should stay pinned at 50')
  if (long.scrollLeft !== 100) throw new Error('long=' + long.scrollLeft + ' should keep 100')
})

check('两栏在最右时左移长栏：短栏钉住，追平后才一起左移', () => {
  const { short, long, unlink } = pair()
  short.scrollLeft = 50
  long.scrollLeft = 100
  long.emit('scroll')
  if (short.scrollLeft !== 50) throw new Error('short moved while long was still ahead: ' + short.scrollLeft)
  long.scrollLeft = 40
  long.emit('scroll')
  unlink()
  if (short.scrollLeft !== 40) throw new Error('short=' + short.scrollLeft + ' expected 40 after catching up')
})

check('两栏在最右时左移短栏：长栏直接跟到短栏的列位置', () => {
  const { short, long, unlink } = pair()
  short.scrollLeft = 50
  long.scrollLeft = 100
  short.scrollLeft = 40
  short.emit('scroll')
  unlink()
  if (long.scrollLeft !== 40) throw new Error('long=' + long.scrollLeft + ' expected 40')
})

check('程序化赋值产生的 scroll 回声被忽略（不会把长栏拉回来）', () => {
  const { short, long, unlink } = pair()
  // 长栏拖到 100 → 短栏被写到 50，并且会触发一次短栏的 scroll 事件（回声）。
  long.scrollLeft = 100
  long.emit('scroll')
  if (short.scrollLeft !== 50) throw new Error('short=' + short.scrollLeft + ' expected 50')
  // 回声：短栏的 scroll 事件，值仍是刚被写进去的 50。
  short.emit('scroll')
  unlink()
  if (long.scrollLeft !== 100) throw new Error('long pulled back to ' + long.scrollLeft + ' (echo not suppressed)')
})

check('横向解绑后不再同步', () => {
  const { short, long, unlink } = pair()
  unlink()
  short.scrollLeft = 30
  short.emit('scroll')
  if (long.scrollLeft !== 0) throw new Error('still syncing after unlink')
  if (short.listenerCount('scroll') !== 0) throw new Error('listener left behind')
})

console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
