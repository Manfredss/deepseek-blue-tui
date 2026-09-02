import assert from "node:assert/strict";
import test from "node:test";

import { clipToWidth, padToWidth, stripAnsi, visibleWidth } from "../src/text-width.js";
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
