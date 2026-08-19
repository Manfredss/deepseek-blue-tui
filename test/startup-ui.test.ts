import assert from "node:assert/strict";
import test from "node:test";

import { renderLogo, renderWelcomeScreen } from "../src/logo.js";
import { createTheme } from "../src/theme.js";

const ANSI_CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const SGR = /\u001b\[([0-9;]*)m/g;
const DEEPSEEK_BLUE = "\u001b[38;2;77;107;254m";
const DEEPSEEK_BLUE_256 = "\u001b[38;5;63m";

function createTrueColorTheme() {
  return createTheme(true, { COLORTERM: "truecolor" });
}

const welcomeOptions = {
  cwd: "/Users/wenfei/Documents/Coding/Deepseek TUI",
  model: "deepseek-v4-flash",
  version: "0.1.0",
  apiKeyConfigured: false,
  username: "Wenfei Qi",
};

function stripAnsi(value: string): string {
  return value.replace(ANSI_CSI, "");
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

function visibleWidth(value: string): number {
  let width = 0;
  for (const character of stripAnsi(value)) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 0 || codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) continue;
    if (/\p{Mark}/u.test(character)) continue;
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

function assertFitsColumns(rendered: string, columns: number): void {
  for (const [index, line] of rendered.split("\n").entries()) {
    assert.ok(
      visibleWidth(line) <= columns,
      `line ${index + 1} is ${visibleWidth(line)} columns wide in a ${columns}-column terminal: ${JSON.stringify(stripAnsi(line))}`,
    );
  }
}

const WHALE_INK = /[▄█▀●]/u;

function whaleMetrics(rendered: string): {
  rows: number;
  width: number;
  hasEye: boolean;
} {
  const whaleRows = rendered
    .split("\n")
    .map(stripAnsi)
    .filter((line) => WHALE_INK.test(line));
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;

  for (const line of whaleRows) {
    for (const [index, character] of Array.from(line).entries()) {
      if (!WHALE_INK.test(character)) continue;
      left = Math.min(left, index);
      right = Math.max(right, index);
    }
  }

  return {
    rows: whaleRows.length,
    width: whaleRows.length === 0 ? 0 : right - left + 1,
    hasEye: whaleRows.some((line) => line.includes("●")),
  };
}

function assertHasNoBackgroundSgr(rendered: string): void {
  for (const match of rendered.matchAll(SGR)) {
    const parameters = (match[1] === "" ? [0] : match[1]?.split(";").map(Number)) ?? [];
    for (let index = 0; index < parameters.length; index += 1) {
      const parameter = parameters[index];
      if (parameter === 38) {
        // Extended foreground colors consume either `38;5;n` or `38;2;r;g;b`.
        index += parameters[index + 1] === 2 ? 4 : 2;
        continue;
      }
      const paintsBackground =
        parameter === 7 ||
        parameter === 48 ||
        (parameter !== undefined && parameter >= 40 && parameter <= 47) ||
        (parameter !== undefined && parameter >= 100 && parameter <= 107);
      assert.equal(
        paintsBackground,
        false,
        `startup UI must not emit background-color SGR, found ${JSON.stringify(match[0])}`,
      );
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertHasBlueWhaleInk(rendered: string, blue = DEEPSEEK_BLUE): void {
  const blueWhaleInk = new RegExp(
    `${escapeRegExp(blue)}(?:(?!\\u001b\\[0m)[\\s\\S])*?[▄█▀●]`,
  );
  assert.match(rendered, blueWhaleInk, "at least one whale glyph should be painted DeepSeek blue");
}

test("logo uses DeepSeek blue foreground without painting a terminal background", () => {
  const rendered = renderLogo(createTrueColorTheme(), { columns: 93 });

  assert.ok(rendered.includes(DEEPSEEK_BLUE), "logo should use the DeepSeek blue RGB foreground");
  assertHasNoBackgroundSgr(rendered);
  assertHasBlueWhaleInk(rendered);
});

test("plain startup UI never leaks ANSI sequences", () => {
  const theme = createTheme(false);
  const rendered = renderWelcomeScreen(theme, { ...welcomeOptions, columns: 93 });

  assert.equal(rendered.includes("\u001b["), false);
  assert.match(rendered, /DeepSeek/);
  assert.match(rendered, /deepseek-v4-flash/);
  assert.match(rendered, /0\.1\.0/);
  assert.match(rendered, /Wenfei Qi/);
});

test("welcome screen uses foreground styling only", () => {
  const rendered = renderWelcomeScreen(createTrueColorTheme(), { ...welcomeOptions, columns: 93 });

  assert.ok(rendered.includes(DEEPSEEK_BLUE));
  assertHasNoBackgroundSgr(rendered);
  assertHasBlueWhaleInk(rendered);
});

test("Apple Terminal uses the 256-color DeepSeek blue fallback without a white background", () => {
  const theme = createTheme(true, {
    TERM: "xterm-256color",
    TERM_PROGRAM: "Apple_Terminal",
  });
  const rendered = [
    renderLogo(theme, { columns: 93 }),
    renderWelcomeScreen(theme, { ...welcomeOptions, columns: 93 }),
  ].join("\n");

  assert.ok(rendered.includes(DEEPSEEK_BLUE_256));
  assert.equal(rendered.includes(DEEPSEEK_BLUE), false);
  assert.equal(rendered.includes("\u001b[107m"), false);
  assertHasNoBackgroundSgr(rendered);
  assertHasBlueWhaleInk(rendered, DEEPSEEK_BLUE_256);
});

test("logo and welcome screen fit common and narrow terminal widths", () => {
  const theme = createTrueColorTheme();

  for (const columns of [120, 93, 80, 60, 40, 24, 16]) {
    assertFitsColumns(renderLogo(theme, { columns }), columns);
    assertFitsColumns(renderWelcomeScreen(theme, { ...welcomeOptions, columns }), columns);
  }
});

test("wide welcome screen uses a larger, more detailed whale without overflowing", () => {
  const columns = 108;
  const rendered = renderWelcomeScreen(createTheme(false), {
    ...welcomeOptions,
    columns,
    rows: 27,
  });
  const whale = whaleMetrics(rendered);

  assert.ok(whale.rows >= 9, `wide-terminal whale should be at least 9 rows tall, got ${String(whale.rows)}`);
  assert.ok(whale.width >= 38, `wide-terminal whale should be at least 38 columns wide, got ${String(whale.width)}`);
  assert.equal(whale.hasEye, true, "wide-terminal whale should retain its visible eye");
  assertFitsColumns(rendered, columns);
});

test("medium welcome screen keeps the existing eight-row whale", () => {
  const columns = 91;
  const rendered = renderWelcomeScreen(createTheme(false), {
    ...welcomeOptions,
    columns,
    rows: 31,
  });

  assert.equal(whaleMetrics(rendered).rows, 8);
  assertFitsColumns(rendered, columns);
});

test("welcome screen switches to a compact-height layout in short terminals", () => {
  const rendered = renderWelcomeScreen(createTheme(false), {
    ...welcomeOptions,
    columns: 91,
    rows: 15,
  });
  const lines = rendered.trimEnd().split("\n");

  assert.ok(lines.length <= 10, `short-terminal card should stay compact, got ${String(lines.length)} lines`);
  assert.equal(whaleMetrics(rendered).rows, 3, "short-terminal card should keep the three-row mini whale");
  assertFitsColumns(rendered, 91);
  assert.match(rendered, /\/login/);
});
