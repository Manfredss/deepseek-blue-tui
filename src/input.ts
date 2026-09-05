import { StringDecoder } from "node:string_decoder";
import { Transform, Writable } from "node:stream";
import {
  clearLine,
  clearScreenDown,
  createInterface,
  cursorTo,
  moveCursor,
  type CompleterResult,
  type Interface,
} from "node:readline";
import { clipToWidth } from "./text-width.js";

type Completer = (line: string) => CompleterResult;

export interface TerminalSize {
  columns: number;
  rows: number;
}

export interface LineInputNextOptions {
  suggestions?: boolean;
  /** Set false for throwaway prompts (confirmations) that must not be recalled. */
  history?: boolean;
  /**
   * Prompt used for continuation lines. When set, a line ending in a single
   * backslash keeps the editor open and the parts are joined with newlines.
   */
  continuation?: string;
}

export interface LineInputHistory {
  /** Chronological entries (oldest first); mutated as new lines are typed. */
  entries: string[];
  /** Called with every newly recorded entry so callers can persist it. */
  append?: (entry: string) => void;
  /** Return false to keep an entry out of history (e.g. `/exit`). */
  accepts?: (entry: string) => boolean;
}

const HISTORY_LIMIT = 500;
const SECRET_LIKE = /\bsk-[A-Za-z0-9_-]{8,}/u;

/** Longest prefix shared by every candidate ("" when they diverge at once). */
function commonPrefix(values: readonly string[]): string {
  let prefix = values[0] ?? "";
  for (const value of values) {
    while (prefix && !value.startsWith(prefix)) prefix = prefix.slice(0, -1);
    if (!prefix) break;
  }
  return prefix;
}

/** A single trailing backslash continues the message on the next line. */
function hasContinuation(line: string): boolean {
  const match = /\\+$/u.exec(line);
  return match !== null && match[0].length % 2 === 1;
}

export interface SuggestionMenu {
  lines: readonly string[];
  /**
   * Values for the selectable rows. When present, Up/Down move through
   * these values while the overlay is visible and Enter can confirm the
   * highlighted value as the submitted line.
   */
  values?: readonly string[];
}

type SuggestionProvider = (
  line: string,
  size: TerminalSize,
  selectedIndex: number,
) => SuggestionMenu | readonly string[];
type ResizeHandler = (size: TerminalSize) => void;

interface Keypress {
  name?: string | undefined;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
  code?: string;
}

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";
const ENABLE_BRACKETED_PASTE = "\u001b[?2004h";
const DISABLE_BRACKETED_PASTE = "\u001b[?2004l";

function markerPrefixLength(value: string, marker: string): number {
  const maximum = Math.min(value.length, marker.length - 1);
  for (let length = maximum; length > 0; length -= 1) {
    if (marker.startsWith(value.slice(-length))) return length;
  }
  return 0;
}

class BracketedPasteParser {
  private buffered = "";
  private pasted = "";
  private insidePaste = false;

  constructor(private readonly replacePaste: (value: string) => string) {}

  push(value: string): string {
    this.buffered += value;
    let output = "";

    while (this.buffered.length > 0) {
      const marker = this.insidePaste ? PASTE_END : PASTE_START;
      const markerIndex = this.buffered.indexOf(marker);
      if (markerIndex >= 0) {
        const beforeMarker = this.buffered.slice(0, markerIndex);
        if (this.insidePaste) this.pasted += beforeMarker;
        else output += beforeMarker;
        this.buffered = this.buffered.slice(markerIndex + marker.length);

        if (this.insidePaste) {
          output += this.replacePaste(this.pasted);
          this.pasted = "";
        }
        this.insidePaste = !this.insidePaste;
        continue;
      }

      const retainedLength = markerPrefixLength(this.buffered, marker);
      const safeLength = this.buffered.length - retainedLength;
      const safe = this.buffered.slice(0, safeLength);
      if (this.insidePaste) this.pasted += safe;
      else output += safe;
      this.buffered = this.buffered.slice(safeLength);
      break;
    }

    return output;
  }

  finish(): string {
    let output = "";
    if (this.insidePaste) {
      this.pasted += this.buffered;
      output = this.replacePaste(this.pasted);
    } else {
      output = this.buffered;
    }
    this.buffered = "";
    this.pasted = "";
    this.insidePaste = false;
    return output;
  }

  flushPendingPrefix(): string {
    if (this.insidePaste || this.buffered.length === 0) return "";
    const output = this.buffered;
    this.buffered = "";
    return output;
  }
}

class BracketedPasteInput extends Transform {
  private readonly decoder = new StringDecoder("utf8");
  private readonly parser: BracketedPasteParser;
  private prefixTimer: NodeJS.Timeout | undefined;
  isTTY = true;
  isRaw = false;

  constructor(
    replacePaste: (value: string) => string,
    private readonly source: NodeJS.ReadStream,
  ) {
    super();
    this.parser = new BracketedPasteParser(replacePaste);
    this.isRaw = Boolean(source.isRaw);
  }

  setRawMode(mode: boolean): this {
    this.source.setRawMode?.(mode);
    this.isRaw = mode;
    return this;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.prefixTimer) clearTimeout(this.prefixTimer);
    this.push(this.parser.push(this.decoder.write(chunk)));
    this.prefixTimer = setTimeout(() => {
      this.prefixTimer = undefined;
      this.push(this.parser.flushPendingPrefix());
    }, 25);
    this.prefixTimer.unref();
    callback();
  }

  override _flush(callback: (error?: Error | null) => void): void {
    if (this.prefixTimer) clearTimeout(this.prefixTimer);
    this.prefixTimer = undefined;
    this.push(this.parser.push(this.decoder.end()));
    this.push(this.parser.finish());
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.prefixTimer) clearTimeout(this.prefixTimer);
    this.prefixTimer = undefined;
    callback(error);
  }
}

export class LineInput {
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly completer?: Completer;
  private readonly suggestions?: SuggestionProvider;
  private readonly onResize?: ResizeHandler;
  private pasteInput?: BracketedPasteInput | undefined;
  private terminalInput?: NodeJS.ReadableStream | undefined;
  private interface: Interface;
  private queued: string[] = [];
  private waiters: Array<(line: string | undefined) => void> = [];
  private pastedValues = new Map<string, string>();
  private pasteSequence = 0;
  private closed = false;
  private suspending = false;
  private lastPrompt = "";
  private suggestionsActive = false;
  private dismissedLine: string | undefined;
  private menuCapacity = 0;
  private promptEpoch = 0;
  private refreshQueued = false;
  private suggestionLine: string | undefined;
  private suggestionSelection = -1;
  private suggestionValues: readonly string[] = [];
  private readonly history: LineInputHistory | undefined;
  private historyEnabled = true;
  onInterrupt?: () => void;

  constructor(options: {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
    completer?: Completer;
    suggestions?: SuggestionProvider;
    onResize?: ResizeHandler;
    history?: LineInputHistory;
  } = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    if (options.completer) this.completer = options.completer;
    if (options.suggestions) this.suggestions = options.suggestions;
    if (options.onResize) this.onResize = options.onResize;
    this.history = options.history;
    if ((this.input as NodeJS.ReadStream).isTTY) {
      this.pasteInput = new BracketedPasteInput(
        (value) => this.replacePaste(value),
        this.input as NodeJS.ReadStream,
      );
      this.input.pipe(this.pasteInput);
      this.output.write(ENABLE_BRACKETED_PASTE);
    }
    this.terminalInput = this.pasteInput ?? this.input;
    this.interface = this.create(this.terminalInput);
    if ((this.terminalInput as NodeJS.ReadStream).isTTY) {
      this.terminalInput.prependListener("keypress", this.handleKeypress);
      this.output.on("resize", this.handleResize);
    }
  }

  private readonly handleKeypress = (_character: string | undefined, key: Keypress = {}): void => {
    if (this.closed) return;
    if (key.ctrl && key.name === "l") {
      // readline clears the screen itself; forget the overlay rows that
      // scrolled away with it so the next repaint re-allocates from scratch.
      this.menuCapacity = 0;
      if (this.suggestionsActive) this.scheduleSuggestionRefresh();
      return;
    }
    if (!this.suggestionsActive) return;
    if (key.name === "escape") {
      this.suggestionSelection = -1;
      this.suggestionValues = [];
      this.dismissedLine = this.interface.line;
      this.eraseMenuFromPrompt();
      return;
    }
    if (key.name === "return" || key.name === "enter" || (key.ctrl && key.name === "c")) {
      if (!key.ctrl) this.confirmSuggestionIntoLine();
      this.promptEpoch += 1;
      this.eraseMenuFromPrompt();
      return;
    }
    if (key.name === "tab" && !key.ctrl && !key.meta && !key.shift) {
      if (this.completeFromSuggestions()) {
        // readline's default branch inserts the *character* it was handed, so
        // clearing `key.name` (enough for arrows) would still leave a literal
        // tab in the line. Routing the key into the ctrl switch drops it.
        key.ctrl = true;
        key.name = undefined;
        key.sequence = "";
        key.code = "";
        this.scheduleSuggestionRefresh();
        return;
      }
    }
    if (key.name === "up" || key.name === "down") {
      if (this.dismissedLine !== this.interface.line) {
        if (this.suggestionValues.length === 0 && this.suggestions) {
          const menu = this.normalizeSuggestion(this.suggestions(this.interface.line, this.terminalSize(), -1));
          this.suggestionValues = menu.values ?? [];
          this.suggestionLine = this.interface.line;
        }
        if (this.suggestionValues.length > 0) {
          this.moveSuggestionSelection(key.name);
          // readline normally sends bare Up/Down to history navigation. The
          // command palette owns those keys while it is visible, so mutate
          // the event object before readline's own keypress listener runs.
          key.name = undefined;
          key.sequence = "";
          key.code = "";
          this.scheduleSuggestionRefresh();
          return;
        }
      }
    }
    this.scheduleSuggestionRefresh();
  };

  private moveSuggestionSelection(direction: "up" | "down"): void {
    const count = this.suggestionValues.length;
    if (count === 0) {
      this.suggestionSelection = -1;
      return;
    }
    if (this.suggestionSelection < 0) {
      this.suggestionSelection = direction === "up" ? count - 1 : 0;
      return;
    }
    this.suggestionSelection =
      direction === "up"
        ? Math.max(0, this.suggestionSelection - 1)
        : Math.min(count - 1, this.suggestionSelection + 1);
  }

  /**
   * Tab completion against the live palette: takes the highlighted candidate,
   * otherwise grows the line by the prefix all candidates share. When the
   * prefix cannot grow it highlights the first candidate instead, so a second
   * Tab (or Enter) commits it. Returns whether anything changed.
   */
  private completeFromSuggestions(): boolean {
    if (!this.suggestions) return false;
    const line = this.interface.line;
    const menu = this.normalizeSuggestion(this.suggestions(line, this.terminalSize(), this.suggestionSelection));
    const values = menu.values ?? [];
    if (values.length === 0) return false;
    this.suggestionValues = values;
    // Tab is an explicit request, so it reopens a palette dismissed with Esc.
    this.dismissedLine = undefined;
    const selected = this.suggestionSelection;
    const highlighted = selected >= 0 && selected < values.length ? values[selected] : undefined;
    const target = highlighted ?? commonPrefix(values);
    if (target.length > line.length) {
      this.replaceLine(target);
      this.suggestionLine = target;
      this.suggestionSelection = -1;
      return true;
    }
    if (highlighted !== undefined) return false;
    this.suggestionSelection = 0;
    return true;
  }

  /** Replaces the line editor's content through readline's own edit keys. */
  private replaceLine(value: string): void {
    this.interface.write(null, { ctrl: true, name: "e" });
    this.interface.write(null, { ctrl: true, name: "u" });
    if (value) this.interface.write(value);
  }

  private confirmSuggestionIntoLine(): void {
    const index = this.suggestionSelection;
    if (index < 0 || index >= this.suggestionValues.length) return;
    const value = this.suggestionValues[index];
    if (value === undefined || this.interface.line === value) return;
    // readline's own keypress listener runs immediately after this
    // prepended one and will submit whatever is in `interface.line`.
    const editable = this.interface as unknown as { line: string; cursor: number };
    editable.line = value;
    editable.cursor = value.length;
  }

  private readonly handleResize = (): void => {
    if (!this.suggestionsActive || this.closed) return;
    const epoch = this.promptEpoch;
    queueMicrotask(() => {
      if (this.closed || !this.suggestionsActive || epoch !== this.promptEpoch) return;
      this.clearMenuForResize();
      this.onResize?.(this.terminalSize());
      this.interface.prompt(true);
      this.refreshSuggestions();
    });
  };

  private terminalSize(): TerminalSize {
    const output = this.output as NodeJS.WriteStream;
    const rawColumns = Number.isFinite(output.columns) && output.columns > 0 ? output.columns : 80;
    const rawRows = Number.isFinite(output.rows) && output.rows > 0 ? output.rows : 24;
    return {
      columns: Math.max(16, rawColumns - 2),
      rows: Math.max(4, rawRows),
    };
  }

  private scheduleSuggestionRefresh(): void {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    const epoch = this.promptEpoch;
    queueMicrotask(() => {
      this.refreshQueued = false;
      if (this.closed || !this.suggestionsActive || epoch !== this.promptEpoch) return;
      if (this.dismissedLine !== undefined && this.dismissedLine !== this.interface.line) this.dismissedLine = undefined;
      this.refreshSuggestions();
    });
  }

  private refreshSuggestions(): void {
    if (!this.suggestions || !this.suggestionsActive || this.dismissedLine === this.interface.line) {
      this.eraseMenuFromPrompt();
      return;
    }
    if (this.interface.getCursorPos().rows > 0) {
      this.eraseMenuFromPrompt();
      return;
    }
    const line = this.interface.line;
    if (this.suggestionLine !== line) {
      this.suggestionLine = line;
      this.suggestionSelection = -1;
    }
    let menu = this.normalizeSuggestion(this.suggestions(line, this.terminalSize(), this.suggestionSelection));
    this.suggestionValues = menu.values ?? [];
    if (this.suggestionSelection >= this.suggestionValues.length) {
      this.suggestionSelection = this.suggestionValues.length > 0 ? this.suggestionValues.length - 1 : -1;
      menu = this.normalizeSuggestion(this.suggestions(line, this.terminalSize(), this.suggestionSelection));
      this.suggestionValues = menu.values ?? [];
    }
    this.paintMenu([...menu.lines]);
  }

  private normalizeSuggestion(result: SuggestionMenu | readonly string[]): SuggestionMenu {
    return (Array.isArray(result) ? { lines: result } : result) as SuggestionMenu;
  }

  private allocateMenuRows(capacity: number): void {
    if (capacity <= this.menuCapacity) return;
    const additional = capacity - this.menuCapacity;
    const cursor = this.interface.getCursorPos();
    if (this.menuCapacity > 0) moveCursor(this.output, 0, this.menuCapacity);
    for (let index = 0; index < additional; index += 1) this.output.write("\r\n");
    moveCursor(this.output, 0, -capacity);
    cursorTo(this.output, cursor.cols);
    this.menuCapacity = capacity;
  }

  private paintMenu(lines: readonly string[]): void {
    this.allocateMenuRows(lines.length);
    if (this.menuCapacity === 0) return;
    const cursor = this.interface.getCursorPos();
    this.output.write("\u001b[?25l");
    for (let index = 0; index < this.menuCapacity; index += 1) {
      moveCursor(this.output, 0, 1);
      cursorTo(this.output, 0);
      clearLine(this.output, 0);
      const line = lines[index];
      if (line) this.output.write(line);
    }
    moveCursor(this.output, 0, -this.menuCapacity);
    cursorTo(this.output, cursor.cols);
    this.output.write("\u001b[?25h");
  }

  private eraseMenuFromPrompt(): void {
    if (this.menuCapacity > 0) this.paintMenu([]);
  }

  private clearMenuForResize(): void {
    if (this.menuCapacity === 0) return;
    const cursor = this.interface.getCursorPos();
    this.output.write("\u001b[?25l");
    moveCursor(this.output, 0, 1);
    cursorTo(this.output, 0);
    clearScreenDown(this.output);
    moveCursor(this.output, 0, -1);
    cursorTo(this.output, cursor.cols);
    this.output.write("\u001b[?25h");
    this.menuCapacity = 0;
  }

  private replacePaste(value: string): string {
    if (!/[\r\n]/u.test(value)) return value;
    const lineCount = value.split(/\r\n|\r|\n/u).length;
    const token = `[Pasted text #${String(++this.pasteSequence)} · ${String(lineCount)} lines]`;
    this.pastedValues.set(token, value);
    return token;
  }

  private restorePastes(line: string): string {
    const pastedValues = [...this.pastedValues];
    this.pastedValues.clear();
    for (const [token, value] of pastedValues) line = line.split(token).join(value);
    return line;
  }

  private create(input: NodeJS.ReadableStream): Interface {
    const options: Parameters<typeof createInterface>[0] = {
      input,
      output: this.output,
      terminal: Boolean((input as NodeJS.ReadStream).isTTY),
      historySize: 500,
      removeHistoryDuplicates: true,
      escapeCodeTimeout: 100,
    };
    if (this.completer) options.completer = this.completer;
    const instance = createInterface(options);
    this.seedHistory(instance);
    instance.on("line", (line) => {
      this.suggestionsActive = false;
      this.dismissedLine = undefined;
      this.menuCapacity = 0;
      this.suggestionLine = undefined;
      this.suggestionSelection = -1;
      this.suggestionValues = [];
      line = this.restorePastes(line);
      if (this.historyEnabled) this.recordHistory(line);
      const waiter = this.waiters.shift();
      if (waiter) waiter(line);
      else this.queued.push(line);
    });
    instance.on("SIGINT", () => this.onInterrupt?.());
    instance.on("close", () => {
      if (this.suspending) return;
      this.closed = true;
      this.promptEpoch += 1;
      this.terminalInput?.removeListener("keypress", this.handleKeypress);
      this.output.removeListener("resize", this.handleResize);
      if (this.pasteInput) {
        this.output.write(DISABLE_BRACKETED_PASTE);
        this.input.unpipe(this.pasteInput);
        this.pasteInput.destroy();
      }
      this.pastedValues.clear();
      for (const waiter of this.waiters.splice(0)) waiter(undefined);
    });
    return instance;
  }

  async next(prompt: string, options: LineInputNextOptions = {}): Promise<string | undefined> {
    const continuation = options.continuation;
    let line = await this.readLine(prompt, options);
    if (line === undefined || continuation === undefined) return line;
    while (hasContinuation(line)) {
      const more = await this.readLine(continuation, {});
      if (more === undefined) return line.slice(0, -1);
      line = `${line.slice(0, -1)}\n${more}`;
    }
    return line;
  }

  private async readLine(prompt: string, options: LineInputNextOptions): Promise<string | undefined> {
    if (this.queued.length > 0) {
      const queued = this.queued.shift();
      // Type-ahead captured while the prompt was suspended never went through
      // the line editor, so echo it: an unexplained reply is disorienting.
      if (queued !== undefined) this.output.write(`${prompt}${queued}\n`);
      return queued;
    }
    if (this.closed) return undefined;
    this.historyEnabled = options.history ?? true;
    this.promptEpoch += 1;
    this.lastPrompt = prompt;
    this.suggestionsActive = options.suggestions ?? false;
    this.dismissedLine = undefined;
    this.menuCapacity = 0;
    this.suggestionLine = undefined;
    this.suggestionSelection = -1;
    this.suggestionValues = [];
    this.interface.setPrompt(prompt);
    this.interface.prompt();
    return await new Promise<string | undefined>((resolve) => this.waiters.push(resolve));
  }

  /**
   * Hands the terminal to a foreign full-screen program (`/edit` spawns
   * $EDITOR with inherited stdio). Bracketed paste is turned off for the
   * duration: left on, an editor receives the raw `[200~` markers as
   * keystrokes when the user pastes into it.
   */
  pause(): void {
    this.interface.pause();
    if (this.pasteInput) {
      this.output.write(DISABLE_BRACKETED_PASTE);
      this.input.pause();
    }
  }

  resume(): void {
    if (!this.closed) {
      this.interface.resume();
      if (this.pasteInput) {
        this.output.write(ENABLE_BRACKETED_PASTE);
        this.input.resume();
      }
    }
  }

  /**
   * Hands the terminal over to a MenuPicker: the readline interface is closed
   * (without marking this input as closed) and the paste transform detached so
   * raw keystrokes reach the picker exclusively.
   */
  suspendForMenu(): void {
    if (this.closed) return;
    this.promptEpoch += 1;
    this.menuCapacity = 0;
    this.suggestionsActive = false;
    this.suggestionLine = undefined;
    this.suggestionSelection = -1;
    this.suggestionValues = [];
    this.suspending = true;
    this.interface.close();
    this.suspending = false;
    this.terminalInput?.removeListener("keypress", this.handleKeypress);
    if (this.pasteInput) {
      this.input.unpipe(this.pasteInput);
      this.pasteInput.destroy();
      this.pasteInput = undefined;
    }
    this.terminalInput = undefined;
  }

  /** Rebuilds the readline interface after a MenuPicker finished. */
  resumeFromMenu(): void {
    if (this.closed) return;
    if ((this.input as NodeJS.ReadStream).isTTY) {
      this.pasteInput = new BracketedPasteInput(
        (value) => this.replacePaste(value),
        this.input as NodeJS.ReadStream,
      );
      this.input.pipe(this.pasteInput);
    }
    this.terminalInput = this.pasteInput ?? this.input;
    this.interface = this.create(this.terminalInput);
    if ((this.terminalInput as NodeJS.ReadStream).isTTY) {
      this.terminalInput.prependListener("keypress", this.handleKeypress);
    }
    if (this.waiters.length > 0) {
      this.interface.setPrompt(this.lastPrompt);
      this.interface.prompt();
    }
  }

  /**
   * Queues complete lines typed while the prompt was suspended (e.g. during
   * a generation). A trailing partial line without Enter is discarded, since
   * it cannot be safely restored into the line editor.
   */
  pushText(text: string): void {
    const segments = text.split(/\r\n|\r|\n/);
    for (const line of segments.slice(0, -1)) {
      if (line.length > 0) this.queued.push(line);
    }
  }

  /** True while a prompt is waiting for the user to submit a line. */
  isPrompting(): boolean {
    return !this.closed && this.waiters.length > 0;
  }

  /** The text currently held by the line editor. */
  currentLine(): string {
    return this.closed ? "" : this.interface.line;
  }

  /** Empties the line editor and hides any visible suggestion overlay. */
  resetLine(): void {
    if (this.closed) return;
    this.replaceLine("");
    this.suggestionLine = undefined;
    this.suggestionSelection = -1;
    this.suggestionValues = [];
    this.dismissedLine = undefined;
    this.eraseMenuFromPrompt();
    this.menuCapacity = 0;
  }

  /** Prints a line above the active prompt, then redraws the prompt. */
  notice(text: string): void {
    if (this.closed) {
      this.output.write(`${text}\n`);
      return;
    }
    this.eraseMenuFromPrompt();
    this.menuCapacity = 0;
    clearLine(this.output as NodeJS.WriteStream, 0);
    cursorTo(this.output as NodeJS.WriteStream, 0);
    this.output.write(`${text}\n`);
    this.interface.prompt(true);
  }

  private seedHistory(instance: Interface): void {
    const entries = this.history?.entries;
    if (!entries || entries.length === 0) return;
    const editable = instance as unknown as { history?: unknown };
    if (!Array.isArray(editable.history)) return;
    editable.history = entries.slice(-HISTORY_LIMIT).reverse();
  }

  private recordHistory(line: string): void {
    const history = this.history;
    if (!history) return;
    const value = line.trim();
    // Skip blanks, repeats, restored multi-line pastes and anything that
    // looks like a credential — the history file lives on disk.
    if (!value || value.length > 1_000 || /[\r\n]/u.test(value)) return;
    if (SECRET_LIKE.test(value)) return;
    if (history.accepts && !history.accepts(value)) return;
    if (history.entries[history.entries.length - 1] === value) return;
    history.entries.push(value);
    if (history.entries.length > HISTORY_LIMIT) {
      history.entries.splice(0, history.entries.length - HISTORY_LIMIT);
    }
    history.append?.(value);
  }

  close(): void {
    if (!this.closed) this.interface.close();
  }
}

class MutedOutput extends Writable {
  override _write(_chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback();
  }
}

// ---------------------------------------------------------------------------
// MenuPicker: arrow-key navigable option lists (↑/↓ move, Enter confirms,
// Esc cancels, digits jump; optionally typing composes a custom value).
// ---------------------------------------------------------------------------

export interface MenuPickerColor {
  accent: (value: string) => string;
  muted: (value: string) => string;
}

export interface MenuPickerOptions {
  title: string;
  items: readonly string[];
  footer?: string;
  allowCustom?: boolean;
  customLabel?: string;
  initial?: number;
  color?: MenuPickerColor;
}

export type MenuPickerResult =
  | { kind: "index"; index: number }
  | { kind: "custom"; text: string }
  | undefined;

const ESCAPE_TIMEOUT_MS = 45;
const CSI_FINAL_MIN = 0x40;
const CSI_FINAL_MAX = 0x7e;

export class MenuPicker {
  private readonly input: NodeJS.ReadStream;
  private readonly output: NodeJS.WritableStream;
  private selected = 0;
  private custom = "";
  private printedLines = 0;
  private escapeBuffer = "";
  private inCsi = false;
  private escapeTimer: NodeJS.Timeout | undefined;
  private settled = false;

  constructor(input: NodeJS.ReadableStream, output: NodeJS.WritableStream) {
    this.input = input as NodeJS.ReadStream;
    this.output = output;
  }

  run(options: MenuPickerOptions): Promise<MenuPickerResult> {
    if (!this.input.isTTY) return Promise.reject(new Error("菜单选择需要 TTY 环境"));
    // Nothing to point at: an empty list would otherwise confirm index 0.
    if (options.items.length === 0 && !options.allowCustom) return Promise.resolve(undefined);
    const color: MenuPickerColor = options.color ?? { accent: (value) => value, muted: (value) => value };
    this.selected = Math.max(0, Math.min(options.items.length - 1, options.initial ?? 0));
    this.printedLines = 0;
    this.escapeBuffer = "";
    this.inCsi = false;
    this.settled = false;

    const width = (): number => {
      const columns = (this.output as NodeJS.WriteStream).columns;
      return Number.isFinite(columns) && columns > 0 ? Math.max(16, Math.floor(columns) - 2) : 78;
    };

    const rowBudget = (): number => {
      const rows = (this.output as NodeJS.WriteStream).rows;
      return Number.isFinite(rows) && rows > 0 ? Math.max(4, Math.floor(rows)) : 24;
    };

    const render = (): void => {
      const showCustom = Boolean(options.allowCustom && this.custom.length > 0);
      // Chrome is title + optional custom line + optional footer. One extra
      // row is reserved for the line the cursor sits on, so the repaint's
      // cursor-up can never walk off the top of a short terminal — which
      // used to shred the screen whenever the list was taller than it.
      const chrome = 1 + (showCustom ? 1 : 0) + (options.footer ? 1 : 0);
      const budget = Math.max(1, rowBudget() - chrome - 1);
      const total = options.items.length;
      let start = 0;
      let capacity = total;
      if (total > budget) {
        capacity = Math.max(1, budget - 1); // One row goes to the overflow hint.
        start = Math.max(0, Math.min(this.selected - Math.floor(capacity / 2), total - capacity));
      }
      const visible = options.items.slice(start, start + capacity);
      const lines: string[] = [color.accent(options.title)];
      visible.forEach((item, offset) => {
        const index = start + offset;
        const clipped = clipToWidth(item, width());
        lines.push(index === this.selected ? color.accent(`❯ ${clipped}`) : `  ${color.muted(clipped)}`);
      });
      const hiddenBefore = start;
      const hiddenAfter = total - start - visible.length;
      if (hiddenBefore > 0 || hiddenAfter > 0) {
        const parts: string[] = [];
        if (hiddenBefore > 0) parts.push(`↑ ${String(hiddenBefore)}`);
        if (hiddenAfter > 0) parts.push(`↓ ${String(hiddenAfter)}`);
        lines.push(color.muted(`  ${parts.join(" · ")} 项未显示`));
      }
      if (showCustom) {
        lines.push(`${color.accent(options.customLabel ?? "自定义：")} ${this.custom}▏`);
      }
      if (options.footer) lines.push(color.muted(options.footer));
      const text = lines.join("\r\n") + "\r\n";
      if (this.printedLines > 0) {
        this.output.write(`\u001b[${this.printedLines}A`);
      }
      for (let index = 0; index < this.printedLines; index += 1) {
        this.output.write("\r\u001b[2K");
      }
      this.output.write(text);
      this.printedLines = lines.length;
    };

    const clearEscapeTimer = (): void => {
      if (this.escapeTimer) clearTimeout(this.escapeTimer);
      this.escapeTimer = undefined;
    };

    let finish: (value: MenuPickerResult) => void = () => undefined;
    const settle = (value: MenuPickerResult): void => {
      if (this.settled) return;
      this.settled = true;
      clearEscapeTimer();
      this.input.removeListener("data", onData);
      if (this.printedLines > 0) {
        this.output.write(`\u001b[${this.printedLines}A`);
        for (let index = 0; index < this.printedLines; index += 1) {
          this.output.write("\r\u001b[2K");
        }
      }
      this.printedLines = 0;
      this.input.setRawMode?.(false);
      this.input.pause();
      finish(value);
    };

    const handleCsiFinal = (final: string): void => {
      if (final === "A") this.selected = Math.max(0, this.selected - 1);
      else if (final === "B") this.selected = Math.min(options.items.length - 1, this.selected + 1);
      this.escapeBuffer = "";
      this.inCsi = false;
      render();
    };

    const onData = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      for (const character of text) {
        if (this.settled) return;
        const codePoint = character.codePointAt(0) ?? 0;

        if (this.inCsi) {
          clearEscapeTimer();
          if (codePoint >= CSI_FINAL_MIN && codePoint <= CSI_FINAL_MAX) {
            handleCsiFinal(character);
          } else if (codePoint === 0x1b) {
            this.escapeBuffer = "\u001b";
            this.inCsi = false;
          }
          // Intermediate bytes (digits, ';', '1'..'9') accumulate invisibly.
          continue;
        }
        if (this.escapeBuffer === "\u001b") {
          clearEscapeTimer();
          if (character === "[") {
            this.inCsi = true;
            continue;
          }
          // A lone Escape (no CSI) means cancel.
          this.escapeBuffer = "";
          settle(undefined);
          return;
        }

        if (character === "\u001b") {
          this.escapeBuffer = "\u001b";
          // Keep this timeout referenced: on CI runners (notably Node 22)
          // an unref'ed timer is the only remaining handle after a lone
          // Escape, so the test runner cancels the still-pending picker.
          this.escapeTimer = setTimeout(() => {
            this.escapeTimer = undefined;
            if (this.escapeBuffer === "\u001b" && !this.settled) {
              this.escapeBuffer = "";
              settle(undefined);
            }
          }, ESCAPE_TIMEOUT_MS);
          continue;
        }
        if (character === "\r" || character === "\n") {
          if (options.allowCustom && this.custom.trim().length > 0) {
            settle({ kind: "custom", text: this.custom.trim() });
          } else if (options.items.length === 0) {
            settle(undefined); // Custom-only picker with nothing typed yet.
          } else {
            settle({ kind: "index", index: this.selected });
          }
          return;
        }
        if (codePoint === 0x03) {
          settle(undefined);
          return;
        }
        if (codePoint === 0x7f || codePoint === 0x08) {
          if (options.allowCustom && this.custom.length > 0) {
            this.custom = this.custom.slice(0, -1);
            render();
          }
          continue;
        }
        if (/[1-9]/u.test(character) && !options.allowCustom) {
          const index = Number(character) - 1;
          if (index < options.items.length) {
            this.selected = index;
            render();
          }
          continue;
        }
        if (options.allowCustom && !/[\u0000-\u001f\u007f]/u.test(character)) {
          this.custom += character;
          render();
        }
      }
    };

    this.input.resume();
    this.input.setRawMode?.(true);
    this.input.on("data", onData);
    render();

    return new Promise<MenuPickerResult>((resolve) => {
      finish = resolve;
    });
  }
}

// ---------------------------------------------------------------------------
// watchAbortKeys: raw-key watcher for interrupting in-flight generations.
// Esc (lone) and Ctrl+C abort; arrow sequences are ignored; any other
// keystrokes are buffered so completed type-ahead lines can be replayed.
// ---------------------------------------------------------------------------

export interface AbortKeyWatcher {
  /** Removes the watcher and returns the buffered type-ahead text. */
  detach: () => string;
}

export function watchAbortKeys(
  input: NodeJS.ReadableStream,
  onAbort: () => void,
): AbortKeyWatcher {
  const stream = input as NodeJS.ReadStream;
  let typed = "";
  let escapeBuffer = "";
  let inCsi = false;
  let escapeTimer: NodeJS.Timeout | undefined;
  let aborted = false;
  let detached = false;

  const abort = (): void => {
    if (aborted) return;
    aborted = true;
    onAbort();
  };

  const clearEscapeTimer = (): void => {
    if (escapeTimer) clearTimeout(escapeTimer);
    escapeTimer = undefined;
  };

  const onData = (chunk: Buffer): void => {
    if (detached) return;
    const text = chunk.toString("utf8");
    for (const character of text) {
      if (detached) return;
      const codePoint = character.codePointAt(0) ?? 0;

      if (inCsi) {
        clearEscapeTimer();
        if (codePoint >= CSI_FINAL_MIN && codePoint <= CSI_FINAL_MAX) {
          // Arrow keys and friends: ignore, but do not abort.
          escapeBuffer = "";
          inCsi = false;
        } else if (codePoint === 0x1b) {
          escapeBuffer = "\u001b";
          inCsi = false;
        }
        continue;
      }
      if (escapeBuffer === "\u001b") {
        clearEscapeTimer();
        if (character === "[") {
          inCsi = true;
          continue;
        }
        // Lone Escape means cancel the generation.
        escapeBuffer = "";
        abort();
        return;
      }
      if (character === "\u001b") {
        escapeBuffer = "\u001b";
        escapeTimer = setTimeout(() => {
          escapeTimer = undefined;
          if (escapeBuffer === "\u001b") {
            escapeBuffer = "";
            abort();
          }
        }, ESCAPE_TIMEOUT_MS);
        escapeTimer.unref();
        continue;
      }
      if (codePoint === 0x03) {
        abort();
        continue;
      }
      typed += character;
    }
  };

  if (!stream.isTTY) {
    return { detach: () => "" };
  }
  stream.resume();
  stream.setRawMode?.(true);
  stream.on("data", onData);

  return {
    detach: () => {
      if (detached) return "";
      detached = true;
      clearEscapeTimer();
      stream.removeListener("data", onData);
      stream.setRawMode?.(false);
      stream.pause();
      return typed;
    },
  };
}

export async function promptSecret(
  prompt: string,
  options: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {},
): Promise<string | undefined> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (!(input as NodeJS.ReadStream).isTTY) return undefined;
  output.write(prompt);
  const muted = new MutedOutput();
  const secretInterface = createInterface({ input, output: muted, terminal: true, historySize: 0 });
  return await new Promise<string | undefined>((resolve) => {
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      secretInterface.close();
      output.write("\n");
      resolve(value);
    };
    secretInterface.once("SIGINT", () => finish(undefined));
    secretInterface.question("", (answer) => finish(answer));
  });
}
