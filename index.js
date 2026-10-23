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
import { watch as fsWatch } from 'node:fs'

export const name = 'dsh-edit-diff'
export const inject = ['sessionProjections', 'fs']

const EDIT_TOOLS = new Set(['str_replace_editor', 'write', 'edit', 'apply_patch', 'multi_edit'])

/** callId → 编辑前 oldStr 的 1-based 起始行。只服务实时路径，读一次即删。 */
const lineByCall = new Map()
const MAX_PENDING_LINES = 256

/** sessionId → 最近一次 shell 改动 { path, ts }。 */
const shellBySession = new Map()
const shellWatchers = new Map()
const shellSeen = new Map()
const SHELL_DEDUPE_MS = 200
const MAX_SHELL_SEEN = 512

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
  if (shellSeen.size > MAX_SHELL_SEEN) shellSeen.clear()
  shellSeen.set(absolutePath, now)
  shellBySession.set(sessionId, { path: absolutePath, ts: now })
}

function watchSessionWorkspace(sessionId, cwd) {
  if (shellWatchers.has(sessionId)) return
  let watcher
  try {
    watcher = fsWatch(cwd, { recursive: true, persistent: false }, (_eventType, filename) => {
      if (typeof filename !== 'string' || filename.length === 0) return
      const rel = normPath(filename)
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
  typeof v.ts === 'number'

const lastSchema = schemaOf((v) => v === null || isLast(v), 'last')
const viewSchema = lastSchema
const stateSchema = schemaOf(
  (v) =>
    isRecord(v) &&
    typeof v.sessionId === 'string' &&
    (v.pending === null || (isLast(v.pending) && typeof v.pending.callId === 'string')) &&
    (v.last === null || isLast(v.last)),
  'state',
)

function shellEntry(shell) {
  return { path: shell.path, tool: 'shell', command: 'shell', line: null, oldStr: '', newStr: '', ts: shell.ts }
}

const definition = {
  key: 'editDiff',
  stateVersion: 1,
  stateSchema,
  init: (header) => ({
    sessionId: typeof header?.id === 'string' ? header.id : '',
    pending: null,
    last: null,
  }),
  apply: (state, event) => {
    let next = state

    if (event.type === 'tool/call') {
      const edit = editFromCall(event.data)
      if (edit !== null) {
        next = { ...state, pending: { callId: String(event.data.callId), ...edit, ts: event.time } }
      }
    } else if (event.type === 'tool/result') {
      if (state.pending !== null) {
        const msg = event.data?.message
        const callId = String(msg?.source?.callId ?? msg?.toolCallId ?? '')
        if (callId === state.pending.callId) {
          const isError = msg?.isError === true || event.data?.error !== undefined
          if (isError) {
            lineByCall.delete(callId)
            next = { ...state, pending: null }
          } else {
            const captured = lineByCall.get(callId)
            lineByCall.delete(callId)
            const { callId: _cid, ...rest } = state.pending
            const line = captured === undefined ? rest.line : captured
            next = { sessionId: state.sessionId, pending: null, last: { ...rest, line, ts: event.time } }
          }
        }
      }
    }

    const shell = shellBySession.get(next.sessionId)
    if (shell !== undefined && (next.last === null || shell.ts > next.last.ts)) {
      return { ...next, last: shellEntry(shell) }
    }
    return next
  },
  wire: {
    viewSchema,
    view: (state) => state.last,
  },
}

export function apply(ctx) {
  // A) 编辑【前】捕获 oldStr 所在行 —— 删除的内容编辑后就不在文件里了，只能这时定位。
  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      const info = editFromCall(exec)
      if (info !== null && info.line === null && info.oldStr.length > 0 && typeof exec?.callId === 'string') {
        const target = await ctx.fs.resolve(info.path, { signal: exec.signal })
        if (target !== undefined) {
          const content = await ctx.fs.readText(target, exec.signal)
          const idx = content.indexOf(info.oldStr)
          if (idx >= 0) {
            if (lineByCall.size > MAX_PENDING_LINES) lineByCall.clear()
            lineByCall.set(exec.callId, content.slice(0, idx).split('\n').length)
          }
        }
      }
    } catch {
      // 行号只是增强项：读文件失败就退化为「无行号」
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

  ctx.effect(() => () => {
    for (const watcher of shellWatchers.values()) {
      try { watcher.close() } catch { /* 已关闭 */ }
    }
    shellWatchers.clear()
  }, 'dsh-edit-diff: shell watchers')

  ctx.sessionProjections.register(definition)
  ctx.logger?.info?.('[dsh-edit-diff] host face loaded; projection key = editDiff')
}
