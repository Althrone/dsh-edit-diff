# dsh-edit-diff

跟随 AI 的改动，并排展示 diff，**不破坏内置的语法高亮与 Markdown 渲染**。

English | 中文

![icon.svg](icon.svg)

## 为什么要重做

`dsh-follow-edits` 会在 Sidebar 预览里把改动的行标黄、删除的内容标红，但它的做法是：

```js
ctx.documentPreviews.register({
  extensions: ['ts','md','py', ... 约 60 个文本后缀],
  priority: 'extension',   // ← 这个 band 压过内置的 code / markdown 渲染器
  ...
})
```

`sidebar.right.tab.document` 是按实现 id 分发的 keyed slot，渲染器按
`extension > builtin > fallback` 的优先级排序。于是这个纯文本渲染器**顶替**了内置的
代码渲染器和 Markdown 渲染器 —— 结果是：

- 代码没有语法高亮
- Markdown 不再渲染，只显示原始文本

而内置的文档预览**没有提供逐行装饰（decoration）的扩展点**，插件能改的只有「换掉整个渲染器」。
所以「在原生预览里高亮 diff」这条路在当前 dsh 里走不通。

## 本插件的做法

插件**从不注册 `documentPreviews` 渲染器**，改用两条互不干扰的路径：

| 路径 | 机制 | 结果 |
|---|---|---|
| 原生预览跟随 | `ctx.sidebarRight.openResource(address, { params: { line } })` | 用内置渲染器打开文件，高亮/Markdown 全部保留，并跳到改动行 |
| 并排 diff | 注册独立的 page 类型 `editDiff.tab` | 左「修改前」右「修改后」，行级 +/− 着色 + 语法高亮 |

因为 diff 是一个**独立的 page 标签**（不声明 `patterns`，不接管任何扩展名），它和内置预览
并存，互不影响。

## 语法高亮

diff 标签自带一个轻量词法高亮器（`LANGS` / `tokenizeLine`），支持 C/C++、JS/TS、Python、
Rust、Shell、JSON，**零依赖**：

- 内置预览的高亮来自 `ui-primitives` 的 `CodeBlock`，而插件规范禁止 `require` 那个包
  （它会随时改版、且没有类型检查）
- 实现方式是「先标记字符串/注释等受保护区间，再在区间外匹配关键字与数字」，
  避免把字符串里的 `if` 染成关键字
- 明暗两套配色，跟随 `body[data-ds-dark-theme]` 实时切换
- 按行分词，不追求跨行状态（字符串/块注释不回渗），对 diff 阅读足够
- **每行分词后必须无损还原原文**，有测试锁住这条

未知后缀不高亮，保持纯文本。

## 改动从哪里来

Host 半（`index.js`）用一个 `sessionProjections` 单元记录改动，通过 `wire.view` 推给 Client：

- **编辑工具**（`edit` / `write` / `str_replace_editor` / `multi_edit` / `apply_patch`）：
  折叠 `tool/call` + `tool/result`。
- **shell / 脚本命令**（`pwsh` / `bash` 等）：`tools/pre-execute` 对**所有工具**都触发，
  所以命令执行**之前**会先从命令文本里解析出可能被写入的文件（`extractCommandPaths`），
  抢在原文消失前快照。解析是启发式的：按空白与常见分隔符切词，取像路径的 token
  （有已知文本扩展名，或带目录分隔符），忽略 URL、开关参数和二进制后缀。
  宁可多快照几个，也不漏掉真正被改的。

### 为什么不能真正做到「任意手段全覆盖」

`fs.watch` 是**事后通知**：命令跑完、文件已改写才触发。想拿到改动前的内容，
只能在命令执行前主动快照。而 shell 命令是黑盒——插件看不到它到底会碰哪些文件，
只能靠命令文本猜。所以：

| 情况 | 能否对比 |
|---|---|
| 命令里写着目标文件路径 | ✅ |
| 路径在脚本内部（如 `python gen.py` 写别的文件） | ⚠️ 只能快照 `gen.py` 本身 |
| 路径由变量拼接、运行时才确定 | ❌ |
| 命令完全不含路径（`make`、`npm run build`） | ❌ 只能事后捕获，无基线 |

### 修改前的内容是真实读取的

被删的内容在编辑后就不在文件里了，所以 `tools/pre-execute`（改之前）会**把整个文件读一遍**
存下来，作为 diff 的「修改前」基线。这比早期版本靠 `indexOf(newStr)` 反推可靠得多：

| 场景 | 只有反推 | 有基线 |
|---|---|---|
| 普通 `edit` | ✅ | ✅ |
| `write` 覆盖已有文件 | ❌ 看不到原文 | ✅ |
| 文件行尾符被改过 | ❌ 反推失败退化成全新增 | ✅ |
| 编辑后再被外部改动 | ❌ 定位不到 | ✅ |

只有拿不到基线时（读文件失败、或超过 2 MiB）才退回反推。

### 一轮之内持续对比最初版本

同一文件在一轮里常被连续编辑多次。插件按会话记住每个文件**本轮首次编辑前**的内容
（`turnBaseline`），后续编辑都对比这一份，用户看到的是整轮累积的完整对比，
而不是「上一次 → 这一次」的碎片。

`agent/turn-stopping` 时清空该会话的基线，下一轮重新取——所以每轮都是一次独立完整的对比。

### 自动弹出 + 持续刷新

- **首次编辑**：弹出侧栏、打开原生预览跳到改动行、并打开 diff 标签（会抢焦点）
- **连续编辑**（700ms 内）：复用同一个 diff 标签刷新内容，用 `revealIfOpened: false`
  更新但不抢焦点，避免打断用户
- diff 标签每次拿到新导航都会重读磁盘，所以右栏始终是最新内容

## 安装

```text
plugin_manager  action: install_bundle  target: <你的路径>/dsh-edit-diff
```

安装后把旧的 `dsh-follow-edits` 关掉，否则它仍会顶替内置渲染器：

```text
plugin_manager  action: set_bundle  target: dsh-follow-edits  enabled: false
```

本插件**没有运行时依赖**（不依赖 `zod`）：链接安装的目录解析不到 profile 的
`node_modules`，任何外部依赖都会让 host 半 import 失败。

## 验证

```text
node test/host.test.mjs        # 工具参数解析、投影状态机、schema 垫片
node test/diff.test.mjs        # 行 diff 与并排配对（增/删/改/重复行）
node test/real-tools.test.mjs  # 用真实工具 schema 驱动投影
node test/real-file.test.mjs   # 对真实文件还原「修改前」并比对
node test/shell-watch.test.mjs # fs.watch 能否捕获删除
node test/sync.test.mjs        # 左右纵向滚动联动、防递归、横向独立
node test/highlight.test.mjs   # 词法高亮：关键字/类型/字符串/注释/无损还原
node test/client.test.mjs      # client factory 装载、slot 注册、不碰 documentPreviews
```

## 已知取舍

- **diff 标签是独立页面**，不会嵌在原生预览里 —— 原生预览没有装饰扩展点，这是唯一不破坏高亮的选择。
- **新建文件**只能看到「新增」，没有「修改前」一侧。
- **shell 改动**没有 before/after 内容，只做跟随打开。
- **高亮是按行词法**，跨行的块注释/多行字符串不会连续着色；只覆盖 6 类语言，其余后缀按纯文本显示。
- **删除动作没有独立视图** —— 删除后文件不存在，diff 标签只显示「文件已不存在」。
- 原生预览跳行：Markdown 渲染器不支持行锚点，只有纯文本和代码渲染器会响应 `line`。
