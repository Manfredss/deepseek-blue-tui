import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { LineInput, type LineInputHistory } from "../src/input.js";

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

function harness(history?: LineInputHistory): {
  input: FakeInput;
  output: FakeOutput;
  line: LineInput;
  seen: () => string;
} {
  const input = new FakeInput();
  const output = new FakeOutput();
  let seen = "";
  output.on("data", (chunk: Buffer) => {
    seen += chunk.toString();
  });
  const line = new LineInput({ input, output, ...(history ? { history } : {}) });
  return { input, output, line, seen: () => seen };
}

async function settle(milliseconds = 20): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

test("a trailing backslash keeps the editor open and joins the lines", async () => {
  const { input, line } = harness();
  const pending = line.next("> ", { continuation: "… " });
  input.write("第一行\\\r");
  await settle();
  input.write("第二行\r");

  assert.equal(await pending, "第一行\n第二行");
  line.close();
});

test("an escaped backslash submits immediately instead of continuing", async () => {
  const { input, line } = harness();
  const pending = line.next("> ", { continuation: "… " });
  input.write("路径 C:\\\\\r");

  assert.equal(await pending, "路径 C:\\\\");
  line.close();
});

test("continuation lines are shown with their own prompt", async () => {
  const { input, line, seen } = harness();
  const pending = line.next("> ", { continuation: "… " });
  input.write("head\\\r");
  await settle();
  assert.ok(seen().includes("… "), "the continuation prompt should be drawn");
  input.write("tail\r");
  await pending;
  line.close();
});

test("submitted lines are recorded and recalled from seeded history", async () => {
  const appended: string[] = [];
  const history: LineInputHistory = {
    entries: ["旧的一句"],
    append: (entry) => appended.push(entry),
  };
  const { input, line } = harness(history);

  const first = line.next("> ");
  input.write("\u001b[A");
  await settle();
  input.write("\r");
  assert.equal(await first, "旧的一句", "Up must recall a seeded entry");

  const second = line.next("> ");
  input.write("新的一句\r");
  assert.equal(await second, "新的一句");
  assert.deepEqual(history.entries, ["旧的一句", "新的一句"]);
  assert.deepEqual(appended, ["新的一句"]);
  line.close();
});

test("history skips blanks, repeats, secrets, and opted-out prompts", async () => {
  const history: LineInputHistory = {
    entries: [],
    accepts: (entry) => !entry.startsWith("/exit"),
  };
  const { input, line } = harness(history);

  for (const [text, options] of [
    ["   ", {}],
    ["记住我", {}],
    ["记住我", {}],
    ["sk-abcdefghijklmnop", {}],
    ["/exit", {}],
    ["y", { history: false }],
  ] as const) {
    const pending = line.next("> ", options);
    input.write(`${text}\r`);
    await pending;
  }

  assert.deepEqual(history.entries, ["记住我"]);
  line.close();
});

test("resetLine empties the editor and isPrompting tracks the prompt", async () => {
  const { input, line } = harness();
  assert.equal(line.isPrompting(), false);

  const pending = line.next("> ");
  input.write("half typed");
  await settle();
  assert.equal(line.isPrompting(), true);
  assert.equal(line.currentLine(), "half typed");

  line.resetLine();
  assert.equal(line.currentLine(), "");

  input.write("real message\r");
  assert.equal(await pending, "real message");
  assert.equal(line.isPrompting(), false);
  line.close();
});

test("notice prints above the prompt without disturbing the pending line", async () => {
  const { input, line, seen } = harness();
  const pending = line.next("> ");
  input.write("draft");
  await settle();

  line.notice("再按一次 Ctrl+C 退出");
  await settle();
  assert.ok(seen().includes("再按一次 Ctrl+C 退出"));

  input.write("\r");
  assert.equal(await pending, "draft");
  line.close();
});
