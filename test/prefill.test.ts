import assert from "node:assert/strict";
import test from "node:test";

import { isOfficialEndpoint, prefixBaseUrl, streamChat } from "../src/api.js";
import { applyPrefill, planPrefill } from "../src/prefill.js";
import type { ChatMessage } from "../src/types.js";

/**
 * Prefix completion: finishing an assistant message instead of replying after
 * it. The wire format is easy to get subtly wrong — the flag belongs on the
 * last message only, and the feature lives behind a different base URL.
 */

function sseResponse(body: string): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

const DONE = [
  'data: {"choices":[{"delta":{"content":"print(1)"},"finish_reason":"stop"}]}\n\n',
  "data: [DONE]\n\n",
].join("");

test("prefix completion only rewrites the official endpoint", () => {
  assert.equal(prefixBaseUrl("https://api.deepseek.com"), "https://api.deepseek.com/beta");
  assert.equal(prefixBaseUrl("https://api.deepseek.com/"), "https://api.deepseek.com/beta");
  // Already pointed at beta: appending again would give /beta/beta.
  assert.equal(prefixBaseUrl("https://api.deepseek.com/beta"), "https://api.deepseek.com/beta");
  // The official endpoint is documented with a /v1 path too; appending there
  // would give /v1/beta, which is a 404 rather than a feature.
  assert.equal(prefixBaseUrl("https://api.deepseek.com/v1"), "https://api.deepseek.com/beta");
  // A gateway may serve the feature on its normal path, and certainly does not
  // gain a /beta route just because this client invented one.
  assert.equal(prefixBaseUrl("https://gateway.internal/v1"), "https://gateway.internal/v1");
  assert.equal(isOfficialEndpoint("https://api.deepseek.com"), true);
  assert.equal(isOfficialEndpoint("https://api.deepseek.com.evil.test"), false);
  assert.equal(isOfficialEndpoint("not a url"), false);
});

test("streamChat marks only the trailing assistant message as a prefix", async () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "写个循环", createdAt: "2026-01-01T00:00:00.000Z" },
    { role: "assistant", content: "早先的回答", createdAt: "2026-01-01T00:00:01.000Z" },
    { role: "user", content: "继续", createdAt: "2026-01-01T00:00:02.000Z" },
    { role: "assistant", content: "```python\n", createdAt: "2026-01-01T00:00:03.000Z" },
  ];
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return sseResponse(DONE);
  }) as typeof fetch;

  await streamChat({
    apiKey: "sk-test",
    baseUrl: "https://api.deepseek.com/beta",
    model: "deepseek-v4-flash",
    messages,
    prefixContinuation: true,
    stop: ["```"],
    fetchImpl,
  });

  const sent = body.messages as Record<string, unknown>[];
  assert.equal(sent.length, 4);
  assert.equal(sent[1]?.prefix, undefined, "an earlier assistant turn is not a prefix");
  assert.equal(sent[3]?.prefix, true);
  assert.deepEqual(body.stop, ["```"]);
});

test("streamChat sends no prefix flag or stop list by default", async () => {
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return sseResponse(DONE);
  }) as typeof fetch;

  await streamChat({
    apiKey: "sk-test",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    messages: [{ role: "assistant", content: "half", createdAt: "2026-01-01T00:00:00.000Z" }],
    fetchImpl,
  });

  assert.equal((body.messages as Record<string, unknown>[])[0]?.prefix, undefined);
  assert.equal("stop" in body, false);
});

test("a bare fence prefill opens a code block and stops at its close", () => {
  const plan = planPrefill("```python");
  assert.equal(plan?.text, "```python\n");
  assert.deepEqual(plan?.stop, ["```"]);
  // The stop sequence is not echoed back, so the fence has to be restored.
  assert.equal(applyPrefill(plan!, "print(1)\n"), "```python\nprint(1)\n```");
});

test("a plain prefill is used verbatim and adds nothing to the answer", () => {
  const plan = planPrefill("结论：");
  assert.equal(plan?.text, "结论：");
  assert.equal(plan?.stop, undefined);
  assert.equal(applyPrefill(plan!, "不值得。"), "结论：不值得。");
});

test("a prefill can spell out newlines, and empty input plans nothing", () => {
  // The slash parser already trims arguments, so escapes are the only way to
  // carry structure into a prefill.
  assert.equal(planPrefill("第一步：\\n1.")?.text, "第一步：\n1.");
  assert.equal(planPrefill("   ")?.text, undefined);
  assert.equal(planPrefill(""), undefined);
  // A fence with a language still reads as one line in /status.
  assert.equal(planPrefill("```ts")?.label, "```ts ⏎");
});
