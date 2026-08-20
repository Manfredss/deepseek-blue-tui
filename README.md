# DeepSeek Blue TUI

一个面向 DeepSeek API 的轻量终端聊天客户端：输入 `deepseek` 即可进入交互界面，支持流式输出、模型切换、会话恢复、余额查询，以及对官方 DeepSeek Harness（DSH）Web UI 的后台管理。

> 本项目是非官方社区项目，不隶属于 DeepSeek AI 或 Anthropic。它借鉴了 Claude Code 的命令习惯，但不是 Claude Code 的复刻，也不是完整的编码智能体。需要读写文件、运行命令、调用工具或规划任务时，请使用集成的官方 DSH。

<!-- 仓库推送到 https://github.com/manfredss/deepseek-blue-tui 后 CI 徽章自动生效 -->
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![CI](https://github.com/manfredss/deepseek-blue-tui/actions/workflows/ci.yml/badge.svg)](https://github.com/manfredss/deepseek-blue-tui/actions/workflows/ci.yml)

## 功能概览

- `deepseek` 启动交互终端，显示 DeepSeek 蓝色 ASCII 大鲸鱼；`dstui` 是等价的中性别名
- DeepSeek OpenAI-compatible API 流式聊天
- 默认推荐 `deepseek-v4-flash`，可切换到 `deepseek-v4-pro` 或自定义模型 ID
- Claude-like 的 `/model`、`/login`、`/usage`、`/clear`、`/resume`、`/exit` 等命令
- 会话工作流全家桶：`/btw` 侧问（不写入会话）、`/compact` 历史压缩（自动备份）、`/export` Markdown 导出、`/rewind` 从更早消息分支、`/search` 会话内全文搜索
- 输入增强：`/edit` 用 `$VISUAL`/`$EDITOR` 编写多行消息、`/attach` 附加文本文件（≤256 KiB、拒绝二进制）、bracketed paste 原样粘贴
- 可观测性：`/status` 上下文 HUD + 分段进度条 + 缓存命中率 + 最近一轮 TPS；`/context` 逐条消息 token 审计
- 按当前工作目录保存会话，支持标题、恢复和累计 Token 统计；跨终端文件锁防止互相覆盖
- 上下文长度估算：接近上限时预警，超限时自动裁剪最早的普通消息（`contextLimitTokens` 可配）
- 隐藏输入 API Key；也可只使用环境变量，不落盘密钥
- 后台启动、打开、检查、停止和查看官方 DSH Web 日志；日志自动轮转并按规则脱敏
- macOS、Linux 与 Windows 的浏览器打开适配

当前终端界面是行式 REPL，而不是占用全屏的 widget TUI。它专注聊天与会话管理，不会自行读取文件、执行 shell、修改代码或调用 MCP；`/attach` 只在用户显式指定路径时读取单个文本文件。

## 环境要求

- Node.js `>= 22.19.0`
- 一个 [DeepSeek API Key](https://platform.deepseek.com/api_keys)
- 交互模式需要真实 TTY；脚本或非交互环境请使用单次提问模式
- DSH 功能需要 `@deepseek-ai/dsh`；首次使用前运行一次 `deepseek dsh install`（见 [DSH 后台管理](#dsh-后台管理)）

## 安装

### 从 GitHub 源码安装

```bash
git clone https://github.com/manfredss/deepseek-blue-tui.git
cd deepseek-blue-tui
npm ci
npm install -g .
deepseek --version
```

发布到 npm 后也可以直接 `npm install -g deepseek-blue-tui`（发布前请勿执行；包名当前尚未发布）。

不想全局安装时，可以直接开发运行：

```bash
npm run dev
npm run dev -- "解释这个项目"
```

安装前可用 `command -v deepseek`（Windows 使用 `where deepseek`）检查是否已有同名命令。原 Hmbown/DeepSeek-TUI 已更名为 [CodeWhale](https://github.com/Hmbown/CodeWhale)，当前使用 `codewhale`；但旧 v0.8.x 安装曾提供 `deepseek` 兼容 shim，其他第三方包也可能占用该名字。若发生冲突，本项目提供等价的中性别名 `dstui`，用法完全一致。

DSH 不再作为可选依赖随包安装（该依赖会连带安装数百个包）。首次需要 DSH 时运行：

```bash
deepseek dsh install
```

该命令会全局安装已验证的 `@deepseek-ai/dsh@0.1.0-rc.7`；若检测到任何可用的 `dsh`（`DEEPSEEK_DSH_COMMAND`、PATH 或开发环境的本地安装）会直接复用而不重复安装。

### 卸载

```bash
npm uninstall -g deepseek-blue-tui
```

卸载不会删除数据。会话、配置和 DSH 状态位于 `~/.config/deepseek-tui`（见下文「数据、配置与密钥位置」）；用 `deepseek dsh install` 安装的 DSH 本体留在 npm 全局目录，可另行 `npm uninstall -g @deepseek-ai/dsh`。

## 快速开始

交互配置 API Key：

```bash
deepseek login
```

也可以只在当前 shell 提供密钥。环境变量优先于 `/login` 保存的值：

```bash
export DEEPSEEK_API_KEY="sk-..."
deepseek
```

首次启动会看到响应式欢迎卡片、蓝色鲸鱼和提示符。真彩/256 色终端会显示 dsh-TUI 同款半块像素鲸鱼（40×13 终端单元格，深蓝轮廓、DeepSeek 蓝身体、冰蓝腹部），ANSI-16 与纯文本模式回退到下方的前景鲸鱼。宽终端使用双栏，窄终端自动切为单栏；开始对话前调整窗口尺寸，首屏会即时重绘。对话开始后保留 scrollback，不会为了重排擦除历史：

```text
╭─ DeepSeek TUI v0.1.0 ───────────────────────────────────────────────╮
│        Welcome back!         │ Tips for getting started             │
│      ▄▄▄▄▄▄▄       ▄▄  ▄▄    │ /login   Configure your API key     │
│  ▄████████████▄    ███▄███   │ /model   Switch the model           │
│▄████████████▀ ▀██████████▀   │ /resume  Continue a conversation    │
│████▀    ▀████▄  ▀██●████▄    │ /dsh     Open Harness Web           │
│ deepseek-v4-flash · API …    │ /help    Show every command         │
╰────────────────────────────────────────────────────────────────────╯
──────────────────────────────────────────────────────────────────────
● deepseek-v4-flash · /help 查看命令
❯ 你好
```

Logo 只在交互模式出现。使用 `--no-logo` 可隐藏，使用 `--no-color` 可关闭 ANSI 颜色。支持真彩色的终端使用 DeepSeek 品牌蓝 `#4D6BFE`；Apple Terminal 等 256 色终端会自动使用最接近的安全蓝色。像素鲸鱼只设置鲸鱼单元格的前景/背景色，不会修改终端全局背景色。一次典型的会话长这样：

```text
❯ /model
  1  DeepSeek V4 Flash ✓
     快速、低成本，适合作为默认模型
  2  DeepSeek V4 Pro
     能力更强，适合复杂任务
编号或自定义模型名称（回车取消）› 2
✓ 已切换到 deepseek-v4-pro

❯ 用一句话解释什么是大语言模型
● 正在思考…
◆ DeepSeek
大语言模型是在海量文本上训练、通过预测下一个词来学习语言的神经网络……

❯ /status
模型      deepseek-v4-pro
API       https://api.deepseek.com
凭据      sk-12••••cdef
会话      e071f4dd · 2 条消息
Token     89 总计

❯ /exit
再见。
```

## 命令行用法

```bash
# 交互聊天
deepseek

# 单次提问：流式答案写入 stdout，结束后退出
deepseek "用三点解释这个项目"

# 临时指定模型或显示 reasoning_content
deepseek --model deepseek-v4-pro --thinking "分析这个错误"

# 恢复当前目录最近会话
deepseek --continue
deepseek --continue "接着刚才的结论继续"

# 选择历史会话，或按 ID/标题恢复
deepseek resume
deepseek resume <session-id>
deepseek resume <session-id> "继续完成上一项工作"

# 其他入口
deepseek login
deepseek usage
deepseek usage topup
deepseek sessions
deepseek dsh install
deepseek dsh status
```

`dstui` 与 `deepseek` 完全等价，所有示例中的 `deepseek` 都可以替换为 `dstui`。

单次提问也会保存为本地会话。启用 `--thinking` 时，最终答案写到 `stdout`，思考过程写到 `stderr`，方便脚本分别处理。当前版本不从 `stdin` 读取 prompt，请把问题作为参数传入。

### 通用选项

| 选项 | 作用 |
| --- | --- |
| `-m, --model <名称>` | 新会话在本次启动中使用指定模型 |
| `-c, --continue` | 恢复当前目录最近会话 |
| `-r, --resume [ID]` | 选择或恢复当前目录的会话 |
| `--endpoint <URL>` | 本次启动使用自定义 OpenAI-compatible API 地址 |
| `--base-url <URL>` | `--endpoint` 的等价写法 |
| `--thinking` | 显示 API 返回的思考过程 |
| `--no-logo` | 交互模式不显示鲸鱼 |
| `--no-color` | 交互模式不使用 ANSI 颜色 |
| `-h, --help` | 显示帮助 |
| `-V, --version` | 显示版本 |

命令行传入的模型、Endpoint 和 `--thinking` 主要用于本次启动；恢复旧会话时保留该会话自己的模型。在交互会话中用 `/model` 或 `/thinking` 修改时会写入配置。

## 交互斜杠命令

在主提示符键入 `/` 会即时展开命令菜单；继续输入（例如 `/mo`）会实时过滤，按 `Esc` 可收起。菜单出现后可用 `↑`/`↓` 在所有匹配命令中移动高亮（长列表会自动滚动），按 `Enter` 直接执行高亮命令；如果还没有按过方向键，`Enter` 仍按普通输入提交。菜单会根据终端的最新宽度和高度重新排版，窄窗口自动隐藏说明文字。命令只会在消息开头识别；若确实要把 `/model` 作为普通消息发给模型，请输入 `//model`。二级选择提示（例如 `/model` 的编号选择）不会错误弹出菜单。

主命令菜单和所有选项列表（`/model` 选择器、`/resume` 会话列表、`/rewind` 回退点、`/login` 登录方式）都是**可键盘导航的菜单**：`↑`/`↓` 移动高亮，`Enter` 确认当前项，`Esc` 取消，数字键直接跳转；`/model` 菜单还支持直接键入自定义模型 ID 后回车。

| 命令 | 行为 |
| --- | --- |
| `/model [名称]` | 无参数时打开 Flash/Pro 选择；也可直接传自定义模型 ID |
| `/login` | 选择隐藏粘贴 API Key，或打开官方 API Key 页面 |
| `/login browser` | 直接打开官方 API Key 页面；不会自动把网页登录态带回终端 |
| `/logout` | 删除 `config.json` 中保存的 API Key；环境变量仍可能生效 |
| `/usage` | 有 Key 时先查询余额，再打开官方用量页 |
| `/usage topup` | 查询余额并打开充值页；`top-up` 也可使用 |
| `/clear` | 保存当前会话并开始空会话；旧会话仍可恢复 |
| `/resume [ID/标题]` | 浏览或匹配当前目录的历史会话 |
| `/rename <标题>` | 重命名当前会话，最长保存 100 个字符 |
| `/thinking [on\|off]` | 显示、隐藏或切换思考过程的可见性 |
| `/status` | 上下文 HUD、Token/缓存/最近一轮 TPS、Endpoint、遮罩凭据与 DSH 状态 |
| `/context` | 逐条消息的 token 估算与按角色/思考的分段构成 |
| `/btw <问题>` | 侧问：复用当前上下文做单轮问答，不写入会话历史、不计入会话 Token |
| `/compact` | 把历史压缩为一条摘要消息（压缩前自动导出备份到数据目录） |
| `/export` | 把当前会话导出为 Markdown 文件（保存到数据目录 `exports/`） |
| `/edit [草稿]` | 用 `$VISUAL`/`$EDITOR`（未设置时 vi/notepad）编写下一条多行消息 |
| `/attach <路径>` | 附加一个文本文件（支持 `~` 和相对路径，≤256 KiB，拒绝二进制）并发送 |
| `/rewind [编号]` | 从更早的用户消息分支一个新会话；原会话保持不变 |
| `/search <关键词>` | 在当前会话内做不区分大小写的逐行全文搜索 |
| `/dsh [动作] [端口]` | 管理 DSH；动作见下一节 |
| `/exit` | 保存并退出；`/quit` 或提示符下 `Ctrl+C` 也可退出 |

另外支持 `/new` 作为 `/clear` 的别名、`/sessions` 作为 `/resume` 的别名。生成过程中按 `Ctrl+C` 会取消本次生成；已收到的部分内容仍会保存在会话中。

会话使用文件锁防止两个终端同时写同一会话：第二个终端会提示进入只读模式（可以继续提问，但回复不落盘），第一个终端退出后重启即可恢复读写。同一会话在同一终端内不会受影响。

`/thinking` 和 `--thinking` 只控制是否把 API 返回的 `reasoning_content` 显示在终端，不等同于切换模型的 thinking 参数。

## DSH 后台管理

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 是 DeepSeek AI 官方开源的智能体框架。官方快速启动方式是持续运行 `npx @deepseek-ai/dsh web`；本项目把它包装为一个脱离当前终端的后台进程：

```bash
# 首次使用：安装已验证的固定版本（检测到可用 dsh 时自动跳过）
deepseek dsh install

# 后台启动并打开浏览器（默认 127.0.0.1:3080）
deepseek dsh start

# 连接到已运行的实例并打开；也允许打开该端口上的外部实例
deepseek dsh open

# 状态、日志、重启和停止
deepseek dsh status
deepseek dsh logs --lines 120
deepseek dsh restart
deepseek dsh stop

# 临时改端口，或启动后不打开浏览器
deepseek dsh start --port 3090 --no-open
```

交互终端中可使用：

```text
/dsh install
/dsh
/dsh status
/dsh start 3090
/dsh logs
/dsh restart 3090
/dsh stop
```

实现要点：

- 固定绑定 `127.0.0.1`，不会主动暴露到局域网
- 优先使用 `DEEPSEEK_DSH_COMMAND` 指定的单个可执行文件，其次使用开发环境随项目安装的包，最后查找 `PATH` 中的 `dsh`；找不到时会提示 `deepseek dsh install`
- 记录 PID、工作目录和日志；再次执行命令即可管理，不必一直挂着 `npx` 终端
- 只停止本项目记录的 PID；Unix-like 平台还会核对进程命令，避免误杀复用 PID 的其他进程；无法核验身份时拒绝停止而不是冒险
- 端口被非本项目管理的进程占用时，`start` 会拒绝接管；`open` 可以只打开它
- 日志超过 1 MiB 自动轮转（保留 `dsh.log.1`）；读取日志时对 `sk-` 密钥、Bearer Token 和 Authorization 头做脱敏

本项目已针对 [`@deepseek-ai/dsh@0.1.0-rc.7`](https://www.npmjs.com/package/@deepseek-ai/dsh) 验证。DSH 官方仍将其标记为 developer preview，未来可能有破坏性更新，因此这里选择固定版本并在检测到其他版本时提示。后台进程不是开机服务，重启系统后需重新启动。

### 两套体验的边界

- `deepseek` 聊天直接调用 DeepSeek API，只管理本项目自己的 JSON 会话。
- `deepseek dsh` 启动官方 DSH Web；DSH 能读取和编辑工作区、执行命令、委派任务并应用自己的权限策略。
- 两者不共享会话、模型配置或 API Key。首次进入 DSH Web 后，仍需按[官方 Web UI 指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/index.md)在 Settings → Models 中配置模型和凭据。

## 数据、配置与密钥位置

默认应用目录：

| 平台/设置 | 路径 |
| --- | --- |
| `DEEPSEEK_TUI_HOME` 已设置 | 该变量指定的目录 |
| Windows | `%APPDATA%\deepseek-tui` |
| 设置了 `XDG_CONFIG_HOME` | `$XDG_CONFIG_HOME/deepseek-tui` |
| macOS/Linux 默认 | `~/.config/deepseek-tui` |

目录结构：

```text
deepseek-tui/
├── config.json          # 模型、Endpoint、显示偏好、DSH 端口、contextLimitTokens；可能含 API Key
├── sessions/
│   ├── <uuid>.json      # 消息、reasoning、工作目录与 Token 统计
│   └── <uuid>.json.lock # 会话文件锁（防止两个终端互相覆盖；进程退出后自动释放）
├── exports/
│   └── <标题>-<id8>.md  # /export 与 /compact 备份产生的 Markdown 记录
└── dsh/
    ├── state.json       # 由本项目启动的 DSH PID/端口/工作目录
    ├── dsh.log          # DSH stdout/stderr（展示时脱敏）
    └── dsh.log.1        # 超过 1 MiB 时轮转出的上一份日志
```

重要环境变量：

| 变量 | 优先级与用途 |
| --- | --- |
| `DEEPSEEK_API_KEY` | 高于本地 `config.json` 中的 Key |
| `DEEPSEEK_BASE_URL` | 高于本地 Endpoint；必须是有效的 `http(s)` URL |
| `DEEPSEEK_TUI_HOME` | 覆盖整个数据目录，适合隔离开发和测试 |
| `DEEPSEEK_DSH_COMMAND` | 指向 DSH 的单个可执行文件或 `PATH` 命令名，不接受一整段 shell 命令 |

默认 API 地址是 `https://api.deepseek.com`。默认模型是 `deepseek-v4-flash`；`deepseek-v4-pro` 也在当前[官方模型与价格文档](https://api-docs.deepseek.com/quick_start/pricing)中列出。

## 安全说明

- `/login` 会隐藏终端输入，但保存后的 API Key 仍是本地明文。Unix 平台创建目录时使用 `0700`、文件使用 `0600`；这不是系统钥匙串。
- 不希望 Key 落盘时，仅使用 `DEEPSEEK_API_KEY`。`/logout` 只删除配置文件中的 Key，不会清除 shell 环境变量、历史会话或 DSH 自己的凭据。
- 会话 JSON 包含完整提问、回答和可能的思考内容。不要把数据目录、调试副本或 DSH 日志提交到版本库或公开分享；`dsh logs` 输出会先对 `sk-` 密钥、Bearer Token 与 Authorization 头脱敏，但轮转出的原始 `dsh.log` 文件本身不做改写，删除时请连同 `dsh.log.1` 一起处理。
- 使用 `--endpoint`/`DEEPSEEK_BASE_URL` 时，所选服务会收到 Authorization Header 和完整会话；除受信任的本地服务外应优先使用 HTTPS，并为不同服务使用不同密钥。
- DSH 是可以操作工作区的智能体。启动后请在 Web UI 中核对 workspace、模型和权限；不要把本地端口通过反向代理或端口转发公开暴露。
- 模型输出在写入终端前会移除常见控制字符，但仍应把模型生成的命令和代码当作不可信内容审阅。

## 当前限制

- 没有内置文件、shell、Git、Web Search、MCP、Skills 或工具调用；这些能力交给 DSH；`/attach` 仅按用户显式路径读取单个文本文件
- 没有逐行内联的多行编辑器、Markdown 全屏渲染、图片输入或键盘驱动弹窗；多行输入可用 `/edit`（外部编辑器）或 bracketed paste
- 上下文管理是估算预警 + 超限裁剪 + `/compact` 手动摘要压缩，不是模型级的自动压缩；估算使用启发式（CJK ≈ 1 token/字，ASCII ≈ 4 字/token）
- 没有系统钥匙串、会话删除命令或跨设备同步；导出用 `/export`
- `/usage` 查询账号余额并打开官方页面，余额请求默认 15 秒超时；当前不计算精确的会话货币成本

完整竞品调研与设计取舍见 [RESEARCH.md](./RESEARCH.md)。

## 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| `deepseek: command not found` | 全局安装未完成；先运行 `npm install -g .`，并用 `command -v deepseek`（Windows 用 `where deepseek`）确认路径。若指向其他包（例如旧版 Hmbown/DeepSeek-TUI 的 shim），请卸载后重新安装本项目 |
| 交互模式报「需要 TTY」 | 管道或脚本环境无法交互；改用单次提问 `deepseek "你的问题"` |
| 报「缺少 API Key」 | 运行 `deepseek login`，或设置 `DEEPSEEK_API_KEY` 环境变量 |
| 请求报「无法连接 `<Endpoint>`」 | 检查 `--endpoint`/`DEEPSEEK_BASE_URL`、代理、DNS 和防火墙，确认提示中的地址可达；底层错误会保留在括号中帮助诊断 |
| `/usage` 显示「暂时无法查询余额」 | 余额接口与 Key/Endpoint 不匹配或 15 秒内没有响应；用 `/status` 核对凭据来源（环境变量优先于本地配置） |
| `dsh start` 报「端口已由其他进程占用」 | 该端口已有进程监听；换端口 `dsh start --port 3090`，或先 `dsh stop` 由本项目管理的旧实例。若确认是本项目实例却无法 stop，可查 `deepseek dsh logs` |
| `dsh start` 报「未找到 DSH」 | 运行 `deepseek dsh install` 安装固定版本，或用 `DEEPSEEK_DSH_COMMAND` 指向已安装的 `dsh` |
| 恢复会话提示「正被另一个终端使用」 | 该会话已被另一个终端加锁，本实例为只读；关闭另一个终端后重启即可恢复读写。若是残留锁（对应进程已退出），下次启动会自动接管 |
| 恢复会话看不到历史 | 会话按工作目录隔离；`--continue`、`/resume` 只查看当前目录，`deepseek sessions` 可按目录核对 |
| 提示上下文超限并裁剪消息 | 会话估算超过 `config.json` 中的 `contextLimitTokens`（默认 131072）；裁剪保留最新消息，也可调大该值或 `/clear` 开新会话 |
| 数据目录异常 | 删除损坏的 `~/.config/deepseek-tui` 前先备份；可用 `DEEPSEEK_TUI_HOME=/tmp/…` 隔离验证 |

## 常见问题

**和 Claude Code 有什么区别？** 本项目只有聊天、会话与 DSH 生命周期管理，没有工具调用、权限、MCP 和 agent 能力；交互命令命名借鉴了 Claude Code 以降低迁移成本。需要完整编码智能体时，用 `/dsh` 启动官方 DSH，或参考 DeepSeek 官方文档接入 Claude Code / OpenCode。

**为什么直接调 API，不嵌入官方 SDK？** 请求面很小（`/chat/completions` 流式 + `/user/balance`），直接调用可以减少依赖、保留 `--endpoint` 兼容 OpenAI-compatible 网关的能力。协议解析与错误处理有对应的单元测试覆盖。

**`deepseek` 和 `deepseek dsh` 是什么关系？** 前者是本项目的轻量聊天，后者是官方 DeepSeek Harness Web 的后台启动器。两者不共享会话、配置和 API Key，详见 [DSH 后台管理](#dsh-后台管理)。

## 贡献与路线图

欢迎以 Issue 和 PR 形式参与：报告 bug 时请附上 `deepseek --version`、Node 版本、操作系统和复现步骤；改动请先运行 `npm run check`。约定见 [CONTRIBUTING.md](./CONTRIBUTING.md)，行为准则见 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)，安全漏洞请按 [SECURITY.md](./SECURITY.md) 私下报告。

计划中的改进优先级见 [RESEARCH.md「已知差距与后续优先级」](./RESEARCH.md#已知差距与后续优先级)，主要包括：钥匙串适配与会话删除/导出、模型级上下文压缩、完整多行编辑器、`/doctor` 自检命令、精确费用估算与 DSH 兼容矩阵。版本记录见 [CHANGELOG.md](./CHANGELOG.md)。

## 开发与测试

```bash
npm ci   # 或 npm install（CI 环境使用 npm ci 以保证 lockfile 一致性）

# 开发运行
npm run dev -- --help
npm run dev

# 静态检查、单元测试和完整检查
npm run typecheck
npm test
npm run check

# 构建及产物烟测
npm run build
node dist/cli.js --help
node dist/cli.js --version
```

建议用隔离目录进行手动测试，以免读写日常配置：

```bash
DEEPSEEK_TUI_HOME=/tmp/deepseek-blue-tui-dev npm run dev
DEEPSEEK_TUI_HOME=/tmp/deepseek-blue-tui-dev npm run dev -- dsh status
```

真实 API 流式测试需要有效 Key，并会产生相应 API 用量。DSH 烟测可以依次运行 `dsh start --no-open`、`dsh status`、`dsh logs`、`dsh stop`；测试结束应停止由本项目启动的后台进程。

## 许可证与品牌

代码以 [MIT License](./LICENSE) 发布。

“DeepSeek”及相关标识属于其权利人。本项目标题、命令名与蓝色视觉用于描述兼容的服务；鲸鱼是本项目绘制的终端 ASCII 图案，强调色为 `#4D6BFE`，不声称是 DeepSeek 官方 Logo 或官方品牌规范。Claude 与 Claude Code 属于 Anthropic；本项目仅借鉴其终端交互惯例，未使用其代码或视觉资产。
