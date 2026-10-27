import fs from 'node:fs'

// 回归：调试信息绝不能写进 notice。
//
// 曾经 bug：debug 模式下把 'rows=1593 text=55018 ...' 拼进 notice，
// 而 notice 非 null 会替换整个 diff 正文 —— 1593 行正常内容被一行诊断顶掉，
// 界面看起来就是「表头在，正文全没了」。

const src = fs.readFileSync('dsh-edit-diff/client.js', 'utf8')

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

const fileBody = src.slice(src.indexOf('function FileSection'), src.indexOf('// ── 插件体'))

check('debug 信息不再赋值给 notice', () => {
  if (/notice = \(notice === null \? '' : notice \+ ' · '\) \+ info/.test(fileBody)) {
    throw new Error('debug string is still assigned to notice')
  }
  // 找 notice 的所有赋值点，确认没有 'rows=' 拼接
  const noticeAssigns = fileBody.match(/notice\s*=[^;\n]*/g) ?? []
  for (const a of noticeAssigns) {
    if (/rows=/.test(a)) throw new Error('notice gets the debug string: ' + a.slice(0, 80))
  }
})

check('调试信息走独立的 debugLine', () => {
  if (!/const debugLine = debug/.test(fileBody)) throw new Error('no debugLine variable')
  if (!/rows=' \+ rows\.length/.test(fileBody)) throw new Error('debugLine lacks row count')
})

check('debugLine 渲染在 header 与 body 之间，不替换 body', () => {
  if (!/debugLine === null\s*\n\s*\? null/.test(fileBody)) {
    throw new Error('debugLine is not rendered conditionally')
  }
  // 返回结构应是 header, debugLine?, body 三者并列
  const ret = fileBody.slice(fileBody.lastIndexOf('return h('))
  if (!/header,/.test(ret)) throw new Error('return does not start with header')
  if (!/body,?\s*\)/.test(ret)) throw new Error('return does not include body')
})

check('notice 为 null 时 body 走 diff 分支（不被诊断污染）', () => {
  if (!/const body = notice !== null/.test(fileBody)) {
    throw new Error('body still branches on notice')
  }
  // notice 只由真实状态决定
  const noticeBlock = fileBody.slice(fileBody.indexOf('let notice = null'), fileBody.indexOf('// 调试信息单独渲染'))
  if (/debug/.test(noticeBlock)) {
    // 唯一允许的 debug 用法是 shell 分支的文案选择，且不能改变 null/非 null
    const m = noticeBlock.match(/debug[^\n]*/g) ?? []
    for (const line of m) {
      if (/notice = /.test(line) && !/beforeKnown \? null :/.test(line)) {
        throw new Error('debug changes whether notice is null: ' + line.slice(0, 80))
      }
    }
  }
})

check('调试行不与正文抢空间', () => {
  if (!/wordBreak: 'break-all'/.test(fileBody)) throw new Error('debug line may overflow instead of wrapping')
  const dl = fileBody.slice(fileBody.indexOf('debugLine === null'))
  if (!/flex: 'none'/.test(dl.slice(0, 600))) {
    throw new Error('debug line is not flex:none — it may squeeze the body')
  }
})

check('正文高度由内容撑开（不再用 1fr 撑 0 高度）', () => {
  const bodyBlock = fileBody.slice(fileBody.indexOf('const body = notice !== null'))
  if (/gridTemplateRows: 'minmax\(0,1fr\)'/.test(bodyBlock)) {
    throw new Error('body still uses minmax(0,1fr) under a flex:none parent')
  }
})

console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
