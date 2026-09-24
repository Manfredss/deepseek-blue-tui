import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";

import { ConfigStore } from "../src/config.js";
import { DshManager, type DshCommand, type DshStatus, type HeadlessResult } from "../src/dsh.js";
import { createSession, SessionStore } from "../src/session-store.js";
import { LineInput } from "../src/input.js";
import { DeepSeekTui } from "../src/tui.js";
import { DEFAULT_CONFIG, type AppConfig, type ChatMessage, type Session } from "../src/types.js";

/**
 * End-to-end coverage for the REPL itself, driven through a pair of fake TTY
 * streams and (where a turn is needed) a local SSE server standing in for the
 * DeepSeek API. Colour is left on so escape-handling regressions are visible.
 */

const ESC = "\u001b";
const CTRL_C = "\u0003";
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/gu;

function stripAnsi(value: string): string {
  return value.replace(ANSI, "");
}

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
  columns = 100;
  rows = 30;
}

async function settle(milliseconds = 60): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Waits for something to actually happen rather than for a duration to pass.
 * Sleeping a fixed time and hoping the stream got far enough makes a test that
 * passes on a fast machine and fails on a loaded CI runner.
 */
async function until(check: () => boolean, message: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail(`timed out waiting: ${message}`);
    await settle(20);
  }
}

interface MockBody {
  reasoning_effort?: string;
  model?: string;
  stop?: string[];
  messages?: { role: string; content: string; prefix?: boolean }[];
}

interface MockOptions {
  content?: string[];
  status?: number;
  errorBody?: string;
  delayMs?: number;
  /** Reply text chosen from the request body (used to tell /race branches apart). */
  replyFor?: (body: MockBody) => string;
  /** Every request body the client sent, in order. */
  capture?: MockBody[];
}

async function startMockApi(t: TestContext, options: MockOptions = {}): Promise<string> {
  const server: Server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (raw += chunk));
    request.on("end", () => {
      if (options.status !== undefined && options.status >= 400) {
        response.writeHead(options.status, { "Content-Type": "application/json" });
        response.end(options.errorBody ?? JSON.stringify({ error: { message: "boom" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      let body: MockBody = {};
      try {
        body = JSON.parse(raw || "{}") as MockBody;
      } catch {
        body = {};
      }
      // Balance polls hit the same server; only chat requests are interesting.
      if (request.url?.includes("/chat/completions")) options.capture?.push(body);
      const chosen = options.replyFor ? [options.replyFor(body)] : (options.content ?? ["ok"]);
      const events = chosen.map(
        (delta) => `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`,
      );
      events.push(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 8,
            total_tokens: 18,
            prompt_cache_hit_tokens: 6,
            prompt_cache_miss_tokens: 4,
          },
        })}\n\n`,
        "data: [DONE]\n\n",
      );
      let index = 0;
      const push = (): void => {
        if (index >= events.length) {
          response.end();
          return;
        }
        response.write(events[index]);
        index += 1;
        setTimeout(push, options.delayMs ?? 5);
      };
      push();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}

interface Harness {
  tui: DeepSeekTui;
  input: FakeInput;
  output: FakeOutput;
  sessionStore: SessionStore;
  home: string;
  /** Everything written since the last `reset()`, with ANSI stripped. */
  plain: () => string;
  raw: () => string;
  reset: () => void;
  /** Submits a line and waits for the REPL to come back to the prompt. */
  send: (line: string, waitMs?: number) => Promise<string>;
  /** Starts the REPL and returns whatever the startup screen printed. */
  start: () => Promise<string>;
  finish: () => Promise<void>;
}

async function harness(
  t: TestContext,
  options: { config?: Partial<AppConfig>; session?: Session; dsh?: DshManager } = {},
): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), "deepseek-tui-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const configStore = new ConfigStore(home);
  const sessionStore = new SessionStore(home);
  const input = new FakeInput();
  const output = new FakeOutput();
  const chunks: string[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));

  const config: AppConfig = { ...DEFAULT_CONFIG, apiKey: "sk-testkey-000000", ...options.config };
  const tui = new DeepSeekTui({
    configStore,
    sessionStore,
    dshManager: options.dsh ?? new DshManager(home),
    config,
    cwd: home,
    showLogo: false,
    color: true,
    input,
    output,
    ...(options.session ? { session: options.session } : {}),
  });

  let running: Promise<void> | undefined;
  const reset = (): void => {
    chunks.length = 0;
  };
  const raw = (): string => chunks.join("");
  const plain = (): string => stripAnsi(raw());

  return {
    tui,
    input,
    output,
    sessionStore,
    home,
    plain,
    raw,
    reset,
    send: async (line, waitMs = 200) => {
      reset();
      input.write(`${line}\n`);
      await settle(waitMs);
      return plain();
    },
    start: async () => {
      running = tui.run();
      await settle(150);
      const startup = plain();
      reset();
      return startup;
    },
    finish: async () => {
      input.write("/exit\n");
      await settle(200);
      // Never await the REPL unboundedly: when a regression stops it exiting,
      // a hanging suite is far worse to diagnose than a failing assertion.
      const outcome = await Promise.race([
        running?.then(() => "exited"),
        settle(3_000).then(() => "stuck"),
      ]);
      assert.equal(outcome, "exited", "the REPL should have exited on /exit");
    },
  };
}

test("the REPL starts, answers /help, and exits cleanly", async (t: TestContext) => {
  const app = await harness(t);
  await app.start();
  const help = await app.send("/help");
  assert.match(help, /斜杠命令/);
  assert.match(help, /\/rewind/);
  await app.finish();
  assert.match(app.plain(), /再见。/);
});

test("Ctrl+C arms once at an empty prompt and exits on the second press", async (t: TestContext) => {
  const app = await harness(t);
  await app.start();
  app.input.write(CTRL_C);
  await settle(120);
  assert.match(app.plain(), /再按一次 Ctrl\+C 退出/);
  app.reset();
  app.input.write(CTRL_C);
  await settle(250);
  assert.match(app.plain(), /再见。/);
});

test("/search sanitizes control characters and highlights the match", async (t: TestContext) => {
  const session = createSession("/tmp", "deepseek-v4-flash");
  session.messages = [
    { role: "user", content: "问题 needle", createdAt: "2026-01-01T00:00:00.000Z" },
    {
      role: "assistant",
      // A model (or an attached file) can echo escape sequences back at us.
      content: `前缀 ${ESC}[31m危险${ESC}[0m needle 后缀`,
      createdAt: "2026-01-01T00:00:01.000Z",
    },
  ];
  const app = await harness(t, { session });
  await app.start();
  await app.send("/search needle");

  const rendered = app.raw();
  assert.doesNotMatch(rendered, /\u001b\[31m/u, "content escapes must never reach the terminal verbatim");
  assert.match(app.plain(), /会话内搜索「needle」（2 处匹配）/);
  assert.match(app.plain(), /\[31m危险/, "the escape survives as inert text, so nothing is silently dropped");
  assert.ok(
    app.raw().includes("\u001b[1m"),
    "the matched substring is emphasised so hits are findable at a glance",
  );
  await app.finish();
});

test("/model refuses a multi-word argument instead of silently taking the first word", async (t: TestContext) => {
  const app = await harness(t);
  await app.start();
  const rejected = await app.send("/model gpt 4");
  assert.match(rejected, /模型 ID 不能包含空格/);
  assert.doesNotMatch(rejected, /已切换/);

  const accepted = await app.send("/model deepseek-v4-pro");
  assert.match(accepted, /已切换到 deepseek-v4-pro/);
  await app.finish();
});

test("/rewind numbers messages the same way in the menu and on the command line", async (t: TestContext) => {
  const session = createSession("/tmp", "deepseek-v4-flash");
  session.messages = Array.from({ length: 30 }, (_unused, index): ChatMessage => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `${index % 2 === 0 ? "问" : "答"} ${String(index)}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  }));
  const app = await harness(t, { session });
  await app.start();

  assert.match(await app.send("/rewind 99"), /用法：\/rewind \[1-15\]/);
  assert.match(await app.send("/rewind abc"), /用法：\/rewind \[1-15\]/);

  // The menu only shows the last 12, but must label them with their real
  // numbers so `/rewind <n>` refers to the same message the user sees.
  app.reset();
  app.input.write("/rewind\n");
  await settle(200);
  const menu = app.plain();
  assert.match(menu, /仅显示最近 12 条/);
  assert.match(menu, /\n\s*❯?\s*4\s+问 6/, "the first visible row is user message #4, not #1");
  app.input.write(ESC);
  await settle(150);
  await app.finish();
});

test("a turn that produces nothing leaves no orphan user message behind", async (t: TestContext) => {
  const baseUrl = await startMockApi(t, {
    status: 401,
    errorBody: JSON.stringify({ error: { message: "Authentication Fails" } }),
  });
  const app = await harness(t, { config: { baseUrl } });
  await app.start();

  const failed = await app.send("这条会失败", 400);
  assert.match(failed, /Authentication Fails/);
  assert.match(failed, /请运行 \/login 重新配置/, "the actionable hint survives the server's own message");
  assert.match(failed, /本轮未记录到会话/);

  // The line is still recallable, which is what the notice promises.
  app.reset();
  app.input.write(`${ESC}[A`);
  await settle(150);
  assert.match(app.plain(), /这条会失败/);
  app.input.write(CTRL_C);
  await settle(80);

  const status = await app.send("/status", 250);
  assert.match(status, /0 条消息/);
  assert.match(status, /New conversation/, "the title is not derived from a message that was rolled back");
  await app.finish();
  assert.deepEqual(await app.sessionStore.list({}), [], "an empty conversation is not offered for resume");
});

test("a partial answer is kept when the generation is interrupted", async (t: TestContext) => {
  // Newline-terminated chunks, because the renderer emits a line at a time:
  // without them nothing is displayed until the stream ends, and there is no
  // in-flight moment to interrupt.
  const baseUrl = await startMockApi(t, {
    content: ["一\n", "二\n", "三\n", "四\n", "五\n"],
    delayMs: 120,
  });
  const app = await harness(t, { config: { baseUrl } });
  await app.start();

  app.input.write("慢慢来\n");
  // Interrupt once something has actually streamed, so there is a partial
  // answer to keep. Waiting a fixed 300ms instead assumed a chunk had arrived,
  // which a loaded runner does not guarantee.
  await until(() => app.plain().includes("一"), "the first chunk should have streamed");
  app.input.write(ESC); // Esc aborts an in-flight generation.
  await until(() => app.plain().includes("已中断本次生成"), "Esc should abort the generation");
  await app.finish();

  const [saved] = await app.sessionStore.list({});
  assert.equal(saved?.messages[0]?.role, "user");
  assert.equal(saved?.messages[1]?.role, "assistant");
  assert.ok((saved?.messages[1]?.content.length ?? 0) > 0, "the partial answer is not thrown away");
});

test("/continue finishes the interrupted answer instead of asking again", async (t: TestContext) => {
  const capture: MockBody[] = [];
  const baseUrl = await startMockApi(t, {
    content: ["一\n", "二\n", "三\n", "四\n", "五\n"],
    delayMs: 120,
    capture,
  });
  const app = await harness(t, { config: { baseUrl } });
  await app.start();

  app.input.write("慢慢来\n");
  await until(() => app.plain().includes("一"), "the first chunk should have streamed");
  app.input.write(ESC);
  await until(() => app.plain().includes("已中断本次生成"), "Esc should abort the generation");
  const [interrupted] = await app.sessionStore.list({});
  const half = interrupted?.messages[1]?.content ?? "";
  assert.ok(half.length > 0, "there is a partial answer to finish");

  await app.send("/continue", 50);
  await until(() => app.plain().includes("tok/s"), "the continuation should finish");
  await app.finish();

  const [saved] = await app.sessionStore.list({});
  assert.equal(saved?.messages.length, 2, "the continuation merges into the same reply");
  assert.ok(saved?.messages[1]?.content.startsWith(half), "the half already generated is kept");
  assert.ok((saved?.messages[1]?.content.length ?? 0) > half.length, "and the rest is appended");

  const last = capture[capture.length - 1];
  const trailing = last?.messages?.[(last.messages?.length ?? 0) - 1];
  assert.equal(trailing?.role, "assistant");
  assert.equal(trailing?.prefix, true, "the partial answer is sent as a prefix to finish");
});

test("a failed /continue leaves the interrupted answer's blocks addressable", async (t: TestContext) => {
  const baseUrl = await startMockApi(t, { status: 500 });
  const session = createSession(process.cwd(), DEFAULT_CONFIG.model);
  session.messages = [
    { role: "user", content: "写个函数", createdAt: new Date().toISOString() },
    { role: "assistant", content: "```python\ndef f():\n    return 1\n```\n接着", createdAt: new Date().toISOString() },
  ];
  const app = await harness(t, { config: { baseUrl }, session });
  await app.start();

  const failed = await app.send("/continue", 400);
  assert.match(failed, /请求失败/u);

  // The half that was already generated is still on screen and in the session,
  // so its block must still answer to its number.
  const saved = await app.send("/save 1 out.py", 300);
  assert.match(saved, /已写入/u);
  assert.equal(await readFile(join(app.home, "out.py"), "utf8"), "def f():\n    return 1\n");
  await app.finish();
});

test("a prefill that never generated anything is not written into the session", async (t: TestContext) => {
  const baseUrl = await startMockApi(t, { status: 500 });
  const app = await harness(t, { config: { baseUrl } });
  await app.start();

  await app.send("/prefill 结论：", 150);
  const failed = await app.send("问题", 400);
  assert.match(failed, /请求失败/u);
  assert.match(failed, /本轮未记录到会话/u, "the prompt is handed back rather than stranded");
  await app.finish();

  // `list` hides empty conversations, so this is the strongest form of
  // "nothing was recorded" — with the prefill counted as content, the
  // transcript would hold a user turn and an answer nobody ever saw.
  const recorded = (await app.sessionStore.list({})).flatMap((item) => item.messages);
  assert.deepEqual(recorded, [], "a prefill is not an answer the model gave");
});

test("/continue explains itself when there is nothing to finish", async (t: TestContext) => {
  const baseUrl = await startMockApi(t);
  const app = await harness(t, { config: { baseUrl } });
  await app.start();

  const out = await app.send("/continue", 200);
  assert.match(out, /没有可以续写的内容/u);
  await app.finish();
});

test("/prefill opens the answer with a code fence, for one turn only", async (t: TestContext) => {
  const capture: MockBody[] = [];
  const baseUrl = await startMockApi(t, { content: ["print(1)\n"], capture });
  const app = await harness(t, { config: { baseUrl } });
  await app.start();

  const armed = await app.send("/prefill ```python", 150);
  assert.match(armed, /下一条回答将以/u);
  assert.match(await app.send("/status", 250), /前缀/u);

  await app.send("写个 hello", 500);
  const [saved] = await app.sessionStore.list({});
  const answer = saved?.messages[1]?.content ?? "";
  assert.ok(answer.startsWith("```python\n"), `the answer keeps the prefill: ${answer}`);
  assert.ok(answer.trimEnd().endsWith("```"), "the fence the stop sequence ate is restored");
  const first = capture[0];
  assert.deepEqual(first?.stop, ["```"]);
  assert.equal(first?.messages?.[(first.messages?.length ?? 0) - 1]?.prefix, true);

  // One-shot: the next turn is an ordinary reply again.
  await app.send("再写一个", 500);
  const later = capture[capture.length - 1];
  assert.equal(later?.messages?.[(later.messages?.length ?? 0) - 1]?.role, "user");
  assert.equal("stop" in (later ?? {}), false);
  await app.finish();
});

test("the turn footer and /status report the same generation speed", async (t: TestContext) => {
  const baseUrl = await startMockApi(t, { content: ["答案"] });
  const app = await harness(t, { config: { baseUrl } });
  await app.start();

  const turn = await app.send("问题", 400);
  const footer = /([\d.]+) tok\/s/u.exec(turn);
  assert.ok(footer?.[1], `turn footer should report tok/s, got: ${turn}`);

  const status = await app.send("/status", 250);
  const reported = /([\d.]+) tok\/s（最近一轮）/u.exec(status);
  assert.ok(reported?.[1], `\/status should report tok/s, got: ${status}`);
  assert.equal(reported[1], footer[1], "both readouts must measure the same interval");
  await app.finish();
});

test("/context reports one consistent token total", async (t: TestContext) => {
  const session = createSession("/tmp", "deepseek-v4-flash");
  session.messages = Array.from({ length: 8 }, (_unused, index): ChatMessage => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `mixed 中英文 content number ${String(index)}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  }));
  const app = await harness(t, { session });
  await app.start();
  const report = await app.send("/context", 250);

  const header = /≈\d+% .*? ([\d.]+k?)\/[\d.]+k tokens（估算）/u.exec(report);
  const total = /合计 ([\d.]+k?) \/ [\d.]+k tokens/u.exec(report);
  assert.ok(header?.[1] && total?.[1], `both totals should render, got:\n${report}`);
  assert.equal(total[1], header[1], "the summary and the breakdown must agree");
  await app.finish();
});

test("commands that fail keep the REPL alive", async (t: TestContext) => {
  const app = await harness(t);
  await app.start();
  assert.match(await app.send("/attach /definitely/not/here.txt"), /文件不存在/);
  assert.match(await app.send("/nope"), /未知命令/);
  assert.match(await app.send("/mdoel"), /你是不是想输入：\/model/);
  assert.match(await app.send("/status", 250), /状态/, "the prompt is still serving commands");
  await app.finish();
});

test("a message starting with // is sent as text, not parsed as a command", async (t: TestContext) => {
  const baseUrl = await startMockApi(t, { content: ["收到"] });
  const app = await harness(t, { config: { baseUrl } });
  await app.start();
  await app.send("//model is just text", 400);
  await app.finish();
  const [saved] = await app.sessionStore.list({});
  assert.equal(saved?.messages[0]?.content, "/model is just text");
});

/** A DSH whose start-up takes a while and never reports "running", so the
 *  command is slow without the TUI trying to open a browser. */
class SlowDsh extends DshManager {
  override async start(): Promise<DshStatus> {
    await settle(700);
    return { phase: "starting", port: 3080, url: "http://127.0.0.1:3080" };
  }
}

test("a slow command shows progress and survives the first Ctrl+C", async (t: TestContext) => {
  const home = await mkdtemp(join(tmpdir(), "deepseek-tui-dsh-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const app = await harness(t, { dsh: new SlowDsh(home) });
  await app.start();

  app.reset();
  app.input.write("/dsh start\n");
  await settle(200);
  assert.match(app.plain(), /正在启动\/连接 DSH Web/, "a spinner says the client is still working");

  // Ctrl+C reaches the client as a signal while no prompt is waiting; the
  // first press must not throw away the whole session.
  process.emit("SIGINT");
  await until(
    () => app.plain().includes("命令执行中"),
    "the first Ctrl+C should warn rather than quit",
  );

  await until(() => app.plain().includes("仍在启动"), "the command should still finish normally");
  assert.match(await app.send("/status", 250), /状态/, "and the REPL kept going");
  await app.finish();
});

// Windows maps mode 0 to a read-only attribute rather than denying reads, and
// root bypasses the permission bits entirely.
const CAN_DENY_READS =
  process.platform !== "win32" && (typeof process.getuid !== "function" || process.getuid() !== 0);

test("/attach explains permission problems instead of leaking errno text", {
  skip: CAN_DENY_READS ? false : "this platform cannot make a file unreadable",
}, async (t: TestContext) => {
  const app = await harness(t);
  await app.start();
  const locked = join(app.home, "locked.txt");
  await writeFile(locked, "secret", "utf8");
  await chmod(locked, 0o000);
  t.after(() => chmod(locked, 0o600).catch(() => undefined));

  const denied = await app.send(`/attach ${locked}`);
  assert.match(denied, /没有读取权限/);
  assert.doesNotMatch(denied, /EACCES/, "raw errno text is not a user-facing message");

  const throughFile = await app.send(`/attach ${join(locked, "inner")}`);
  assert.match(throughFile, /路径中有一段不是目录/);
  await app.finish();
});

// ---------------------------------------------------------------------------
// Markdown rendering, cache awareness, /do and /race.
// ---------------------------------------------------------------------------

test("a fenced code block in a reply is framed rather than dumped as raw text", async (t: TestContext) => {
  const reply = "先看代码：\n\n```ts\nconst x = 1; // 注释\n```\n\n就这样。";
  // Split into three-character deltas so fences arrive mid-chunk.
  const baseUrl = await startMockApi(t, {
    content: Array.from({ length: Math.ceil(reply.length / 3) }, (_u, i) => reply.slice(i * 3, i * 3 + 3)),
  });
  const app = await harness(t, { config: { baseUrl } });
  await app.start();
  const out = await app.send("给我代码", 500);

  assert.match(out, /┌─ \[1\] ts/, "the code block is framed, numbered and labelled");
  assert.match(out, /│ const x = 1;/, "code carries the gutter even when deltas split the fence");
  assert.match(out, /└─/, "and the block is closed");
  assert.doesNotMatch(out, /```/, "raw fences are consumed, not printed");
  await app.finish();
});

test("/copy explains itself before there is anything to copy", async (t: TestContext) => {
  const app = await harness(t);
  await app.start();
  assert.match(await app.send("/copy"), /还没有出现代码块/u);
  await app.finish();
});

test(
  "/copy hands the code block to the clipboard command",
  // The stand-in clipboard is a POSIX script; the command lookup itself is
  // covered per-platform in artifacts.test.ts.
  { skip: process.platform === "win32" ? "needs a POSIX shell" : false },
  async (t: TestContext) => {
    const baseUrl = await startMockApi(t, { content: ["给你：\n\n```ts\nconst x = 1;\n```\n"] });
    const app = await harness(t, { config: { baseUrl } });
    const sink = join(app.home, "clipboard.txt");
    const script = join(app.home, "fake-copy");
    await writeFile(script, `#!/bin/sh\ncat > ${JSON.stringify(sink)}\n`, { mode: 0o755 });
    process.env.DEEPSEEK_TUI_CLIPBOARD = script;
    t.after(() => {
      delete process.env.DEEPSEEK_TUI_CLIPBOARD;
    });

    await app.start();
    const turn = await app.send("给我代码", 500);
    assert.match(turn, /┌─ \[1\] ts/u, "the block is numbered so it can be named");
    const copied = await app.send("/copy", 400);
    assert.match(copied, /已复制 \[1\] ts/u);
    assert.equal(await readFile(sink, "utf8"), "const x = 1;", "the code is copied verbatim, unframed");
    await app.finish();
  },
);

test(
  "/copy takes the source, not the output the answer ends with",
  { skip: process.platform === "win32" ? "needs a POSIX shell" : false },
  async (t: TestContext) => {
    // The shape that made this a bug: code first, then what it printed.
    const python = "实现：\n\n```python\nprint(sorted(xs))\n```\n\n输出：\n\n```text\n[1, 2, 3]\n```\n";
    const cpp = "实现：\n\n```cpp\nint main() { return 0; }\n```\n\n运行示例输出：\n\n```\n3 9 21\n```\n";
    // Keyed off the question, not a counter: the balance poll shares this
    // server and would consume the first reply.
    const baseUrl = await startMockApi(t, {
      replyFor: (body) => (JSON.stringify(body.messages ?? []).includes("cpp") ? cpp : python),
    });
    const app = await harness(t, { config: { baseUrl } });
    const sink = join(app.home, "clipboard.txt");
    const script = join(app.home, "fake-copy");
    await writeFile(script, `#!/bin/sh\ncat > ${JSON.stringify(sink)}\n`, { mode: 0o755 });
    process.env.DEEPSEEK_TUI_CLIPBOARD = script;
    t.after(() => {
      delete process.env.DEEPSEEK_TUI_CLIPBOARD;
    });

    await app.start();
    await app.send("写个排序", 500);
    const copied = await app.send("/copy", 400);
    assert.match(copied, /已复制 \[1\] python/u, "the last block is the output, which is never what /copy meant");
    assert.match(copied, /同一条回答还有 \[2\] text/u, "and the other block is named, in case the guess was wrong");
    assert.equal(await readFile(sink, "utf8"), "print(sorted(xs))");

    // A second implementation question: its own blocks, and its output block
    // left untagged — the shape that made /copy pick the output again.
    await app.send("再用 cpp 写一个", 500);
    const again = await app.send("/copy", 400);
    assert.match(again, /已复制 \[3\] cpp/u, "the newest answer's source, not its untagged output");
    assert.match(again, /同一条回答还有 \[4\]/u);
    assert.equal(await readFile(sink, "utf8"), "int main() { return 0; }");

    // An explicit number still wins, and then nothing is guessed at.
    const second = await app.send("/copy 2", 400);
    assert.match(second, /已复制 \[2\] text/u);
    assert.doesNotMatch(second, /同一条回答还有/u);
    assert.equal(await readFile(sink, "utf8"), "[1, 2, 3]");
    await app.finish();
  },
);

test("an edited attachment comes back as a diff, and /save can write it out", async (t: TestContext) => {
  const baseUrl = await startMockApi(t, { content: ["改好了：\n\n```python\ndef f():\n    return 2\n```\n"] });
  const app = await harness(t, { config: { baseUrl } });
  const file = join(app.home, "f.py");
  await writeFile(file, "def f():\n    return 1\n");
  await app.start();

  const turn = await app.send(`/attach ${file}`, 600);
  assert.match(turn, /代码块 \[1\] 相对 .*f\.py/u, "an edited attachment is pointed out, not left to be spotted");

  const diff = await app.send("/diff", 300);
  assert.match(diff, /-\s+return 1/u);
  assert.match(diff, /\+\s+return 2/u);

  const save = await app.send(`/save 1 ${file}`, 250);
  assert.match(save, /已存在，将被覆盖/u, "an existing file is never overwritten silently");
  await app.send("y", 350);
  assert.equal(await readFile(file, "utf8"), "def f():\n    return 2\n");
  await app.finish();
});

test("the attachment diff hint belongs to the turn that produced it", async (t: TestContext) => {
  const rewrite = "改好了：\n\n```python\ndef f():\n    return 2\n```\n";
  const baseUrl = await startMockApi(t, {
    replyFor: (body) => (JSON.stringify(body.messages ?? []).includes("无关") ? "和文件没关系的一段话。" : rewrite),
  });
  const app = await harness(t, { config: { baseUrl } });
  const file = join(app.home, "f.py");
  await writeFile(file, "def f():\n    return 1\n");
  await app.start();

  assert.match(await app.send(`/attach ${file}`, 600), /代码块 \[1\] 相对/u);
  const unrelated = await app.send("说点无关的", 500);
  assert.doesNotMatch(
    unrelated,
    /代码块 \[1\] 相对/u,
    "an answer with no code of its own has not just rewritten that file",
  );
  await app.finish();
});

test("/cache reports hit rate and cost, and says so when a model has no price", async (t: TestContext) => {
  const baseUrl = await startMockApi(t, { content: ["好"] });
  const app = await harness(t, { config: { baseUrl, model: "deepseek-v4-flash" } });
  await app.start();
  await app.send("问题", 400);

  const known = await app.send("/cache", 250);
  assert.match(known, /上下文缓存/);
  assert.match(known, /命中率/);
  assert.match(known, /可复用/);
  assert.match(known, /≈<?\$[\d.]/u, "a known model shows an estimated cost");
  assert.match(known, /60\.0%/, "the hit rate comes from the API's own split");
  assert.doesNotMatch(known, /\$0\.0000/, "a real charge is never rounded down to look free");

  // Switching model mid-session now asks about the cache prefix first.
  app.reset();
  app.input.write("/model my-local-model\n");
  await settle(200);
  assert.match(app.plain(), /切换模型会重写会话前缀/);
  app.input.write("y\n");
  await settle(250);

  const unknown = await app.send("/cache", 250);
  assert.match(unknown, /没有内置价目/, "an unknown model must not invent a price");
  assert.doesNotMatch(unknown, /≈<?\$/u);
  await app.finish();
});

test("/compact warns that rewriting the prefix drops the context cache", async (t: TestContext) => {
  const session = createSession("/tmp", "deepseek-v4-flash");
  session.messages = Array.from({ length: 6 }, (_u, index): ChatMessage => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: "内容".repeat(400),
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  }));
  const app = await harness(t, { session });
  await app.start();

  app.reset();
  app.input.write("/compact\n");
  await settle(250);
  const warned = app.plain();
  assert.match(warned, /会重写会话前缀/);
  assert.match(warned, /上下文缓存将失效/);
  assert.match(warned, /≈<?\$[\d.]/u, "the extra cost is quantified");
  assert.match(warned, /前缀完全匹配/, "the reason is explained, not just asserted");

  app.input.write("n\n"); // decline
  await settle(250);
  assert.match(app.plain(), /已取消/);
  assert.equal(app.tui ? session.messages.length : 0, 6, "declining leaves history untouched");
  await app.finish();
});

test("switching model mid-conversation warns about the same prefix loss", async (t: TestContext) => {
  const session = createSession("/tmp", "deepseek-v4-flash");
  session.messages = [
    { role: "user", content: "内容".repeat(300), createdAt: "2026-01-01T00:00:00.000Z" },
    { role: "assistant", content: "回答".repeat(300), createdAt: "2026-01-01T00:00:01.000Z" },
  ];
  const app = await harness(t, { session });
  await app.start();

  app.reset();
  app.input.write("/model deepseek-v4-pro\n");
  await settle(250);
  assert.match(app.plain(), /切换模型会重写会话前缀/);
  app.input.write("n\n");
  await settle(250);
  assert.match(app.plain(), /已取消/);
  assert.equal(session.model, "deepseek-v4-flash", "declining leaves the model alone");
  await app.finish();
});

test("/race runs each effort, compares them, and keeps only the chosen answer", async (t: TestContext) => {
  const baseUrl = await startMockApi(t, {
    replyFor: (body) => `这是 ${body.reasoning_effort ?? "?"} 档的回答`,
  });
  const app = await harness(t, { config: { baseUrl } });
  await app.start();

  app.reset();
  app.input.write("/race low max 该怎么做\n");
  await until(() => app.plain().includes("保留哪一个"), "both branches should finish and offer a picker");
  const compared = app.plain();
  assert.match(compared, /并行对比 low \/ max/);
  assert.match(compared, /这是 low 档的回答/, "each branch really used its own effort");
  assert.match(compared, /这是 max 档的回答/);
  assert.match(compared, /保留哪一个/, "a picker offers the branches");

  app.input.write("\r"); // keep the highlighted (first) branch
  await until(() => app.plain().includes("已保留"), "the chosen branch should be kept");
  const kept = app.plain();
  assert.match(kept, /已保留 low 的回答/);
  await app.finish();

  const [saved] = await app.sessionStore.list({});
  assert.equal(saved?.messages.length, 2, "only the kept branch enters history");
  assert.equal(saved?.messages[1]?.content, "这是 low 档的回答");
  assert.ok(
    (saved?.usage.completionTokens ?? 0) >= 16,
    "every branch was billed, so both count toward session usage",
  );
});

/** Three judged races of the same shape: enough for `/effort auto` to act. */
function seededLedger(winner: string): string {
  return [1, 2, 3]
    .map((index) =>
      JSON.stringify({
        version: 1,
        at: `2026-09-0${index}T00:00:00.000Z`,
        kind: "code",
        size: "small",
        branches: [
          { model: "deepseek-v4-flash", effort: "low", ms: 900, outputTokens: 80, reasoningTokens: 0, cost: 0.0002 },
          { model: "deepseek-v4-flash", effort: "max", ms: 9_000, outputTokens: 900, reasoningTokens: 4_000, cost: 0.004 },
        ].map((branch) => (branch.effort === winner ? { ...branch, chosen: true } : branch)),
      }),
    )
    .join("\n");
}

test("a kept branch is filed in the ledger, and /race stats reads it back", async (t: TestContext) => {
  const baseUrl = await startMockApi(t, { replyFor: (body) => `这是 ${body.reasoning_effort ?? "?"} 档的回答` });
  const app = await harness(t, { config: { baseUrl } });
  await app.start();

  app.reset();
  app.input.write("/race low max 写个函数把它拍平\n");
  await until(() => app.plain().includes("保留哪一个"), "both branches should finish");
  app.input.write("\r");
  await until(() => app.plain().includes("已记入对比账本"), "the pick should be recorded");
  assert.match(app.plain(), /写代码/u, "the ledger says what kind of question it judged");

  const stats = await app.send("/race stats", 250);
  assert.match(stats, /对比账本 · 1 次/u);
  assert.match(stats, /写代码/u);
  assert.match(stats, /1\/1/u, "the kept branch counts as a win");
  await app.finish();

  const ledger = await readFile(join(app.home, "races.jsonl"), "utf8");
  const filed = JSON.parse(ledger.trim()) as { kind: string; branches: { effort: string; chosen?: boolean }[] };
  assert.equal(filed.kind, "code");
  assert.deepEqual(
    filed.branches.filter((branch) => branch.chosen).map((branch) => branch.effort),
    ["low"],
    "only the branch the user kept is marked as the winner",
  );
});

test("/race --blind hides which branch is which until the pick is made", async (t: TestContext) => {
  const baseUrl = await startMockApi(t, { replyFor: (body) => `这是 ${body.reasoning_effort ?? "?"} 档的回答` });
  const app = await harness(t, { config: { baseUrl } });
  await app.start();

  app.reset();
  app.input.write("/race --blind low max 该怎么做\n");
  await until(() => app.plain().includes("保留哪一个"), "both branches should finish");
  const compared = app.plain();
  assert.match(compared, /盲测/u);
  assert.match(compared, /^\s+A\s/mu, "branches are shown as letters, not levels");
  assert.match(compared, /^\s+B\s/mu);
  assert.doesNotMatch(compared.split("保留哪一个")[0] ?? "", /^\s+(?:low|max)\s/mu, "no level labels before the pick");

  app.input.write("\r");
  // Not "揭晓": the blind header already promises one, so it would match at once.
  await until(() => app.plain().includes("已保留"), "the pick should be kept");
  assert.match(app.plain(), /揭晓：[AB] = (?:low|max)/u);
  await app.finish();
});

test("/effort auto picks the level the ledger says wins, and says why", async (t: TestContext) => {
  const capture: MockBody[] = [];
  const baseUrl = await startMockApi(t, { content: ["好"], capture });
  // Configured for max: the point of the ledger is to talk you down from it.
  const app = await harness(t, { config: { baseUrl, effortAuto: true, effort: "max" } });
  await writeFile(join(app.home, "races.jsonl"), `${seededLedger("low")}\n`);
  await app.start();

  const status = await app.send("/status", 250);
  assert.match(status, /思考\s+auto/u, "/status says the level is being chosen automatically");

  const turn = await app.send("写个函数把它拍平", 500);
  assert.match(turn, /自动选档：写代码问题你对比过 3 次，low 赢了 3 次/u);
  assert.match(turn, /省 ≈/u, "the cheaper level reports what it saves against the configured one");
  assert.equal(capture[0]?.reasoning_effort, "low", "the advised level is what gets sent");
  await app.finish();
});

test("/effort auto keeps the configured level when the ledger has nothing to say", async (t: TestContext) => {
  const capture: MockBody[] = [];
  const baseUrl = await startMockApi(t, { content: ["好"], capture });
  const app = await harness(t, { config: { baseUrl, effortAuto: true, effort: "max" } });
  await app.start();

  const turn = await app.send("写个函数把它拍平", 500);
  assert.match(turn, /自动选档暂无依据/u);
  assert.equal(capture[0]?.reasoning_effort, "max");
  await app.finish();
});

test("/race needs at least two efforts and a question", async (t: TestContext) => {
  const app = await harness(t);
  await app.start();
  assert.match(await app.send("/race low"), /至少要两个档位/);
  assert.match(await app.send("/race"), /用法：\/race/, "with no history there is nothing to reuse");
  await app.finish();
});

/**
 * A DSH stub whose availability and headless run are fully controlled by the
 * test. Both must be stubbed: reaching the real lookup would make these tests
 * pass or fail according to whether the machine happens to have dsh installed.
 */
class StubDsh extends DshManager {
  constructor(
    home: string,
    private readonly reply: HeadlessResult,
    private readonly available = true,
  ) {
    super(home);
  }

  override resolveCommand(): DshCommand | undefined {
    if (!this.available) return undefined;
    return { command: "/stub/dsh", argsPrefix: [], source: "path", display: "/stub/dsh", version: "9.9.9-stub" };
  }

  override async runHeadless(options: { task: string; onData?: (chunk: string) => void }): Promise<HeadlessResult> {
    StubDsh.lastTask = options.task;
    options.onData?.(this.reply.output);
    await settle(20);
    return this.reply;
  }

  static lastTask = "";
}

test("/do confirms first, then folds the agent's result into the conversation", async (t: TestContext) => {
  const home = await mkdtemp(join(tmpdir(), "deepseek-do-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dsh = new StubDsh(home, { output: "改了 2 个文件：\n\n```diff\n+ ok\n```", status: 0, timedOut: false });
  const session = createSession("/tmp", "deepseek-v4-flash");
  session.messages = [
    { role: "user", content: "这个竞态在哪", createdAt: "2026-01-01T00:00:00.000Z" },
    { role: "assistant", content: "在 touchLock 的 inode 比较上", createdAt: "2026-01-01T00:00:01.000Z" },
  ];
  const app = await harness(t, { dsh, session });
  await app.start();

  app.reset();
  app.input.write("/do 按上面的结论修掉\n");
  await settle(250);
  const confirm = app.plain();
  assert.match(confirm, /交给 DSH 执行/);
  assert.match(confirm, /真实修改文件/, "the destructive nature is stated before confirming");
  assert.match(confirm, /确认执行/);
  assert.doesNotMatch(confirm, /改了 2 个文件/, "nothing runs before the user agrees");

  app.input.write("y\n");
  await until(() => app.plain().includes("◆ DSH"), "the agent result should be rendered");
  const done = app.plain();
  assert.match(done, /◆ DSH/);
  assert.match(done, /改了 2 个文件/);
  assert.match(done, /┌─ \[1\] diff/, "agent output is rendered as markdown too");

  // The earlier conversation is handed over so the agent is not starting blind.
  assert.match(StubDsh.lastTask, /此前的对话背景/);
  assert.match(StubDsh.lastTask, /touchLock/);
  assert.match(StubDsh.lastTask, /按上面的结论修掉$/u, "the task itself comes last");

  await app.finish();
  const [saved] = await app.sessionStore.list({});
  assert.equal(saved?.messages.length, 4, "the delegation is recorded as a turn");
  assert.match(saved?.messages[3]?.content ?? "", /^\[DSH 执行结果\]/u, "provenance is explicit");
});

test("/do declines cleanly without running the agent", async (t: TestContext) => {
  const home = await mkdtemp(join(tmpdir(), "deepseek-do-no-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dsh = new StubDsh(home, { output: "不该跑到这里", status: 0, timedOut: false });
  const app = await harness(t, { dsh });
  await app.start();

  assert.match(await app.send("/do"), /用法：\/do/);

  app.reset();
  app.input.write("/do 危险操作\n");
  await settle(250);
  app.input.write("n\n");
  await settle(250);
  assert.match(app.plain(), /已取消/);
  assert.doesNotMatch(app.plain(), /不该跑到这里/, "declining must not run the agent");
  await app.finish();
});

test("/do reports a missing DSH instead of prompting", async (t: TestContext) => {
  const home = await mkdtemp(join(tmpdir(), "deepseek-do-missing-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dsh = new StubDsh(home, { output: "不该跑到这里", status: 0, timedOut: false }, false);
  const app = await harness(t, { dsh });
  await app.start();

  const missing = await app.send("/do 修一下", 250);
  assert.match(missing, /未找到 DSH/);
  assert.match(missing, /\/dsh install/, "the message says how to fix it");
  assert.doesNotMatch(missing, /确认执行/, "there is nothing to confirm without a DSH");
  await app.finish();
});

test("a command after /race runs exactly once", async (t: TestContext) => {
  // /race opens a picker while the generation guard still holds the terminal.
  // Suspending the line editor twice used to leave two live readline
  // interfaces on one stream: the second queued every later line as
  // type-ahead, so the next command ran a second time.
  const baseUrl = await startMockApi(t, { replyFor: (body) => `${body.reasoning_effort ?? "?"} 的回答` });
  const app = await harness(t, { config: { baseUrl } });
  await app.start();

  app.input.write("/race low max 问题\n");
  await settle(700);
  app.input.write("\r"); // keep the first branch
  await settle(400);

  const status = await app.send("/status", 350);
  assert.equal(status.split("状态").length - 1, 1, `/status must run once, got:\n${status}`);

  const context = await app.send("/context", 350);
  assert.equal(context.split("上下文报告").length - 1, 1, "and so must the next one");
  await app.finish();
});

test("nested suspensions rebuild the line editor only once", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const lineInput = new LineInput({ input, output });
  const lines: Array<string | undefined> = [];

  const pending = lineInput.next("❯ ");
  await settle(20);
  // Two overlapping suspensions, as a picker opened during a generation guard.
  lineInput.suspendForMenu();
  lineInput.suspendForMenu();
  lineInput.resumeFromMenu();
  lineInput.resumeFromMenu();
  await settle(20);

  void pending.then((value) => lines.push(value));
  input.write("hello\n");
  await settle(60);
  const extra = await Promise.race([
    lineInput.next("❯ ").then((value) => value ?? "<closed>"),
    settle(120).then(() => "<no duplicate>"),
  ]);
  lineInput.close();
  assert.deepEqual(lines, ["hello"]);
  assert.equal(extra, "<no duplicate>", "the line must not be delivered a second time");
});

// ---------------------------------------------------------------------------
// Live balance.
// ---------------------------------------------------------------------------

test("balance is fetched off the request path and carried forward between turns", async (t: TestContext) => {
  let balanceCalls = 0;
  let remaining = 42.5;
  const server: Server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      if ((request.url ?? "").endsWith("/user/balance")) {
        balanceCalls += 1;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            is_available: true,
            balance_infos: [
              { currency: "CNY", total_balance: remaining.toFixed(2), granted_balance: "0.00", topped_up_balance: remaining.toFixed(2) },
            ],
          }),
        );
        return;
      }
      remaining -= 0.03;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "答案\n" } }] })}\n\n`);
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 30000, completion_tokens: 2000, total_tokens: 32000, prompt_cache_hit_tokens: 28000, prompt_cache_miss_tokens: 2000 } })}\n\n`,
      );
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  // A hostname that is not loopback, redirected to the test server, so the
  // client treats it as a real keyed endpoint.
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) =>
    realFetch(String(url).replace(`api.test.invalid:${port}`, `127.0.0.1:${port}`), init)) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const app = await harness(t, {
    config: { baseUrl: `http://api.test.invalid:${port}`, model: "deepseek-v4-flash" },
  });
  await app.start();
  await settle(250); // the startup fetch is deliberately not awaited by run()

  const first = await app.send("问题一", 600);
  assert.match(first, /余额 ≈?[\d.]+ CNY/u, "the turn footer carries the remaining balance");

  const status = await app.send("/status", 400);
  assert.match(status, /余额\s+[\d.]+ CNY/u);
  assert.ok(balanceCalls >= 2, `balance should refresh after a turn, saw ${balanceCalls} calls`);
  await app.finish();
});
