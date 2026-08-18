# 贡献指南

感谢你的兴趣！本项目是一个轻量、低权限的 DeepSeek 终端客户端，目标是保持核心小而可审计。贡献前请先了解项目边界：聊天客户端本身**不做**文件工具、shell、MCP 或 agent 能力，这些能力属于官方 DSH（见 [RESEARCH.md](./RESEARCH.md)）。

## 准备环境

```bash
git clone https://github.com/manfredss/deepseek-blue-tui.git
cd deepseek-blue-tui
npm ci
```

需要 Node.js `>= 22.19.0`。建议用隔离目录做手动测试，避免读写你的日常配置：

```bash
DEEPSEEK_TUI_HOME=/tmp/deepseek-blue-tui-dev npm run dev
```

## 开发流程

1. 在 Issue 中先描述你要解决的问题（bug 请附 `deepseek --version`、Node 版本、操作系统与复现步骤）。
2. 从 `main` 拉出新分支，做出最小化改动。
3. 代码必须通过：

   ```bash
   npm run check   # typecheck + 全部测试
   ```

   测试包含一个跨平台 DSH 生命周期集成测试（用 stub DSH 走完 start/status/logs/stop）。在部分受限制的 macOS 沙箱中 `/bin/ps` 不可用，测试会自动降级为模拟的进程身份检查；CI 在真实 runner 上执行完整路径。
4. 新增行为必须带测试（`node:test` + `assert/strict`，测试文件放在 `test/`）。
5. 更新受影响的文档（README、RESEARCH、CHANGELOG）。
6. 提交信息用一句话说明「做了什么、为什么」。推分支并开 PR。

## 代码约定

- TypeScript strict 模式全开（含 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`）；不要关闭检查，用类型守卫收窄。
- 所有文件写入走 `writeJsonAtomic`；涉及凭据的路径保持 `0700`/`0600` 权限语义。
- 用户可见文案为中文；错误信息要给出下一步动作（例如「请运行 `deepseek dsh install`」）。
- 不要硬编码模型价格或模型名；模型 ID 允许自定义，价格以官方文档为准。
- 任何会执行命令、读写文件或扩大权限面的功能，先讨论边界与审批模型，而不是直接实现。

## 测试约定

- 纯函数用单测；进程与端口行为用集成测试；不要用真实 API Key 或真实网络做测试。
- 真实 API 流式测试需要有效 Key 并产生用量，仅允许手动执行，不进入 CI。
- 测试必须能在没有外部服务的环境通过（除本地回环端口外）。

## 发布流程（维护者）

1. 更新 `CHANGELOG.md`（Keep a Changelog 格式）并 bump `package.json` 版本。
2. 合并到 `main` 后打标签 `vX.Y.Z` 并推送。
3. 标签触发 [publish workflow](./.github/workflows/publish.yml)：CI 检查通过后以 provenance 发布到 npm（需要 `NPM_TOKEN` secret），并生成 GitHub Release。
4. 升级 `VERIFIED_DSH_VERSION`（`src/dsh.ts`）前，先在手动环境验证 `deepseek dsh install` 与 start/stop 全流程，并更新 RESEARCH.md 的兼容性说明。

## 许可证

贡献默认以项目同款 MIT License 授权（见 [LICENSE](./LICENSE)）。不要提交任何来源不明或不允许再许可的代码。
