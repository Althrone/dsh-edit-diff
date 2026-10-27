/**
 * dsh-edit-diff —— host 半。
 *
 * 与 dsh-follow-edits 的关键差别：**不注册任何 documentPreviews 渲染器**。
 * 旧插件用一个纯文本渲染器在所有文本扩展名上以 priority:'extension' 顶替了内置的
 * 代码/Markdown 渲染器，于是语法高亮和 md 渲染全没了。这里只做「记录改动」，
 * 由 client 半用原生预览 + 独立 diff 标签来展示。
 *
 * 记录两条来源：
 *
 * A) 编辑工具：折叠 `tool/call` + `tool/result`，得到 { path, tool, command, oldStr, newStr }。
 *    被删内容编辑后就不在文件里了，所以在 `tools/pre-execute`（改之前）读旧文件，
 *    用 indexOf(oldStr) 定位起始行存进 lineByCall，`tool/result` 时合并。
 *
 * B) shell 写入：子进程绕过 ctx.fs，没有 tool 事件，改用 fs.watch 盯会话工作区根。
 *
 * 投影通过 wire.view 自动推给 client（第三方投影按 key 出现，无需白名单）。
 */
import { watch as fsWatch, statSync, readFileSync } from 'node:fs'

export const name = 'dsh-edit-diff'
export const inject = ['sessionProjections', 'fs']

/**
 * 没有 Config —— 这是有意的。
 *
 * Cordis 的 resolveConfig 会调用 `runtime.Config["~standard"].validate(config)`；
 * 而插件页的配置表单只渲染 Config 里带 `.volatile()` 的字段，那是
 * @deepseek-ai/schemastery 的 API。
 *
 * 本插件是 link: 安装，目录解析不到 profile 的 node_modules，
 * 既装不了 schemastery，手写 `~standard` 也拿不到 `.volatile()` 元数据
 * （表单会是空的）。之前尝试声明 Config 直接让插件激活失败：
 *   Cannot read properties of undefined (reading 'validate')
 *
 * 所以配置项改由客户端 localStorage + 插件自己的配置页承载。
 */

const EDIT_TOOLS = new Set(['str_replace_editor', 'write', 'edit', 'apply_patch', 'multi_edit'])

/** callId → 编辑前 oldStr 的 1-based 起始行。只服务实时路径，读一次即删。 */
const lineByCall = new Map()
const MAX_PENDING_LINES = 256

/**
 * callId → 编辑前的完整文件内容（或 null 表示文件原本不存在）。
 *
 * 为什么要在编辑前读整份内容：客户端目前靠 `indexOf(newStr)` 反推「修改前」，
 * 一旦行尾符或内容有细微差异就找不回位置，只能退化成「全部新增」。
 * 在 pre-execute 真实读一次，就得到准确的基线（Coding Tools 也是这么做的）。
 */
const beforeByCall = new Map()
const MAX_PENDING_BEFORE = 64
/** 单份基线的大小上限；超过就放弃精确对比，避免占满内存。 */
const MAX_BEFORE_BYTES = 2 * 1024 * 1024

/**
 * callId → 编辑【后】的完整文件内容。
 *
 * 为什么也要在 Host 侧捕获：客户端本来靠读磁盘拿「修改后」，但插件自己的源文件
 * （index.js / client.js）在被监视时可能读不到，界面上就只剩一个空栏。
 * 与其依赖客户端能读成功，不如在编辑刚结束时读一次存下来。
 */
const afterByCall = new Map()

/**
 * sessionId → (path → 本轮首次编辑前的完整内容)。
 *
 * 一个文件在同一轮里常被连续编辑多次。每次都用「上一次的中间态」当基线，
 * 用户看到的就是碎片；用「本轮最初的样子」才是一次完整对比 ——
 * 这也是「会话停止前持续对比原始文件」的基础。
 * null 表示本轮第一次见到它时文件还不存在（新建）。
 */
const turnBaseline = new Map()
const MAX_BASELINE_PATHS = 256

/** sessionId → 最近一次 shell 改动 { path, ts, afterText?, beforeText? }。 */
const shellBySession = new Map()
/**
 * sessionId → (规范路径 → 改动记录)。
 *
 * 一轮里可能改多个文件，只保留「最后一个」会让前面的消失，
 * 所以按会话存一张表，投影里一次把这些改动全推给客户端。
 */
const shellChangesBySession = new Map()
/** 一个会话最多保留多少条 shell 改动记录。 */
const MAX_SHELL_CHANGES = 64
const shellWatchers = new Map()
const shellSeen = new Map()
const SHELL_DEDUPE_MS = 200
const MAX_SHELL_SEEN = 512
/** 一条命令最多快照多少个候选路径。 */
const MAX_SHELL_PATH_CANDIDATES = 32
/** 会被当作「可能写文件」的 shell 工具名。 */
const SHELL_TOOLS = new Set(['pwsh', 'bash', 'shell', 'terminal', 'exec', 'run'])
/**
 * 取不到会话 id 时用的兜底 key。
 * shell 基线只有一张表，单会话场景下与真实 id 等价；
 * 总比因为拿不到 id 就完全不做快照要好。
 */
const FALLBACK_SESSION_KEY = '(default)'

const SHELL_IGNORE =
  /(^|\/)(node_modules|\.git|\.pnpm-store|dist|lib|build|out|__pycache__|\.dsh|\.venv|venv)(\/|$)/
const SHELL_TEXT_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'swift', 'scala', 'r', 'jl', 'dart', 'lua',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'sql', 'pl', 'ex', 'exs', 'erl', 'hs',
  'clj', 'cljs', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'astro',
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'xml', 'svg',
  'md', 'markdown', 'mdx', 'txt', 'text', 'log', 'csv', 'tsv', 'env',
  'graphql', 'gql', 'proto', 'prisma',
])

function normPath(p) {
  return String(p).replace(/\\/g, '/')
}

// ── shell 命令的写入目标解析 ─────────────────────────────────────────
//
// shell 命令执行前无法知道它到底会改哪些文件，但命令文本里通常写着路径。
// 这里做启发式提取：找出命令里出现的、看起来像文件路径的 token，
// 然后在 pre-execute 阶段把这些文件先快照下来。宁可多快照几个无关文件，
// 也不要漏掉真正被改的文件 —— 多快照只是多读几次，漏掉就再也补不回来了。

/** 出现在命令文本里、但不是写入目标的常见参数值。 */
const SHELL_ARG_NOISE = new Set([
  'true', 'false', 'null', 'none', 'utf8', 'utf-8', 'ascii', 'json', 'text',
  'list', 'view', 'edit', 'create', 'insert', 'delete', 'force', 'quiet',
  'verbose', 'error', 'stdout', 'stderr', 'pipe', 'inherit', 'ignore',
])

/** 粗略判断一个 token 是否像文件路径。 */
function looksLikePath(token) {
  if (typeof token !== 'string') return false
  const t = token.replace(/^['"]|['"]$/g, '').trim()
  if (t.length === 0 || t.length > 512) return false
  if (SHELL_ARG_NOISE.has(t.toLowerCase())) return false
  // 选项/开关
  if (/^[-/]/.test(t) && !/^\/[A-Za-z0-9_.-]+\//.test(t)) return false
  // URL
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false
  // 必须有点号扩展名，或者是带目录分隔符的相对/绝对路径
  const hasExt = /\.[A-Za-z0-9]{1,12}$/.test(t)
  const hasSep = /[\\/]/.test(t)
  if (!hasExt && !hasSep) return false
  // 扩展名必须是已知的文本类型，避免快照二进制
  const dot = t.lastIndexOf('.')
  if (dot >= 0) {
    const ext = t.slice(dot + 1).toLowerCase()
    if (!SHELL_TEXT_EXT.has(ext)) return false
  }
  return true
}

/**
 * 从一段 shell 命令里提取可能被写入的文件路径。
 *
 * 只做保守的启发式：按空白和常见分隔符切开，取像路径的 token。
 * 不做 shell 语法解析 —— 那需要真正的解析器，代价远大于收益。
 *
 * @param command - 命令文本。
 * @param workdir - 命令的工作目录，用于把相对路径转成绝对路径。
 * @returns 去重后的绝对路径候选。
 */
function extractCommandPaths(command, workdir) {
  if (typeof command !== 'string' || command.length === 0) return []
  if (typeof workdir !== 'string' || workdir.length === 0) return []

  const base = normPath(workdir).replace(/\/+$/, '')
  // 按空白、分号、管道、重定向、括号等切开
  const tokens = command.split(/[\s;|&<>()\[\]{},=+]+/)
  const out = []
  const seen = new Set()

  for (const raw of tokens) {
    if (!looksLikePath(raw)) continue
    let t = raw.replace(/^['"]|['"]$/g, '').trim()
    // 去掉行尾标点
    t = t.replace(/[.;,]+$/, '')
    if (t.length === 0) continue

    const normalized = normPath(t)
    let abs
    if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith('/')) {
      abs = normalized
    } else {
      abs = base + '/' + normalized.replace(/^(?:\.\/)+/, '')
    }
    if (seen.has(abs)) continue
    seen.add(abs)
    out.push(abs)
    if (out.length >= MAX_SHELL_PATH_CANDIDATES) break
  }
  return out
}

/**
 * 从 Agent 对象上取会话 id。
 *
 * tools/pre-execute 的 exec 没有 sessionId，只有 agent。Agent 是 Cordis 的
 * Proxy 对象：访问一个没有 inject 过的东西会**直接抛异常**
 * （`cannot get property "session" without inject`），而不是返回 undefined。
 * 所以这里必须逐个读、逐个 try ——
 * 用 `[a.id, a.session?.id]` 这种数组字面量会让所有候选立刻求值，
 * 一个越界访问就整轮失败。
 */
function sessionIdOfAgent(agent) {
  if (agent === undefined || agent === null) return ''

  const read = (fn) => {
    try {
      const v = fn()
      return typeof v === 'string' && v.length > 0 ? v : ''
    } catch {
      return ''
    }
  }

  return (
    read(() => agent.id) ||
    read(() => agent.sessionId) ||
    read(() => agent.session?.id) ||
    read(() => agent.session?.header?.id) ||
    ''
  )
}

function parseArgs(raw) {
  if (typeof raw === 'object' && raw !== null) return raw
  if (typeof raw !== 'string') return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * 从一次工具调用里提取编辑信息。
 * @returns {{ path, tool, command, line, oldStr, newStr } | null}
 */
function editFromCall(data) {
  if (typeof data?.name !== 'string' || !EDIT_TOOLS.has(data.name)) return null
  const args = parseArgs(data.arguments)
  if (args === null || typeof args !== 'object') return null

  const path = args.path ?? args.file_path
  if (typeof path !== 'string' || path.length === 0) return null

  const tool = data.name

  if (tool === 'str_replace_editor') {
    switch (args.command) {
      case 'view':
        return null
      case 'create':
        return { path, tool, command: 'create', line: 1, oldStr: '', newStr: String(args.file_text ?? '') }
      case 'insert': {
        const n = typeof args.insert_line === 'number' && Number.isInteger(args.insert_line) ? args.insert_line : 0
        return { path, tool, command: 'insert', line: n + 1, oldStr: '', newStr: String(args.new_str ?? '') }
      }
      case 'str_replace':
        return {
          path, tool, command: 'str_replace', line: null,
          oldStr: String(args.old_str ?? ''), newStr: String(args.new_str ?? ''),
        }
      default:
        return null
    }
  }

  if (tool === 'write') {
    return { path, tool, command: 'write', line: 1, oldStr: '', newStr: String(args.content ?? '') }
  }
  if (tool === 'edit') {
    const edits = Array.isArray(args.edits) ? args.edits : null
    if (edits !== null && edits.length > 0) {
      return {
        path, tool, command: 'edit', line: null,
        oldStr: edits.map((e) => String(e?.old_string ?? '')).join('\n'),
        newStr: edits.map((e) => String(e?.new_string ?? '')).join('\n'),
      }
    }
    return {
      path, tool, command: 'edit', line: null,
      oldStr: String(args.old_string ?? ''), newStr: String(args.new_string ?? ''),
    }
  }
  if (tool === 'multi_edit') {
    const edits = Array.isArray(args.edits) ? args.edits : []
    return {
      path, tool, command: 'edit', line: null,
      oldStr: edits.map((e) => String(e?.old_string ?? '')).join('\n'),
      newStr: edits.map((e) => String(e?.new_string ?? '')).join('\n'),
    }
  }
  if (tool === 'apply_patch') {
    return { path, tool, command: 'patch', line: null, oldStr: '', newStr: String(args.patch ?? args.input ?? '') }
  }
  return null
}

function noteShellChange(sessionId, absolutePath) {
  const now = Date.now()
  const previous = shellSeen.get(absolutePath)
  if (previous !== undefined && now - previous < SHELL_DEDUPE_MS) return

  // 快照「改动后」的内容。探针验证过：fs.watch 回调触发时文件已经是新内容。
  let afterText = null
  try {
    const stat = statSync(absolutePath)
    if (stat.isFile() && stat.size <= MAX_BEFORE_BYTES) {
      afterText = readFileSync(absolutePath, 'utf8')
      if (Buffer.byteLength(afterText, 'utf8') > MAX_BEFORE_BYTES) afterText = null
    }
  } catch {
    afterText = null
  }

  // 基线可能记在会话 id 下（pre-execute 能取到 agent 时），
  // 也可能记在兜底 key 下（取不到时）。两个都查，避免因 key 不同而丢基线。
  const lookup = (key) => {
    const byPath = turnBaseline.get(key)
    return byPath === undefined ? undefined : byPath.get(normPath(absolutePath))
  }
  let base = lookup(sessionId)
  if (base === undefined) base = lookup(FALLBACK_SESSION_KEY)

  // 没有基线的 shell 改动【不记录】。
  //
  // 没有「改动前」就永远算不出 diff，这类条目只会渲染成一个写着
  // 「这次改动没有记录到前后内容」的空栏目，纯粹是噪音。
  // 与其占一个位置让用户困惑，不如根本不列出来。
  if (base === undefined) return

  if (base !== undefined && afterText !== null && base === afterText) {
    return
  }

  if (shellSeen.size > MAX_SHELL_SEEN) shellSeen.clear()
  shellSeen.set(absolutePath, now)

  const beforeText = base
  const beforeKnown = true

  // 记进本会话的改动列表（一轮内可能改多个文件，都要能显示）。
  let list = shellChangesBySession.get(sessionId)
  if (list === undefined) {
    list = new Map()
    shellChangesBySession.set(sessionId, list)
  }
  list.set(normPath(absolutePath), {
    path: absolutePath,
    ts: now,
    afterText,
    beforeText,
    beforeKnown,
  })
  if (list.size > MAX_SHELL_CHANGES) {
    // 丢掉最旧的
    const oldest = [...list.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]
    if (oldest !== undefined) list.delete(oldest[0])
  }
}

function watchSessionWorkspace(sessionId, cwd) {
  if (shellWatchers.has(sessionId)) return
  let watcher
  try {
    watcher = fsWatch(cwd, { recursive: true, persistent: false }, (_eventType, filename) => {
      if (typeof filename !== 'string' || filename.length === 0) return
      const rel = normPath(filename)
      // 点号开头的临时文件/目录（.probe.txt、.sc-1.c 之类）不进列表：
      // 它们几乎都是工具或测试脚本的中间产物，出现在改动列表里只会造成噪音。
      if (/(^|\/)\./.test(rel)) return
      if (SHELL_IGNORE.test('/' + rel)) return
      const dot = rel.lastIndexOf('.')
      const ext = dot < 0 ? '' : rel.slice(dot + 1).toLowerCase()
      if (!SHELL_TEXT_EXT.has(ext)) return
      noteShellChange(sessionId, normPath(cwd).replace(/\/+$/, '') + '/' + rel)
    })
    watcher.on('error', () => {})
  } catch {
    return
  }
  shellWatchers.set(sessionId, watcher)
}

/**
 * 在 shell 命令执行【前】，把命令文本里提到的文件先快照进本轮基线。
 *
 * 这是「不管用什么手段改文件，都能看到前后对比」的关键一步：
 * 命令跑完之后原文就没了，所以必须在这里抢在它前面读。
 * 解析是启发式的（见 extractCommandPaths），宁可多快照也不漏。
 */
async function snapshotShellTargets(ctx, exec) {
  // Agent 上取不到会话 id 时退回固定 key：shell 快照本来就只有一张表，
  // 单会话场景完全够用。取不到就整个放弃才是最糟的选择 ——
  // 那样 shell 改动永远没有基线，diff 只能退化成「无对比」。
  const sid = sessionIdOfAgent(exec?.agent) || FALLBACK_SESSION_KEY

  const args = exec?.arguments
  if (args === null || typeof args !== 'object') return
  const command = typeof args.command === 'string' ? args.command : ''
  const workdir = typeof args.workdir === 'string' && args.workdir.length > 0
    ? args.workdir
    : process.cwd()

  const candidates = extractCommandPaths(command, workdir)
  if (candidates.length === 0) return

  let byPath = turnBaseline.get(sid)
  if (byPath === undefined) {
    byPath = new Map()
    turnBaseline.set(sid, byPath)
  }

  for (const abs of candidates) {
    const key = normPath(abs)
    // 本轮已经快照过就不覆盖：要的是「最先的样子」。
    if (byPath.has(key)) continue
    try {
      const stat = statSync(abs)
      if (!stat.isFile() || stat.size > MAX_BEFORE_BYTES) continue
      const content = readFileSync(abs, 'utf8')
      if (Buffer.byteLength(content, 'utf8') > MAX_BEFORE_BYTES) continue
      if (byPath.size > MAX_BASELINE_PATHS) byPath.clear()
      byPath.set(key, content)
    } catch {
      // 读不到（不存在 / 无权限）就跳过；命令可能会创建它，
      // 那种情况下基线本就该是「原本不存在」，由后续 shell 快照标为 null。
    }
  }
}

/**
 * 极简 schema 垫片：投影层只用到 `schema.parse(value)`（读检查点时校验）。
 * 这里手写校验，避免把一个 6 MB 的 zod 依赖带进插件 —— 链接安装的目录解析不到
 * profile 的 node_modules，带外部依赖会直接 import 失败。
 */
function schemaOf(check, shape) {
  return {
    shape,
    parse(value) {
      if (!check(value)) throw new Error('invalid ' + shape)
      return value
    },
  }
}

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

const isLast = (v) =>
  isRecord(v) &&
  typeof v.path === 'string' &&
  typeof v.tool === 'string' &&
  typeof v.command === 'string' &&
  (v.line === null || typeof v.line === 'number') &&
  typeof v.oldStr === 'string' &&
  typeof v.newStr === 'string' &&
  typeof v.ts === 'number' &&
  // 编辑前的完整文件内容：string 表示有基线，null 表示文件原本不存在，
  // undefined 表示这次编辑没能拿到基线（client 退化为反推）。
  (v.beforeText === undefined || v.beforeText === null || typeof v.beforeText === 'string') &&
  (v.beforeKnown === undefined || typeof v.beforeKnown === 'boolean') &&
  // shell 路径专用：改动后的完整快照内容。
  (v.afterText === undefined || typeof v.afterText === 'string')

const lastSchema = schemaOf((v) => v === null || isLast(v), 'last')

/**
 * wire view：最近一次改动 + 本轮改动过的全部文件。
 *
 * `last` 驱动「打开/跳转」，`files` 让客户端知道一轮里改过哪些文件，
 * 从而给每个真正有变化的文件各开一个标签，而不是只显示最后一个。
 */
const viewSchema = schemaOf(
  (v) =>
    isRecord(v) &&
    (v.last === null || isLast(v.last)) &&
    Array.isArray(v.files) &&
    v.files.every((f) => isLast(f)),
  'view',
)

const stateSchema = schemaOf(
  (v) =>
    isRecord(v) &&
    typeof v.sessionId === 'string' &&
    (v.pending === null || (isLast(v.pending) && typeof v.pending.callId === 'string')) &&
    (v.last === null || isLast(v.last)) &&
    // 会话内的按路径基线表；旧检查点可能没有这个字段，容忍缺失。
    (v.baselines === undefined || isRecord(v.baselines)),
  'state',
)

function shellEntry(shell) {
  return {
    path: shell.path,
    tool: 'shell',
    command: 'shell',
    line: null,
    oldStr: '',
    newStr: '',
    ts: shell.ts,
    // shell 改动没有编辑参数，但有快照：
    //   afterText 是改动后的完整内容，beforeText 是本轮基线（可能为 null）。
    // beforeKnown 为 false 表示「改动前从未被捕获」，此时无法做对比。
    ...(shell.afterText !== null && shell.afterText !== undefined
      ? { afterText: shell.afterText, beforeKnown: shell.beforeKnown === true, beforeText: shell.beforeText ?? null }
      : {}),
  }
}

const definition = {
  key: 'editDiff',
  stateVersion: 1,
  stateSchema,
  init: (header) => ({
    sessionId: typeof header?.id === 'string' ? header.id : '',
    pending: null,
    last: null,
    // 本会话内「每个文件最初的样子」。基线的归属完全由投影自己维护，
    // 不依赖 pre-execute 那边的 session id —— 两处 key 一旦不一致，
    // 基线就读不到，diff 会静默退化成「上一次→这一次」的碎片。
    baselines: {},
    // 本轮改过的文件（路径 → 改动记录）。一轮可能改多个，都要能列出来。
    turnFiles: {},
  }),
  apply: (state, event) => {
    let next = state

    // 轮次边界：新的一轮开始时丢弃上一轮的基线。
    //
    // 「一轮」= 用户发消息 → 助手停止。语义上每轮对比的是【上一轮结束时的状态】，
    // 所以基线必须随轮次滚动，而不是永远钉在会话开始。
    // 本轮第一次编辑某个文件时，pre-execute 会重新读它的内容作为本轮基线。
    //
    // 注意：这里不能提前 return —— 后面的 shell 合并对任何事件都要跑，
    // 否则 shell 改动会漏掉。
    if (event.type === 'turn/start') {
      // 新一轮：清掉基线和本轮的改动列表，一切从当前状态重新开始。
      const hasBaselines = state.baselines !== undefined && Object.keys(state.baselines).length > 0
      const hasFiles = state.turnFiles !== undefined && Object.keys(state.turnFiles).length > 0
      if (hasBaselines || hasFiles) {
        next = { ...state, baselines: {}, turnFiles: {} }
      }
      // shell 的全局表也要跟着清，否则上一轮的 shell 改动会漏进本轮。
      const sid = state.sessionId
      if (typeof sid === 'string' && sid.length > 0) {
        shellChangesBySession.delete(sid)
        shellChangesBySession.delete(FALLBACK_SESSION_KEY)
      }
    } else if (event.type === 'tool/call') {
      const edit = editFromCall(event.data)
      if (edit !== null) {
        next = { ...state, pending: { callId: String(event.data.callId), ...edit, ts: event.time } }
      }
    } else if (event.type === 'tool/result') {
      if (state.pending !== null) {
        const msg = event.data?.message
        const rawId = msg?.source?.callId ?? msg?.toolCallId ?? event.data?.callId
        const callId = typeof rawId === 'string' && rawId.length > 0
          ? rawId
          // 兜底：有些版本的结果事件不带 callId。此时 pending 就是唯一在途的调用，
          // 直接采信它 —— 否则条目会被静默丢弃（新建文件就是这么消失的）。
          : state.pending.callId
        if (callId === state.pending.callId) {
          const isError = msg?.isError === true || event.data?.error !== undefined
          const hadBefore = beforeByCall.has(callId)
          const firstBefore = beforeByCall.get(callId)
          const captured = lineByCall.get(callId)
          lineByCall.delete(callId)
          beforeByCall.delete(callId)

          if (isError) {
            next = { ...state, pending: null }
          } else {
            const { callId: _cid, ...rest } = state.pending
            const line = captured === undefined ? rest.line : captured

            // 基线选择：本会话里这个文件「最初的样子」优先。
            // 表在投影 state 内，所以归属天然正确，不需要任何 id 匹配。
            const pathKey = normPath(rest.path)
            const table = state.baselines ?? {}
            const hasStored = Object.prototype.hasOwnProperty.call(table, pathKey)
            const useStored = hasStored
            // 第一次见到这个文件时，用这次 pre-execute 读到的内容作为会话基线。
            const baselines = useStored
              ? table
              : (hadBefore ? { ...table, [pathKey]: firstBefore ?? null } : table)
            const finalBefore = useStored ? table[pathKey] : (hadBefore ? firstBefore : undefined)
            const finalKnown = useStored || hadBefore

            // post-execute 存下的「修改后」内容（可能没有）。
            const capturedAfter = afterByCall.get(callId)
            afterByCall.delete(callId)
            const afterPart = typeof capturedAfter === 'string'
              ? { afterText: capturedAfter }
              : {}

            next = {
              sessionId: state.sessionId,
              pending: null,
              baselines,
              // 本轮改过的文件按路径累积：一轮可能改多个文件，都要能列出来。
              turnFiles: {
                ...(state.turnFiles ?? {}),
                [pathKey]: {
                  ...rest,
                  line,
                  ...(finalKnown ? { beforeText: finalBefore, beforeKnown: true } : {}),
                  ...afterPart,
                  ts: event.time,
                },
              },
              last: {
                ...rest,
                line,
                // beforeKnown 表示「这次确实拿到了基线」，用于区分
                // 「文件原本不存在」(beforeText: null) 和「没取到基线」(undefined)。
                ...(finalKnown ? { beforeText: finalBefore, beforeKnown: true } : {}),
                ...afterPart,
                ts: event.time,
              },
            }
          }
        }
      }
    }

    // shell 改动：把本会话所有 shell 记录并进 turnFiles。
    // 内容没变的已被 noteShellChange 丢掉，所以这里进来的都是真改动。
    const shellList = shellChangesBySession.get(next.sessionId)
    if (shellList !== undefined && shellList.size > 0) {
      const merged = { ...(next.turnFiles ?? {}) }
      let newest = next.last
      for (const [key, shell] of shellList) {
        const entry = shellEntry(shell)
        merged[key] = entry
        if (newest === null || shell.ts > newest.ts) newest = entry
      }
      next = { ...next, turnFiles: merged, last: newest }
    }
    return next
  },
  wire: {
    viewSchema,
    // files 只保留有实际变化的条目：before === after 且都已知时跳过，
    // 避免出现 +0 −0 这种空条目。
    view: (state) => {
      const all = state.turnFiles ?? {}
      const files = Object.values(all).filter((f) => {
        // 点号开头的临时文件不进列表（见 watchSessionWorkspace 的同类过滤）。
        if (isScratchPath(f.path)) return false
        // 没有基线就没有「改动前」，永远算不出 diff。
        // 这类条目以前会渲染成一个写着「这次改动没有记录到前后内容」的空栏目，
        // 它不提供任何信息，只会让列表变乱——直接不列出来。
        if (f.beforeKnown !== true) return false
        const before = f.beforeText === null ? '' : String(f.beforeText)
        const after = f.afterText !== undefined
          ? String(f.afterText)
          : (typeof f.newStr === 'string' ? f.newStr : null)
        if (after === null) return false
        return before.replace(/\r\n/g, '\n') !== after.replace(/\r\n/g, '\n')
      })
      return { last: state.last, files }
    },
  },
}

/** 点号开头的文件名/目录视为临时产物，不进改动列表。 */
function isScratchPath(path) {
  return /(^|\/)\./.test(normPath(String(path ?? '')))
}

export function apply(ctx) {
  // A) 编辑【前】捕获基线：
  //    · 完整文件内容 → 供 diff 精确显示「修改前」（不依赖 indexOf 反推）
  //    · oldStr 所在行 → 供跳行定位
  // 删除的内容编辑后就不在文件里了，所以两样都只能在这时拿到。
  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      // A2) shell / 脚本命令：从命令文本里解析出可能被写入的文件，先快照。
      //     命令执行后就再也拿不到「改动前」的原文了，这里是唯一的时机。
      const toolName = String(exec?.name ?? '')
      if (SHELL_TOOLS.has(toolName)) {
        await snapshotShellTargets(ctx, exec)
        return next()
      }

      const info = editFromCall(exec)
      const callId = typeof exec?.callId === 'string' ? exec.callId : null
      if (info !== null && callId !== null) {
        // 关键：resolve 返回 undefined 表示「这个路径还不存在」——也就是新建。
        // 仍然必须记一条 null 基线，否则 tool/result 里 hadBefore=false，
        // 条目会被当成「无基线」过滤掉，新建的文件就永远不显示。
        let target
        try {
          target = await ctx.fs.resolve(info.path, { signal: exec.signal })
        } catch {
          target = undefined
        }

        let content = null
        if (target !== undefined) {
          try {
            content = await ctx.fs.readText(target, exec.signal)
          } catch {
            // 文件不可读：当作原本没有内容。
            content = null
          }
        }

        if (beforeByCall.size > MAX_PENDING_BEFORE) beforeByCall.clear()
        beforeByCall.set(
          callId,
          content !== null && content.length <= MAX_BEFORE_BYTES ? content : null,
        )

        // 编辑路径的会话基线由投影 state 自己维护（见 definition.apply），
        // 这里不再写 turnBaseline —— 那张表只服务 shell 路径。

        if (info.line === null && info.oldStr.length > 0 && content !== null) {
          const idx = content.indexOf(info.oldStr)
          if (idx >= 0) {
            if (lineByCall.size > MAX_PENDING_LINES) lineByCall.clear()
            lineByCall.set(callId, content.slice(0, idx).split('\n').length)
          }
        }
      }
    } catch {
      // 基线只是增强项：读失败就退化为「无基线」，由 client 兜底
    }
    return next()
  })

  // A3) 编辑【后】再读一次，存下「修改后」的完整内容。
  //
  // 客户端原本靠读磁盘拿 after，但插件自己的源文件在被监视时可能读不到，
  // 界面上就只剩空栏。这里在编辑刚结束时读一次，客户端优先用它。
  ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      const info = editFromCall(exec)
      const callId = typeof exec?.callId === 'string' ? exec.callId : null
      if (info !== null && callId !== null && result !== undefined) {
        const target = await ctx.fs.resolve(info.path, { signal: exec.signal })
        if (target !== undefined) {
          const content = await ctx.fs.readText(target, exec.signal)
          if (typeof content === 'string' && content.length <= MAX_BEFORE_BYTES) {
            if (afterByCall.size > MAX_PENDING_BEFORE) afterByCall.clear()
            afterByCall.set(callId, content)
          }
        }
      }
    } catch {
      // 读不到就退回客户端读磁盘的老路径
    }
    return next()
  })

  // B) 终端 / shell 改动
  ctx.on('session/created', (session) => {
    const cwd = session?.header?.cwd
    if (typeof session?.id === 'string' && typeof cwd === 'string' && cwd.length > 0) {
      watchSessionWorkspace(session.id, cwd)
    }
  })

  // C) 轮次语义：每轮对比的是【上一轮结束时的状态】。
  //
  // 编辑路径的基线由投影 state 在 turn/start 时重置（见 definition.apply），
  // 已自动随轮次滚动。这里只处理 shell 路径用的全局表 turnBaseline ——
  // 它在投影之外，只能在一轮结束时清掉，让下一轮的 shell 命令重新取基线。
  ctx.on('agent/turn-stopping', (payload) => {
    const sid = sessionIdOfAgent(payload?.agent) || FALLBACK_SESSION_KEY
    turnBaseline.delete(sid)
  })

  // D) 会话销毁时清理，避免内存里留着已结束会话的基线。
  ctx.on('session/disposed', (session) => {
    if (typeof session?.id === 'string') {
      turnBaseline.delete(session.id)
      shellBySession.delete(session.id)
    }
    turnBaseline.delete(FALLBACK_SESSION_KEY)
  })

  ctx.effect(() => () => {
    for (const watcher of shellWatchers.values()) {
      try { watcher.close() } catch { /* 已关闭 */ }
    }
    shellWatchers.clear()
    turnBaseline.clear()
    beforeByCall.clear()
    lineByCall.clear()
  }, 'dsh-edit-diff: shell watchers')

  ctx.sessionProjections.register(definition)
  ctx.logger?.info?.('[dsh-edit-diff] host face loaded; projection key = editDiff')
}
