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
     * 占位用的不换行空格。
     * 空字符串的 span 高度是 0，会让该行塌陷、与对侧行错位；
     * 用 NBSP 保证「留空的单元格」仍然占一行高度（VS Code 的 diff 同样留白占位）。
     */
    const NBSP = '\u00A0'

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
     * 只同步 scrollTop：横向滚动是两栏独立的。
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
     * 生成 diff 标签正文。remote 与翻译都从闭包取，不依赖 slot 的 inject 语义
     * （只有 `useTabInfo` 是框架固定注入的 prop）。
     */
    function createDiffBody(remote, translate) {
      return function DiffBody(props) {
        const tr = translate
        const useTabInfo = props.useTabInfo
      const info = useTabInfo()
      const tab = info === undefined || info === null ? undefined : info.tab
      const params = tab?.navigation?.params ?? {}
      const revision = tab?.navigation?.revision ?? 0

      const [text, setText] = useState(undefined)
      const [failure, setFailure] = useState(false)
      const [gone, setGone] = useState(false)
      const leftRef = useRef(null)
      const rightRef = useRef(null)
      const parsed = useMemo(() => parseSessionAddress(tab?.contentId ?? ''), [tab?.contentId])

      const path = params.path ?? (parsed === undefined ? '' : parsed.path)
      const sessionId = parsed === undefined ? params.sessionId : parsed.sessionId
      const oldStr = typeof params.oldStr === 'string' ? params.oldStr : ''
      const newStr = typeof params.newStr === 'string' ? params.newStr : ''
      const command = typeof params.command === 'string' ? params.command : ''
      const shell = command === 'shell' || command === 'patch'

      useEffect(() => {
        if (sessionId === undefined || path === undefined || path.length === 0) {
          setText(undefined)
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
            // 文件被删除或移动是 shell 路径的正常结果，不该报成「读取失败」。
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
      }, [sessionId, path, revision])

      const rows = useMemo(() => {
        if (text === undefined || shell) return []
        // 行尾符不参与 diff 语义，但会破坏 indexOf 定位（Host 记录的 \n 对上磁盘的 \r\n）。
        // 两侧统一成 \n 再比较，消掉这一类假阴性。
        const norm = (s) => String(s).replace(/\r\n/g, '\n')
        const after = norm(text)
        const target = norm(newStr)
        const original = norm(oldStr)

        let before = after
        // 整体写入类操作（create/write/patch）语义就是「整份文件都是新增」：
        // oldStr 为空，不应靠 indexOf 反推，否则尾部换行等细微差异会算出残行。
        const wholesale = command === 'create' || command === 'write' || command === 'patch'
        if (wholesale) {
          before = ''
        } else if (target.length > 0) {
          const idx = after.indexOf(target)
          if (idx >= 0) {
            before = after.slice(0, idx) + original + after.slice(idx + target.length)
          } else {
            // 定位失败：宁可显示为「全部新增」，也不假装两边一样。
            before = ''
          }
        } else if (original.length > 0 && after.length === 0) {
          before = original
        }
        return toSideBySide(diffLines(before, after))
      }, [text, oldStr, newStr, shell, command])

      const stats = useMemo(() => {
        let added = 0
        let removed = 0
        for (const row of rows) {
          if (row.right !== undefined && row.type !== 'eq') added++
          if (row.left !== undefined && row.type !== 'eq') removed++
        }
        return { added, removed }
      }, [rows])

      // 纵向联动：左右两栏的行数一致，滚一边另一边跟着走，横向各自独立。
      //
      // 依赖 panesRendered 而不是 []：内容还没加载完时两栏根本没渲染，ref 是 null，
      // 空依赖的 effect 会在那时跑一次就再也不会补挂监听。
      const panesRendered = !shell && !gone && !failure && text !== undefined
      useEffect(() => {
        if (!panesRendered) return undefined
        const left = leftRef.current
        const right = rightRef.current
        if (left === null || right === null) return undefined
        return linkVerticalScroll(left, right)
      }, [panesRendered])

      // 跳行：把改动行滚到两栏中间（横向保持不动）。
      useEffect(() => {
        const nodes = [leftRef.current, rightRef.current]
        if (nodes.includes(null) || rows.length === 0) return
        const { first } = changedSpan(rows, 'right')
        for (const node of nodes) {
          const target = node.querySelector(`[data-cline-side-row="${first}"]`)
          if (target === null) continue
          const top = target.offsetTop - node.clientHeight / 2 + target.offsetHeight / 2
          node.scrollTop = Math.max(0, top)
        }
      }, [rows])

      const mono = {
        // 用 dsh 的 code 字体 token（设置里「代码字体」改的就是它），
        // 不再自己写栈：之前用的 --dsw-font-mono 并不存在，一直在走兜底。
        fontFamily: 'var(--ds-font-family-code, "SF Mono", "JetBrains Mono", Consolas, "Courier New", monospace)',
        fontSize: '12.5px',
        // VS Code 的行高是 1.5，且开启亚像素抗锯齿后字形更柔；
        // 这里同时给平滑相关属性，减轻小字号下的「锋利」观感。
        lineHeight: '1.5',
        whiteSpace: 'pre',
        WebkitFontSmoothing: 'antialiased',
        MozOsxFontSmoothing: 'grayscale',
        textRendering: 'optimizeLegibility',
      }
      // 行高用像素固定：两栏逐行对齐依赖它，不能让内容为空时塌陷。
      // 12.5px × 1.5 = 18.75 → 取 20 留出余量，避免抗锯齿后字形被裁。
      const rowHeightPx = 20

      // 高亮语言按文件后缀决定；未知后缀保持纯文本。
      const lang = useMemo(() => languageOf(path), [path])

      // 跨行块注释状态：逐行前进，记录每行起始是否处于注释内。
      // 按行词法无法自行知道上一行状态，所以先整体扫一遍。
      const blockState = useMemo(() => {
        const state = new Array(rows.length).fill(false)
        if (lang === null) return state
        let inBlock = false
        for (let i = 0; i < rows.length; i++) {
          state[i] = inBlock
          const line = lang === null ? '' : (rows[i].left ?? rows[i].right ?? '')
          const open = line.lastIndexOf('/*')
          const close = line.lastIndexOf('*/')
          if (inBlock) {
            if (close >= 0 && (open < close)) inBlock = false
          } else if (open >= 0 && (close < 0 || open > close)) {
            inBlock = true
          }
        }
        return state
      }, [rows, lang])

      // 暗色主题由 ui-theme 写在 body 上（body[data-ds-dark-theme]）。
      // 订阅主题变化，明暗切换时重新取色。
      const [dark, setDark] = useState(
        () => typeof document !== 'undefined' && document.body?.hasAttribute('data-ds-dark-theme') === true,
      )
      useEffect(() => {
        if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return undefined
        const read = () => setDark(document.body?.hasAttribute('data-ds-dark-theme') === true)
        read()
        const observer = new MutationObserver(read)
        observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
        return () => observer.disconnect()
      }, [])

      /** 一栏里的单行：行号 + 文本。 */
      function sideCell(row, index, side) {
        const isLeft = side === 'left'
        const text = isLeft ? row.left : row.right
        const lineNo = isLeft ? row.leftNo : row.rightNo
        const present = text !== undefined
        const tint = isLeft ? 'rgba(229, 72, 77, 0.10)' : 'rgba(46, 160, 67, 0.12)'
        // 对侧缺失时留空，但必须占一行高度：空字符串会让行高塌成 0，
        // 导致下面的行与另一栏逐行错位（VS Code 的 diff 也是留空占位）。
        return h('div', {
          key: index,
          'data-cline-side-row': index,
          style: {
            display: 'flex',
            gap: '10px',
            padding: '0 8px',
            height: rowHeightPx + 'px',
            boxSizing: 'border-box',
            background: !present
              ? 'var(--dsw-alias-bg-base)'
              : row.type === 'eq'
                ? 'var(--dsw-specific-sidebar-fill)'
                : tint,
          },
        },
          h('span', {
            style: { ...mono, width: '3.2em', textAlign: 'right', flex: 'none', color: 'var(--dsw-alias-label-secondary)' },
          }, lineNo === undefined ? NBSP : String(lineNo)),
          h('span', {
            style: { ...mono, flex: 'none', color: 'var(--dsw-alias-label-primary)' },
          }, present ? renderText(text, blockState[index] === true) : NBSP),
        )
      }

      /** 有高亮的语言按 token 分段渲染；其余原样输出（空行用 NBSP 占位）。 */
      function renderText(text, inBlock) {
        if (text.length === 0) return NBSP
        if (lang === null) return text
        const parts = tokenizeLine(text, lang, inBlock === true)
        if (parts.length === 1 && parts[0].kind === null) return text
        return parts.map((part, i) => {
          const color = tokenColor(part.kind, dark)
          if (color === undefined) return part.text
          return h('span', { key: i, style: { color } }, part.text)
        })
      }

      /** 一栏：列头 + 自己的滚动区（各自一条水平滚动条）。 */
      function pane(side, label, ref) {
        return h('div', {
          style: {
            display: 'flex',
            flexDirection: 'column',
            // 固定占 1fr 的一半，且 overflow:hidden 保证内容再宽也不会把栏顶大 ——
            // 溢出必须由内层滚动区消化。
            minWidth: 0,
            minHeight: 0,
            overflow: 'hidden',
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
            // position:relative 让行的 offsetTop 相对这个滚动容器计算（跳行定位依赖它）。
            style: { flex: '1 1 auto', minWidth: 0, minHeight: 0, overflow: 'auto', position: 'relative' },
          },
            h('div', {
              // 宽度交给浏览器按真实字形量（max-content），不再用字符数估算 ——
              // 全角、制表符、宽字符都能算对。内容比栏窄时由 minWidth 铺满。
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

      const header = h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '8px 12px',
          borderBottom: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-specific-sidebar-fill)',
          flex: 'none',
        },
      },
        h('span', {
          style: {
            fontSize: '12px',
            color: 'var(--dsw-alias-label-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          },
          title: path,
        }, baseName(path)),
        h('span', { style: { fontSize: '11.5px', color: 'var(--dsw-alias-state-success-primary)', flex: 'none' } }, '+' + stats.added),
        h('span', { style: { fontSize: '11.5px', color: 'var(--dsw-alias-state-error-primary)', flex: 'none' } }, '−' + stats.removed),
      )

      let notice = null
      if (shell) {
        notice = tr('shell')
      } else if (gone) {
        notice = tr('gone')
      } else if (failure) {
        notice = tr('failed')
      } else if (text === undefined) {
        notice = tr('loading')
      } else if (rows.length === 0) {
        notice = command === 'create' ? tr('created') : tr('empty')
      }

      return h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          minHeight: 0,
          background: 'var(--dsw-alias-bg-base)',
          color: 'var(--dsw-alias-label-primary)',
        },
      },
        header,
        notice === null
          ? h('div', {
            style: {
              flex: '1 1 auto',
              minHeight: 0,
              display: 'grid',
              // 两栏严格等分；minmax(0,…) 允许子项被压缩，配合每栏的 overflow:hidden
              // 保证内容再宽也不会改变列宽（横向滚动发生在栏内）。
              gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)',
              gridTemplateRows: 'minmax(0,1fr)',
              columnGap: '1px',
              background: 'var(--dsw-alias-border-l1)',
            },
          },
            pane('left', tr('original'), leftRef),
            pane('right', tr('current'), rightRef),
          )
          : h('div', {
            style: {
              flex: '1 1 auto',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '24px',
              fontSize: '12.5px',
              color: 'var(--dsw-alias-label-secondary)',
              textAlign: 'center',
            },
          }, notice),
      )
      }
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
        const t = ctx.locale.bind('editDiff')

        ctx.effect(() => ctx.locale.register('editDiff', { en, zh }), 'dsh-edit-diff: copy')

        // 1) page 类型：并排 diff 标签（不接管任何文件扩展名）
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: KIND,
          title: () => 'Edit Diff',
        }), 'dsh-edit-diff: diff tab type')

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          locale: 'editDiff',
        }, createDiffBody(remote, (key) => (typeof t === 'function' ? t(key) : key)))), 'dsh-edit-diff: diff body')

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

        function openDiff(sessionId, value) {
          // 同一会话的连续编辑只保留一个 diff 标签（page 类型在同一 pane 内去重），
          // 但每次重新聚焦会打断用户，所以对短时间内的连击做节流。
          const now = Date.now()
          const previous = lastDiffAt.get(sessionId)
          if (previous !== undefined && now - previous < DIFF_FOCUS_THROTTLE_MS) return
          lastDiffAt.set(sessionId, now)
          try {
            sidebarRight.openTab(KIND, {
              params: {
                path: normPath(value.path),
                sessionId,
                command: value.command,
                line: value.line,
                oldStr: value.oldStr,
                newStr: value.newStr,
                ts: value.ts,
              },
            })
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
          let lastTs = face.getSnapshot()?.ts
          const unsubscribe = face.subscribe(() => {
            const value = face.getSnapshot()
            if (value === null || value === undefined) return
            if (lastTs === value.ts) return
            lastTs = value.ts
            if (Date.now() - value.ts > MAX_AGE_MS) return
            openNative(sessionId, value)
            openDiff(sessionId, value)
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
