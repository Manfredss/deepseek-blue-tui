import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import test from "node:test";

import { cliHelp, parseCliArgs } from "../src/args.js";
import {
  closestCommands,
  commandHelp,
  completeSlashCommand,
  parseSlashCommand,
  tokenizeArguments,
  unescapePrompt,
} from "../src/commands.js";
import { renderLogo } from "../src/logo.js";
import { commandForUrl, DEEPSEEK_URLS, openUrl } from "../src/open-url.js";
import { createTheme } from "../src/theme.js";

test("tokenizeArguments supports whitespace, quotes, and escaping", () => {
  assert.deepEqual(
    tokenizeArguments("one \"two three\" 'four five' six\\ seven \"quote\\\"x\" 'literal\\x' tail\\"),
    ["one", "two three", "four five", "six seven", 'quote"x', "literal\\x", "tail\\"],
  );
  assert.deepEqual(tokenizeArguments("  'unterminated value  "), ["unterminated value"]);
  assert.deepEqual(tokenizeArguments(""), []);
});

test("parseSlashCommand normalizes the name and preserves raw arguments", () => {
  assert.deepEqual(parseSlashCommand('  /MoDeL   "deepseek reasoner" custom  '), {
    name: "model",
    args: '"deepseek reasoner" custom',
    tokens: ["deepseek reasoner", "custom"],
  });
  assert.equal(parseSlashCommand("//literal slash"), undefined);
  assert.equal(parseSlashCommand("regular prompt"), undefined);
  assert.equal(parseSlashCommand("/"), undefined);
});

test("slash escaping and completion behave like terminal commands", () => {
  assert.equal(unescapePrompt("//model is text"), "/model is text");
  assert.equal(unescapePrompt("  //model is text"), "  /model is text");
  assert.equal(unescapePrompt("/model"), "/model");
  assert.deepEqual(completeSlashCommand("/mo"), [["/model"], "/mo"]);
  assert.deepEqual(completeSlashCommand("/unknown"), [[], "/unknown"]);
  assert.deepEqual(completeSlashCommand("/model deep"), [[], "/model deep"]);
  assert.match(commandHelp(), /\/dsh \[子命令\][^\n]*install\/start\/open\/status\/stop\/logs\/restart/);
  assert.match(commandHelp(), /输入 \/\//);
});

test("parseCliArgs returns interactive defaults", () => {
  assert.deepEqual(parseCliArgs([]), {
    command: "chat",
    commandArgs: [],
    continueLast: false,
    showLogo: true,
    color: true,
    showReasoning: false,
    help: false,
    version: false,
  });
});

test("parseCliArgs parses chat flags and joins prompt words", () => {
  assert.deepEqual(
    parseCliArgs([
      "--model",
      "deepseek-reasoner",
      "--base-url",
      "https://proxy.example/v1",
      "--thinking",
      "--no-logo",
      "--no-color",
      "--continue",
      "explain",
      "this",
    ]),
    {
      command: "chat",
      commandArgs: [],
      model: "deepseek-reasoner",
      baseUrl: "https://proxy.example/v1",
      prompt: "explain this",
      continueLast: true,
      showLogo: false,
      color: false,
      showReasoning: true,
      help: false,
      version: false,
    },
  );
});

test("parseCliArgs parses --effort into options for later validation", () => {
  assert.deepEqual(parseCliArgs(["--effort", "low", "hello"]), {
    ...parseCliArgs([]),
    effort: "low",
    prompt: "hello",
  });
  assert.throws(() => parseCliArgs(["--effort"]), /--effort 需要一个值/);
});

test("parseCliArgs handles subcommands, resume forms, and option terminator", () => {
  assert.deepEqual(parseCliArgs(["dsh", "start", "--port", "4000"]), {
    ...parseCliArgs([]),
    command: "dsh",
    commandArgs: ["start", "--port", "4000"],
  });
  assert.deepEqual(parseCliArgs(["resume", "abc-123", "continue", "here"]), {
    ...parseCliArgs([]),
    resume: "abc-123",
    prompt: "continue here",
  });
  assert.deepEqual(parseCliArgs(["resume"]), { ...parseCliArgs([]), resume: true });
  assert.deepEqual(parseCliArgs(["-r", "abc", "hello"]), {
    ...parseCliArgs([]),
    resume: "abc",
    prompt: "hello",
  });
  assert.deepEqual(parseCliArgs(["-r", "--thinking"]), {
    ...parseCliArgs([]),
    resume: true,
    showReasoning: true,
  });
  assert.deepEqual(parseCliArgs(["before", "--", "--literal", "after"]), {
    ...parseCliArgs([]),
    prompt: "before --literal after",
  });
});

test("parseCliArgs reports missing values and unknown options", () => {
  assert.throws(() => parseCliArgs(["--model"]), /--model 需要一个值/);
  assert.throws(() => parseCliArgs(["--endpoint", "--thinking"]), /--endpoint 需要一个值/);
  assert.throws(() => parseCliArgs(["--wat"]), /未知选项：--wat/);
  assert.match(cliHelp(), /deepseek dsh \[start\|open\|status\|stop\|logs\|restart\]/);
  assert.match(cliHelp(), /dstui 与 deepseek 等价/);
});

test("commandForUrl chooses a safe platform launcher and rejects other protocols", () => {
  const url = "https://example.com/path?q=deepseek#top";
  assert.deepEqual(commandForUrl(url, "darwin"), { command: "open", args: [url] });
  assert.deepEqual(commandForUrl(url, "linux"), { command: "xdg-open", args: [url] });
  assert.deepEqual(commandForUrl(url, "win32"), {
    command: "rundll32.exe",
    args: ["url.dll,FileProtocolHandler", url],
  });
  assert.throws(() => commandForUrl("file:///tmp/secret", "linux"), /仅允许打开 http\(s\) 链接/);
  assert.equal(DEEPSEEK_URLS.apiKeys, "https://platform.deepseek.com/api_keys");
  assert.equal(DEEPSEEK_URLS.usage, "https://platform.deepseek.com/usage");
  assert.equal(DEEPSEEK_URLS.topUp, "https://platform.deepseek.com/top_up");
});

interface FakeChild extends ChildProcess {
  unrefCalled: boolean;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.unrefCalled = false;
  child.unref = () => {
    child.unrefCalled = true;
    return child;
  };
  return child;
}

test("openUrl resolves true after spawn and detaches the browser process", async () => {
  const child = fakeChild();
  let invocation: { command: string; args: readonly string[]; options: unknown } | undefined;
  const spawnImpl = ((command: string, args: readonly string[], options: unknown) => {
    invocation = { command, args, options };
    queueMicrotask(() => child.emit("spawn"));
    return child;
  }) as unknown as typeof spawn;

  assert.equal(await openUrl("https://example.com", spawnImpl, "linux"), true);
  assert.deepEqual(invocation, {
    command: "xdg-open",
    args: ["https://example.com/"],
    options: { detached: true, stdio: "ignore", windowsHide: true },
  });
  assert.equal(child.unrefCalled, true);
});

test("openUrl resolves false for synchronous and asynchronous spawn failures", async () => {
  const throwingSpawn = (() => {
    throw new Error("missing launcher");
  }) as unknown as typeof spawn;
  assert.equal(await openUrl("https://example.com", throwingSpawn, "linux"), false);

  const child = fakeChild();
  const failingSpawn = (() => {
    queueMicrotask(() => child.emit("error", new Error("spawn failed")));
    return child;
  }) as unknown as typeof spawn;
  assert.equal(await openUrl("https://example.com", failingSpawn, "linux"), false);
  assert.equal(child.unrefCalled, false);
});

test("renderLogo renders a blue whale and styled product title", () => {
  const plain = renderLogo(createTheme(false));
  assert.match(plain, /▄{7}/);
  assert.match(plain, /●/);
  assert.match(plain, /DeepSeek Terminal/);
  assert.equal(plain.includes("\u001b["), false);

  const colored = renderLogo(createTheme(true, { COLORTERM: "truecolor" }));
  assert.match(colored, /\u001b\[38;2;77;107;254m/);
  assert.match(colored, /\u001b\[1mDeepSeek\u001b\[22m/);
  assert.match(colored, /\u001b\[38;2;128;138;157mTerminal\u001b\[0m/);
});

test("closestCommands suggests prefixes first and tolerates small typos", () => {
  assert.deepEqual(closestCommands("mod"), ["/model"]);
  assert.deepEqual(closestCommands("moddel"), ["/model"]);
  assert.deepEqual(closestCommands("statuss"), ["/status"]);
  assert.deepEqual(closestCommands("e"), ["/effort", "/export", "/edit"], "prefix matches keep command order");
  assert.deepEqual(closestCommands("zzzzzzzz"), [], "a wild miss suggests nothing");
  assert.deepEqual(closestCommands("Users/wenfei/notes.md"), [], "a path is not a near-miss command");
  assert.ok(closestCommands("co").length <= 3, "suggestions stay short");
});

test("commandHelp documents the keyboard shortcuts users are expected to know", () => {
  const help = commandHelp();
  for (const key of ["Ctrl+C", "Ctrl+D", "Ctrl+L", "Esc", "Enter"]) {
    assert.ok(help.includes(key), `help should mention ${key}`);
  }
  assert.equal(help.includes("\u001b["), false, "plain help must not leak ANSI");
  assert.ok(commandHelp(createTheme(true, { COLORTERM: "truecolor" })).includes("\u001b["));
});
