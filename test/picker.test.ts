import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";

import { LineInput, MenuPicker, type MenuPickerResult } from "../src/input.js";

class FakeInput extends PassThrough {
  readonly isTTY = true;
  isRaw = false;
  rawModeCalls = 0;

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    this.rawModeCalls += 1;
    return this;
  }
}

class FakeOutput extends PassThrough {
  readonly isTTY = true;
  columns = 80;
  rows = 24;
}

function picker(): { input: FakeInput; output: FakeOutput; run: (options: Parameters<MenuPicker["run"]>[0]) => Promise<MenuPickerResult> } {
  const input = new FakeInput();
  const output = new FakeOutput();
  return { input, output, run: (options) => new MenuPicker(input, output).run(options) };
}

async function settle(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

const ITEMS = ["选项一", "选项二", "选项三"];

test("MenuPicker navigates with arrow keys and confirms with Enter", async () => {
  const { input, run } = picker();
  const promise = run({ title: "标题", items: ITEMS });
  input.write("\u001b[B");
  input.write("\u001b[B");
  input.write("\r");
  assert.deepEqual(await promise, { kind: "index", index: 2 });
});

test("MenuPicker clamps upward navigation at the first option", async () => {
  const { input, run } = picker();
  const promise = run({ title: "标题", items: ITEMS });
  input.write("\u001b[A");
  input.write("\r");
  assert.deepEqual(await promise, { kind: "index", index: 0 });
});

test("MenuPicker survives split arrow-key byte sequences", async () => {
  const { input, run } = picker();
  const promise = run({ title: "标题", items: ITEMS });
  input.write("\u001b");
  await settle(10);
  input.write("[B");
  await settle(10);
  input.write("\r");
  assert.deepEqual(await promise, { kind: "index", index: 1 });
});

test("MenuPicker accepts digit jumps without custom mode", async () => {
  const { input, run } = picker();
  const promise = run({ title: "标题", items: ITEMS });
  input.write("3\r");
  assert.deepEqual(await promise, { kind: "index", index: 2 });
});

test("MenuPicker cancels on a lone Escape", async () => {
  const { input, run } = picker();
  const promise = run({ title: "标题", items: ITEMS });
  input.write("\u001b");
  assert.equal(await promise, undefined);
});

test("MenuPicker cancels on Ctrl+C in raw mode", async () => {
  const { input, run } = picker();
  const promise = run({ title: "标题", items: ITEMS });
  input.write("\u0003");
  assert.equal(await promise, undefined);
});

test("MenuPicker composes a custom value with typing and backspace", async () => {
  const { input, run } = picker();
  const promise = run({ title: "标题", items: ITEMS, allowCustom: true });
  input.write("deepseek-xx");
  input.write("\u007f");
  input.write("\u007f");
  input.write("v4-pro\r");
  assert.deepEqual(await promise, { kind: "custom", text: "deepseek-v4-pro" });
});

test("MenuPicker returns the highlighted item when Enter is pressed with empty custom text", async () => {
  const { input, run } = picker();
  const promise = run({ title: "标题", items: ITEMS, allowCustom: true });
  input.write("\u001b[B");
  input.write("\r");
  assert.deepEqual(await promise, { kind: "index", index: 1 });
});

test("MenuPicker renders a highlighted title, marker, and footer, then clears them", async () => {
  const { input, output, run } = picker();
  const promise = run({ title: "最近会话", items: ITEMS, footer: "↑/↓ 选择 · Enter 确认 · Esc 取消" });
  await settle(20);
  const rendered = output.read().toString();
  assert.match(rendered, /最近会话/);
  assert.match(rendered, /❯ 选项一/);
  assert.match(rendered, /↑\/↓ 选择/);
  input.write("\r");
  await promise;
  await settle(20);
  const after = output.read().toString();
  assert.match(after, /\u001b\[5A/u, "picker must move up and clear all of its own lines on finish");
});

test("MenuPicker restores raw mode and pauses input when finished", async () => {
  const { input, run } = picker();
  const promise = run({ title: "标题", items: ITEMS });
  await settle(10);
  assert.equal(input.isRaw, true);
  input.write("\r");
  await promise;
  assert.equal(input.isRaw, false);
});

test("MenuPicker rejects non-TTY input", async () => {
  const input = new PassThrough() as unknown as Parameters<MenuPicker["run"]>[0];
  const picker = new MenuPicker(input, new FakeOutput());
  await assert.rejects(picker.run({ title: "标题", items: ITEMS }), /TTY/);
});

test("LineInput survives a suspend/resume round-trip around a MenuPicker", async (t: TestContext) => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const lineInput = new LineInput({ input, output });
  t.after(() => lineInput.close());

  const answer = lineInput.next("❯ ");
  await settle(10);
  lineInput.suspendForMenu();
  const pickerPromise = new MenuPicker(input, output).run({ title: "选择", items: ITEMS });
  input.write("\u001b"); // Esc cancels the picker.
  const pickerResult = await pickerPromise;
  assert.deepEqual(pickerResult, undefined);
  lineInput.resumeFromMenu();
  await settle(20);

  input.write("hello\r");
  assert.equal(await answer, "hello");
});

test("LineInput still resolves normally when nothing suspends it", async (t: TestContext) => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const lineInput = new LineInput({ input, output });
  t.after(() => lineInput.close());
  const answer = lineInput.next("❯ ");
  input.write("plain\r");
  assert.equal(await answer, "plain");
});
