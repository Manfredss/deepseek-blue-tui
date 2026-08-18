# 安全政策

## 支持版本

目前只有 `main` 分支的最新版本接受安全修复。发布到 npm 后，补丁将随下一个版本号发布（目前项目处于 0.x，修复可能直接进入 `0.1.x`）。

## 报告漏洞

**请不要在公开 Issue 中报告安全漏洞。**

请使用 GitHub 的 **Security Advisories**（仓库 Security → Report a vulnerability）私下报告，或联系仓库维护者（`manfredss`）。请包含：

- 受影响版本与运行环境（`deepseek --version`、Node 版本、操作系统）
- 复现步骤或 PoC
- 影响评估（是否涉及密钥泄露、会话数据泄露、本地权限扩大）

我们会在 48 小时内确认，并在修复发布前保密。修复将发布为新的 patch 版本并在 [CHANGELOG](./CHANGELOG.md) 与安全公告中说明。

## API Key 泄露处理流程

如果你的 DeepSeek API Key 已经泄露（误提交、日志外发、屏幕共享等）：

1. **立即吊销**：登录 [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys) 删除该 Key 并创建新 Key。
2. **清除本地落盘**：运行 `deepseek logout`（或删除 `config.json` 中的 `apiKey`）；如果用过环境变量，检查 shell 配置与 CI secret。
3. **清除会话与日志**：会话 JSON（`~/.config/deepseek-tui/sessions/`）和 DSH 日志（`dsh/dsh.log*`）可能包含完整对话；确认无价值后删除，不要只做表面清理。
4. **检查 DSH**：`deepseek dsh logs` 已做显示脱敏，但原始日志文件不改写；DSH 自己的凭据在 `$DSH_HOME` 下，按需一并处理。
5. **审计用量**：在 [platform.deepseek.com/usage](https://platform.deepseek.com/usage) 检查吊销前的异常用量。
6. 如果泄露来自本项目的缺陷，请按上面的渠道私下报告。

## 项目安全模型（评审用）

- 聊天模式的唯一外发数据是向 `baseUrl`（默认 `https://api.deepseek.com`）的 HTTPS 请求；`--endpoint`/`DEEPSEEK_BASE_URL` 可改变目标，因此只应指向可信服务。
- 会话、配置和 DSH 状态以 `0700` 目录 / `0600` 文件权限原子写入；保存的 Key 是本地明文，不是系统钥匙串。
- 模型输出在写入终端前过滤常见控制字符，但模型内容本身不可信。
- DSH 是有 workspace 权限的官方 agent；本客户端只做进程托管，不注入凭据、不提供对外监听快捷方式。
- 超出上述范围的发现（如供应链、依赖问题）同样欢迎报告。
