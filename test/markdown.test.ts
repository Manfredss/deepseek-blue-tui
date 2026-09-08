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

// ---------------------------------------------------------------------------
// Streaming latency: holding a paragraph until its newline leaves the screen
// blank for as long as the paragraph takes to generate.
// ---------------------------------------------------------------------------

test("prose appears as it arrives rather than waiting for the newline", () => {
  const stream = new MarkdownStream({ theme: plainTheme });
  const opening = stream.write("这是一个");
  assert.equal(opening, "这是一个", "the first characters must reach the terminal immediately");
  assert.equal(stream.write("很长的段落"), "很长的段落", "and so must each later chunk");
  assert.equal(stream.end(), "");
});

test("a list item streams its text once the marker resolves", () => {
  const stream = new MarkdownStream({ theme: plainTheme });
  assert.equal(stream.write("- "), "", "a bare marker could still be a horizontal rule");
  assert.match(stream.write("第一项"), /• 第一项$/u, "once it is a bullet, the text flows");
  assert.equal(stream.write("的后半段"), "的后半段");
  stream.end();
});

test("lines whose meaning needs the whole line are still held", () => {
  for (const [label, partial] of [
    ["fence", "```t"],
    ["heading", "# 标"],
    ["quote", "> 引"],
    ["table", "| a "],
  ] as const) {
    const stream = new MarkdownStream({ theme: plainTheme });
    assert.equal(stream.write(partial), "", `${label} must not be emitted half-classified`);
    stream.end();
  }
});

test("an unclosed inline marker holds back only its own tail", () => {
  const stream = new MarkdownStream({ theme });
  // Everything before the backtick is safe; the backtick might still close.
  assert.equal(stripAnsi(stream.write("先看 `estimate")), "先看 ");
  const closed = stream.write("Tokens` 这个函数");
  assert.equal(stripAnsi(closed), "estimateTokens 这个函数", "the construct renders once it closes");
  assert.match(closed, /\u001b\[36m/u, "and it is styled as inline code");
  stream.end();
});

test("streaming a code block still frames it correctly", () => {
  const stream = new MarkdownStream({ theme: plainTheme });
  let out = stream.write("```ts\n");
  assert.match(out, /┌─ ts/, "the header appears once the fence line completes");
  out += stream.write("const x");
  out += stream.write(" = 1;\n");
  assert.match(out, /│ const x = 1;/, "code is emitted a line at a time");
  out += stream.write("```");
  out += stream.end();
  assert.match(out, /└─/);
});
