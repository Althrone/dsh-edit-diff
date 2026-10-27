import fs from 'node:fs'

const p = 'D:/Software/Ai/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js'
const s = fs.readFileSync(p, 'utf8')
const out = []

const turn = s.match(/turn\/[a-z-]+/g) ?? []
out.push('turn events: ' + [...new Set(turn)].join(', '))

const step = s.match(/step\/[a-z-]+/g) ?? []
out.push('step events: ' + [...new Set(step)].join(', '))

// 找 KNOWN event type 列表附近的定义
const idx = s.indexOf('"turn/end"')
if (idx >= 0) {
  out.push('\n--- around "turn/end" ---')
  out.push(s.slice(Math.max(0, idx - 600), idx + 600))
}

fs.writeFileSync('D:/Project/cline/.probe.txt', out.join('\n'), 'utf8')
