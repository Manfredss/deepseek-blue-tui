/** Terminal display-width helpers shared by menu, logo and context rendering. */

/** CSI escape sequences — the only escape family this client emits. */
const ANSI_CSI_GLOBAL = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
const ANSI_CSI_STICKY = /\u001b\[[0-?]*[ -/]*[@-~]/uy;
const RESET = "\u001b[0m";

/** Removes SGR/CSI sequences so only printable cells remain. */
export function stripAnsi(value: string): string {
  return value.replace(ANSI_CSI_GLOBAL, "");
}

export function isWideCodePoint(codePoint: number): boolean {
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

function isZeroWidth(character: string, codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) || /\p{Mark}/u.test(character);
}

/** Display width of a string: ANSI sequences are free, CJK counts as two cells. */
export function visibleWidth(value: string): number {
  let width = 0;
  for (const character of stripAnsi(value)) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (isZeroWidth(character, codePoint)) continue;
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

/**
 * Clips a string to a terminal display width. Strings that already fit are
 * returned untouched; longer ones end in `…`. ANSI sequences are copied
 * verbatim and cost no cells, so colored text clips at the same column as
 * the equivalent plain text.
 */
export function clipToWidth(value: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(value) <= width) return value;
  if (width === 1) return "…";
  let used = 0;
  let result = "";
  let styled = false;
  let index = 0;
  while (index < value.length) {
    ANSI_CSI_STICKY.lastIndex = index;
    const escape = ANSI_CSI_STICKY.exec(value);
    if (escape?.[0]) {
      result += escape[0];
      index = ANSI_CSI_STICKY.lastIndex;
      styled = true;
      continue;
    }
    const codePoint = value.codePointAt(index) ?? 0;
    const character = String.fromCodePoint(codePoint);
    index += character.length;
    if (isZeroWidth(character, codePoint)) {
      result += character;
      continue;
    }
    const advance = isWideCodePoint(codePoint) ? 2 : 1;
    if (used + advance > width - 1) break;
    result += character;
    used += advance;
  }
  // Clipping can cut a string before its closing SGR; reset so the discarded
  // tail's color cannot bleed across the rest of the line.
  return `${result}…${styled ? RESET : ""}`;
}

/**
 * Shortens a filesystem path for a fixed display width. `home` collapses to
 * `~`, and an over-long path keeps its **tail** (`…/project/src`) rather than
 * its head: the trailing segments are what identify a working directory, so
 * clipping them the way `clipToWidth` does throws away the useful half.
 */
export function shortenPath(value: string, width: number, home?: string): string {
  const normalized = stripAnsi(value).replace(/[\r\n\t]/gu, " ").trim();
  if (!normalized) return ".";
  const root = home?.replace(/[\\/]+$/u, "");
  const collapsed =
    root && root.length > 1 && (normalized === root || /^[\\/]/u.test(normalized.slice(root.length)))
      ? `~${normalized.slice(root.length)}`
      : normalized;
  if (width <= 0) return "";
  if (visibleWidth(collapsed) <= width) return collapsed;
  if (width === 1) return "…";
  const characters = [...collapsed];
  let used = 0;
  let index = characters.length;
  while (index > 0) {
    const character = characters[index - 1] ?? "";
    const codePoint = character.codePointAt(0) ?? 0;
    const advance = isZeroWidth(character, codePoint) ? 0 : isWideCodePoint(codePoint) ? 2 : 1;
    if (used + advance > width - 1) break;
    used += advance;
    index -= 1;
  }
  return `…${characters.slice(index).join("")}`;
}

export type Align = "left" | "center" | "right";

/** Clips then pads a string to exactly `width` display cells. */
export function padToWidth(value: string, width: number, align: Align = "left"): string {
  if (width <= 0) return "";
  const clipped = clipToWidth(value, width);
  const remaining = Math.max(0, width - visibleWidth(clipped));
  if (align === "center") {
    const left = Math.floor(remaining / 2);
    return `${" ".repeat(left)}${clipped}${" ".repeat(remaining - left)}`;
  }
  if (align === "right") return `${" ".repeat(remaining)}${clipped}`;
  return `${clipped}${" ".repeat(remaining)}`;
}
