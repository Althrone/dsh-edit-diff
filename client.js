/**
 * dsh-edit-diff —— client 半（浏览器侧）。
 *
 * 设计原则（这是它相对 dsh-follow-edits 的全部区别）：
 *
 *   绝不注册 `documentPreviews` 渲染器。
 *
 * 旧插件为了「标黄/标红」抢在 extension 优先级上注册了一个纯文本渲染器，覆盖了
 * `*.ts`/`*.md` 等所有文本扩展名 —— 内置的代码高亮和 Markdown 渲染因此被顶掉。
 * 这里改成两条互不干扰的路径：
 *
 *   1) 原生预览跟随：`openResource(address, { params: { line } })`
 *      —— 用内置渲染器打开文件（语法高亮、md 全部保留），并跳到改动行。
 *   2) 并排 diff：注册一个独立的 page 类型标签 `editDiff.tab`，
 *      左「原内容」右「当前内容」，行级 +/- 着色 + 语法高亮。
 *
 * 依赖：slots、locale、sidebarRight、sidebarRightTabs、sessions、remote。
 */

window.__ModuleLoader__.load({
  id: 'dsh-edit-diff',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef } = React

    const PROJECTION_KEY = 'editDiff'
    const TAB_ID = 'dsh-edit-diff/tab'
    const KIND = 'editDiff.tab'
    const MAX_AGE_MS = 90 * 1000
    const MAX_LOCATE_PAGES = 10
    const MAX_DIFF_CELLS = 4_000_000
    const DIFF_FOCUS_THROTTLE_MS = 700
    /**
     * 随导航参数携带的基线原文上限。
     * 导航参数会进入侧栏布局的 localStorage 存档，所以不能无限制地带大文件；
     * Host 侧另有 2 MiB 的读取上限，这里更保守，只带中小文件。
     */
    const MAX_CARRY_BEFORE = 256 * 1024

    /**
     * 占位用的不换行空格。
     * 空字符串的 span 高度是 0，会让该行塌陷、与对侧行错位；
     * 用 NBSP 保证「留空的单元格」仍然占一行高度（VS Code 的 diff 同样留白占位）。
     */
    const NBSP = '\u00A0'

    // ── 跟随偏好 ────────────────────────────────────────────────────
    //
    // 每次编辑都强制打开侧栏会打断人，所以给三档可选行为，存在 localStorage。
    // 纯浏览器侧偏好：不涉及 Host，改完立刻生效，不需要重启。

    /** 打开行为：always=每次；turn=每轮首次；off=只更新不打开。 */
    const FOLLOW_KEY = 'dsh-edit-diff:follow'
    const FOLLOW_MODES = ['always', 'turn', 'off']
    const FOLLOW_DEFAULT = 'turn'

    function readFollowMode() {
      try {
        const v = globalThis.localStorage?.getItem(FOLLOW_KEY)
        return FOLLOW_MODES.includes(v) ? v : FOLLOW_DEFAULT
      } catch {
        return FOLLOW_DEFAULT
      }
    }

    function writeFollowMode(mode) {
      try {
        globalThis.localStorage?.setItem(FOLLOW_KEY, mode)
      } catch {
        // localStorage 不可用时退回默认，不影响功能
      }
    }

    /** 调试模式：显示「shell 改动无法对比」这类内部提示。默认关闭。 */
    const DEBUG_KEY = 'dsh-edit-diff:debug'

    function readDebugMode() {
      try {
        return globalThis.localStorage?.getItem(DEBUG_KEY) === '1'
      } catch {
        return false
      }
    }

    function writeDebugMode(on) {
      try {
        globalThis.localStorage?.setItem(DEBUG_KEY, on ? '1' : '0')
      } catch {
        // localStorage 不可用时忽略
      }
    }

    /**
     * 自动打开 diff 标签时，是否【同时】打开每个改动文件的原生预览标签。
     *
     * 两者目的不同：原生预览负责「跳到改动行、保留语法高亮/Markdown」，
     * diff 标签负责「并排看前后对比」。很多人只想要后者 —— 每改一个文件
     * 就在侧栏多出一个原生标签，标签栏很快就被塞满。
     *
     * 默认 true，保持旧行为；关掉后仍会打开并聚焦 Edit Diff 标签本身。
     */
    const NATIVE_KEY = 'dsh-edit-diff:native'

    function readNativeOpen() {
      try {
        const v = globalThis.localStorage?.getItem(NATIVE_KEY)
        return v === null || v === undefined ? true : v === '1'
      } catch {
        return true
      }
    }

    function writeNativeOpen(on) {
      try {
        globalThis.localStorage?.setItem(NATIVE_KEY, on ? '1' : '0')
      } catch {
        // localStorage 不可用时忽略
      }
    }

    const en = {
      title: 'Edit Diff',
      empty: 'No change recorded in this Session yet.',
      original: 'Original',
      current: 'Current',
      openFile: 'Open file',
      deleted: 'removed',
      added: 'added',
      unchanged: 'unchanged',
      shell: 'Changed by a shell command (no before/after content available).',
      created: 'New file',
      loading: 'Loading file…',
      failed: 'Could not read the file.',
      gone: 'This file no longer exists (it was probably deleted or moved).',
      follow: 'Auto-open',
      followAlways: 'Every edit',
      followTurn: 'First edit of each turn',
      followOff: 'Off (update only)',
      collapseAll: 'Collapse all',
      expandAll: 'Expand all',
      fileCount: '{n} file(s)',
      debug: 'Debug info',
      nativePreview: 'Also open the native preview tab',
      noBaseline: 'No before/after content recorded for this change.',
      noChanges: 'No textual change detected.',
      prevChange: 'Previous change',
      nextChange: 'Next change',
    }
    const zh = {
      title: 'Edit Diff',
      empty: '本会话还没有记录到改动。',
      original: '修改前',
      current: '修改后',
      openFile: '打开文件',
      deleted: '删除',
      added: '新增',
      unchanged: '未变',
      shell: '该文件由 shell 命令改动（没有修改前后的内容）。',
      created: '新建文件',
      loading: '正在读取文件…',
      failed: '读取文件失败。',
      gone: '该文件已不存在（可能被删除或移动了）。',
      follow: '自动打开',
      followAlways: '每次编辑',
      followTurn: '每轮首次编辑',
      followOff: '关闭（只更新）',
      collapseAll: '全部折叠',
      expandAll: '全部展开',
      fileCount: '{n} 个文件',
      debug: '调试信息',
      nativePreview: '同时打开原生预览标签',
      noBaseline: '这次改动没有记录到前后内容。',
      noChanges: '没有检测到文本变化。',
      prevChange: '上一处差异',
      nextChange: '下一处差异',
    }

    // ── 轻量语法高亮 ────────────────────────────────────────────────
    //
    // 内置预览的高亮来自 ui-primitives 的 CodeBlock，而插件规范禁止 require 那个包
    // （它会随时改版、无类型检查）。这里自己做一个够用的词法高亮：
    // 按行独立着色，不追求跨行状态（字符串/注释不回渗），对 diff 展示已经足够。

    /**
     * 每种语言：单行注释、块注释、字符串、关键字、数字、预处理器、函数名。
     *
     * `call` 匹配「标识符后面紧跟 (」—— 函数声明与调用都是这个形状，VS Code 同款规则。
     * 关键字先于 call 探测，所以 `if (` / `sizeof(` 里的词仍算关键字。
     */
    const LANGS = {
      c: {
        keywords: /\b(?:auto|break|case|char|const|continue|default|do|double|else|enum|extern|float|for|goto|if|inline|int|long|register|restrict|return|short|signed|sizeof|static|struct|switch|typedef|union|unsigned|void|volatile|while|_Bool|size_t|NULL|true|false)\b/,
        line: /\/\/.*$/,
        block: /\/\*.*?\*\//g,
        string: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
        number: /\b(?:0[xX][0-9a-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?)[uUlLfF]*\b/g,
        preproc: /^\s*#\s*\w+/,
        type: /\b(?:int|char|float|double|void|long|short|unsigned|signed|size_t|FILE|bool)\b/,
        call: /\b[A-Za-z_]\w*(?=\s*\()/g,
      },
      js: {
        keywords: /\b(?:async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|function|if|import|in|instanceof|let|new|of|return|super|switch|this|throw|try|typeof|var|void|while|with|yield|true|false|null|undefined)\b/,
        line: /\/\/.*$/,
        block: /\/\*.*?\*\//g,
        string: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
        number: /\b(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?)\b/g,
        preproc: null,
        type: null,
        call: /\b[A-Za-z_$]\w*(?=\s*\()/g,
      },
      py: {
        keywords: /\b(?:and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|False|try|while|with|yield)\b/,
        line: /#.*$/,
        block: null,
        string: /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
        number: /\b(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?)\b/g,
        preproc: null,
        type: null,
        call: /\b[A-Za-z_]\w*(?=\s*\()/g,
      },
      rust: {
        keywords: /\b(?:as|async|await|break|const|continue|crate|dyn|else|enum|extern|false|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|true|type|unsafe|use|where|while)\b/,
        line: /\/\/.*$/,
        block: /\/\*[\s\S]*?\*\//g,
        string: /"(?:\\.|[^"\\])*"/g,
        number: /\b(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?)(?:[iuf](?:8|16|32|64|128|size))?\b/g,
        preproc: null,
        type: null,
        call: /\b[A-Za-z_]\w*(?=\s*[!(])/g,
      },
      sh: {
        keywords: /\b(?:case|do|done|elif|else|esac|fi|for|function|if|in|select|then|until|while|local|export|return|set|unset|shift|echo)\b/,
        line: /#.*$/,
        block: null,
        string: /"(?:\\.|[^"\\])*"|'[^']*'/g,
        number: /\b\d+\b/g,
        preproc: null,
        type: null,
        // shell 里没有统一的函数形状（命令、内建、别名混在一起），不做函数高亮。
        call: null,
      },
      json: {
        keywords: /\b(?:true|false|null)\b/,
        line: null,
        block: null,
        string: /"(?:\\.|[^"\\])*"/g,
        number: /-?\b\d+\.?\d*(?:[eE][+-]?\d+)?\b/g,
        preproc: null,
        type: null,
        call: null,
      },
    }

    /** 扩展名 → 语言。未知后缀返回 null（不高亮，保持纯文本）。 */
    function languageOf(path) {
      const dot = String(path).lastIndexOf('.')
      if (dot < 0) return null
      switch (String(path).slice(dot + 1).toLowerCase()) {
        case 'c':
        case 'h':
        case 'cc':
        case 'cpp':
        case 'cxx':
        case 'hpp':
        case 'hh':
          return 'c'
        case 'js':
        case 'jsx':
        case 'mjs':
        case 'cjs':
        case 'ts':
        case 'tsx':
        case 'java':
        case 'kt':
        case 'cs':
        case 'go':
        case 'swift':
        case 'php':
        case 'scala':
          return 'js'
        case 'py':
        case 'rb':
          return 'py'
        case 'rs':
          return 'rust'
        case 'sh':
        case 'bash':
        case 'zsh':
        case 'ps1':
          return 'sh'
        case 'json':
        case 'jsonc':
          return 'json'
        default:
          return null
      }
    }

    /**
     * 把一行切成 [{ text, kind }] 片段。kind 为 null 表示普通文本。
     *
     * 策略：先标出「受保护区间」（字符串/注释），再在这些区间之外匹配关键字与数字，
     * 避免把字符串里的 "if" 染成关键字。
     *
     * @param line - 一行源码。
     * @param lang - 语言名，或 null（纯文本）。
     * @param inBlock - 本行是否处在跨行块注释内（由上一行状态传入）。
     * @returns 片段数组，以及本行结束时是否仍在块注释内，供下一行使用。
     */
    function tokenizeLine(line, lang, inBlock = false) {
      const spec = lang === null ? null : LANGS[lang]
      if (spec === null || spec === undefined) return [{ text: line, kind: null }]

      const marks = []
      const collect = (regex, kind) => {
        if (regex === null || regex === undefined) return
        const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g')
        let match
        while ((match = re.exec(line)) !== null) {
          marks.push({ start: match.index, end: match.index + match[0].length, kind })
          if (match[0].length === 0) re.lastIndex++
        }
      }

      // 跨行块注释：本行起始就处于注释内时，整行算注释；
      // 否则找出未闭合的 /* 并从那里到行尾算注释。
      let stillInBlock = false
      if (typeof line === 'string') {
        const open = line.lastIndexOf('/*')
        const close = line.lastIndexOf('*/')
        if (inBlock && (close < 0 || open > close)) {
          marks.push({ start: 0, end: line.length, kind: 'comment' })
          stillInBlock = true
        } else if (!inBlock && open >= 0 && (close < 0 || open > close)) {
          marks.push({ start: open, end: line.length, kind: 'comment' })
          stillInBlock = true
        }
      }

      // 顺序有意义：注释优先，其次字符串，最后才是关键字/数字。
      if (!stillInBlock && !inBlock && spec.line !== null) collect(spec.line, 'comment')
      collect(spec.block, 'comment')
      collect(spec.string, 'string')
      collect(spec.number, 'number')

      const masked = line.split('')
      for (const m of marks) {
        for (let i = m.start; i < m.end; i++) masked[i] = '\u0000'
      }
      const plain = masked.join('')

      const probe = (regex, kind) => {
        if (regex === null || regex === undefined) return
        const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g')
        let match
        while ((match = re.exec(plain)) !== null) {
          marks.push({ start: match.index, end: match.index + match[0].length, kind })
          if (match[0].length === 0) re.lastIndex++
        }
      }
      // 类型要先于关键字探测：C 里 int/void/size_t 同时出现在两张表里，
      // 先探 keyword 会把它们染成关键字色。
      // 关键字又要先于 call 探测，否则 `if (` / `sizeof(` 会被当成函数名。
      probe(spec.type, 'type')
      probe(spec.keywords, 'keyword')
      probe(spec.preproc, 'preproc')
      probe(spec.call, 'call')

      marks.sort((a, b) => a.start - b.start || a.end - b.end)
      const out = []
      let cursor = 0
      for (const m of marks) {
        if (m.start < cursor) continue
        if (m.start > cursor) out.push({ text: line.slice(cursor, m.start), kind: null })
        out.push({ text: line.slice(m.start, m.end), kind: m.kind })
        cursor = m.end
      }
      if (cursor < line.length) out.push({ text: line.slice(cursor), kind: null })
      const result = out.length === 0 ? [{ text: line, kind: null }] : out
      // 把「本行结束时是否仍在块注释内」挂在数组上，供下一行传回 inBlock。
      result.inBlock = stillInBlock
      return result
    }

    /** token 配色：暗色/亮色各一套，全部走主题 token 之外的语义色（美术用色）。 */
    function tokenColor(kind, dark) {
      switch (kind) {
        case 'comment':
          return dark ? '#7d8590' : '#6e7781'
        case 'string':
          return dark ? '#a5d6a7' : '#0a7d33'
        case 'number':
          return dark ? '#f0b072' : '#b35900'
        case 'keyword':
          return dark ? '#79c0ff' : '#0550ae'
        case 'type':
          return dark ? '#7ee0d0' : '#116d63'
        case 'preproc':
          return dark ? '#d2a8ff' : '#8250df'
        // 函数名：VS Code Dark+ 是黄色系，Light+ 是深蓝紫。
        case 'call':
          return dark ? '#dcdcaa' : '#795e26'
        default:
          return undefined
      }
    }

    function fileAddress(sessionId, cwd, path) {
      const encodeSegment = (seg) => encodeURIComponent(seg).replace(/%3A/gi, ':')
      const encodePath = (p) => p.split('/').map(encodeSegment).join('/')
      const normalized = String(path).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
      let rel = normalized
      if (typeof cwd === 'string' && cwd.length > 0) {
        const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
        if (root !== '' && normalized === root) rel = ''
        else if (root !== '' && normalized.startsWith(root + '/')) rel = normalized.slice(root.length + 1)
      }
      return `dsh-resource://file/session/${encodeSegment(sessionId)}/${encodePath(rel)}`
    }

    function parseSessionAddress(address) {
      const m = String(address ?? '').match(/^dsh-resource:\/\/file\/session\/([^/]+)\/(.*)$/)
      if (m === null) return undefined
      try {
        return { sessionId: decodeURIComponent(m[1]), path: m[2].split('/').map(decodeURIComponent).join('/') }
      } catch {
        return undefined
      }
    }

    function normPath(p) {
      return String(p || '').replace(/\\/g, '/')
    }

    function baseName(p) {
      const s = normPath(p)
      const i = s.lastIndexOf('/')
      return i < 0 ? s : s.slice(i + 1)
    }

    function sessionIdOf(address) {
      const parsed = parseSessionAddress(address)
      return parsed === undefined ? undefined : parsed.sessionId
    }

    function isSameFile(edit, absolutePath, resourceAddress) {
      const editPath = normPath(edit.path)
      if (editPath.length === 0) return false
      if (absolutePath !== undefined && normPath(absolutePath) === editPath) return true
      const parsed = parseSessionAddress(resourceAddress)
      if (parsed === undefined || parsed.path.length === 0) return false
      return editPath === parsed.path || editPath.endsWith('/' + parsed.path)
    }

    async function locateLine(remote, sessionId, path, newStr) {
      const needle = String(newStr || '').split('\n')[0]
      if (needle.length === 0) return null
      let offset = 1
      for (let i = 0; i < MAX_LOCATE_PAGES; i++) {
        let result
        try {
          result = await remote.workspaceFiles.read(sessionId, path, { offset }, undefined)
        } catch {
          return null
        }
        if (result === undefined || result.ok !== true) return null
        const { text, lines, eof } = result.value
        const idx = text.indexOf(needle)
        if (idx !== -1) return offset + text.slice(0, idx).split('\n').length - 1
        if (eof) return null
        offset += lines
      }
      return null
    }

    /** 读取整份文本（分页读到底）。 */
    async function readWholeFile(remote, sessionId, path, signal) {
      const chunks = []
      let offset = 1
      for (let i = 0; i < 400; i++) {
        const result = await remote.workspaceFiles.read(sessionId, path, { offset }, signal)
        if (result === undefined || result.ok !== true) {
          const failure = result?.error ?? result?.failure
          const code = failure?.code ?? failure?.kind
          const message = typeof failure?.message === 'string' ? failure.message : 'read failed'
          const error = new Error(message)
          error.code = typeof code === 'string' ? code : undefined
          throw error
        }
        chunks.push(result.value.text)
        if (result.value.eof) break
        offset += result.value.lines
      }
      return chunks.join('')
    }

    // ── 行级 diff ────────────────────────────────────────────────────

    /** LCS 行 diff，返回 [{ type:'eq'|'del'|'add', line }]。 */
    function diffLines(before, after) {
      const a = before.length === 0 ? [] : before.split('\n')
      const b = after.length === 0 ? [] : after.split('\n')
      if (a.length * b.length > MAX_DIFF_CELLS) {
        const out = []
        for (const line of a) out.push({ type: 'del', line })
        for (const line of b) out.push({ type: 'add', line })
        return out
      }
      const n = a.length
      const m = b.length
      const table = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
        }
      }
      const out = []
      let i = 0
      let j = 0
      while (i < n && j < m) {
        if (a[i] === b[j]) {
          out.push({ type: 'eq', line: a[i] })
          i++
          j++
        } else if (table[i + 1][j] >= table[i][j + 1]) {
          out.push({ type: 'del', line: a[i] })
          i++
        } else {
          out.push({ type: 'add', line: b[j] })
          j++
        }
      }
      while (i < n) out.push({ type: 'del', line: a[i++] })
      while (j < m) out.push({ type: 'add', line: b[j++] })
      return out
    }

    /** 把线性 diff 折成并排行：删除行与其后的新增行配对成一行。 */
    function toSideBySide(ops) {
      const rows = []
      let leftNo = 0
      let rightNo = 0
      let k = 0
      while (k < ops.length) {
        const op = ops[k]
        if (op.type === 'eq') {
          leftNo++
          rightNo++
          rows.push({ type: 'eq', leftNo, rightNo, left: op.line, right: op.line })
          k++
          continue
        }
        const dels = []
        while (k < ops.length && ops[k].type === 'del') dels.push(ops[k++].line)
        const adds = []
        while (k < ops.length && ops[k].type === 'add') adds.push(ops[k++].line)
        const count = Math.max(dels.length, adds.length)
        for (let r = 0; r < count; r++) {
          const left = r < dels.length ? dels[r] : undefined
          const right = r < adds.length ? adds[r] : undefined
          if (left !== undefined) leftNo++
          if (right !== undefined) rightNo++
          rows.push({
            type: left !== undefined && right !== undefined ? 'mod' : left !== undefined ? 'del' : 'add',
            leftNo: left === undefined ? undefined : leftNo,
            rightNo: right === undefined ? undefined : rightNo,
            left,
            right,
          })
        }
      }
      return rows
    }

    function changedSpan(rows, type) {
      let first
      let count = 0
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]
        const hit = type === 'left' ? row.left !== undefined && row.type !== 'eq' : row.right !== undefined && row.type !== 'eq'
        if (hit) {
          if (first === undefined) first = i
          count++
        }
      }
      return { first: first ?? 0, count }
    }

    // ── diff 标签正文 ────────────────────────────────────────────────

    /**
     * 把一栏的纵向滚动镜像到另一栏。
     * 用 guard 防止 A→B 赋值触发 B 的监听再反过来写 A（无限递归）。
     */
    function mirrorScroll(from, to, guard = { current: false }) {
      return () => {
        if (guard.current) return
        guard.current = true
        to.scrollTop = from.scrollTop
        guard.current = false
      }
    }

    /** 把两个滚动容器按纵向联动起来，返回解绑函数。 */
    function linkVerticalScroll(left, right) {
      const guard = { current: false }
      const onLeft = mirrorScroll(left, right, guard)
      const onRight = mirrorScroll(right, left, guard)
      left.addEventListener('scroll', onLeft)
      right.addEventListener('scroll', onRight)
      return () => {
        left.removeEventListener('scroll', onLeft)
        right.removeEventListener('scroll', onRight)
      }
    }

    /**
     * 横向联动：两栏共享同一个「列位置」，但各自按自己的最大可滚动距离截断。
     *
     * 规则只有一条：谁被拖动，就把它的 scrollLeft 写给另一栏，
     * 写入前 clamp 到【对方】的 max（scrollWidth - clientWidth）。
     *
     * 这样自然得到几种想要的组合：
     *  - 拖短栏到最右：长栏同步到同一列；短栏到底后停住，再拖长栏可继续右移，
     *    短栏被 clamp 钉在自己的 max 上不动；
     *  - 两栏都在最右，左移长栏：短栏仍被 clamp 钉住，直到长栏回到短栏的列位置，
     *    两者才一起左移；
     *  - 两栏都在最右，左移短栏：长栏直接跟到短栏的列位置（短栏到不了的地方没意义）。
     *
     * 程序化写 scrollLeft 会触发对方的 scroll 事件，形成回声。
     * 所以记下「我刚写进去的值」，下一次该元素的事件只要还是这个值就忽略。
     */
    function linkHorizontalScroll(left, right) {
      const echo = new Map([[left, null], [right, null]])
      const mirror = (from, to) => () => {
        const value = from.scrollLeft
        const pending = echo.get(from)
        echo.set(from, null)
        // 自己刚写进去的那一次滚动：忽略，不要反向传播。
        if (pending !== null && Math.abs(value - pending) < 1) return

        const max = Math.max(0, (to.scrollWidth ?? 0) - (to.clientWidth ?? 0))
        const next = Math.min(Math.max(0, value), max)
        if (Math.abs(to.scrollLeft - next) < 1) return
        echo.set(to, next)
        to.scrollLeft = next
      }
      const onLeft = mirror(left, right)
      const onRight = mirror(right, left)
      left.addEventListener('scroll', onLeft)
      right.addEventListener('scroll', onRight)
      return () => {
        left.removeEventListener('scroll', onLeft)
        right.removeEventListener('scroll', onRight)
      }
    }

    /**
     * 生成 diff 标签正文。remote 与翻译都从闭包取，不依赖 slot 的 inject 语义
     * （只有 `useTabInfo` 是框架固定注入的 prop）。
     */
    function createDiffBody(sessions, remote, translate) {
      /**
       * 外层只做一件事：把内部渲染的任何异常变成可见的错误信息。
       *
       * 之前界面「一片空白」且没有任何线索，最可能就是内层抛异常后被框架
       * 静默吞掉。宁可显示堆栈，也不要留白。
       */
      return function DiffBody(props) {
        try {
          // 直接调用内层函数（而不是 h(DiffInner)）：
          // React 稍后才渲染子组件，外层的 try/catch 捕不到它的异常。
          return DiffInner(props)
        } catch (error) {
          const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
          return h('div', {
            style: {
              padding: '16px',
              fontSize: '11.5px',
              lineHeight: '1.6',
              color: 'var(--dsw-alias-state-error-primary)',
              background: 'var(--dsw-alias-bg-base)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              overflow: 'auto',
              height: '100%',
              boxSizing: 'border-box',
            },
          }, 'Edit Diff 渲染失败：\n' + message)
        }
      }

      function DiffInner(props) {
        const tr = translate
        const tab = (() => {
          try {
            const info = props.useTabInfo()
            return info === undefined || info === null ? undefined : info.tab
          } catch {
            return undefined
          }
        })()

        /**
         * 会话 id 有两条来源：
         *   1. slot 的 inject(sessionId) —— 正常路径
         *   2. 标签自身的导航/地址 —— 兜底
         * 只依赖 (1) 时，一旦 slot 没把 inject 结果合并进 props，页面就完全空白。
         */
        const sessionId = (() => {
          if (typeof props.sessionId === 'string' && props.sessionId.length > 0) {
            return props.sessionId
          }
          const fromAddress = parseSessionAddress(tab?.contentId ?? '')
          if (fromAddress !== undefined) return fromAddress.sessionId
          const fromParams = tab?.navigation?.params?.sessionId
          return typeof fromParams === 'string' && fromParams.length > 0 ? fromParams : undefined
        })()

        /**
         * 直接订阅投影，不依赖导航参数。
         *
         * page 标签在同一个 pane 内会自动去重：openTab 只是把已有标签聚焦，
         * 并不会替换 navigation.params —— 所以早先版本靠 params 传数据，
         * 标签一旦开过就永远读到空的参数，界面只能显示「还没有记录到改动」。
         * 投影是会话级状态，订阅它就绕开了整个参数传递问题。
         */
        const EMPTY_VIEW = { last: null, files: [] }
        const normalizeView = (v) => {
          if (v === null || typeof v !== 'object') return EMPTY_VIEW
          return {
            last: v.last ?? null,
            files: Array.isArray(v.files) ? v.files : [],
          }
        }
        const [view, setView] = useState(() => normalizeView(readProjection(sessions, sessionId)))
        useEffect(() => {
          if (sessionId === undefined) {
            setView(EMPTY_VIEW)
            return undefined
          }
          const face = projectionFace(sessions, sessionId)
          if (face === undefined) {
            setView(EMPTY_VIEW)
            return undefined
          }
          const read = () => {
            try {
              return normalizeView(face.getSnapshot())
            } catch {
              return EMPTY_VIEW
            }
          }
          setView(read())
          // 订阅是增强项：拿不到 subscribe 也不该让整个面板空掉。
          try {
            if (typeof face.subscribe === 'function') {
              return face.subscribe(() => setView(read()))
            }
          } catch {
            // 退化为一次性读取
          }
          return undefined
        }, [sessionId])

        /**
         * 文件列表只来自投影。
         *
         * 刻意不从导航参数取（params 在标签复用时可能是上一轮的旧值，
         * 这正是早期「标签只显示第一次改动」的根因，见 projection-body 测试）。
         * 但投影里的 `files` 是【本轮】集合，`turn/start` 会清空它；
         * 只剩 `last` 时就画最后一条改动，别留白。
         */
        const files = useMemo(() => {
          const fromProjection = Array.isArray(view?.files) ? view.files : []
          const list = fromProjection.length > 0
            ? fromProjection
            : view?.last
              ? [view.last]
              : []
          return list.filter(
            (f) => f !== null && typeof f === 'object' && typeof f.path === 'string',
          )
        }, [view])

        if (files.length === 0) {
          // 诊断信息：正常情况下用户看不到，但页面空白时必须能看出卡在哪一步。
          const diag = [
            'sessionId=' + String(sessionId),
            'propsKeys=' + Object.keys(props ?? {}).join(','),
            'view=' + (view === null ? 'null' : typeof view),
            'files=' + (Array.isArray(view?.files) ? view.files.length : 'n/a'),
            'loc=' + String(tr('empty')),
          ].join(' | ')
          return h('div', {
            style: {
              minHeight: '120px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              padding: '24px',
              fontSize: '12.5px',
              color: 'var(--dsw-alias-label-secondary)',
              textAlign: 'center',
              background: 'var(--dsw-alias-bg-base)',
            },
          },
            h('div', {}, (() => {
              const text = tr('empty')
              return typeof text === 'string' && text.length > 0 ? text : '本会话还没有记录到改动。'
            })()),
            h('div', {
              style: { fontSize: '10px', opacity: 0.7, wordBreak: 'break-all' },
            }, diag),
          )
        }

        // 一键折叠/展开全部。存 localStorage 记住用户偏好不必要——
        // 这是「当前视图」的操作，刷新后回到默认全展开更符合预期。
        const [allCollapsed, setAllCollapsed] = useState(false)
        // 每次「全部折叠/展开」递增，用于通知各分组丢弃自己的局部折叠状态。
        const [allToken, setAllToken] = useState(0)
        const debug = readDebugMode()

        // 每个文件一个可折叠分组。
        //
        // 根容器不用 height:100% / minHeight:0：父级高度不确定时，这两个会让
        // 整块塌成 0 高（表现就是「标签页一片空白」）。改成自然高度 + 自身滚动。
        return h('div', {
          style: {
            display: 'flex',
            flexDirection: 'column',
            maxHeight: '100%',
            overflowY: 'auto',
            background: 'var(--dsw-alias-bg-base)',
            color: 'var(--dsw-alias-label-primary)',
          },
        },
          // 工具条：一键折叠 + 文件计数
          h('div', {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '4px 10px',
              flex: 'none',
              borderBottom: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-base)',
            },
          },
            h('button', {
              type: 'button',
              'data-cline-collapse-all': true,
              'aria-expanded': allCollapsed ? 'false' : 'true',
              title: allCollapsed ? tr('expandAll') : tr('collapseAll'),
              onClick: () => {
                setAllCollapsed((v) => !v)
                setAllToken((t) => t + 1)
              },
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                padding: '2px 8px',
                fontSize: '11.5px',
                cursor: 'pointer',
                borderRadius: '5px',
                border: '1px solid var(--dsw-alias-border-l1)',
                background: 'var(--dsw-alias-bg-layer-1)',
                color: 'var(--dsw-alias-label-secondary)',
                flex: 'none',
              },
            },
              h('span', {
                'aria-hidden': true,
                style: {
                  display: 'inline-block',
                  fontSize: '10px',
                  transform: allCollapsed ? 'none' : 'rotate(90deg)',
                  transition: 'transform 120ms',
                },
              }, '▶'),
              allCollapsed ? tr('expandAll') : tr('collapseAll'),
            ),
            h('span', {
              style: {
                fontSize: '11px',
                color: 'var(--dsw-alias-label-secondary)',
                marginLeft: 'auto',
                flex: 'none',
              },
            }, tr('fileCount').replace('{n}', String(files.length))),
          ),
          h('div', {
            style: {
              flex: '1 1 auto',
              minHeight: 0,
              overflowY: 'auto',
            },
          }, files.map((entry, index) => h(FileSection, {
            key: normPath(entry.path) + '#' + index,
            entry,
            sessionId,
            revision: tab?.navigation?.revision ?? 0,
            remote,
            tr,
            debug,
            dark: readDarkTheme(),
            // 只是「默认值」：单点表头可以在局部覆盖它。
            defaultCollapsed: allCollapsed,
            // 每次点「全部折叠/展开」都换一个 token，让各分组清掉局部覆盖。
            allToken,
          }))),
        )
      }
    }

    /** 取某个会话的投影 face（可能因为会话未绑定而拿不到）。 */
    function projectionFace(sessions, sessionId) {
      try {
        const binding = sessions.binding(sessionId)
        if (binding === undefined) return undefined
        return binding.session.projections.faceOf(PROJECTION_KEY)
      } catch {
        return undefined
      }
    }

    /** 同步读一次投影当前值，供首次渲染使用。 */
    function readProjection(sessions, sessionId) {
      if (sessionId === undefined) return { last: null, files: [] }
      const face = projectionFace(sessions, sessionId)
      if (face === undefined) return { last: null, files: [] }
      try {
        return face.getSnapshot() ?? { last: null, files: [] }
      } catch {
        return { last: null, files: [] }
      }
    }

    /** 暗色主题由 ui-theme 写在 body 上；每次渲染读一次即可。 */
    function readDarkTheme() {
      try {
        return typeof document !== 'undefined' && document.body?.hasAttribute('data-ds-dark-theme') === true
      } catch {
        return false
      }
    }

    // ── 单文件分组 ──────────────────────────────────────────────────

    /**
     * 一个文件一个可折叠分组。
     * 表头只显示文件名和 +N −M（以及折叠箭头），点一下收起/展开。
     *
     * 折叠状态由外部（DiffBody 的一键折叠）控制：collapsed 是受控 prop，
     * 没有受控时退回内部 state，保证单独使用也能工作。
     */
    function FileSection(props) {
      const { entry, sessionId, revision, remote, tr, dark, debug } = props

      /**
       * 折叠状态分两层：
       *   · `defaultCollapsed` 来自「全部折叠 / 全部展开」按钮，变化时覆盖所有分组
       *   · `localOverride` 是用户单独点某个表头的结果
       * 点表头只影响自己，绝不应触发全局折叠——之前把 onToggle 直接接到
       * setAllCollapsed，导致点任意一个表头都在翻转整个列表。
       */
      const [localOverride, setLocalOverride] = useState(undefined)
      const defaultCollapsed = props.defaultCollapsed === true
      const collapsed = localOverride === undefined ? defaultCollapsed : localOverride

      // 「全部折叠」切换时清掉各分组的局部覆盖，让按钮真正生效。
      // 用 effect 而不是渲染期比较：渲染期间 setState 会触发 React 警告。
      const allToken = props.allToken
      useEffect(() => {
        setLocalOverride(undefined)
      }, [allToken])

      const toggleSelf = () => setLocalOverride((v) => !(v === undefined ? defaultCollapsed : v))

      const [text, setText] = useState(undefined)
      const [failure, setFailure] = useState(false)
      const [gone, setGone] = useState(false)
      const leftRef = useRef(null)
      const rightRef = useRef(null)

      const path = typeof entry.path === 'string' ? entry.path : ''
      const oldStr = typeof entry.oldStr === 'string' ? entry.oldStr : ''
      const newStr = typeof entry.newStr === 'string' ? entry.newStr : ''
      const command = typeof entry.command === 'string' ? entry.command : ''
      const shell = command === 'shell' || command === 'patch'
      const beforeKnown = entry.beforeKnown === true
      const beforeText = typeof entry.beforeText === 'string' ? entry.beforeText : null
      const shellAfter = typeof entry.afterText === 'string' ? entry.afterText : null

      // 折叠时【仍然】读文件：表头的 +N −M 需要最新内容才能算准。
      // 之前折叠就跳过读取，导致折叠状态下再改动，统计停在旧值。
      useEffect(() => {
        if (sessionId === undefined || path.length === 0) {
          setText(undefined)
          return undefined
        }
        if (shellAfter !== null) {
          setFailure(false)
          setGone(false)
          setText(shellAfter)
          return undefined
        }
        const lifetime = new AbortController()
        setFailure(false)
        setGone(false)
        readWholeFile(remote, sessionId, path, lifetime.signal).then(
          (value) => {
            if (!lifetime.signal.aborted) setText(value)
          },
          (error) => {
            if (lifetime.signal.aborted) return
            const message = error instanceof Error ? error.message : String(error ?? '')
            const code = error?.code ?? ''
            setGone(
              /not[_ -]?found|enoent|no such file|does not exist|not[-_ ]regular/i.test(message) ||
              /not[_ -]?found|enoent/i.test(String(code)),
            )
            setFailure(true)
            setText(undefined)
          },
        )
        return () => lifetime.abort()
      }, [sessionId, path, revision, shellAfter, collapsed])

      // 折叠时【也要】计算 rows：表头的 +N −M 依赖它。
      // 之前折叠就 return []，导致折叠状态下再改动，统计停在旧值不更新。
      // 代价只是多算一次 diff，比显示错误的数字划算。
      const rows = useMemo(() => {
        if (text === undefined) return []
        if (shell) {
          if (!beforeKnown) return []
          const before = beforeText === null ? '' : beforeText
          return toSideBySide(diffLines(before, String(text)))
        }
        const norm = (s) => String(s).replace(/\r\n/g, '\n')
        const after = norm(text)
        if (beforeKnown) {
          const before = beforeText === null ? '' : norm(beforeText)
          return toSideBySide(diffLines(before, after))
        }
        // 没有基线时退回反推。
        const target = norm(newStr)
        const original = norm(oldStr)
        let before = after
        const wholesale = command === 'create' || command === 'write' || command === 'patch'
        if (wholesale) {
          before = ''
        } else if (target.length > 0) {
          const idx = after.indexOf(target)
          before = idx >= 0 ? after.slice(0, idx) + original + after.slice(idx + target.length) : ''
        } else if (original.length > 0 && after.length === 0) {
          before = original
        }
        return toSideBySide(diffLines(before, after))
      }, [text, oldStr, newStr, shell, command, beforeKnown, beforeText, collapsed])

      // 统计直接从 rows 算；rows 现在折叠时也会更新，所以表头数字始终是最新的。
      const stats = useMemo(() => {
        let added = 0
        let removed = 0
        for (const row of rows) {
          if (row.right !== undefined && row.type !== 'eq') added++
          if (row.left !== undefined && row.type !== 'eq') removed++
        }
        return { added, removed }
      }, [rows])

      /**
       * 行号槽位的宽度按「最大行号有几位」来定，而不是写死 3.2em。
       *
       * 取左右两侧行号的并集最大值（≈ 文件行数），两栏用同一个宽度，
       * 这样左右代码文本的左边缘仍然对齐；行号变位数时槽位跟着变宽变窄。
       * `ch` 在等宽字体里正好是一个数字宽，所以几位数字就给几 ch。
       */
      const gutterWidth = useMemo(() => {
        let maxNo = 0
        for (const row of rows) {
          if (typeof row.leftNo === 'number' && row.leftNo > maxNo) maxNo = row.leftNo
          if (typeof row.rightNo === 'number' && row.rightNo > maxNo) maxNo = row.rightNo
        }
        const digits = Math.max(1, String(maxNo).length)
        return digits + 'ch'
      }, [rows])

      let notice = null
      if (collapsed) {
        notice = null
      } else if (shell) {
        notice = beforeKnown ? null : (debug ? tr('shell') : tr('noBaseline'))
      } else if (gone) {
        notice = tr('gone')
      } else if (failure) {
        notice = tr('failed')
      } else if (text === undefined) {
        notice = tr('loading')
      } else if (rows.length === 0) {
        notice = command === 'create' ? tr('created') : tr('empty')
      }

      // 最后一道保险：rows 为空且没有任何说明时，也给出中性提示。
      if (!collapsed && notice === null && rows.length === 0 && text !== undefined) {
        notice = tr('noChanges')
      }

      // 诊断兜底：本地化函数可能返回空串（locale 没绑上），
      // 那样界面就是一片空白，看不出任何信息。这里给每个分支准备硬编码文案。
      if (notice !== null && (typeof notice !== 'string' || notice.length === 0)) {
        if (failure) notice = '读取文件失败。'
        else if (gone) notice = '该文件已不存在。'
        else if (text === undefined) notice = '正在读取文件…'
        else notice = '没有可显示的差异。'
      }

      // 调试信息单独渲染在表头下方的一行小字里，
      // 绝不能写进 notice —— notice 非 null 就会替换掉整个 diff 正文，
      // 之前就是这里把 1593 行的正常内容顶掉了。
      const debugLine = debug
        ? 'rows=' + rows.length
          + ' text=' + (text === undefined ? 'undef' : String(text.length))
          + ' before=' + (beforeKnown ? (beforeText === null ? 'null' : String(beforeText.length)) : 'unknown')
          + ' cmd=' + command
          + ' shell=' + String(shell)
        : null

      // ── 表头：只有文件名 + 增删统计，点击折叠 ──
      // ── 差异跳转 ──
      // 记录当前停在哪个「差异块」（blocks 的索引），null 表示还没跳过。
      const [diffCursor, setDiffCursor] = useState(null)

      /**
       * 把连续的改动行合并成差异块（hunk）。
       *
       * 逐行跳会毁体验：一次连续新增 20 行就要按 20 次 ▼。
       * 这里只保留每块的首行，跳一次走完一整块。
       */
      const blocks = useMemo(() => {
        const out = []
        for (let i = 0; i < rows.length; i++) {
          if (rows[i].type === 'eq') continue
          let end = i
          while (end + 1 < rows.length && rows[end + 1].type !== 'eq') end++
          out.push({ start: i, end })
          i = end
        }
        return out
      }, [rows])

      // 行变了（新一次编辑）之后索引可能越界，按越界当作「没有选中块」。
      const currentBlock = diffCursor === null ? null : (blocks[diffCursor] ?? null)

      /** 滚到某个 rows 索引对应的行。 */
      const scrollToRow = (index) => {
        const node = rightRef.current
        if (node === null) return
        const target = node.querySelector(`[data-cline-side-row="${index}"]`)
        if (target === null) return
        const top = target.offsetTop - node.clientHeight / 2 + target.offsetHeight / 2
        node.scrollTop = Math.max(0, top)
      }

      /** 跳到下一块 / 上一块差异。 */
      const jump = (direction) => {
        if (blocks.length === 0) return
        const current = diffCursor === null || blocks[diffCursor] === undefined ? -1 : diffCursor
        let next
        if (direction > 0) {
          next = current < 0 ? 0 : (current + 1) % blocks.length
        } else {
          next = current <= 0 ? blocks.length - 1 : current - 1
        }
        setDiffCursor(next)
        scrollToRow(blocks[next].start)
      }

      // 差异块数量变了就校正游标：有块时至少停在第一块（指示器 x/y 从打开那一刻
      // 就有意义，不必先点一次 ▼），块数变少导致越界时回到第一块。
      useEffect(() => {
        if (blocks.length === 0) {
          if (diffCursor !== null) setDiffCursor(null)
          return
        }
        if (diffCursor === null || blocks[diffCursor] === undefined) setDiffCursor(0)
      }, [blocks, diffCursor])

      const jumpStyle = {
        flex: 'none',
        width: '18px',
        height: '18px',
        padding: '0',
        fontSize: '10px',
        lineHeight: '1',
        cursor: 'pointer',
        borderRadius: '4px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-secondary)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }

      const header = h('div', {
        'data-cline-file-header': path,
        role: 'button',
        tabIndex: 0,
        title: path,
        'aria-expanded': collapsed ? 'false' : 'true',
        onClick: toggleSelf,
        onKeyDown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggleSelf()
          }
        },
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '6px 10px',
          cursor: 'pointer',
          flex: 'none',
          userSelect: 'none',
          borderBottom: collapsed ? 'none' : '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-specific-sidebar-fill)',
        },
      },
        h('span', {
          'aria-hidden': true,
          style: {
            flex: 'none',
            width: '10px',
            fontSize: '10px',
            color: 'var(--dsw-alias-label-secondary)',
            transform: collapsed ? 'none' : 'rotate(90deg)',
            transition: 'transform 120ms',
            display: 'inline-block',
          },
        }, '▶'),
        h('span', {
          style: {
            flex: '1 1 auto',
            minWidth: 0,
            fontSize: '12px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: 'var(--dsw-alias-label-primary)',
          },
        }, baseName(path)),
        stats.added > 0
          ? h('span', {
            style: { fontSize: '11.5px', flex: 'none', color: 'var(--dsw-alias-state-success-primary)' },
          }, '+' + stats.added)
          : null,
        stats.removed > 0
          ? h('span', {
            style: { fontSize: '11.5px', flex: 'none', color: 'var(--dsw-alias-state-error-primary)' },
          }, '−' + stats.removed)
          : null,
        // 差异跳转：上一处 / 下一处。stopPropagation 避免触发表头的折叠。
        blocks.length === 0
          ? null
          : h('span', {
            style: { display: 'inline-flex', gap: '3px', flex: 'none', marginLeft: '2px', alignItems: 'center' },
          },
            h('button', {
              type: 'button',
              'data-cline-jump': 'prev',
              title: tr('prevChange'),
              'aria-label': tr('prevChange'),
              onClick: (e) => { e.stopPropagation(); jump(-1) },
              style: jumpStyle,
            }, '▲'),
            h('button', {
              type: 'button',
              'data-cline-jump': 'next',
              title: tr('nextChange'),
              'aria-label': tr('nextChange'),
              onClick: (e) => { e.stopPropagation(); jump(1) },
              style: jumpStyle,
            }, '▼'),
            // 当前块序号；没跳过时不占位。
            currentBlock === null
              ? null
              : h('span', {
                style: {
                  fontSize: '10.5px',
                  lineHeight: '1',
                  color: 'var(--dsw-alias-label-secondary)',
                  flex: 'none',
                  fontVariantNumeric: 'tabular-nums',
                },
              }, (diffCursor + 1) + '/' + blocks.length),
          ),
      )

      // ── 高亮状态（必须在任何提前 return 之前调用，否则 Hooks 顺序错乱）──
      const lang = useMemo(() => languageOf(path), [path])

      // 跨行块注释状态：逐行前进，记录每行起始是否处于注释内。
      const blockState = useMemo(() => {
        const state = new Array(rows.length).fill(false)
        if (lang === null) return state
        let inBlock = false
        for (let i = 0; i < rows.length; i++) {
          state[i] = inBlock
          const line = rows[i].left ?? rows[i].right ?? ''
          const open = line.lastIndexOf('/*')
          const close = line.lastIndexOf('*/')
          if (inBlock) {
            if (close >= 0 && open < close) inBlock = false
          } else if (open >= 0 && (close < 0 || open > close)) {
            inBlock = true
          }
        }
        return state
      }, [rows, lang])

      // 两栏联动：纵向逐行对齐，横向按「共享列位置 + 各自 max 截断」同步。
      // 必须在提前 return 之前注册（Hook 顺序要求）。
      const panesRendered = !collapsed && notice === null
      useEffect(() => {
        if (!panesRendered) return undefined
        const left = leftRef.current
        const right = rightRef.current
        if (left === null || right === null) return undefined
        const unlinkVertical = linkVerticalScroll(left, right)
        const unlinkHorizontal = linkHorizontalScroll(left, right)
        return () => {
          unlinkVertical()
          unlinkHorizontal()
        }
      }, [panesRendered, rows])

      if (collapsed) return h('div', { style: { flex: 'none' } }, header)

      // ── 渲染辅助（每个分组私有） ──
      const mono = {
        fontFamily: 'var(--ds-font-family-code, "SF Mono", "JetBrains Mono", Consolas, "Courier New", monospace)',
        fontSize: '12.5px',
        lineHeight: '1.5',
        whiteSpace: 'pre',
        WebkitFontSmoothing: 'antialiased',
        MozOsxFontSmoothing: 'grayscale',
        textRendering: 'optimizeLegibility',
      }
      const rowHeightPx = 20

      /** 有高亮的语言按 token 分段渲染；其余原样输出（空行用 NBSP 占位）。 */
      function renderText(line, inBlock) {
        if (line.length === 0) return NBSP
        if (lang === null) return line
        const parts = tokenizeLine(line, lang, inBlock === true)
        if (parts.length === 1 && parts[0].kind === null) return line
        return parts.map((part, i) => {
          const color = tokenColor(part.kind, dark)
          if (color === undefined) return part.text
          return h('span', { key: i, style: { color } }, part.text)
        })
      }

      /** 一栏里的单行：行号 + 文本。 */
      function sideCell(row, index, side) {
        const isLeft = side === 'left'
        const line = isLeft ? row.left : row.right
        const lineNo = isLeft ? row.leftNo : row.rightNo
        const present = line !== undefined
        const tint = isLeft ? 'rgba(229, 72, 77, 0.10)' : 'rgba(46, 160, 67, 0.12)'
        // 当前块的浅黄指示层：用半透明 backgroundImage 叠在红/绿底色之上，
        // 所以底色（增/删/改）依然透得出来，两套信息可以同时读。
        const marked = currentBlock !== null && index >= currentBlock.start && index <= currentBlock.end
        return h('div', {
          key: index,
          'data-cline-side-row': index,
          style: {
            display: 'flex',
            gap: '10px',
            padding: '0 8px',
            height: rowHeightPx + 'px',
            boxSizing: 'border-box',
            backgroundColor: !present
              ? 'var(--dsw-alias-bg-base)'
              : row.type === 'eq'
                ? 'var(--dsw-specific-sidebar-fill)'
                : tint,
            ...(marked
              ? { backgroundImage: 'linear-gradient(rgba(255, 199, 0, 0.26), rgba(255, 199, 0, 0.26))' }
              : {}),
          },
        },
          h('span', {
            style: {
              ...mono,
              width: gutterWidth,
              textAlign: 'right',
              flex: 'none',
              color: 'var(--dsw-alias-label-secondary)',
              // 行号与代码之间的竖分隔线（VS Code 风格）
              borderRight: '1px solid var(--dsw-alias-border-l1)',
              paddingRight: '6px',
              marginRight: '2px',
              boxSizing: 'content-box',
            },
          }, lineNo === undefined ? NBSP : String(lineNo)),
          h('span', {
            style: { ...mono, flex: 'none', color: 'var(--dsw-alias-label-primary)' },
          }, present ? renderText(line, blockState[index] === true) : NBSP),
        )
      }

      /** 一栏：列头 + 自己的滚动区（各自一条水平滚动条）。 */
      function pane(side, label, ref) {
        return h('div', {
          style: {
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
          },
        },
          h('div', {
            style: {
              padding: '4px 12px',
              fontSize: '11px',
              color: 'var(--dsw-alias-label-secondary)',
              background: 'var(--dsw-alias-bg-base)',
              borderBottom: '1px solid var(--dsw-alias-border-l1)',
              flex: 'none',
            },
          }, label),
          h('div', {
            ref,
            'data-cline-pane': side,
            style: {
              maxHeight: '60vh',
              minWidth: 0,
              overflow: 'auto',
              position: 'relative',
            },
          },
            h('div', {
              style: {
                minWidth: '100%',
                width: 'max-content',
                display: 'flex',
                flexDirection: 'column',
              },
            },
              rows.map((row, index) => sideCell(row, index, side)),
            ),
          ),
        )
      }

      const body = notice !== null
        ? h('div', {
          style: {
            padding: '16px',
            fontSize: '12px',
            color: 'var(--dsw-alias-label-secondary)',
            textAlign: 'center',
          },
        }, notice)
        : h('div', {
          style: {
            // 横向两栏；纵向高度由内容撑开（行高固定），
            // 不能用 minmax(0,1fr) —— 父级是 flex:none，1fr 会塌成 0 高度，
            // 表现就是「表头在，正文一片空白」。
            display: 'grid',
            gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)',
            columnGap: '1px',
            background: 'var(--dsw-alias-border-l1)',
          },
        },
          pane('left', tr('original'), leftRef),
          pane('right', tr('current'), rightRef),
        )

      return h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          flex: 'none',
          minHeight: 0,
          borderBottom: '1px solid var(--dsw-alias-border-l1)',
        },
      },
        header,
        debugLine === null
          ? null
          : h('div', {
            style: {
              padding: '2px 10px',
              fontSize: '10px',
              lineHeight: '1.4',
              color: 'var(--dsw-alias-label-secondary)',
              background: 'var(--dsw-alias-bg-layer-2)',
              wordBreak: 'break-all',
              flex: 'none',
            },
          }, debugLine),
        body,
      )
    }

    // ── 插件体 ──────────────────────────────────────────────────────

    return {
      inject: ['slots', 'locale', 'sessions', 'sidebarRight', 'sidebarRightTabs', 'remote', 'remote.workspaceFiles'],
      apply(ctx) {
        const sessions = ctx.sessions
        const sidebarRight = ctx.sidebarRight
        const remote = ctx.remote
        const following = new Map()
        const lastDiffAt = new Map()
        /** 已经为哪些会话打开过 diff 标签（off 模式下据此决定是否刷新）。 */
        const diffOpened = new Set()
        const t = ctx.locale.bind('editDiff')

        ctx.effect(() => ctx.locale.register('editDiff', { en, zh }), 'dsh-edit-diff: copy')

        // 纵向滚动条只保留两栏中间那一条：右栏的竖条用 CSS 隐掉（滚动能力不变，
        // 仍由纵向联动驱动）。横向条两栏都保留，长行各自平移。
        // 用样式表而不是行内样式，是因为隐藏滚动条只能靠 ::-webkit-scrollbar。
        ctx.effect(() => {
          if (typeof document === 'undefined') return undefined
          if (typeof document.createElement !== 'function') return undefined
          if (document.head === undefined || document.head === null) return undefined
          try {
            const style = document.createElement('style')
            style.setAttribute('data-dsh-edit-diff', 'scrollbars')
            style.textContent =
              '[data-cline-pane="right"]::-webkit-scrollbar:vertical{width:0;height:0}'
            document.head.appendChild(style)
            return () => { style.remove() }
          } catch {
            // 没有 DOM（测试/SSR 环境）就跳过，纯样式增强项
            return undefined
          }
        }, 'dsh-edit-diff: single vertical scrollbar')

        // 设置项：自动打开行为。渲染在「设置 → 通用」里的一行。
        /** 设置行的小工具：左侧标签 + 右侧控件。 */
        function row(label, control) {
          return h('div', {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              width: '100%',
              minWidth: 0,
              padding: '6px 0',
            },
          },
            h('span', {
              style: {
                fontSize: '13px',
                color: 'var(--dsw-alias-label-primary)',
                flex: '1 1 auto',
                minWidth: 0,
              },
            }, label),
            control,
          )
        }

        const controlStyle = {
          fontSize: '12.5px',
          padding: '4px 8px',
          borderRadius: '6px',
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-layer-1)',
          color: 'var(--dsw-alias-label-primary)',
          flex: 'none',
        }

        function FollowSetting() {
          const [mode, setMode] = useState(() => readFollowMode())
          const tr2 = (key) => (typeof t === 'function' ? t(key) : key)
          const options = [
            ['always', tr2('followAlways')],
            ['turn', tr2('followTurn')],
            ['off', tr2('followOff')],
          ]
          return row(tr2('follow'), h('select', {
            value: mode,
            'aria-label': tr2('follow'),
            onChange: (e) => {
              const next = e.target.value
              setMode(next)
              writeFollowMode(next)
            },
            style: controlStyle,
          }, options.map(([value, label]) => h('option', { key: value, value }, label))))
        }

        function DebugSetting() {
          const [on, setOn] = useState(() => readDebugMode())
          const tr2 = (key) => (typeof t === 'function' ? t(key) : key)
          return row(tr2('debug'), h('input', {
            type: 'checkbox',
            checked: on,
            'aria-label': tr2('debug'),
            onChange: (e) => {
              const next = e.target.checked
              setOn(next)
              writeDebugMode(next)
            },
            style: { flex: 'none', width: '16px', height: '16px', cursor: 'pointer' },
          }))
        }

        function NativeSetting() {
          const [on, setOn] = useState(() => readNativeOpen())
          const tr2 = (key) => (typeof t === 'function' ? t(key) : key)
          return row(tr2('nativePreview'), h('input', {
            type: 'checkbox',
            checked: on,
            'aria-label': tr2('nativePreview'),
            onChange: (e) => {
              const next = e.target.checked
              setOn(next)
              writeNativeOpen(next)
            },
            style: { flex: 'none', width: '16px', height: '16px', cursor: 'pointer' },
          }))
        }

        // 设置放在【插件自己的详情页】里，而不是塞进通用设置。
        //
        // `plugins.row.config` 的 key 是 `<包名>#<行 id>`：注册它之后，
        // 插件页那一行会多出一个「配置」入口，点开就是这个组件的内容。
        // 这样插件的选项归属清晰，不会污染全局设置页。
        function PluginSettings() {
          return h('div', {
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
              width: '100%',
              minWidth: 0,
            },
          },
            h(FollowSetting, {}),
            h(NativeSetting, {}),
            h(DebugSetting, {}),
          )
        }

        const configKey = 'dsh-edit-diff#dsh-edit-diff'
        ctx.effect(() => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: configKey,
          locale: 'editDiff',
        }, PluginSettings)), 'dsh-edit-diff: plugin settings page')

        // 1) page 类型：并排 diff 标签（不接管任何文件扩展名）
        //
        // 刻意【不】声明 multiple：普通 page 标签在同一个 pane 内自动去重，
        // 每次 openTab 只是把同一个标签的 navigation.params 换成新文件，
        // 这正是我们要的「一个 diff 标签，始终跟随最新改动」。
        // 若声明 multiple:true，每次 openTab 都会新开实例，同一文件连续编辑
        // 会堆出一排重复标签，而且 revealIfOpened:false 对它不生效。
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: KIND,
          title: () => 'Edit Diff',
        }), 'dsh-edit-diff: diff tab type')

        const DiffBody = createDiffBody(sessions, remote, (key) => (typeof t === 'function' ? t(key) : key))
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          locale: 'editDiff',
          // slot 的 inject 按会话作用域调用，把 sessionId 直接交给组件：
          // body 靠它订阅投影，不依赖导航参数（参数在标签复用时不会刷新）。
          inject: (sessionId) => ({ sessionId }),
        }, DiffBody)), 'dsh-edit-diff: diff body')

        // 2) 跟随：打开原生预览（高亮保留）+ 并排 diff 标签
        function openNative(sessionId, value) {
          const row = sessions.list.getSnapshot().byId[sessionId]
          const cwd = row === undefined ? undefined : row.cwd
          const address = fileAddress(sessionId, cwd, value.path)
          const open = (line) => {
            const options = line === null || line === undefined ? {} : { params: { line } }
            try {
              sidebarRight.openResource(address, options)
            } catch (err) {
              ctx.logger?.warn?.('[dsh-edit-diff] openResource failed:', err)
            }
          }
          open(value.line)
          if (value.line === null && value.command !== 'shell' && value.newStr) {
            locateLine(remote, sessionId, value.path, value.newStr)
              .then((line) => { if (line !== null && line !== undefined) open(line) })
              .catch(() => {})
          }
        }

        /**
         * 打开/刷新 diff 标签。
         *
         * 同一个 Edit Diff 标签承载本轮所有改动文件：每个文件一个可折叠分组。
         * 所以这里不再为每个文件开标签，而是把所有文件塞进一次 openTab 的 params。
         *
         * @param files - 本轮改动过的全部文件（wire view 的 files）。
         * @param value - 触发这次刷新的那一条（用来决定跳转行）。
         * @param requestFocus - 是否把标签推到用户面前。
         */
        function openDiff(sessionId, files, value, requestFocus = true) {
          const now = Date.now()
          const previous = lastDiffAt.get(sessionId)
          const burst = previous !== undefined && now - previous < DIFF_FOCUS_THROTTLE_MS
          lastDiffAt.set(sessionId, now)
          const reveal = requestFocus && !burst
          try {
            // 每个文件都带上基线与改动后内容，让标签能在一次渲染里画出全部分组。
            // params 会进侧栏布局存档，所以只带中小文件；超限的退回读磁盘。
            const packed = files.map((f) => {
              const carry = f.beforeKnown === true &&
                (f.beforeText === null || f.beforeText.length <= MAX_CARRY_BEFORE)
              return {
                path: normPath(f.path),
                command: f.command,
                line: f.line,
                oldStr: f.oldStr,
                newStr: f.newStr,
                ts: f.ts,
                ...(carry ? { beforeKnown: true, beforeText: f.beforeText } : {}),
                ...(typeof f.afterText === 'string' && f.afterText.length <= MAX_CARRY_BEFORE
                  ? { afterText: f.afterText }
                  : {}),
              }
            })
            sidebarRight.openTab(KIND, {
              params: {
                sessionId,
                files: packed,
                // 兼容单文件路径：body 会优先用 files。
                path: normPath(value.path),
                command: value.command,
                line: value.line,
                oldStr: value.oldStr,
                newStr: value.newStr,
                ts: value.ts,
              },
              ...(reveal ? {} : { revealIfOpened: false }),
            })
            diffOpened.add(sessionId)
          } catch (err) {
            ctx.logger?.warn?.('[dsh-edit-diff] openTab failed:', err)
          }
        }

        function follow(sessionId) {
          if (following.has(sessionId)) return
          let binding
          try {
            binding = sessions.binding(sessionId)
          } catch {
            return
          }
          if (binding === undefined) return

          const face = binding.session.projections.faceOf(PROJECTION_KEY)
          let lastTs = face.getSnapshot()?.last?.ts
          // 每轮是否已经自动打开过（"turn" 模式用）。
          let openedThisTurn = false
          // 已经为哪些 (路径, ts) 开过标签，避免同一改动重复打开。
          const seen = new Set()

          const unsubscribe = face.subscribe(() => {
            // wire view 现在是 { last, files }：last 驱动跳转，files 是本轮改过的全部文件。
            const view = face.getSnapshot()
            if (view === null || view === undefined) return
            const value = view.last
            if (value === null || value === undefined) return
            if (lastTs === value.ts) return

            // 新一轮：改动时间戳变小说明列表被重置过（turn/start 清空 turnFiles），
            // 允许再自动聚焦一次。
            if (lastTs !== undefined && value.ts < lastTs) {
              openedThisTurn = false
              seen.clear()
            }
            lastTs = value.ts
            if (Date.now() - value.ts > MAX_AGE_MS) return

            const mode = readFollowMode()
            const files = view.files ?? []

            // 同一个 Edit Diff 标签承载全部文件：只调用一次 openTab，
            // 把所有文件塞进 params，由标签内部渲染成可折叠分组。
            if (mode === 'off') {
              if (diffOpened.has(sessionId) && files.length > 0) {
                openDiff(sessionId, files, value, false)
              }
              return
            }

            const focus = mode === 'always' || !openedThisTurn
            openDiff(sessionId, files.length > 0 ? files : [value], value, focus)

            if (focus) {
              openedThisTurn = true
              // 只有显式打开时才去开原生预览；关掉后 diff 标签照样弹、照样抢焦点。
              if (readNativeOpen()) openNative(sessionId, value)
            }
          })
          following.set(sessionId, unsubscribe)
        }

        function unfollow(sessionId) {
          const unsubscribe = following.get(sessionId)
          if (unsubscribe !== undefined) {
            unsubscribe()
            following.delete(sessionId)
          }
        }

        function sync() {
          const byId = sessions.list.getSnapshot().byId
          for (const id of Object.keys(byId)) follow(id)
          for (const id of [...following.keys()]) if (byId[id] === undefined) unfollow(id)
        }

        ctx.effect(() => {
          const stopList = sessions.list.subscribe(sync)
          sync()
          return () => {
            stopList()
            for (const id of [...following.keys()]) unfollow(id)
          }
        }, 'dsh-edit-diff: client subscription')

        ctx.logger?.info?.('[dsh-edit-diff] client face loaded (no document renderer override)')
      },
    }
  },
})
