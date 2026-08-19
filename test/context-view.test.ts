import assert from "node:assert/strict";
import test from "node:test";

import {
  renderContextHud,
  renderContextReport,
  type ContextViewState,
} from "../src/context-view.js";
import { createTheme } from "../src/theme.js";

const ANSI_CSI = /\u001b\[[0-?]*[ -/]*[@-~]/gu;

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
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) continue;
    if (/\p{Mark}/u.test(character)) continue;
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

function assertFitsColumns(rendered: string, columns: number): void {
  for (const [index, line] of rendered.split("\n").entries()) {
    assert.ok(
      visibleWidth(line) <= columns,
      `line ${String(index + 1)} is ${String(visibleWidth(line))} columns wide in a ${String(columns)}-column terminal: ${JSON.stringify(stripAnsi(line))}`,
    );
  }
}

const baseState: ContextViewState = {
  model: "deepseek-v4-flash",
  estimatedTokens: 32_768,
  limitTokens: 131_072,
  messageCount: 12,
  showReasoning: false,
  readOnly: false,
  apiKeyConfigured: true,
  usage: {
    promptTokens: 1_200,
    completionTokens: 800,
    totalTokens: 2_000,
    promptCacheHitTokens: 400,
    promptCacheMissTokens: 800,
    reasoningTokens: 100,
  },
  cwd: "/Users/wenfei/Documents/Coding/Deepseek TUI",
};

test("context HUD and report stay within responsive terminal widths", () => {
  const theme = createTheme(false);

  for (const columns of [108, 72, 44, 24]) {
    assertFitsColumns(renderContextHud(theme, baseState, { columns }), columns);
    assertFitsColumns(renderContextReport(theme, baseState, { columns }), columns);
  }
});

test("context HUD presents estimated context, reasoning visibility, and real session access", () => {
  const theme = createTheme(false);
  const writable = stripAnsi(renderContextHud(theme, baseState, { columns: 108 }));
  const readOnly = stripAnsi(
    renderContextHud(
      theme,
      { ...baseState, estimatedTokens: 65_536, showReasoning: true, readOnly: true },
      { columns: 108 },
    ),
  );

  assert.match(writable, /≈25%/u, "context percentage must be marked as an estimate");
  assert.match(writable, /reasoning\s+hidden/iu);
  assert.match(writable, /\bRW\b/u);
  assert.match(readOnly, /≈50%/u);
  assert.match(readOnly, /reasoning\s+shown/iu);
  assert.match(readOnly, /\bRO\b/u);
});

test("read-only context report warns that messages will not be saved", () => {
  const rendered = stripAnsi(
    renderContextReport(createTheme(false), { ...baseState, readOnly: true }, { columns: 72 }),
  );

  assert.match(rendered, /(?:消息不会保存|messages? (?:will )?not be saved)/iu);
});

test("detailed context report includes cumulative token and cache accounting", () => {
  const rendered = stripAnsi(renderContextReport(createTheme(false), baseState, { columns: 108 }));

  assert.match(rendered, /(?:累计|total)/iu);
  assert.match(rendered, /2(?:,|\s)?000/u);
  assert.match(rendered, /(?:缓存|cache)/iu);
  assert.match(rendered, /400/u);
  assert.match(rendered, /12/u, "report should include the real message count");
});

test("context views expose only API ready or missing state and never inspect the environment key", (t) => {
  const secret = "sk-super-secret-context-view-test-key";
  const previous = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = secret;
  t.after(() => {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
  });

  const ready = [
    renderContextHud(createTheme(false), baseState, { columns: 108 }),
    renderContextReport(createTheme(false), baseState, { columns: 108 }),
  ].join("\n");
  const missing = [
    renderContextHud(createTheme(false), { ...baseState, apiKeyConfigured: false }, { columns: 108 }),
    renderContextReport(createTheme(false), { ...baseState, apiKeyConfigured: false }, { columns: 108 }),
  ].join("\n");

  assert.match(stripAnsi(ready), /API\s+ready/iu);
  assert.match(stripAnsi(missing), /API\s+missing/iu);
  assert.doesNotMatch(`${ready}\n${missing}`, new RegExp(secret, "u"));
  assert.doesNotMatch(stripAnsi(`${ready}\n${missing}`), /sk-[a-z0-9-]{8,}/iu);
});

test("context pressure changes foreground severity at 80 and 100 percent", () => {
  const theme = createTheme(true, { TERM: "xterm" });
  const warning = renderContextHud(
    theme,
    { ...baseState, estimatedTokens: 80, limitTokens: 100 },
    { columns: 108 },
  );
  const danger = renderContextHud(
    theme,
    { ...baseState, estimatedTokens: 100, limitTokens: 100 },
    { columns: 108 },
  );

  assert.match(warning, /\u001b\[33m/u, "80% context should use the warning foreground");
  assert.doesNotMatch(warning, /\u001b\[31m/u, "80% context should not use the danger foreground");
  assert.match(danger, /\u001b\[31m/u, "100% context should use the danger foreground");
});

test("invalid context limits never render NaN or Infinity", () => {
  const theme = createTheme(false);

  for (const limitTokens of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const state = { ...baseState, limitTokens };
    const rendered = `${renderContextHud(theme, state, { columns: 44 })}\n${renderContextReport(theme, state, { columns: 44 })}`;
    assert.doesNotMatch(rendered, /(?:NaN|-?Infinity)/u);
    assertFitsColumns(rendered, 44);
  }
});

test("context views do not invent agent effort, permissions, or enabled tools", () => {
  const theme = createTheme(false);
  const rendered = [
    renderContextHud(theme, baseState, { columns: 108 }),
    renderContextReport(theme, baseState, { columns: 108 }),
  ].join("\n");

  assert.doesNotMatch(rendered, /\beffort\b|\bxhigh\b|\bpermissions?\b|tools?\s+enabled/iu);
});
