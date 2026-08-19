#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { parseCliArgs, cliHelp } from "./args.js";
import { ConfigStore, isValidBaseUrl, maskApiKey } from "./config.js";
import {
  SessionStore,
  addUsage,
  createSession,
  deriveTitle,
  estimateTokens,
  truncateToLimit,
} from "./session-store.js";
import { DshManager, formatDshStatus, installDsh } from "./dsh.js";
import { DeepSeekTui } from "./tui.js";
import { createTheme } from "./theme.js";
import { streamChat, getBalance, DeepSeekApiError } from "./api.js";
import type { AppConfig, ChatMessage, Session } from "./types.js";
import { MenuPicker, promptSecret } from "./input.js";
import { DEEPSEEK_URLS, openUrl } from "./open-url.js";
import { VERSION } from "./version.js";

function errorMessage(error: unknown): string {
  if (error instanceof DeepSeekApiError) return `${error.message} (${error.status})`;
  if (error instanceof Error) return error.message;
  return String(error);
}

async function requestedSession(
  store: SessionStore,
  cwd: string,
  model: string,
  request: string | true | undefined,
  continueLast: boolean,
): Promise<Session> {
  if (typeof request === "string") {
    const matches = await store.find(request, cwd);
    if (matches.length === 0) throw new Error(`未找到会话：${request}`);
    if (matches.length > 1) throw new Error(`会话匹配不唯一：${request}`);
    const match = matches[0];
    if (match) return match;
  }
  if (request === true || continueLast) {
    const latest = (await store.list({ cwd, limit: 1 }))[0];
    if (latest) return latest;
  }
  return createSession(cwd, model);
}

export async function runOneShot(options: {
  prompt: string;
  config: AppConfig;
  configStore: ConfigStore;
  sessionStore: SessionStore;
  cwd: string;
  resume?: string | true;
  continueLast?: boolean;
  showReasoning?: boolean;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}): Promise<void> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const runtime = options.configStore.runtime(options.config);
  if (!runtime.apiKey) throw new Error("缺少 API Key。请运行 deepseek login 或设置 DEEPSEEK_API_KEY");
  const session = await requestedSession(
    options.sessionStore,
    options.cwd,
    options.config.model,
    options.resume,
    options.continueLast ?? false,
  );
  const lock = await options.sessionStore.acquireLock(session.id);
  try {
    if (!options.resume && !options.continueLast) session.model = options.config.model;
    const user: ChatMessage = { role: "user", content: options.prompt, createdAt: new Date().toISOString() };
    session.messages.push(user);
    if (session.title === "New conversation") session.title = deriveTitle(options.prompt);
    await options.sessionStore.save(session);

    const controller = new AbortController();
    const abort = (): void => controller.abort();
    process.once("SIGINT", abort);
    let content = "";
    let reasoning = "";
    let reasoningHeader = false;
    const startedAt = Date.now();
    try {
      const result = await streamChat({
        apiKey: runtime.apiKey,
        baseUrl: runtime.baseUrl,
        model: session.model,
        messages: truncateForSend(session, options.config.contextLimitTokens, stderr),
        signal: controller.signal,
        onReasoning: (delta) => {
          reasoning += delta;
          if (!options.showReasoning) return;
          if (!reasoningHeader) {
            stderr.write("[thinking]\n");
            reasoningHeader = true;
          }
          stderr.write(delta.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ""));
        },
        onContent: (delta) => {
          content += delta;
          stdout.write(delta.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ""));
        },
      });
      if (!result.content) stdout.write("\n");
      else if (!result.content.endsWith("\n")) stdout.write("\n");
      const assistant: ChatMessage = {
        role: "assistant",
        content: result.content,
        createdAt: new Date().toISOString(),
      };
      if (result.reasoningContent) assistant.reasoningContent = result.reasoningContent;
      session.messages.push(assistant);
      session.usage = addUsage(session.usage, result.usage);
      session.lastTurnMs = Math.max(1, Date.now() - startedAt);
      session.lastCompletionTokens = result.usage.completionTokens;
      await options.sessionStore.save(session);
    } catch (error) {
      if (content || reasoning) {
        const partial: ChatMessage = { role: "assistant", content, createdAt: new Date().toISOString() };
        if (reasoning) partial.reasoningContent = reasoning;
        session.messages.push(partial);
        await options.sessionStore.save(session);
      }
      throw error;
    } finally {
      process.removeListener("SIGINT", abort);
    }
  } finally {
    await lock.release();
  }
}

function truncateForSend(
  session: { messages: ChatMessage[] },
  limitTokens: number,
  stderr: NodeJS.WriteStream,
): ChatMessage[] {
  const estimated = estimateTokens(session.messages);
  if (estimated > limitTokens) {
    const result = truncateToLimit(session.messages, limitTokens);
    session.messages = result.messages;
    stderr.write(
      `警告：上下文超限（估算 ${estimated.toLocaleString()} tokens > ${limitTokens.toLocaleString()}），已裁剪最早的 ${result.dropped} 条消息。\n`,
    );
  } else if (estimated > limitTokens * 0.8) {
    stderr.write(
      `警告：上下文较长（估算 ${estimated.toLocaleString()} tokens，上限 ${limitTokens.toLocaleString()}）。\n`,
    );
  }
  return session.messages;
}

async function standaloneLogin(store: ConfigStore, config: AppConfig): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("非交互环境请设置 DEEPSEEK_API_KEY 环境变量");
  }
  const theme = createTheme(true);
  const result = await new MenuPicker(process.stdin, process.stdout).run({
    title: "登录方式",
    items: ["安全粘贴 API Key", "打开 DeepSeek API Key 页面", "取消"],
    footer: "↑/↓ 选择 · Enter 确认 · Esc 取消 · 数字跳转",
    color: { accent: theme.brightBlue, muted: theme.muted },
  });
  if (!result || result.kind !== "index") return;
  if (result.index === 1) {
    const opened = await openUrl(DEEPSEEK_URLS.apiKeys);
    process.stdout.write(opened ? "已打开 API Key 页面。\n" : `${DEEPSEEK_URLS.apiKeys}\n`);
    return;
  }
  if (result.index !== 0) return;
  const key = await promptSecret("粘贴 API Key：");
  if (!key?.trim()) return;
  if (key.trim().length < 8 || /\s/.test(key.trim())) throw new Error("API Key 格式无效");
  config.apiKey = key.trim();
  await store.save(config);
  process.stdout.write(`API Key 已保存 (${maskApiKey(key.trim())})。\n`);
}

async function standaloneUsage(store: ConfigStore, config: AppConfig, args: string[]): Promise<void> {
  const runtime = store.runtime(config);
  if (runtime.apiKey) {
    try {
      const balance = await getBalance({ apiKey: runtime.apiKey, baseUrl: runtime.baseUrl });
      for (const item of balance.balances) {
        process.stdout.write(`${item.totalBalance} ${item.currency} (充值 ${item.toppedUpBalance} · 赠金 ${item.grantedBalance})\n`);
      }
    } catch (error) {
      process.stderr.write(`余额查询失败：${errorMessage(error)}\n`);
    }
  }
  const url = args.includes("topup") || args.includes("top-up") ? DEEPSEEK_URLS.topUp : DEEPSEEK_URLS.usage;
  if (!(await openUrl(url))) process.stdout.write(`${url}\n`);
}

async function listSessions(store: SessionStore, cwd: string): Promise<void> {
  const sessions = await store.list({ cwd, limit: 50 });
  if (sessions.length === 0) {
    process.stdout.write("当前目录没有历史会话。\n");
    return;
  }
  for (const session of sessions) {
    process.stdout.write(`${session.id}  ${session.updatedAt}  ${session.model}  ${session.title}\n`);
  }
}

function parseDshOptions(args: string[], defaultPort: number): {
  action: string;
  port: number;
  open: boolean;
  lines: number;
} {
  let action = "start";
  let port = defaultPort;
  let shouldOpen = true;
  let lines = 80;
  let actionSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--no-open") shouldOpen = false;
    else if (argument === "--port") {
      const value = args[index + 1];
      if (!value) throw new Error("--port 需要一个值");
      port = Number.parseInt(value, 10);
      index += 1;
    } else if (argument === "--lines") {
      const value = args[index + 1];
      if (!value) throw new Error("--lines 需要一个值");
      lines = Number.parseInt(value, 10);
      index += 1;
    } else if (argument?.startsWith("-")) throw new Error(`未知 DSH 选项：${argument}`);
    else if (!actionSeen && argument) {
      action = argument.toLocaleLowerCase();
      actionSeen = true;
    } else if (argument) throw new Error(`多余的 DSH 参数：${argument}`);
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error("端口必须在 1 到 65535 之间");
  if (!Number.isInteger(lines) || lines <= 0 || lines > 10_000) throw new Error("日志行数必须在 1 到 10000 之间");
  return { action, port, open: shouldOpen, lines };
}

async function runDsh(manager: DshManager, config: AppConfig, args: string[], cwd: string): Promise<void> {
  const options = parseDshOptions(args, config.dshPort);
  if (options.action === "status") {
    process.stdout.write(`${formatDshStatus(await manager.status(options.port))}\n`);
    return;
  }
  if (options.action === "stop") {
    process.stdout.write(`${(await manager.stop()).message}\n`);
    return;
  }
  if (options.action === "logs") {
    process.stdout.write(`${(await manager.logs(options.lines)) || "暂无 DSH 日志。"}\n`);
    return;
  }
  if (options.action === "install") {
    const result = await installDsh();
    process.stdout.write(`${result.message}\n`);
    return;
  }
  if (options.action === "restart") await manager.stop();
  if (!["start", "open", "restart"].includes(options.action)) {
    throw new Error("用法：deepseek dsh [install|start|open|status|stop|logs|restart] [--port N] [--no-open]");
  }

  const before = await manager.status(options.port);
  let status = before;
  if (before.phase === "stopped" || options.action === "restart") {
    process.stdout.write("正在后台启动 DSH Web…\n");
    status = await manager.start({ port: options.port, cwd });
  } else if (before.phase === "external" && options.action !== "open") {
    throw new Error(`端口 ${options.port} 已由外部进程占用`);
  }
  process.stdout.write(`${formatDshStatus(status)}\n`);
  if (options.open && (status.phase === "running" || (status.phase === "external" && options.action === "open"))) {
    if (!(await openUrl(status.url))) process.stdout.write(`${status.url}\n`);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let options;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    process.stderr.write(`错误：${errorMessage(error)}\n\n${cliHelp()}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${cliHelp()}\n`);
    return 0;
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const configStore = new ConfigStore();
  const sessionStore = new SessionStore(configStore.home);
  const dshManager = new DshManager(configStore.home);
  // Canonicalize the working directory so sessions match across path
  // spellings (e.g. macOS /tmp vs /private/tmp symlinks). Fall back to the
  // raw cwd when the directory was deleted underneath us.
  let cwd: string;
  try {
    cwd = realpathSync(process.cwd());
  } catch {
    cwd = process.cwd();
  }
  try {
    const config = await configStore.load();
    if (options.model) config.model = options.model;
    if (options.baseUrl) {
      const baseUrl = options.baseUrl.replace(/\/+$/, "");
      if (!isValidBaseUrl(baseUrl)) throw new Error("--endpoint 必须是有效的 http(s) URL");
      config.baseUrl = baseUrl;
    }
    if (options.showReasoning) config.showReasoning = true;

    if (options.command === "login") await standaloneLogin(configStore, config);
    else if (options.command === "usage") await standaloneUsage(configStore, config, options.commandArgs);
    else if (options.command === "sessions") await listSessions(sessionStore, cwd);
    else if (options.command === "dsh") await runDsh(dshManager, config, options.commandArgs, cwd);
    else if (options.prompt) {
      await runOneShot({
        prompt: options.prompt,
        config,
        configStore,
        sessionStore,
        cwd,
        ...(options.resume !== undefined ? { resume: options.resume } : {}),
        continueLast: options.continueLast,
        showReasoning: config.showReasoning,
      });
    } else {
      const tuiOptions = {
        configStore,
        sessionStore,
        dshManager,
        config,
        cwd,
        ...(options.resume !== undefined ? { resumeQuery: options.resume } : {}),
        continueLast: options.continueLast,
        showLogo: options.showLogo,
        color: options.color,
      };
      await new DeepSeekTui(tuiOptions).run();
    }
    return 0;
  } catch (error) {
    process.stderr.write(`错误：${errorMessage(error)}\n`);
    return (error as Error).name === "AbortError" ? 130 : 1;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
let invokedDirectly = false;
if (invokedPath) {
  try {
    invokedDirectly = realpathSync(fileURLToPath(import.meta.url)) === realpathSync(invokedPath);
  } catch {
    invokedDirectly = fileURLToPath(import.meta.url) === invokedPath;
  }
}
if (invokedDirectly) {
  process.exitCode = await main();
}
