import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import {
  ConfigStore,
  isValidBaseUrl,
  maskApiKey,
  normalizeConfig,
  resolveAppHome,
} from "../src/config.js";
import {
  SessionStore,
  addUsage,
  createSession,
  deriveTitle,
  estimateTokens,
  parseSession,
  truncateToLimit,
} from "../src/session-store.js";
import { DEFAULT_CONFIG, EMPTY_USAGE, type ChatMessage, type Session } from "../src/types.js";

async function temporaryDirectory(t: TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test("resolveAppHome honors explicit and XDG homes", () => {
  assert.equal(resolveAppHome({ DEEPSEEK_TUI_HOME: " ./custom-home " }), resolve("./custom-home"));
  assert.equal(resolveAppHome({ XDG_CONFIG_HOME: "/tmp/xdg" }), join("/tmp/xdg", "deepseek-tui"));
  assert.equal(
    resolveAppHome({ DEEPSEEK_TUI_HOME: "/tmp/deepseek", XDG_CONFIG_HOME: "/tmp/ignored" }),
    resolve("/tmp/deepseek"),
  );
});

test("base URL validation accepts only credential-free HTTP(S) URLs", () => {
  assert.equal(isValidBaseUrl("https://api.deepseek.com"), true);
  assert.equal(isValidBaseUrl("http://127.0.0.1:8080/v1"), true);
  assert.equal(isValidBaseUrl("ftp://api.deepseek.com"), false);
  assert.equal(isValidBaseUrl("https://user:secret@example.com"), false);
  assert.equal(isValidBaseUrl("not a URL"), false);
});

test("normalizeConfig trims valid values and sanitizes invalid fields", () => {
  assert.deepEqual(
    normalizeConfig({
      version: 99,
      model: "  deepseek-reasoner  ",
      baseUrl: " https://gateway.example/v1/// ",
      apiKey: "  sk-secret  ",
      showReasoning: true,
      dshPort: 65_535,
      contextLimitTokens: 200_000,
    }),
    {
      version: 1,
      model: "deepseek-reasoner",
      baseUrl: "https://gateway.example/v1",
      apiKey: "sk-secret",
      showReasoning: true,
      dshPort: 65_535,
      contextLimitTokens: 200_000,
    },
  );

  assert.deepEqual(
    normalizeConfig({ model: " ", baseUrl: "file:///tmp/socket", apiKey: " ", dshPort: 0, contextLimitTokens: 100 }),
    DEFAULT_CONFIG,
  );
  assert.deepEqual(normalizeConfig(null), DEFAULT_CONFIG);
});

test("ConfigStore round-trips normalized configuration and supplies defaults", async (t) => {
  const home = await temporaryDirectory(t, "deepseek-config-");
  const store = new ConfigStore(home);

  assert.deepEqual(await store.load(), DEFAULT_CONFIG);
  await store.save({
    version: 1,
    model: " custom-model ",
    baseUrl: "https://example.test/v1/",
    apiKey: " key ",
    showReasoning: true,
    dshPort: 4444,
    contextLimitTokens: 256_000,
  });

  assert.deepEqual(await store.load(), {
    version: 1,
    model: "custom-model",
    baseUrl: "https://example.test/v1",
    apiKey: "key",
    showReasoning: true,
    dshPort: 4444,
    contextLimitTokens: 256_000,
  });
  const serialized = await readFile(store.configPath, "utf8");
  assert.equal(serialized.endsWith("\n"), true);
});

test("ConfigStore reports malformed JSON and applies runtime environment overrides", async (t) => {
  const home = await temporaryDirectory(t, "deepseek-config-invalid-");
  const store = new ConfigStore(home);
  await writeFile(store.configPath, "{broken", "utf8");
  await assert.rejects(store.load(), new RegExp(`配置文件格式无效：${store.configPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

  const base = { ...DEFAULT_CONFIG, apiKey: "saved-key" };
  assert.deepEqual(store.runtime(base, {
    DEEPSEEK_API_KEY: " env-key ",
    DEEPSEEK_BASE_URL: " https://proxy.example/v1/// ",
  }), {
    ...base,
    apiKey: "env-key",
    baseUrl: "https://proxy.example/v1",
  });
  assert.equal(base.apiKey, "saved-key", "runtime overrides must not mutate the stored config");
  assert.throws(
    () => store.runtime(base, { DEEPSEEK_BASE_URL: "ssh://proxy.example" }),
    /DEEPSEEK_BASE_URL 必须是有效的 http\(s\) URL/,
  );
});

test("maskApiKey reveals only a small identifying prefix and suffix", () => {
  assert.equal(maskApiKey(undefined), "未配置");
  assert.equal(maskApiKey("short"), "sho••••");
  assert.equal(maskApiKey("sk-1234567890abcdef"), "sk-12••••cdef");
});

test("createSession initializes stable timestamps, UUID, and empty usage", () => {
  const now = new Date("2026-08-18T01:02:03.000Z");
  const session = createSession("/workspace", "deepseek-chat", now);
  assert.match(session.id, /^[0-9a-f-]{36}$/);
  assert.equal(session.createdAt, now.toISOString());
  assert.equal(session.updatedAt, now.toISOString());
  assert.equal(session.title, "New conversation");
  assert.deepEqual(session.messages, []);
  assert.deepEqual(session.usage, EMPTY_USAGE);
  assert.notEqual(session.usage, EMPTY_USAGE);
});

test("parseSession rejects unsafe identities and cleans messages and usage", () => {
  assert.equal(parseSession(null), undefined);
  assert.equal(parseSession({ id: "../escape", cwd: "/tmp", model: "m", messages: [] }), undefined);
  assert.equal(parseSession({ id: "safe", cwd: "/tmp", model: "m", messages: "nope" }), undefined);

  const parsed = parseSession({
    version: 55,
    id: "safe-123",
    title: "",
    cwd: "/workspace",
    model: "deepseek-chat",
    messages: [
      { role: "user", content: "hello", createdAt: "2026-01-01T00:00:00.000Z" },
      { role: "assistant", content: "answer", reasoningContent: "thought" },
      { role: "tool", content: "discard me" },
      { role: "assistant", content: 42 },
    ],
    usage: {
      promptTokens: 3,
      completionTokens: -1,
      totalTokens: Number.POSITIVE_INFINITY,
      promptCacheHitTokens: 2,
      promptCacheMissTokens: "4",
      reasoningTokens: 1,
    },
  });

  assert.deepEqual(parsed, {
    version: 1,
    id: "safe-123",
    title: "New conversation",
    cwd: "/workspace",
    model: "deepseek-chat",
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
    messages: [
      { role: "user", content: "hello", createdAt: "2026-01-01T00:00:00.000Z" },
      {
        role: "assistant",
        content: "answer",
        reasoningContent: "thought",
        createdAt: "1970-01-01T00:00:00.000Z",
      },
    ],
    usage: {
      promptTokens: 3,
      completionTokens: 0,
      totalTokens: 0,
      promptCacheHitTokens: 2,
      promptCacheMissTokens: 0,
      reasoningTokens: 1,
    },
  });
});

test("deriveTitle collapses whitespace and truncates to sixty characters", () => {
  assert.equal(deriveTitle("  hello\n\tworld  "), "hello world");
  assert.equal(deriveTitle(" \n "), "New conversation");
  const long = "a".repeat(61);
  assert.equal(deriveTitle(long), `${"a".repeat(57)}…`);
  assert.equal(deriveTitle("b".repeat(60)), "b".repeat(60));
});

test("addUsage sums every tracked token category without mutating inputs", () => {
  const left = {
    promptTokens: 1,
    completionTokens: 2,
    totalTokens: 3,
    promptCacheHitTokens: 4,
    promptCacheMissTokens: 5,
    reasoningTokens: 6,
  };
  const right = {
    promptTokens: 10,
    completionTokens: 20,
    totalTokens: 30,
    promptCacheHitTokens: 40,
    promptCacheMissTokens: 50,
    reasoningTokens: 60,
  };
  assert.deepEqual(addUsage(left, right), {
    promptTokens: 11,
    completionTokens: 22,
    totalTokens: 33,
    promptCacheHitTokens: 44,
    promptCacheMissTokens: 55,
    reasoningTokens: 66,
  });
  assert.equal(left.promptTokens, 1);
});

function fixtureSession(id: string, title: string, cwd: string, updatedAt: string): Session {
  return {
    version: 1,
    id,
    title,
    cwd,
    model: "deepseek-chat",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
    messages: [],
    usage: { ...EMPTY_USAGE },
  };
}

test("SessionStore saves, loads, lists, filters, limits, and finds sessions", async (t) => {
  const home = await temporaryDirectory(t, "deepseek-sessions-");
  const store = new SessionStore(home);
  const saved = fixtureSession("saved-session", "Saved", "/saved", "2000-01-01T00:00:00.000Z");
  await store.save(saved);
  assert.ok(Date.parse(saved.updatedAt) > Date.parse("2000-01-01T00:00:00.000Z"));
  assert.deepEqual(await store.load(saved.id), saved);
  assert.equal(await store.load("missing"), undefined);

  await mkdir(store.directory, { recursive: true });
  const fixtures = [
    fixtureSession("alpha-001", "First Project", "/one", "2026-03-01T00:00:00.000Z"),
    fixtureSession("beta-002", "Second Project", "/one", "2026-02-01T00:00:00.000Z"),
    fixtureSession("gamma-003", "Other Folder", "/two", "2026-04-01T00:00:00.000Z"),
  ];
  await Promise.all(fixtures.map((session) => writeFile(store.pathFor(session.id), JSON.stringify(session), "utf8")));
  await writeFile(join(store.directory, "invalid.json"), "{not-json", "utf8");
  await writeFile(join(store.directory, "notes.txt"), "ignored", "utf8");

  assert.deepEqual((await store.list({ cwd: "/one", limit: 2 })).map(({ id }) => id), ["alpha-001", "beta-002"]);
  assert.deepEqual((await store.find("ALPHA", "/one")).map(({ id }) => id), ["alpha-001"]);
  assert.deepEqual((await store.find("second project", "/one")).map(({ id }) => id), ["beta-002"]);
  assert.deepEqual((await store.find("", "/two")).map(({ id }) => id), ["gamma-003"]);
});

test("SessionStore rejects traversal-like IDs", async (t) => {
  const store = new SessionStore(await temporaryDirectory(t, "deepseek-session-path-"));
  assert.throws(() => store.pathFor("../config"), /无效的会话 ID/);
  assert.throws(() => store.pathFor(""), /无效的会话 ID/);
});

test("estimateTokens weights CJK and ASCII and includes message overhead", () => {
  const ascii: ChatMessage = { role: "user", content: "a".repeat(100), createdAt: "2026-01-01T00:00:00.000Z" };
  const cjk: ChatMessage = { role: "user", content: "汉".repeat(100), createdAt: "2026-01-01T00:00:00.000Z" };
  assert.equal(estimateTokens([ascii]), 4 + 25); // overhead + 100 ASCII chars / 4
  assert.equal(estimateTokens([cjk]), 4 + 100); // overhead + 100 CJK chars
  assert.equal(estimateTokens([]), 0);
});

test("truncateToLimit keeps system messages and the newest tail, dropping the oldest", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "sys", createdAt: "2026-01-01T00:00:00.000Z" },
    { role: "user", content: "汉".repeat(100), createdAt: "2026-01-01T00:00:01.000Z" },
    { role: "user", content: "a".repeat(100), createdAt: "2026-01-01T00:00:02.000Z" },
    { role: "assistant", content: "汉".repeat(100), createdAt: "2026-01-01T00:00:03.000Z" },
  ];
  // system(≈5) + assistant(104) + ascii user(29) = ≈138 fits in 150; + cjk user(104) = ≈242 does not.
  const result = truncateToLimit(messages, 150);
  assert.equal(result.dropped, 1);
  assert.equal(result.messages.length, 3);
  assert.equal(result.messages[0]?.role, "system");
  assert.equal(result.messages[1]?.content, "a".repeat(100));
  assert.equal(result.messages[2]?.content, "汉".repeat(100));

  // A single oversized message is still kept rather than sending an empty tail.
  const oversized = truncateToLimit(messages, 10);
  assert.equal(oversized.dropped, 2);
  assert.equal(oversized.messages.length, 2);
  assert.equal(oversized.messages[0]?.role, "system");
  assert.equal(oversized.messages.at(-1)?.content, "汉".repeat(100));
});
