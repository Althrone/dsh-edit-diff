import fs from 'node:fs'

// 诊断：把 dsh-edit-diff 的 index.js 临时换成带日志的版本，
// 但不动运行中的实例 —— 只是静态分析可能的失败点。

const src = fs.readFileSync('dsh-edit-diff/index.js', 'utf8')
const out = []

// 1) sessionIdOfAgent 的候选顺序
const fnStart = src.indexOf('function sessionIdOfAgent(')
out.push('=== sessionIdOfAgent ===')
out.push(src.slice(fnStart, fnStart + 700))

// 2) pre-execute 里写 turnBaseline 的条件
const tb = src.indexOf('turnBaseline.get(sid)')
out.push('\n=== turnBaseline write site ===')
out.push(src.slice(Math.max(0, tb - 700), tb + 400))

// 3) tool/result 里读 turnBaseline
const tr = src.indexOf('const byPath = turnBaseline.get(state.sessionId)')
out.push('\n=== turnBaseline read site (tool/result) ===')
out.push(src.slice(Math.max(0, tr - 500), tr + 500))

fs.writeFileSync('D:/Project/cline/.probe.txt', out.join('\n'), 'utf8')
