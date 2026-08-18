import { StringDecoder } from "node:string_decoder";
import { Transform, Writable } from "node:stream";
import { createInterface, type CompleterResult, type Interface } from "node:readline";

type Completer = (line: string) => CompleterResult;

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
}

class BracketedPasteInput extends Transform {
  private readonly decoder = new StringDecoder("utf8");
  private readonly parser: BracketedPasteParser;
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
    this.push(this.parser.push(this.decoder.write(chunk)));
    callback();
  }

  override _flush(callback: (error?: Error | null) => void): void {
    this.push(this.parser.push(this.decoder.end()));
    this.push(this.parser.finish());
    callback();
  }
}

export class LineInput {
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly completer?: Completer;
  private readonly pasteInput?: BracketedPasteInput;
  private interface: Interface;
  private queued: string[] = [];
  private waiters: Array<(line: string | undefined) => void> = [];
  private pastedValues = new Map<string, string>();
  private pasteSequence = 0;
  private closed = false;
  onInterrupt?: () => void;

  constructor(options: {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
    completer?: Completer;
  } = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    if (options.completer) this.completer = options.completer;
    if ((this.input as NodeJS.ReadStream).isTTY) {
      this.pasteInput = new BracketedPasteInput(
        (value) => this.replacePaste(value),
        this.input as NodeJS.ReadStream,
      );
      this.input.pipe(this.pasteInput);
      this.output.write(ENABLE_BRACKETED_PASTE);
    }
    this.interface = this.create(this.pasteInput ?? this.input);
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
    };
    if (this.completer) options.completer = this.completer;
    const instance = createInterface(options);
    instance.on("line", (line) => {
      line = this.restorePastes(line);
      const waiter = this.waiters.shift();
      if (waiter) waiter(line);
      else this.queued.push(line);
    });
    instance.on("SIGINT", () => this.onInterrupt?.());
    instance.on("close", () => {
      this.closed = true;
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

  async next(prompt: string): Promise<string | undefined> {
    if (this.queued.length > 0) return this.queued.shift();
    if (this.closed) return undefined;
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

  close(): void {
    if (!this.closed) this.interface.close();
  }
}

class MutedOutput extends Writable {
  override _write(_chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback();
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
