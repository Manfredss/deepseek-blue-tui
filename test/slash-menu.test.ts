import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";

import {
  renderSlashCommandMenu,
  slashCommandSuggestions,
  SLASH_COMMANDS,
} from "../src/commands.js";
import { LineInput } from "../src/input.js";
import { createTheme } from "../src/theme.js";

const ANSI_CSI = /\u001b\[[0-?]*[ -/]*[@-~]/gu;

function stripAnsi(value: string): string {
  return value.replace(ANSI_CSI, "");
}

function visibleWidth(value: string): number {
  let width = 0;
  for (const character of stripAnsi(value)) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) continue;
    if (/\p{Mark}/u.test(character)) continue;
    width +=
      codePoint >= 0x1100 &&
      (codePoint <= 0x115f ||
        (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
        (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
        (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
        (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
        (codePoint >= 0xff00 && codePoint <= 0xff60) ||
        (codePoint >= 0x1f300 && codePoint <= 0x1faff))
        ? 2
        : 1;
  }
  return width;
}

async function eventually(predicate: () => boolean, message: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function settle(milliseconds = 30): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

test("slash command suggestions filter the command token and preserve command order", () => {
  const all = slashCommandSuggestions("/");
  assert.deepEqual(
    all.map(({ command }) => command),
    [...SLASH_COMMANDS],
  );
  assert.ok(all.every(({ description }) => description.trim().length > 0));

  assert.deepEqual(
    slashCommandSuggestions("/mo").map(({ command }) => command),
    ["/model"],
  );
  assert.deepEqual(
    slashCommandSuggestions("/", 3).map(({ command }) => command),
    [...SLASH_COMMANDS.slice(0, 3)],
  );
});

test("slash command suggestions stay hidden for prompts, escaped slashes, arguments, and misses", () => {
  assert.deepEqual(slashCommandSuggestions(""), []);
  assert.deepEqual(slashCommandSuggestions("hello"), []);
  assert.deepEqual(slashCommandSuggestions(" //model"), []);
  assert.deepEqual(slashCommandSuggestions("//model"), []);
  assert.deepEqual(slashCommandSuggestions("/model deepseek-v4-pro"), []);
  assert.deepEqual(slashCommandSuggestions("/not-a-command"), []);
});

test("slash menu respects terminal columns and available rows", () => {
  const theme = createTheme(false);

  for (const { columns, rows } of [
    { columns: 92, rows: 31 },
    { columns: 48, rows: 12 },
    { columns: 24, rows: 6 },
    { columns: 16, rows: 4 },
  ]) {
    const rendered = renderSlashCommandMenu("/", { columns, rows, theme });
    assert.ok(rendered.length > 0, `expected menu rows at ${columns}x${rows}`);
    assert.ok(rendered.length <= rows, `menu must fit ${rows} available rows`);
    assert.ok(
      rendered.every((line) => visibleWidth(line) <= columns),
      `every menu row must fit ${columns} columns: ${JSON.stringify(rendered.map(stripAnsi))}`,
    );
    assert.ok(
      rendered.some((line) => stripAnsi(line).includes(SLASH_COMMANDS[0])),
      `menu should include its first matching command at ${columns}x${rows}`,
    );
  }
});

test("slash menu shows at most five commands and reports the remaining matches", () => {
  const theme = createTheme(false);
  const rendered = renderSlashCommandMenu("/", { columns: 92, rows: 31, theme });
  const plain = rendered.map(stripAnsi);
  const visibleCommands = SLASH_COMMANDS.filter((command) =>
    plain.some((line) => line.trimStart().startsWith(command)),
  );

  assert.deepEqual(visibleCommands, [...SLASH_COMMANDS.slice(0, 5)]);
  assert.equal(
    plain.at(-1)?.trim(),
    `... ${String(SLASH_COMMANDS.length - visibleCommands.length)} more`,
    "the final menu row should disclose how many matching commands are hidden",
  );
});

test("slash menu reserves room for its overflow hint in short viewports", () => {
  const theme = createTheme(false);

  for (const rows of [4, 5, 6, 7]) {
    const rendered = renderSlashCommandMenu("/", { columns: 60, rows, theme });
    const plain = rendered.map(stripAnsi);
    const visibleCount = SLASH_COMMANDS.filter((command) =>
      plain.some((line) => line.trimStart().startsWith(command)),
    ).length;

    assert.ok(rendered.length <= rows, `menu must fit a ${String(rows)}-row viewport`);
    assert.ok(visibleCount <= 5, "no viewport may show more than five command items");
    assert.equal(
      plain.at(-1)?.trim(),
      `... ${String(SLASH_COMMANDS.length - visibleCount)} more`,
      `the overflow count must reflect hidden matches in a ${String(rows)}-row viewport`,
    );
  }
});

test("slash menu filters while typing and applies foreground styling only", () => {
  const theme = createTheme(true, { COLORTERM: "truecolor" });
  const rendered = renderSlashCommandMenu("/mo", { columns: 60, rows: 10, theme });
  const plain = rendered.map(stripAnsi).join("\n");

  assert.match(plain, /(?:^|\n)\s*\/model\b/);
  assert.doesNotMatch(plain, /\/help\b/);
  assert.ok(rendered.some((line) => line.includes("\u001b[38;2;")), "command should use a foreground color");
  assert.doesNotMatch(rendered.join(""), /\u001b\[(?:4[0-8]|10[0-7]|48(?:;|m)|7m)/u);
});

class TtyInput extends PassThrough {
  readonly isTTY = true;
  isRaw = false;

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    return this;
  }
}

class TtyOutput extends PassThrough {
  readonly isTTY = true;
  columns = 80;
  rows = 24;
}

interface SuggestionCall {
  line: string;
  columns: number;
  rows: number;
}

function createLiveInput(t: TestContext): {
  calls: SuggestionCall[];
  input: TtyInput;
  lineInput: LineInput;
  output: TtyOutput;
  rendered: () => string;
} {
  const input = new TtyInput();
  const output = new TtyOutput();
  const calls: SuggestionCall[] = [];
  let rendered = "";
  output.on("data", (chunk: Buffer) => {
    rendered += chunk.toString();
  });
  const lineInput = new LineInput({
    input,
    output,
    suggestions: (line, dimensions) => {
      calls.push({ line, ...dimensions });
      return line.startsWith("/") ? [`menu:${line}:${dimensions.columns}x${dimensions.rows}`, "second item"] : [];
    },
  });
  t.after(() => lineInput.close());
  return { calls, input, lineInput, output, rendered: () => rendered };
}

function hasEraseSequence(value: string): boolean {
  return /\u001b\[(?:\d+;?)*(?:J|K)/u.test(value);
}

test("LineInput opens and filters a live slash overlay without changing the submitted line", async (t) => {
  const { calls, input, lineInput, rendered } = createLiveInput(t);
  const answer = lineInput.next("❯ ", { suggestions: true });

  input.write("/");
  await eventually(
    () => calls.some(({ line, columns, rows }) => line === "/" && columns === 78 && rows === 24),
    "typing / should request suggestions using current terminal dimensions",
  );
  await eventually(() => rendered().includes("menu:/:78x24"), "slash menu should be rendered below the prompt");

  const beforeFilter = rendered().length;
  input.write("m");
  await eventually(() => calls.at(-1)?.line === "/m", "typing should update the suggestion query");
  await eventually(
    () => rendered().slice(beforeFilter).includes("menu:/m:78x24"),
    "filtered menu should be redrawn",
  );
  assert.equal(hasEraseSequence(rendered().slice(beforeFilter)), true, "redraw should erase the previous overlay");

  const beforeEnter = rendered().length;
  input.write("\r");
  assert.equal(await answer, "/m");
  await eventually(
    () => hasEraseSequence(rendered().slice(beforeEnter)),
    "Enter should remove the menu before returning the line",
  );
});

test("LineInput redraws a visible slash overlay when the terminal is resized", async (t) => {
  const { calls, input, lineInput, output, rendered } = createLiveInput(t);
  const answer = lineInput.next("❯ ", { suggestions: true });
  input.write("/");
  await eventually(() => rendered().includes("menu:/:78x24"), "initial menu should render");

  const beforeResize = rendered().length;
  output.columns = 46;
  output.rows = 11;
  output.emit("resize");

  await eventually(
    () => calls.some(({ line, columns, rows }) => line === "/" && columns === 44 && rows === 11),
    "resize should recompute suggestions with new dimensions",
  );
  await eventually(
    () => rendered().slice(beforeResize).includes("menu:/:44x11"),
    "resize should redraw the menu for the new viewport",
  );
  assert.equal(hasEraseSequence(rendered().slice(beforeResize)), true, "resize should erase stale menu rows");

  input.write("\r");
  assert.equal(await answer, "/");
});

test("Escape dismisses the slash overlay without submitting or clearing the prompt", async (t) => {
  const { input, lineInput, rendered } = createLiveInput(t);
  const answer = lineInput.next("❯ ", { suggestions: true });
  input.write("/");
  await eventually(() => rendered().includes("menu:/:78x24"), "menu should render before Escape");

  const beforeEscape = rendered().length;
  input.write("\u001b");
  await eventually(
    () => hasEraseSequence(rendered().slice(beforeEscape)),
    "Escape should erase the visible suggestion overlay",
    1_500,
  );

  input.write("\r");
  assert.equal(await answer, "/", "Escape must not submit or delete the current input");
});

test("a queued redraw cannot resurrect the menu after an immediate Enter", async (t) => {
  const { input, lineInput, rendered } = createLiveInput(t);
  const answer = lineInput.next("❯ ", { suggestions: true });

  input.write("/\r");
  assert.equal(await answer, "/");
  const afterAnswer = rendered().length;
  await settle();

  assert.doesNotMatch(
    rendered().slice(afterAnswer),
    /menu:\//u,
    "no delayed suggestion render may run after the line was accepted",
  );
});

test("resize followed immediately by Enter cannot resurrect the menu", async (t) => {
  const { input, lineInput, output, rendered } = createLiveInput(t);
  const answer = lineInput.next("❯ ", { suggestions: true });
  input.write("/");
  await eventually(() => rendered().includes("menu:/:78x24"), "initial menu should render");

  output.columns = 52;
  output.rows = 13;
  output.emit("resize");
  input.write("\r");
  assert.equal(await answer, "/");
  const afterAnswer = rendered().length;
  await settle();

  assert.doesNotMatch(
    rendered().slice(afterAnswer),
    /menu:\//u,
    "a resize redraw queued before Enter must be cancelled when the line is accepted",
  );
});

test("LineInput removes its resize listener when closed", async (t) => {
  const { calls, input, lineInput, output, rendered } = createLiveInput(t);
  const answer = lineInput.next("❯ ", { suggestions: true });
  input.write("/");
  await eventually(() => rendered().includes("menu:/:78x24"), "initial menu should render");

  lineInput.close();
  assert.equal(await answer, undefined);
  const callsAfterClose = calls.length;
  output.columns = 40;
  output.rows = 8;
  output.emit("resize");
  await settle();

  assert.equal(calls.length, callsAfterClose, "resize after close must not request suggestions");
});

test("suggestions stay scoped to prompts that explicitly enable them", async (t) => {
  const { calls, input, lineInput, rendered } = createLiveInput(t);
  const answer = lineInput.next("选择编号› ");
  const beforeTyping = rendered().length;

  input.write("/");
  await settle();
  assert.equal(calls.length, 0, "secondary prompts must not query the slash-command provider");
  assert.doesNotMatch(rendered().slice(beforeTyping), /menu:\//u);

  input.write("\r");
  assert.equal(await answer, "/");
});

test("resize keeps an Escape-dismissed menu closed until the line changes", async (t) => {
  const { calls, input, lineInput, output, rendered } = createLiveInput(t);
  const answer = lineInput.next("❯ ", { suggestions: true });
  input.write("/");
  await eventually(() => rendered().includes("menu:/:78x24"), "initial menu should render");
  const beforeEscape = rendered().length;
  input.write("\u001b");
  await eventually(
    () => hasEraseSequence(rendered().slice(beforeEscape)),
    "Escape should erase the menu",
    1_500,
  );

  const beforeResize = rendered().length;
  output.columns = 44;
  output.rows = 10;
  output.emit("resize");
  await settle();
  assert.doesNotMatch(
    rendered().slice(beforeResize),
    /menu:\/:42x10/u,
    "resize alone must not reopen an explicitly dismissed menu",
  );

  input.write("m");
  await eventually(
    () => calls.some(({ line, columns, rows }) => line === "/m" && columns === 42 && rows === 10),
    "editing the line should resume suggestion filtering",
  );
  await eventually(
    () => rendered().includes("menu:/m:42x10"),
    "editing after Escape should render the newly filtered menu",
  );
  input.write("\r");
  assert.equal(await answer, "/m");
});
