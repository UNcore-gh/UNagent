# OBot（AI Assistant）

**给 Obsidian 用户的移动优先 AI 助手——手机平板上轻量自足，桌面上经 hermes ACP 拥有重度任务能力。**

插件 id 是 `obsidian-ai`、显示名是「AI Assistant」（这两个不动），OBot 是我们对外的叫法。核心是「纯插件内 JS + 远程 HTTP」：不依赖任何 LLM SDK（原生 `fetch` + 手写 SSE），移动端零本地进程；桌面端在此之上多一条 hermes ACP 的重度通道，仅此一条。

---

## 5 分钟上手（BYO key：自带你自己的模型 Key）

### 第一步：安装

目前手动安装。把构建产物三件套放进你的 vault：

```
<你的 vault>/.obsidian/plugins/obsidian-ai/
├── main.js
├── manifest.json
└── styles.css
```

然后 设置 → 第三方插件 → 启用「AI Assistant」。左侧栏 ✨ 图标或命令面板「Open AI Assistant chat」打开对话框。

### 第二步：添加模型档案

设置 → AI Assistant →「模型」标签页 → 点「模型厂商」标题行右侧的 **「＋ 添加厂商」**，在弹窗里填三项关键配置：

1. **API 协议**（下拉）：选你的服务商协议（OpenAI 兼容 / Anthropic 等），选完会自动回填对应的默认地址；
2. **API 地址**：即 Base URL，接口地址不含 `/chat/completions` 等路径后缀（选协议时已预填，可任意改写）；
3. **API 密钥**：你的服务商 Key（右侧「眼睛」按钮可显示/隐藏）。

再往下是**模型列表**：输入模型名回车添加（会自动从 API 拉取联想），保存即生效。可以同时添加多个厂商、多种协议并存；对话里发 `/model` 随时切换本会话模型。

### 第三步：开聊

直接说需求就行，例如「搜索关于读书的笔记并总结一下」「给《项目计划》加上 #work 标签」。AI 会流式回答、按需调用工具读写你的笔记；破坏性操作会弹窗确认，改错了点顶部「撤销」。

到这里插件已完整可用——不装 hermes、不配 MCP，轻层功能一样不缺。

---

## 能力分两层（功能不对称是设计，不是缺陷）

### 轻层：移动 + 桌面，零 hermes 也完整可用

| 能力 | 说明 |
|---|---|
| 流式对话 | 逐字输出、可随时停止、错误有友好提示可重试；多厂商多协议档案并存，`/model` 切换会话模型，`/think` 系列控制思考强度 |
| 16 个工具 | AI 可读、搜、写你的笔记（清单见下）；破坏性操作弹窗确认，删除与编辑可撤销 |
| 技能 (Skills) | 纯提示文本的 SKILL.md 指南，`//技能名` 调用或 AI 按需 `load_skill` 载入；绝不执行代码 |
| 混合检索 | 关键词 + 元数据为主通道；语义检索可选（远程 embedding + 本地向量缓存，见下） |
| 生图 | `generate_image` 文生图存入 vault，可插入笔记/设为封面 |
| 记忆与进化 | agent.md / user.md / memory.md 三个可见文件，显式记忆 + 反思建议（见下） |
| 文字引用 | 编辑器 / 画布 / 表格里选中文字按 Option+Z（Alt+Z，或命令面板「引用选中文字到 AI 输入框」），一键跳到 AI 输入框并自动带上「来源 + 选中文字」引用 |
| 对话管理 | 自动保存进 vault、重启恢复、多层分支（`/branch`）、任意轮回溯（`/rewind`）、`/compact` 压缩 |
| MCP（最小形态） | 仅远程 streamableHttp + tools 面，见「边界」一节 |

### 重层：仅桌面，可选增强，需本机安装 hermes

hermes 是一个本机命令行 agent。装上之后 OBot 经 ACP 协议把它接进对话：

- **`/hermes <任务>`**：把复杂任务分派给本机 hermes 执行——过程可见（工具卡片、计划清单），结果回到对话历史，主 agent 可基于结果继续；
- **engine: hermes 子代理**：在 subagent.md frontmatter 里写 `engine: hermes`，该代理的整个对话走 hermes 引擎；
- **审批面板**：hermes 要执行命令或改文件时弹窗让你选（允许一次/本次会话/始终允许 · 拒绝）——这是本地 agent 动你机器的唯一交互面；
- **会话恢复**：hermes 会话 id 随对话持久化，关闭重开、重启 Obsidian 都能接上（hermes 侧 state.db 存档）。

没装 hermes = 这些入口缺席而非报错，轻层一切照旧。**移动端永远不渲染 Hermes 入口。**

### 工具清单（16 个）

| 工具 | 作用 | 破坏性 |
|---|---|---|
| `search_notes` | 关键词 + 元数据（标签/文件夹/日期）检索 | 否 |
| `semantic_search` | 语义检索（远程 embedding，本地只存向量缓存） | 否 |
| `library_index` | 库目录（启发式摘要缓存） | 否 |
| `list_notes` | 文件夹单层浏览 | 否 |
| `read_note` | 读取笔记内容（含元数据，超长分段续读） | 否 |
| `create_note` | 新建笔记（支持 frontmatter） | 否 |
| `edit_note` | 追加 / 替换章节 / 全文替换（匹配失败会报最相似片段） | 是（可确认） |
| `update_frontmatter` | 增删改 frontmatter 字段 | 是（可确认） |
| `add_tag` | 添加标签 | 是（可确认） |
| `rename_or_move` | 改名/移动（自动更新引用） | 是（可确认） |
| `delete_note` | 移入回收站——**永远强制确认**，可撤销 | 是（强制） |
| `generate_image` | 文生图并存入 vault | 否 |
| `load_skill` | 按名载入某个技能的完整指南 | 否 |
| `save_memory` | 写入 memory.md（长期记忆）/ user.md（用户画像） | 否 |
| `todo_write` | 任务清单（长任务的进度可视化） | 否 |
| `ask_user` | AI 主动向你提问 | 否 |

### 检索怎么工作（如实版）

检索以**关键词 + 元数据**（`metadataCache`）为主通道，CJK 友好。可选开启语义通道：笔记按标题切块 → **远程** embedding API 算向量 → 向量只是远程结果的本地缓存（存数据文件夹 `.retrieval/`）→ 暴力余弦 top-k。embedding 计算不在本地发生，不引入 ANN 索引与重排序模型。embedding 模型复用统一的厂商体系（模型能力勾「向量化（检索）」），未配置时零启动成本。

### 记忆与进化

数据文件夹（默认 `AI 助手/`，可见可编辑）里三个文件：

| 文件 | 职责 | 注入方式 |
|---|---|---|
| `agent.md` | 助手人设与工作守则 | 整篇注入系统提示 |
| `user.md` | 用户画像 | `-` 开头条目注入 |
| `memory.md` | 长期记忆 | `-` 开头条目注入 |

两条进化路径：**A 案显式**——你说「记住 xxx」，AI 用 `save_memory` 写入（带提示注入防护与额度）；**B 案反思建议**——每若干轮静默复盘一次，产出建议逐条摆在面板里，**你逐条确认才落盘，绝不自动写**，切换对话即作废。`/learn` 可以把一次对话结晶成可复用技能。

### MCP 边界（如实描述，不夸大）

只做**远程 streamableHttp 传输 + tools 面**：`initialize` / `tools/list` / `tools/call` 三个方法，纯 fetch 手写 JSON-RPC、零 SDK。不做 stdio / WebSocket / OAuth / resources / prompts / sampling / 会话恢复。工具总数上限 8 个，单条结果 2 万字符截断。设置 →「MCP」标签页添加服务，Agent 级可再按代理开关。

---

## 完全配置版（规划中）

现在是 BYO key：你自己去各家申请 Key、自己填。我们**规划中**会提供一个零配置的托管版本——统一 API、开箱即用，任何设备不必折腾密钥。具体形态与时间待定，本文档不承诺日期；当前版本的一切能力它就是它的全部。

---

## 边界与安全（先看这段再用）

- **API Key 明文存储**：所有 Key 以明文存在 vault 的 `data.json` 里（v1 从众做法）。不要把 `data.json` 提交到公开仓库、不要放进会公开同步的目录。
- **技能是提示注入面**：技能正文会原样注入 AI 的上下文，等同于提示词——**只安装你信任来源的技能**。技能永远是纯提示文本、绝不执行代码，破坏性操作的确认弹窗不受技能影响，照常兜底。
- **删除有双保险**：`delete_note` 永远强制弹窗确认（不受任何「跳过确认」设置影响）；删除与编辑前都会留全文快照，对话框顶部「撤销」可还原（撤销栈落盘，重启不丢）。
- **MCP 工具也是工具**：远程 MCP 工具的调用同样进工具链路与确认机制，别接入不受信服务。

## 平台差异声明

- **移动端（手机/平板）= 纯插件内 JS + 远程 HTTP**：零本地进程、零本地算力（embedding 也走远程），所有核心功能三端一致。
- **桌面专属能力只有一条路径 = hermes 集成**（ACP 会话 + 任务分派），由设置总开关控制；除此之外桌面与移动没有任何功能差异，也不打算对齐——两层职责不同，对称是反模式。

---

## 开发（给改代码的人）

```bash
cd obsidian-ai
npm install
npm run dev      # esbuild watch，自动同步产物到测试 vault
npm run build    # tsc strict 类型检查 + esbuild 生产构建 → main.js / manifest.json / styles.css
npm test         # jest 全量
```

产物体积受关注（main.js ≈ 470–570K 量级）；每次构建后 grep 产物确认无隐藏依赖泄漏（pglite / lexical / framer-motion / langchain 须全 0）。设计约束与历史决策见仓库根目录 `ROADMAP.md`（方向与边界）、`HANDOFF.md`（进度与坑）。

## License

MIT
