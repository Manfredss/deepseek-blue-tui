import assert from "node:assert/strict";
import test from "node:test";

import { clipToWidth, padToWidth, shortenPath, stripAnsi, visibleWidth } from "../src/text-width.js";
import { createTheme } from "../src/theme.js";

const theme = createTheme(true, { COLORTERM: "truecolor" });

test("visibleWidth ignores ANSI sequences and counts CJK as two cells", () => {
  assert.equal(visibleWidth("abc"), 3);
  assert.equal(visibleWidth("上下文"), 6);
  assert.equal(visibleWidth(theme.yellow("abc")), 3);
  assert.equal(visibleWidth(theme.bold(theme.brightBlue("上下文"))), 6);
});

test("clipToWidth keeps strings that exactly fill the width", () => {
  assert.equal(clipToWidth("abc", 3), "abc");
  assert.equal(clipToWidth("上下文", 6), "上下文");
  assert.equal(clipToWidth("abcd", 3), "ab…");
  assert.equal(clipToWidth("上下文", 5), "上下…");
  assert.equal(clipToWidth("abc", 1), "…");
  assert.equal(clipToWidth("abc", 0), "");
});

test("clipToWidth measures colored text by its visible cells, not its escapes", () => {
  const colored = `${theme.yellow("≈95%")} ${theme.muted("剩余")}`;
  assert.equal(visibleWidth(colored), visibleWidth("≈95% 剩余"));

  const kept = clipToWidth(colored, visibleWidth("≈95% 剩余"));
  assert.equal(kept, colored, "a colored string that fits must survive untouched");

  const clipped = clipToWidth(colored, 6);
  assert.equal(stripAnsi(clipped), "≈95% …");
  assert.ok(clipped.endsWith("\u001b[0m"), "a clipped colored string must reset so color cannot bleed");
  assert.ok(visibleWidth(clipped) <= 6);
});

test("padToWidth fills to an exact display width in every alignment", () => {
  assert.equal(padToWidth("ab", 5), "ab   ");
  assert.equal(padToWidth("ab", 5, "right"), "   ab");
  assert.equal(padToWidth("ab", 6, "center"), "  ab  ");
  assert.equal(visibleWidth(padToWidth("模型", 8)), 8);
  assert.equal(visibleWidth(padToWidth(theme.bold("模型"), 8)), 8);
  assert.equal(visibleWidth(padToWidth("这是一段很长的标签", 6)), 6);
});

test("shortenPath collapses the home directory and keeps the tail of a long path", () => {
  const home = "/Users/wenfei";
  const path = "/Users/wenfei/Documents/Coding/Deepseek TUI";

  assert.equal(shortenPath(path, 80, home), "~/Documents/Coding/Deepseek TUI");
  assert.equal(shortenPath(path, 31, home), "~/Documents/Coding/Deepseek TUI", "an exact fit is left alone");

  // The trailing segments say which project this is, so they are what survive.
  const clipped = shortenPath(path, 24, home);
  assert.equal(visibleWidth(clipped), 24);
  assert.ok(clipped.startsWith("\u2026"));
  assert.ok(clipped.endsWith("Deepseek TUI"), `tail must survive, got ${clipped}`);

  assert.equal(shortenPath(path, 1, home), "\u2026");
  assert.equal(shortenPath(path, 0, home), "");
  assert.equal(shortenPath("   ", 20, home), ".");
});

test("shortenPath only collapses a real home prefix and measures CJK by cells", () => {
  const home = "/Users/wenfei";
  assert.equal(shortenPath("/Users/wenfeiqi/x", 40, home), "/Users/wenfeiqi/x", "a sibling directory is not $HOME");
  assert.equal(shortenPath(home, 40, home), "~");
  assert.equal(shortenPath("/Users/wenfei/\u6587\u6863", 40, home), "~/\u6587\u6863");

  const cjk = shortenPath("/Users/wenfei/\u6587\u6863/\u7f16\u7a0b/\u6df1\u5ea6\u6c42\u7d22\u9879\u76ee", 16, home);
  assert.ok(visibleWidth(cjk) <= 16, `${cjk} must fit 16 cells, measured ${visibleWidth(cjk)}`);
  assert.ok(cjk.endsWith("\u6df1\u5ea6\u6c42\u7d22\u9879\u76ee"));
});
