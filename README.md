# UNagent

**A mobile-first AI assistant for Obsidian — lightweight and self-contained on phones and tablets, and equally complete on desktop.**

[中文文档](#中文文档)

Plugin id `unagent`, display name "UNagent", by UNcore. Everything the plugin does is either in-plugin JavaScript or a remote HTTP call: native `fetch` with hand-written SSE, no LLM SDK, and **zero local processes on mobile**. On desktop there is exactly one extra capability — `run_command` (local shell execution). See [Boundaries and security](#boundaries-and-security) for what each tool touches and the confirmations it asks for.

## Quick start (BYO API key)

You supply your own model API key. Nothing is bundled, nothing is proxied through us.

### 1. Install

Manual install for now — drop the three build artifacts into your vault:

```
<your vault>/.obsidian/plugins/unagent/
├── main.js
├── manifest.json
└── styles.css
```

Then enable **UNagent** in Settings → Community plugins, and open it from the ✨ ribbon icon or the "Open UNagent chat" command.

### 2. Add a model profile

Settings → UNagent → **Models** → "+ Add provider":

1. **API protocol** — OpenAI-compatible / Anthropic / OpenAI Responses. Picking one pre-fills the default base URL.
2. **API base URL** — no `/chat/completions` suffix (the default is already filled in, and you can change it freely).
3. **API key** — your provider key (the eye button toggles visibility).

Below that is the **model list**: type a model name and press Enter (suggestions are fetched from the API). Several providers and protocols can coexist; `/model` switches the model for the current conversation.

### 3. Chat

Just ask: "search my notes about reading and summarize them", "add a #work tag to Project plan". The assistant streams its answer and calls tools to read and write notes and folders as needed.

- In **default** and **auto** modes, create/edit tools run first and then appear as a file card you accept or reject (edits come with a diff).
- Move and delete ask **before** they run; `delete_note` and `delete_folder` always ask, in every approval mode.
- `run_command`'s provably read-only commands skip the prompt (can be turned off in Settings → Security); everything else asks every time.
- Note edits/deletes and folder create/delete leave an undo snapshot — the "Undo" button at the top restores it.

The plugin is fully usable at this point. MCP is optional and adds nothing you need for the basics.

## Capabilities (identical on mobile and desktop)

| Capability | Notes |
|---|---|
| Streaming chat | Token-by-token output, stop at any time, friendly errors with retry. Multiple providers/protocols at once, `/model` to switch model, `/think <level>` for reasoning effort (bare `/think` opens the same panel), `/search <level>` for the retrieval mode. The row under the input holds the conversation title (opens conversation management) and the model button (opens the "model · reasoning · retrieval" panel). On phones that row hides while the keyboard is up, leaving only the input. |
| Retrieval modes | A per-conversation knob with five positions: **search off** (neither vault nor web), **auto** (default; the model decides), **notes only**, **web only**, **web + notes**. The mode is a **hard boundary**: retrieval tools for a disabled channel are removed from that turn's tool table (note read/write tools are unaffected), and the system prompt states the requirement for the turn. Web search goes through remote MCP services (exa / bailian-websearch are pre-configured; their keys are never bundled), plus the built-in `fetch_url`. |
| 24 tools (25 on desktop) | The assistant reads, searches and writes your notes and folders, reads office documents and PDFs, and can run command-palette commands. Approval behaviour per tool is listed below. `run_command` is desktop-only, so mobile sees 24 tools. |
| Skills | Plain-text `SKILL.md` guides, loaded with `//skill-name` or by the model through `load_skill`. Skills **never execute code**. The built-in skills' catalog lines are bilingual (Chinese/English) and follow the UI language; user skills can provide `description_en` and a sibling `SKILL.en.md`. |
| Hybrid search | Keyword + metadata is the primary channel; semantic search is optional (remote embeddings, local vector cache only). |
| Image generation | `generate_image` writes into the vault; the folder is configurable (Settings → General → "AI image folder"). |
| Ebooks | `book_read` reads .epub / .fb2 / .mobi / .azw3 / .txt — table of contents first, then chapter-by-chapter Markdown. DRM-protected books and .azw/.pdf are not supported (convert with Calibre). Read-only: editing books is out of scope. |
| Office documents and PDF | `read_document` reads .docx / .xlsx / .pptx / .pdf / .html. Word keeps heading levels, lists, tables, bold/italic and links; spreadsheets come back sheet by sheet, decks page by page, PDFs page by page from the **text layer** (a scanned PDF is reported as unreadable — **no OCR**). `write_document` writes **.docx only**: `create` (refuses to overwrite), `append`, `replace_text`. |
| Web pages | `fetch_url` opens one http/https page and converts it to Markdown; long pages keep their beginning and report what was dropped. Binary content and `file:`/`data:` are refused. It does **not** block private/internal addresses — see the security notes. |
| Memory and distillation | Three visible files (`agent.md` / `user.md` / `memory.md`) and memory **only when you ask for it** via `save_memory`. `/distill` turns a working session into a note with `[[links]]` in `digests/`. |
| Text references | Select text in the editor, canvas, table or the built-in browser and press Option+Z (Alt+Z) to jump to the AI input with "source + selected text" attached. With nothing selected, the shortcut just focuses the input. |
| Conversations | Saved into the vault, restored on restart, multi-level branches (`/branch`), rewind to any turn (`/rewind`), compaction (`/compact`). |
| MCP | Remote streamableHttp, tools facet only — see [MCP](#mcp-deliberately-minimal). |

### The 26 tools

| Tool | What it does | Confirmation |
|---|---|---|
| `search_notes` | Keyword/metadata search over Markdown notes; filter by name, drill 2–5 levels, paginated | No |
| `semantic_search` | Optional semantic channel (remote embeddings, local vector cache) | No |
| `library_index` | Table of contents of your Markdown notes | No |
| `list_folder` | List the files in a folder, including non-note files; paginated | No |
| `read_note` | Read a note with its metadata; long notes are read in windows | No |
| `read_document` | Read .docx / .xlsx / .pptx / .pdf / .html as Markdown or plain text | No |
| `book_read` | Read .epub / .fb2 / .mobi / .azw3 / .txt by chapter | No |
| `create_note` | Create a note (frontmatter supported; also .canvas/.excalidraw/.base/.json and .html/.htm text files — never inside the config dir) | File card after execution (rejecting trashes it) |
| `create_folder` | Create a folder, missing parents included | File card after execution (rejecting removes it if empty) |
| `write_document` | Write a .docx: `create`, `append`, `replace_text` | **Per action**: `create` never asks (it cannot overwrite); `append` / `replace_text` ask first |
| `edit_note` | Append / replace a section / replace all | File card with diff (accept/reject) |
| `update_frontmatter` | Add, change or remove frontmatter fields | File card |
| `memos` | Read and write UNmemos flash notes — each memo is a node inside a canvas file, not a note. `list` (filter + page), `get`, `create`, `update`, `batch` | **Per action**: `create` never asks; `update` / `batch` ask first (`batch` takes `dry_run`) |
| `rename_or_move` | Rename or move a note (links updated) | Asks before execution |
| `rename_or_move_folder` | Rename or move a whole folder | Asks before execution |
| `delete_note` | Move to trash | **Always asks**; undoable |
| `delete_folder` | Delete a folder and its contents (needs `recursive: true` when non-empty) | **Always asks**; snapshot capped at 200 files / 500 KB, text files only — beyond that it says so instead of pretending it can undo |
| `run_command` | Local command/script execution for work **outside** the vault (**desktop only**) | Provably read-only commands skip the prompt (allowlist, fail-closed; can be turned off); everything else asks every time |
| `run_obsidian_command` | Run a command-palette command, including commands other plugins registered | `run` asks (skipped in don't-ask mode); `list` never asks; no undo entry; app-lifecycle commands (`app:reload` / `app:quit` / `window:close`) are refused |
| `fetch_url` | Open an http/https page and return it as Markdown | No (read-only, but the URL is sent to that site) |
| `generate_image` | Text-to-image into the vault | No |
| `mcp_admin` | Add, update or remove remote MCP servers | Asks before network discovery and before removal; built-in services cannot be deleted |
| `load_skill` | Load a skill's full guide | No |
| `save_memory` | Write memory.md (long-term memory) / user.md (user profile) | No |
| `todo_write` | Task list for long runs | No |
| `ask_user` | The assistant asks you a question | No |

### How retrieval works

The primary channel is keyword + metadata (`metadataCache.set`) search, CJK-friendly. The optional semantic channel splits notes by heading, sends the chunks to a **remote** embedding API, and keeps the resulting vectors only as a local cache (`<data folder>/.retrieval/`), with brute-force cosine top-k. No ANN index, no reranker, no local inference. Retrieval covers **Markdown notes only** — images, PDFs and ebooks are invisible to it ("not found" does not mean "does not exist"); excluded folders stay excluded. Use `list_folder` to enumerate everything in a folder, non-note files included.

### Memory and distillation

The data folder (default `UNagent/`, visible and editable) holds three ordinary Markdown files: `agent.md` (persona and working rules, injected whole), `user.md` (profile) and `memory.md` (long-term memory) — the latter two injected as `-` bullet lines. Memory has exactly one path and it is always user-initiated: you say "remember X", the assistant calls `save_memory`. There is **no automatic reflection pass and no "should I remember this?" prompt**.

`/distill <what>` turns a session into a note under `digests/` with frontmatter, a one-line summary and four fixed sections (conclusions/decisions, notes touched, unfinished/where to resume, key context). Links are verified to exist before being written as `[[links]]`; the distillation index is mentioned in the system prompt **only** if you have used `/distill` at least once, so it costs nothing if you never do.

### What it costs per turn (honest numbers)

Every turn re-sends the system prompt, the tool schemas, the conversation history and the tool results. All four are capped:

| Channel | Mechanism | Numbers |
|---|---|---|
| Tool schemas | Fixed cost, estimated from the real registry | 26 built-in tools ≈ 7,149 tokens (measured 2026-09-20); registered MCP tools are extra. A test pins the ceiling. |
| Skill catalog | The catalog is pruned per turn by the tool table and runtime capabilities | 29 built-in skills ≈ 1,381 tokens with everything enabled (~47 each) |
| Tool results | Per-result and per-run budgets; tools that paginate themselves are exempt | 6,000 per result; min(24,000, window × 15%) per run; once spent, the per-result cap drops to 1,500 |
| Conversation history | **Non-destructive**: only what is sent is trimmed, never the visible transcript or the saved conversation | min(24,000, window × 30%), or window × 70% when Anthropic prompt caching is on |
| System prompt cache | Anthropic protocol marks the system prompt as a cacheable prefix (on by default, per-profile) | ~0.1× on hits, ~1.25× on writes |

Tools that paginate themselves (`read_note` / `read_document` / `book_read` / `list_folder` / `load_skill`) are deliberately exempt: clipping their window would make `nextOffset` a lie and silently skip the middle of a document. There is **no automatic compaction** — `/compact` replaces the visible message list and is saved to disk, so it only ever happens when you type it.

### MCP (deliberately minimal)

Remote streamableHttp transport and the tools facet only: `initialize`, `tools/list`, `tools/call`, hand-written JSON-RPC over `fetch`, no SDK, 10 s timeout. No stdio, WebSocket, OAuth, resources, prompts, sampling or session resumption. At most 8 tools per server; a text result longer than 20,000 characters keeps the **last** 20,000 and reports `keptChars` / `originalLength`.

Whether an MCP tool is treated as destructive comes **only** from the server's own `annotations`: `destructiveHint: true` without `readOnlyHint: true` asks before running (except in don't-ask mode); an explicit `readOnlyHint: true` does not; an undeclared tool does not ask either, but its model-facing description warns that undeclared is not read-only. These annotations are self-reported by a remote server, not proof. MCP tools get no vault handle and no undo entry. **Only connect services you trust.**

## Boundaries and security (read this before you use it)

- **API keys are stored in plaintext** in the vault's `data.json` (the usual v1 approach). Never commit `data.json`, and never put it in a folder that syncs publicly.
- **Skills are a prompt-injection surface.** A skill's body is injected into the model's context verbatim — treat it as a prompt. Only install skills from sources you trust. Skills are always plain text, never execute code, and cannot bypass approvals.
- **Deletion has two safety nets.** `delete_note` and `delete_folder` always show a confirmation dialog no matter what your settings say, and deletions/edits try to keep a full-text snapshot first (the "Undo" button, persisted to disk).
- **MCP tools and their output are untrusted.** The remote call is only marked destructive if the server says so; in don't-ask mode even destructive tools run without prompting. Output enters the model context; the plugin gives it no vault handle and no undo.
- **`fetch_url` sends the URL out and reads the page in.** It is read-only and does not prompt (approval is reserved for changing local data), but the request reaches that site (it sees your IP; the plugin does not spoof its User-Agent) and the page text enters the conversation context — which means it can also be sent to your model provider. The plugin deliberately does **not** block private/internal addresses (`http://127.0.0.1:…`, `192.168.*`, …): this is a local-first tool, and an "is this address internal?" heuristic would fail closed more often than it helps. It only handles text content; binaries (PDF, images, archives) are refused by content type.
- **`run_obsidian_command` can run anything any plugin registered, and this plugin cannot see what it did.** Commands are a black box: no vault changes are attributable, so nothing goes on the undo stack, and in don't-ask mode there is no prompt at all. The system prompt tells the model to use the note tools for in-vault edits, but that is a **soft** guidance — the only hard control is your approval mode. Commands that would end the session (`app:reload` / `app:quit` / `window:close`) are refused outright.
- **Documents are read as content, not as layout.** All parsing happens in-plugin (OOXML via the vendored fflate + DOMParser; the PDF text layer is parsed by hand, reusing fflate's inflate for FlateDecode). No OCR, no PDF/Office SDK: a scanned PDF can only be reported as unreadable; fonts, columns, charts, formulas and complex table styling are lost; images, comments and revisions are counted but not restored. Writing is `.docx`-only, and the two actions that modify an existing file (`append` / `replace_text`) ask first. Undo for documents lasts for the current session only — a binary document cannot take a persistent text snapshot without corrupting the file.
- **Vendored parsing code:** the ebook layer vendors [foliate-js](https://github.com/johnfactotum/foliate-js) (MIT) and [fflate](https://github.com/101arrowz/fflate) (MIT); origins and versions are recorded in `src/vendor/foliate/README.md`.

### Data access, network use and disclosures

Plugin review flags four behaviours in this plugin. All four are real and all four are deliberate:

- **Network use.** (a) Your model provider — every conversation, including note text and tool results that the model needs to see. (b) Optionally, an embedding API for semantic search, if you enable it. (c) Optionally, MCP servers you add yourself — built-in search presets (exa, bailian-websearch) ship with empty keys and only work once you fill in your own. (d) A URL you or the model choose, via `fetch_url`. There is **no telemetry, no analytics, no account, and no call to any server of ours**. Whatever you put in the context can leave your machine through your chosen provider — that is inherent to using a remote model.
- **Shell execution** (`child_process`, desktop only, `run_command`). This exists so the assistant can do work *outside* the vault — conversions, `git`, `rg`, one-off scripts. It is filtered out on mobile, and it is the only place in the codebase that touches local processes. Vault editing never goes through the shell. Commands that can be *proven* read-only (`ls`, `cat`, `git status`, `rg`, `find` without `-exec`, …) skip the confirmation prompt by default; anything that writes, chains an unknown command, redirects output (other than `/dev/null` and fd duplicates), uses command substitution, variable expansion, background jobs, subshells or heredocs, and anything unrecognised asks every time, in every approval mode. The honest caveat: read-only does not mean harmless — `cat ~/.ssh/id_rsa` is read-only too.
- **Vault file enumeration** (`vault.getFiles` and friends). The plugin lists the paths in your vault to build the keyword search index, resolve `[[wikilinks]]`, list folder contents, and detect which skills apply (is there an ebook in this vault? is there a model that can generate images?). It reads file *contents* only through the documented Obsidian APIs, and only for files a tool was actually asked to read.
- **Clipboard.** The plugin **writes** to the clipboard only when you click a copy button (copy a message, a note path, an embed, or an image). It never reads the clipboard; pasted images arrive as an ordinary paste event you trigger yourself.
- **`localStorage`** (two keys, not vault data): an "unclean shutdown" marker used by the boot log, and a latch recording that the on-screen keyboard was really observed. Both need to survive a hard kill of the webview, which is exactly what the synchronous `localStorage` API does and the asynchronous plugin data API cannot. They contain a timestamp and a boolean — no note content, no keys.

## Platform differences

- **Mobile (phone/tablet)** = in-plugin JavaScript + remote HTTP. No local processes, no local compute (embeddings are remote too).
- **Desktop-only capability: one.** `run_command`. On mobile the tool is absent (not an error). Nothing else differs between the two.

## Development

```bash
npm install
npm run dev      # esbuild watch, also syncs artifacts into the test vault
npm run build    # tsc strict typecheck + production bundle → main.js / manifest.json / styles.css
npm test         # full jest suite
```

Bundle size is watched (`main.js` measured at 1,060,825 bytes, ~1,036 KiB, on 2026-09-20 with the reference strip above the input and the consolidated tool-notification path; 1,061,070 bytes, ~1,036 KiB, was earlier the same day with the `memos` tool and skill in the bundle; 1,036,479 bytes, ~1,012 KiB, was earlier the same day with the `unreader` skill and the `.json` create_note whitelist, and 1,014,204 bytes, ~990 KiB, was the 0.10.0 release artifact on 2026-09-19). After every build, `grep` the bundle to confirm no hidden dependency leaked in (`pglite` / `lexical` / `framer-motion` / `langchain` must all be 0 hits).

## License

**UNcore Source Available License** — see [LICENSE](LICENSE). This is not an open-source licence: reading and auditing the source is permitted (including for Obsidian's own plugin review), while commercial use, redistribution and republishing require written permission. The plugin is therefore **closed source in the Community directory sense** — the distributed `main.js` is a minified bundle, and the source lives in a private repository that is opened to Obsidian's review process. Commercial licensing: contact UNcore.

---

# 中文文档

**给 Obsidian 用户的移动优先 AI 助手——手机平板上轻量自足，桌面上同样完整可用。**

插件 id 是 `unagent`、显示名是「UNagent」，作者 UNcore。核心是「纯插件内 JS + 远程 HTTP」：不依赖任何 LLM SDK（原生 `fetch` + 手写 SSE），移动端零本地进程；桌面端在此之上只多一条本地命令执行（`run_command`：只读命令默认免确认，写入的与认不出的一律逐次确认，见「边界与安全」）。

---

## 5 分钟上手（BYO key：自带你自己的模型 Key）

### 第一步：安装

目前手动安装。把构建产物三件套放进你的 vault：

```
<你的 vault>/.obsidian/plugins/unagent/
├── main.js
├── manifest.json
└── styles.css
```

然后 设置 → 第三方插件 → 启用「UNagent」。左侧栏 ✨ 图标或命令面板「Open UNagent chat」打开对话框。

### 第二步：添加模型档案

设置 → UNagent →「模型」标签页 → 点「模型厂商」标题行右侧的 **「＋ 添加厂商」**，在弹窗里填三项关键配置：

1. **API 协议**（下拉）：选你的服务商协议（OpenAI 兼容 / Anthropic 等），选完会自动回填对应的默认地址；
2. **API 地址**：即 Base URL，接口地址不含 `/chat/completions` 等路径后缀（选协议时已预填，可任意改写）；
3. **API 密钥**：你的服务商 Key（右侧「眼睛」按钮可显示/隐藏）。

再往下是**模型列表**：输入模型名回车添加（会自动从 API 拉取联想），保存即生效。可以同时添加多个厂商、多种协议并存；对话里发 `/model` 随时切换本会话模型。

### 第三步：开聊

直接说需求就行，例如「搜索关于读书的笔记并总结一下」「给《项目计划》加上 #work 标签」。AI 会流式回答、按需调用工具读写你的笔记与文件夹；默认/自动模式下，新建/编辑类工具执行后会在文件卡片给出接受/拒绝（编辑类带 diff），移动与删除在执行前确认，其中 `delete_note`、`delete_folder` 无论审批模式都强制确认；`run_command` 里能被证明只读的命令默认免确认（设置可关），其余照旧逐次确认。笔记编辑/删除、文件夹创建/删除会留撤销快照，改错了点顶部「撤销」。

到这里插件已完整可用——不配 MCP，功能一样不缺。

---

## 能力清单（移动 + 桌面一致）

| 能力 | 说明 |
|---|---|
| 流式对话 | 逐字输出、可随时停止、错误有友好提示可重试；多厂商多协议档案并存，`/model` 切换会话模型，`/think <档位>` 直接设思考强度（裸 `/think` 打开同一个面板），`/search <档位>` 直接设检索模式（裸 `/search` 同样打开那个面板）。输入框下方一行：左半边是对话标题（点开对话管理面板），右半边是模型键（点开「模型 · 思考强度与检索模式」面板，最上面是思考强度与检索模式两个档位控件，下面直接选模型）；手机上键盘弹起时这一行整体隐藏，键盘上方只剩输入框 |
| 检索模式 | 会话级旋钮，五档：**关闭搜索**（既不翻库内笔记也不联网）/ **自动**（默认，由 AI 自己决定）/ **搜索笔记** / **搜索网页** / **搜索网页和笔记**。档位是**硬边界**：对应通道的检索工具真的不会进入这一轮的工具表（读写笔记的工具不受影响），同时系统提示里写明本轮要求。入口两个：输入框下方模型键的面板顶部档位控件，或 `/search <档位>`。**搜索网页**走远程 MCP 联网服务（插件已内置 exa / bailian-websearch），模型档案勾了「联网搜索」时还会额外注入服务端内置联网；另有内置的 `fetch_url` 打开用户给出的网址（同样属网页通道，所以这两档下不可用——搜索服务给的是标题与链接，打不开页面） |
| 24 个工具（桌面 25） | AI 可读、搜、写你的笔记与文件夹、读办公文档与 PDF、执行 Obsidian 命令面板的命令（清单见下，共 25 个）；默认/自动模式下新建/编辑类执行后走文件卡片审批，移动/删除执行前确认，其中删除文件夹与删除笔记永远强制确认；桌面端的本地命令里只读的那些默认免确认（设置可关），写入的与认不出的一律逐次确认；笔记编辑/删除、文件夹创建/删除可撤销；桌面端另有本地命令执行（`run_command`，移动端不可见，故移动端为 24 个） |
| 技能 (Skills) | 纯提示文本的 SKILL.md 指南，`//技能名` 调用或 AI 按需 `load_skill` 载入；绝不执行代码。官方技能的**目录行**（每轮进上下文的那一行）中英双语，英文界面自动取英文版；用户自建技能用 `description_en` 与兄弟文件 `SKILL.en.md` 提供英文版 |
| 混合检索 | 关键词 + 元数据为主通道；语义检索可选（远程 embedding + 本地向量缓存，见下） |
| 生图 | `generate_image` 文生图存入 vault，可插入笔记/设为封面；存放目录可配置（设置 → 通用 →「AI 生图目录」） |
| 电子书阅读 | `book_read` 读 .epub / .fb2 / .mobi / .azw3 / .txt：先取书目与目录，再按章输出 Markdown（超长分段续读）；配 `book-read` / `ebook-workflows` 技能做摘录、翻译、整本导入；DRM 加密书与 .azw/.pdf 不支持（引导 Calibre 转换）。**只读**：改书/拆章/改封面属于二期，请用 Calibre |
| 办公文档与 PDF | `read_document` 读 .docx / .xlsx / .pptx / .pdf / .html：Word 保留标题层级、列表、表格、加粗斜体与链接，Excel 按工作表逐行、PPT 按页、PDF 按页给出文本层；`write_document` 一把工具管三件事：新建 Word 文档（`mode=create`，同名文件绝不覆盖）、往正文末尾追加（`mode=append`）、全文替换指定文字（`mode=replace_text`）。**审批跟着动作走**：新建不问（建不了就报错，没有损失），改已有文档执行前先确认（配 `documents` 技能）。**写入只限 .docx**：.xlsx / .pptx / .pdf 只读；扫描版 PDF 没有文本层时如实报告——插件不做 OCR；.doc / .xls / .ppt / .rtf / odt 是旧格式，请先另存为 .docx / .xlsx / .pptx |
| 网页阅读 | `fetch_url` 打开一个 http/https 网页并转成 Markdown（HTML 转换复用电子书那套，JSON/纯文本原样返回）。搜索服务给的是标题与链接、打不开页面，这一条补的正是那一步。长页只保留开头并如实报出省略了多少；二进制内容与 `file:` / `data:` 之类一律拒绝；响应不带 content-type 时不猜、直接说打不开（不把可能的乱码当正文）。属**网页通道**——「关闭搜索 / 只搜索笔记」两档下不可用；不拦内网地址，见「边界与安全」 |
| 记忆与沉淀 | agent.md / user.md / memory.md 三个可见文件 + **完全由你发起**的显式记忆（`save_memory`）；一段工作结束时用 `/distill` 沉淀成一篇带 `[[链接]]` 的笔记（见下） |
| 文字引用 | 编辑器 / 画布 / 表格 / 内置浏览器里选中文字按 Option+Z（Alt+Z，或命令面板「引用选中文字到 AI 输入框」），一键跳到 AI 输入框并自动带上「来源 + 选中文字」引用；网页选区带页面地址（选中处是链接时连带链接本身）；没有选中内容（或引用失败）时按下也会直接聚焦输入框，可当纯聚焦快捷键用 |
| 对话管理 | 自动保存进 vault、重启恢复、多层分支（`/branch`）、任意轮回溯（`/rewind`）、`/compact` 压缩 |
| MCP（最小形态） | 仅远程 streamableHttp + tools 面，见「边界」一节 |

### 工具清单（26 个）

| 工具 | 作用 | 审批 / 风险 |
|---|---|---|
| `search_notes` | 关键词 + 元数据（标签/文件夹）检索；只带文件夹过滤时即文件夹浏览（返回子文件夹） | 否 |
| `semantic_search` | 语义检索（远程 embedding，本地只存向量缓存） | 否 |
| `library_index` | 库目录（启发式摘要缓存） | 否 |
| `list_folder` | 列文件夹内容：子文件夹、笔记，**以及图片/PDF/电子书等非笔记文件**；可按名字过滤、可下钻 2-5 层、分页续读。属笔记检索通道，故「关闭搜索 / 只搜索网页」两档下不可用 | 否 |
| `read_note` | 读取笔记内容（含元数据，超长分段续读） | 否 |
| `read_document` | 读取非 Markdown 文档：Word `.docx` / Excel `.xlsx` / PowerPoint `.pptx` / `.pdf` / `.html`，转成 Markdown 或纯文本。Word 保留标题层级、列表、表格、加粗斜体与链接；PDF 逐页给出**文本层**（每页以 `<!-- page N -->` 开头），扫描件没有文本层时如实报告（**不做 OCR**）；旧格式（.doc/.xls/.ppt/.rtf/odt）明确拒绝并请用户另存。超长只给一个窗口，按 `nextOffset` 续读；图片/批注/修订会丢，丢什么写在 `warnings` 里 | 否 |
| `book_read` | 读取库内电子书（.epub / .fb2 / .mobi / .azw3 / .txt）：书目 + 目录，按章读为 Markdown，长章分段续读；只读，DRM 加密书不支持（建议 Calibre 去 DRM） | 否 |
| `create_note` | 新建笔记（支持 frontmatter；也可建 .canvas/.excalidraw/.base 与 .html/.htm/.json 等文本文件；配置目录 `.obsidian` 内一律拒绝） | 默认/自动模式下执行后卡片审批（拒绝则移入回收站） |
| `create_folder` | 新建文件夹（缺失的父级一并创建；文件夹不是笔记，不加扩展名） | 默认/自动模式下执行后卡片审批（拒绝则删掉刚建的文件夹，**非空时不删**；可撤销） |
| `write_document` | 写 Word 文档（`.docx`）一把工具三个动作：`mode=create` 用 Markdown 新建（标题层级、列表、表格、引用、代码块、加粗斜体、超链接变成真正的 Word 结构；同名文件已存在则拒绝，**绝不覆盖**，缺的父文件夹自动创建）、`mode=append` 在正文末尾追加、`mode=replace_text` 全文替换指定原文（找不到就**一个字都不改**）。图片、页眉页脚、批注不受影响；跨格式片段的替换会把那段合并成单一样式（会说明） | **按动作**：`create` 不问（无损失）；`append` / `replace_text` 改的是已有文件，执行前确认（免询模式放行）。撤销**仅本次会话有效**——二进制文档不留持久快照 |
| `edit_note` | 追加 / 替换章节 / 全文替换（匹配失败会报最相似片段） | 默认/自动模式下执行后卡片审批（diff / 接受 / 拒绝；可撤销） |
| `update_frontmatter` | 增删改 frontmatter 字段；数组字段可合并去重（加标签用它） | 默认/自动模式下执行后卡片审批（接受 / 拒绝；可撤销） |
| `memos` | 读写 UNmemos 闪念笔记（每条 memo 是 canvas 文件里的一个节点，不是 .md 笔记）：`list` 筛选/分页、`get`、`create`、`update`、`batch`。同一画布上用户自己的卡片与分组一律不碰；UNmemos 会自己发现改动，无需重载插件 | **按动作**：`create` 不问；`update` / `batch` 执行前确认（`batch` 可先 `dry_run` 预览命中哪些；免询模式放行）。没有删除动作——与 UNmemos 一致，只能归档 |
| `rename_or_move` | 改名/移动（自动更新引用） | 默认/自动模式下执行前确认 |
| `rename_or_move_folder` | 重命名/移动整个文件夹（其中笔记随之移动；链接是否改写取决于你的「自动更新内部链接」设置） | 默认/自动模式下执行前确认；拒绝搬进自己的子目录与数据文件夹 |
| `delete_note` | 移入回收站 | **执行前强制确认**；可撤销 |
| `delete_folder` | 删除整个文件夹及其内容（移入回收站）。非空必须显式 `recursive: true` | **执行前强制确认**；快照有上限（200 文件 / 500 KB，且必须全是文本文件），超出时不记录快照并明确告知「本次无法在插件内撤销」 |
| `run_command` | 本地命令/脚本执行（**仅桌面**；库外计算专用，不碰库内文件） | **能被证明只读的命令免确认**（ls / cat / git status / rg / find 不带 -exec 等；设置 → 安全 →「只读命令免确认」可关）；其余执行前强制确认；输出保尾部并报告截断规模 |
| `run_obsidian_command` | 执行 Obsidian 命令面板里的命令（含别的插件注册的）：`action=list` 按关键词找 id，`action=run` 执行指定的一条。只用于「别的工具做不到」的动作（打开某视图、触发某插件） | `run` 执行前确认（**免询模式放行**，与移动/删除同档）；`list` 不确认；**不留撤销快照**；重启/退出/关窗类命令一律拒绝 |
| `fetch_url` | 打开 http/https 网页转成 Markdown（HTML→Markdown；JSON/纯文本原样返回）。长页只保留开头并报出省略规模；非文本内容与 `file:`/`data:` 拒绝。属**网页通道**，「关闭搜索 / 只搜索笔记」两档下不可用 | 否（只读；但会把该网址发给对应站点） |
| `generate_image` | 文生图并存入 vault（目录可配置：设置 → 通用 →「AI 生图目录」，留空 = 数据文件夹下的 `images/`） | 否 |
| `mcp_admin` | 远程 MCP 服务增/改/删（action=add/update/remove） | 联网发现前确认；删除前确认；官方服务不可删 |
| `load_skill` | 按名载入某个技能的完整指南 | 否 |
| `save_memory` | 写入 memory.md（长期记忆）/ user.md（用户画像） | 否 |
| `todo_write` | 任务清单（长任务的进度可视化） | 否 |
| `ask_user` | AI 主动向你提问 | 否 |

### 检索怎么工作（如实版）

检索以**关键词 + 元数据**（`metadataCache`）为主通道，CJK 友好。可选开启语义通道：笔记按标题切块 → **远程** embedding API 算向量 → 向量只是远程结果的本地缓存（存数据文件夹 `.retrieval/`）→ 暴力余弦 top-k。embedding 计算不在本地发生，不引入 ANN 索引与重排序模型。embedding 模型复用统一的厂商体系（模型能力勾「向量化（检索）」），未配置时零启动成本。

库内检索（`search_notes` / `semantic_search` / `library_index`）**只覆盖 Markdown 笔记**——图片、PDF、电子书等非笔记文件对它们不可见，「没搜到」不等于「不存在」；被排除的文件夹也默认不在范围内。要枚举文件夹内容（含非笔记文件）用 `list_folder`。这一条只写在系统提示里一次，不再散落在各工具描述里。联网那一半：搜索靠 MCP 服务，打开具体页面靠 `fetch_url`。

### 记忆与沉淀

数据文件夹（默认 `UNagent/`，可见可编辑）里三个文件：

| 文件 | 职责 | 注入方式 |
|---|---|---|
| `agent.md` | 助手人设与工作守则 | 整篇注入系统提示 |
| `user.md` | 用户画像 | `-` 开头条目注入 |
| `memory.md` | 长期记忆 | `-` 开头条目注入 |

记忆只有**一条**路径，且完全由你发起：你说「记住 xxx」，AI 用 `save_memory` 写入（带提示注入防护与额度），下次新对话生效。**没有任何自动复盘、没有「要不要记住」的弹窗**——需要长期记住什么由你决定。

沉淀解决的是另一件事：一段工作做完之后，怎么让下次不用从零开始。

- `/learn` 把一次对话结晶成一个可复用技能（纯提示文本的操作指南）。
- `/distill <要沉淀什么>` 把这段工作沉淀成一篇笔记，落在数据文件夹的 `digests/` 下，并在 `digests/index.md` 追加一行索引。笔记带 frontmatter、一行摘要，以及四段固定结构（结论/决定、动过的笔记、未完成/下次从这里开始、关键上下文），其中「动过的笔记」是指向相关笔记的 `[[链接]]`——**写链接前会先核对路径真实存在**，核对不了的写成纯文本，避免死链。下次做同一件事时，从那篇接着走。

注入是**按需**的：只有当你真的用过 `/distill`（`digests/index.md` 存在）时，系统提示里才会多出一句「沉淀索引在哪、问起旧事先读它」；没用过就一个字都不提，零额外开销。沉淀不需要你维护，它只是某个时点的快照——当前真相永远在你自己的笔记里。

### 上下文成本怎么控制（如实版）

每轮要重发的输入 = 系统提示 + 工具 schema + 对话历史 + 工具结果。四者都有上限：

| 通道 | 机制 | 数值 |
|---|---|---|
| 工具 schema | 固定开销，芯片按注册表里的真实工具量出 | 26 个内置工具 ≈ 7,149 tokens（`estimateToolSchemaTokens` 实测，2026-09-20 加 `memos` 后；同日加 `unreader` 前 25 个为 6,561、23 个为 5,853、22 个为 5,463、21 个为 5,399、17 个为 4,215）；已注册的 MCP 工具另计。上限由 `promptCost.test.ts` 守着（实测 + 固定绝对余量，加 `memos` 时先合并了它的日期参数），撞线时先合并/瘦身 |
| 技能目录（系统提示里的一部分） | 目录随本轮**工具表**与**运行时能力**裁剪：被摘掉的能力连名字都不出现 | 29 条官方技能 ≈ 1,381 tokens（能力全开时实测，平均约 47/条）：2026-09-20 加 `unreader` 后是 28 条 1,381，同日再加 `memos` 前先压缩了几条最长的描述，所以 29 条仍是 1,381——**这条线没抬**；更早 27 条为 1,335、26 条为 1,292 |
| 工具结果 | 单条预算 + 每轮累计预算；自报分窗的工具不裁 | 单条 6,000；累计 min(24,000, 窗口×15%)；用掉后单条降到 1,500 |
| 对话历史 | **非破坏性**预算：只缩减发给模型的那份，可见记录 / 已落盘对话 / 分支都不动 | min(24,000, 窗口×30%)；开了 prompt 缓存则退化为纯溢出兜底（窗口×70%） |
| 系统提示缓存 | Anthropic 协议把系统提示标成可缓存前缀（默认开，厂商档案可关） | 命中约 0.1x 计费，写入约 1.25x |

几点如实说明：

- **自报分窗的工具刻意不裁**：一次 2 万字符的笔记分 4 次 5 千读，输入是 5k+10k+15k+20k = 50k；一次读完只发 20k。截断它的窗口反而更贵，还会让 `nextOffset` 变成谎话、静默跳过中间那段——所以 `read_note` / `read_document` / `book_read` / `list_folder` / `load_skill` 的结果完全跳过预算（`list_folder` 自带 `limit ≤ 200` 的窗口上限，`load_skill` 一份技能正文一个窗口、超长续读）。`load_skill` 是这条规则里唯一「不是数据而是指令」的一个：被截断的指南更糟——模型不会发现自己少了半份，只会照着前半段做。
- **技能目录会随能力消失（不只是工具）**：技能声明的运行时能力不存在时，目录里连名字都不出现——没配生图模型（`image-generator`）、库里没有可读电子书（`book-read` / `ebook-workflows`）、Obsidian 版本不支持 `.base`（`obsidian-bases`，Bases 是 1.9.0 的核心功能）。`Dataview` / `Excalidraw` 这两个依赖**社区插件**的技能不做自动门控（可靠侦测要用未公开 API），改为在目录行里写明依赖，并在设置页可自由开关。
- **历史预算不是固定 24,000**：未开缓存时取 `min(24,000, 窗口×30%)`，所以 8K 模型实际只有约 2,400；长窗口模型的常见短对话通常够不到。它的价值是给真正长的会话兜住溢出、止住历史越长每轮重发越贵的二次增长。要主动压缩整段上下文，仍然敲 `/compact`。
- **不做自动压缩**：`/compact` 会替换可见的消息列表并落盘，自动触发等于静默删掉你的对话记录，所以只在你敲命令时发生。
- **缓存可能静默失效**：缓存是前缀匹配，前缀里任何一处变化（包括工具集）都会让它整体失效。开诊断日志后每轮会有一条 `cache read=… write=…`，读侧连续为 0 就说明没命中。
- **芯片**：首轮之前是粗估（系统提示 + 工具 schema + 消息），首轮之后一律用服务商返回的真实用量。

### MCP 边界（如实描述，不夸大）

只做**远程 streamableHttp 传输 + tools 面**：`initialize` / `tools/list` / `tools/call` 三个方法，纯 fetch 手写 JSON-RPC、零 SDK，单次请求超时 10 秒。不做 stdio / WebSocket / OAuth / resources / prompts / sampling / 会话恢复。工具总数上限 8 个；单条文本结果超过 2 万字符时保留**最后** 2 万字符，并返回 `keptChars` / `originalLength`，非文本片段数量也会明确上报。设置 →「MCP」标签页添加服务，Agent 级可再按代理开关。

内置官方预设服务（bailian-websearch 联网搜索、exa 搜索），`key 一律留空`不在插件里内置——需在「MCP」设置里编辑对应服务、填入你自己的 Authorization 再「测试并刷新工具」才能调用；官方服务不可删除，只能开关/编辑。

MCP 工具是否被标成破坏性，只看服务端在 `tools/list` 里自报的 `annotations`；是否真正弹执行前确认，还受全局审批模式约束。分三档：

- `destructiveHint: true` 且未声明 `readOnlyHint: true`：按破坏性工具处理；默认与「自动（编辑放行）」模式下执行前确认，「免询」模式仍会放行；
- `readOnlyHint: true`：按只读工具处理，不确认；
- 未声明：维持不确认，但工具描述会明确告诉模型「未声明不等于只读，调用前先向用户说明」。

这些 annotation 是远程服务端的自报提示，不是可信证明。MCP 工具没有 vault 读写句柄，也不进撤销栈；结果文本是不可信输入，应只接入你信任的服务。

---

## 完全配置版（规划中）

现在是 BYO key：你自己去各家申请 Key、自己填。我们**规划中**会提供一个零配置的托管版本——统一 API、开箱即用，任何设备不必折腾密钥。具体形态与时间待定，本文档不承诺日期；当前版本的一切能力它就是它的全部。

---

## 边界与安全（先看这段再用）

- **API Key 明文存储**：所有 Key 以明文存在 vault 的 `data.json` 里（v1 从众做法）。不要把 `data.json` 提交到公开仓库、不要放进会公开同步的目录。
- **技能是提示注入面**：技能正文会原样注入 AI 的上下文，等同于提示词——**只安装你信任来源的技能**。技能永远是纯提示文本、绝不执行代码，也不能绕过审批：默认/自动模式下的编辑类仍落文件卡片，移动/删除仍走执行前确认。
- **删除有双保险**：`delete_note` 与 `delete_folder` 永远强制弹窗确认（不受任何「跳过确认」设置影响）；删除与编辑会先尝试留全文快照，成功后对话框顶部「撤销」可还原（撤销栈落盘，重启不丢）。**文件夹删除的快照有上限**：200 个文件 / 500 KB，且子树上必须全是文本文件——文件过多、含图片/PDF/电子书、或有文件读不出来时不记录快照，结果、卡片与提示都会明确写出「本次无法在插件内撤销，只能从回收站找回」，绝不假装可撤销。（另外：超过 100 KB 的快照仍可在本次会话内撤销，但超出落盘上限，重启后该条目会被丢弃。）
- **MCP 工具与结果都不可信**：远程调用只按服务端自报 annotation 标记是否破坏性，未声明时不会弹确认；即使标记为破坏性，「免询」模式也会放行。输出会进入模型上下文，插件不授予它 vault 句柄，也没有撤销。别接入不受信服务，也不要把 MCP 输出当成可信指令。
- **`fetch_url` 会把网址发出去、把页面读进来**：它是只读工具、不弹确认（与 MCP 工具的调用一致——审批留给改动本地数据的操作），但要知道：请求会到达那个站点（对方能看到你的 IP 与请求头，插件不伪装 User-Agent），页面文本会进入本次对话上下文（因此也可能被一起发给你的模型服务商）。插件**不拦内网/本地地址**（`http://127.0.0.1:…`、`192.168.*` 之类），也**不做**「哪些地址算内网」的穷举判断——这是本地优先工具的有意取舍，不是遗漏；只让 AI 打开你信得过的网址。另外它只处理文本类内容，二进制（PDF/图片/压缩包）按 content-type 拒绝。
- **`run_obsidian_command` 能跑任何插件注册的命令，插件看不到它做了什么**：命令是黑盒——插件拿不到它改了哪些文件，所以这一步**不进撤销栈**、也无法在插件侧还原；「免询」模式下连确认都不会弹。系统提示要求库内编辑仍走笔记工具，但那是**软引导**，真正拦得住的是你选的审批模式。会终结当前会话的三类命令（`app:reload` / `app:quit` / `window:close`）被**硬拒绝**，列命令时也不会出现。
- **`run_command` 的只读命令默认免确认**：能被证明只读的命令（ls / cat / git status / rg / find 不带 -exec 等）不再弹确认框——判定是**白名单 + 认不出就确认**：写入类、串联了陌生命令的、含重定向 / 命令替换 / 变量展开 / 后台作业的、以及白名单外的命令（npm run、make、curl、自装 CLI）一律照旧逐次确认，且任何审批模式都不豁免。设置 → 安全 →「只读命令免确认」关掉即回到「每条都问」。代价要清楚：**只读不等于读不到敏感内容**——`cat ~/.ssh/id_rsa` 也是只读命令，免询后这类读取会直接执行并把内容带进对话上下文（因此也可能被一起发给你的模型服务商）。
- **文档的读取是「内容」不是「版面」，写入只限 .docx 且审批跟着动作走**：解析全部在插件内完成（OOXML 用已 vendor 的 fflate 解包 + DOMParser 走查 XML，PDF 自己解文本层，PDF 的 FlateDecode 用 fflate 的 `inflateSync`），**不装 OCR、不引 PDF/Office SDK**，因此边界是硬的：扫描版 PDF 没有文本层时只能如实报告「读不了」，字体 / 分栏 / 图表 / 公式 / 复杂表格样式会失真，图片、批注、脚注、修订只报数不还原。写入只支持 `.docx`（新建 / 末尾追加 / 全文替换），`.xlsx` / `.pptx` / `.pdf` **只读**；`write_document` 里改已有文档的两个动作（`append` / `replace_text`）走**执行前确认**——二进制写入没有可 diff 的源码；新建（`create`）不弹框，因为它不覆盖任何东西（同名即报错）。撤销只在本次会话内有效（不留持久快照——`undo.json` 存的是「恢复用的文本」，把提取出来的文字塞进去会在重启后当正文写回文档，那会损坏你的文件）。
- **第三方解析组件**：电子书解析层 vendor 自 [foliate-js](https://github.com/johnfactotum/foliate-js)（MIT）与 [fflate](https://github.com/101arrowz/fflate)（MIT），纯 JS 内存解析、移动端一致；来源与版本见 `src/vendor/foliate/README.md`。

### 权限与数据访问披露（对应官方审核提示的四项行为）

官方审核对这个插件给过四类行为提示（Shell Execution / Vault Enumeration / Clipboard Access / Local Storage），逐条如实说明它们各自在干什么：

- **Shell Execution（`child_process`，仅桌面，`run_command`）**：存在的唯一理由是让助手做**库外**的活（格式转换、`git`、`rg`、一次性脚本）。移动端这个工具被过滤掉，整个代码库只有这一处触碰本地进程；库内编辑永远走笔记工具。能被证明只读的命令默认免确认，写入的与认不出的一律逐次确认——代价见上文「只读不等于读不到敏感内容」。
- **Vault Enumeration（`vault.getFiles` 一类调用）**：列出库内路径，用于建关键词检索索引、解析 `[[双链]]`、列文件夹内容，以及判断某个技能该不该出现在本轮（库里有没有电子书、有没有配生图模型）。文件**内容**只在某个工具真的被要求读它时、经 Obsidian 文档化的 API 读取。
- **Clipboard（剪贴板）**：只有你点「复制」时才**写入**（复制消息、笔记路径、嵌入块、图片）；插件从不主动读剪贴板——粘贴图片走的是你自己触发的那次 paste 事件。
- **Local Storage（`localStorage`，两个键，不是库内数据）**：一个是开机日志用的「上次没正常退出」标记，一个是「屏幕上确实弹过键盘」的闩锁。两者都必须在 webview 被硬杀时仍能落下——这正是同步的 `localStorage` 能做、异步的插件数据 API 做不到的事。里面只有一个时间戳和一个布尔值：没有笔记内容，也没有密钥。
- **联网去向**：模型服务商（每轮对话）、可选的 embedding 服务（语义检索）、你自己加的 MCP 服务（内置搜索预设的 key 一律留空，填了才可用），以及 `fetch_url` 打开的那个网址。**没有遥测、没有统计、没有账号、没有任何我方服务器**。

## 平台差异声明

- **移动端（手机/平板）= 纯插件内 JS + 远程 HTTP**：零本地进程、零本地算力（embedding 也走远程），所有核心功能三端一致。
- **桌面专属能力只有一条**：`run_command` 本地命令/脚本执行（库外计算；只读命令默认免确认、其余逐次确认，绝不用于库内文件）。移动端该入口缺席而非报错；除此之外桌面与移动没有任何功能差异。

---

## 开发（给改代码的人）

```bash
cd unagent
npm install
npm run dev      # esbuild watch，自动同步产物到测试 vault
npm run build    # tsc strict 类型检查 + esbuild 生产构建 → main.js / manifest.json / styles.css
npm test         # jest 全量
```

产物体积受关注（`main.js` 2026-09-20 `npm run build` 实测 1,060,825 bytes（约 1,036 KiB——引用改由输入框上方的悬浮带独占，并归口工具通知路径之后）；同一次会话再早一点是 1,061,070 bytes（约 1,036 KiB，`memos` 工具与技能进包后，同一次构建也带着 `unreader` 技能、`create_note` 的 `.json` 白名单，以及同日并行落地的 RefBar / mention 改动——所以这个数含的不只是 `memos`）；同日更早一次 1,036,479 bytes（约 1,012 KiB，`unreader` 技能与 `.json` 白名单进包后）；2026-09-19 实测：文档能力（`read_document` + `write_document`）与 `documents` 技能进包并修完真实文件样本暴露的读取缺陷后 1,012,155 bytes（约 988 KiB；修缺陷前那一刻是 1,009,379 bytes）；同一天只读命令免确认落地后 934,186 bytes（约 912 KiB）、`run_obsidian_command` 落地时 925,340 bytes，此前 894,761 bytes）；每次构建后 grep 产物确认无隐藏依赖泄漏（pglite / lexical / framer-motion / langchain 须全 0）。

## License

**UNcore Source Available License**（源码可见，非开源许可）—— 阅读与审计源码被允许（含 Obsidian 官方审核），商业使用、再分发与再发布需事先书面授权。详见 [LICENSE](LICENSE)。

按社区目录对「Close sourced code」的披露要求写明：本插件**属于闭源插件**——分发的 `main.js` 是压缩后的构建产物，源码在私有仓库中，仅对 Obsidian 官方审核开放；需要商业授权请联系 UNcore。

> **English:** UNcore Source Available License — source-visible, not open source. Reading and auditing the source is permitted (including for Obsidian's plugin review); commercial use, redistribution and republishing require written permission. The plugin is therefore closed source in the Community directory sense: the shipped `main.js` is a minified build, and the source lives in a private repository opened to Obsidian's review process.
