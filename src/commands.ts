import type { Theme } from "./theme.js";

export const SLASH_COMMANDS = [
  "/model",
  "/login",
  "/usage",
  "/clear",
  "/resume",
  "/status",
  "/context",
  "/thinking",
  "/btw",
  "/compact",
  "/export",
  "/edit",
  "/attach",
  "/rewind",
  "/search",
  "/dsh",
  "/help",
  "/exit",
  "/logout",
  "/rename",
] as const;

export interface SlashCommandDefinition {
  command: (typeof SLASH_COMMANDS)[number];
  description: string;
}

export interface SlashCommandMenuOptions {
  columns: number;
  rows: number;
  theme: Theme;
  /** Index into the full matching command list, or -1 for no highlight. */
  selected?: number;
}

export const SLASH_COMMAND_DEFINITIONS: readonly SlashCommandDefinition[] = [
  { command: "/model", description: "Switch the current DeepSeek model" },
  { command: "/login", description: "Configure your API key" },
  { command: "/usage", description: "View API usage and billing" },
  { command: "/clear", description: "Start a fresh conversation" },
  { command: "/resume", description: "Continue a previous conversation" },
  { command: "/status", description: "Show model, session, and DSH status" },
  { command: "/context", description: "Per-message token audit and breakdown" },
  { command: "/thinking", description: "Show or hide reasoning output" },
  { command: "/btw", description: "Ask a side question outside the session" },
  { command: "/compact", description: "Summarize history into one message" },
  { command: "/export", description: "Export the session as Markdown" },
  { command: "/edit", description: "Compose with your external editor" },
  { command: "/attach", description: "Attach a text file to your message" },
  { command: "/rewind", description: "Fork the session at an earlier message" },
  { command: "/search", description: "Search inside the current session" },
  { command: "/dsh", description: "Manage the DeepSeek Harness Web companion" },
  { command: "/help", description: "Show every command" },
  { command: "/exit", description: "Save the session and exit" },
  { command: "/logout", description: "Remove the saved API key" },
  { command: "/rename", description: "Rename the current conversation" },
];

export interface SlashCommand {
  name: string;
  args: string;
  tokens: string[];
}

export function tokenizeArguments(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of input.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (escaped) current += "\\";
  if (current) tokens.push(current);
  return tokens;
}

export function parseSlashCommand(input: string): SlashCommand | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return undefined;
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match?.[1]) return undefined;
  const args = match[2]?.trim() ?? "";
  return { name: match[1].toLocaleLowerCase(), args, tokens: tokenizeArguments(args) };
}

export function unescapePrompt(input: string): string {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("//")) return input;
  return `${input.slice(0, input.length - trimmed.length)}/${trimmed.slice(2)}`;
}

export function completeSlashCommand(line: string): [string[], string] {
  if (!line.startsWith("/") || line.includes(" ")) return [[], line];
  const matches = SLASH_COMMANDS.filter((command) => command.startsWith(line));
  return [[...matches], line];
}

export function slashCommandSuggestions(line: string, limit = SLASH_COMMAND_DEFINITIONS.length): SlashCommandDefinition[] {
  if (!line.startsWith("/") || line.startsWith("//") || /\s/u.test(line)) return [];
  const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : SLASH_COMMAND_DEFINITIONS.length;
  const normalized = line.toLocaleLowerCase();
  return SLASH_COMMAND_DEFINITIONS.filter(({ command }) => command.startsWith(normalized)).slice(0, safeLimit);
}

function clipText(value: string, width: number): string {
  if (width <= 0) return "";
  if (value.length <= width) return value;
  if (width === 1) return "…";
  return `${value.slice(0, width - 1)}…`;
}

/** Build the live command palette shown under readline's active prompt. */
export function renderSlashCommandMenu(line: string, options: SlashCommandMenuOptions): readonly string[] {
  const columns = Number.isFinite(options.columns) ? Math.max(16, Math.floor(options.columns)) : 78;
  const rows = Number.isFinite(options.rows) ? Math.max(4, Math.floor(options.rows)) : 24;
  const maxItems = Math.max(1, Math.min(5, Math.floor((rows - 3) / 2)));
  const suggestions = slashCommandSuggestions(line);
  if (suggestions.length === 0) return [];

  const requestedSelected = options.selected;
  const selected =
    requestedSelected === undefined || !Number.isFinite(requestedSelected)
      ? -1
      : Math.max(-1, Math.min(suggestions.length - 1, Math.floor(requestedSelected)));
  const start =
    selected < 0
      ? 0
      : selected < maxItems
        ? 0
        : Math.max(0, Math.min(selected - maxItems + 1, suggestions.length - maxItems));
  const visible = suggestions.slice(start, start + maxItems);
  const hiddenBefore = start;
  const hiddenAfter = suggestions.length - start - visible.length;

  const rendered = [options.theme.muted("─".repeat(columns))];
  const commandWidth = Math.min(12, Math.max(...visible.map(({ command }) => command.length)) + 2);
  for (let index = 0; index < visible.length; index += 1) {
    const definition = visible[index];
    if (!definition) continue;
    const isSelected = selected === start + index;
    const { command, description } = definition;
    const commandText = (): string => options.theme.brightBlue(command);
    const highlightedCommand = (): string => options.theme.bold(options.theme.brightBlue(command));
    if (columns < 44) {
      const clipped = clipText(command, columns - 2);
      const styled = isSelected
        ? options.theme.bold(options.theme.brightBlue(clipped))
        : options.theme.brightBlue(clipped);
      rendered.push(`${isSelected ? options.theme.brightBlue("❯ ") : "  "}${styled}`);
      continue;
    }
    const descriptionWidth = Math.max(1, columns - commandWidth - 3);
    const commandPadding = " ".repeat(Math.max(0, commandWidth - command.length));
    rendered.push(
      `${isSelected ? options.theme.brightBlue("❯ ") : "  "}${isSelected ? highlightedCommand() : commandText()}${commandPadding} ${options.theme.muted(clipText(description, descriptionWidth))}`,
    );
  }
  if (hiddenBefore > 0 || hiddenAfter > 0) {
    const overflow =
      hiddenBefore > 0 && hiddenAfter > 0
        ? `↑ ${String(hiddenBefore)} · ... ${String(hiddenAfter)} more`
        : hiddenBefore > 0
          ? `↑ ${String(hiddenBefore)} more`
          : `... ${String(hiddenAfter)} more`;
    rendered.push(options.theme.muted(overflow));
  }
  return rendered;
}

export function commandHelp(): string {
  return [
    "斜杠命令",
    "  /model [名称]          选择 V4 Flash/Pro 或输入自定义模型",
    "  /login [browser]       安全录入 API Key，或打开 DeepSeek 平台",
    "  /logout                删除本地保存的 API Key",
    "  /usage [topup]         查询余额并打开用量或充值页面",
    "  /clear                 保存当前会话并开始一个空会话",
    "  /resume [ID/标题]      浏览或恢复历史会话",
    "  /rename <标题>         重命名当前会话",
    "  /thinking [on|off]     显示或隐藏思考过程",
    "  /status                显示模型、会话、凭据和 DSH 状态",
    "  /context               逐条消息的 token 估算与分段构成",
    "  /btw <问题>            侧问：复用上下文单轮问答，不写入会话",
    "  /compact               把历史压缩为一条摘要（自动导出备份）",
    "  /export                导出当前会话为 Markdown",
    "  /edit [草稿]           用 $VISUAL/$EDITOR 编写下一条消息",
    "  /attach <路径>         附加文本文件（≤256 KiB）并发送",
    "  /rewind [编号]         从更早的消息分支新会话（原会话保留）",
    "  /search <关键词>       在当前会话内全文搜索",
    "  /dsh [install|start|open|status|stop|logs|restart]  管理官方 DSH Web",
    "  /exit                  保存并退出（也可按 Ctrl+C）",
    "",
    "菜单提示：主提示符输入 / 后可用 ↑/↓ 选择命令、Enter 执行；",
    "        其他选项列表也支持 ↑/↓ 选择、Enter 确认、Esc 取消，",
    "        数字可直接跳转；/model 菜单还可以直接输入自定义模型 ID。",
    "提示：输入 // 开头可把 / 当作普通消息发送。",
  ].join("\n");
}
