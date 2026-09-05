import type { BalanceInfo, ChatMessage, ReasoningEffort, TokenUsage } from "./types.js";
import { EMPTY_USAGE } from "./types.js";
import { isRecord } from "./fs-utils.js";

export class DeepSeekApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "DeepSeekApiError";
    this.status = status;
    if (code !== undefined) this.code = code;
  }
}

export class DeepSeekConnectionError extends Error {
  readonly endpoint: string;

  constructor(endpoint: string, cause: unknown) {
    const detail = cause instanceof Error && cause.message ? `（${cause.message}）` : "";
    super(`无法连接 ${endpoint}。请检查网络、DNS、代理或 Endpoint 配置${detail}`, { cause });
    this.name = "DeepSeekConnectionError";
    this.endpoint = endpoint;
  }
}

class DeepSeekTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeepSeekTimeoutError";
  }
}

export interface StreamChatOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  timeoutMs?: number;
  /** DeepSeek V4 thinking effort (OpenAI format: low/high/max). */
  effort?: ReasoningEffort;
  fetchImpl?: typeof fetch;
  onContent?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onUsage?: (usage: TokenUsage) => void;
}

export interface StreamChatResult {
  content: string;
  reasoningContent: string;
  usage: TokenUsage;
  finishReason?: string;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function parseUsage(value: unknown): TokenUsage {
  if (!isRecord(value)) return { ...EMPTY_USAGE };
  const details = isRecord(value.completion_tokens_details) ? value.completion_tokens_details : {};
  return {
    promptTokens: numberOrZero(value.prompt_tokens),
    completionTokens: numberOrZero(value.completion_tokens),
    totalTokens: numberOrZero(value.total_tokens),
    promptCacheHitTokens: numberOrZero(value.prompt_cache_hit_tokens),
    promptCacheMissTokens: numberOrZero(value.prompt_cache_miss_tokens),
    reasoningTokens: numberOrZero(details.reasoning_tokens),
  };
}

function apiMessages(messages: ChatMessage[]): Record<string, string>[] {
  return messages.map((message) => {
    const result: Record<string, string> = { role: message.role, content: message.content };
    // DeepSeek thinking models require this field to be echoed on later turns.
    if (message.role === "assistant" && message.reasoningContent) {
      result.reasoning_content = message.reasoningContent;
    }
    return result;
  });
}

export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  const acceptLine = (rawLine: string): string | undefined => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      if (dataLines.length === 0) return undefined;
      const event = dataLines.join("\n");
      dataLines = [];
      return event;
    }
    if (line.startsWith(":")) return undefined;
    if (line === "data") dataLines.push("");
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    return undefined;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const event = acceptLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (event !== undefined) yield event;
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer) {
      const event = acceptLine(buffer);
      if (event !== undefined) yield event;
    }
    if (dataLines.length > 0) yield dataLines.join("\n");
  } finally {
    reader.releaseLock();
  }
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

async function fetchWithAbort(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  return await new Promise<Response>((resolveResponse, rejectResponse) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => finish(() => rejectResponse(signal.reason ?? new DOMException("Aborted", "AbortError")));
    signal.addEventListener("abort", abort, { once: true });
    void fetchImpl(url, { ...init, signal }).then(
      (response) => finish(() => resolveResponse(response)),
      (error: unknown) => finish(() => rejectResponse(error)),
    );
  });
}

/**
 * What the user should do about a failing status. DeepSeek always returns its
 * own English `error.message`, so the hint is appended to it rather than only
 * used as a fallback — otherwise the actionable half is never seen.
 */
const STATUS_HINTS: Record<number, string> = {
  400: "请求被拒绝；可用 /compact 压缩上下文，或用 /model 换一个模型",
  401: "API Key 无效，请运行 /login 重新配置",
  402: "账户余额不足，请运行 /usage 充值",
  413: "请求体过大，请用 /compact 压缩上下文",
  422: "模型参数无效，请检查 /model 与 /effort",
  429: "请求过于频繁，请稍后重试",
  500: "DeepSeek 服务暂时异常，请稍后重试",
  503: "DeepSeek 服务繁忙，请稍后重试",
};

async function errorFromResponse(response: Response): Promise<DeepSeekApiError> {
  let message = "";
  let code: string | undefined;
  try {
    const value = JSON.parse(await response.text()) as unknown;
    if (isRecord(value) && isRecord(value.error)) {
      if (typeof value.error.message === "string") message = value.error.message.trim();
      if (typeof value.error.code === "string") code = value.error.code;
    }
  } catch {
    // Fall back to a safe status-based message below.
  }
  const hint = STATUS_HINTS[response.status];
  if (!message) message = hint ?? `DeepSeek API 请求失败 (${response.status})`;
  else if (hint) message = `${message}（${hint}）`;
  return new DeepSeekApiError(message, response.status, code);
}

function linkedAbortController(signal: AbortSignal | undefined, timeoutMs: number, timeoutMessage: string): {
  controller: AbortController;
  dispose: () => void;
} {
  const controller = new AbortController();
  const forward = (): void => controller.abort(signal?.reason);
  if (signal?.aborted) forward();
  else signal?.addEventListener("abort", forward, { once: true });
  const timeout = setTimeout(() => controller.abort(new DeepSeekTimeoutError(timeoutMessage)), timeoutMs);
  timeout.unref();
  return {
    controller,
    dispose: () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", forward);
    },
  };
}

export async function streamChat(options: StreamChatOptions): Promise<StreamChatResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { controller, dispose } = linkedAbortController(
    options.signal,
    options.timeoutMs ?? 10 * 60_000,
    `DeepSeek API 请求超时：${options.baseUrl}`,
  );
  try {
    const response = await fetchWithAbort(fetchImpl, endpoint(options.baseUrl, "/chat/completions"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: options.model,
        messages: apiMessages(options.messages),
        stream: true,
        stream_options: { include_usage: true },
        // DeepSeek V4 thinking effort: low/high/max. Thinking mode itself is
        // enabled by default, so only the effort level needs to be sent.
        ...(options.effort !== undefined ? { reasoning_effort: options.effort } : {}),
      }),
    }, controller.signal);
    if (!response.ok) throw await errorFromResponse(response);
    if (!response.body) throw new DeepSeekApiError("DeepSeek API 未返回响应流", response.status);

    let content = "";
    let reasoningContent = "";
    let usage = { ...EMPTY_USAGE };
    let finishReason: string | undefined;

    for await (const event of parseSse(response.body)) {
      if (event.trim() === "[DONE]") break;
      let value: unknown;
      try {
        value = JSON.parse(event) as unknown;
      } catch {
        continue;
      }
      if (!isRecord(value)) continue;
      if (value.usage !== null && value.usage !== undefined) {
        usage = parseUsage(value.usage);
        options.onUsage?.(usage);
      }
      if (!Array.isArray(value.choices) || value.choices.length === 0) continue;
      const choice = value.choices[0];
      if (!isRecord(choice)) continue;
      if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
      if (!isRecord(choice.delta)) continue;
      if (typeof choice.delta.reasoning_content === "string") {
        reasoningContent += choice.delta.reasoning_content;
        options.onReasoning?.(choice.delta.reasoning_content);
      }
      if (typeof choice.delta.content === "string") {
        content += choice.delta.content;
        options.onContent?.(choice.delta.content);
      }
    }
    const result: StreamChatResult = { content, reasoningContent, usage };
    if (finishReason !== undefined) result.finishReason = finishReason;
    return result;
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof DeepSeekApiError)) {
      const reason = controller.signal.reason;
      if (reason instanceof DeepSeekTimeoutError) throw reason;
      const aborted = new Error("已取消本次生成");
      aborted.name = "AbortError";
      throw aborted;
    }
    if (!(error instanceof DeepSeekApiError) && !(error instanceof DeepSeekConnectionError)) {
      throw new DeepSeekConnectionError(options.baseUrl, error);
    }
    throw error;
  } finally {
    dispose();
  }
}

export async function getBalance(options: {
  apiKey: string;
  baseUrl: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<{ available: boolean; balances: BalanceInfo[] }> {
  const { controller, dispose } = linkedAbortController(
    options.signal,
    options.timeoutMs ?? 15_000,
    `余额查询超时：${options.baseUrl}`,
  );
  try {
    const response = await fetchWithAbort(options.fetchImpl ?? fetch, endpoint(options.baseUrl, "/user/balance"), {
      headers: { Authorization: `Bearer ${options.apiKey}`, Accept: "application/json" },
    }, controller.signal);
    if (!response.ok) throw await errorFromResponse(response);
    let value: unknown;
    try {
      value = (await response.json()) as unknown;
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw new DeepSeekApiError("余额接口返回了无效 JSON", response.status);
    }
    if (!isRecord(value) || !Array.isArray(value.balance_infos)) {
      throw new DeepSeekApiError("余额接口返回了无效数据", response.status);
    }
    const balances = value.balance_infos.flatMap((item): BalanceInfo[] => {
      if (!isRecord(item)) return [];
      if (
        typeof item.currency !== "string" ||
        typeof item.total_balance !== "string" ||
        typeof item.granted_balance !== "string" ||
        typeof item.topped_up_balance !== "string"
      ) {
        return [];
      }
      return [
        {
          currency: item.currency,
          totalBalance: item.total_balance,
          grantedBalance: item.granted_balance,
          toppedUpBalance: item.topped_up_balance,
        },
      ];
    });
    return { available: value.is_available === true, balances };
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof DeepSeekApiError)) {
      const reason = controller.signal.reason;
      if (reason instanceof DeepSeekTimeoutError) throw reason;
      const aborted = new Error("已取消余额查询");
      aborted.name = "AbortError";
      throw aborted;
    }
    if (!(error instanceof DeepSeekApiError) && !(error instanceof DeepSeekConnectionError)) {
      throw new DeepSeekConnectionError(options.baseUrl, error);
    }
    throw error;
  } finally {
    dispose();
  }
}
