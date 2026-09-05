import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  applyCompactSummary,
  attachmentMessage,
  buildContextBreakdown,
  COMPACT_INSTRUCTION,
  editPrompt,
  editorCommand,
  forkSessionAt,
  formatCompactTokens,
  formatSessionMarkdown,
  readAttachmentFile,
  searchMessages,
  userMessageIndexes,
} from "../src/session-tools.js";
import { createSession, type Session } from "../src/session-store.js";
import { EMPTY_USAGE, type ChatMessage } from "../src/types.js";

async function temporaryDirectory(t: TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function fixtureSession(overrides: Partial<Session> = {}): Session {
  return {
    ...createSession("/workspace", "deepseek-v4-flash"),
    messages: [
      { role: "user", content: "第一问", createdAt: "2026-01-01T00:00:01.000Z" },
      { role: "assistant", content: "第一答", reasoningContent: "想了一下", createdAt: "2026-01-01T00:00:02.000Z" },
      { role: "user", content: "第二问", createdAt: "2026-01-01T00:00:03.000Z" },
    ],
    ...overrides,
  };
}

test("formatCompactTokens compacts counts and guards non-finite input", () => {
  assert.equal(formatCompactTokens(988), "988");
  assert.equal(formatCompactTokens(3_400), "3.4k");
  assert.equal(formatCompactTokens(12_000), "12k");
  assert.equal(formatCompactTokens(1_000_000), "1.0M");
  assert.equal(formatCompactTokens(12_000_000), "12M");
  assert.equal(formatCompactTokens(-5), "0");
  assert.equal(formatCompactTokens(Number.NaN), "—");
  assert.equal(formatCompactTokens(Number.POSITIVE_INFINITY), "—");
});

test("buildContextBreakdown segments by role, includes thinking, and draws the bar", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "sys", createdAt: "2026-01-01T00:00:00.000Z" },
    { role: "user", content: "汉".repeat(100), createdAt: "2026-01-01T00:00:01.000Z" },
    {
      role: "assistant",
      content: "答",
      reasoningContent: "汉".repeat(50),
      createdAt: "2026-01-01T00:00:02.000Z",
    },
  ];
  const breakdown = buildContextBreakdown(messages, 10_000, 20);
  const labels = breakdown.segments.map((segment) => segment.label);
  assert.deepEqual(labels, ["system", "user", "assistant", "thinking"]);
  const thinking = breakdown.segments.find((segment) => segment.label === "thinking");
  assert.ok(thinking && thinking.tokens >= 50);
  assert.match(breakdown.bar, /^█*░*$/);
  assert.equal(breakdown.bar.length, 20);
  assert.ok(breakdown.total >= 150);
  assert.equal(breakdown.limit, 10_000);
});

test("formatSessionMarkdown renders a complete transcript including reasoning", () => {
  const markdown = formatSessionMarkdown(fixtureSession());
  assert.match(markdown, /^# /);
  assert.match(markdown, /会话 ID/);
  assert.match(markdown, /第一问/);
  assert.match(markdown, /> 思考过程：/);
  assert.match(markdown, /> 想了一下/);
});

test("searchMessages finds case-insensitive matches with line numbers and previews", () => {
  const session = fixtureSession({
    messages: [
      { role: "user", content: "第一行\n第二行含关键词\n第三行", createdAt: "2026-01-01T00:00:01.000Z" },
      { role: "assistant", content: "关键词也在这里", createdAt: "2026-01-01T00:00:02.000Z" },
    ],
  });
  const hits = searchMessages(session.messages, "关键词");
  assert.equal(hits.length, 2);
  assert.equal(hits[0]?.index, 0);
  assert.equal(hits[0]?.lineNumber, 2);
  assert.equal(hits[1]?.role, "assistant");
  assert.deepEqual(searchMessages(session.messages, "不存在"), []);
  assert.deepEqual(searchMessages(session.messages, "  "), []);
});

test("applyCompactSummary replaces history with a single system message", () => {
  const messages = applyCompactSummary("这里是摘要");
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.role, "system");
  assert.match(messages[0]?.content ?? "", /这里是摘要/);
  assert.match(messages[0]?.content ?? "", /^\[历史对话摘要\]/);
  assert.match(COMPACT_INSTRUCTION, /压缩/);
});

test("forkSessionAt creates a new session up to the selected user message", () => {
  const original = fixtureSession();
  const fork = forkSessionAt(original, 2);
  assert.notEqual(fork.id, original.id);
  assert.match(fork.title, /rewind/);
  assert.equal(fork.messages.length, 3);
  assert.equal(fork.messages[2]?.content, "第二问");
  assert.equal(original.messages.length, 3, "the original session must stay intact");
});

test("userMessageIndexes lists only user-role message positions", () => {
  assert.deepEqual(userMessageIndexes(fixtureSession()), [0, 2]);
  assert.deepEqual(userMessageIndexes(fixtureSession({ messages: [] })), []);
});

test("readAttachmentFile resolves paths, rejects binary and oversized files", async (t) => {
  const directory = await temporaryDirectory(t, "deepseek-attach-");
  await mkdir(join(directory, "nested"), { recursive: true });

  const text = join(directory, "nested", "note.txt");
  await writeFile(text, "你好，附件内容\n第二行\n", "utf8");
  const result = await readAttachmentFile("nested/note.txt", directory);
  assert.equal(result.ok, true);
  assert.equal(result.path, text);
  assert.equal(result.content, "你好，附件内容\n第二行");
  assert.equal(attachmentMessage(text, result.content ?? ""), `@${text}\n\`\`\`\n你好，附件内容\n第二行\n\`\`\``);

  const missing = await readAttachmentFile("missing.txt", directory);
  assert.equal(missing.ok, false);
  assert.match(missing.error ?? "", /不存在/);

  const binary = join(directory, "blob.bin");
  await writeFile(binary, Buffer.from([0x00, 0x01, 0x02]));
  const binaryResult = await readAttachmentFile("blob.bin", directory);
  assert.equal(binaryResult.ok, false);
  assert.match(binaryResult.error ?? "", /二进制/);

  const big = join(directory, "big.txt");
  await writeFile(big, "a".repeat(512), "utf8");
  const bigResult = await readAttachmentFile("big.txt", directory, 128);
  assert.equal(bigResult.ok, false);
  assert.match(bigResult.error ?? "", /过大/);

  const directoryResult = await readAttachmentFile("nested", directory);
  assert.equal(directoryResult.ok, false);
  assert.match(directoryResult.error ?? "", /不是普通文件/);
});

test("editorCommand honors VISUAL over EDITOR and falls back per platform", () => {
  assert.deepEqual(editorCommand({ VISUAL: "code -w" }), { command: "code", args: ["-w"] });
  assert.deepEqual(editorCommand({ EDITOR: "nvim" }), { command: "nvim", args: [] });
  assert.deepEqual(editorCommand({ VISUAL: "  ", EDITOR: "vim" }), { command: "vim", args: [] });
  const fallback = editorCommand({});
  assert.ok(fallback.command === "vi" || fallback.command === "notepad");
});

test("editPrompt runs the editor, reads the draft back, and reports failures", async (t) => {
  const directory = await temporaryDirectory(t, "deepseek-edit-");
  const fakeEditor = join(directory, "fake-editor");
  const marker = join(directory, "editor-ran.txt");

  // Emulate the editor writing into the draft file (its last argument),
  // which is exactly what a real editor does on save. The writes must be
  // synchronous: this stands in for spawnSync, so editPrompt reads the draft
  // back the instant this returns. Firing unawaited promise writes here left
  // the draft truncated-but-empty at that moment, which surfaced as a flaky
  // "编辑器内容为空" failure on slower runners.
  const spawnImpl = ((command: string, args: string[]) => {
    if (command !== fakeEditor) return { status: 0, error: undefined, stdout: "", stderr: "" };
    const target = args.at(-1);
    if (target) {
      writeFileSync(target, "编辑后的多行内容\n第二行\n", "utf8");
      writeFileSync(marker, "ran\n", "utf8");
    }
    return { status: 0, error: undefined, stdout: "", stderr: "" };
  }) as unknown as typeof import("node:child_process")["spawnSync"];

  const result = await editPrompt({
    initial: "初始草稿",
    env: { ...process.env, VISUAL: fakeEditor, TMPDIR: directory },
    spawnImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, "编辑后的多行内容\n第二行");
  assert.equal((await readFile(marker, "utf8")).trim(), "ran");

  const failingSpawn = (() => ({ status: 1, error: undefined, stdout: "", stderr: "" })) as unknown as typeof import("node:child_process")["spawnSync"];
  const failed = await editPrompt({ env: { ...process.env, VISUAL: fakeEditor, TMPDIR: directory }, spawnImpl: failingSpawn });
  assert.equal(failed.ok, false);
  assert.match(failed.error ?? "", /退出码/);
});
