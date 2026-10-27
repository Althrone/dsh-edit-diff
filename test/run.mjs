#!/usr/bin/env node
// 测试总入口：递归发现 test/**/*.test.mjs，逐个在子进程里跑完，汇总结果。
//
// 为什么要改 cwd：这些用例读的是 'dsh-edit-diff/client.js'、'dsh-edit-diff/index.js'
// （历史约定，相对「仓库的父目录」）。直接在仓库根跑会 ENOENT，所以这里统一
// 把子进程的 cwd 设成 dsh-edit-diff 的父目录。
//
// 为什么用 stdio: 'inherit'：沙箱里子进程的管道 stdout 会被拒（EPERM），
// 直接继承父进程的 stdio 最稳，输出顺序也和执行顺序一致。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.dirname(HERE)
const CWD = path.dirname(REPO)

function discover(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) discover(full, out)
    else if (entry.name.endsWith('.test.mjs')) out.push(full)
  }
  return out
}

// 可选过滤：`node test/run.mjs diff` 只跑路径里含 "diff" 的套件（主题目录名或文件名片段）。
const filter = process.argv[2]
const rel = (file) => path.relative(REPO, file).replace(/\\/g, '/')
const all = discover(HERE).sort()
const cases = filter === undefined ? all : all.filter((file) => rel(file).includes(filter))
if (cases.length === 0) {
  console.error(filter === undefined ? 'no *.test.mjs found under test/' : 'no suite matched: ' + filter)
  process.exit(1)
}

const failed = []
for (const file of cases) {
  const started = Date.now()
  const result = spawnSync(process.execPath, [file], { cwd: CWD, stdio: 'inherit' })
  const ms = Date.now() - started
  if (result.status !== 0) {
    failed.push(rel(file))
    console.error(`\n✗ ${rel(file)}  (exit ${result.status}, ${ms}ms)\n`)
  }
}

const passed = cases.length - failed.length
console.log(`${passed}/${cases.length} suites passed`)
if (failed.length > 0) {
  console.error('failed:')
  for (const rel of failed) console.error('  - ' + rel)
}
process.exit(failed.length === 0 ? 0 : 1)
