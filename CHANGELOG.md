# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循语义化版本（0.x 阶段不承诺向后兼容）。

## [未发布]

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
