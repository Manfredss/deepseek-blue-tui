import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { Spinner } from "../src/spinner.js";

class FakeTty extends PassThrough {
  isTTY = true;
  columns = 80;
  rows = 24;
}

function collect(stream: PassThrough): () => string {
  let seen = "";
  stream.on("data", (chunk: Buffer) => {
    seen += chunk.toString();
  });
  return () => seen;
}

async function settle(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

test("the spinner animates, keeps the label live, and clears its line on stop", async () => {
  const output = new FakeTty();
  const seen = collect(output);
  let label = "正在思考";
  const spinner = new Spinner(output as unknown as NodeJS.WriteStream, (frame) => `${frame} ${label}`);

  spinner.start();
  await settle(250);
  label = "正在压缩";
  await settle(150);
  spinner.stop();
  const painted = seen();

  assert.ok(painted.includes("正在思考"), "the first label should have been painted");
  assert.ok(painted.includes("正在压缩"), "a later frame should pick up the new label");
  assert.ok(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u.test(painted), "braille frames should appear");
  assert.ok(painted.includes("\u001b[?25l") && painted.includes("\u001b[?25h"), "the cursor is hidden then restored");

  const trailing = painted.slice(painted.lastIndexOf("正在压缩") + 4);
  assert.ok(trailing.includes("\u001b[2K") || trailing.includes("\u001b[0K"), "stop must clear the spinner line");
});

test("stop is idempotent and a spinner that never started writes nothing", async () => {
  const output = new FakeTty();
  const seen = collect(output);
  const spinner = new Spinner(output as unknown as NodeJS.WriteStream, (frame) => frame);

  spinner.stop();
  spinner.refresh();
  await settle(20);
  assert.equal(seen(), "");

  spinner.start();
  spinner.stop();
  spinner.stop();
  const afterStop = seen();
  await settle(200);
  assert.equal(seen(), afterStop, "a stopped spinner must not paint another frame");
});

test("a non-TTY output never receives spinner frames", async () => {
  const output = new PassThrough() as PassThrough & { isTTY?: boolean };
  const seen = collect(output);
  const spinner = new Spinner(output as unknown as NodeJS.WriteStream, (frame) => `${frame} working`);

  spinner.start();
  await settle(200);
  spinner.stop();

  assert.equal(seen(), "", "piped output must stay clean for redirection");
  assert.ok(spinner.elapsedMs >= 0);
});
