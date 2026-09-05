# DeepSeek 终端客户端调研与设计取舍

调研截止日期：**2026-08-18**。

本文记录 DeepSeek Blue TUI 在实现前后参考的公开产品、官方资料和最终取舍。功能事实尽量以项目自身仓库或厂商文档为依据；第三方项目的功能、包名和兼容性仍可能随版本变化。

## 结论先行

市场上已有两类相似实现：

1. Claude Code、CodeWhale、OpenCode、Reasonix、Deep Code 等完整终端编码智能体。它们不仅聊天，还能读写仓库、运行命令、调用工具和管理权限。
2. DeepSeek Harness（DSH）这样的智能体运行时与 Web UI。DSH 是 DeepSeek AI 官方项目，插件化程度更高，但官方快速启动需要让 `npx @deepseek-ai/dsh web` 持续占用一个终端。

因此，本项目没有再造一套高权限编码 agent，而是拆成两层：

```text
deepseek             轻量、低权限、直接 API 流式聊天与本地会话
deepseek dsh / /dsh  官方 DSH Web 的后台启动器和进程管理入口
```

这满足“像 Claude 一样在终端随时唤起”的核心体验，同时把文件、shell、工具调用和审批策略留给专门的 DSH。两层故意不共享会话和凭据，避免把两套数据模型强行耦合。

## 相似项目对比

| 项目 | 定位与已确认能力 | 可借鉴之处 | 本项目的差异 |
| --- | --- | --- | --- |
| [Claude Code](https://code.claude.com/docs/en/cli-usage) | Anthropic 的终端编码智能体；支持交互/单次调用、`--continue`、`--resume`、模型选择和大量[会话内命令](https://code.claude.com/docs/en/commands) | 命令命名、当前目录会话、启动参数与斜杠命令的一致性 | 只借鉴交互语法；没有 Claude Code 的工具、权限、MCP、hooks、checkpoint 或 agent 能力 |
| [CodeWhale](https://github.com/Hmbown/CodeWhale)（原 DeepSeek TUI） | MIT 许可的 Rust 终端编码 harness；从 DeepSeek-native 项目发展为 BYO-model、多 provider、角色/fleet、权限模式和工具执行平台，并有项目自带的 [DSH 集成设计](https://github.com/Hmbown/CodeWhale/blob/main/docs/INTEGRATIONS_DSH.md) | 本次调研最直接的社区参考：DeepSeek-first UX、鲸鱼视觉、模型/会话可见性，以及明确的 DSH 边界 | 本项目不做 fleet、工具或 provider router，只提供轻聊天和 DSH 生命周期管理。按其[更名文档](https://github.com/Hmbown/CodeWhale/blob/main/docs/REBRAND.md)，v0.9.0 已移除旧 `deepseek` shim，当前命令是 `codewhale` |
| [OpenCode](https://github.com/anomalyco/opencode) | 开源、provider-agnostic 的完整编码 agent，提供终端/桌面体验、build/plan agent 和子代理 | 清晰区分只读规划与可执行工作、成熟的多 provider 方向 | 本项目只直接服务 DeepSeek/OpenAI-compatible API，体积和权限面更小 |
| [DeepSeek Reasonix](https://github.com/esengine/DeepSeek-Reasonix) | DeepSeek-native 终端/桌面编码 agent；其 [main-v2 CLI Reference](https://github.com/esengine/DeepSeek-Reasonix/blob/main-v2/docs/CLI.md) 展示模型、状态、会话恢复、权限与工具相关命令 | `/status` 信息密度、命令分类、可诊断性 | 本项目没有 agent 工具链，仅保留对轻聊天有价值的少量命令 |
| [Deep Code](https://github.com/lessweb/deepcode-cli) | 第三方 Claude-style DeepSeek 编码助手；DeepSeek 官方文档提供了[集成指南](https://api-docs.deepseek.com/quick_start/agent_integrations/deepcode)，列出 `/new`、`/resume`、`/exit` 和 Skills | 证明 Claude-like 命令对 DeepSeek 用户已有认知基础 | 它面向编码与 Skills；本项目更轻，并把智能体能力交给官方 DSH |
| [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) | 被 DeepSeek Harness 官方公众号收录的 Claude Code 风格 TUI 插件（Ink/React，自带 ink fork）；像素鲸鱼顶栏、实时工作状态行、思考流式展开、双击 Esc 会话 rewind、上下文分段进度条与 TPS 仪表、`/btw` 侧问、`/compact`、`/export`、外部编辑器、`@` 文件引用、历史搜索、主题与 i18n，并有 VS Code companion 扩展 | 侧问不污染会话、压缩/导出/回退的工作流、上下文与 TPS 的可观测性设计、按内容类型分段的上下文进度条 | 它是 DSH 的插件前端（挂进 harness 事件流），本项目是独立直连 API 的行式 REPL；借鉴其命令语义与可观测性思路，重构为无 React、无 plugin runtime 的轻实现，详见下文「对 dsh-TUI 的借鉴与差异」 |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | DeepSeek AI 官方开源 agent harness；“一切皆插件”，提供 Web UI、工具、session log、sandbox/approval 与 agent loop | 作为高权限 companion，而不是在聊天客户端重复实现 agent runtime | 本项目仅管理它的进程和浏览器入口，不嵌入、不 fork，也不接管 DSH 的配置或数据 |

另外，DeepSeek 官方已经给出把 DeepSeek API 接入 [Claude Code、OpenCode 等工具](https://api-docs.deepseek.com/guides/coding_agents)的方法。对需要成熟编码 agent 的用户，这些方案往往比扩张本项目的权限面更合适。

## 对 dsh-TUI 的借鉴与差异

[dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI)（2026-08 调研）是当前 DeepSeek 生态中完成度最高的 Claude Code 风格终端体验，已被 DeepSeek Harness 官方公众号收录。本项目不复制其 Ink/React 架构（它 fork 了整套 Ink 渲染器，约数万行），而是借鉴其**交互语义与可观测性设计**，重写为行式 REPL 的轻实现：

| dsh-TUI 的设计 | 本项目的借鉴实现 | 差异与创新 |
| --- | --- | --- |
| `/btw` 侧问：复用上下文、无工具、单轮、不写 session log | `/btw <问题>`：单轮 streamChat，不进 `messages`、不计会话 usage | 同一套 AbortController 中断路径与错误处理；行式内联输出，无浮层面板 |
| `/compact` 历史压缩 | `/compact`：确认后模型摘要替换历史为一条 system 消息 | **压缩前自动导出备份**到 `exports/`，误操作可查；usage 计入会话 |
| `/export` 会话导出 | `/export`：Markdown 记录（含思考过程）写入数据目录 | 文件名含标题与 ID 前缀，不覆盖已有导出 |
| 双击 Esc 会话 rewind（DSH session fork） | `/rewind [编号]`：列出最近用户消息，fork 出新会话 | 永远非破坏性：原会话保持原样，新会话标题带 `· rewind` |
| `@` 文件引用（目录遍历补全、图片块） | `/attach <路径>`：单文件文本附加 | 无补全、无图片；显式 256 KiB 上限 + NUL 检测拒绝二进制，守住低权限边界 |
| `Ctrl+X` 外部编辑器 | `/edit [草稿]`：`$VISUAL`→`$EDITOR`→vi/notepad | 编辑产物直接作为下一条消息发送，多行输入不需要 Shift+Enter |
| 上下文分段进度条 + TPS 仪表 | `/status` HUD（`≈25% · ██░░ · RW · API ready`）+ 缓存命中率 + 最近一轮 TPS（≥50 绿 / ≥20 黄） | `/context` 另提供**逐条消息 token 审计**，是直连 API 客户端独有的可观测性 |
| `/` 会话内全文搜索（n/N 跳转） | `/search <关键词>`：逐行不区分大小写，带消息编号与行号 | 无跳转交互，结果一次性列出 |
| 紧凑 token 计数（`988`、`3.4k`、`12k`、`1.0M`） | `formatCompactTokens` 同款格式 | 非有限值输出 `—`，避免 NaN 进入终端 |
| 会话浏览器、主题、i18n、插件协议、轨迹场景 | 不做 | 行式 REPL 刻意保持小而可审计；见「已知差距」 |

边界保持不变：本项目仍然不执行 shell、不写工作区文件、不做 agent 工具链；上述借鉴只扩展了**会话工作流与可观测性**，不扩大权限面（`/attach` 是唯一新增的文件访问，且只读、限大小、拒二进制）。

## 官方 API 事实与实现影响

### OpenAI-compatible 接口

DeepSeek 的[首次 API 调用指南](https://api-docs.deepseek.com/guides/reasoning_model_api_example_non_streaming)给出的 OpenAI 格式 Base URL 是 `https://api.deepseek.com`。本项目直接调用：

- `POST /chat/completions`：SSE 流式聊天
- `GET /user/balance`：余额查询，字段定义见[官方余额文档](https://api-docs.deepseek.com/api/get-user-balance/)

没有引入完整 SDK，减少依赖并保留对 OpenAI-compatible Endpoint 的可配置能力。代价是协议解析、错误处理和兼容性需要自行测试。

### 当前模型名称

截至调研日期，官方文档列出 `deepseek-v4-flash` 与 `deepseek-v4-pro`。因此：

- 默认使用 `deepseek-v4-flash`，降低普通聊天的等待和成本
- `/model` 选择器同时提供 Flash 与 Pro
- 允许用户输入受限字符集内的自定义模型 ID，以兼容代理和未来模型
- 不把价格硬编码到客户端；价格会变化，应以[官方 Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)为准

### 多轮历史与 reasoning

DeepSeek 的[多轮对话指南](https://api-docs.deepseek.com/guides/multi_round_chat)说明 Chat API 是无状态的，客户端必须在每次请求中重发历史。本项目因此把会话存为本地 JSON，并在恢复后发送完整消息历史。

实现还会保存 assistant 的 `reasoning_content`，并在后续请求中回传；当前[官方 Thinking Mode 文档](https://api-docs.deepseek.com/guides/thinking_mode)说明无工具调用时该字段会被忽略，而工具调用链要求完整回传。显示与保存是两个概念：`/thinking` 只决定终端是否展示思考过程，隐藏时仍可能被 API 返回并保存在会话中。

### 思考强度（reasoning_effort）

[官方 Thinking Mode 指南](https://api-docs.deepseek.com/guides/thinking_mode)确认 DeepSeek V4（flash 与 pro 相同）在 OpenAI 格式下支持：

- 开关：`thinking: {type: "enabled"|"disabled"}`；思考模式**默认开启**
- 强度：`reasoning_effort: "low"|"high"|"max"`，**默认 high**
- 官方映射表：`low→low`、`medium→high`、`high→high`、`xhigh→high`、`max→max`（`medium`/`xhigh` 只是别名，实际都落到 high）
- 思考模式忽略 `temperature`/`top_p` 等采样参数

因此 `/effort` 只暴露 `low`/`high`/`max` 三个真实档位，不提供会静默合并的 `medium`；请求只发送 `reasoning_effort`（thinking 已默认开启）。本项目 `config.effort` 默认 `high`，与官方默认一致。

流式实现遵守官方 `stream_options.include_usage` 语义：用量 chunk 可能没有 choices；SSE 的 `[DONE]`、keep-alive 注释和不完整分块都需要容错。

## DSH 调研

### 官方状态

DeepSeek Harness 的[中文 README](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.zh.md)明确说明：

- 它由 DeepSeek AI 开发并以 MIT 许可证开源
- 架构理念是“一切皆插件”，底层由 Cordis 驱动
- 当前处于 developer preview，未来会发生破坏兼容性的变更
- 官方 npm 启动命令是 `npx @deepseek-ai/dsh web`
- 默认 Web 地址是 `http://127.0.0.1:3080`

其[架构文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)进一步展示模型 adapter、工具注册表、session log、agent loop、持久事件和 profile/bundle 都由插件组合。官方 [Web UI 指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/index.md)说明 agent 可以读取/编辑工作区、运行命令、委派工作并维护计划，相关操作受权限策略控制。

### 为什么选择进程托管，而不是嵌入

直接嵌入 DSH 会把本项目绑定到其快速变化的内部 API、插件生命周期和 Web 构建。后台托管只依赖稳定得多的 CLI 边界：

```text
dsh web --host 127.0.0.1 --port <port>
```

本项目采用以下策略：

- 不再把 `@deepseek-ai/dsh` 作为 npm 可选依赖（该依赖连带安装数百个包）；改为 `deepseek dsh install` 显式安装 `latest`，检测到 `DEEPSEEK_DSH_COMMAND`、`PATH` 或开发环境本地安装时直接复用。版本号不硬编码，一律从实际安装的包清单读取
- 用 detached child process 释放启动它的终端
- 将 stdout/stderr 追加到单独日志；日志超过 1 MiB 自动轮转保留一份，展示日志时对 `sk-` 密钥、Bearer Token 和 Authorization 头做脱敏
- 原子保存 PID、端口、URL、工作目录、启动时间和版本
- 启动后轮询本地端口，区分 running、starting、stopped 与 external
- 停止前检查 PID 存活；Unix-like 平台再检查命令形态，减少 PID 复用导致的误杀；`ps` 不可用导致身份无法核验时拒绝停止，而不是冒险
- 始终传 `127.0.0.1`，不提供对外监听快捷方式

这不是系统级 daemon：没有开机启动、崩溃拉起或崩溃自动恢复。它解决的是“无需一直挂着 npx 终端”，而不是替代进程管理器。

### 为什么不共享会话和 Key

DSH 有自己的 profile、模型 adapter、凭据、append-only session events 与工作区语义；轻聊天客户端使用简单的 OpenAI message JSON。二者强行互转会丢失工具调用、审批事件、思考块和插件上下文，也会模糊密钥归属。

所以 `/dsh` 只负责生命周期管理。用户仍在 DSH 的 Settings → Models 配置 DSH 凭据；本项目不会把 `config.json` 中的 Key 注入 DSH。

CodeWhale 提供了更深的 [DSH integration](https://github.com/Hmbown/CodeWhale/blob/main/docs/INTEGRATIONS_DSH.md)：用 overlay 连接 provider route 与权限姿态，并明确不修改 DSH 的 credentials、profiles 或 sessions。这个边界设计值得借鉴，但本项目没有 fleet、provider router 或权限模型可作为权威来源，因此只采用更窄、更易审计的进程托管。

## 设计决策

### 1. 复用 Claude-like 交互习惯，不承诺功能等价

保留用户最容易迁移的表层：

- 裸命令进入交互会话
- 带 prompt 时执行一次并退出
- `-c/--continue`、`-r/--resume` 与 `resume [ID]`
- `/model`、`/clear`、`/resume`、`/rename`、`/status`、`/exit`

没有文件工具和权限系统时，仿造 `/plan`、`/permissions`、`/mcp` 等命令只会制造错误预期，因此不提供。

### 2. `/login` 是 API Key 配置，不是假 OAuth

DeepSeek API 的调用凭据是 API Key。本项目提供两条真实路径：隐藏粘贴并本地保存，或打开官方 API Key 页面。浏览器页面不会把网页登录态自动传回 CLI，也没有声称支持账户 OAuth。

### 3. `/clear` 可恢复，而不是删除

与 Claude-style 会话工作流一致，`/clear` 先保存当前会话，再创建空会话。这样误操作可以通过 `/resume` 恢复。删除和数据擦除应当是一个独立、带确认的未来功能。

### 4. 会话按工作目录隔离

`--continue`、`/resume` 和 `deepseek sessions` 默认只查看当前工作目录的历史，避免在无关项目间意外发送上下文。JSON 文件本身存放在统一应用目录，以 UUID 命名。

### 5. 配置覆盖层明确

- Key：`DEEPSEEK_API_KEY` > `config.json`
- Endpoint：`DEEPSEEK_BASE_URL` > `config.json` > 官方默认值
- `--model`/`--endpoint`：本次进程覆盖
- `/model`/`/thinking`：写回用户配置
- `DEEPSEEK_TUI_HOME`：完整隔离配置、会话和 DSH 管理状态

这使 CI、临时测试和本地日常使用可以共享同一套二进制而不共享数据。

### 6. 视觉识别采用原创 ASCII，而非官方资产

启动页使用项目自己绘制的大鲸鱼和 `#4D6BFE` 蓝色，满足终端中的 DeepSeek 视觉联想。它不复制 DeepSeek 或 Claude 的 Logo 文件，也不声称颜色值是官方品牌规范；界面会明确显示 “Unofficial community client”。

### 7. 保持低权限默认值

聊天模式唯一主要网络动作是向所选 API Endpoint 发请求；模型输出中的常见终端控制字符会被过滤。浏览器跳转和启动 DSH 由显式命令触发，会话则在每轮消息后自动保存。高权限 workspace 操作只发生在用户另行配置和使用 DSH 时。

## 名称与分发风险

包名使用 `deepseek-blue-tui`，主可执行文件按需求命名为 `deepseek`，并额外提供等价的中性别名 `dstui`。CodeWhale 自 v0.9.0 起已移除旧 `deepseek` shim，不过用户机器上仍可能残留 v0.8.x 兼容二进制，其他第三方包也可能占用这一命令。因此：

- npm 发布前应再次检查包名、README 免责声明和搜索结果
- 安装文档必须提醒全局 bin 冲突，并说明 `dstui` 别名可以直接替代
- 故障排查应先确认 `command -v deepseek` / `where deepseek` 指向哪个包

## 已知差距与后续优先级

这些不是已承诺功能，而是调研后最有价值的改进顺序（v0.1 已落地文件锁、上下文估算预警/裁剪、bracketed paste、DSH 显式安装与日志轮转脱敏，故从清单中移除）：

1. 系统钥匙串适配与明确的数据删除命令（导出已有 `/export`，删除仍未提供）
2. 模型级上下文压缩：现有实现是启发式估算 + 超限裁剪 + `/compact` 手动摘要，不是自动压缩
3. 内联多行编辑、Markdown 渲染和更多终端兼容性测试（`/edit` 外部编辑器与 bracketed paste 已覆盖多行输入的主路径）
4. `/doctor`：检查 Node、命令冲突、凭据来源、Endpoint 和 DSH 版本
5. 会话级精确费用估算；价格必须动态或显式带版本，不能长期硬编码
6. DSH 版本兼容矩阵和更明确的 stale state 修复入口（日志轮转与脱敏已完成）
7. 借鉴 dsh-TUI 但暂未采纳的能力：会话浏览器式 `/resume`、主题、界面语言切换、消息选择模式、输入历史搜索（Ctrl+R 等价物）

若未来加入文件或命令工具，必须先设计 workspace 边界、逐项审批、审计日志、超时、输出上限和跨平台 sandbox，不能仅把 shell 接到模型输出上。

## 主要资料链接

- [DeepSeek API：Your First API Call](https://api-docs.deepseek.com/guides/reasoning_model_api_example_non_streaming)
- [DeepSeek API：Create Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion)
- [DeepSeek API：Multi-round Conversation](https://api-docs.deepseek.com/guides/multi_round_chat)
- [DeepSeek API：Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)
- [DeepSeek API：Get User Balance](https://api-docs.deepseek.com/api/get-user-balance/)
- [DeepSeek API：Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)
- [DeepSeek API：Integrate with AI Tools](https://api-docs.deepseek.com/guides/coding_agents)
- [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)
- [DeepSeek Harness npm 包](https://www.npmjs.com/package/@deepseek-ai/dsh)
- [DeepSeek Harness 中文 README](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.zh.md)
- [DeepSeek Harness Web UI 指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/index.md)
- [DeepSeek Harness 架构](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [Claude Code CLI Reference](https://code.claude.com/docs/en/cli-usage)
- [Claude Code Commands](https://code.claude.com/docs/en/commands)
- [OpenCode](https://github.com/anomalyco/opencode)
- [CodeWhale（原 DeepSeek TUI）](https://github.com/Hmbown/CodeWhale)
- [CodeWhale 更名说明](https://github.com/Hmbown/CodeWhale/blob/main/docs/REBRAND.md)
- [CodeWhale × DSH 集成说明](https://github.com/Hmbown/CodeWhale/blob/main/docs/INTEGRATIONS_DSH.md)
- [DeepSeek Reasonix](https://github.com/esengine/DeepSeek-Reasonix)
- [DeepSeek Reasonix main-v2 CLI Reference](https://github.com/esengine/DeepSeek-Reasonix/blob/main-v2/docs/CLI.md)
- [Deep Code](https://github.com/lessweb/deepcode-cli)
- [dsh-TUI 仓库](https://github.com/ccch1mneyyy/dsh-TUI)
- [dsh-TUI 交互与命令](https://github.com/ccch1mneyyy/dsh-TUI/blob/main/docs/interaction.md)
