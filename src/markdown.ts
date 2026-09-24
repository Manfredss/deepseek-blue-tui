import { createTheme, type Theme } from "./theme.js";

/**
 * Streaming Markdown renderer for assistant output.
 *
 * The model's reply arrives as arbitrary deltas, so this buffers until a line
 * is complete and only then decides how to draw it — a code fence cannot be
 * recognised from half a line. Everything is line-oriented for that reason.
 *
 * Code is never truncated or reflowed: losing a character of code is worse
 * than a ragged wrap, so long lines are left for the terminal to wrap.
 */

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)/u;
const HEADING = /^(#{1,6})\s+(.*)$/u;
const BULLET = /^(\s*)([-*+])\s+(.*)$/u;
const ORDERED = /^(\s*)(\d{1,3}[.)])\s+(.*)$/u;
const QUOTE = /^(\s*)>\s?(.*)$/u;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u;
const TABLE_ROW = /^\s*\|.*\|\s*$/u;

/** Strips control characters that could move the cursor or repaint the screen. */
function safe(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

// --- lightweight code tinting ---------------------------------------------
//
// A full grammar per language is out of scope; this marks the three things
// that carry most of the visual signal in any C-like, Python, shell or SQL
// source — comments, string literals and numbers — plus a shared keyword set.
// It is deliberately approximate, and never drops or reorders characters.

const KEYWORDS = new Set([
  "abstract", "and", "as", "assert", "async", "await", "break", "case", "catch", "class", "const",
  "continue", "def", "default", "del", "delete", "do", "elif", "else", "enum", "except", "export",
  "extends", "finally", "fn", "for", "from", "func", "function", "go", "if", "impl", "import", "in",
  "instanceof", "interface", "is", "lambda", "let", "match", "mod", "mut", "new", "nil", "none",
  "not", "null", "or", "package", "pass", "private", "protected", "public", "pub", "raise", "return",
  "select", "self", "static", "struct", "super", "switch", "this", "throw", "trait", "true", "false",
  "try", "type", "typeof", "undefined", "union", "unless", "until", "use", "var", "void", "when",
  "where", "while", "with", "yield",
  // SQL is conventionally uppercase in the wild; lookup lowercases, so one
  // lowercase spelling covers both.
  "insert", "update", "join",
]);

const LINE_COMMENT_MARKERS = ["//", "#", "--", ";;"];

interface CodeState {
  /** Inside a /* ... *\/ block that opened on an earlier line. */
  blockComment: boolean;
}

/**
 * Tints one line of code. Scans left to right so a marker inside a string is
 * not mistaken for a comment, and vice versa. Returns the styled line; the
 * visible characters are always identical to the input.
 */
function tintCode(line: string, theme: Theme, state: CodeState): string {
  if (!theme.enabled) return line;
  let out = "";
  let index = 0;

  const flushWord = (word: string): string => {
    if (!word) return "";
    if (/^\d[\d_.eE+-]*$/u.test(word) || /^0[xXbBoO][0-9a-fA-F_]+$/u.test(word)) return theme.cyan(word);
    if (KEYWORDS.has(word) || (word.length > 1 && KEYWORDS.has(word.toLocaleLowerCase()))) {
      return theme.brightBlue(word);
    }
    return word;
  };

  let word = "";
  while (index < line.length) {
    if (state.blockComment) {
      const close = line.indexOf("*/", index);
      if (close === -1) {
        out += theme.muted(line.slice(index));
        return out;
      }
      out += theme.muted(line.slice(index, close + 2));
      index = close + 2;
      state.blockComment = false;
      continue;
    }

    const rest = line.slice(index);

    if (rest.startsWith("/*")) {
      out += flushWord(word);
      word = "";
      state.blockComment = true;
      continue;
    }

    const marker = LINE_COMMENT_MARKERS.find((candidate) => rest.startsWith(candidate));
    if (marker) {
      out += flushWord(word);
      word = "";
      out += theme.muted(line.slice(index));
      return out;
    }

    const character = line[index] ?? "";
    if (character === '"' || character === "'" || character === "`") {
      out += flushWord(word);
      word = "";
      let cursor = index + 1;
      while (cursor < line.length) {
        if (line[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (line[cursor] === character) {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      out += theme.green(line.slice(index, Math.min(cursor, line.length)));
      index = Math.min(cursor, line.length);
      continue;
    }

    if (/[A-Za-z0-9_$]/u.test(character)) {
      word += character;
      index += 1;
      continue;
    }
    out += flushWord(word);
    word = "";
    out += character;
    index += 1;
  }
  out += flushWord(word);
  return out;
}

/** The inline constructs, tried in order at a given position. */
const INLINE_PATTERNS = [
  /^`[^`\n]+`/u,
  /^\*\*[^*\n]+\*\*/u,
  /^[*_][^*_\n]+[*_](?!\w)/u,
  /^\[[^\]\n]*\]\([^)\s]+\)/u,
] as const;

/** Characters that can open an inline construct. */
const INLINE_OPENERS = "`*_[";

/**
 * How much of `text` is safe to emit now: everything before an inline marker
 * that has not closed yet. Splitting there means the pieces can be rendered
 * separately and concatenated to exactly what rendering the whole would give,
 * which is what lets output stream without changing.
 */
function stableInlineLength(text: string, precededBy: string): number {
  let index = 0;
  while (index < text.length) {
    const character = text[index] ?? "";
    if (!INLINE_OPENERS.includes(character)) {
      index += 1;
      continue;
    }
    const rest = text.slice(index);
    const previous = index === 0 ? precededBy : (text[index - 1] ?? "");
    // `_` inside a word is an identifier, not emphasis, so it opens nothing.
    if ((character === "_" || character === "*") && /\w/u.test(previous)) {
      index += 1;
      continue;
    }
    const match = INLINE_PATTERNS.find((pattern) => pattern.test(rest));
    if (!match) return index; // may still close once more text arrives
    index += (match.exec(rest)?.[0].length ?? 1);
  }
  return text.length;
}

/**
 * Inline Markdown outside code: `code`, **bold**, *em*, and [text](url).
 *
 * `precededBy` is the character before `text` in the original line. It matters
 * because emphasis must not fire mid-word, and when a line is rendered in
 * pieces the previous character is no longer in `text`.
 */
function inlineMarkdown(text: string, theme: Theme, precededBy = ""): string {
  if (!theme.enabled) return text;
  let result = "";
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);

    const code = /^`([^`\n]+)`/u.exec(rest);
    if (code?.[1]) {
      result += theme.cyan(code[1]);
      index += code[0].length;
      continue;
    }
    const bold = /^\*\*([^*\n]+)\*\*/u.exec(rest);
    if (bold?.[1]) {
      result += theme.bold(bold[1]);
      index += bold[0].length;
      continue;
    }
    const emphasis = /^[*_]([^*_\n]+)[*_](?!\w)/u.exec(rest);
    // Anchored at `rest`, a lookbehind would always see the empty string, so
    // the "not mid-word" check has to read the character before it.
    const previous = index === 0 ? precededBy : (text[index - 1] ?? "");
    if (emphasis?.[1] && !/\w/u.test(previous)) {
      result += theme.brightBlue(emphasis[1]);
      index += emphasis[0].length;
      continue;
    }
    const link = /^\[([^\]\n]*)\]\(([^)\s]+)\)/u.exec(rest);
    if (link) {
      result += `${theme.brightBlue(link[1] ?? "")} ${theme.muted(link[2] ?? "")}`;
      index += link[0].length;
      continue;
    }
    result += text[index];
    index += 1;
  }
  return result;
}

export interface MarkdownStreamOptions {
  theme: Theme;
  /** Prefix drawn down the left of a fenced code block. */
  gutter?: string;
  /**
   * Number code blocks from here and show the number in the frame, so the
   * reader can say which one they mean (`/copy 2`). Left out, blocks are still
   * collected but drawn unnumbered.
   */
  numberFrom?: number;
}

/** A fenced block, kept verbatim so it can be copied or written to a file. */
export interface CodeBlock {
  /** 1-based label as drawn in the frame header. */
  index: number;
  language: string;
  code: string;
  /** The last line of prose before the fence — often "运行示例输出：". */
  intro?: string;
}

/**
 * Feed deltas in, get terminal-ready text out. Call `end()` once the stream
 * finishes to flush a trailing partial line and close an unterminated fence.
 */
/** Lines whose rendering only makes sense once the whole line is known. */
const HOLD_WHOLE_LINE = /^\s*(?:`{3,}|~{3,}|\||#{1,6}\s|>)/u;

/** A partial line that could still turn into something structural. */
const UNDECIDED = /^\s*(?:#{1,6}|[-*+_]+|\d{1,3}[.)]?|`{1,2}|~{1,2}|>)?\s*$/u;

export class MarkdownStream {
  private readonly theme: Theme;
  private readonly gutter: string;
  private readonly numberFrom: number | undefined;
  private readonly collected: CodeBlock[] = [];
  /** The fence being read, collected line by line so nothing is re-parsed. */
  private open: { index: number; language: string; lines: string[]; intro: string } | undefined;
  /** Last line of prose seen outside a fence; what introduces the next block. */
  private lastProse = "";
  /** The current line so far, including anything already emitted. */
  private line = "";
  /** How much of `line` has been written out. */
  private consumed = 0;
  /** Set once the line is classified and its prefix emitted. */
  private streaming = false;
  private inFence = false;
  private fenceMarker = "";
  private codeState: CodeState = { blockComment: false };

  constructor(options: MarkdownStreamOptions) {
    this.theme = options.theme;
    this.gutter = options.gutter ?? "│ ";
    if (options.numberFrom !== undefined) this.numberFrom = options.numberFrom;
  }

  /** True while the renderer is inside a fenced code block. */
  get insideCode(): boolean {
    return this.inFence;
  }

  /** Every fenced block rendered so far, verbatim. Complete after `end()`. */
  get blocks(): readonly CodeBlock[] {
    return this.collected;
  }

  /** Files the fence that just closed (or that `end()` had to close). */
  private closeBlock(): void {
    if (!this.open) return;
    this.collected.push({
      index: this.open.index,
      language: this.open.language,
      code: this.open.lines.join("\n"),
      ...(this.open.intro ? { intro: this.open.intro } : {}),
    });
    this.open = undefined;
  }

  write(delta: string): string {
    let pending = safe(delta);
    let out = "";
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      this.line += pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      const completed = this.line;
      out += `${this.finishLine()}\n`;
      // Remember what introduced the next fence. `finishLine` has already
      // flipped `inFence`, so a fence line itself is excluded by the test.
      if (!this.inFence && completed.trim() && !FENCE.test(completed)) this.lastProse = completed.trim();
      this.resetLine();
    }
    this.line += pending;
    out += this.stream();
    return out;
  }

  /** Flushes whatever is buffered; closes a code block left hanging. */
  end(): string {
    let out = "";
    if (this.line) {
      out += this.finishLine();
      this.resetLine();
    }
    if (this.inFence) {
      out += `\n${this.theme.muted("└─")}`;
      this.inFence = false;
      this.fenceMarker = "";
      this.codeState = { blockComment: false };
      this.closeBlock();
    }
    return out;
  }

  private resetLine(): void {
    this.line = "";
    this.consumed = 0;
    this.streaming = false;
  }

  /**
   * Emits as much of the current partial line as can be committed to.
   *
   * Prose and list items stream as they arrive, because holding a paragraph
   * until its newline leaves the screen blank for as long as the paragraph
   * takes to generate. Everything whose rendering depends on the whole line —
   * fences, headings, quotes, tables, rules — still waits.
   */
  private stream(): string {
    if (this.inFence) return ""; // code is tinted and guttered per line
    if (!this.streaming) {
      if (HOLD_WHOLE_LINE.test(this.line) || UNDECIDED.test(this.line)) return "";
      const opened = this.openLine();
      if (opened === undefined) return "";
      this.streaming = true;
      return opened + this.emitStable();
    }
    return this.emitStable();
  }

  /** Classifies the line, emitting any list marker. */
  private openLine(): string | undefined {
    const bullet = BULLET.exec(this.line);
    if (bullet?.[3] !== undefined) {
      this.consumed = this.line.length - bullet[3].length;
      return `${bullet[1] ?? ""}${this.theme.blue("•")} `;
    }
    const ordered = ORDERED.exec(this.line);
    if (ordered?.[3] !== undefined) {
      this.consumed = this.line.length - ordered[3].length;
      return `${ordered[1] ?? ""}${this.theme.blue(ordered[2] ?? "")} `;
    }
    this.consumed = 0;
    return "";
  }

  /** Emits the part of the line that no pending inline marker can change. */
  private emitStable(): string {
    const rest = this.line.slice(this.consumed);
    if (!rest) return "";
    const precededBy = this.consumed > 0 ? (this.line[this.consumed - 1] ?? "") : "";
    const safeLength = stableInlineLength(rest, precededBy);
    if (safeLength <= 0) return "";
    const piece = rest.slice(0, safeLength);
    this.consumed += safeLength;
    return inlineMarkdown(piece, this.theme, precededBy);
  }

  /** Completes the current line, streamed or not. */
  private finishLine(): string {
    if (!this.streaming) return this.renderLine(this.line);
    const rest = this.line.slice(this.consumed);
    if (!rest) return "";
    const precededBy = this.consumed > 0 ? (this.line[this.consumed - 1] ?? "") : "";
    this.consumed = this.line.length;
    return inlineMarkdown(rest, this.theme, precededBy);
  }

  private renderLine(line: string): string {
    const fence = FENCE.exec(line);
    if (fence?.[2]) {
      if (!this.inFence) {
        this.inFence = true;
        this.fenceMarker = fence[2][0] ?? "`";
        this.codeState = { blockComment: false };
        const language = fence[3] ?? "";
        const index = (this.numberFrom ?? 1) + this.collected.length;
        this.open = { index, language, lines: [], intro: this.lastProse };
        // Spent: two fences in a row, with nothing but blank lines between
        // them, must not both claim the one line of prose above the first.
        this.lastProse = "";
        const label = this.numberFrom === undefined ? "" : `[${index}] `;
        return this.theme.muted(`┌─ ${label}${language || "code"} ${"─".repeat(Math.max(0, 12 - language.length))}`);
      }
      // A closing fence must use the same character as the opening one.
      if (fence[2][0] === this.fenceMarker) {
        this.inFence = false;
        this.fenceMarker = "";
        this.codeState = { blockComment: false };
        this.closeBlock();
        return this.theme.muted("└─");
      }
    }

    if (this.inFence) {
      this.open?.lines.push(line);
      return `${this.theme.muted(this.gutter)}${tintCode(line, this.theme, this.codeState)}`;
    }

    if (!line.trim()) return "";

    const heading = HEADING.exec(line);
    if (heading?.[2] !== undefined) {
      return this.theme.bold(this.theme.brightBlue(heading[2]));
    }
    if (RULE.test(line)) {
      return this.theme.muted("─".repeat(24));
    }
    const quote = QUOTE.exec(line);
    if (quote?.[2] !== undefined) {
      return `${quote[1] ?? ""}${this.theme.muted("▏")} ${this.theme.muted(inlineMarkdown(quote[2], this.theme))}`;
    }
    const bullet = BULLET.exec(line);
    if (bullet?.[3] !== undefined) {
      return `${bullet[1] ?? ""}${this.theme.blue("•")} ${inlineMarkdown(bullet[3], this.theme)}`;
    }
    const ordered = ORDERED.exec(line);
    if (ordered?.[3] !== undefined) {
      return `${ordered[1] ?? ""}${this.theme.blue(ordered[2] ?? "")} ${inlineMarkdown(ordered[3], this.theme)}`;
    }
    if (TABLE_ROW.test(line)) {
      // Leave table pipes alone; realigning them mid-stream is not possible.
      return this.theme.muted(line);
    }
    return inlineMarkdown(line, this.theme);
  }
}

/** One-shot rendering that also hands back the code blocks it framed. */
export function renderMarkdownWithBlocks(
  text: string,
  theme: Theme,
  numberFrom?: number,
): { text: string; blocks: readonly CodeBlock[] } {
  const stream = new MarkdownStream({ theme, ...(numberFrom === undefined ? {} : { numberFrom }) });
  const rendered = `${stream.write(text)}${stream.end()}`.replace(/\n+$/u, "");
  return { text: rendered, blocks: stream.blocks };
}

/** One-shot rendering for text that is already complete (history replay). */
export function renderMarkdown(text: string, theme: Theme): string {
  return renderMarkdownWithBlocks(text, theme).text;
}

/**
 * Language tags that mean "this is what it printed" rather than "this is the
 * source". An answer very often ends with its own output, which makes the
 * *last* block the one nobody wants to copy.
 */
const OUTPUT_LANGUAGES = new Set([
  "text",
  "txt",
  "plain",
  "plaintext",
  "output",
  "out",
  "stdout",
  "stderr",
  "console",
  "terminal",
  "log",
  "result",
]);

/** Prose that announces the block below it is what the program printed. */
const OUTPUT_INTRO = /输出|结果|运行|示例|打印|效果|\boutput\b|\bresult\b|\bprints?\b|\bconsole\b/iu;

/**
 * Marks of source rather than printed text. Deliberately shallow: statement
 * punctuation, indentation, and the keywords every language family shares.
 */
const SOURCE_MARKS: readonly RegExp[] = [
  /[;{}]\s*$/mu,
  /^\s{2,}\S/mu,
  /^\s*(?:#\s*include\b|#!)/mu,
  /\b(?:def|class|import|from|return|function|const|let|var|public|private|void|struct|impl|fn|package|using|namespace|async|await|lambda|echo|git|npm|pip|sudo|cd)\b/u,
  /=>|->|::|==|!=|\+=|&&|\|\||\$\(/u,
  /\w+\s*\([^)]*\)\s*[:{]/u,
];

function looksLikeSource(code: string): boolean {
  return SOURCE_MARKS.some((mark) => mark.test(code));
}

/**
 * Whether a block is the answer's output rather than its source.
 *
 * The language tag settles it when there is one. Models routinely leave the
 * output block untagged, though, so an untagged block is judged by the prose
 * that introduced it and then by whether it reads like code at all — an
 * untagged block that looks like source stays source, because a bare shell
 * command is exactly the kind of thing people copy.
 */
export function isOutputBlock(block: CodeBlock): boolean {
  const language = block.language.trim().toLowerCase();
  if (language) return OUTPUT_LANGUAGES.has(language);
  if (block.intro && OUTPUT_INTRO.test(block.intro)) return true;
  return !looksLikeSource(block.code);
}

/**
 * The code blocks in some text, without drawing anything — used to rebuild the
 * numbering for a session that was resumed rather than streamed. It runs the
 * same renderer so a block is whatever the frame would have framed, not
 * whatever a second fence parser happens to think.
 */
export function extractCodeBlocks(text: string, numberFrom = 1): CodeBlock[] {
  const stream = new MarkdownStream({ theme: createTheme(false), numberFrom });
  stream.write(text);
  stream.end();
  return [...stream.blocks];
}
