/** Terminal display-width helpers shared by menu and context rendering. */

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

/** Display width of a plain (ANSI-free) string: CJK counts as two cells. */
export function visibleWidth(value: string): number {
  let width = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) continue;
    if (/\p{Mark}/u.test(character)) continue;
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

/**
 * Clips a string to a terminal display width. ANSI control sequences and
 * combining marks are preserved but count zero cells; CJK counts two.
 */
export function clipToWidth(value: string, width: number): string {
  if (width <= 0) return "";
  let used = 0;
  let result = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const zeroWidth =
      codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) || /\p{Mark}/u.test(character);
    if (zeroWidth) {
      result += character;
      continue;
    }
    const advance = isWideCodePoint(codePoint) ? 2 : 1;
    if (used + advance > width - 1) return `${result}…`;
    result += character;
    used += advance;
  }
  return result;
}
