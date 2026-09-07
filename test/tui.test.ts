import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";

import { ConfigStore } from "../src/config.js";
import { DshManager, type DshStatus, type HeadlessResult } from "../src/dsh.js";
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

interface MockOptions {
  content?: string[];
  status?: number;
  errorBody?: string;
  delayMs?: number;
  /** Reply text chosen from the request body (used to tell /race branches apart). */
  replyFor?: (body: { reasoning_effort?: string }) => string;
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
      let body: { reasoning_effort?: string } = {};
      try {
        body = JSON.parse(raw || "{}") as { reasoning_effort?: string };
      } catch {
        body = {};
      }
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

  assert.match(out, /┌─ ts/, "the code block is labelled");
  assert.match(out, /│ const x = 1;/, "code carries the gutter even when deltas split the fence");
  assert.match(out, /└─/, "and the block is closed");
  assert.doesNotMatch(out, /```/, "raw fences are consumed, not printed");
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
  await settle(700);
  const compared = app.plain();
  assert.match(compared, /并行对比 low \/ max/);
  assert.match(compared, /这是 low 档的回答/, "each branch really used its own effort");
  assert.match(compared, /这是 max 档的回答/);
  assert.match(compared, /保留哪一个/, "a picker offers the branches");

  app.input.write("\r"); // keep the highlighted (first) branch
  await settle(400);
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

test("/race needs at least two efforts and a question", async (t: TestContext) => {
  const app = await harness(t);
  await app.start();
  assert.match(await app.send("/race low"), /至少要两个档位/);
  assert.match(await app.send("/race"), /用法：\/race/, "with no history there is nothing to reuse");
  await app.finish();
});

/** A DSH stub whose headless run is fully controlled by the test. */
class StubDsh extends DshManager {
  constructor(home: string, private readonly reply: HeadlessResult) {
    super(home);
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
  await settle(400);
  const done = app.plain();
  assert.match(done, /◆ DSH/);
  assert.match(done, /改了 2 个文件/);
  assert.match(done, /┌─ diff/, "agent output is rendered as markdown too");

  // The earlier conversation is handed over so the agent is not starting blind.
  assert.match(StubDsh.lastTask, /此前的对话背景/);
  assert.match(StubDsh.lastTask, /touchLock/);
  assert.match(StubDsh.lastTask, /按上面的结论修掉$/u, "the task itself comes last");

  await app.finish();
  const [saved] = await app.sessionStore.list({});
  assert.equal(saved?.messages.length, 4, "the delegation is recorded as a turn");
  assert.match(saved?.messages[3]?.content ?? "", /^\[DSH 执行结果\]/u, "provenance is explicit");
});

test("/do declines cleanly and reports a missing DSH", async (t: TestContext) => {
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
