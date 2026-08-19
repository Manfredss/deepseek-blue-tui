import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";

import { LineInput } from "../src/input.js";

class TtyInput extends PassThrough {
  readonly isTTY = true;
  isRaw = false;

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    return this;
  }
}

function createInput(t: TestContext): { input: TtyInput; lineInput: LineInput; output: PassThrough } {
  const input = new TtyInput();
  const output = new PassThrough();
  output.resume();
  const lineInput = new LineInput({ input, output });
  t.after(() => lineInput.close());
  return { input, lineInput, output };
}

test("TTY bracketed paste mode is enabled and restored on close", () => {
  const input = new TtyInput();
  const output = new PassThrough();
  let rendered = "";
  output.on("data", (chunk: Buffer) => {
    rendered += chunk.toString();
  });
  const lineInput = new LineInput({ input, output });
  assert.match(rendered, /\u001b\[\?2004h/);
  lineInput.close();
  assert.match(rendered, /\u001b\[\?2004l/);
});

test("bracketed multiline paste is returned as one input with its newlines intact", async (t) => {
  const { input, lineInput } = createInput(t);
  const result = lineInput.next("❯ ");

  input.write("\u001b[200~first line\nsecond line\r\nthird line\u001b[201~\r");

  assert.equal(await result, "first line\nsecond line\r\nthird line");
});

test("paste markers and UTF-8 characters survive arbitrary chunk boundaries", async (t) => {
  const { input, lineInput } = createInput(t);
  const result = lineInput.next("❯ ");
  const bytes = Buffer.from("before \u001b[200~鲸鱼\n第二行\u001b[201~ after\r");

  for (const byte of bytes) input.write(Buffer.from([byte]));

  assert.equal(await result, "before 鲸鱼\n第二行 after");
});

test("Enter immediately after a paste does not queue its internal lines", async (t) => {
  const { input, lineInput } = createInput(t);
  const pasted = lineInput.next("❯ ");

  input.write("\u001b[20");
  input.write("0~alpha\nbeta\u001b[20");
  input.write("1~\r");
  assert.equal(await pasted, "alpha\nbeta");

  const ordinary = lineInput.next("❯ ");
  input.write("next message\r");
  assert.equal(await ordinary, "next message");
});

test("ordinary line input remains unchanged", async (t) => {
  const { input, lineInput } = createInput(t);
  const first = lineInput.next("❯ ");
  input.write("one\r");
  assert.equal(await first, "one");

  const second = lineInput.next("❯ ");
  input.write("two\r");
  assert.equal(await second, "two");
});

test("split CSI arrow keys survive the paste-marker prefix timer", async (t) => {
  const { input, lineInput } = createInput(t);
  const result = lineInput.next("❯ ");

  input.write("ac");
  input.write("\u001b");
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  input.write("[");
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  input.write("D");
  input.write("\r");

  assert.equal(await result, "ac", "a split arrow CSI must be consumed as one key, not leak [D into the line");
});
