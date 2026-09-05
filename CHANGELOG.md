# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循语义化版本（0.x 阶段不承诺向后兼容）。

## [未发布]

## [0.2.0] - 2026-09-04

### 内部

- CLI 入口测试不再硬编码版本号（此前每次发版都会挂）；改为与 `package.json` 比对，断言的是「通过符号链接调用时仍能解析到自己的清单」这件事本身

### 新增

- Claude Code 式 `Ctrl+C`：生成中中断本次生成；提示符下清空当前输入；输入已为空时 3 秒内再按一次才退出（并给出提示）。`Ctrl+D` 直接退出，`Ctrl+L` 清屏
- `Tab` 补全斜杠命令：唯一匹配直接补全（`/mo` → `/model`，补全后不发送，可继续输入参数）；多个匹配时先补到共同前缀，补不动则高亮第一个候选，再按一次 `Tab` 或 `Enter` 采用
- 行尾 `\` 换行续写：续行提示符为 `…`，各行以换行拼接后作为一条消息发送
- 跨会话输入历史：`↑`/`↓` 翻阅，保存在数据目录 `history`（0600，最多 500 条）；空行、重复行、多行粘贴、疑似 API Key（`sk-…`）与 `/exit` 不入历史
- 生成中的实时状态行：盲文动画 + 已用时间 + 隐藏思考时的思考 token 增长 + `esc 中断` 提示；每轮结束打印 `输入 · 输出 · 思考 · 缓存 · 耗时 · TPS`
- 命令拼错时给出最接近的候选（`/moddel` → `/model`）；以 `/` 开头的路径会提示改用 `//`
- 非交互环境下（无位置参数且 `stdin` 非 TTY）从标准输入读取问题：`cat notes.md | deepseek`
- `/clear` 现在会清屏并重绘欢迎卡片；`/compact` 结束后追加一行上下文 HUD，直观显示压缩效果

- 生成中按 `Esc` 或 `Ctrl+C` 可立即中断本次生成（原先 readline 挂起时按键无人接收）；生成期间输入的完整消息会在生成结束后自动排队发送
- `/effort [low|high|max]`：设置 DeepSeek V4 思考强度（无参数打开 ↑/↓ 导航菜单）；请求发送官方 `reasoning_effort`，默认 `high` 与官方默认一致；`deepseek --effort <档位>` 单次覆盖；`/status` 显示当前档位
- 主提示符 `/` 命令菜单支持方向键选择：`↑`/`↓` 在所有匹配项中移动高亮（长列表自动滚动），`Enter` 执行高亮命令；未按方向键时 `Enter` 保持普通提交行为
- 启动页在真彩/256 色终端采用 dsh-TUI 风格半块像素鲸鱼：40×13 终端单元格，深蓝轮廓、DeepSeek 蓝身体、冰蓝腹部与白色嘴部；ANSI-16 与纯文本模式继续使用原有前景鲸鱼
- 选项列表支持方向键导航：`↑`/`↓` 移动高亮、`Enter` 确认、`Esc` 取消、数字跳转；`/model` 菜单支持直接键入自定义模型 ID（应用于 `/model`、`/resume`、`/rewind`、`/login` 与 `deepseek login`）

### 修复

- **上下文超限不再删除本地历史**：超限时只在当次请求中省略最早的消息，会话文件保持完整，`/export`、`/rewind`、`/search` 仍能看到全部对话（交互模式与单次提问模式均已修复）
- 宽度计算此前把 ANSI 转义序列当成可见字符，导致带颜色的状态行（≥80% 上下文、`/status`、`/context`）被过早截断；同时修复了恰好占满整行的字符串被多截一个字符的问题
- `/rename` 绕过了会话文件锁，只读实例会覆盖另一个终端的会话文件；现在遵守只读模式并明确提示
- 命令执行失败（文件不可读、磁盘写满、DSH 异常等）会直接终止整个 REPL；现在只报错并回到提示符
- 中断生成时若只收到思考内容，会写入一条 `content` 为空的 assistant 消息，导致下一轮请求被 API 拒绝；现在只在有正文时保存部分回复
- `deepseek resume --thinking` 之类的写法会把选项当成会话 ID
- `/dsh 3081`（只给端口）现在按端口处理，并校验端口范围
- `/model <ID> <多余参数>` 此前静默丢弃多余参数并切换到第一个词（`/model bad name!!` 会切到名为 `bad` 的模型）；现在明确提示「模型 ID 不能包含空格」
- 选项菜单在列表为空时会返回一个不存在的第 0 项
- **`/search` 会把消息里的转义序列原样写进终端**：模型输出或 `/attach` 附带的文本若含 ANSI/控制字符，可以改变终端颜色甚至光标位置；现在与其他视图一样先净化再输出，并高亮命中的关键词
- **选项菜单在矮终端里会撕裂屏幕**：`/resume`、`/rewind` 最多打印 14 行，重绘时按行数上移光标，终端不够高就会越过顶部；现在按终端高度开窗滚动，并提示还有多少项未显示
- `/rewind <编号>` 与菜单里的编号不是同一套：菜单只列最近 12 条却从 1 开始编号，而参数按全部用户消息计数；现在两者统一，超出范围会提示有效区间（此前会静默弹出菜单）
- 每轮结束的 `tok/s` 与 `/status` 的「最近一轮」速度对不上：两处分别取了不同的计时点和不同的下限；现在共用同一次测量与同一个下限
- `/context` 的「上下文」总计与「分段构成」合计不一致（逐条向上取整会累积误差）；现在只在最终结果取整，两个数字必然相同
- 生成失败或被中断且没有产出任何正文时，用户消息会滞留为会话末尾的孤立 user 消息（污染记录，并让下一次请求出现连续两条 user 消息）；现在回滚该消息并提示可用 `↑` 召回
- API 报错时丢失可操作提示：DeepSeek 总会返回自己的英文 `error.message`，导致 401/402 等状态码对应的「请运行 /login」「请运行 /usage 充值」永远不会显示；现在两者一起给出
- 慢命令（`/dsh start` 最长轮询 45 秒）期间按一次 `Ctrl+C` 会直接退出整个 REPL；现在与提示符一致，需要连按两次
- `/attach` 遇到权限不足等错误时抛出原始 errno 文本（`EACCES: permission denied, stat ...`）；现在给出中文说明
- `/edit` 调起外部编辑器期间未关闭括号粘贴模式，在编辑器里粘贴会插入 `[200~` 之类的标记
- `/dsh logs` 直接输出日志内容，其中的控制字符会影响终端；现在先净化
- 空会话会出现在 `/resume` 列表和 `--continue` 里，占用一个选项却没有任何内容可恢复
- `/dsh install` 的进度动画会与 npm 自身的输出抢同一行：`installDsh` 用 `spawnSync` + 继承 stdio，动画既转不起来（事件循环被阻塞），停止时还会擦掉 npm 的最后一行；该路径改为纯文字提示
- 找不到 DSH 时的报错让 TUI 用户去执行 shell 命令 `deepseek dsh install`；现在同时给出 `/dsh install`、全局安装与 `DEEPSEEK_DSH_COMMAND` 三种方式，并说明 `npx` 装的副本位于 npm 缓存、不在 PATH 上，因此不会被自动发现

### 变更

- **DSH 版本不再硬编码**：删除 `VERIFIED_DSH_VERSION = "0.1.0-rc.7"` 常量
  - `dsh install` 改为跟随 `latest` dist-tag（此前固定安装一个已落后两个版本的 rc）
  - 新增 `detectDshVersion()`：跟随符号链接、从实际安装的 `@deepseek-ai/dsh` 包清单读取版本。此前只有「开发环境本地安装」这一种来源会带版本号，全局安装与 `DEEPSEEK_DSH_COMMAND` 在 `/dsh status` 里**根本不显示版本**
  - 「未经本版本验证」的提示改为**正在运行的版本 vs 当前安装的版本**——一个会随时间自己失效的比较，换成了一个真正会触发、也真正可操作的比较（升级 DSH 后旧进程仍在跑 → 提示 `/dsh restart`）

### 优化

- 长路径改为保留尾部：`/status` 的「目录」、`/context` 的「工作目录」与启动卡片此前从头截断，丢掉的恰好是标识项目的那一段；现在 `$HOME` 收敛为 `~`，过长时显示 `…/上级/项目名`
- `/dsh` 与 `/usage` 的耗时操作加上进度动画（此前提示符看起来像卡死）
- `/help` 的 `/dsh` 一行过长会撑破对齐；同时补上 `/new`、`/sessions`、`/quit` 三个别名的说明

### 测试

- 新增 `test/tui.test.ts`：用一对假 TTY 流与本地 SSE 模拟服务端端到端驱动 REPL，覆盖启动/退出、`Ctrl+C` 两段式、`/search` 净化、`/model` 参数校验、`/rewind` 编号、失败轮次回滚、中断保留部分回复、速度与 token 口径一致性、慢命令中断保护等
- 新增 `shortenPath` 与选项菜单开窗滚动的单元测试

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

- `/status` 改为一屏对齐面板（模型/Endpoint、思考强度、上下文占用条、Token 与缓存、TPS、会话、凭据、目录、DSH），不再与上下文报告重复；上下文报告移入 `/context`
- `/help` 改为对齐的双栏排版，并新增「键盘快捷键」一节
- 界面统一为中文：欢迎卡片、命令面板描述与状态面板不再混排英文
- 上下文进度条按压力着色（<80% 蓝、≥80% 黄、100% 红）
- 历史回放使用与实时输出一致的 `❯` / `◆ DeepSeek` / `◇ 摘要` 标记
- 请求裁剪逻辑抽取为 `planRequest`，交互模式与单次提问共用同一实现
- 终端宽度计算、鲸鱼绘制与菜单渲染共用 `text-width` 中的同一套实现（去掉 logo.ts 里的副本）

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

[未发布]: https://github.com/Manfredss/deepseek-blue-tui/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Manfredss/deepseek-blue-tui/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Manfredss/deepseek-blue-tui/releases/tag/v0.1.0
