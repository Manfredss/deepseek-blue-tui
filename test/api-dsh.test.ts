import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  DeepSeekApiError,
  DeepSeekConnectionError,
  getBalance,
  parseSse,
  streamChat,
} from "../src/api.js";
import {
  DshManager,
  dshChildEnvironment,
  dshExecutableName,
  formatDshStatus,
  installDsh,
  isPortOpen,
  redactSecrets,
  resolveDshCommand,
} from "../src/dsh.js";
import { EMPTY_USAGE, type ChatMessage, type TokenUsage } from "../src/types.js";

async function temporaryDirectory(t: TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function byteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function fragmentedUtf8Stream(value: string, sizes: number[]): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(value);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let index = 0;
  while (offset < encoded.length) {
    const size = sizes[index % sizes.length] ?? 1;
    chunks.push(encoded.slice(offset, offset + size));
    offset += size;
    index += 1;
  }
  return byteStream(chunks);
}

test("parseSse survives arbitrary byte chunks, CRLF, UTF-8 splits, and keepalives", async () => {
  const input = [
    ": keepalive\r\n",
    "\r\n",
    'data: {"text":"鲸鱼"}\r\n',
    "\r\n",
    "data: first\n",
    ": comment inside event\n",
    "data: second\n",
    "\n",
    ": trailing keepalive\n",
    "\n",
    "data: tail-without-blank-line",
  ].join("");
  const events: string[] = [];
  for await (const event of parseSse(fragmentedUtf8Stream(input, [1, 2, 5, 3]))) events.push(event);
  assert.deepEqual(events, ['{"text":"鲸鱼"}', "first\nsecond", "tail-without-blank-line"]);
});

test("streamChat sends compatible messages and aggregates reasoning, content, and usage", async () => {
  const sse = [
    ": ping\n\n",
    "data: not-json\n\n",
    'data: {"choices":[{"delta":{"reasoning_content":"先想"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning_content":"一下","content":"答"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"案"},"finish_reason":"stop"}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":5,"total_tokens":12,"prompt_cache_hit_tokens":2,"prompt_cache_miss_tokens":3,"completion_tokens_details":{"reasoning_tokens":4}}}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  const messages: ChatMessage[] = [
    { role: "user", content: "question", createdAt: "2026-01-01T00:00:00.000Z", reasoningContent: "ignore" },
    {
      role: "assistant",
      content: "previous",
      reasoningContent: "previous thought",
      createdAt: "2026-01-01T00:00:01.000Z",
    },
  ];
  let request: { url: string; init?: RequestInit } | undefined;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    request = { url: String(url), ...(init ? { init } : {}) };
    return new Response(fragmentedUtf8Stream(sse, [7, 1, 11, 2]), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as typeof fetch;
  const contents: string[] = [];
  const thoughts: string[] = [];
  const usages: TokenUsage[] = [];

  const result = await streamChat({
    apiKey: "sk-test",
    baseUrl: "https://api.example/v1///",
    model: "deepseek-reasoner",
    messages,
    fetchImpl,
    onContent: (delta) => contents.push(delta),
    onReasoning: (delta) => thoughts.push(delta),
    onUsage: (usage) => usages.push(usage),
  });

  assert.equal(request?.url, "https://api.example/v1/chat/completions");
  assert.equal(request?.init?.method, "POST");
  assert.deepEqual(request?.init?.headers, {
    Authorization: "Bearer sk-test",
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  });
  assert.ok(request?.init?.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    model: "deepseek-reasoner",
    messages: [
      { role: "user", content: "question" },
      { role: "assistant", content: "previous", reasoning_content: "previous thought" },
    ],
    stream: true,
    stream_options: { include_usage: true },
  });
  assert.deepEqual(contents, ["答", "案"]);
  assert.deepEqual(thoughts, ["先想", "一下"]);
  assert.deepEqual(usages, [
    {
      promptTokens: 7,
      completionTokens: 5,
      totalTokens: 12,
      promptCacheHitTokens: 2,
      promptCacheMissTokens: 3,
      reasoningTokens: 4,
    },
  ]);
  assert.deepEqual(result, {
    content: "答案",
    reasoningContent: "先想一下",
    finishReason: "stop",
    usage: usages[0],
  });
});

test("streamChat maps structured HTTP errors and safe fallback messages", async () => {
  const structuredFetch = (async () => new Response(JSON.stringify({
    error: { message: "bad credential", code: "invalid_api_key" },
  }), { status: 401 })) as typeof fetch;
  await assert.rejects(
    streamChat({
      apiKey: "bad",
      baseUrl: "https://api.example",
      model: "m",
      messages: [],
      fetchImpl: structuredFetch,
    }),
    (error: unknown) => {
      assert.ok(error instanceof DeepSeekApiError);
      assert.equal(error.message, "bad credential");
      assert.equal(error.status, 401);
      assert.equal(error.code, "invalid_api_key");
      return true;
    },
  );

  const fallbackFetch = (async () => new Response("not json", { status: 429 })) as typeof fetch;
  await assert.rejects(
    streamChat({
      apiKey: "key",
      baseUrl: "https://api.example",
      model: "m",
      messages: [],
      fetchImpl: fallbackFetch,
    }),
    (error: unknown) => error instanceof DeepSeekApiError && error.message === "请求过于频繁，请稍后重试",
  );
});

test("streamChat reports a missing response body", async () => {
  const fetchImpl = (async () => ({ ok: true, status: 204, body: null })) as typeof fetch;
  await assert.rejects(
    streamChat({ apiKey: "key", baseUrl: "https://api.example", model: "m", messages: [], fetchImpl }),
    (error: unknown) => error instanceof DeepSeekApiError && error.status === 204 && /未返回响应流/.test(error.message),
  );
});

test("network failures include the configured endpoint in a friendly Chinese error", async () => {
  const baseUrl = "https://gateway.example/deepseek/v1";
  const failure = new TypeError("fetch failed");
  const fetchImpl = (async () => {
    throw failure;
  }) as typeof fetch;
  const requests = [
    () => streamChat({ apiKey: "key", baseUrl, model: "m", messages: [], fetchImpl }),
    () => getBalance({ apiKey: "key", baseUrl, fetchImpl }),
  ];

  for (const request of requests) {
    await assert.rejects(request, (error: unknown) => {
      assert.ok(error instanceof DeepSeekConnectionError);
      assert.equal(error.endpoint, baseUrl);
      assert.match(error.message, /^无法连接 /);
      assert.match(error.message, /https:\/\/gateway\.example\/deepseek\/v1/);
      assert.equal(error.cause, failure);
      return true;
    });
  }
});

test("getBalance normalizes valid balances and ignores malformed rows", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    request = { url: String(url), ...(init ? { init } : {}) };
    return Response.json({
      is_available: true,
      balance_infos: [
        { currency: "CNY", total_balance: "10.00", granted_balance: "1.00", topped_up_balance: "9.00" },
        { currency: "USD", total_balance: 3, granted_balance: "0", topped_up_balance: "3" },
        null,
      ],
    });
  }) as typeof fetch;
  assert.deepEqual(await getBalance({ apiKey: "sk-balance", baseUrl: "https://api.example/", fetchImpl }), {
    available: true,
    balances: [
      { currency: "CNY", totalBalance: "10.00", grantedBalance: "1.00", toppedUpBalance: "9.00" },
    ],
  });
  assert.equal(request?.url, "https://api.example/user/balance");
  assert.deepEqual(request?.init?.headers, { Authorization: "Bearer sk-balance", Accept: "application/json" });
  assert.ok(request?.init?.signal instanceof AbortSignal);
});

test("getBalance rejects a malformed success payload", async () => {
  const fetchImpl = (async () => Response.json({ is_available: true })) as typeof fetch;
  await assert.rejects(
    getBalance({ apiKey: "key", baseUrl: "https://api.example", fetchImpl }),
    (error: unknown) => error instanceof DeepSeekApiError && /无效数据/.test(error.message),
  );
});

test("getBalance honors timeoutMs and aborts a fetch that would otherwise hang", { timeout: 2_000 }, async () => {
  let receivedSignal: AbortSignal | undefined;
  const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    receivedSignal = init?.signal ?? undefined;
    assert.ok(receivedSignal instanceof AbortSignal);
    const watchdog = setTimeout(() => reject(new Error("fetch mock did not observe the configured timeout")), 1_000);
    const rejectOnAbort = (): void => {
      clearTimeout(watchdog);
      reject(receivedSignal?.reason ?? new DOMException("aborted", "AbortError"));
    };
    if (receivedSignal.aborted) rejectOnAbort();
    else receivedSignal.addEventListener("abort", rejectOnAbort, { once: true });
  })) as typeof fetch;

  await assert.rejects(
    getBalance({ apiKey: "key", baseUrl: "https://api.example", timeoutMs: 20, fetchImpl }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "DeepSeekTimeoutError");
      assert.match(error.message, /余额查询超时/);
      assert.match(error.message, /https:\/\/api\.example/);
      return true;
    },
  );
  assert.equal(receivedSignal?.aborted, true);
});

test("getBalance propagates an external abort to fetch and rejects as AbortError", async () => {
  const external = new AbortController();
  const reason = new Error("user cancelled usage lookup");
  let receivedSignal: AbortSignal | undefined;
  const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    receivedSignal = init?.signal ?? undefined;
    assert.ok(receivedSignal instanceof AbortSignal);
    const rejectOnAbort = (): void => reject(receivedSignal?.reason ?? new DOMException("aborted", "AbortError"));
    if (receivedSignal.aborted) rejectOnAbort();
    else receivedSignal.addEventListener("abort", rejectOnAbort, { once: true });
  })) as typeof fetch;

  const balance = getBalance({
    apiKey: "key",
    baseUrl: "https://api.example",
    signal: external.signal,
    timeoutMs: 1_000,
    fetchImpl,
  });
  external.abort(reason);

  await assert.rejects(balance, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "AbortError");
    assert.match(error.message, /已取消余额查询/);
    return true;
  });
  assert.equal(receivedSignal?.aborted, true);
  assert.equal(receivedSignal?.reason, reason);
});

function rejectingRequire(): NodeRequire {
  return {
    resolve() {
      throw new Error("not installed");
    },
  } as unknown as NodeRequire;
}

test("resolveDshCommand gives an explicit custom command highest priority", async (t) => {
  assert.deepEqual(resolveDshCommand({
    env: { DEEPSEEK_DSH_COMMAND: " custom-dsh ", PATH: "" },
    requireFrom: rejectingRequire(),
  }), {
    command: "custom-dsh",
    argsPrefix: [],
    source: "custom",
    display: "custom-dsh",
  });

  const directory = await temporaryDirectory(t, "deepseek-dsh-custom-");
  const executable = join(directory, "my-dsh");
  await writeFile(executable, "#!/bin/sh\n", "utf8");
  await chmod(executable, 0o755);
  assert.equal(resolveDshCommand({
    env: { DEEPSEEK_DSH_COMMAND: join(directory, "missing") },
    requireFrom: rejectingRequire(),
  }), undefined);
  assert.equal(resolveDshCommand({
    env: { DEEPSEEK_DSH_COMMAND: executable },
    requireFrom: rejectingRequire(),
  })?.command, executable);
});

test("resolveDshCommand resolves a bundled manifest and preserves its version", async (t) => {
  const directory = await temporaryDirectory(t, "deepseek-dsh-bundled-");
  const manifestPath = join(directory, "package.json");
  const binPath = join(directory, "lib", "bin.js");
  await mkdir(join(directory, "lib"));
  await writeFile(manifestPath, JSON.stringify({ version: "0.1.0-rc.7", bin: { dsh: "lib/bin.js" } }), "utf8");
  await writeFile(binPath, "", "utf8");
  const requireFrom = {
    resolve(specifier: string) {
      assert.equal(specifier, "@deepseek-ai/dsh/package.json");
      return manifestPath;
    },
  } as unknown as NodeRequire;

  assert.deepEqual(resolveDshCommand({ env: { PATH: "" }, requireFrom }), {
    command: process.execPath,
    argsPrefix: [binPath],
    source: "bundled",
    display: `${process.execPath} ${binPath}`,
    version: "0.1.0-rc.7",
  });
});

test("resolveDshCommand falls back to an executable on PATH", async (t) => {
  const directory = await temporaryDirectory(t, "deepseek-dsh-path-");
  const executable = join(directory, process.platform === "win32" ? "dsh.cmd" : "dsh");
  await writeFile(executable, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n", "utf8");
  await chmod(executable, 0o755);
  const command = resolveDshCommand({ env: { PATH: directory }, requireFrom: rejectingRequire() });
  assert.deepEqual(command, {
    command: executable,
    argsPrefix: [],
    source: "path",
    display: executable,
  });
  assert.equal(command && dshExecutableName(command), basename(executable));
  assert.equal(resolveDshCommand({ env: { PATH: "" }, requireFrom: rejectingRequire() }), undefined);
});

test("DSH child environment does not inherit chat credentials", () => {
  const source = {
    PATH: "/bin",
    DSH_HOME: "/tmp/dsh",
    DEEPSEEK_API_KEY: "sk-secret",
    DEEPSEEK_BASE_URL: "https://proxy.example",
  };
  const child = dshChildEnvironment(source);
  assert.equal(child.PATH, "/bin");
  assert.equal(child.DSH_HOME, "/tmp/dsh");
  assert.equal(child.DEEPSEEK_API_KEY, undefined);
  assert.equal(child.DEEPSEEK_BASE_URL, undefined);
  assert.equal(source.DEEPSEEK_API_KEY, "sk-secret");
});

test("isPortOpen detects a listening TCP port and a closed port", async (t) => {
  const server = createServer();
  t.after(() => server.close());
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  assert.equal(await isPortOpen(port, "127.0.0.1", 500), true);
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  assert.equal(await isPortOpen(port, "127.0.0.1", 100), false);
});

test("DshManager validates ports and reports stopped state without launching", async (t) => {
  const manager = new DshManager(await temporaryDirectory(t, "deepseek-dsh-manager-"));
  await assert.rejects(manager.start({ port: 0 }), /DSH 端口必须在 1 到 65535 之间/);
  await assert.rejects(manager.start({ port: 65_536 }), /DSH 端口必须在 1 到 65535 之间/);

  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  assert.deepEqual(await manager.status(port), {
    phase: "stopped",
    port,
    url: `http://127.0.0.1:${port}`,
  });
});

test("formatDshStatus includes useful process and compatibility details", () => {
  assert.equal(formatDshStatus({ phase: "stopped", port: 3080, url: "http://127.0.0.1:3080" }),
    "已停止 · http://127.0.0.1:3080");
  assert.equal(formatDshStatus({
    phase: "running",
    port: 3080,
    url: "http://127.0.0.1:3080",
    pid: 42,
    version: "0.1.0-rc.7",
    warning: "warning",
  }), "运行中 · http://127.0.0.1:3080 · PID 42 · DSH 0.1.0-rc.7 · warning");
});

test("streamChat defaults to empty usage when the stream omits usage", async () => {
  const fetchImpl = (async () => new Response("data: [DONE]\n\n", { status: 200 })) as typeof fetch;
  assert.deepEqual(await streamChat({
    apiKey: "key",
    baseUrl: "https://api.example",
    model: "model",
    messages: [],
    fetchImpl,
  }), { content: "", reasoningContent: "", usage: EMPTY_USAGE });
});

test("redactSecrets masks API keys, bearer tokens, and authorization headers in logs", () => {
  const input = [
    "GET https://api.deepseek.com with key sk-1234567890abcdef",
    "token=Bearer abcdefghijklmnopqrstuvwxyz012345",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
    "Authorization: sk-abcdefgh12345678",
    "some unrelated text stays intact",
  ].join("\n");
  const redacted = redactSecrets(input);
  assert.equal(redacted.includes("sk-1234567890abcdef"), false);
  assert.equal(redacted.includes("sk-abcdefgh12345678"), false);
  assert.equal(redacted.includes("abcdefghijklmnopqrstuvwxyz012345"), false);
  assert.match(redacted, /sk-•{8}/);
  assert.match(redacted, /Bearer •{8}/);
  // Authorization lines are masked wholesale, whatever the scheme.
  assert.equal((redacted.match(/Authorization: •{8}/g) ?? []).length, 2);
  assert.equal(redacted.includes("unrelated text"), true);
});

test("installDsh reports an already available dsh without running npm", async (t) => {
  const directory = await temporaryDirectory(t, "deepseek-dsh-install-");
  const executable = join(directory, process.platform === "win32" ? "dsh.cmd" : "dsh");
  await writeFile(executable, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n", "utf8");
  if (process.platform !== "win32") await chmod(executable, 0o755);

  const result = await installDsh({
    env: { ...process.env, PATH: directory },
    requireFrom: rejectingRequire(),
  });
  assert.equal(result.installed, false);
  assert.equal(result.command?.command, executable);
  assert.match(result.message, /DSH 已可用/);
});

test("installDsh installs the pinned version through npm when dsh is missing", async (t) => {
  const directory = await temporaryDirectory(t, "deepseek-dsh-install-npm-");
  const fakeNpmDirectory = join(directory, "npm-bin");
  const prefix = join(directory, "prefix");
  await mkdir(fakeNpmDirectory, { recursive: true });
  const binDirectory = process.platform === "win32" ? prefix : join(prefix, "bin");
  await mkdir(binDirectory, { recursive: true });

  // Pre-create the dsh executable so the script only needs to simulate npm
  // succeeding; the marker proves the fake npm actually ran.
  const dshTarget = join(binDirectory, process.platform === "win32" ? "dsh.cmd" : "dsh");
  await writeFile(dshTarget, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n", "utf8");
  if (process.platform !== "win32") await chmod(dshTarget, 0o755);
  const marker = join(directory, "npm-ran.txt");

  const npmPath = join(fakeNpmDirectory, process.platform === "win32" ? "npm.cmd" : "npm");
  if (process.platform === "win32") {
    await writeFile(
      npmPath,
      `@echo off\r\nif "%1"=="config" echo ${prefix}\r\nif "%1"=="install" echo ran > "${marker}"\r\n`,
      "utf8",
    );
  } else {
    await writeFile(
      npmPath,
      `#!/bin/sh\nif [ "$1" = "config" ]; then echo "${prefix}"; fi\nif [ "$1" = "install" ]; then echo ran > "${marker}"; fi\n`,
      "utf8",
    );
    await chmod(npmPath, 0o755);
  }
  const env = { ...process.env };
  delete env.DEEPSEEK_DSH_COMMAND;
  // Only the fake npm may resolve; a real `dsh` on the developer PATH would
  // otherwise short-circuit the install branch.
  env.PATH = fakeNpmDirectory;

  const result = await installDsh({ env, version: "0.1.0-rc.7", requireFrom: rejectingRequire() });
  assert.equal(result.installed, true);
  assert.ok(result.command);
  assert.equal(result.command.source, "path");
  assert.equal(result.command.command, dshTarget);
  assert.equal(result.command.version, "0.1.0-rc.7");
  assert.equal(await readFile(marker, "utf8"), "ran\n");
});
