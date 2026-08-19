import type { Theme } from "./theme.js";

const DETAILED_WHALE = [
  "         ▄▄▄▄▄▄▄▄▄▄▄██      ██▄",
  "    ▄▄███████████████▄      █████▄ ▄▄▄▄▄██",
  "  ▄█████████████████████▄   ▀████████████▀",
  "▄██████████████████████████▄  ▀██████▀▀",
  "███      ▀▀▀██████████▀●▀██████████",
  "███▄          ▀▀████████  ▀████████",
  "▀███▄            ▀███████▄▄███████",
  " ▀███▄             ▀████████████▀",
  "  ▀█████▄     ██▄▄   ▀████████▀",
  "     ▀██████▄▄██████▄▄▄▄█████████",
  "        ▀▀▀███████████▀▀▀",
] as const;

const LARGE_WHALE = [
  "        ▄▄▄▄▄▄▄       ▄▄  ▄▄",
  "    ▄████████████▄    ███▄███",
  "  ▄████████████████▄▄███████▀",
  "▄████████████▀ ▀██████████▀",
  "████▀    ▀████▄  ▀██●████▄",
  "████       ▀██████████▀ ▀██",
  " ▀███▄        ▀██████▄",
  "   ▀████▄▄▄██████▀ ▀████▄",
] as const;

const SMALL_WHALE = [
  "    ▄▄▄▄▄   ▄ ▄",
  " ▄████████▄ █▄█",
  "██████▀ ●██████▀",
  "██▀   ▀██████▄",
  " ▀██▄▄▄██▀ ▀██",
] as const;

const MINI_WHALE = [
  "  ▄████▄  ▄ ▄",
  "▄████▀●██▄█▄█",
  "▀██▄▄████▀ ▀█",
] as const;

export interface LogoOptions {
  /** Maximum number of terminal columns available to the logo. */
  columns?: number;
}

export interface WelcomeScreenOptions extends LogoOptions {
  rows?: number;
  cwd: string;
  model: string;
  version: string;
  apiKeyConfigured: boolean;
  username?: string;
}

type CellTone = "normal" | "muted" | "blue" | "heading" | "whale";

interface Cell {
  text: string;
  align?: "left" | "center";
  tone?: CellTone;
}

const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/gu;

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE, "");
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

function displayWidth(value: string): number {
  let width = 0;
  for (const character of stripAnsi(value)) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) continue;
    if (/\p{Mark}/u.test(character)) continue;
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

function truncate(value: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(value) <= width) return value;
  if (width === 1) return "…";
  let result = "";
  let used = 0;
  for (const character of value) {
    const characterWidth = isWideCodePoint(character.codePointAt(0) ?? 0) ? 2 : 1;
    if (used + characterWidth > width - 1) break;
    result += character;
    used += characterWidth;
  }
  return `${result}…`;
}

function pad(value: string, width: number, align: "left" | "center" = "left"): string {
  const clipped = truncate(value, width);
  const remaining = Math.max(0, width - displayWidth(clipped));
  if (align === "center") {
    const left = Math.floor(remaining / 2);
    return `${" ".repeat(left)}${clipped}${" ".repeat(remaining - left)}`;
  }
  return `${clipped}${" ".repeat(remaining)}`;
}

function normalizedColumns(columns: number | undefined, fallback = 72): number {
  if (columns === undefined || !Number.isFinite(columns)) return fallback;
  return Math.max(16, Math.min(110, Math.floor(columns)));
}

function whaleFor(columns: number): readonly string[] {
  return columns >= 27 ? LARGE_WHALE : SMALL_WHALE;
}

function styleCell(theme: Theme, cell: Cell, width: number): string {
  const value = pad(cell.text, width, cell.align);
  switch (cell.tone) {
    case "muted":
      return theme.muted(value);
    case "blue":
      return theme.brightBlue(value);
    case "heading":
      return theme.bold(theme.brightBlue(value));
    case "whale":
      return styleWhale(theme, value);
    default:
      return value;
  }
}

function styleWhale(theme: Theme, value: string): string {
  return value
    .split(/(\s+|●)/u)
    .map((part) => {
      if (!part || /^\s+$/u.test(part)) return part;
      return part === "●" ? theme.bold(part) : theme.blue(part);
    })
    .join("");
}

function topBorder(theme: Theme, width: number, title: string): string {
  const innerWidth = Math.max(0, width - 2);
  if (innerWidth === 0) return theme.blue("╭╮".slice(0, width));
  const label = truncate(`─ ${title} `, innerWidth);
  return theme.blue(`╭${label}${"─".repeat(Math.max(0, innerWidth - displayWidth(label)))}╮`);
}

function bottomBorder(theme: Theme, width: number): string {
  return theme.blue(`╰${"─".repeat(Math.max(0, width - 2))}╯`);
}

function singleRow(theme: Theme, width: number, cell: Cell): string {
  const contentWidth = Math.max(0, width - 4);
  return `${theme.blue("│")} ${styleCell(theme, cell, contentWidth)} ${theme.blue("│")}`;
}

function twoColumnRow(
  theme: Theme,
  width: number,
  leftWidth: number,
  left: Cell,
  right: Cell,
): string {
  const innerWidth = width - 2;
  const rightWidth = innerWidth - leftWidth - 1;
  const paddedCell = (cell: Cell, cellWidth: number): string => {
    if (cellWidth < 2) return styleCell(theme, cell, cellWidth);
    return ` ${styleCell(theme, cell, cellWidth - 2)} `;
  };
  return `${theme.blue("│")}${paddedCell(left, leftWidth)}${theme.blue("│")}${paddedCell(right, rightWidth)}${theme.blue("│")}`;
}

function compactPath(value: string): string {
  const normalized = value.replace(/[\r\n\t]/gu, " ").trim();
  return normalized || ".";
}

/**
 * Render the original community whale using only a DeepSeek-blue foreground.
 * No background SGR is emitted, so the user's terminal theme remains intact.
 */
export function renderLogo(theme: Theme, options: LogoOptions = {}): string {
  const columns = normalizedColumns(options.columns);
  const whale = whaleFor(columns);
  const lines = whale.map((line) => styleWhale(theme, pad(line, columns, "center")));
  const fullTitle = columns >= displayWidth("DeepSeek Terminal");
  const plainTitle = truncate(fullTitle ? "DeepSeek Terminal" : "DeepSeek", columns);
  const title = fullTitle ? `${theme.bold("DeepSeek")} ${theme.muted("Terminal")}` : theme.bold(plainTitle);
  const titleWidth = displayWidth(plainTitle);
  const left = Math.max(0, Math.floor((columns - titleWidth) / 2));
  lines.push(`${" ".repeat(left)}${title}`);
  return `${lines.join("\n")}\n`;
}

/** Render the responsive Claude-like startup card used by interactive mode. */
export function renderWelcomeScreen(theme: Theme, options: WelcomeScreenOptions): string {
  const width = normalizedColumns(options.columns, 92);
  const compactHeight = options.rows !== undefined && Number.isFinite(options.rows) && options.rows < 20;
  const username = options.username?.replace(/[\r\n\t]/gu, " ").trim() || "friend";
  const apiStatus = options.apiKeyConfigured ? "API key connected" : "API key not configured";
  const title = `DeepSeek TUI v${options.version}`;
  const lines = [topBorder(theme, width, title)];

  if (compactHeight) {
    const compactRows: Cell[] = [
      { text: `Welcome back, ${username}!`, align: "center" },
      ...MINI_WHALE.map((text): Cell => ({ text, align: "center", tone: "whale" })),
      { text: `${options.model} · ${apiStatus}`, align: "center", tone: "muted" },
      { text: compactPath(options.cwd), align: "center", tone: "muted" },
      { text: "/login · /model · /resume · /dsh · /help", align: "center", tone: "muted" },
    ];
    for (const row of compactRows) lines.push(singleRow(theme, width, row));
  } else if (width >= 84) {
    const innerWidth = width - 2;
    const leftWidth = Math.floor((innerWidth - 1) * 0.56);
    const hasDetailedWhaleSpace =
      width >= 104 && options.rows !== undefined && Number.isFinite(options.rows) && options.rows >= 24;
    const whale = hasDetailedWhaleSpace ? DETAILED_WHALE : LARGE_WHALE;
    const left: Cell[] = [
      { text: `Welcome back, ${username}!`, align: "center", tone: "normal" },
      ...whale.map((text): Cell => ({ text, align: "center", tone: "whale" })),
      { text: `${options.model} · ${apiStatus}`, align: "center", tone: "muted" },
      { text: compactPath(options.cwd), align: "center", tone: "muted" },
    ];
    const right: Cell[] = [
      { text: "Tips for getting started", tone: "heading" },
      { text: "/login   Configure your API key" },
      { text: "/model   Switch the DeepSeek model" },
      { text: "/resume  Continue a past conversation" },
      { text: "/clear   Start a fresh conversation" },
      { text: "DeepSeek Harness", tone: "heading" },
      { text: "/dsh     Open the managed Web companion" },
      { text: "/usage   View API usage and top up" },
      { text: "/help    Show every command" },
      { text: "Unofficial client · Harness sessions stay separate", tone: "muted" },
    ];
    const height = Math.max(left.length, right.length);
    for (let index = 0; index < height; index += 1) {
      lines.push(
        twoColumnRow(
          theme,
          width,
          leftWidth,
          left[index] ?? { text: "" },
          right[index] ?? { text: "" },
        ),
      );
    }
  } else {
    const contentWidth = Math.max(0, width - 4);
    const whale = contentWidth >= 16 ? SMALL_WHALE : whaleFor(contentWidth);
    const rows: Cell[] = [
      { text: `Welcome back, ${username}!`, align: "center" },
      ...whale.map((text): Cell => ({ text, align: "center", tone: "whale" })),
      { text: options.model, align: "center", tone: "muted" },
      { text: apiStatus, align: "center", tone: "muted" },
      { text: compactPath(options.cwd), align: "center", tone: "muted" },
      { text: "Quick start", tone: "heading" },
      { text: "/login · /model · /resume · /clear" },
      { text: "/dsh Harness Web · /help commands", tone: "muted" },
      { text: "Unofficial community client", align: "center", tone: "muted" },
    ];
    for (const row of rows) lines.push(singleRow(theme, width, row));
  }

  lines.push(bottomBorder(theme, width));
  return `${lines.join("\n")}\n`;
}
