import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createSession, estimateTokens } from "./session-store.js";
import type { ChatMessage, Session } from "./types.js";

/**
 * Session tooling borrowed and adapted from the dsh-TUI design language
 * (https://github.com/ccch1mneyyy/dsh-TUI): compact token counts, session
 * export, compaction, rewind-as-fork, external editor input, file attachment
 * and a segmented context breakdown — rebuilt for a lightweight line REPL
 * instead of a full Ink widget tree.
 */

export const ATTACH_MAX_BYTES = 256 * 1024; // 256 KiB text cap for /attach.
export const SEARCH_PREVIEW_CHARS = 120;
export const COMPACT_INSTRUCTION =
  "请把以上全部对话压缩为一段紧凑、信息完整的中文摘要，保留：所有关键结论与决策、未完成的任务与下一步计划、重要代码片段与错误信息、用户的偏好和约束。只输出摘要本身，不要任何开场白。";

/** 988 → "988" · 3400 → "3.4k" · 12_000 → "12k" · 1_000_000 → "1.0M". */
export function formatCompactTokens(count: number): string {
  if (!Number.isFinite(count)) return "—";
  const value = Math.max(0, Math.round(count));
  if (value < 1_000) return String(value);
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${Math.round(value / 1_000_000)}M`;
}

export interface ContextSegment {
  role: ChatMessage["role"] | "thinking";
  label: ChatMessage["role"] | "thinking";
  tokens: number;
  percent: number;
}

export interface ContextBreakdown {
  segments: ContextSegment[];
  total: number;
  limit: number;
  percent: number;
  bar: string;
}

/** Per-role token estimate plus a proportional block bar (█ used, ░ free). */
export function buildContextBreakdown(
  messages: ChatMessage[],
  limitTokens: number,
  width = 20,
): ContextBreakdown {
  const order: ChatMessage["role"][] = ["system", "user", "assistant"];
  const tokens = new Map<ChatMessage["role"], number>();
  for (const message of messages) {
    tokens.set(message.role, (tokens.get(message.role) ?? 0) + estimateTokens([message]));
  }
  const reasoning = messages.reduce((sum, message) => {
    if (!message.reasoningContent) return sum;
    let count = 0;
    for (const character of message.reasoningContent) {
      const code = character.codePointAt(0) ?? 0;
      count += code > 0x7f ? 1 : 0.25;
    }
    return sum + Math.ceil(count);
  }, 0);
  const roleTokens = [...tokens.values()].reduce((sum, value) => sum + value, 0);
  const total = Math.max(1, roleTokens + reasoning);
  const segments: ContextSegment[] = [];
  for (const role of order) {
    const count = tokens.get(role) ?? 0;
    if (count === 0) continue;
    segments.push({ role, label: role, tokens: count, percent: (count / total) * 100 });
  }
  if (reasoning > 0) {
    segments.push({ role: "thinking", label: "thinking", tokens: reasoning, percent: (reasoning / total) * 100 });
  }
  const used = Math.min(width, Math.round((total / limitTokens) * width));
  const bar = "█".repeat(used) + "░".repeat(Math.max(0, width - used));
  return {
    segments,
    total,
    limit: limitTokens,
    percent: (total / limitTokens) * 100,
    bar,
  };
}

function sanitizeFilename(value: string): string {
  const cleaned = value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim();
  return (cleaned || "session").slice(0, 80);
}

/** Renders a session as a portable Markdown transcript. */
export function formatSessionMarkdown(session: Session): string {
  const lines = [
    `# ${session.title}`,
    "",
    `- 会话 ID：${session.id}`,
    `- 工作目录：${session.cwd}`,
    `- 模型：${session.model}`,
    `- 创建：${session.createdAt} · 更新：${session.updatedAt}`,
    `- 消息数：${session.messages.length} · 累计 tokens：${session.usage.totalTokens.toLocaleString()}`,
    "",
  ];
  for (const message of session.messages) {
    const roleLabel = message.role === "user" ? "用户" : message.role === "assistant" ? "DeepSeek" : "系统";
    lines.push(`## ${roleLabel}（${message.createdAt}）`, "", message.content, "");
    if (message.reasoningContent) {
      lines.push("> 思考过程：", ">", ...message.reasoningContent.split("\n").map((line) => `> ${line}`), "");
    }
  }
  return lines.join("\n");
}

export async function writeSessionExport(
  session: Session,
  directory: string,
): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stem = `${sanitizeFilename(session.title)}-${session.id.slice(0, 8)}`;
  const path = join(directory, `${stem}.md`);
  await writeFile(path, formatSessionMarkdown(session), { mode: 0o600 });
  return path;
}

export interface SearchHit {
  index: number;
  role: ChatMessage["role"];
  lineNumber: number;
  line: string;
}

/** Case-insensitive, line-grained full-text search over a session. */
export function searchMessages(messages: ChatMessage[], query: string, limit = 12): SearchHit[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [];
  const hits: SearchHit[] = [];
  for (let index = 0; index < messages.length && hits.length < limit; index += 1) {
    const message = messages[index];
    if (!message) continue;
    const lines = message.content.split(/\r?\n/);
    for (let lineNumber = 0; lineNumber < lines.length && hits.length < limit; lineNumber += 1) {
      const line = lines[lineNumber] ?? "";
      if (!line.toLocaleLowerCase().includes(normalized)) continue;
      const preview = line.length > SEARCH_PREVIEW_CHARS ? `${line.slice(0, SEARCH_PREVIEW_CHARS - 1)}…` : line;
      hits.push({ index, role: message.role, lineNumber: lineNumber + 1, line: preview });
    }
  }
  return hits;
}

/** Applies a compaction summary: history is replaced by one system message. */
export function applyCompactSummary(summary: string): ChatMessage[] {
  return [{ role: "system", content: `[历史对话摘要] ${summary.trim()}`, createdAt: new Date().toISOString() }];
}

/** Forks `session` at (and including) user message `index`, like DSH rewind. */
export function forkSessionAt(session: Session, index: number): Session {
  const fork = createSession(session.cwd, session.model);
  fork.title = `${session.title} · rewind`;
  fork.messages = session.messages.slice(0, index + 1);
  return fork;
}

export function userMessageIndexes(session: Session): number[] {
  const indexes: number[] = [];
  session.messages.forEach((message, index) => {
    if (message.role === "user") indexes.push(index);
  });
  return indexes;
}

export interface AttachmentResult {
  ok: boolean;
  error?: string;
  path?: string;
  content?: string;
}

/** Reads a text file for /attach: size-capped, binary-rejected, ~ expanded. */
export async function readAttachmentFile(
  input: string,
  cwd: string,
  maxBytes = ATTACH_MAX_BYTES,
): Promise<AttachmentResult> {
  let expanded = input.trim();
  if (!expanded) return { ok: false, error: "用法：/attach <文件路径>" };
  if (expanded === "~") expanded = homedir();
  else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = join(homedir(), expanded.slice(2));
  }
  const path = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, error: `文件不存在：${path}` };
    throw error;
  }
  if (!info.isFile()) return { ok: false, error: `不是普通文件：${path}` };
  if (info.size > maxBytes) {
    return {
      ok: false,
      error: `文件过大（${Math.ceil(info.size / 1024)} KiB > ${Math.ceil(maxBytes / 1024)} KiB 上限），请只附加相关片段`,
    };
  }
  const buffer = await readFile(path);
  if (buffer.includes(0)) return { ok: false, error: `看起来是二进制文件，无法作为文本附加：${path}` };
  const content = buffer.toString("utf8").replace(/\r\n/g, "\n").replace(/\n{3,}$/g, "\n\n").trimEnd();
  if (!content) return { ok: false, error: `文件为空：${path}` };
  return { ok: true, path, content };
}

/** Builds the @-referenced message body sent for an attached file. */
export function attachmentMessage(path: string, content: string): string {
  return `@${path}\n\`\`\`\n${content}\n\`\`\``;
}

/** Chooses the external editor: $VISUAL → $EDITOR → platform default. */
export function editorCommand(env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  const visual = env.VISUAL?.trim();
  const editor = env.EDITOR?.trim();
  const chosen = visual || editor;
  if (chosen) {
    // Support arguments inside the variable ("code -w").
    const [command, ...args] = chosen.split(/\s+/).filter(Boolean);
    if (command) return { command, args };
  }
  return process.platform === "win32" ? { command: "notepad", args: [] } : { command: "vi", args: [] };
}

export interface EditPromptResult {
  ok: boolean;
  text?: string;
  error?: string;
}

/** Opens the external editor on a temporary draft and returns the result. */
export async function editPrompt(
  options: { initial?: string; env?: NodeJS.ProcessEnv; spawnImpl?: typeof spawnSync },
): Promise<EditPromptResult> {
  const env = options.env ?? process.env;
  const spawnImpl = options.spawnImpl ?? spawnSync;
  const editor = editorCommand(env);
  const directory = join(env.TMPDIR ?? "/tmp", "deepseek-tui-edit");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const draft = join(directory, `${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
  await writeFile(draft, options.initial ?? "", { mode: 0o600 });
  const result = spawnImpl(editor.command, [...editor.args, draft], { stdio: "inherit", env });
  if (result.error) {
    return { ok: false, error: `无法启动编辑器 ${editor.command}：${result.error.message}` };
  }
  if (result.status !== 0) return { ok: false, error: `编辑器退出码 ${result.status}，已保留原输入` };
  const text = (await readFile(draft, "utf8")).trimEnd();
  if (!text.trim()) return { ok: false, error: "编辑器内容为空，已取消" };
  return { ok: true, text };
}
