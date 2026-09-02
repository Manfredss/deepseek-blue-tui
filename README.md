<div align="center">

# 🐋 DeepSeek Blue TUI

**一个为 DeepSeek API 打造的轻量终端聊天客户端**

流式对话 · 会话恢复 · 上下文可观测 · 官方 Harness 后台托管

[![CI](https://github.com/Manfredss/deepseek-blue-tui/actions/workflows/ci.yml/badge.svg)](https://github.com/Manfredss/deepseek-blue-tui/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-4D6BFE.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19-3C873A.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6.svg)](./tsconfig.json)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)](#安装)

**简体中文** · [English](./README.en.md)

<img width="913" alt="DeepSeek Blue TUI 启动界面" src="https://github.com/user-attachments/assets/24d79a7f-c292-4174-97d8-e258ff515512" />

</div>

---

> [!NOTE]
> 本项目是**非官方社区项目**，不隶属于 DeepSeek AI 或 Anthropic。它借鉴了 Claude Code 的命令习惯，但不是 Claude Code 的复刻，也不是完整的编码智能体。需要读写文件、运行命令、调用工具或规划任务时，请使用集成的官方 DSH。

## 目录

[特性一览](#特性一览) · [快速开始](#快速开始) · [安装](#安装) · [键盘快捷键](#键盘快捷键) · [斜杠命令](#斜杠命令) · [命令行用法](#命令行用法) · [DSH 后台管理](#dsh-后台管理) · [数据与配置](#数据配置与密钥位置) · [安全说明](#安全说明) · [当前限制](#当前限制) · [故障排查](#故障排查) · [开发与测试](#开发与测试)

## 特性一览

| | |
| --- | --- |
| 🐋 **像素鲸鱼欢迎页** | 真彩/256 色终端渲染 dsh-TUI 同款半块像素鲸鱼；ANSI-16 或 `--no-color` 回退字符鲸鱼，窄终端自动切换单栏布局 |
| ⚡ **流式对话** | 直连 DeepSeek OpenAI-compatible API；默认 `deepseek-v4-flash`，可切到 `deepseek-v4-pro` 或任意自定义模型 ID |
| 🧠 **思考强度控制** | `/effort [low\|high\|max]` 直接映射官方 `reasoning_effort`；`/thinking` 控制是否显示思考过程 |
| ⌨️ **Claude Code 式手感** | <kbd>Tab</kbd> 补全命令、<kbd>Esc</kbd> 中断生成、<kbd>Ctrl</kbd>+<kbd>C</kbd> 清空输入、行尾 `\` 换行续写、<kbd>↑</kbd> 翻阅跨会话历史 |
| 📊 **上下文可观测** | 生成中显示用时与思考 token 的实时状态行；每轮结束打印输入/输出/缓存/耗时/TPS；`/status` 一屏面板、`/context` 逐条审计 |
| 🗂️ **会话工作流** | `/btw` 侧问、`/compact` 压缩（自动备份）、`/export` 导出 Markdown、`/rewind` 分支回退、`/search` 会话内全文搜索 |
| 🔒 **凭据与隔离** | 隐藏输入保存 API Key（`0600`），或只用环境变量不落盘；会话按工作目录隔离并加文件锁防止互相覆盖 |
| 🐳 **官方 Harness 托管** | 一条命令后台启动/打开/停止官方 DSH Web，日志自动轮转并对密钥脱敏 |

当前终端界面是**行式 REPL**，不是占用全屏的 widget TUI。它专注聊天与会话管理，不会自行读取文件、执行 shell、修改代码或调用 MCP；`/attach` 只在你显式指定路径时读取单个文本文件。

## 快速开始

```bash
# 1. 安装
git clone https://github.com/Manfredss/deepseek-blue-tui.git
cd deepseek-blue-tui && npm ci && npm install -g .

# 2. 配置 API Key（或直接 export DEEPSEEK_API_KEY="sk-..."）
deepseek login

# 3. 开聊
deepseek
```

需要 Node.js `>= 22.19.0`、一个 [DeepSeek API Key](https://platform.deepseek.com/api_keys)，以及一个真实 TTY（脚本环境请用单次提问模式）。

一次典型会话长这样：

```text
❯ /mo⇥                                   ← Tab 补全成 /model

选择模型

❯ 1  DeepSeek V4 Flash ✓  快速、低成本，适合作为默认模型
  2  DeepSeek V4 Pro      能力更强，适合复杂任务

↑/↓ 选择 · Enter 确认 · Esc 取消 · 直接输入自定义模型 ID

✓ 已切换到 deepseek-v4-pro

❯ 用一句话解释什么是大语言模型

⠹ 正在思考… (2s · 思考 184 tokens · esc 中断)
◆ DeepSeek
大语言模型是在海量文本上训练、通过预测下一个词来学习语言的神经网络……

54 in · 35 out · 128 thinking · 缓存 32 · 2.4s · 14.6 tok/s

❯ /status

状态
  模型    deepseek-v4-pro · https://api.deepseek.com
  思考    high · 默认档，深度思考 · 过程隐藏
  上下文  ≈0% ░░░░░░░░░░░░░░░░░░░░ 89/131k · 2 条消息
  累计    89 tokens · 缓存命中 32 (36.0%)
  速度    14.6 tok/s（最近一轮）
  会话    e071f4dd · 用一句话解释什么是大语言模型
  凭据    sk-12••••cdef
  目录    /Users/you/code/demo
  DSH     已停止 · http://127.0.0.1:3080

❯ /exit
再见。
```

Logo 只在交互模式出现：`--no-logo` 隐藏鲸鱼，`--no-color` 关闭 ANSI 颜色。真彩终端使用 DeepSeek 品牌蓝 `#4D6BFE`，Apple Terminal 等 256 色终端自动取最接近的安全蓝；像素鲸鱼只设置自身单元格的前景/背景色，不会改动终端全局背景。

## 安装

### 从源码安装

```bash
git clone https://github.com/Manfredss/deepseek-blue-tui.git
cd deepseek-blue-tui
npm ci
npm install -g .
deepseek --version
```

发布到 npm 后也可以直接 `npm install -g deepseek-blue-tui`（**包名当前尚未发布**，发布前请勿执行）。

不想全局安装时，可以直接开发运行：

```bash
npm run dev
npm run dev -- "解释这个项目"
```

> [!TIP]
> 安装前建议用 `command -v deepseek`（Windows 用 `where deepseek`）检查是否已有同名命令。原 Hmbown/DeepSeek-TUI 已更名为 [CodeWhale](https://github.com/Hmbown/CodeWhale)，但旧 v0.8.x 安装曾提供 `deepseek` 兼容 shim，其他第三方包也可能占用该名字。若发生冲突，本项目提供完全等价的中性别名 **`dstui`**。

### 安装 DSH（可选）

DSH 不再作为可选依赖随包安装（它会连带拉入数百个包）。首次需要时运行一次：

```bash
deepseek dsh install
```

该命令安装已验证的 `@deepseek-ai/dsh@0.1.0-rc.7`；若检测到任何可用的 `dsh`（`DEEPSEEK_DSH_COMMAND`、`PATH` 或开发环境的本地安装）会直接复用而不重复安装。

<details>
<summary><b>卸载</b></summary>

```bash
npm uninstall -g deepseek-blue-tui
```

卸载不会删除数据。会话、配置和 DSH 状态位于 `~/.config/deepseek-tui`（见[数据与配置](#数据配置与密钥位置)）；用 `deepseek dsh install` 安装的 DSH 本体留在 npm 全局目录，可另行 `npm uninstall -g @deepseek-ai/dsh`。

</details>

## 键盘快捷键

| 按键 | 行为 |
| --- | --- |
| <kbd>Enter</kbd> | 发送消息；行尾加 `\` 则换行继续输入（提示符变为 `…`） |
| <kbd>Tab</kbd> | 补全命令：`/mo` → `/model`。多个匹配时先补到共同前缀，补不动就高亮第一个，再按一次采用它 |
| <kbd>/</kbd> 后 <kbd>↑</kbd> <kbd>↓</kbd> | 在命令面板中移动高亮，<kbd>Enter</kbd> 执行，<kbd>Esc</kbd> 收起面板 |
| <kbd>↑</kbd> <kbd>↓</kbd> | 空提示符下翻阅输入历史（跨会话保存） |
| <kbd>Esc</kbd> | 中断正在生成的回复 |
| <kbd>Ctrl</kbd>+<kbd>C</kbd> | 清空当前输入；输入已为空时连按两次退出 |
| <kbd>Ctrl</kbd>+<kbd>D</kbd> | 直接退出 |
| <kbd>Ctrl</kbd>+<kbd>L</kbd> | 清屏 |

输入历史保存在数据目录下的 `history`（权限 `0600`，最多 500 条）。看起来像 API Key 的行（`sk-…`）、空行、重复行、粘贴进来的多行文本以及 `/exit` **不会**写入历史。

## 斜杠命令

在主提示符键入 `/` 会即时展开命令菜单；继续输入（例如 `/mo`）实时过滤，<kbd>Tab</kbd> 补全，<kbd>Esc</kbd> 收起。菜单出现后可用 <kbd>↑</kbd>/<kbd>↓</kbd> 在所有匹配命令中移动高亮（长列表自动滚动），<kbd>Enter</kbd> 直接执行；**未按过方向键时 <kbd>Enter</kbd> 仍按普通输入提交**。菜单会随终端宽高实时重排，窄窗口自动隐藏说明文字。

命令只在消息开头识别；若确实要把 `/model` 作为普通消息发给模型，请输入 `//model`。

| 命令 | 行为 |
| --- | --- |
| `/model [名称]` | 无参数时打开 Flash/Pro 选择；也可直接传自定义模型 ID |
| `/login` | 隐藏粘贴 API Key，或打开官方 API Key 页面 |
| `/login browser` | 直接打开官方 API Key 页面；不会把网页登录态带回终端 |
| `/logout` | 删除 `config.json` 中保存的 API Key；环境变量仍可能生效 |
| `/usage` | 有 Key 时先查询余额；随后打开官方用量页 |
| `/usage topup` | 查询余额并打开充值页（`top-up` 亦可） |
| `/clear` | 保存当前会话，清屏并开始空会话；旧会话仍可恢复 |
| `/resume [ID/标题]` | 浏览或匹配当前目录的历史会话 |
| `/rename <标题>` | 重命名当前会话，最长 100 个字符 |
| `/thinking [on\|off]` | 显示、隐藏或切换思考过程的可见性 |
| `/effort [low\|high\|max]` | 无参数打开选择菜单；直接传档位立即切换 |
| `/status` | 一屏状态面板：模型/Endpoint、思考强度、上下文占用、Token 与缓存、最近一轮 TPS、会话、遮罩凭据、工作目录与 DSH |
| `/context` | 上下文报告 + 逐条消息 token 估算与按角色/思考的分段构成 |
| `/btw <问题>` | 侧问：复用当前上下文做单轮问答，不写入会话历史、不计入会话 Token |
| `/compact` | 把历史压缩为一条摘要消息（压缩前自动导出备份） |
| `/export` | 把当前会话导出为 Markdown（保存到数据目录 `exports/`） |
| `/edit [草稿]` | 用 `$VISUAL`/`$EDITOR`（未设置时 vi/notepad）编写下一条多行消息 |
| `/attach <路径>` | 附加一个文本文件（支持 `~` 与相对路径，≤256 KiB，拒绝二进制）并发送 |
| `/rewind [编号]` | 从更早的用户消息分支一个新会话；原会话保持不变 |
| `/search <关键词>` | 在当前会话内做不区分大小写的逐行全文搜索 |
| `/dsh [动作] [端口]` | 管理 DSH，见 [DSH 后台管理](#dsh-后台管理) |
| `/help` | 显示全部斜杠命令与键盘快捷键 |
| `/exit` | 保存并退出（`/quit`、<kbd>Ctrl</kbd>+<kbd>D</kbd> 或空提示符下连按两次 <kbd>Ctrl</kbd>+<kbd>C</kbd> 同样有效） |

`/new` 是 `/clear` 的别名，`/sessions` 是 `/resume` 的别名。命令拼错时会给出最接近的候选（输入 `/moddel` 会提示 `/model`）。

生成过程中按 <kbd>Esc</kbd> 或 <kbd>Ctrl</kbd>+<kbd>C</kbd> 会中断本次生成，已收到的部分回复仍会保存；生成期间输入的完整消息（以回车结束）会排队在结束后自动发送并回显。

所有二级选项列表（`/model` 选择器、`/resume` 会话列表、`/rewind` 回退点、`/login` 登录方式）都是**可键盘导航的菜单**：<kbd>↑</kbd>/<kbd>↓</kbd> 移动、<kbd>Enter</kbd> 确认、<kbd>Esc</kbd> 取消、数字键跳转；`/model` 菜单还支持直接键入自定义模型 ID。

> [!IMPORTANT]
> `/thinking` 与 `--thinking` 只控制**是否把 API 返回的 `reasoning_content` 显示在终端**，不等同于切换模型的 thinking 参数。
> `/effort` 才控制真实推理深度，直接映射 DeepSeek V4 的 `reasoning_effort`（OpenAI 格式仅支持 `low`/`high`/`max`；`medium` 会被官方映射为 `high`，因此本项目不提供该档位）。思考模式默认开启、默认强度 `high`，与官方默认一致。

## 命令行用法

```bash
# 交互聊天
deepseek

# 单次提问：流式答案写入 stdout，结束后退出
deepseek "用三点解释这个项目"

# 非交互环境下从标准输入读取问题
cat notes.md | deepseek

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

`dstui` 与 `deepseek` 完全等价，所有示例都可以替换。

单次提问也会保存为本地会话。启用 `--thinking` 时，最终答案写到 `stdout`，思考过程写到 `stderr`，方便脚本分别处理。**没有位置参数且 `stdin` 不是 TTY 时**（例如通过管道调用）会把标准输入的全部内容当作问题；有位置参数时不读取 `stdin`，以免在脚本里意外阻塞。

| 选项 | 作用 |
| --- | --- |
| `-m, --model <名称>` | 新会话在本次启动中使用指定模型 |
| `-c, --continue` | 恢复当前目录最近会话 |
| `-r, --resume [ID]` | 选择或恢复当前目录的会话 |
| `--endpoint <URL>` | 本次启动使用自定义 OpenAI-compatible API 地址 |
| `--base-url <URL>` | `--endpoint` 的等价写法 |
| `--thinking` | 显示 API 返回的思考过程 |
| `--effort <强度>` | 本次启动使用 `low`/`high`/`max` 思考强度 |
| `--no-logo` | 交互模式不显示鲸鱼 |
| `--no-color` | 交互模式不使用 ANSI 颜色 |
| `-h, --help` | 显示帮助 |
| `-V, --version` | 显示版本 |

命令行传入的模型、Endpoint 和 `--thinking` 只作用于本次启动；恢复旧会话时保留该会话自己的模型。在交互会话中用 `/model` 或 `/thinking` 修改时会写入配置。

## DSH 后台管理

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 是 DeepSeek AI 官方开源的智能体框架。官方快速启动方式是持续运行 `npx @deepseek-ai/dsh web`；本项目把它包装成一个脱离当前终端的后台进程：

```bash
# 首次使用：安装已验证的固定版本（检测到可用 dsh 时自动跳过）
deepseek dsh install

# 后台启动并打开浏览器（默认 127.0.0.1:3080）
deepseek dsh start

# 打开 DSH Web；已有实例直接连接，没有就后台启动
deepseek dsh open

# 状态、日志、重启和停止
deepseek dsh status
deepseek dsh logs --lines 120
deepseek dsh restart
deepseek dsh stop

# 临时改端口，或启动后不打开浏览器
deepseek dsh start --port 3090 --no-open
```

交互终端中同样可用：`/dsh install`、`/dsh`、`/dsh status`、`/dsh start 3090`、`/dsh logs`、`/dsh restart 3090`、`/dsh stop`。

<details>
<summary><b>实现要点</b></summary>

- 固定绑定 `127.0.0.1`，不会主动暴露到局域网
- 优先使用 `DEEPSEEK_DSH_COMMAND` 指定的可执行文件，其次是开发环境随项目安装的包，最后查找 `PATH` 中的 `dsh`；找不到时提示 `deepseek dsh install`
- 记录 PID、工作目录和日志；再次执行命令即可管理，不必一直挂着 `npx` 终端
- **只停止本项目记录的 PID**；Unix-like 平台还会核对进程命令，避免误杀复用 PID 的其他进程；无法核验身份时拒绝停止而不是冒险
- 端口被非本项目管理的进程占用时，`start` 会拒绝接管；`open` 可以只打开它
- 日志超过 1 MiB 自动轮转（保留 `dsh.log.1`）；读取日志时对 `sk-` 密钥、Bearer Token 和 Authorization 头脱敏

本项目已针对 [`@deepseek-ai/dsh@0.1.0-rc.7`](https://www.npmjs.com/package/@deepseek-ai/dsh) 验证。DSH 官方仍将其标记为 developer preview，未来可能有破坏性更新，因此这里固定版本并在检测到其他版本时提示。后台进程不是开机服务，重启系统后需重新启动。

</details>

### 两套体验的边界

- **`deepseek` 聊天**直接调用 DeepSeek API，只管理本项目自己的 JSON 会话。
- **`deepseek dsh`** 启动官方 DSH Web；DSH 能读取和编辑工作区、执行命令、委派任务并应用自己的权限策略。
- 两者**不共享**会话、模型配置或 API Key。首次进入 DSH Web 后，仍需按[官方 Web UI 指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/index.md)在 Settings → Models 中配置模型和凭据。

## 数据、配置与密钥位置

| 平台/设置 | 路径 |
| --- | --- |
| `DEEPSEEK_TUI_HOME` 已设置 | 该变量指定的目录 |
| Windows | `%APPDATA%\deepseek-tui` |
| 设置了 `XDG_CONFIG_HOME` | `$XDG_CONFIG_HOME/deepseek-tui` |
| macOS/Linux 默认 | `~/.config/deepseek-tui` |

<details>
<summary><b>目录结构</b></summary>

```text
deepseek-tui/
├── config.json          # 模型、Endpoint、显示偏好、DSH 端口、contextLimitTokens；可能含 API Key
├── history              # 提示符输入历史（0600，最多 500 条）
├── sessions/
│   ├── <uuid>.json      # 消息、reasoning、工作目录与 Token 统计
│   └── <uuid>.json.lock # 会话文件锁（防止两个终端互相覆盖；异常残留会被自动接管）
├── exports/
│   └── <标题>-<id8>.md  # /export 与 /compact 备份产生的 Markdown 记录
└── dsh/
    ├── state.json       # 由本项目启动的 DSH PID/端口/工作目录
    ├── dsh.log          # DSH stdout/stderr（展示时脱敏）
    └── dsh.log.1        # 超过 1 MiB 时轮转出的上一份日志
```

</details>

| 环境变量 | 优先级与用途 |
| --- | --- |
| `DEEPSEEK_API_KEY` | 高于本地 `config.json` 中的 Key |
| `DEEPSEEK_BASE_URL` | 高于本地 Endpoint；必须是有效的 `http(s)` URL |
| `DEEPSEEK_TUI_HOME` | 覆盖整个数据目录，适合隔离开发和测试 |
| `DEEPSEEK_DSH_COMMAND` | 指向 DSH 的单个可执行文件或 `PATH` 命令名，不接受一整段 shell 命令 |

默认 API 地址是 `https://api.deepseek.com`，默认模型是 `deepseek-v4-flash`；`deepseek-v4-pro` 也在当前[官方模型与价格文档](https://api-docs.deepseek.com/quick_start/pricing)中列出。

## 安全说明

> [!WARNING]
> `/login` 会隐藏终端输入，但**保存后的 API Key 仍是本地明文**。Unix 平台创建目录时使用 `0700`、文件使用 `0600`；这不是系统钥匙串。不希望 Key 落盘时，请仅使用 `DEEPSEEK_API_KEY`。

- `/logout` 只删除配置文件中的 Key，不会清除 shell 环境变量、历史会话或 DSH 自己的凭据。
- 会话 JSON 包含完整提问、回答和可能的思考内容。不要把数据目录、调试副本或 DSH 日志提交到版本库或公开分享；`dsh logs` 输出会先对 `sk-` 密钥、Bearer Token 与 Authorization 头脱敏，但轮转出的原始 `dsh.log` 本身不做改写，删除时请连同 `dsh.log.1` 一起处理。
- 使用 `--endpoint`/`DEEPSEEK_BASE_URL` 时，所选服务会收到 Authorization Header 和完整会话；除受信任的本地服务外应优先使用 HTTPS，并为不同服务使用不同密钥。
- DSH 是可以操作工作区的智能体。启动后请在 Web UI 中核对 workspace、模型和权限；不要把本地端口通过反向代理或端口转发公开暴露。
- 模型输出在写入终端前会移除常见控制字符，但仍应把模型生成的命令和代码当作**不可信内容**审阅。

## 当前限制

- 没有内置文件、shell、Git、Web Search、MCP、Skills 或工具调用；这些能力交给 DSH。`/attach` 仅按用户显式路径读取单个文本文件
- 没有 Markdown 全屏渲染或图片输入；多行输入可用行尾 `\` 续写、`/edit`（外部编辑器）或 bracketed paste，但仍不是可上下移动光标的全屏编辑器
- 上下文管理是「估算预警 + 超限时按请求省略最早消息 + `/compact` 手动摘要压缩」，不是模型级自动压缩；估算使用启发式（CJK ≈ 1 token/字，ASCII ≈ 4 字/token）。**本地会话历史永远不会因为超限被删除**
- 没有系统钥匙串、会话删除命令或跨设备同步；导出用 `/export`
- `/usage` 查询账号余额并打开官方页面（余额请求默认 15 秒超时），当前不计算精确的会话货币成本

完整竞品调研与设计取舍见 [RESEARCH.md](./RESEARCH.md)。

## 故障排查

<details>
<summary><b>展开常见问题与处理方式</b></summary>

| 现象 | 原因与处理 |
| --- | --- |
| `deepseek: command not found` | 全局安装未完成；先运行 `npm install -g .`，并用 `command -v deepseek`（Windows 用 `where deepseek`）确认路径。若指向其他包（例如旧版 Hmbown/DeepSeek-TUI 的 shim），请卸载后重新安装本项目 |
| 交互模式报「需要 TTY」 | 管道或脚本环境无法交互；改用单次提问 `deepseek "你的问题"`，或用管道传入内容 |
| 报「缺少 API Key」 | 运行 `deepseek login`，或设置 `DEEPSEEK_API_KEY` 环境变量 |
| 请求报「无法连接 `<Endpoint>`」 | 检查 `--endpoint`/`DEEPSEEK_BASE_URL`、代理、DNS 和防火墙，确认提示中的地址可达；底层错误会保留在括号中帮助诊断 |
| `/usage` 显示「暂时无法查询余额」 | 余额接口与 Key/Endpoint 不匹配或 15 秒内没有响应；用 `/status` 核对凭据来源（环境变量优先于本地配置） |
| `dsh start` 报「端口已由其他进程占用」 | 该端口已有进程监听；换端口 `dsh start --port 3090`，或先 `dsh stop` 由本项目管理的旧实例。若确认是本项目实例却无法 stop，可查 `deepseek dsh logs` |
| `dsh start` 报「未找到 DSH」 | 运行 `deepseek dsh install`，或用 `DEEPSEEK_DSH_COMMAND` 指向已安装的 `dsh` |
| 恢复会话提示「正被另一个终端使用」 | 该会话已被另一个终端加锁，本实例为只读；关闭另一个终端后重启即可恢复读写。残留锁（对应进程已退出）会在下次启动时自动接管 |
| 恢复会话看不到历史 | 会话按工作目录隔离；`--continue`、`/resume` 只查看当前目录，`deepseek sessions` 可按目录核对 |
| 提示上下文超限并省略消息 | 会话估算超过 `config.json` 中的 `contextLimitTokens`（默认 131072）。**省略只作用于当次请求，本地历史不会被删除**；可用 `/compact` 压缩、调大该值或 `/clear` 开新会话 |
| 数据目录异常 | 删除损坏的 `~/.config/deepseek-tui` 前先备份；可用 `DEEPSEEK_TUI_HOME=/tmp/…` 隔离验证 |

</details>

## 常见问题

<details>
<summary><b>和 Claude Code 有什么区别？</b></summary>

本项目只有聊天、会话与 DSH 生命周期管理，没有工具调用、权限、MCP 和 agent 能力；交互命令命名借鉴了 Claude Code 以降低迁移成本。需要完整编码智能体时，用 `/dsh` 启动官方 DSH，或参考 DeepSeek 官方文档接入 Claude Code / OpenCode。

</details>

<details>
<summary><b>为什么直接调 API，不嵌入官方 SDK？</b></summary>

请求面很小（`/chat/completions` 流式 + `/user/balance`），直接调用可以减少依赖、保留 `--endpoint` 兼容 OpenAI-compatible 网关的能力。协议解析与错误处理有对应的单元测试覆盖。

</details>

<details>
<summary><b><code>deepseek</code> 和 <code>deepseek dsh</code> 是什么关系？</b></summary>

前者是本项目的轻量聊天，后者是官方 DeepSeek Harness Web 的后台启动器。两者不共享会话、配置和 API Key，详见 [DSH 后台管理](#dsh-后台管理)。

</details>

## 开发与测试

<details>
<summary><b>展开开发命令</b></summary>

```bash
npm ci   # 或 npm install（CI 使用 npm ci 以保证 lockfile 一致性）

# 开发运行（直接跑源码，无需 build）
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

真实 API 流式测试需要有效 Key，并会产生相应 API 用量。DSH 烟测可依次运行 `dsh start --no-open`、`dsh status`、`dsh logs`、`dsh stop`；测试结束应停止由本项目启动的后台进程。

</details>

## 贡献与路线图

欢迎以 Issue 和 PR 形式参与：报告 bug 时请附上 `deepseek --version`、Node 版本、操作系统和复现步骤；改动请先运行 `npm run check`。约定见 [CONTRIBUTING.md](./CONTRIBUTING.md)，行为准则见 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)，安全漏洞请按 [SECURITY.md](./SECURITY.md) 私下报告。

计划中的改进优先级见 [RESEARCH.md「已知差距与后续优先级」](./RESEARCH.md#已知差距与后续优先级)，主要包括：钥匙串适配与会话删除/导出、模型级上下文压缩、完整多行编辑器、`/doctor` 自检命令、精确费用估算与 DSH 兼容矩阵。版本记录见 [CHANGELOG.md](./CHANGELOG.md)。

## 许可证与品牌

代码以 [MIT License](./LICENSE) 发布。

「DeepSeek」及相关标识属于其权利人。本项目标题、命令名与蓝色视觉用于描述兼容的服务，强调色为 `#4D6BFE`，不声称是 DeepSeek 官方 Logo 或官方品牌规范。彩色半块像素鲸鱼 sprite 来自 MIT 授权的 [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI)（`src/components/Whale.tsx`）；纯文本字符鲸鱼为本项目绘制。Claude 与 Claude Code 属于 Anthropic；本项目仅借鉴其终端交互惯例，未使用 Anthropic 的代码或视觉资产。

<div align="center">
<sub>Co-authored by DeepSeek Harness · 用 🐋 和 TypeScript 构建</sub>
</div>
