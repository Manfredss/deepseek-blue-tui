import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";

import { LineInput, watchAbortKeys } from "../src/input.js";

class FakeInput extends PassThrough {
  readonly isTTY = true;
  isRaw = false;

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    return this;
  }
}

class FakeOutput extends PassThrough {
  readonly isTTY = true;
  columns = 80;
  rows = 24;
}

async function settle(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

test("watchAbortKeys aborts on a lone Escape after the sequence timeout", async () => {
  const input = new FakeInput();
  let aborts = 0;
  const watcher = watchAbortKeys(input, () => {
    aborts += 1;
  });
  input.write("\u001b");
  assert.equal(aborts, 0, "must wait for the escape-sequence timeout before aborting");
  await settle(70);
  assert.equal(aborts, 1);
  watcher.detach();
});

test("watchAbortKeys ignores arrow keys without aborting", async () => {
  const input = new FakeInput();
  let aborts = 0;
  const watcher = watchAbortKeys(input, () => {
    aborts += 1;
  });
  input.write("\u001b[B");
  input.write("\u001b[A");
  await settle(70);
  assert.equal(aborts, 0);
  watcher.detach();
});

test("watchAbortKeys aborts immediately on Ctrl+C and only once", async () => {
  const input = new FakeInput();
  let aborts = 0;
  const watcher = watchAbortKeys(input, () => {
    aborts += 1;
  });
  input.write("\u0003");
  input.write("\u0003");
  await settle(10);
  assert.equal(aborts, 1);
  watcher.detach();
});

test("watchAbortKeys buffers type-ahead and returns it on detach", async () => {
  const input = new FakeInput();
  const watcher = watchAbortKeys(input, () => undefined);
  input.write("hello");
  input.write("\r");
  input.write("next question");
  await settle(10);
  assert.equal(watcher.detach(), "hello\rnext question");
  assert.equal(input.isRaw, false);
});

test("watchAbortKeys is a no-op without a TTY", () => {
  const input = new PassThrough();
  const watcher = watchAbortKeys(input, () => undefined);
  assert.equal(watcher.detach(), "");
});

test("LineInput.pushText queues complete lines and drops the partial tail", async (t: TestContext) => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const lineInput = new LineInput({ input, output });
  t.after(() => lineInput.close());

  lineInput.pushText("first line\rsecond line\npartial tail");
  assert.equal(await lineInput.next("❯ "), "first line");
  assert.equal(await lineInput.next("❯ "), "second line");

  // The pending next() must still work for real keyboard input afterwards.
  const pending = lineInput.next("❯ ");
  input.write("typed later\r");
  assert.equal(await pending, "typed later");
});
