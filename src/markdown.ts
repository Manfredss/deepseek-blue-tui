import type { Theme } from "./theme.js";

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

/** Inline Markdown outside code: `code`, **bold**, *em*, and [text](url). */
function inlineMarkdown(text: string, theme: Theme): string {
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
    // the "not mid-word" check has to read the original text.
    if (emphasis?.[1] && (index === 0 || !/\w/u.test(text[index - 1] ?? ""))) {
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
}

/**
 * Feed deltas in, get terminal-ready text out. Call `end()` once the stream
 * finishes to flush a trailing partial line and close an unterminated fence.
 */
export class MarkdownStream {
  private readonly theme: Theme;
  private readonly gutter: string;
  private buffer = "";
  private inFence = false;
  private fenceMarker = "";
  private codeState: CodeState = { blockComment: false };

  constructor(options: MarkdownStreamOptions) {
    this.theme = options.theme;
    this.gutter = options.gutter ?? "│ ";
  }

  /** True while the renderer is inside a fenced code block. */
  get insideCode(): boolean {
    return this.inFence;
  }

  write(delta: string): string {
    this.buffer += safe(delta);
    let out = "";
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      out += `${this.renderLine(this.buffer.slice(0, newline))}\n`;
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
    }
    return out;
  }

  /** Flushes whatever is buffered; closes a code block left hanging. */
  end(): string {
    let out = "";
    if (this.buffer) {
      out += this.renderLine(this.buffer);
      this.buffer = "";
    }
    if (this.inFence) {
      out += `\n${this.theme.muted("└─")}`;
      this.inFence = false;
      this.fenceMarker = "";
      this.codeState = { blockComment: false };
    }
    return out;
  }

  private renderLine(line: string): string {
    const fence = FENCE.exec(line);
    if (fence?.[2]) {
      if (!this.inFence) {
        this.inFence = true;
        this.fenceMarker = fence[2][0] ?? "`";
        this.codeState = { blockComment: false };
        const language = fence[3] ?? "";
        return this.theme.muted(`┌─ ${language || "code"} ${"─".repeat(Math.max(0, 12 - language.length))}`);
      }
      // A closing fence must use the same character as the opening one.
      if (fence[2][0] === this.fenceMarker) {
        this.inFence = false;
        this.fenceMarker = "";
        this.codeState = { blockComment: false };
        return this.theme.muted("└─");
      }
    }

    if (this.inFence) {
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

/** One-shot rendering for text that is already complete (history replay). */
export function renderMarkdown(text: string, theme: Theme): string {
  const stream = new MarkdownStream({ theme });
  return `${stream.write(text)}${stream.end()}`.replace(/\n+$/u, "");
}
