# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循语义化版本（0.x 阶段不承诺向后兼容）。

## [未发布]

### 新增

- `/effort [low|high|max]`：设置 DeepSeek V4 思考强度（无参数打开 ↑/↓ 导航菜单）；请求发送官方 `reasoning_effort`，默认 `high` 与官方默认一致；`deepseek --effort <档位>` 单次覆盖；`/status` 显示当前档位
- 主提示符 `/` 命令菜单支持方向键选择：`↑`/`↓` 在所有匹配项中移动高亮（长列表自动滚动），`Enter` 执行高亮命令；未按方向键时 `Enter` 保持普通提交行为
- 启动页在真彩/256 色终端采用 dsh-TUI 风格半块像素鲸鱼：40×13 终端单元格，深蓝轮廓、DeepSeek 蓝身体、冰蓝腹部与白色嘴部；ANSI-16 与纯文本模式继续使用原有前景鲸鱼
- 选项列表支持方向键导航：`↑`/`↓` 移动高亮、`Enter` 确认、`Esc` 取消、数字跳转；`/model` 菜单支持直接键入自定义模型 ID（应用于 `/model`、`/resume`、`/rewind`、`/login` 与 `deepseek login`）

### 新增（借鉴 dsh-TUI，适配行式 REPL）

- `/btw <问题>`：侧问——复用当前上下文做单轮问答，不写入会话历史、不计入会话 Token
- `/compact`：把历史压缩为一条 system 摘要消息；压缩前自动导出 Markdown 备份
- `/export`：会话导出为 Markdown（含思考过程），保存到数据目录 `exports/`
- `/edit [草稿]`：用 `$VISUAL`/`$EDITOR`（缺省 vi/notepad）编写多行下一条消息
- `/attach <路径>`：附加文本文件（`~`/相对路径、≤256 KiB、NUL 检测拒绝二进制）
- `/rewind [编号]`：从更早的用户消息分支新会话（原会话保持不变）
- `/search <关键词>`：会话内逐行全文搜索，带消息编号与行号
- `/context`：逐条消息 token 审计 + 按 system/user/assistant/thinking 的分段构成
- `/status` 可观测性升级：上下文 HUD（百分比着色：≥80% 黄、100% 红）、缓存命中率、最近一轮 TPS（≥50 绿 / ≥20 黄）
- 紧凑 token 计数格式（`988`、`3.4k`、`12k`、`1.0M`），非有限值显示 `—`
- 会话记录 `lastTurnMs` / `lastCompletionTokens`（TPS 数据，向后兼容可选字段）

### 改进

- 启动页改为响应式双栏/单栏欢迎卡片，并按参考图重画带右上尾鳍、腹部留白和眼睛的原创字符鲸鱼；宽高充足时启用 42×11 精细版，首次交互前可随窗口实时重绘
- 根据终端色彩能力选择 DeepSeek 真彩蓝、256 色近似蓝或 ANSI 蓝，修复 Apple Terminal 出现白色背景的问题
- 主提示符键入 `/` 即时显示命令菜单；支持前缀过滤、Esc 收起和终端 resize 实时重排；菜单最多显示 5 条并提示剩余数量
- 修复 bracketed-paste 解析器吞掉单独 Esc 按键的问题，同时保留分块方向键序列

## [0.1.0] - 2026-08-18

### 新增

- `deepseek` 交互式终端：DeepSeek 蓝色 ASCII 大鲸鱼、行式 REPL、流式输出
- OpenAI-compatible API 直连（`/chat/completions` SSE + `/user/balance`），支持自定义 `--endpoint`
- Claude-like 斜杠命令：`/model`、`/login`、`/logout`、`/usage`、`/clear`、`/resume`、`/rename`、`/thinking`、`/status`、`/help`、`/exit`
- 按工作目录隔离的本地会话：UUID 存储、标题派生、累计 Token 统计、恢复/续聊
- 隐藏输入保存 API Key；`DEEPSEEK_API_KEY`/`DEEPSEEK_BASE_URL` 环境变量覆盖层
- 官方 DSH Web 的后台托管：`deepseek dsh [install|start|open|status|stop|logs|restart]`，无需常驻 `npx` 终端
- `deepseek dsh install`：按需显式安装固定版本 `@deepseek-ai/dsh@0.1.0-rc.7`（不再作为可选依赖随包安装）
- 会话文件锁：第二个终端进入只读模式，崩溃残留锁自动接管
- 上下文长度估算：80% 预警、超限自动裁剪最早的普通消息（`contextLimitTokens`，默认 131072）
- 现代终端 bracketed paste：多行粘贴聚合为一条消息
- DSH 日志 1 MiB 自动轮转；日志展示对 `sk-` 密钥、Bearer Token、Authorization 头脱敏
- 更友好的错误：无法连接时给出 Endpoint 与底层原因；余额查询 15 秒超时
- 中性别名 `dstui` 与 `deepseek` 等价
- macOS / Linux / Windows 的浏览器打开适配与 CI 矩阵（Node 22/24）
