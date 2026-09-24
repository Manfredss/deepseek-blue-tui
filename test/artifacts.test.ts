import assert from "node:assert/strict";
import test from "node:test";

import { clipboardCommand, osc52, OSC52_MAX_BYTES } from "../src/clipboard.js";
import { diffLines, looksLikeEdit, renderDiff, summarizeDiff } from "../src/diff.js";
import { extractCodeBlocks, isOutputBlock, MarkdownStream } from "../src/markdown.js";
import { createTheme } from "../src/theme.js";

/**
 * Turning an answer into something usable: the code blocks it contains, the
 * clipboard route out of the terminal, and the diff against the file that was
 * attached in the first place.
 */

const PLAIN = createTheme(false);

test("code blocks are collected verbatim however the stream is chopped up", () => {
  const reply = "看这里：\n\n```python\nif x:  # 注意\n    print('hi')\n```\n\n还有一个：\n\n```\nplain\n```\n";
  for (const size of [1, 3, 7, 1_000]) {
    const stream = new MarkdownStream({ theme: PLAIN, numberFrom: 1 });
    for (let index = 0; index < reply.length; index += size) stream.write(reply.slice(index, index + size));
    stream.end();
    assert.deepEqual(
      stream.blocks.map((block) => [block.index, block.language, block.code]),
      [
        [1, "python", "if x:  # 注意\n    print('hi')"],
        [2, "", "plain"],
      ],
      `chunk size ${size} must not change what was in the block`,
    );
  }
});

test("numbering continues from where the session left off, and shows in the frame", () => {
  const stream = new MarkdownStream({ theme: PLAIN, numberFrom: 7 });
  const drawn = `${stream.write("```ts\nconst a = 1;\n```\n")}${stream.end()}`;
  assert.match(drawn, /┌─ \[7\] ts/u);
  assert.equal(stream.blocks[0]?.index, 7);

  // Unnumbered rendering still collects, it just does not label.
  const quiet = new MarkdownStream({ theme: PLAIN });
  quiet.write("```\nx\n```\n");
  quiet.end();
  assert.equal(quiet.blocks.length, 1);
});

test("an answer cut off mid-block still yields the code that arrived", () => {
  const blocks = extractCodeBlocks("```js\nconst half = tru");
  assert.deepEqual(blocks, [{ index: 1, language: "js", code: "const half = tru" }]);
});

test("output blocks are told apart from source blocks", () => {
  const blocks = extractCodeBlocks("```python\nprint(1)\n```\n输出：\n```text\n1\n```\n");
  assert.equal(blocks.length, 2);
  assert.equal(isOutputBlock(blocks[0]!), false);
  assert.equal(isOutputBlock(blocks[1]!), true, "an answer's own output is not what /copy means");
  // Untagged blocks are judged separately (see the next test); a bare word is
  // no evidence of source.
  assert.equal(isOutputBlock({ index: 1, language: "", code: "x" }), true);
  assert.equal(isOutputBlock({ index: 1, language: "", code: "def f():\n    return 1" }), false);
  assert.equal(isOutputBlock({ index: 1, language: "CONSOLE", code: "x" }), true);
  assert.equal(isOutputBlock({ index: 1, language: "json", code: "{}" }), false, "data is still worth copying");
});

test("an untagged block is judged by its introduction, then by its content", () => {
  // The shape that broke the first attempt: the model tags one output block
  // and leaves the next one bare.
  const answer = [
    "以下是实现：",
    "",
    "```cpp",
    "#include <vector>",
    "void f() { return; }",
    "```",
    "",
    "运行示例输出：",
    "```",
    "原始数组: 0.78 0.17",
    "排序结果: 0.12 0.17",
    "```",
  ].join("\n");
  const blocks = extractCodeBlocks(answer);
  assert.equal(blocks[0]?.intro, "以下是实现：", "the prose above a fence is kept with it");
  assert.equal(blocks[1]?.intro, "运行示例输出：");
  assert.equal(isOutputBlock(blocks[0]!), false);
  assert.equal(isOutputBlock(blocks[1]!), true, "untagged output is still output");

  // No announcement either: then only the content can say.
  const bare = extractCodeBlocks("```\n原始数组: 29 25 3\n排序结果: 3 25 29\n```")[0];
  assert.equal(isOutputBlock(bare!), true);

  // A bare shell command is exactly the kind of block people copy.
  const command = extractCodeBlocks("安装：\n\n```\nnpm install -g .\n```")[0];
  assert.equal(isOutputBlock(command!), false);
  const snippet = extractCodeBlocks("```\nif (x) {\n  return 1;\n}\n```")[0];
  assert.equal(isOutputBlock(snippet!), false);
});

test("one line of prose introduces one block, not every block that follows", () => {
  // Output block, then a source block right after it with no prose between:
  // inheriting "运行结果：" would misfile the source block as output.
  const blocks = extractCodeBlocks("运行结果：\n\n```\n3 9 21\n```\n\n```\nif (x) {\n  return 1;\n}\n```");
  assert.equal(blocks[0]?.intro, "运行结果：");
  assert.equal(blocks[1]?.intro, undefined, "the second fence has no introduction of its own");
  assert.equal(isOutputBlock(blocks[0]!), true);
  assert.equal(isOutputBlock(blocks[1]!), false);
});

test("the clipboard route depends on the platform, and can be overridden", () => {
  const none = (): boolean => false;
  assert.equal(clipboardCommand("darwin", {}, none)?.command, "pbcopy");
  assert.equal(clipboardCommand("win32", {}, none)?.command, "clip");
  assert.equal(clipboardCommand("linux", {}, none), undefined, "no tool installed means no command");

  assert.equal(clipboardCommand("linux", { WAYLAND_DISPLAY: "wayland-0" }, () => true)?.command, "wl-copy");
  assert.equal(clipboardCommand("linux", {}, (command) => command === "xclip")?.command, "xclip");
  assert.equal(clipboardCommand("linux", {}, (command) => command === "xsel")?.command, "xsel");
  // An X11 tool is preferred over wl-copy when there is no Wayland display.
  assert.equal(clipboardCommand("linux", {}, () => true)?.command, "xclip");

  assert.equal(clipboardCommand("darwin", { DEEPSEEK_TUI_CLIPBOARD: " my-copy " }, none)?.command, "my-copy");
});

test("OSC 52 carries base64 and has a size the terminal will accept", () => {
  assert.equal(osc52("hi"), `]52;c;${Buffer.from("hi").toString("base64")}`);
  assert.ok(OSC52_MAX_BYTES > 10_000, "the cap is a terminal limit, not a token limit");
});

test("a diff reports what changed, and gives up when nothing is recognisable", () => {
  const before = ["def f():", "    return 1", "", "print(f())"];
  const after = ["def f():", "    return 2", "", "print(f())"];
  const ops = diffLines(before, after);
  assert.ok(ops);
  assert.deepEqual(summarizeDiff(ops), { added: 1, removed: 1, kept: 3 });
  assert.equal(looksLikeEdit(ops, before.length, after.length), true);

  const unrelated = diffLines(before, ["package main", "func main() {}"]);
  assert.ok(unrelated);
  assert.equal(looksLikeEdit(unrelated, before.length, 2), false, "a rewrite is not an edit");

  assert.equal(diffLines(["a"], ["b"], 0), undefined, "past the edit budget there is no useful diff");
  assert.deepEqual(summarizeDiff(diffLines(before, before) ?? []), { added: 0, removed: 0, kept: 4 });
});

test("rendering collapses untouched runs instead of reprinting the file", () => {
  const before = Array.from({ length: 30 }, (_value, index) => `line ${String(index)}`);
  const after = [...before];
  after[15] = "line fifteen, changed";
  const ops = diffLines(before, after);
  assert.ok(ops);
  const lines = renderDiff(ops, PLAIN, { context: 1 });
  assert.ok(
    lines.some((line) => line.includes("⋯") && line.includes("行未变")),
    "the untouched majority is summarized",
  );
  assert.ok(lines.some((line) => line.startsWith("- line 15")));
  assert.ok(lines.some((line) => line.startsWith("+ line fifteen, changed")));
  assert.ok(lines.length < 15, `only the neighbourhood of the change is printed, got ${String(lines.length)}`);
});
