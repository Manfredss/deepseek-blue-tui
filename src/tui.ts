import { userInfo } from "node:os";
import { join } from "node:path";
import type { AppConfig, ChatMessage, ReasoningEffort, Session } from "./types.js";
import { REASONING_EFFORT_LABELS, REASONING_EFFORTS, RECOMMENDED_MODELS } from "./types.js";
import { ConfigStore, maskApiKey } from "./config.js";
import {
  addUsage,
  createSession,
  deriveTitle,
  estimateTokens,
  SessionStore,
  truncateToLimit,
} from "./session-store.js";
import {
  applyCompactSummary,
  attachmentMessage,
  buildContextBreakdown,
  COMPACT_INSTRUCTION,
  editPrompt,
  forkSessionAt,
  formatCompactTokens,
  readAttachmentFile,
  searchMessages,
  userMessageIndexes,
  writeSessionExport,
} from "./session-tools.js";
import type { FileLock } from "./fs-utils.js";
import { commandHelp, parseSlashCommand, renderSlashCommandMenu, slashCommandSuggestions, unescapePrompt } from "./commands.js";
import { colorEnabled, createTheme, clearCurrentLine, type Theme } from "./theme.js";
import { renderWelcomeScreen } from "./logo.js";
import { LineInput, promptSecret, MenuPicker, type MenuPickerOptions, type MenuPickerResult } from "./input.js";
import { DeepSeekApiError, getBalance, streamChat } from "./api.js";
import { DEEPSEEK_URLS, openUrl } from "./open-url.js";
import { DshManager, formatDshStatus, installDsh } from "./dsh.js";
import { LockHeldError } from "./fs-utils.js";
import { renderContextHud, renderContextReport } from "./context-view.js";
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

function currentUsername(): string {
  try {
    return safeTerminalText(userInfo().username).trim().slice(0, 48) || "friend";
  } catch {
    return "friend";
  }
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
  private mainPromptActive = false;
  private homeScreenPristine = true;

  constructor(options: TuiOptions) {
    this.configStore = options.configStore;
    this.sessionStore = options.sessionStore;
    this.dsh = options.dshManager;
    this.config = options.config;
    this.cwd = options.cwd;
    this.output = options.output ?? process.stdout;
    this.inputStream = options.input ?? process.stdin;
    this.theme = createTheme((options.color ?? true) && colorEnabled(this.output));
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
      suggestions: (line, size, selected) => ({
        lines: renderSlashCommandMenu(line, { ...size, theme: this.theme, selected }),
        values: slashCommandSuggestions(line).map(({ command }) => command),
      }),
      onResize: () => this.redrawHomeForResize(),
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

  private terminalColumns(): number {
    const columns = this.output.columns;
    return Number.isFinite(columns) && columns > 0 ? Math.max(16, columns - 2) : 92;
  }

  private terminalRows(): number {
    const rows = this.output.rows;
    return Number.isFinite(rows) && rows > 0 ? Math.max(8, rows) : 24;
  }

  private renderHome(): void {
    if (!this.session) return;
    const runtime = this.configStore.runtime(this.config);
    if (this.showLogo) {
      if (this.theme.enabled) this.write("\u001b[0m");
      this.write(
        renderWelcomeScreen(this.theme, {
          columns: this.terminalColumns(),
          rows: this.terminalRows(),
          cwd: this.cwd,
          model: this.session.model,
          version: VERSION,
          apiKeyConfigured: Boolean(runtime.apiKey),
          username: currentUsername(),
        }),
      );
    } else {
      this.line(this.theme.bold(`DeepSeek TUI v${VERSION}`));
      this.line(this.theme.muted(`Unofficial community client · ${this.cwd}`));
    }
    if (this.session.messages.length > 0) this.renderHistory(this.session);
    const columns = this.terminalColumns();
    this.line(this.theme.muted("─".repeat(columns)));
    this.line(
      `${this.theme.blue("●")} ${this.theme.bold(this.session.model)} ${this.theme.muted(columns < 40 ? "· /help" : "· /help 查看命令")}`,
    );
    if (!runtime.apiKey) {
      this.line(
        this.theme.yellow(
          columns < 48 ? "未配置 API Key · /login" : "尚未配置 API Key。输入 /login 可安全粘贴，或打开 DeepSeek 平台。",
        ),
      );
    }
    this.line();
  }

  private redrawHomeForResize(): void {
    if (!this.mainPromptActive || !this.homeScreenPristine || !this.session || this.controller) return;
    this.write("\u001b[2J\u001b[H");
    this.renderHome();
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
    this.input = this.makeInput();
    process.on("SIGINT", this.processInterrupt);

    try {
      this.session = await this.initialSession();
      await this.lockSession(this.session);
      this.homeScreenPristine = this.session.messages.length === 0 && !this.readOnly;
      this.renderHome();

      while (!this.exitRequested) {
        this.mainPromptActive = true;
        const line = await this.input.next(this.theme.brightBlue("❯ "), { suggestions: true });
        this.mainPromptActive = false;
        if (line === undefined) break;
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.homeScreenPristine = false;
        const command = parseSlashCommand(line);
        if (command) await this.handleCommand(command.name, command.args, command.tokens);
        else await this.sendMessage(unescapePrompt(line));
      }
    } finally {
      this.mainPromptActive = false;
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

  private async runMenu(options: MenuPickerOptions): Promise<MenuPickerResult> {
    this.input.suspendForMenu();
    try {
      const picker = new MenuPicker(this.inputStream, this.output);
      return await picker.run({
        ...options,
        color: { accent: this.theme.brightBlue, muted: this.theme.muted },
      });
    } finally {
      this.input.resumeFromMenu();
    }
  }

  private async chooseSession(sessions: Session[]): Promise<Session | undefined> {
    if (sessions.length === 0) {
      this.line(this.theme.muted("当前工作目录还没有历史会话。"));
      return undefined;
    }
    const visible = sessions.slice(0, 12);
    const result = await this.runMenu({
      title: "最近会话",
      items: visible.map(
        (session, index) =>
          `${String(index + 1).padStart(2)}  ${formatTime(session.updatedAt)}  ${shortText(session.title, 48)}`,
      ),
      footer: "↑/↓ 选择 · Enter 确认 · Esc 取消 · 数字跳转",
    });
    if (!result || result.kind !== "index") return undefined;
    return visible[result.index];
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
      case "effort":
        await this.changeEffort(tokens[0]);
        break;
      case "status":
        await this.showStatus();
        break;
      case "context":
        await this.showContext();
        break;
      case "btw":
        await this.sideQuestion(args);
        break;
      case "compact":
        await this.compactConversation();
        break;
      case "export":
        await this.exportConversation();
        break;
      case "edit":
        await this.editInput(args);
        break;
      case "attach":
        await this.attachFile(args);
        break;
      case "rewind":
        await this.rewindConversation(tokens[0]);
        break;
      case "search":
        await this.searchInSession(args);
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
      const result = await this.runMenu({
        title: "选择模型",
        items: RECOMMENDED_MODELS.map(
          (item, index) =>
            `${index + 1}  ${item.label}${this.session?.model === item.id ? " ✓" : ""}  ${item.description}`,
        ),
        allowCustom: true,
        customLabel: "自定义模型：",
        footer: "↑/↓ 选择 · Enter 确认 · Esc 取消 · 直接输入自定义模型 ID",
      });
      if (!result) return;
      if (result.kind === "custom") {
        model = result.text;
      } else {
        const selected = RECOMMENDED_MODELS[result.index];
        if (!selected) return;
        model = selected.id;
      }
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
    const result = await this.runMenu({
      title: "登录方式",
      items: ["安全粘贴 API Key（输入不会显示）", "在浏览器打开 DeepSeek API Key 页面", "取消"],
      footer: "↑/↓ 选择 · Enter 确认 · Esc 取消 · 数字跳转",
    });
    if (!result || result.kind !== "index") return;
    if (result.index === 1) {
      await this.openAndReport(DEEPSEEK_URLS.apiKeys, "API Key 页面");
      return;
    }
    if (result.index !== 0) return;

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

  /** /effort — DeepSeek V4 thinking effort (low/high/max), with a menu. */
  private async changeEffort(requested: string | undefined): Promise<void> {
    const normalized = requested?.trim().toLocaleLowerCase();
    let effort: ReasoningEffort | undefined;
    if (normalized && (REASONING_EFFORTS as readonly string[]).includes(normalized)) {
      effort = normalized as ReasoningEffort;
    } else if (normalized) {
      this.line(this.theme.yellow("用法：/effort [low|high|max]。medium 在 DeepSeek V4 上会映射为 high。"));
      return;
    } else {
      const result = await this.runMenu({
        title: "选择思考强度",
        items: REASONING_EFFORTS.map(
          (level) =>
            `${level.padEnd(4)} ${REASONING_EFFORT_LABELS[level]}${this.config.effort === level ? " ✓" : ""}`,
        ),
        footer: "↑/↓ 选择 · Enter 确认 · Esc 取消 · 数字跳转",
      });
      if (!result || result.kind !== "index") return;
      effort = REASONING_EFFORTS[result.index];
    }
    if (!effort) return;
    this.config.effort = effort;
    await this.configStore.save(this.config);
    this.line(`${this.theme.green("✓")} 思考强度已设为 ${this.theme.bold(effort)}（${REASONING_EFFORT_LABELS[effort]}）`);
  }

  private async showStatus(): Promise<void> {
    if (!this.session) return;
    const runtime = this.configStore.runtime(this.config);
    const dshStatus = await this.dsh.status(this.config.dshPort);
    this.line(
      renderContextHud(
        this.theme,
        {
          model: this.session.model,
          estimatedTokens: estimateTokens(this.session.messages),
          limitTokens: this.config.contextLimitTokens,
          messageCount: this.session.messages.length,
          showReasoning: this.config.showReasoning,
          readOnly: this.readOnly,
          apiKeyConfigured: Boolean(runtime.apiKey),
          usage: this.session.usage,
          cwd: this.cwd,
        },
        { columns: this.terminalColumns() },
      ),
    );
    this.line(
      renderContextReport(
        this.theme,
        {
          model: this.session.model,
          estimatedTokens: estimateTokens(this.session.messages),
          limitTokens: this.config.contextLimitTokens,
          messageCount: this.session.messages.length,
          showReasoning: this.config.showReasoning,
          readOnly: this.readOnly,
          apiKeyConfigured: Boolean(runtime.apiKey),
          usage: this.session.usage,
          cwd: this.cwd,
        },
        { columns: this.terminalColumns() },
      ),
    );
    this.line(`${this.theme.bold("会话")}      ${this.session.id} · ${this.session.title}`);
    this.line(`${this.theme.bold("Endpoint")}  ${runtime.baseUrl}`);
    this.line(`${this.theme.bold("凭据")}      ${maskApiKey(runtime.apiKey)}${process.env.DEEPSEEK_API_KEY ? " (环境变量)" : ""}`);
    this.line(
      `${this.theme.bold("思考强度")}  ${this.theme.bold(this.config.effort)}${this.theme.muted(`（${REASONING_EFFORT_LABELS[this.config.effort]}）· 思考过程 ${this.config.showReasoning ? "显示" : "隐藏"}`)}`,
    );
    const hit = this.session.usage.promptCacheHitTokens;
    const miss = this.session.usage.promptCacheMissTokens;
    const hitRate = hit + miss > 0 ? ((hit / (hit + miss)) * 100).toFixed(1) : "—";
    this.line(`${this.theme.bold("缓存命中")}  ${this.session.usage.promptCacheHitTokens.toLocaleString()} (${hitRate}%)`);
    this.line(`${this.theme.bold("速度")}      ${this.renderTpsLine()}`);
    this.line(`${this.theme.bold("DSH")}       ${formatDshStatus(dshStatus)}`);
  }

  private renderTpsLine(): string {
    if (!this.session) return "";
    const { lastTurnMs, lastCompletionTokens } = this.session;
    if (!lastTurnMs || lastCompletionTokens === undefined || lastCompletionTokens === 0) {
      return this.theme.muted("—（暂无最近一轮数据）");
    }
    const tps = lastCompletionTokens / (lastTurnMs / 1_000);
    const value = `${tps.toFixed(1)} tok/s（最近一轮）`;
    if (tps >= 50) return this.theme.green(value);
    if (tps >= 20) return this.theme.yellow(value);
    return this.theme.muted(value);
  }

  /** /context — per-message token audit plus segmented breakdown (dsh-TUI 借鉴). */
  private async showContext(): Promise<void> {
    if (!this.session) return;
    const messages = this.session.messages;
    this.line(this.theme.bold(`上下文明细（估算，共 ${messages.length} 条）`));
    const head = messages.length > 50 ? messages.slice(-50) : messages;
    if (messages.length > head.length) this.line(this.theme.muted(`… 已省略更早的 ${messages.length - head.length} 条`));
    const labels: Record<ChatMessage["role"], string> = { system: "系统", user: "用户", assistant: "助手" };
    head.forEach((message, index) => {
      const offset = messages.length - head.length + index + 1;
      const tokens = formatCompactTokens(estimateTokens([message]));
      this.line(
        `  ${this.theme.blue(String(offset).padStart(3))}  ${this.theme.muted(labels[message.role].padEnd(2))} ${this.theme.muted(tokens.padStart(6))}  ${shortText(message.content, 60)}`,
      );
    });
    const breakdown = buildContextBreakdown(messages, this.config.contextLimitTokens, 30);
    this.line();
    this.line(this.theme.bold("分段构成"));
    for (const segment of breakdown.segments) {
      const label = segment.label === "thinking" ? "思考" : labels[segment.label];
      this.line(
        `  ${this.theme.muted(label.padEnd(4))} ${this.theme.blue("█".repeat(Math.max(1, Math.round(segment.percent / 100 * 20))).padEnd(20, " "))} ${formatCompactTokens(segment.tokens).padStart(7)} (${segment.percent.toFixed(0)}%)`,
      );
    }
    this.line(`  合计 ${formatCompactTokens(breakdown.total)} / ${formatCompactTokens(breakdown.limit)} tokens（${breakdown.percent.toFixed(0)}%）`);
  }

  /** /btw — a single-turn side question that never enters session history. */
  private async sideQuestion(prompt: string): Promise<void> {
    if (!this.session) return;
    const text = prompt.trim();
    if (!text) {
      this.line(this.theme.yellow("用法：/btw <问题>。侧问复用当前上下文做单轮调用，不写入会话历史。"));
      return;
    }
    const runtime = this.configStore.runtime(this.config);
    if (!runtime.apiKey) {
      this.line(this.theme.yellow("缺少 API Key。请先输入 /login，或设置 DEEPSEEK_API_KEY。"));
      return;
    }
    const request: ChatMessage[] = [...this.session.messages, { role: "user", content: text, createdAt: new Date().toISOString() }];
    this.controller = new AbortController();
    this.input.pause();
    this.write(`\n${this.theme.muted("◇ 侧问（单轮，不写入会话）")}\n`);
    let content = "";
    let reasoning = "";
    let reasoningShown = false;
    let contentShown = false;
    try {
      const result = await streamChat({
        apiKey: runtime.apiKey,
        baseUrl: runtime.baseUrl,
        model: this.session.model,
        messages: request,
        effort: this.config.effort,
        signal: this.controller.signal,
        onReasoning: (delta) => {
          reasoning += delta;
          if (!this.config.showReasoning) return;
          if (!reasoningShown) {
            this.write(`${this.theme.muted(safeTerminalText(delta))}`);
            reasoningShown = true;
          } else this.write(this.theme.muted(safeTerminalText(delta)));
        },
        onContent: (delta) => {
          content += delta;
          if (!contentShown) {
            if (reasoningShown) this.write("\n");
            contentShown = true;
          }
          this.write(safeTerminalText(delta));
        },
      });
      if (!contentShown && !reasoningShown) this.write(this.theme.muted("(没有文本响应)"));
      this.write(`\n\n${this.theme.muted(`侧问结束 · ${result.usage.totalTokens.toLocaleString()} tokens（不计入会话）`)}\n\n`);
    } catch (error) {
      clearCurrentLine(this.output);
      if ((error as Error).name === "AbortError") this.line(`\n${this.theme.yellow("已取消侧问。")}\n`);
      else this.line(`\n${this.theme.red(`侧问失败：${this.errorMessage(error)}`)}\n`);
    } finally {
      this.controller = undefined;
      this.input.resume();
    }
  }

  /** /compact — summarize history into one system message, with auto backup. */
  private async compactConversation(): Promise<void> {
    if (!this.session) return;
    const substantive = this.session.messages.filter((message) => message.role !== "system").length;
    if (substantive === 0) {
      this.line(this.theme.yellow("当前会话还没有可压缩的内容。"));
      return;
    }
    const estimated = estimateTokens(this.session.messages);
    this.line(
      `将把 ${substantive} 条消息压缩为一段摘要并替换会话历史（估算 ${formatCompactTokens(estimated)} tokens → 摘要）。`,
    );
    const runtime = this.configStore.runtime(this.config);
    if (!runtime.apiKey) {
      this.line(this.theme.yellow("缺少 API Key。请先输入 /login，或设置 DEEPSEEK_API_KEY。"));
      return;
    }
    const answer = await this.input.next(this.theme.brightBlue("确认压缩？压缩前会自动导出备份 [y/N] › "));
    if (answer?.trim().toLocaleLowerCase() !== "y") {
      this.line(this.theme.muted("已取消。"));
      return;
    }
    try {
      const backup = await writeSessionExport(this.session, join(this.configStore.home, "exports"));
      this.line(this.theme.muted(`已备份到 ${backup}`));
    } catch (error) {
      this.line(this.theme.yellow(`备份失败，已取消压缩：${this.errorMessage(error)}`));
      return;
    }
    const request: ChatMessage[] = [
      ...this.session.messages,
      { role: "user", content: COMPACT_INSTRUCTION, createdAt: new Date().toISOString() },
    ];
    this.controller = new AbortController();
    this.input.pause();
    this.write(`\n${this.theme.muted("● 正在压缩历史…")}`);
    const startedAt = Date.now();
    try {
      const result = await streamChat({
        apiKey: runtime.apiKey,
        baseUrl: runtime.baseUrl,
        model: this.session.model,
        messages: request,
        effort: this.config.effort,
        signal: this.controller.signal,
      });
      clearCurrentLine(this.output);
      if (!result.content.trim()) {
        this.line(this.theme.yellow("模型未返回摘要，已保持会话不变。"));
        return;
      }
      this.session.messages = applyCompactSummary(result.content);
      this.session.usage = addUsage(this.session.usage, result.usage);
      this.session.lastTurnMs = Math.max(1, Date.now() - startedAt);
      this.session.lastCompletionTokens = result.usage.completionTokens;
      await this.saveSession();
      const after = estimateTokens(this.session.messages);
      this.line(
        `${this.theme.green("✓")} 已压缩为 1 条摘要消息（${formatCompactTokens(after)} tokens）。${this.theme.muted("原历史已备份到 exports 目录，可用 /resume 恢复此前会话时参考。")}`,
      );
      this.line();
    } catch (error) {
      clearCurrentLine(this.output);
      if ((error as Error).name === "AbortError") this.line(`\n${this.theme.yellow("已取消压缩。")}\n`);
      else this.line(`\n${this.theme.red(`压缩失败：${this.errorMessage(error)}`)}\n`);
    } finally {
      this.controller = undefined;
      this.input.resume();
    }
  }

  /** /export — write the session transcript as Markdown into the data dir. */
  private async exportConversation(): Promise<void> {
    if (!this.session) return;
    if (this.session.messages.length === 0) {
      this.line(this.theme.yellow("当前会话还没有内容可导出。"));
      return;
    }
    try {
      const path = await writeSessionExport(this.session, join(this.configStore.home, "exports"));
      this.line(`${this.theme.green("✓")} 已导出 ${this.session.messages.length} 条消息到 ${path}`);
    } catch (error) {
      this.line(this.theme.red(`导出失败：${this.errorMessage(error)}`));
    }
  }

  /** /edit — compose the next message in $VISUAL/$EDITOR. */
  private async editInput(initial: string): Promise<void> {
    this.input.pause();
    const result = await editPrompt({ initial: initial.trim() });
    this.input.resume();
    if (!result.ok) {
      this.line(this.theme.yellow(result.error ?? "编辑已取消。"));
      return;
    }
    await this.sendMessage(result.text ?? "");
  }

  /** /attach — read a text file (size-capped, binary-rejected) and send it. */
  private async attachFile(input: string): Promise<void> {
    const result = await readAttachmentFile(input, this.cwd);
    if (!result.ok) {
      this.line(this.theme.yellow(result.error ?? "无法附加文件。"));
      return;
    }
    this.line(this.theme.muted(`@${result.path}`));
    await this.sendMessage(attachmentMessage(result.path ?? "", result.content ?? ""));
  }

  /** /rewind — fork the session at an earlier user message (non-destructive). */
  private async rewindConversation(token: string | undefined): Promise<void> {
    if (!this.session) return;
    const indexes = userMessageIndexes(this.session);
    if (indexes.length < 2) {
      this.line(this.theme.yellow("至少需要两条用户消息才能回退。"));
      return;
    }
    let chosenIndex: number | undefined;
    const requested = token ? Number.parseInt(token, 10) : undefined;
    if (requested !== undefined && Number.isInteger(requested) && requested >= 1 && requested <= indexes.length) {
      chosenIndex = indexes[requested - 1];
    } else {
      const windowIndexes = indexes.slice(-12);
      const result = await this.runMenu({
        title: "选择回退点（分支会话，原会话保留）",
        items: windowIndexes.map((index, position) => {
          const message = this.session?.messages[index];
          return `${String(position + 1).padStart(2)}  ${shortText(message?.content ?? "", 56)}`;
        }),
        footer: "↑/↓ 选择 · Enter 确认 · Esc 取消 · 数字跳转",
      });
      if (!result || result.kind !== "index") return;
      chosenIndex = windowIndexes[result.index];
    }
    if (chosenIndex === undefined) return;
    await this.saveSession();
    const fork = forkSessionAt(this.session, chosenIndex);
    this.session = fork;
    await this.lockSession(fork);
    this.renderHistory(fork);
    this.line(`${this.theme.green("✓")} 已从该消息处分支新会话 ${fork.id.slice(0, 8)}；原会话仍可通过 /resume 恢复。`);
  }

  /** /search — line-grained full-text search over the current session. */
  private async searchInSession(query: string): Promise<void> {
    if (!this.session) return;
    if (!query.trim()) {
      this.line(this.theme.yellow("用法：/search <关键词>。在当前会话内全文搜索。"));
      return;
    }
    const hits = searchMessages(this.session.messages, query);
    if (hits.length === 0) {
      this.line(this.theme.muted(`没有找到包含「${query.trim()}」的内容。`));
      return;
    }
    const labels: Record<ChatMessage["role"], string> = { system: "系统", user: "用户", assistant: "助手" };
    this.line(this.theme.bold(`会话内搜索「${query.trim()}」（${hits.length} 处匹配）`));
    for (const hit of hits) {
      this.line(`  ${this.theme.blue(`#${String(hit.index + 1).padStart(3)}`)} ${this.theme.muted(labels[hit.role].padEnd(2))} ${this.theme.muted(`L${String(hit.lineNumber).padStart(3)}`)}  ${hit.line}`);
    }
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
    const startedAt = Date.now();
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
        effort: this.config.effort,
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
      this.session.lastTurnMs = Math.max(1, Date.now() - startedAt);
      this.session.lastCompletionTokens = result.usage.completionTokens;
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
