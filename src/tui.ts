import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import type { AppConfig, ChatMessage, ReasoningEffort, Session, TokenUsage } from "./types.js";
import { REASONING_EFFORT_LABELS, REASONING_EFFORTS, RECOMMENDED_MODELS } from "./types.js";
import { ConfigStore, maskApiKey } from "./config.js";
import {
  addUsage,
  createSession,
  deriveTitle,
  estimateTextTokens,
  estimateTokens,
  planRequest,
  SessionStore,
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
import { ensurePrivateDirectory } from "./fs-utils.js";
import {
  closestCommands,
  commandHelp,
  parseSlashCommand,
  renderSlashCommandMenu,
  slashCommandSuggestions,
  unescapePrompt,
} from "./commands.js";
import { colorEnabled, createTheme, type Theme } from "./theme.js";
import { renderWelcomeScreen } from "./logo.js";
import { LineInput, promptSecret, MenuPicker, watchAbortKeys, type MenuPickerOptions, type MenuPickerResult } from "./input.js";
import { DeepSeekApiError, getBalance, streamChat } from "./api.js";
import { DEEPSEEK_URLS, openUrl } from "./open-url.js";
import { DshManager, formatDshStatus, installDsh } from "./dsh.js";
import { LockHeldError } from "./fs-utils.js";
import { renderContextHud, renderContextReport, renderPressureBar } from "./context-view.js";
import { Spinner } from "./spinner.js";
import { clipToWidth, padToWidth, shortenPath } from "./text-width.js";
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

const HISTORY_LIMIT = 500;
/** Window in which a second Ctrl+C at an empty prompt means "quit". */
const INTERRUPT_EXIT_WINDOW_MS = 3_000;

function safeTerminalText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

function shortText(value: string, width = 900): string {
  const clean = safeTerminalText(value).trim();
  if (clean.length <= width) return clean;
  return `${clean.slice(0, width - 1)}…`;
}

/**
 * Single-line preview for table rows and menu items: newlines and runs of
 * whitespace collapse to one space so a multi-line message cannot break the
 * surrounding layout.
 */
function oneLine(value: string, width: number): string {
  return shortText(safeTerminalText(value).replace(/\s+/gu, " "), width);
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
    return safeTerminalText(userInfo().username).trim().slice(0, 48) || "朋友";
  } catch {
    return "朋友";
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
  private interruptArmedAt = 0;
  private readonly historyPath: string;
  private history: string[] = [];
  private processInterrupt: () => void;
  private sessionLock: FileLock | undefined;
  private readOnly = false;
  private mainPromptActive = false;
  private homeScreenPristine = true;
  /** True while a slash command or a turn is running (no prompt is waiting). */
  private commandBusy = false;

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
    this.historyPath = join(this.configStore.home, "history");
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
      history: {
        entries: this.history,
        append: (entry) => this.appendHistory(entry),
        // Recalling the command that just ended the session is never useful.
        accepts: (entry) => !/^\/(?:exit|quit)\b/iu.test(entry),
      },
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
          home: homedir(),
          model: this.session.model,
          version: VERSION,
          apiKeyConfigured: Boolean(runtime.apiKey),
          username: currentUsername(),
        }),
      );
    } else {
      this.line(this.theme.bold(`DeepSeek TUI v${VERSION}`));
      this.line(this.theme.muted(clipToWidth(`Unofficial community client · ${shortenPath(this.cwd, Math.max(8, this.terminalColumns() - 32), homedir())}`, this.terminalColumns())));
    }
    if (this.session.messages.length > 0) this.renderHistory(this.session);
    const columns = this.terminalColumns();
    this.line(this.theme.muted("─".repeat(columns)));
    this.line(
      clipToWidth(
        `${this.theme.blue("●")} ${this.theme.bold(this.session.model)} ${this.theme.muted(`· 思考强度 ${this.config.effort}`)} ${this.theme.muted(columns < 40 ? "· /help" : "· /help 查看命令")}`,
        columns,
      ),
    );
    if (columns >= 72) {
      this.line(this.theme.muted("⏎ 发送 · \\ 换行 · / 命令 · Tab 补全 · ↑ 历史 · Esc 中断 · Ctrl+C 退出"));
    } else if (columns >= 44) {
      this.line(this.theme.muted("⏎ 发送 · / 命令 · Tab 补全 · Esc 中断"));
    }
    if (!runtime.apiKey) {
      this.line(
        this.theme.yellow(
          columns < 48 ? "未配置 API Key · /login" : "尚未配置 API Key。输入 /login 可安全粘贴，或打开 DeepSeek 平台。",
        ),
      );
    }
    this.line();
  }

  /** Clears the viewport; `scrollback` also drops the terminal's history. */
  private clearScreen(scrollback = false): void {
    if (!this.output.isTTY) return;
    this.write(scrollback ? "\u001b[2J\u001b[3J\u001b[H" : "\u001b[2J\u001b[H");
  }

  private redrawHomeForResize(): void {
    if (!this.mainPromptActive || !this.homeScreenPristine || !this.session || this.controller) return;
    this.clearScreen();
    this.renderHome();
  }

  /**
   * Ctrl+C follows Claude Code: it aborts an in-flight generation, otherwise
   * it clears the line editor, and only a second press against an already
   * empty prompt exits. Ctrl+D (readline close) still exits immediately.
   */
  private handleInterrupt(): void {
    const now = Date.now();
    // Both readline and the process signal can deliver the same Ctrl+C.
    if (now - this.lastInterrupt < 80) return;
    this.lastInterrupt = now;
    if (this.controller) {
      this.controller.abort();
      return;
    }
    if (!this.input?.isPrompting()) {
      // A command is running (a DSH start can poll for 45s). Losing the whole
      // terminal to one impatient Ctrl+C is harsh, so honour the same
      // press-twice contract /help advertises for the prompt.
      if (this.commandBusy && now - this.interruptArmedAt > INTERRUPT_EXIT_WINDOW_MS) {
        this.interruptArmedAt = now;
        // Clear the spinner's line first so the notice is not overpainted.
        this.write(`\r\u001b[2K${this.theme.muted("命令执行中…再按一次 Ctrl+C 退出")}\n`);
        return;
      }
      this.quit();
      return;
    }
    if (this.input.currentLine().length > 0) {
      this.input.resetLine();
      this.interruptArmedAt = 0;
      return;
    }
    if (now - this.interruptArmedAt <= INTERRUPT_EXIT_WINDOW_MS) {
      this.quit();
      return;
    }
    this.interruptArmedAt = now;
    this.input.notice(this.theme.muted("再按一次 Ctrl+C 退出（或输入 /exit）"));
  }

  private quit(): void {
    this.exitRequested = true;
    this.input?.close();
  }

  private async loadHistory(): Promise<void> {
    try {
      const raw = await readFile(this.historyPath, "utf8");
      const entries = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      this.history.splice(0, this.history.length, ...entries.slice(-HISTORY_LIMIT));
    } catch {
      // A missing or unreadable history file simply means no recall.
    }
  }

  private appendHistory(entry: string): void {
    void (async () => {
      try {
        await ensurePrivateDirectory(this.configStore.home);
        await appendFile(this.historyPath, `${entry}\n`, { mode: 0o600 });
      } catch {
        // History is a convenience; never let it break the prompt.
      }
    })();
  }

  /** Keeps the on-disk history bounded, tolerating concurrent terminals. */
  private async trimHistory(): Promise<void> {
    try {
      const raw = await readFile(this.historyPath, "utf8");
      const entries = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (entries.length <= HISTORY_LIMIT) return;
      await writeFile(this.historyPath, `${entries.slice(-HISTORY_LIMIT).join("\n")}\n`, { mode: 0o600 });
    } catch {
      // Ignore: trimming is best-effort housekeeping.
    }
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
    await this.loadHistory();
    this.input = this.makeInput();
    process.on("SIGINT", this.processInterrupt);

    try {
      this.session = await this.initialSession();
      await this.lockSession(this.session);
      this.homeScreenPristine = this.session.messages.length === 0 && !this.readOnly;
      this.renderHome();

      while (!this.exitRequested) {
        this.mainPromptActive = true;
        const line = await this.input.next(this.theme.brightBlue("❯ "), {
          suggestions: true,
          continuation: this.theme.muted("… "),
        });
        this.mainPromptActive = false;
        if (line === undefined) break;
        this.interruptArmedAt = 0;
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.homeScreenPristine = false;
        const command = parseSlashCommand(line);
        this.commandBusy = true;
        try {
          if (command) await this.handleCommand(command.name, command.args, command.tokens);
          else await this.sendMessage(unescapePrompt(line));
        } catch (error) {
          // A failing command (unreadable file, full disk, offline DSH) must
          // never take the whole REPL down with it.
          if ((error as Error).name === "AbortError") this.line(this.theme.yellow("已取消。"));
          else this.line(this.theme.red(`出错了：${this.errorMessage(error)}`));
        } finally {
          this.commandBusy = false;
        }
      }
    } finally {
      this.mainPromptActive = false;
      this.commandBusy = false;
      if (this.session && this.session.messages.length > 0 && !this.readOnly) {
        await this.sessionStore.save(this.session);
      }
      await this.sessionLock?.release();
      await this.trimHistory();
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
      if (message.role === "system") {
        this.line(`\n${this.theme.muted(`◇ 摘要  ${oneLine(message.content, 160)}`)}`);
        continue;
      }
      if (message.role === "user") {
        this.line(`\n${this.theme.brightBlue("❯")} ${shortText(message.content, 400)}`);
        continue;
      }
      this.line(`\n${this.theme.blue("◆ DeepSeek")}`);
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

  /**
   * Takes exclusive control of the terminal while a generation is in flight:
   * Esc and Ctrl+C abort the current request, arrow keys are ignored, and
   * complete type-ahead lines are replayed as the next message after the
   * generation settles.
   */
  private beginGenerationGuard(): { detach: () => void } {
    this.input.suspendForMenu();
    const watcher = watchAbortKeys(this.inputStream, () => this.controller?.abort());
    return {
      detach: () => {
        const leftover = watcher.detach();
        this.input.resumeFromMenu();
        if (leftover) this.input.pushText(leftover);
      },
    };
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
          `${String(index + 1).padStart(2)}  ${formatTime(session.updatedAt)}  ${oneLine(session.title, 200)}`,
      ),
      footer: "↑/↓ 选择 · Enter 确认 · Esc 取消 · 数字跳转",
    });
    if (!result || result.kind !== "index") return undefined;
    return visible[result.index];
  }

  private async handleCommand(name: string, args: string, tokens: string[]): Promise<void> {
    switch (name) {
      case "help":
        this.line(commandHelp(this.theme));
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
        this.reportUnknownCommand(name);
    }
  }

  private reportUnknownCommand(name: string): void {
    this.line(this.theme.yellow(`未知命令：/${name}`));
    const near = closestCommands(name);
    if (near.length > 0) {
      this.line(this.theme.muted(`你是不是想输入：${near.join(" · ")}`));
      return;
    }
    if (name.includes("/") || name.includes("\\")) {
      this.line(this.theme.muted(`要把以 / 开头的路径当作普通消息发送，请改用 //${name}`));
      return;
    }
    this.line(this.theme.muted("输入 /help 查看全部命令。"));
  }

  private async changeModel(requested: string): Promise<void> {
    const words = requested.trim().split(/\s+/u).filter(Boolean);
    // Silently keeping only the first word turned `/model gpt 4` into a
    // switch to a model literally named "gpt"; say so instead.
    if (words.length > 1) {
      this.line(this.theme.yellow("用法：/model [模型 ID]。模型 ID 不能包含空格。"));
      return;
    }
    let model = words[0] ?? "";
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
        const balance = await this.withSpinner("正在查询余额", () =>
          getBalance({ apiKey: runtime.apiKey as string, baseUrl: runtime.baseUrl }),
        );
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
    this.clearScreen(true);
    this.renderHome();
    this.homeScreenPristine = !this.readOnly;
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
    await this.saveSession();
    this.line(
      this.readOnly
        ? `${this.theme.yellow("!")} 会话为只读，标题只在本次运行内生效：${this.session.title}`
        : `${this.theme.green("✓")} 会话已重命名为 ${this.session.title}`,
    );
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
    this.line(
      `${this.theme.green("✓")} 思考强度已设为 ${this.theme.bold(effort)} ${this.theme.muted(`· ${REASONING_EFFORT_LABELS[effort]}`)}`,
    );
  }

  /** /status — one aligned panel: model, session, credentials, DSH. */
  private async showStatus(): Promise<void> {
    if (!this.session) return;
    const runtime = this.configStore.runtime(this.config);
    const dshStatus = await this.dsh.status(this.config.dshPort);
    const estimated = estimateTokens(this.session.messages);
    const limit = this.config.contextLimitTokens;
    const percent = Number.isFinite(limit) && limit > 0 ? Math.min(100, (estimated / limit) * 100) : undefined;
    const usage = this.session.usage;
    const cacheTotal = usage.promptCacheHitTokens + usage.promptCacheMissTokens;
    const cacheNote =
      cacheTotal > 0
        ? `· 缓存命中 ${usage.promptCacheHitTokens.toLocaleString()} (${((usage.promptCacheHitTokens / cacheTotal) * 100).toFixed(1)}%)`
        : "· 暂无缓存数据";
    const contextPercent = percent === undefined ? "≈–%" : `≈${String(Math.round(percent))}%`;
    const fromEnvironment = Boolean(process.env.DEEPSEEK_API_KEY?.trim());
    const columns = this.terminalColumns();
    const rows: readonly (readonly [string, string])[] = [
      ["模型", `${this.theme.bold(this.session.model)} ${this.theme.muted(`· ${runtime.baseUrl}`)}`],
      [
        "思考",
        `${this.theme.bold(this.config.effort)} ${this.theme.muted(`· ${REASONING_EFFORT_LABELS[this.config.effort]} · 过程${this.config.showReasoning ? "显示" : "隐藏"}`)}`,
      ],
      [
        "上下文",
        `${contextPercent} ${renderPressureBar(this.theme, percent)} ${formatCompactTokens(estimated)}/${formatCompactTokens(limit)} ${this.theme.muted(`· ${this.session.messages.length} 条消息`)}`,
      ],
      [
        "累计",
        `${usage.totalTokens.toLocaleString()} tokens ${this.theme.muted(cacheNote)}`,
      ],
      ["速度", this.renderTpsLine()],
      [
        "会话",
        `${this.session.id.slice(0, 8)} ${this.theme.muted(`· ${oneLine(this.session.title, 200)}`)}${this.readOnly ? this.theme.yellow(" · 只读") : ""}`,
      ],
      ["凭据", `${maskApiKey(runtime.apiKey)}${fromEnvironment ? this.theme.muted(" · 来自环境变量") : ""}`],
      ["目录", shortenPath(this.cwd, Math.max(8, columns - 10), homedir())],
      ["DSH", formatDshStatus(dshStatus)],
    ];
    this.line(this.theme.bold("状态"));
    for (const [label, value] of rows) {
      this.line(clipToWidth(`  ${this.theme.muted(padToWidth(label, 6))}  ${value}`, columns));
    }
  }

  /** Compact one-line context HUD (model · pressure · access · reasoning · API). */
  private renderHud(): string {
    if (!this.session) return "";
    const runtime = this.configStore.runtime(this.config);
    return renderContextHud(
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
        home: homedir(),
      },
      { columns: this.terminalColumns() },
    );
  }

  private renderTpsLine(): string {
    if (!this.session) return "";
    const { lastTurnMs, lastCompletionTokens } = this.session;
    if (!lastTurnMs || lastCompletionTokens === undefined || lastCompletionTokens === 0) {
      return this.theme.muted("—（暂无最近一轮数据）");
    }
    const tps = lastCompletionTokens / DeepSeekTui.turnSeconds(lastTurnMs);
    const value = `${tps.toFixed(1)} tok/s（最近一轮）`;
    if (tps >= 50) return this.theme.green(value);
    if (tps >= 20) return this.theme.yellow(value);
    return this.theme.muted(value);
  }

  /** /context — per-message token audit plus segmented breakdown (dsh-TUI 借鉴). */
  private async showContext(): Promise<void> {
    if (!this.session) return;
    const messages = this.session.messages;
    const runtime = this.configStore.runtime(this.config);
    this.line(
      renderContextReport(
        this.theme,
        {
          model: this.session.model,
          estimatedTokens: estimateTokens(messages),
          limitTokens: this.config.contextLimitTokens,
          messageCount: messages.length,
          showReasoning: this.config.showReasoning,
          readOnly: this.readOnly,
          apiKeyConfigured: Boolean(runtime.apiKey),
          usage: this.session.usage,
          cwd: this.cwd,
          home: homedir(),
        },
        { columns: this.terminalColumns() },
      ),
    );
    if (messages.length === 0) return;
    this.line();
    this.line(this.theme.bold(`逐条明细（估算，共 ${messages.length} 条）`));
    const head = messages.length > 50 ? messages.slice(-50) : messages;
    if (messages.length > head.length) this.line(this.theme.muted(`… 已省略更早的 ${messages.length - head.length} 条`));
    const labels: Record<ChatMessage["role"], string> = { system: "系统", user: "用户", assistant: "助手" };
    head.forEach((message, index) => {
      const offset = messages.length - head.length + index + 1;
      const tokens = formatCompactTokens(estimateTokens([message]));
      this.line(
        clipToWidth(
          `  ${this.theme.blue(String(offset).padStart(3))}  ${this.theme.muted(labels[message.role])} ${this.theme.muted(tokens.padStart(6))}  ${oneLine(message.content, 200)}`,
          this.terminalColumns(),
        ),
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
    const request = this.requestMessages([
      ...this.session.messages,
      { role: "user", content: text, createdAt: new Date().toISOString() },
    ]);
    this.controller = new AbortController();
    const generationGuard = this.beginGenerationGuard();
    this.write(`\n${this.theme.muted("◇ 侧问（单轮，不写入会话）")}\n`);
    let content = "";
    let reasoning = "";
    let reasoningShown = false;
    let contentShown = false;
    const spinner = new Spinner(this.output, (frame, elapsedMs) =>
      this.generationStatus(frame, elapsedMs, reasoning, "侧问中"),
    );
    spinner.start();
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
          if (!this.config.showReasoning) {
            spinner.refresh();
            return;
          }
          if (!reasoningShown) {
            spinner.stop();
            reasoningShown = true;
          }
          this.write(this.theme.muted(safeTerminalText(delta)));
        },
        onContent: (delta) => {
          content += delta;
          if (!contentShown) {
            spinner.stop();
            if (reasoningShown) this.write("\n");
            contentShown = true;
          }
          this.write(safeTerminalText(delta));
        },
      });
      spinner.stop();
      if (!contentShown && !reasoningShown) this.write(this.theme.muted("(没有文本响应)"));
      this.write(
        `\n\n${this.theme.muted(`侧问结束 · ${result.usage.totalTokens.toLocaleString()} tokens（不计入会话）`)}\n\n`,
      );
    } catch (error) {
      spinner.stop();
      if ((error as Error).name === "AbortError") this.line(`\n${this.theme.yellow("已中断侧问。")}\n`);
      else this.line(`\n${this.theme.red(`侧问失败：${this.errorMessage(error)}`)}\n`);
    } finally {
      spinner.stop();
      generationGuard.detach();
      this.controller = undefined;
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
    const answer = await this.input.next(this.theme.brightBlue("确认压缩？压缩前会自动导出备份 [y/N] › "), {
      history: false,
    });
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
    const generationGuard = this.beginGenerationGuard();
    const spinner = new Spinner(this.output, (frame, elapsedMs) =>
      this.generationStatus(frame, elapsedMs, "", "正在压缩历史"),
    );
    this.write("\n");
    spinner.start();
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
      spinner.stop();
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
        `${this.theme.green("✓")} 已压缩为 1 条摘要消息：${formatCompactTokens(estimated)} → ${formatCompactTokens(after)} tokens`,
      );
      this.line(this.theme.muted("原历史已备份到 exports 目录，可用 /resume 参考此前会话。"));
      this.line(this.renderHud());
      this.line();
    } catch (error) {
      spinner.stop();
      if ((error as Error).name === "AbortError") this.line(`\n${this.theme.yellow("已中断压缩。")}\n`);
      else this.line(`\n${this.theme.red(`压缩失败：${this.errorMessage(error)}`)}\n`);
    } finally {
      spinner.stop();
      generationGuard.detach();
      this.controller = undefined;
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
    if (token !== undefined) {
      // `/rewind 3` must mean the same "3" the menu prints, so both number
      // user messages from the start of the session, and an out-of-range
      // number is reported instead of silently falling through to the menu.
      const requested = Number.parseInt(token, 10);
      if (!/^\d+$/u.test(token) || !Number.isInteger(requested) || requested < 1 || requested > indexes.length) {
        this.line(this.theme.yellow(`用法：/rewind [1-${indexes.length}]，或不带参数从列表中选择。`));
        return;
      }
      chosenIndex = indexes[requested - 1];
    } else {
      const windowIndexes = indexes.slice(-12);
      const offset = indexes.length - windowIndexes.length;
      const result = await this.runMenu({
        title:
          offset > 0
            ? `选择回退点（分支会话，原会话保留）· 仅显示最近 ${windowIndexes.length} 条，更早的用 /rewind <编号>`
            : "选择回退点（分支会话，原会话保留）",
        items: windowIndexes.map((index, position) => {
          const message = this.session?.messages[index];
          return `${String(offset + position + 1).padStart(2)}  ${oneLine(message?.content ?? "", 200)}`;
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
    const needle = query.trim();
    this.line(this.theme.bold(`会话内搜索「${needle}」（${hits.length} 处匹配）`));
    const columns = this.terminalColumns();
    for (const hit of hits) {
      const gutter = `  ${this.theme.blue(`#${String(hit.index + 1).padStart(3)}`)} ${this.theme.muted(labels[hit.role])} ${this.theme.muted(`L${String(hit.lineNumber).padStart(3)}`)}  `;
      const body = this.highlight(safeTerminalText(hit.line), needle);
      this.line(clipToWidth(`${gutter}${body}`, columns));
    }
  }

  /**
   * Marks every occurrence of `needle` in already-sanitized text. Matching is
   * case-insensitive on the same lowercasing `searchMessages` uses, so the
   * highlight always lands on the substring that produced the hit.
   */
  private highlight(text: string, needle: string): string {
    if (!needle) return text;
    const haystack = text.toLocaleLowerCase();
    const target = needle.toLocaleLowerCase();
    // Lowercasing can change length (e.g. İ); fall back rather than misalign.
    if (haystack.length !== text.length || target.length !== needle.length) return text;
    let result = "";
    let cursor = 0;
    for (let at = haystack.indexOf(target); at >= 0; at = haystack.indexOf(target, cursor)) {
      result += text.slice(cursor, at) + this.theme.bold(this.theme.brightBlue(text.slice(at, at + target.length)));
      cursor = at + target.length;
    }
    return result + text.slice(cursor);
  }

  private async handleDsh(tokens: string[]): Promise<void> {
    const first = tokens[0]?.toLocaleLowerCase();
    // `/dsh 3081` is a port, not an action.
    const action = first === undefined || /^\d+$/.test(first) ? "open" : first;
    const portToken = tokens.find((token) => /^\d+$/.test(token));
    const port = portToken ? Number.parseInt(portToken, 10) : this.config.dshPort;
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      this.line(this.theme.yellow("端口必须在 1 到 65535 之间。"));
      return;
    }
    try {
      if (action === "install") {
        // No spinner here: installDsh runs `npm install` synchronously with
        // inherited stdio, so npm paints its own progress on this terminal
        // and a spinner would both fail to animate and erase npm's last line.
        this.line(this.theme.muted("正在通过 npm 全局安装 DSH，请稍候（npm 的输出会直接显示）…"));
        const result = await installDsh();
        this.line(result.message);
        return;
      }
      if (action === "status") {
        this.line(formatDshStatus(await this.withSpinner("正在查询 DSH 状态", () => this.dsh.status(port))));
        return;
      }
      if (action === "stop") {
        this.line((await this.withSpinner("正在停止 DSH", () => this.dsh.stop())).message);
        return;
      }
      if (action === "logs") {
        const logs = await this.dsh.logs(80);
        this.line(logs ? safeTerminalText(logs) : this.theme.muted("暂无 DSH 日志。"));
        return;
      }
      if (action === "restart") {
        const status = await this.withSpinner("正在重启 DSH Web", async () => {
          await this.dsh.stop();
          return await this.dsh.start({ port, cwd: this.cwd });
        });
        this.line(formatDshStatus(status));
        await this.openAndReport(status.url, "DSH Web");
        return;
      }
      if (action !== "start" && action !== "open") {
        this.line(this.theme.yellow("用法：/dsh [install|start|open|status|stop|logs|restart] [端口]"));
        return;
      }
      const status = await this.withSpinner("正在启动/连接 DSH Web", () =>
        this.dsh.start({ port, cwd: this.cwd }),
      );
      this.line(formatDshStatus(status));
      if (status.phase === "running") await this.openAndReport(status.url, "DSH Web");
      else this.line(this.theme.muted(`仍在启动；日志位于 ${status.logFile ?? this.dsh.logPath}`));
    } catch (error) {
      this.line(this.theme.red(`DSH：${this.errorMessage(error)}`));
    }
  }

  /**
   * Runs a slow, non-streaming task behind the shared spinner. DSH start-up
   * polls the port for up to 45 seconds; without this the prompt just sat
   * there looking hung, with nothing to say the client was still working.
   */
  private async withSpinner<T>(label: string, task: () => Promise<T>): Promise<T> {
    const spinner = new Spinner(this.output, (frame, elapsedMs) =>
      clipToWidth(
        `${this.theme.blue(frame)} ${this.theme.muted(`${label}… (${String(Math.max(0, Math.round(elapsedMs / 1_000)))}s)`)}`,
        this.terminalColumns(),
      ),
    );
    spinner.start();
    try {
      return await task();
    } finally {
      spinner.stop();
    }
  }

  private async openAndReport(url: string, label: string): Promise<void> {
    const opened = await openUrl(url);
    this.line(opened ? `${this.theme.green("✓")} 已打开${label}` : `${label}：${url}`);
  }

  /**
   * Builds the message list for one request. History that no longer fits is
   * omitted from the request only — the stored session keeps every message so
   * /export, /rewind and /search still see the full conversation.
   */
  private requestMessages(messages: ChatMessage[]): ChatMessage[] {
    const limit = this.config.contextLimitTokens;
    const plan = planRequest(messages, limit);
    if (plan.dropped > 0) {
      this.line(
        this.theme.yellow(
          `上下文超限（估算 ${plan.estimated.toLocaleString()} > ${limit.toLocaleString()} tokens），本次请求省略最早的 ${plan.dropped} 条消息。`,
        ),
      );
      this.line(this.theme.muted("本地历史仍然完整；可用 /compact 压缩，或在 config.json 调高 contextLimitTokens。"));
    } else if (plan.nearLimit) {
      this.line(
        this.theme.yellow(
          `上下文较长（估算 ${plan.estimated.toLocaleString()} tokens，上限 ${limit.toLocaleString()}）。可用 /compact 压缩历史。`,
        ),
      );
    }
    return plan.messages;
  }

  /** Live status line shown while a request is in flight. */
  private generationStatus(frame: string, elapsedMs: number, reasoning: string, label: string): string {
    const parts = [`${String(Math.max(0, Math.round(elapsedMs / 1_000)))}s`];
    if (reasoning.length > 0) parts.push(`思考 ${formatCompactTokens(estimateTextTokens(reasoning))} tokens`);
    parts.push("esc 中断");
    return clipToWidth(
      `${this.theme.blue(frame)} ${this.theme.muted(`${label}… (${parts.join(" · ")})`)}`,
      this.terminalColumns(),
    );
  }

  /**
   * Throughput for one turn. Every readout goes through here — the turn
   * footer and /status used to divide by differently-floored durations and
   * quoted visibly different speeds for the same generation.
   */
  private static turnSeconds(elapsedMs: number): number {
    return Math.max(0.1, elapsedMs / 1_000);
  }

  /** Per-turn accounting line printed under a completed response. */
  private turnFooter(usage: TokenUsage, elapsedMs: number): string {
    const seconds = DeepSeekTui.turnSeconds(elapsedMs);
    const parts = [`${usage.promptTokens.toLocaleString()} in`, `${usage.completionTokens.toLocaleString()} out`];
    if (usage.reasoningTokens > 0) parts.push(`${usage.reasoningTokens.toLocaleString()} thinking`);
    if (usage.promptCacheHitTokens > 0) parts.push(`缓存 ${formatCompactTokens(usage.promptCacheHitTokens)}`);
    parts.push(`${seconds.toFixed(1)}s`);
    if (usage.completionTokens > 0) parts.push(`${(usage.completionTokens / seconds).toFixed(1)} tok/s`);
    return parts.join(" · ");
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
    const titleBefore = this.session.title;
    this.session.messages.push(userMessage);
    if (this.session.title === "New conversation") this.session.title = deriveTitle(text);
    await this.saveSession();

    const messages = this.requestMessages(this.session.messages);
    this.controller = new AbortController();
    const generationGuard = this.beginGenerationGuard();
    const startedAt = Date.now();
    let content = "";
    let reasoning = "";
    let reasoningShown = false;
    let contentShown = false;
    const spinner = new Spinner(this.output, (frame, elapsedMs) =>
      this.generationStatus(frame, elapsedMs, reasoning, "正在思考"),
    );
    this.write("\n");
    spinner.start();
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
          if (!this.config.showReasoning) {
            // Thinking stays hidden, but its size keeps the spinner honest.
            spinner.refresh();
            return;
          }
          if (!reasoningShown) {
            spinner.stop();
            this.write(`${this.theme.muted("╭─ 思考过程")}\n${this.theme.muted(safeTerminalText(delta))}`);
            reasoningShown = true;
          } else this.write(this.theme.muted(safeTerminalText(delta)));
        },
        onContent: (delta) => {
          content += delta;
          if (!contentShown) {
            spinner.stop();
            if (reasoningShown) this.write(`\n${this.theme.muted("╰─")}\n\n`);
            this.write(`${this.theme.blue("◆ DeepSeek")}\n`);
            contentShown = true;
          }
          this.write(safeTerminalText(delta));
        },
      });
      spinner.stop();
      if (!contentShown) {
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
      // One measurement for both readouts: taking it twice made the turn
      // footer and /status disagree by however long the session save took.
      const elapsedMs = Math.max(1, Date.now() - startedAt);
      this.session.lastTurnMs = elapsedMs;
      this.session.lastCompletionTokens = result.usage.completionTokens;
      await this.saveSession();
      this.write(`\n\n${this.theme.muted(this.turnFooter(result.usage, elapsedMs))}\n\n`);
    } catch (error) {
      spinner.stop();
      // Keep a partial answer, but never store an assistant turn with empty
      // content: the API rejects it on the next request.
      if (content.trim()) {
        const partial: ChatMessage = { role: "assistant", content, createdAt: new Date().toISOString() };
        if (reasoning) partial.reasoningContent = reasoning;
        this.session.messages.push(partial);
        await this.saveSession();
      } else if (this.session.messages[this.session.messages.length - 1] === userMessage) {
        // Nothing came back, so the prompt would otherwise be stranded as a
        // trailing user turn — which both pollutes the transcript and leaves
        // two user messages in a row on the next request. Drop it; the line
        // is still in the input history, so ↑ brings it straight back.
        this.session.messages.pop();
        if (this.session.messages.length === 0) this.session.title = titleBefore;
        await this.saveSession();
        this.line(`\n${this.theme.muted("本轮未记录到会话（按 ↑ 可召回刚才的输入）。")}`);
      }
      if ((error as Error).name === "AbortError") this.line(`\n${this.theme.yellow("已中断本次生成。")}\n`);
      else this.line(`\n${this.theme.red(`请求失败：${this.errorMessage(error)}`)}\n`);
    } finally {
      spinner.stop();
      generationGuard.detach();
      this.controller = undefined;
    }
  }

  private errorMessage(error: unknown): string {
    if (error instanceof DeepSeekApiError) return `${error.message}${error.status ? ` (${error.status})` : ""}`;
    if (error instanceof Error) return error.message;
    return String(error);
  }
}
