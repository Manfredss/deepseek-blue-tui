import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { EMPTY_USAGE, type ChatMessage, type Session, type TokenUsage } from "./types.js";
import { acquireFileLock, ensurePrivateDirectory, isRecord, writeJsonAtomic, type FileLock } from "./fs-utils.js";

function cleanUsage(value: unknown): TokenUsage {
  const source = isRecord(value) ? value : {};
  const number = (key: string): number => {
    const candidate = source[key];
    return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 ? candidate : 0;
  };
  return {
    promptTokens: number("promptTokens"),
    completionTokens: number("completionTokens"),
    totalTokens: number("totalTokens"),
    promptCacheHitTokens: number("promptCacheHitTokens"),
    promptCacheMissTokens: number("promptCacheMissTokens"),
    reasoningTokens: number("reasoningTokens"),
  };
}

function cleanMessage(value: unknown): ChatMessage | undefined {
  if (!isRecord(value)) return undefined;
  if (value.role !== "user" && value.role !== "assistant" && value.role !== "system") return undefined;
  if (typeof value.content !== "string") return undefined;
  const message: ChatMessage = {
    role: value.role,
    content: value.content,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString(),
  };
  if (typeof value.reasoningContent === "string" && value.reasoningContent) {
    message.reasoningContent = value.reasoningContent;
  }
  return message;
}

export function parseSession(value: unknown): Session | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== "string" || !/^[a-zA-Z0-9-]+$/.test(value.id)) return undefined;
  if (typeof value.cwd !== "string" || typeof value.model !== "string") return undefined;
  if (!Array.isArray(value.messages)) return undefined;
  const messages = value.messages.map(cleanMessage).filter((message): message is ChatMessage => Boolean(message));
  return {
    version: 1,
    id: value.id,
    title: typeof value.title === "string" && value.title ? value.title : "New conversation",
    cwd: value.cwd,
    model: value.model,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
    messages,
    usage: cleanUsage(value.usage),
  };
}

export function createSession(cwd: string, model: string, now = new Date()): Session {
  const timestamp = now.toISOString();
  return {
    version: 1,
    id: randomUUID(),
    title: "New conversation",
    cwd,
    model,
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: [],
    usage: { ...EMPTY_USAGE },
  };
}

export function deriveTitle(content: string): string {
  const singleLine = content.replace(/\s+/g, " ").trim();
  if (!singleLine) return "New conversation";
  return singleLine.length > 60 ? `${singleLine.slice(0, 57)}…` : singleLine;
}

export function addUsage(total: TokenUsage, increment: TokenUsage): TokenUsage {
  return {
    promptTokens: total.promptTokens + increment.promptTokens,
    completionTokens: total.completionTokens + increment.completionTokens,
    totalTokens: total.totalTokens + increment.totalTokens,
    promptCacheHitTokens: total.promptCacheHitTokens + increment.promptCacheHitTokens,
    promptCacheMissTokens: total.promptCacheMissTokens + increment.promptCacheMissTokens,
    reasoningTokens: total.reasoningTokens + increment.reasoningTokens,
  };
}

function textTokens(value: string): number {
  let count = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    count += code > 0x7f ? 1 : 0.25; // CJK ≈ 1 token/char, ASCII ≈ 4 chars/token
  }
  return count;
}

export function estimateTokens(messages: ChatMessage[]): number {
  let tokens = messages.length * 4; // Per-message protocol overhead.
  for (const message of messages) {
    tokens += textTokens(message.content);
    if (message.reasoningContent) tokens += textTokens(message.reasoningContent);
  }
  return Math.ceil(tokens);
}

export interface TruncationResult {
  messages: ChatMessage[];
  dropped: number;
}

/**
 * Drops the oldest non-system messages so the tail fits under `limitTokens`.
 * Always keeps system messages and at least the newest message, so a single
 * oversized message is still sent rather than an empty history.
 */
export function truncateToLimit(messages: ChatMessage[], limitTokens: number): TruncationResult {
  const system = messages.filter((message) => message.role === "system");
  const rest = messages.filter((message) => message.role !== "system");
  const kept: ChatMessage[] = [];
  let tokens = estimateTokens(system);
  for (let index = rest.length - 1; index >= 0; index -= 1) {
    const message = rest[index];
    if (!message) continue;
    const cost = estimateTokens([message]);
    if (tokens + cost > limitTokens && kept.length > 0) break;
    kept.unshift(message);
    tokens += cost;
  }
  return { messages: [...system, ...kept], dropped: rest.length - kept.length };
}

export class SessionStore {
  readonly directory: string;

  constructor(home: string) {
    this.directory = join(home, "sessions");
  }

  pathFor(id: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("无效的会话 ID");
    return join(this.directory, `${id}.json`);
  }

  lockPathFor(id: string): string {
    return `${this.pathFor(id)}.lock`;
  }

  /**
   * Acquires an advisory lock for a session. Two terminals resuming the same
   * session would otherwise overwrite each other's messages on save; the lock
   * makes the second writer detectable (and stale locks from crashed
   * processes are taken over automatically).
   */
  async acquireLock(id: string): Promise<FileLock> {
    return await acquireFileLock(this.lockPathFor(id));
  }

  async save(session: Session): Promise<void> {
    session.updatedAt = new Date().toISOString();
    await writeJsonAtomic(this.pathFor(session.id), session);
  }

  async load(id: string): Promise<Session | undefined> {
    try {
      const value = JSON.parse(await readFile(this.pathFor(id), "utf8")) as unknown;
      return parseSession(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async list(options: { cwd?: string; limit?: number } = {}): Promise<Session[]> {
    await ensurePrivateDirectory(this.directory);
    const names = (await readdir(this.directory)).filter((name) => name.endsWith(".json"));
    const sessions = await Promise.all(
      names.map(async (name) => {
        try {
          return parseSession(JSON.parse(await readFile(join(this.directory, name), "utf8")) as unknown);
        } catch {
          return undefined;
        }
      }),
    );
    const filtered = sessions
      .filter((session): session is Session => Boolean(session))
      .filter((session) => !options.cwd || session.cwd === options.cwd)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return filtered.slice(0, options.limit ?? 50);
  }

  async find(query: string, cwd?: string): Promise<Session[]> {
    const normalized = query.trim().toLocaleLowerCase();
    const sessions = await this.list({ ...(cwd !== undefined ? { cwd } : {}), limit: 100 });
    if (!normalized) return sessions;
    return sessions.filter(
      (session) =>
        session.id.toLocaleLowerCase() === normalized ||
        session.id.toLocaleLowerCase().startsWith(normalized) ||
        session.title.toLocaleLowerCase().includes(normalized),
    );
  }
}
