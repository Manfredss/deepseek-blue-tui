import type { AppConfig, ChatMessage, Session } from "./types.js";
import { RECOMMENDED_MODELS } from "./types.js";
import { ConfigStore, maskApiKey } from "./config.js";
import {
  addUsage,
  createSession,
  deriveTitle,
  estimateTokens,
  SessionStore,
  truncateToLimit,
} from "./session-store.js";
import type { FileLock } from "./fs-utils.js";
import { completeSlashCommand, commandHelp, parseSlashCommand, unescapePrompt } from "./commands.js";
import { createTheme, clearCurrentLine, type Theme } from "./theme.js";
import { renderLogo } from "./logo.js";
import { LineInput, promptSecret } from "./input.js";
import { DeepSeekApiError, getBalance, streamChat } from "./api.js";
import { DEEPSEEK_URLS, openUrl } from "./open-url.js";
import { DshManager, formatDshStatus, installDsh } from "./dsh.js";
import { LockHeldError } from "./fs-utils.js";
import { VERSION } from "./version.js";

export interface TuiOptions {
  configStore: ConfigStore;
  sessionStore: SessionStore;
  dshManager: DshManager;
  config: AppConfig;
  cwd: string;
  session?: Session;
  resumeQuery?: string | true;
  continueLast?: boolean;
  showLogo?: boolean;
  color?: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WriteStream;
}

function safeTerminalText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

function shortPath(value: string, width = 54): string {
  if (value.length <= width) return value;
  return `…${value.slice(-(width - 1))}`;
}

function shortText(value: string, width = 900): string {
  const clean = safeTerminalText(value).trim();
  if (clean.length <= width) return clean;
  return `${clean.slice(0, width - 1)}…`;
}

function validModel(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value);
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export class DeepSeekTui {
  private readonly configStore: ConfigStore;
  private readonly sessionStore: SessionStore;
  private readonly dsh: DshManager;
  private readonly cwd: string;
  private readonly output: NodeJS.WriteStream;
  private readonly inputStream: NodeJS.ReadableStream;
  private readonly theme: Theme;
  private readonly showLogo: boolean;
  private readonly resumeQuery: string | true | undefined;
  private readonly continueLast: boolean;
  private config: AppConfig;
  private session: Session | undefined;
  private input!: LineInput;
  private exitRequested = false;
  private controller: AbortController | undefined;
  private lastInterrupt = 0;
  private processInterrupt: () => void;
  private sessionLock: FileLock | undefined;
  private readOnly = false;

  constructor(options: TuiOptions) {
    this.configStore = options.configStore;
    this.sessionStore = options.sessionStore;
    this.dsh = options.dshManager;
    this.config = options.config;
    this.cwd = options.cwd;
    this.output = options.output ?? process.stdout;
    this.inputStream = options.input ?? process.stdin;
    this.theme = createTheme((options.color ?? true) && Boolean(this.output.isTTY));
    this.showLogo = options.showLogo ?? true;
    this.session = options.session;
    this.resumeQuery = options.resumeQuery;
    this.continueLast = options.continueLast ?? false;
    this.processInterrupt = () => this.handleInterrupt();
  }

  private makeInput(): LineInput {
    const input = new LineInput({
      input: this.inputStream,
      output: this.output,
      completer: completeSlashCommand,
    });
    input.onInterrupt = () => this.handleInterrupt();
    return input;
  }

  private write(value: string): void {
    this.output.write(value);
  }

  private line(value = ""): void {
    this.write(`${value}\n`);
  }

  private handleInterrupt(): void {
    const now = Date.now();
    if (now - this.lastInterrupt < 80) return;
    this.lastInterrupt = now;
    if (this.controller) {
      this.controller.abort();
      return;
    }
    this.exitRequested = true;
    this.input?.close();
  }

  private async initialSession(): Promise<Session> {
    if (this.session) return this.session;
    if (this.continueLast) {
      const latest = (await this.sessionStore.list({ cwd: this.cwd, limit: 1 }))[0];
      if (latest) return latest;
    }
    if (typeof this.resumeQuery === "string") {
      const matches = await this.sessionStore.find(this.resumeQuery, this.cwd);
      if (matches.length === 1 && matches[0]) return matches[0];
      if (matches.length > 1) return await this.chooseSession(matches) ?? createSession(this.cwd, this.config.model);
      this.line(this.theme.yellow(`未找到会话：${this.resumeQuery}`));
    }
    if (this.resumeQuery === true) {
      const chosen = await this.chooseSession(await this.sessionStore.list({ cwd: this.cwd, limit: 20 }));
      if (chosen) return chosen;
    }
    return createSession(this.cwd, this.config.model);
  }

  /**
   * Holds an advisory lock while a session is open so a second terminal
   * resuming the same session cannot silently overwrite this one. When the
   * lock is already owned by a live process, this instance degrades to
   * read-only (chat works, persistence is skipped).
   */
  private async lockSession(session: Session): Promise<void> {
    await this.sessionLock?.release();
    this.sessionLock = undefined;
    this.readOnly = false;
    try {
      this.sessionLock = await this.sessionStore.acquireLock(session.id);
    } catch (error) {
      if (!(error instanceof LockHeldError)) throw error;
      this.readOnly = true;
      const pid = error.ownerPid;
      this.line(
        this.theme.yellow(
          pid !== undefined
            ? `会话 ${session.id.slice(0, 8)} 正被另一个终端使用 (PID ${pid})；本实例为只读，消息不会保存。`
            : `会话 ${session.id.slice(0, 8)} 正被另一个终端使用；本实例为只读，消息不会保存。`,
        ),
      );
    }
  }

  private async saveSession(): Promise<void> {
    if (this.readOnly || !this.session) return;
    await this.sessionStore.save(this.session);
  }

  async run(): Promise<void> {
    if (!(this.inputStream as NodeJS.ReadStream).isTTY || !this.output.isTTY) {
      throw new Error("交互模式需要 TTY；单次调用请使用 deepseek \"你的问题\"");
    }
    if (this.showLogo) this.write(renderLogo(this.theme));
    this.line(this.theme.muted(`  Unofficial community client v${VERSION}`));
    this.line(this.theme.muted(`  ${shortPath(this.cwd)}`));
    this.line();
    this.input = this.makeInput();
    process.on("SIGINT", this.processInterrupt);

    try {
      this.session = await this.initialSession();
      await this.lockSession(this.session);
      if (this.session.messages.length > 0) this.renderHistory(this.session);
      const runtime = this.configStore.runtime(this.config);
      this.line(
        `${this.theme.blue("●")} ${this.theme.bold(this.session.model)} ${this.theme.muted("· /help 查看命令")}`,
      );
      if (!runtime.apiKey) {
        this.line(this.theme.yellow("尚未配置 API Key。输入 /login 可安全粘贴，或打开 DeepSeek 平台。"));
      }
      this.line();

      while (!this.exitRequested) {
        const line = await this.input.next(this.theme.brightBlue("❯ "));
        if (line === undefined) break;
        const trimmed = line.trim();
        if (!trimmed) continue;
        const command = parseSlashCommand(line);
        if (command) await this.handleCommand(command.name, command.args, command.tokens);
        else await this.sendMessage(unescapePrompt(line));
      }
    } finally {
      if (this.session && this.session.messages.length > 0 && !this.readOnly) {
        await this.sessionStore.save(this.session);
      }
      await this.sessionLock?.release();
      this.input?.close();
      process.removeListener("SIGINT", this.processInterrupt);
      if (this.output.isTTY) this.line(this.theme.muted("再见。"));
    }
  }

  private renderHistory(session: Session): void {
    this.line(this.theme.muted(`恢复会话 ${session.id.slice(0, 8)} · ${session.title}`));
    const messages = session.messages.slice(-10);
    if (session.messages.length > messages.length) {
      this.line(this.theme.muted(`… 已省略更早的 ${session.messages.length - messages.length} 条消息`));
    }
    for (const message of messages) {
      const label = message.role === "user" ? this.theme.brightBlue("You") : this.theme.blue("DeepSeek");
      if (message.role === "system") continue;
      this.line(`\n${label}`);
      if (message.reasoningContent && this.config.showReasoning) {
        this.line(this.theme.muted(shortText(message.reasoningContent, 500)));
      }
      this.line(shortText(message.content));
    }
    this.line();
  }

  private async chooseSession(sessions: Session[]): Promise<Session | undefined> {
    if (sessions.length === 0) {
      this.line(this.theme.muted("当前工作目录还没有历史会话。"));
      return undefined;
    }
    this.line(this.theme.bold("最近会话"));
    sessions.slice(0, 12).forEach((session, index) => {
      this.line(
        `  ${this.theme.blue(String(index + 1).padStart(2))}  ${formatTime(session.updatedAt)}  ${shortText(session.title, 56)}`,
      );
    });
    const answer = await this.input.next(this.theme.brightBlue("选择编号（回车取消）› "));
    if (!answer?.trim()) return undefined;
    const index = Number.parseInt(answer.trim(), 10) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= Math.min(sessions.length, 12)) {
      this.line(this.theme.yellow("无效的会话编号。"));
      return undefined;
    }
    return sessions[index];
  }

  private async handleCommand(name: string, args: string, tokens: string[]): Promise<void> {
    switch (name) {
      case "help":
        this.line(commandHelp());
        break;
      case "exit":
      case "quit":
        this.exitRequested = true;
        this.input.close();
        break;
      case "model":
        await this.changeModel(args);
        break;
      case "login":
        await this.login(tokens[0]);
        break;
      case "logout":
        await this.logout();
        break;
      case "usage":
        await this.usage(tokens[0]);
        break;
      case "clear":
      case "new":
        await this.clearConversation();
        break;
      case "resume":
      case "sessions":
        await this.resumeConversation(args);
        break;
      case "rename":
        await this.renameConversation(args);
        break;
      case "thinking":
        await this.toggleThinking(tokens[0]);
        break;
      case "status":
        await this.showStatus();
        break;
      case "dsh":
        await this.handleDsh(tokens);
        break;
      default:
        this.line(this.theme.yellow(`未知命令：/${name}。输入 /help 查看可用命令。`));
    }
  }

  private async changeModel(requested: string): Promise<void> {
    let model = requested.trim();
    if (!model) {
      this.line(this.theme.bold("选择模型"));
      RECOMMENDED_MODELS.forEach((item, index) => {
        const current = this.session?.model === item.id ? this.theme.green(" ✓") : "";
        this.line(`  ${this.theme.blue(String(index + 1))}  ${item.label}${current}`);
        this.line(`     ${this.theme.muted(item.description)}`);
      });
      const answer = await this.input.next(this.theme.brightBlue("编号或自定义模型名称（回车取消）› "));
      if (!answer?.trim()) return;
      const selected = RECOMMENDED_MODELS[Number.parseInt(answer.trim(), 10) - 1];
      model = selected?.id ?? answer.trim();
    }
    if (!validModel(model)) {
      this.line(this.theme.yellow("模型名称无效。只允许字母、数字以及 . _ : / -"));
      return;
    }
    this.config.model = model;
    if (this.session) {
      this.session.model = model;
      await this.saveSession();
    }
    await this.configStore.save(this.config);
    this.line(`${this.theme.green("✓")} 已切换到 ${this.theme.bold(model)}`);
  }

  private async login(mode: string | undefined): Promise<void> {
    if (mode === "browser") {
      await this.openAndReport(DEEPSEEK_URLS.apiKeys, "API Key 页面");
      return;
    }
    this.line("  1  安全粘贴 API Key（输入不会显示）");
    this.line("  2  在浏览器打开 DeepSeek API Key 页面");
    this.line("  3  取消");
    const choice = await this.input.next(this.theme.brightBlue("选择› "));
    if (choice?.trim() === "2") {
      await this.openAndReport(DEEPSEEK_URLS.apiKeys, "API Key 页面");
      return;
    }
    if (choice?.trim() !== "1") return;

    this.input.close();
    const key = await promptSecret("粘贴 API Key：", { input: this.inputStream, output: this.output });
    this.input = this.makeInput();
    if (!key?.trim()) {
      this.line(this.theme.muted("已取消。"));
      return;
    }
    if (key.trim().length < 8 || /\s/.test(key.trim())) {
      this.line(this.theme.yellow("API Key 格式无效。"));
      return;
    }
    this.config.apiKey = key.trim();
    await this.configStore.save(this.config);
    this.line(`${this.theme.green("✓")} API Key 已保存到权限为 0600 的本地配置文件 (${maskApiKey(key.trim())})`);
  }

  private async logout(): Promise<void> {
    delete this.config.apiKey;
    await this.configStore.save(this.config);
    const environmentStillSet = Boolean(process.env.DEEPSEEK_API_KEY?.trim());
    this.line(`${this.theme.green("✓")} 已删除本地保存的 API Key。`);
    if (environmentStillSet) this.line(this.theme.yellow("DEEPSEEK_API_KEY 环境变量仍然生效。"));
  }

  private async usage(mode: string | undefined): Promise<void> {
    const runtime = this.configStore.runtime(this.config);
    if (runtime.apiKey) {
      try {
        const balance = await getBalance({ apiKey: runtime.apiKey, baseUrl: runtime.baseUrl });
        if (balance.balances.length === 0) this.line(this.theme.muted("余额接口未返回币种明细。"));
        for (const item of balance.balances) {
          this.line(
            `${this.theme.bold(item.totalBalance)} ${item.currency} ${this.theme.muted(`(充值 ${item.toppedUpBalance} · 赠金 ${item.grantedBalance})`)}`,
          );
        }
        if (!balance.available) this.line(this.theme.yellow("当前余额不可用于 API 调用。"));
      } catch (error) {
        this.line(this.theme.yellow(`暂时无法查询余额：${this.errorMessage(error)}`));
      }
    }
    const url = mode === "topup" || mode === "top-up" ? DEEPSEEK_URLS.topUp : DEEPSEEK_URLS.usage;
    await this.openAndReport(url, mode ? "充值页面" : "用量页面");
  }

  private async clearConversation(): Promise<void> {
    if (!this.session) return;
    if (this.session.messages.length > 0) await this.saveSession();
    this.session = createSession(this.cwd, this.session.model);
    await this.lockSession(this.session);
    this.line(`${this.theme.green("✓")} 已开始新会话；原会话仍可通过 /resume 恢复。`);
  }

  private async resumeConversation(query: string): Promise<void> {
    const matches = query.trim()
      ? await this.sessionStore.find(query, this.cwd)
      : await this.sessionStore.list({ cwd: this.cwd, limit: 20 });
    let selected: Session | undefined;
    if (matches.length === 1) selected = matches[0];
    else selected = await this.chooseSession(matches);
    if (!selected) {
      if (query.trim() && matches.length === 0) this.line(this.theme.yellow(`未找到会话：${query.trim()}`));
      return;
    }
    if (this.session?.messages.length) await this.saveSession();
    this.session = selected;
    await this.lockSession(selected);
    this.renderHistory(selected);
    this.line(`${this.theme.green("✓")} 已恢复；当前模型 ${selected.model}`);
  }

  private async renameConversation(title: string): Promise<void> {
    if (!this.session) return;
    const clean = title.replace(/\s+/g, " ").trim();
    if (!clean) {
      this.line(this.theme.yellow("用法：/rename <新标题>"));
      return;
    }
    this.session.title = clean.slice(0, 100);
    await this.sessionStore.save(this.session);
    this.line(`${this.theme.green("✓")} 会话已重命名为 ${this.session.title}`);
  }

  private async toggleThinking(value: string | undefined): Promise<void> {
    const normalized = value?.toLocaleLowerCase();
    if (normalized === "on") this.config.showReasoning = true;
    else if (normalized === "off") this.config.showReasoning = false;
    else if (normalized && normalized !== "toggle") {
      this.line(this.theme.yellow("用法：/thinking [on|off]"));
      return;
    } else this.config.showReasoning = !this.config.showReasoning;
    await this.configStore.save(this.config);
    this.line(`思考过程：${this.config.showReasoning ? this.theme.green("显示") : this.theme.muted("隐藏")}`);
  }

  private async showStatus(): Promise<void> {
    if (!this.session) return;
    const runtime = this.configStore.runtime(this.config);
    const dshStatus = await this.dsh.status(this.config.dshPort);
    this.line(`${this.theme.bold("模型")}      ${this.session.model}`);
    this.line(`${this.theme.bold("API")}       ${runtime.baseUrl}`);
    this.line(`${this.theme.bold("凭据")}      ${maskApiKey(runtime.apiKey)}${process.env.DEEPSEEK_API_KEY ? " (环境变量)" : ""}`);
    this.line(`${this.theme.bold("会话")}      ${this.session.id} · ${this.session.messages.length} 条消息`);
    this.line(
      `${this.theme.bold("上下文")}    ${estimateTokens(this.session.messages).toLocaleString()} / ${this.config.contextLimitTokens.toLocaleString()} tokens（估算）`,
    );
    this.line(`${this.theme.bold("Token")}     ${this.session.usage.totalTokens.toLocaleString()} 总计`);
    this.line(`${this.theme.bold("缓存命中")}  ${this.session.usage.promptCacheHitTokens.toLocaleString()}`);
    this.line(`${this.theme.bold("DSH")}       ${formatDshStatus(dshStatus)}`);
  }

  private async handleDsh(tokens: string[]): Promise<void> {
    const action = tokens[0]?.toLocaleLowerCase() ?? "open";
    const portToken = tokens.find((token, index) => index > 0 && /^\d+$/.test(token));
    const port = portToken ? Number.parseInt(portToken, 10) : this.config.dshPort;
    try {
      if (action === "install") {
        const result = await installDsh();
        this.line(result.message);
        return;
      }
      if (action === "status") {
        this.line(formatDshStatus(await this.dsh.status(port)));
        return;
      }
      if (action === "stop") {
        this.line((await this.dsh.stop()).message);
        return;
      }
      if (action === "logs") {
        const logs = await this.dsh.logs(80);
        this.line(logs || this.theme.muted("暂无 DSH 日志。"));
        return;
      }
      if (action === "restart") {
        await this.dsh.stop();
        const status = await this.dsh.start({ port, cwd: this.cwd });
        this.line(formatDshStatus(status));
        await this.openAndReport(status.url, "DSH Web");
        return;
      }
      if (action !== "start" && action !== "open") {
        this.line(this.theme.yellow("用法：/dsh [install|start|open|status|stop|logs|restart] [端口]"));
        return;
      }
      this.line(this.theme.muted("正在启动/连接 DSH Web…"));
      const status = await this.dsh.start({ port, cwd: this.cwd });
      this.line(formatDshStatus(status));
      if (status.phase === "running") await this.openAndReport(status.url, "DSH Web");
      else this.line(this.theme.muted(`仍在启动；日志位于 ${status.logFile ?? this.dsh.logPath}`));
    } catch (error) {
      this.line(this.theme.red(`DSH：${this.errorMessage(error)}`));
    }
  }

  private async openAndReport(url: string, label: string): Promise<void> {
    const opened = await openUrl(url);
    this.line(opened ? `${this.theme.green("✓")} 已打开${label}` : `${label}：${url}`);
  }

  private async sendMessage(text: string): Promise<void> {
    if (!this.session) return;
    const runtime = this.configStore.runtime(this.config);
    if (!runtime.apiKey) {
      this.line(this.theme.yellow("缺少 API Key。请先输入 /login，或设置 DEEPSEEK_API_KEY。"));
      return;
    }
    const userMessage: ChatMessage = {
      role: "user",
      content: text,
      createdAt: new Date().toISOString(),
    };
    this.session.messages.push(userMessage);
    if (this.session.title === "New conversation") this.session.title = deriveTitle(text);
    await this.saveSession();

    const limit = this.config.contextLimitTokens;
    const estimated = estimateTokens(this.session.messages);
    let messages = this.session.messages;
    if (estimated > limit) {
      const result = truncateToLimit(this.session.messages, limit);
      this.session.messages = result.messages;
      messages = result.messages;
      this.line(
        this.theme.yellow(
          `上下文超限（估算 ${estimated.toLocaleString()} tokens > ${limit.toLocaleString()}），已裁剪最早的 ${result.dropped} 条消息。可在 config.json 调整 contextLimitTokens。`,
        ),
      );
    } else if (estimated > limit * 0.8) {
      this.line(
        this.theme.yellow(`上下文较长（估算 ${estimated.toLocaleString()} tokens，上限 ${limit.toLocaleString()}）。`),
      );
    }

    this.controller = new AbortController();
    this.input.pause();
    this.write(`\n${this.theme.muted("● 正在思考…")}`);
    let content = "";
    let reasoning = "";
    let reasoningShown = false;
    let contentShown = false;
    try {
      const result = await streamChat({
        apiKey: runtime.apiKey,
        baseUrl: runtime.baseUrl,
        model: this.session.model,
        messages,
        signal: this.controller.signal,
        onReasoning: (delta) => {
          reasoning += delta;
          if (!this.config.showReasoning) return;
          if (!reasoningShown) {
            clearCurrentLine(this.output);
            this.write(`${this.theme.muted("╭─ thinking")}\n${this.theme.muted(safeTerminalText(delta))}`);
            reasoningShown = true;
          } else this.write(this.theme.muted(safeTerminalText(delta)));
        },
        onContent: (delta) => {
          content += delta;
          if (!contentShown) {
            if (reasoningShown) this.write(`\n${this.theme.muted("╰─")}\n\n`);
            else clearCurrentLine(this.output);
            this.write(`${this.theme.blue("◆ DeepSeek")}\n`);
            contentShown = true;
          }
          this.write(safeTerminalText(delta));
        },
      });
      if (!contentShown) {
        clearCurrentLine(this.output);
        this.write(`${this.theme.blue("◆ DeepSeek")}\n${this.theme.muted("(没有文本响应)")}`);
      }
      const assistant: ChatMessage = {
        role: "assistant",
        content: result.content,
        createdAt: new Date().toISOString(),
      };
      if (result.reasoningContent) assistant.reasoningContent = result.reasoningContent;
      this.session.messages.push(assistant);
      this.session.usage = addUsage(this.session.usage, result.usage);
      await this.saveSession();
      this.write(`\n\n${this.theme.muted(`${result.usage.promptTokens.toLocaleString()} input · ${result.usage.completionTokens.toLocaleString()} output`)}\n\n`);
    } catch (error) {
      if (content || reasoning) {
        const partial: ChatMessage = { role: "assistant", content, createdAt: new Date().toISOString() };
        if (reasoning) partial.reasoningContent = reasoning;
        this.session.messages.push(partial);
        await this.saveSession();
      }
      clearCurrentLine(this.output);
      if ((error as Error).name === "AbortError") this.line(`\n${this.theme.yellow("已取消本次生成。")}\n`);
      else this.line(`\n${this.theme.red(`请求失败：${this.errorMessage(error)}`)}\n`);
    } finally {
      this.controller = undefined;
      this.input.resume();
    }
  }

  private errorMessage(error: unknown): string {
    if (error instanceof DeepSeekApiError) return `${error.message}${error.status ? ` (${error.status})` : ""}`;
    if (error instanceof Error) return error.message;
    return String(error);
  }
}
