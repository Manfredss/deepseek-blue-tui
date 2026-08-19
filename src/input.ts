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
}

type SuggestionProvider = (line: string, size: TerminalSize) => readonly string[];
type ResizeHandler = (size: TerminalSize) => void;

interface Keypress {
  name?: string;
  ctrl?: boolean;
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
  onInterrupt?: () => void;

  constructor(options: {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
    completer?: Completer;
    suggestions?: SuggestionProvider;
    onResize?: ResizeHandler;
  } = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    if (options.completer) this.completer = options.completer;
    if (options.suggestions) this.suggestions = options.suggestions;
    if (options.onResize) this.onResize = options.onResize;
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
    if ((this.terminalInput as NodeJS.ReadStream).isTTY && this.suggestions) {
      this.terminalInput.prependListener("keypress", this.handleKeypress);
      this.output.on("resize", this.handleResize);
    }
  }

  private readonly handleKeypress = (_character: string | undefined, key: Keypress = {}): void => {
    if (!this.suggestionsActive || this.closed) return;
    if (key.name === "escape") {
      this.dismissedLine = this.interface.line;
      this.eraseMenuFromPrompt();
      return;
    }
    if (key.name === "return" || key.name === "enter" || (key.ctrl && key.name === "c")) {
      this.promptEpoch += 1;
      this.eraseMenuFromPrompt();
      return;
    }
    this.scheduleSuggestionRefresh();
  };

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
    this.paintMenu([...this.suggestions(this.interface.line, this.terminalSize())]);
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
    instance.on("line", (line) => {
      this.suggestionsActive = false;
      this.dismissedLine = undefined;
      this.menuCapacity = 0;
      line = this.restorePastes(line);
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
    if (this.queued.length > 0) return this.queued.shift();
    if (this.closed) return undefined;
    this.promptEpoch += 1;
    this.lastPrompt = prompt;
    this.suggestionsActive = options.suggestions ?? false;
    this.dismissedLine = undefined;
    this.menuCapacity = 0;
    this.interface.setPrompt(prompt);
    this.interface.prompt();
    return await new Promise<string | undefined>((resolve) => this.waiters.push(resolve));
  }

  pause(): void {
    this.interface.pause();
    if (this.pasteInput) this.input.pause();
  }

  resume(): void {
    if (!this.closed) {
      this.interface.resume();
      if (this.pasteInput) this.input.resume();
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
    if ((this.terminalInput as NodeJS.ReadStream).isTTY && this.suggestions) {
      this.terminalInput.prependListener("keypress", this.handleKeypress);
    }
    if (this.waiters.length > 0) {
      this.interface.setPrompt(this.lastPrompt);
      this.interface.prompt();
    }
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

    const render = (): void => {
      const lines: string[] = [color.accent(options.title)];
      options.items.forEach((item, index) => {
        const clipped = clipToWidth(item, width());
        lines.push(index === this.selected ? color.accent(`❯ ${clipped}`) : `  ${color.muted(clipped)}`);
      });
      if (options.allowCustom && this.custom.length > 0) {
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
          this.escapeTimer = setTimeout(() => {
            this.escapeTimer = undefined;
            if (this.escapeBuffer === "\u001b" && !this.settled) {
              this.escapeBuffer = "";
              settle(undefined);
            }
          }, ESCAPE_TIMEOUT_MS);
          this.escapeTimer.unref();
          continue;
        }
        if (character === "\r" || character === "\n") {
          if (options.allowCustom && this.custom.trim().length > 0) {
            settle({ kind: "custom", text: this.custom.trim() });
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
