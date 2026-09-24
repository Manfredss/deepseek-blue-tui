import { homedir, userInfo } from "node:os";
import { isAbsolute, join, relative as relativePath } from "node:path";
import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import type { AppConfig, ChatMessage, ReasoningEffort, Session, TokenUsage } from "./types.js";
import { EMPTY_USAGE, REASONING_EFFORT_LABELS, REASONING_EFFORTS, RECOMMENDED_MODELS } from "./types.js";
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
  expandUserPath,
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
  splitIndexedArgument,
  parseSlashCommand,
  renderSlashCommandMenu,
  slashCommandSuggestions,
  unescapePrompt,
} from "./commands.js";
import { colorEnabled, createTheme, type Theme } from "./theme.js";
import { renderWelcomeScreen } from "./logo.js";
import { LineInput, promptSecret, MenuPicker, watchAbortKeys, type MenuPickerOptions, type MenuPickerResult } from "./input.js";
import { DeepSeekApiError, getBalance, isOfficialEndpoint, prefixBaseUrl, streamChat } from "./api.js";
import { applyPrefill, planPrefill, type PrefillPlan } from "./prefill.js";
import {
  classifyQuestion,
  parseRaceArgs,
  QUESTION_KIND_LABELS,
  RaceLedger,
  recommendEffort,
  summarize,
  type RaceBranch,
  type RaceBranchRecord,
  type RaceRecord,
} from "./race.js";
import { DEEPSEEK_URLS, openUrl } from "./open-url.js";
import { DshManager, formatDshStatus, installDsh } from "./dsh.js";
import { LockHeldError } from "./fs-utils.js";
import { renderContextHud, renderContextReport, renderPressureBar } from "./context-view.js";
import { Spinner } from "./spinner.js";
import {
  extractCodeBlocks,
  isOutputBlock,
  MarkdownStream,
  renderMarkdown,
  renderMarkdownWithBlocks,
  type CodeBlock,
} from "./markdown.js";
import { clipboardCommand, osc52, OSC52_MAX_BYTES, writeClipboard } from "./clipboard.js";
import { diffLines, looksLikeEdit, renderDiff, summarizeDiff } from "./diff.js";
import { cacheReport, estimateCost, formatCost, prefixLoss, pricingFor, type ModelPricing } from "./pricing.js";
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

/** Everything a request needs from the resolved runtime config. */
interface Credentials {
  apiKey: string;
  baseUrl: string;
}

interface AssistantTurnOptions {
  credentials: Credentials;
  model: string;
  messages: ChatMessage[];
  effort: ReasoningEffort;
  /** Finish the trailing assistant message rather than reply after it. */
  prefixContinuation?: boolean;
  /** Answer text already decided: a prefill, or the half already generated. */
  echo?: string;
  stop?: string[];
  /** Spinner verb; defaults to 正在思考. */
  label?: string;
  /** First code-block number this answer may use. */
  numberFrom: number;
}

interface AssistantTurn {
  /** What the model returned this time; excludes any `echo`. */
  content: string;
  reasoning: string;
  usage: TokenUsage;
  elapsedMs: number;
  /** Code blocks this answer drew, including any that came from an `echo`. */
  blocks: readonly CodeBlock[];
  /** Whether the `echo` was actually redrawn; false when nothing streamed. */
  echoed: boolean;
  /** Set when the stream failed or was interrupted; `content` may be partial. */
  error?: unknown;
}

/** A code block plus which answer it came from, so siblings can be named. */
interface SessionBlock extends CodeBlock {
  answer: number;
}

/** One branch of a `/race`: its answer and what it cost to get it. */
interface RaceEntry {
  branch: RaceBranch;
  content: string;
  reasoning: string;
  usage: TokenUsage;
  elapsedMs: number;
  error?: string;
}

/** Fisher–Yates, so a blind comparison cannot be read off the row order. */
function shuffledIndexes(count: number): number[] {
  const indexes = Array.from({ length: count }, (_value, index) => index);
  for (let index = indexes.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [indexes[index], indexes[swap]] = [indexes[swap] as number, indexes[index] as number];
  }
  return indexes;
}

/** How many attached files stay diffable; older ones are forgotten. */
const ATTACHMENT_MEMORY = 8;

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const HISTORY_LIMIT = 500;
/** Window in which a second Ctrl+C at an empty prompt means "quit". */
const INTERRUPT_EXIT_WINDOW_MS = 3_000;
/** Shown when /do cannot find a DSH to delegate to. */
const DSH_NOT_FOUND_HINT =
  "未找到 DSH，无法执行任务。输入 /dsh install 安装，或用 DEEPSEEK_DSH_COMMAND 指向已有的 dsh。";

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
  /** Every `/race` the user has judged; the evidence behind `/effort auto`. */
  private readonly races: RaceLedger;
  private raceRecords: RaceRecord[] | undefined;
  private autoEffortNoted = false;
  private processInterrupt: () => void;
  private sessionLock: FileLock | undefined;
  private readOnly = false;
  private mainPromptActive = false;
  private homeScreenPristine = true;
  /** Text the next answer must start with; consumed by the next turn. */
  private prefill: PrefillPlan | undefined;
  /** Code blocks drawn in this session, numbered so `/copy 2` can name one. */
  private codeBlocks: SessionBlock[] = [];
  /** Counts answers, so blocks from one reply can be told from another's. */
  private answers = 0;
  /** Files `/attach` has read, kept so an edited version can be diffed. */
  private readonly attachments = new Map<string, string>();
  /** True while a slash command or a turn is running (no prompt is waiting). */
  private commandBusy = false;
  /**
   * Last known account balance, and what it cost to learn it. Refreshed after
   * a turn rather than before, so it never delays a reply; between refreshes
   * the estimated spend is subtracted locally so the figure keeps moving.
   */
  private balance: { currency: string; total: number; fetchedAt: number; estimated: boolean } | undefined;
  private balanceFailed = false;

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
    this.races = new RaceLedger(join(this.configStore.home, "races.jsonl"));
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
      this.refreshBalance();
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
    // Numbering is rebuilt from the *full* answers, not from the shortened
    // preview below: /copy must hand back the code that was written, not the
    // part of it that happened to fit on screen.
    this.codeBlocks = [];
    this.answers = 0;
    for (const message of session.messages) {
      if (message.role !== "assistant") continue;
      const blocks = extractCodeBlocks(message.content, this.codeBlocks.length + 1);
      if (blocks.length > 0) this.fileBlocks(blocks);
    }
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
      this.line(renderMarkdown(shortText(message.content), this.theme));
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
    let detached = false;
    return {
      detach: () => {
        // Callers detach early (before opening a picker) and again in their
        // finally; resuming twice would rebuild the line editor twice.
        if (detached) return;
        detached = true;
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
      case "cache":
        this.showCache();
        break;
      case "btw":
        await this.sideQuestion(args);
        break;
      case "continue":
        await this.continueAnswer();
        break;
      case "prefill":
        this.prefillNext(args);
        break;
      case "race":
        await this.raceEfforts(args);
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
      case "copy":
        await this.copyCodeBlock(tokens[0]);
        break;
      case "save":
        await this.saveCodeBlock(args);
        break;
      case "diff":
        this.showDiff(args);
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
      case "do":
      case "agent":
        await this.delegateToAgent(args);
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
    // A different model has a different cache, so the prefix is lost too.
    if (this.session && model !== this.session.model && !(await this.confirmPrefixLoss("切换模型"))) return;
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
    this.codeBlocks = [];
    this.answers = 0;
    this.prefill = undefined;
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
    if (this.codeBlocks.length > 0) {
      this.line(this.theme.muted(`（历史里有 ${this.codeBlocks.length} 个代码块，/copy 或 /save 可直接取用）`));
    }
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

  /** /effort — DeepSeek V4 thinking effort (low/high/max, or auto), with a menu. */
  private async changeEffort(requested: string | undefined): Promise<void> {
    const normalized = requested?.trim().toLocaleLowerCase();
    const AUTO = "auto";
    let effort: ReasoningEffort | undefined;
    if (normalized === AUTO) {
      await this.enableAutoEffort();
      return;
    }
    if (normalized && (REASONING_EFFORTS as readonly string[]).includes(normalized)) {
      effort = normalized as ReasoningEffort;
    } else if (normalized) {
      this.line(this.theme.yellow("用法：/effort [low|high|max|auto]。medium 在 DeepSeek V4 上会映射为 high。"));
      return;
    } else {
      const result = await this.runMenu({
        title: "选择思考强度",
        items: [
          ...REASONING_EFFORTS.map(
            (level) =>
              `${level.padEnd(4)} ${REASONING_EFFORT_LABELS[level]}${!this.config.effortAuto && this.config.effort === level ? " ✓" : ""}`,
          ),
          `${AUTO.padEnd(4)} 按 /race 对比过的结果自动选档${this.config.effortAuto ? " ✓" : ""}`,
        ],
        footer: "↑/↓ 选择 · Enter 确认 · Esc 取消 · 数字跳转",
      });
      if (!result || result.kind !== "index") return;
      if (result.index >= REASONING_EFFORTS.length) {
        await this.enableAutoEffort();
        return;
      }
      effort = REASONING_EFFORTS[result.index];
    }
    if (!effort) return;
    this.config.effort = effort;
    this.config.effortAuto = false;
    await this.configStore.save(this.config);
    this.line(
      `${this.theme.green("✓")} 思考强度已设为 ${this.theme.bold(effort)} ${this.theme.muted(`· ${REASONING_EFFORT_LABELS[effort]}`)}`,
    );
  }

  /**
   * Hands the effort knob to the ledger `/race` has been filling. The
   * configured level stays as the fallback for questions the records have
   * nothing to say about.
   */
  private async enableAutoEffort(): Promise<void> {
    this.config.effortAuto = true;
    await this.configStore.save(this.config);
    const records = await this.raceHistory();
    this.line(
      `${this.theme.green("✓")} 思考强度已设为 ${this.theme.bold("auto")} ${this.theme.muted(`· 按 /race 的对比结果选档，没有依据时用 ${this.config.effort}`)}`,
    );
    if (records.length === 0) {
      this.line(this.theme.muted("目前还没有对比记录：先跑几次 /race low max <问题>，auto 才有依据。"));
      return;
    }
    this.line(this.theme.muted(`已有 ${records.length} 次对比记录 · /race stats 查看`));
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
        `${this.theme.bold(this.config.effortAuto ? "auto" : this.config.effort)} ${this.theme.muted(
          `· ${
            this.config.effortAuto
              ? `按 /race 账本选档，无依据时 ${this.config.effort}`
              : REASONING_EFFORT_LABELS[this.config.effort]
          } · 过程${this.config.showReasoning ? "显示" : "隐藏"}`,
        )}`,
      ],
      ...(this.prefill
        ? ([["前缀", `${oneLine(this.prefill.label, 60)} ${this.theme.muted("· 仅下一条回答")}`]] as const)
        : []),
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
      [
        "余额",
        this.balanceLabel() ??
          (this.balanceFailed ? this.theme.yellow("暂时无法查询") : this.theme.muted("查询中…")),
      ],
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
    const markdown = new MarkdownStream({ theme: this.theme });
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
          this.write(markdown.write(delta));
        },
      });
      spinner.stop();
      this.write(markdown.end());
      if (!contentShown && !reasoningShown) this.write(this.theme.muted("(没有文本响应)"));
      this.write(
        `\n\n${this.theme.muted(`侧问结束 · ${result.usage.totalTokens.toLocaleString()} tokens（不计入会话）`)}\n\n`,
      );
    } catch (error) {
      spinner.stop();
      this.write(markdown.end());
      if ((error as Error).name === "AbortError") this.line(`\n${this.theme.yellow("已中断侧问。")}\n`);
      else this.line(`\n${this.theme.red(`侧问失败：${this.errorMessage(error)}`)}\n`);
    } finally {
      spinner.stop();
      generationGuard.detach();
      this.controller = undefined;
    }
  }

  /**
   * /race — ask the same question at several thinking efforts at once, then
   * keep one answer.
   *
   * DeepSeek V4's effort knob has no published guidance on when `max` earns
   * its latency, and this client already measures tokens, time and cost
   * exactly — so the honest way to answer "is it worth it *for my questions*"
   * is to run them side by side and look at the numbers.
   */
  private async raceEfforts(args: string): Promise<void> {
    if (!this.session) return;
    const parsed = parseRaceArgs(args, { model: this.session.model, effort: this.config.effort });
    if (parsed.stats) {
      await this.showRaceStats();
      return;
    }
    if (parsed.branches.length === 1) {
      this.line(this.theme.yellow("至少要两个档位才能对比，例如 /race low max 你的问题"));
      return;
    }
    const model = this.session.model;
    const branches: RaceBranch[] =
      parsed.branches.length >= 2
        ? parsed.branches
        : REASONING_EFFORTS.map((effort) => ({ model, effort, label: effort }));
    // The question can also just be the last thing already asked.
    const question = parsed.question.trim() || this.lastUserMessage();
    if (!question) {
      this.line(this.theme.yellow("用法：/race [low high max | pro@max] [--blind] <问题>。不带问题时复用上一条用户消息。"));
      return;
    }
    const credentials = this.requireCredentials();
    if (!credentials) return;

    const request = this.requestMessages([
      ...this.session.messages,
      { role: "user", content: question, createdAt: new Date().toISOString() },
    ]);
    this.line(
      this.theme.bold(
        parsed.blind
          ? `并行对比 ${branches.length} 个分支（盲测：选完才揭晓）`
          : `并行对比 ${branches.map((branch) => branch.label).join(" / ")}`,
      ),
    );
    this.line(this.theme.muted(`  ${oneLine(question, 200)}`));

    const controller = new AbortController();
    this.controller = controller;
    const generationGuard = this.beginGenerationGuard();
    let done = 0;
    const spinner = new Spinner(this.output, (frame, elapsedMs) =>
      clipToWidth(
        `${this.theme.blue(frame)} ${this.theme.muted(`并行生成中… (${String(Math.max(0, Math.round(elapsedMs / 1_000)))}s · 已完成 ${done}/${branches.length} · esc 中断)`)}`,
        this.terminalColumns(),
      ),
    );
    this.write("\n");
    spinner.start();

    try {
      const results = await Promise.all(
        branches.map(async (branch): Promise<RaceEntry> => {
          const startedAt = Date.now();
          try {
            const result = await streamChat({
              apiKey: credentials.apiKey,
              baseUrl: credentials.baseUrl,
              model: branch.model,
              messages: request,
              effort: branch.effort,
              signal: controller.signal,
            });
            done += 1;
            spinner.refresh();
            return {
              branch,
              content: result.content,
              reasoning: result.reasoningContent,
              usage: result.usage,
              elapsedMs: Math.max(1, Date.now() - startedAt),
            };
          } catch (error) {
            done += 1;
            spinner.refresh();
            return {
              branch,
              content: "",
              reasoning: "",
              usage: { ...EMPTY_USAGE },
              elapsedMs: Math.max(1, Date.now() - startedAt),
              error: this.errorMessage(error),
            };
          }
        }),
      );
      spinner.stop();
      // Generation is over, so hand the terminal back before the picker opens:
      // the abort watcher would otherwise race the picker for the same keys and
      // replay them as type-ahead afterwards.
      generationGuard.detach();
      this.controller = undefined;

      // Blind mode also shuffles: with the rows in the order they were asked
      // for, "the slow expensive one" is still the last line every time.
      const order = parsed.blind ? shuffledIndexes(results.length) : results.map((_, index) => index);
      const named = order.flatMap((index, position) => {
        const entry = results[index];
        if (!entry) return [];
        return [{ entry, name: parsed.blind ? String.fromCodePoint(65 + position) : entry.branch.label }];
      });
      const priced = (entry: RaceEntry): ModelPricing | undefined =>
        pricingFor(entry.branch.model, this.config.pricing);
      const anyPriced = named.some(({ entry }) => priced(entry) !== undefined);
      const nameWidth = Math.max(6, ...named.map(({ name }) => name.length + 2));

      const columns = this.terminalColumns();
      this.line(this.theme.bold("对比"));
      this.line(
        this.theme.muted(
          `  ${padToWidth(parsed.blind ? "分支" : "档位", nameWidth)}${padToWidth("耗时", 9)}${padToWidth("输出", 8)}${padToWidth("思考", 8)}${anyPriced ? padToWidth("花费", 10) : ""}摘要`,
        ),
      );
      for (const { entry, name } of named) {
        if (entry.error) {
          this.line(`  ${this.theme.bold(padToWidth(name, nameWidth))}${this.theme.red(`失败：${entry.error}`)}`);
          continue;
        }
        const rates = priced(entry);
        const cost = anyPriced ? padToWidth(rates ? `≈${formatCost(estimateCost(entry.usage, rates))}` : "—", 10) : "";
        this.line(
          clipToWidth(
            `  ${this.theme.bold(padToWidth(name, nameWidth))}${padToWidth(`${(entry.elapsedMs / 1_000).toFixed(1)}s`, 9)}${padToWidth(formatCompactTokens(entry.usage.completionTokens), 8)}${padToWidth(formatCompactTokens(entry.usage.reasoningTokens), 8)}${cost}${this.theme.muted(oneLine(entry.content, 200))}`,
            columns,
          ),
        );
      }

      const usable = named.filter(({ entry }) => !entry.error && entry.content.trim());
      if (usable.length === 0) {
        this.line(this.theme.yellow("没有可用的回答，会话未改变。"));
        return;
      }
      this.line();
      const choice = await this.runMenu({
        title: "查看并保留哪一个？（其余丢弃，不写入会话）",
        items: usable.map(
          ({ entry, name }) =>
            `${name.padEnd(6)} ${(entry.elapsedMs / 1_000).toFixed(1)}s  ${oneLine(entry.content, 160)}`,
        ),
        footer: "↑/↓ 选择 · Enter 保留 · Esc 全部丢弃 · 数字跳转",
      });
      if (!choice || choice.kind !== "index") {
        this.line(this.theme.muted("已全部丢弃，会话未改变。"));
        return;
      }
      const picked = usable[choice.index];
      if (!picked) return;
      const kept = picked.entry;
      if (parsed.blind) {
        this.line(`${this.theme.muted("揭晓：")}${this.theme.bold(picked.name)} = ${this.theme.bold(kept.branch.label)}`);
      }

      this.write(`\n${this.theme.blue(`◆ DeepSeek (${kept.branch.label})`)}\n`);
      this.line(this.renderAnswer(kept.content));

      const now = new Date().toISOString();
      this.session.messages.push({ role: "user", content: question, createdAt: now });
      const assistant: ChatMessage = { role: "assistant", content: kept.content, createdAt: new Date().toISOString() };
      if (kept.reasoning) assistant.reasoningContent = kept.reasoning;
      this.session.messages.push(assistant);
      // Every branch was billed, so charge the session for all of them.
      for (const entry of results) this.session.usage = addUsage(this.session.usage, entry.usage);
      this.session.lastTurnMs = kept.elapsedMs;
      this.session.lastCompletionTokens = kept.usage.completionTokens;
      if (this.session.title === "New conversation") this.session.title = deriveTitle(question);
      await this.saveSession();
      this.write(`\n${this.theme.muted(`已保留 ${kept.branch.label} 的回答 · ${this.turnFooter(kept.usage, kept.elapsedMs)}`)}\n`);
      this.line(this.theme.muted(`（其余 ${results.length - 1} 个分支同样计费，已计入会话累计）`));
      await this.recordRace(question, results.map((entry) => ({ entry, chosen: entry === kept })));
      this.line();
    } catch (error) {
      spinner.stop();
      if ((error as Error).name === "AbortError") this.line(`\n${this.theme.yellow("已中断对比。")}\n`);
      else this.line(`\n${this.theme.red(`对比失败：${this.errorMessage(error)}`)}\n`);
    } finally {
      spinner.stop();
      generationGuard.detach();
      this.controller = undefined;
    }
  }

  /**
   * Files a judged race. That pick is the only labelled data this client can
   * collect — "for this kind of question, that effort was worth its price" —
   * but writing it must never cost the user the answer they just chose.
   */
  private async recordRace(question: string, entries: { entry: RaceEntry; chosen: boolean }[]): Promise<void> {
    const shape = classifyQuestion(question);
    const record: RaceRecord = {
      version: 1,
      at: new Date().toISOString(),
      kind: shape.kind,
      size: shape.size,
      branches: entries.map(({ entry, chosen }): RaceBranchRecord => {
        const rates = pricingFor(entry.branch.model, this.config.pricing);
        return {
          model: entry.branch.model,
          effort: entry.branch.effort,
          ms: entry.elapsedMs,
          outputTokens: entry.usage.completionTokens,
          reasoningTokens: entry.usage.reasoningTokens,
          ...(rates && !entry.error ? { cost: estimateCost(entry.usage, rates) } : {}),
          ...(chosen ? { chosen: true } : {}),
          ...(entry.error ? { failed: true } : {}),
        };
      }),
    };
    // Read before writing: loading afterwards would see the appended line and
    // then count it twice.
    const history = await this.raceHistory();
    try {
      await this.races.append(record);
    } catch {
      return;
    }
    history.push(record);
    const seen = history.filter((item) => item.kind === record.kind).length;
    const hint = this.config.effortAuto ? "auto 会用上它" : "/effort auto 可按它自动选档";
    this.line(this.theme.muted(`已记入对比账本（${QUESTION_KIND_LABELS[record.kind]} · 第 ${seen} 次）；${hint}。`));
  }

  /** /race stats — what the ledger has learned so far. */
  private async showRaceStats(): Promise<void> {
    const records = await this.raceHistory();
    if (records.length === 0) {
      this.line(this.theme.yellow("还没有对比记录。跑几次 /race low max <问题>，账本才会开始积累。"));
      return;
    }
    const columns = this.terminalColumns();
    this.line(this.theme.bold(`对比账本 · ${records.length} 次`));
    this.line(
      this.theme.muted(
        `  ${padToWidth("类型", 10)}${padToWidth("次数", 6)}${REASONING_EFFORTS.map((effort) => padToWidth(effort, 10)).join("")}`,
      ),
    );
    for (const summary of summarize(records)) {
      const cells = REASONING_EFFORTS.map((effort) =>
        padToWidth(
          summary.appearances[effort] === 0 ? "—" : `${summary.wins[effort]}/${summary.appearances[effort]}`,
          10,
        ),
      ).join("");
      this.line(
        clipToWidth(
          `  ${padToWidth(QUESTION_KIND_LABELS[summary.kind], 10)}${padToWidth(String(summary.races), 6)}${cells}`,
          columns,
        ),
      );
    }
    this.line(this.theme.muted("  单元格是「胜出 / 参与」，胜出即对比后你保留的那个分支。"));
    this.line(
      this.theme.muted(
        `  ${this.config.effortAuto ? "/effort auto 正在使用这份账本" : "/effort auto 可按它自动选档"} · ${this.races.path}`,
      ),
    );
  }

  /** The race ledger, read once per session and kept in step with new races. */
  private async raceHistory(): Promise<RaceRecord[]> {
    if (!this.raceRecords) this.raceRecords = await this.races.load();
    return this.raceRecords;
  }

  /**
   * The effort one turn should use. With auto on, the ledger decides and says
   * why; a question the records cannot speak to keeps the configured level.
   */
  private async effortFor(question: string): Promise<ReasoningEffort> {
    if (!this.config.effortAuto) return this.config.effort;
    const shape = classifyQuestion(question);
    const advice = recommendEffort(await this.raceHistory(), shape, this.config.effort);
    if (!advice) {
      if (!this.autoEffortNoted) {
        this.autoEffortNoted = true;
        this.line(this.theme.muted(`自动选档暂无依据，本轮按 ${this.config.effort}（/race 会积累依据）。`));
      }
      return this.config.effort;
    }
    const scope = advice.scope === "all" ? "各类" : QUESTION_KIND_LABELS[shape.kind];
    const saved = advice.saved === undefined ? "" : ` · 省 ≈${formatCost(advice.saved)}`;
    this.line(
      this.theme.muted(
        `自动选档：${scope}问题你对比过 ${advice.samples} 次，${advice.effort} 赢了 ${advice.wins} 次 → 本轮用 ${advice.effort}${saved}`,
      ),
    );
    return advice.effort;
  }

  private lastUserMessage(): string {
    if (!this.session) return "";
    for (let index = this.session.messages.length - 1; index >= 0; index -= 1) {
      const message = this.session.messages[index];
      if (message?.role === "user") return message.content;
    }
    return "";
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
    if (!(await this.confirmPrefixLoss("压缩"))) return;
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
    this.line(this.theme.muted(`@${this.shortPath(result.path ?? "")}`));
    // Remembered so a rewritten version coming back can be shown as a diff
    // rather than as a wall of mostly-identical code.
    if (result.path !== undefined && result.content !== undefined) {
      this.attachments.delete(result.path);
      this.attachments.set(result.path, result.content);
      while (this.attachments.size > ATTACHMENT_MEMORY) {
        const oldest = this.attachments.keys().next();
        if (oldest.done) break;
        this.attachments.delete(oldest.value);
      }
    }
    await this.sendMessage(attachmentMessage(result.path ?? "", result.content ?? ""));
  }

  /**
   * A path short enough to read and still valid as a command argument:
   * relative to the working directory when it lives there, `~`-prefixed when
   * it lives under home, absolute otherwise. Printing the absolute path of a
   * deeply nested file twice in one hint pushes everything else off the line.
   */
  private shortPath(path: string): string {
    const nearby = relativePath(this.cwd, path);
    if (nearby && !nearby.startsWith("..") && !isAbsolute(nearby)) return nearby;
    const home = homedir();
    if (path === home) return "~";
    if (path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
    return path;
  }

  /** Renders a finished answer and files whatever code blocks it framed. */
  private renderAnswer(text: string): string {
    const rendered = renderMarkdownWithBlocks(text, this.theme, this.codeBlocks.length + 1);
    this.fileBlocks(rendered.blocks);
    return rendered.text;
  }

  /** Files an answer's blocks under one answer id. */
  private fileBlocks(blocks: readonly CodeBlock[], answer = (this.answers += 1)): void {
    this.codeBlocks.push(...blocks.map((block) => ({ ...block, answer })));
  }

  /**
   * The block a command means: an explicit number, or the most recent one.
   * Prints the menu of what is available when the argument makes no sense,
   * which is also how numbers are discovered after a session is resumed.
   */
  private pickCodeBlock(token: string | undefined): SessionBlock | undefined {
    if (this.codeBlocks.length === 0) {
      this.line(this.theme.yellow("当前会话还没有出现代码块。"));
      return undefined;
    }
    if (token === undefined) return this.defaultCodeBlock();
    const index = Number.parseInt(token, 10);
    const block = this.codeBlocks.find((candidate) => candidate.index === index);
    if (block) return block;
    this.line(this.theme.yellow(`没有编号为 ${token} 的代码块。当前可用：`));
    for (const candidate of this.codeBlocks.slice(-10)) {
      this.line(
        this.theme.muted(
          `  [${candidate.index}] ${candidate.language || "code"} · ${candidate.code.split("\n").length} 行`,
        ),
      );
    }
    return undefined;
  }

  private static describeBlock(block: CodeBlock): string {
    return `[${block.index}] ${block.language || "code"} · ${block.code.split("\n").length} 行`;
  }

  /**
   * What `/copy` means with no number.
   *
   * Not simply the last block: an answer routinely ends with the output its
   * code produced, so "the last one" is reliably the one nobody wanted. The
   * source in the answer you are looking at is what was meant — falling back
   * to the last source anywhere, and only then to the last block at all.
   */
  private defaultCodeBlock(): SessionBlock | undefined {
    const latest = this.codeBlocks[this.codeBlocks.length - 1]?.answer;
    const fromLatest = this.codeBlocks.filter((block) => block.answer === latest);
    return DeepSeekTui.preferSource(fromLatest) ?? DeepSeekTui.preferSource(this.codeBlocks);
  }

  /** The last source block of a group, or its last block when all are output. */
  private static preferSource(blocks: readonly SessionBlock[]): SessionBlock | undefined {
    return [...blocks].reverse().find((block) => !isOutputBlock(block)) ?? blocks[blocks.length - 1];
  }

  /**
   * Names the other blocks of the same answer after an implicit pick, so a
   * guess that went the wrong way is one keystroke from being corrected.
   */
  private noteOtherBlocks(block: SessionBlock): void {
    const siblings = this.codeBlocks.filter(
      (candidate) => candidate.answer === block.answer && candidate.index !== block.index,
    );
    if (siblings.length === 0) return;
    const listed = siblings.map((sibling) => DeepSeekTui.describeBlock(sibling)).join(" · ");
    this.line(this.theme.muted(`  同一条回答还有 ${listed}——加编号即可，如 /copy ${String(siblings[0]?.index ?? 1)}`));
  }

  /**
   * /copy — put a code block on the clipboard.
   *
   * Falls back to OSC 52, which asks the terminal to do it: over SSH the
   * machine running this client has the wrong clipboard, and that is exactly
   * when copying by hand is most painful.
   */
  private async copyCodeBlock(token: string | undefined): Promise<void> {
    const block = this.pickCodeBlock(token);
    if (!block) return;
    const target = clipboardCommand();
    if (target) {
      try {
        await writeClipboard(block.code, target);
        this.line(`${this.theme.green("✓")} 已复制 ${DeepSeekTui.describeBlock(block)} ${this.theme.muted(`· ${target.label}`)}`);
        if (token === undefined) this.noteOtherBlocks(block);
        return;
      } catch (error) {
        this.line(this.theme.yellow(`${target.label} 复制失败：${this.errorMessage(error)}`));
      }
    }
    const bytes = Buffer.byteLength(block.code, "utf8");
    if (bytes > OSC52_MAX_BYTES) {
      this.line(this.theme.yellow(`代码块过大（${String(bytes)} 字节），改用 /save ${String(block.index)} <路径> 写入文件。`));
      return;
    }
    this.write(osc52(block.code));
    this.line(`${this.theme.green("✓")} 已通过 OSC 52 把 ${DeepSeekTui.describeBlock(block)} 交给终端`);
    this.line(this.theme.muted("（终端未开启剪贴板写入时这一步会被静默忽略，此时请用 /save）"));
  }

  /** /save — write a code block to a file, on an explicit path only. */
  private async saveCodeBlock(args: string): Promise<void> {
    const { index, rest } = splitIndexedArgument(args);
    if (!rest) {
      this.line(this.theme.yellow("用法：/save [编号] <路径>。不写编号就用这条回答里的源码块。"));
      return;
    }
    const block = this.pickCodeBlock(index);
    if (!block) return;
    const path = expandUserPath(rest, this.cwd);
    if (await fileExists(path)) {
      this.line(this.theme.yellow(`${path} 已存在，将被覆盖。`));
      const answer = await this.input.next(this.theme.brightBlue("继续？[y/N] › "), { history: false });
      if (answer?.trim().toLocaleLowerCase() !== "y") {
        this.line(this.theme.muted("已取消。"));
        return;
      }
    }
    try {
      // A trailing newline: every other tool in the terminal expects one.
      await writeFile(path, block.code.endsWith("\n") ? block.code : `${block.code}\n`, "utf8");
      this.line(`${this.theme.green("✓")} 已写入 ${path} ${this.theme.muted(`· ${DeepSeekTui.describeBlock(block)}`)}`);
      if (index === undefined) this.noteOtherBlocks(block);
    } catch (error) {
      this.line(this.theme.red(`写入失败：${this.errorMessage(error)}`));
    }
  }

  /**
   * /diff — a code block against the file it was derived from.
   *
   * The pairing is only ever with a file the user attached in this session:
   * the client reads nothing on its own, and that boundary does not move for
   * a convenience.
   */
  private showDiff(args: string): void {
    const { index, rest: requested } = splitIndexedArgument(args);
    const block = this.pickCodeBlock(index);
    if (!block) return;
    if (this.attachments.size === 0) {
      this.line(this.theme.yellow("还没有用 /attach 附加过文件，没有可比较的原文。"));
      return;
    }
    // The hint prints a short path, so the short path has to resolve back to
    // the file it named.
    const path = requested ? expandUserPath(requested, this.cwd) : ([...this.attachments.keys()].pop() ?? "");
    const original = this.attachments.get(path);
    if (original === undefined) {
      this.line(
        this.theme.yellow(
          `没有附加过 ${path}。已附加：${[...this.attachments.keys()].map((known) => this.shortPath(known)).join(" · ")}`,
        ),
      );
      return;
    }
    const ops = diffLines(original.split("\n"), block.code.split("\n"));
    if (!ops) {
      this.line(this.theme.yellow("两者差异过大，diff 已放弃；这更像是一份新文件而不是改动。"));
      return;
    }
    const { added, removed } = summarizeDiff(ops);
    if (added === 0 && removed === 0) {
      this.line(this.theme.muted(`代码块 [${String(block.index)}] 与 ${this.shortPath(path)} 完全一致。`));
      return;
    }
    const shown = this.shortPath(path);
    this.line(
      `${this.theme.bold(`${shown} → 代码块 [${String(block.index)}]`)} ${this.theme.muted(`+${String(added)} −${String(removed)}`)}`,
    );
    for (const line of renderDiff(ops, this.theme)) this.line(clipToWidth(line, this.terminalColumns()));
    this.line(this.theme.muted(`/save ${String(block.index)} ${shown} 覆盖原文 · /do 让 DSH 按它动手`));
  }

  /**
   * After an answer, say so when it looks like a rewrite of an attached file.
   * Without this the diff is there but nobody knows to ask for it.
   */
  private offerAttachmentDiff(answer: number): void {
    // Only this turn's blocks: judged against the whole session, an answer
    // that contained no code at all would keep re-offering a diff for the
    // rewrite two questions ago, as though it had just changed that file.
    const block = DeepSeekTui.preferSource(this.codeBlocks.filter((candidate) => candidate.answer === answer));
    if (!block || this.attachments.size === 0) return;
    const path = [...this.attachments.keys()].pop();
    const original = path === undefined ? undefined : this.attachments.get(path);
    if (path === undefined || original === undefined) return;
    const before = original.split("\n");
    const after = block.code.split("\n");
    const ops = diffLines(before, after);
    if (!ops || !looksLikeEdit(ops, before.length, after.length)) return;
    const { added, removed } = summarizeDiff(ops);
    if (added === 0 && removed === 0) return;
    const shown = this.shortPath(path);
    this.line(
      this.theme.muted(
        `代码块 [${String(block.index)}] 相对 ${shown} 是 +${String(added)} −${String(removed)} · /diff ${String(block.index)} 查看 · /save ${String(block.index)} ${shown} 覆盖`,
      ),
    );
    this.line();
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

  /**
   * /do — hand a task to `dsh --profile headless` and fold the result back
   * into this conversation.
   *
   * The point is the split: the REPL is a cheap place to think a problem
   * through, DSH is where files actually get edited and commands actually get
   * run. Recent turns are passed along as context so the agent does not start
   * from nothing, and the outcome is recorded so the chat can keep going
   * informed by what happened.
   */
  private async delegateToAgent(task: string): Promise<void> {
    if (!this.session) return;
    const text = task.trim();
    if (!text) {
      this.line(this.theme.yellow("用法：/do <任务>。把任务交给 DSH 执行（会真实修改文件、运行命令）。"));
      return;
    }
    const command = this.dsh.resolveCommand();
    if (!command) {
      this.line(this.theme.red(`DSH：${DSH_NOT_FOUND_HINT}`));
      return;
    }

    const context = this.recentContext();
    this.line(this.theme.bold("交给 DSH 执行"));
    this.line(`  ${this.theme.muted(padToWidth("任务", 6))}  ${oneLine(text, 400)}`);
    this.line(`  ${this.theme.muted(padToWidth("目录", 6))}  ${shortenPath(this.cwd, Math.max(8, this.terminalColumns() - 12), homedir())}`);
    this.line(`  ${this.theme.muted(padToWidth("DSH", 6))}  ${command.display}${command.version ? this.theme.muted(` (v${command.version})`) : ""}`);
    if (context) this.line(`  ${this.theme.muted(padToWidth("上下文", 6))}  ${this.theme.muted(`附带最近 ${formatCompactTokens(estimateTextTokens(context))} tokens 的对话摘要`)}`);
    this.line(this.theme.yellow("DSH 会在上述目录里真实修改文件、执行命令，且使用它自己的凭据。"));

    const answer = await this.input.next(this.theme.brightBlue("确认执行？[y/N] › "), { history: false });
    if (answer?.trim().toLocaleLowerCase() !== "y") {
      this.line(this.theme.muted("已取消。"));
      return;
    }

    const prompt = context ? `${context}\n\n---\n\n${text}` : text;
    this.controller = new AbortController();
    const generationGuard = this.beginGenerationGuard();
    let bytes = 0;
    const spinner = new Spinner(this.output, (frame, elapsedMs) =>
      clipToWidth(
        `${this.theme.blue(frame)} ${this.theme.muted(`DSH 执行中… (${String(Math.max(0, Math.round(elapsedMs / 1_000)))}s · ${formatCompactTokens(bytes / 4)} 输出 · esc 中断)`)}`,
        this.terminalColumns(),
      ),
    );
    this.write("\n");
    spinner.start();
    const startedAt = Date.now();
    try {
      const result = await this.dsh.runHeadless({
        task: prompt,
        cwd: this.cwd,
        signal: this.controller.signal,
        onData: (chunk) => {
          bytes += chunk.length;
          spinner.refresh();
        },
      });
      spinner.stop();
      const seconds = Math.max(0.1, (Date.now() - startedAt) / 1_000);
      if (this.controller.signal.aborted) {
        this.line(`${this.theme.yellow("已中断 DSH 执行。")}\n`);
        return;
      }
      if (result.timedOut) {
        this.line(`${this.theme.red("DSH 执行超时，已终止。")}\n`);
        return;
      }
      if (!result.output) {
        this.line(this.theme.yellow(`DSH 没有输出${result.status === 0 ? "" : `（退出码 ${String(result.status)}）`}。`));
        if (result.stderr) this.line(this.theme.muted(safeTerminalText(result.stderr).slice(0, 2_000)));
        return;
      }

      this.write(`${this.theme.blue("◆ DSH")}\n`);
      this.line(this.renderAnswer(result.output));
      if (result.status !== 0) {
        this.line(this.theme.yellow(`（DSH 退出码 ${String(result.status)}）`));
        if (result.stderr) this.line(this.theme.muted(safeTerminalText(result.stderr).slice(0, 2_000)));
      }
      this.write(`\n${this.theme.muted(`DSH 执行完成 · ${seconds.toFixed(1)}s · 不计入本会话 token 用量`)}\n\n`);

      // Record it so the conversation can reason about what the agent did.
      const now = new Date().toISOString();
      this.session.messages.push({ role: "user", content: `/do ${text}`, createdAt: now });
      this.session.messages.push({
        role: "assistant",
        content: `[DSH 执行结果]\n${result.output}`,
        createdAt: new Date().toISOString(),
      });
      if (this.session.title === "New conversation") this.session.title = deriveTitle(text);
      await this.saveSession();
    } catch (error) {
      spinner.stop();
      if ((error as Error).name === "AbortError") this.line(`${this.theme.yellow("已中断 DSH 执行。")}\n`);
      else this.line(`${this.theme.red(`DSH 执行失败：${this.errorMessage(error)}`)}\n`);
    } finally {
      spinner.stop();
      generationGuard.detach();
      this.controller = undefined;
    }
  }

  /** A short digest of recent turns, so a delegated task starts informed. */
  private recentContext(maxChars = 4_000): string | undefined {
    if (!this.session || this.session.messages.length === 0) return undefined;
    const parts: string[] = [];
    let used = 0;
    for (let index = this.session.messages.length - 1; index >= 0; index -= 1) {
      const message = this.session.messages[index];
      if (!message || message.role === "system") continue;
      const label = message.role === "user" ? "用户" : "助手";
      const body = shortText(message.content, 1_200);
      const entry = `${label}：${body}`;
      if (used + entry.length > maxChars) break;
      parts.unshift(entry);
      used += entry.length;
    }
    if (parts.length === 0) return undefined;
    return `以下是此前的对话背景，供你参考：\n\n${parts.join("\n\n")}`;
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
    const pricing = this.pricing();
    if (pricing) parts.push(`≈${formatCost(estimateCost(usage, pricing))}`);
    const balance = this.balanceLabel();
    if (balance) parts.push(`余额 ${balance}`);
    return parts.join(" · ");
  }

  /** Credentials for a request, or a warning when no API Key is configured. */
  private requireCredentials(): Credentials | undefined {
    const runtime = this.configStore.runtime(this.config);
    if (runtime.apiKey) return { apiKey: runtime.apiKey, baseUrl: runtime.baseUrl };
    this.line(this.theme.yellow("缺少 API Key。请先输入 /login，或设置 DEEPSEEK_API_KEY。"));
    return undefined;
  }

  /**
   * Streams one assistant reply onto the terminal: spinner, optional thinking
   * block, Markdown and timing. Every answer goes through here, so a new turn,
   * a prefilled one and the second half of an interrupted one all look alike.
   *
   * Never throws. An interrupted or failed stream comes back as `error` with
   * whatever text had already arrived, and the caller decides what to keep.
   */
  private async streamAssistant(options: AssistantTurnOptions): Promise<AssistantTurn> {
    if (options.prefixContinuation && !isOfficialEndpoint(options.credentials.baseUrl)) {
      this.line(
        this.theme.muted(`前缀续写走官方 Beta 接口；当前 Endpoint ${options.credentials.baseUrl} 未必支持。`),
      );
    }
    this.controller = new AbortController();
    const generationGuard = this.beginGenerationGuard();
    const startedAt = Date.now();
    let content = "";
    let reasoning = "";
    let reasoningShown = false;
    let contentShown = false;
    const markdown = new MarkdownStream({ theme: this.theme, numberFrom: options.numberFrom });
    const spinner = new Spinner(this.output, (frame, elapsedMs) =>
      this.generationStatus(frame, elapsedMs, reasoning, options.label ?? "正在思考"),
    );
    /** Opens the answer block, replaying text the answer is known to start with. */
    const openAnswer = (): void => {
      spinner.stop();
      if (reasoningShown) this.write(`\n${this.theme.muted("╰─")}\n\n`);
      this.write(`${this.theme.blue("◆ DeepSeek")}\n`);
      contentShown = true;
      if (options.echo) this.write(markdown.write(options.echo));
    };
    this.write("\n");
    spinner.start();
    try {
      const result = await streamChat({
        apiKey: options.credentials.apiKey,
        baseUrl: options.prefixContinuation
          ? prefixBaseUrl(options.credentials.baseUrl)
          : options.credentials.baseUrl,
        model: options.model,
        messages: options.messages,
        effort: options.effort,
        signal: this.controller.signal,
        ...(options.prefixContinuation ? { prefixContinuation: true } : {}),
        ...(options.stop ? { stop: options.stop } : {}),
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
          if (!contentShown) openAnswer();
          this.write(markdown.write(delta));
        },
      });
      spinner.stop();
      this.write(markdown.end());
      if (!contentShown) {
        // An echo is text the answer already has, so it is still worth drawing
        // even when the model added nothing to it.
        if (options.echo) {
          openAnswer();
          this.write(markdown.end());
          this.write(this.theme.muted("\n(没有新增内容)"));
        } else this.write(`${this.theme.blue("◆ DeepSeek")}\n${this.theme.muted("(没有文本响应)")}`);
      }
      return {
        content: result.content,
        reasoning: result.reasoningContent,
        usage: result.usage,
        // One measurement for every readout: taking it twice made the turn
        // footer and /status disagree by however long the session save took.
        elapsedMs: Math.max(1, Date.now() - startedAt),
        blocks: markdown.blocks,
        echoed: contentShown,
      };
    } catch (error) {
      spinner.stop();
      // Close a code fence the interrupted reply left open, or the frame
      // would swallow every line printed after it.
      this.write(markdown.end());
      return {
        content,
        reasoning,
        usage: { ...EMPTY_USAGE },
        elapsedMs: Math.max(1, Date.now() - startedAt),
        blocks: markdown.blocks,
        echoed: contentShown,
        error,
      };
    } finally {
      spinner.stop();
      generationGuard.detach();
      this.controller = undefined;
    }
  }

  /** Books a finished turn: usage, timing, balance and the footer line. */
  private async recordTurn(usage: TokenUsage, elapsedMs: number): Promise<void> {
    if (!this.session) return;
    this.session.usage = addUsage(this.session.usage, usage);
    this.session.lastTurnMs = elapsedMs;
    this.session.lastCompletionTokens = usage.completionTokens;
    this.chargeBalance(usage);
    await this.saveSession();
    this.write(`\n\n${this.theme.muted(this.turnFooter(usage, elapsedMs))}\n\n`);
    // Reconcile with the real figure for the next turn's footer.
    this.refreshBalance();
  }

  private reportTurnError(error: unknown): void {
    if ((error as Error).name === "AbortError") this.line(`\n${this.theme.yellow("已中断本次生成。")}\n`);
    else this.line(`\n${this.theme.red(`请求失败：${this.errorMessage(error)}`)}\n`);
  }

  private async sendMessage(text: string): Promise<void> {
    if (!this.session) return;
    const credentials = this.requireCredentials();
    if (!credentials) return;
    const userMessage: ChatMessage = {
      role: "user",
      content: text,
      createdAt: new Date().toISOString(),
    };
    const titleBefore = this.session.title;
    this.session.messages.push(userMessage);
    if (this.session.title === "New conversation") this.session.title = deriveTitle(text);
    await this.saveSession();

    // One-shot: a prefill that silently shaped every later answer would be a
    // hidden mode. Taken up front so a failed turn does not leave it armed.
    const prefill = this.prefill;
    this.prefill = undefined;
    const planned = this.requestMessages(this.session.messages);
    const messages = prefill
      ? [...planned, { role: "assistant" as const, content: prefill.text, createdAt: new Date().toISOString() }]
      : planned;

    const turn = await this.streamAssistant({
      credentials,
      model: this.session.model,
      messages,
      numberFrom: this.codeBlocks.length + 1,
      effort: await this.effortFor(text),
      ...(prefill
        ? { prefixContinuation: true, echo: prefill.text, ...(prefill.stop ? { stop: prefill.stop } : {}) }
        : {}),
    });
    const answer = prefill ? applyPrefill(prefill, turn.content) : turn.content;
    this.fileBlocks(turn.blocks);

    if (!turn.error) {
      const assistant: ChatMessage = {
        role: "assistant",
        content: answer,
        createdAt: new Date().toISOString(),
      };
      if (turn.reasoning) assistant.reasoningContent = turn.reasoning;
      this.session.messages.push(assistant);
      await this.recordTurn(turn.usage, turn.elapsedMs);
      this.offerAttachmentDiff(this.answers);
      return;
    }

    // Keep a partial answer, but never store an assistant turn with empty
    // content: the API rejects it on the next request. The test is on what the
    // model returned, not on `answer` — with a prefill armed, `answer` is
    // non-empty even when nothing whatsoever was generated, and storing that
    // would put words in the model's mouth and strand the user's message.
    if (turn.content.trim()) {
      const partial: ChatMessage = { role: "assistant", content: answer, createdAt: new Date().toISOString() };
      if (turn.reasoning) partial.reasoningContent = turn.reasoning;
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
    this.reportTurnError(turn.error);
  }

  /**
   * /continue — finish the answer that was cut off.
   *
   * An interrupted reply is already kept in the session; until now the only
   * way to get the rest was to ask again, which pays for the whole thinking
   * pass a second time. DeepSeek's beta prefix completion finishes the message
   * instead, so the second half costs what a second half should.
   */
  private async continueAnswer(): Promise<void> {
    if (!this.session) return;
    const last = this.session.messages[this.session.messages.length - 1];
    if (!last || last.role !== "assistant" || !last.content.trim()) {
      this.line(this.theme.yellow("没有可以续写的内容：/continue 接在助手回复之后使用（例如被 Esc 中断的那条）。"));
      return;
    }
    const credentials = this.requireCredentials();
    if (!credentials) return;

    const before = last.content;
    // The echo re-draws the blocks the interrupted half already had, so those
    // numbers are re-issued rather than duplicated.
    const reissued = extractCodeBlocks(before).length;
    const turn = await this.streamAssistant({
      credentials,
      model: this.session.model,
      messages: this.requestMessages(this.session.messages),
      effort: this.config.effort,
      numberFrom: Math.max(1, this.codeBlocks.length - reissued + 1),
      prefixContinuation: true,
      echo: before,
      label: "正在续写",
    });
    // Only re-file when the echo was actually redrawn. A request that failed
    // before its first token drew nothing, and swapping its empty block list
    // in would delete the interrupted half's numbering — and, on a retry,
    // start eating an earlier answer's blocks instead.
    if (turn.echoed) {
      // The continuation belongs to the answer it is finishing, not a new one.
      const resumed = this.codeBlocks[this.codeBlocks.length - reissued]?.answer;
      this.codeBlocks.splice(Math.max(0, this.codeBlocks.length - reissued));
      this.fileBlocks(turn.blocks, resumed ?? (this.answers += 1));
    }

    if (turn.content) {
      last.content = `${before}${turn.content}`;
      if (turn.reasoning) {
        last.reasoningContent = last.reasoningContent ? `${last.reasoningContent}\n${turn.reasoning}` : turn.reasoning;
      }
    }
    if (turn.error) {
      if (turn.content) await this.saveSession();
      this.reportTurnError(turn.error);
      return;
    }
    if (!turn.content.trim()) {
      this.line(`\n${this.theme.muted("模型没有再补充内容，这条回答保持原样。")}\n`);
      return;
    }
    await this.recordTurn(turn.usage, turn.elapsedMs);
  }

  /** /prefill — force the next answer to start with something (one-shot). */
  private prefillNext(raw: string): void {
    const input = raw.trim();
    if (!input) {
      if (this.prefill) {
        this.line(`下一条回答将以 ${this.theme.bold(oneLine(this.prefill.label, 60))} 开头（仅一次）。`);
        this.line(this.theme.muted("/prefill off 取消。"));
        return;
      }
      this.line(this.theme.muted("用法：/prefill <文本>——下一条回答会以这段文本开头。"));
      this.line(this.theme.muted("例：/prefill ```python 只要代码；/prefill 结论： 直接给结论。支持 \\n 换行，/prefill off 取消。"));
      return;
    }
    if (/^(?:off|none|clear|-)$/iu.test(input)) {
      if (!this.prefill) {
        this.line(this.theme.muted("当前没有待用的前缀。"));
        return;
      }
      this.prefill = undefined;
      this.line(this.theme.muted("已取消前缀。"));
      return;
    }
    const plan = planPrefill(input);
    if (!plan) return;
    this.prefill = plan;
    this.line(`${this.theme.green("✓")} 下一条回答将以 ${this.theme.bold(oneLine(plan.label, 60))} 开头（仅一次）`);
    if (plan.stop) {
      this.line(this.theme.muted(`遇到 ${plan.stop.join(" / ")} 即停止，因此回答里只会有这一个代码块。`));
    }
  }

  /** Rates for the session's model, or undefined when none are known. */
  private pricing(): ModelPricing | undefined {
    return this.session ? pricingFor(this.session.model, this.config.pricing) : undefined;
  }

  /**
   * Warns that an action is about to rewrite the conversation prefix. The
   * DeepSeek cache only serves a *fully* matching prefix, so rewriting any of
   * it makes the next request pay miss rate for the whole replacement.
   * Returns false when the user declines.
   */
  private async confirmPrefixLoss(action: string): Promise<boolean> {
    if (!this.session || this.session.messages.length === 0) return true;
    const loss = prefixLoss(this.session.messages, this.pricing());
    if (loss.tokens <= 0) return true;
    const money = loss.cost === undefined ? "" : `，下一轮约多付 ${this.theme.bold(`≈${formatCost(loss.cost)}`)}`;
    this.line(
      this.theme.yellow(
        `${action}会重写会话前缀：约 ${formatCompactTokens(loss.tokens)} tokens 的上下文缓存将失效${money}。`,
      ),
    );
    this.line(this.theme.muted("（DeepSeek 的缓存要求前缀完全匹配，改动早期历史后整段都按未命中计价）"));
    const answer = await this.input.next(this.theme.brightBlue("继续？[y/N] › "), { history: false });
    if (answer?.trim().toLocaleLowerCase() === "y") return true;
    this.line(this.theme.muted("已取消。"));
    return false;
  }

  /** /cache — how much the context cache is actually saving. */
  private showCache(): void {
    if (!this.session) return;
    const pricing = this.pricing();
    const report = cacheReport(this.session.usage, pricing);
    this.line(this.theme.bold("上下文缓存"));
    if (report.hitRate === undefined) {
      this.line(this.theme.muted("  本会话还没有计费过的输入 token。"));
    } else {
      const tint = report.hitRate >= 60 ? this.theme.green : report.hitRate >= 25 ? this.theme.yellow : this.theme.muted;
      this.line(
        `  ${this.theme.muted(padToWidth("命中率", 8))}  ${tint(`${report.hitRate.toFixed(1)}%`)} ${this.theme.muted(`· 命中 ${formatCompactTokens(report.hitTokens)} · 未命中 ${formatCompactTokens(report.missTokens)}`)}`,
      );
    }
    const resident = prefixLoss(this.session.messages, pricing);
    this.line(
      `  ${this.theme.muted(padToWidth("可复用", 8))}  ${formatCompactTokens(resident.tokens)} tokens ${this.theme.muted("（下一轮若不改动早期历史即可命中）")}`,
    );
    if (pricing) {
      if (report.saved !== undefined) {
        this.line(`  ${this.theme.muted(padToWidth("已省下", 8))}  ${this.theme.green(`≈${formatCost(report.saved)}`)} ${this.theme.muted("（相对全部按未命中计价）")}`);
      }
      this.line(`  ${this.theme.muted(padToWidth("本会话", 8))}  ${this.theme.bold(`≈${formatCost(estimateCost(this.session.usage, pricing))}`)} ${this.theme.muted("· 估算，按峰值价，可在 config.json 的 pricing 覆盖")}`);
    } else {
      this.line(this.theme.muted(`  ${this.session.model} 没有内置价目；可在 config.json 的 pricing 里补充后显示金额。`));
    }
    this.line(this.theme.muted("  提示：/compact 与切换模型都会让整段前缀失效。"));
  }

  /**
   * Refreshes the account balance in the background. Never awaited by a turn:
   * a slow balance endpoint must not hold up the next prompt, and a failure
   * here is not worth an error — the figure simply stops being shown.
   */
  private refreshBalance(): void {
    const runtime = this.configStore.runtime(this.config);
    if (!runtime.apiKey) return;
    void (async () => {
      try {
        const result = await getBalance({
          apiKey: runtime.apiKey as string,
          baseUrl: runtime.baseUrl,
          timeoutMs: 8_000,
        });
        const first = result.balances[0];
        if (!first) return;
        const total = Number.parseFloat(first.totalBalance);
        if (!Number.isFinite(total)) return;
        this.balance = { currency: first.currency, total, fetchedAt: Date.now(), estimated: false };
        this.balanceFailed = false;
      } catch {
        // A balance is a nicety; losing it must not disturb the session.
        this.balanceFailed = true;
      }
    })();
  }

  /**
   * Subtracts a turn's estimated cost locally, so the remaining figure moves
   * with every message instead of only when the API is asked again. Marked
   * estimated so the display never claims more precision than it has.
   */
  private chargeBalance(usage: TokenUsage): void {
    const pricing = this.pricing();
    if (!this.balance || !pricing) return;
    const spent = estimateCost(usage, pricing);
    if (!Number.isFinite(spent) || spent <= 0) return;
    // Balance is billed in the account currency; USD rates only approximate
    // it, so this is explicitly an estimate between real refreshes.
    this.balance = { ...this.balance, total: Math.max(0, this.balance.total - spent), estimated: true };
  }

  /**
   * `≈12.34 CNY`, or undefined when there is nothing trustworthy to show.
   * Bare, so callers that already have a "余额" label do not repeat it; the
   * leading ≈ marks a figure carried forward by local estimate rather than
   * one just read from the API.
   */
  private balanceLabel(): string | undefined {
    if (!this.balance) return undefined;
    const { currency, total, estimated } = this.balance;
    const amount = total >= 100 ? total.toFixed(0) : total.toFixed(2);
    return `${estimated ? "≈" : ""}${amount} ${currency}`;
  }

  private errorMessage(error: unknown): string {
    if (error instanceof DeepSeekApiError) return `${error.message}${error.status ? ` (${error.status})` : ""}`;
    if (error instanceof Error) return error.message;
    return String(error);
  }
}
