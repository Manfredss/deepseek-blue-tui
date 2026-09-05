import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";

import { ConfigStore } from "../src/config.js";
import { DshManager, type DshStatus } from "../src/dsh.js";
import { createSession, SessionStore } from "../src/session-store.js";
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

interface MockOptions {
  content?: string[];
  status?: number;
  errorBody?: string;
  delayMs?: number;
}

async function startMockApi(t: TestContext, options: MockOptions = {}): Promise<string> {
  const server: Server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      if (options.status !== undefined && options.status >= 400) {
        response.writeHead(options.status, { "Content-Type": "application/json" });
        response.end(options.errorBody ?? JSON.stringify({ error: { message: "boom" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const events = (options.content ?? ["ok"]).map(
        (delta) => `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`,
      );
      events.push(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
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
  start: () => Promise<void>;
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
      reset();
    },
    finish: async () => {
      input.write("/exit\n");
      await settle(200);
      await running;
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
  const baseUrl = await startMockApi(t, { content: ["一", "二", "三", "四", "五"], delayMs: 120 });
  const app = await harness(t, { config: { baseUrl } });
  await app.start();

  app.input.write("慢慢来\n");
  await settle(300);
  app.input.write(ESC); // Esc aborts an in-flight generation.
  await settle(400);
  assert.match(app.plain(), /已中断本次生成/);
  await app.finish();

  const [saved] = await app.sessionStore.list({});
  assert.equal(saved?.messages[0]?.role, "user");
  assert.equal(saved?.messages[1]?.role, "assistant");
  assert.ok((saved?.messages[1]?.content.length ?? 0) > 0, "the partial answer is not thrown away");
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
  await settle(150);
  assert.match(app.plain(), /命令执行中…再按一次 Ctrl\+C 退出/);

  await settle(700);
  assert.match(app.plain(), /仍在启动/, "the command still finished normally");
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
