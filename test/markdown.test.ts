import assert from "node:assert/strict";
import test from "node:test";

import { MarkdownStream, renderMarkdown } from "../src/markdown.js";
import { createTheme } from "../src/theme.js";
import { stripAnsi } from "../src/text-width.js";

const theme = createTheme(true, { COLORTERM: "truecolor" });
const plainTheme = createTheme(false);

/** Feeds text through the stream in chunks of `size` characters. */
function streamed(text: string, size: number, activeTheme = theme): string {
  const stream = new MarkdownStream({ theme: activeTheme });
  let out = "";
  for (let index = 0; index < text.length; index += size) {
    out += stream.write(text.slice(index, index + size));
  }
  return out + stream.end();
}

const SAMPLE = [
  "# 标题",
  "",
  "普通段落，带 `inline code` 和 **加粗**。",
  "",
  "- 第一项",
  "- 第二项",
  "",
  "```ts",
  "const x = 1; // 注释",
  'const s = "字符串 // 不是注释";',
  "```",
  "",
  "> 引用一行",
].join("\n");

test("streaming produces the same result regardless of how deltas are split", () => {
  const whole = streamed(SAMPLE, SAMPLE.length);
  for (const size of [1, 2, 3, 7, 13, 64]) {
    assert.equal(streamed(SAMPLE, size), whole, `chunk size ${size} must not change the output`);
  }
});

test("fenced code gets a labelled frame and a gutter", () => {
  const rendered = stripAnsi(renderMarkdown(SAMPLE, theme));
  assert.match(rendered, /┌─ ts/, "the language is shown on the opening frame");
  assert.match(rendered, /└─/, "the block is closed");
  assert.match(rendered, /│ const x = 1; \/\/ 注释/, "code lines carry the gutter");
});

test("code text survives rendering character for character", () => {
  const code = [
    "```python",
    "def f(a, b='x'):  # 注释里有 \"引号\"",
    "    return a /* not a comment in python */ b",
    "\tif a == 0xFF and b != 3.14: pass",
    "```",
  ].join("\n");
  const rendered = stripAnsi(renderMarkdown(code, theme));
  const bodyLines = rendered.split("\n").filter((line) => line.startsWith("│ "));
  assert.equal(bodyLines.length, 3);
  assert.deepEqual(
    bodyLines.map((line) => line.slice(2)),
    [
      "def f(a, b='x'):  # 注释里有 \"引号\"",
      "    return a /* not a comment in python */ b",
      "\tif a == 0xFF and b != 3.14: pass",
    ],
    "tinting must never add, drop or reorder a visible character",
  );
});

test("an unterminated code fence is closed when the stream ends", () => {
  const stream = new MarkdownStream({ theme });
  let out = stream.write("```js\nconst a = 1;\n");
  assert.equal(stream.insideCode, true);
  out += stream.end();
  assert.match(stripAnsi(out), /└─\s*$/u, "the block is closed so later output is not swallowed");
  assert.equal(stream.insideCode, false);
});

test("a fence only closes on its own marker", () => {
  const mixed = ["```md", "~~~", "still code", "```", "prose"].join("\n");
  const rendered = stripAnsi(renderMarkdown(mixed, theme));
  assert.match(rendered, /│ ~~~/, "a different fence character stays part of the code");
  assert.match(rendered, /│ still code/);
  assert.doesNotMatch(rendered.split("└─")[1] ?? "", /│/, "nothing after the close is treated as code");
});

test("terminal control characters in the reply never reach the output", () => {
  const ESC = "\u001b";
  const hostile = `正常文字 ${ESC}[2J${ESC}[H 危险\n\`\`\`sh\n${ESC}[31mrm -rf /\n\`\`\``;
  const rendered = renderMarkdown(hostile, theme);
  assert.doesNotMatch(rendered, /\u001b\[2J/u, "screen-clearing sequences must be stripped");
  assert.doesNotMatch(rendered, /\u001b\[H/u, "cursor-home sequences must be stripped");
  assert.match(stripAnsi(rendered), /\[2J/, "the text survives as inert characters");
});

test("inline markers are consumed, and emphasis does not fire mid-word", () => {
  const rendered = stripAnsi(renderMarkdown("**粗** 与 `码` 与 [链接](https://example.com)", theme));
  assert.match(rendered, /粗/);
  assert.doesNotMatch(rendered, /\*\*/, "bold markers are consumed");
  assert.doesNotMatch(rendered, /`/, "code ticks are consumed");
  assert.match(rendered, /链接 https:\/\/example\.com/, "links show their target");

  // snake_case must not be mistaken for emphasis.
  const identifier = stripAnsi(renderMarkdown("a_b_c 和 some_var_name", theme));
  assert.equal(identifier, "a_b_c 和 some_var_name");
});

test("headings, rules, quotes and lists are structural, not literal", () => {
  const rendered = stripAnsi(renderMarkdown(SAMPLE, theme));
  assert.match(rendered, /^标题$/mu, "the # marker is consumed");
  assert.match(rendered, /^• 第一项$/mu);
  assert.match(rendered, /▏ 引用一行/);
});

test("a plain theme emits no escape sequences at all", () => {
  const rendered = renderMarkdown(SAMPLE, plainTheme);
  assert.equal(rendered, stripAnsi(rendered), "NO_COLOR output must stay plain");
  assert.match(rendered, /┌─ ts/, "structure is still drawn without colour");
});
