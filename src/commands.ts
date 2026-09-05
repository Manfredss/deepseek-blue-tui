import type { Theme } from "./theme.js";
import { clipToWidth, visibleWidth } from "./text-width.js";

export const SLASH_COMMANDS = [
  "/model",
  "/login",
  "/usage",
  "/clear",
  "/resume",
  "/status",
  "/context",
  "/thinking",
  "/effort",
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
  { command: "/model", description: "切换当前使用的 DeepSeek 模型" },
  { command: "/login", description: "配置 API Key" },
  { command: "/usage", description: "查询余额、用量与充值" },
  { command: "/clear", description: "清屏并开始一段新会话" },
  { command: "/resume", description: "继续一段历史会话" },
  { command: "/status", description: "查看模型、会话与 DSH 状态" },
  { command: "/context", description: "逐条消息的 token 审计与构成" },
  { command: "/thinking", description: "显示或隐藏思考过程" },
  { command: "/effort", description: "设置思考强度：low / high / max" },
  { command: "/btw", description: "侧问：单轮提问，不写入会话" },
  { command: "/compact", description: "把历史压缩成一条摘要" },
  { command: "/export", description: "把当前会话导出为 Markdown" },
  { command: "/edit", description: "用外部编辑器撰写下一条消息" },
  { command: "/attach", description: "附加一个文本文件并发送" },
  { command: "/rewind", description: "从更早的消息分支出新会话" },
  { command: "/search", description: "在当前会话内全文搜索" },
  { command: "/dsh", description: "管理官方 DeepSeek Harness Web" },
  { command: "/help", description: "查看全部命令与快捷键" },
  { command: "/exit", description: "保存会话并退出" },
  { command: "/logout", description: "删除本地保存的 API Key" },
  { command: "/rename", description: "重命名当前会话" },
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

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_unused, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const candidate = Math.min(
        (previous[column] ?? 0) + 1,
        (previous[column - 1] ?? 0) + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
      diagonal = previous[column] ?? 0;
      previous[column] = candidate;
    }
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
}

/**
 * Commands a mistyped name most likely meant: prefix matches first, then
 * near-misses within a small edit distance. Used for "did you mean" hints.
 */
export function closestCommands(name: string, limit = 3): string[] {
  const normalized = `/${name.trim().toLocaleLowerCase()}`;
  if (normalized.length < 2) return [];
  const prefixed = SLASH_COMMANDS.filter((command) => command.startsWith(normalized));
  if (prefixed.length > 0) return [...prefixed].slice(0, limit);
  const tolerance = normalized.length <= 4 ? 1 : 2;
  return SLASH_COMMANDS.map((command) => ({ command, distance: editDistance(normalized, command) }))
    .filter(({ distance }) => distance <= tolerance)
    .sort((left, right) => left.distance - right.distance || left.command.localeCompare(right.command))
    .slice(0, limit)
    .map(({ command }) => command);
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
      const clipped = clipToWidth(command, columns - 2);
      const styled = isSelected
        ? options.theme.bold(options.theme.brightBlue(clipped))
        : options.theme.brightBlue(clipped);
      rendered.push(`${isSelected ? options.theme.brightBlue("❯ ") : "  "}${styled}`);
      continue;
    }
    const descriptionWidth = Math.max(1, columns - commandWidth - 3);
    const commandPadding = " ".repeat(Math.max(0, commandWidth - visibleWidth(command)));
    rendered.push(
      `${isSelected ? options.theme.brightBlue("❯ ") : "  "}${isSelected ? highlightedCommand() : commandText()}${commandPadding} ${options.theme.muted(clipToWidth(description, descriptionWidth))}`,
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

const COMMAND_HELP_ROWS: readonly (readonly [string, string])[] = [
  ["/model [名称]", "选择 V4 Flash/Pro，或直接输入自定义模型 ID"],
  ["/login [browser]", "安全录入 API Key，或打开 DeepSeek 平台"],
  ["/logout", "删除本地保存的 API Key"],
  ["/usage [topup]", "查询余额并打开用量或充值页面"],
  ["/clear", "保存当前会话，清屏并开始一个空会话（别名 /new）"],
  ["/resume [ID/标题]", "浏览或恢复历史会话（别名 /sessions）"],
  ["/rename <标题>", "重命名当前会话"],
  ["/thinking [on|off]", "显示或隐藏思考过程"],
  ["/effort [low|high|max]", "设置模型思考强度（默认 high）"],
  ["/status", "模型、会话、凭据与 DSH 状态"],
  ["/context", "逐条消息的 token 估算与分段构成"],
  ["/btw <问题>", "侧问：复用上下文单轮问答，不写入会话"],
  ["/compact", "把历史压缩为一条摘要（自动导出备份）"],
  ["/export", "导出当前会话为 Markdown"],
  ["/edit [草稿]", "用 $VISUAL/$EDITOR 编写下一条消息"],
  ["/attach <路径>", "附加文本文件（≤256 KiB）并发送"],
  ["/rewind [编号]", "从更早的消息分支新会话（原会话保留）"],
  ["/search <关键词>", "在当前会话内全文搜索"],
  ["/dsh [子命令]", "管理官方 DSH Web：install/start/open/status/stop/logs/restart"],
  ["/help", "显示这份帮助"],
  ["/exit", "保存并退出（别名 /quit）"],
];

const KEY_HELP_ROWS: readonly (readonly [string, string])[] = [
  ["Enter", "发送消息；行尾加 \\ 可换行继续输入"],
  ["Tab", "补全命令：唯一匹配直接补全，多个匹配先高亮第一个"],
  ["/ 然后 ↑/↓", "在命令面板中选择，Enter 执行，Esc 关闭"],
  ["↑ / ↓", "在空提示符下翻阅历史输入"],
  ["Esc", "中断正在生成的回复"],
  ["Ctrl+C", "清空当前输入；输入为空时连按两次退出"],
  ["Ctrl+D", "直接退出"],
  ["Ctrl+L", "清屏"],
];

function helpSection(theme: Theme | undefined, title: string, rows: readonly (readonly [string, string])[]): string[] {
  const accent = theme?.brightBlue ?? ((value: string) => value);
  const bold = theme?.bold ?? ((value: string) => value);
  const muted = theme?.muted ?? ((value: string) => value);
  const labelWidth = Math.min(24, Math.max(...rows.map(([label]) => visibleWidth(label))));
  const lines = [bold(title)];
  for (const [label, description] of rows) {
    const padding = " ".repeat(Math.max(1, labelWidth - visibleWidth(label) + 2));
    lines.push(`  ${accent(label)}${padding}${muted(description)}`);
  }
  return lines;
}

export function commandHelp(theme?: Theme): string {
  const muted = theme?.muted ?? ((value: string) => value);
  return [
    ...helpSection(theme, "斜杠命令", COMMAND_HELP_ROWS),
    "",
    ...helpSection(theme, "键盘快捷键", KEY_HELP_ROWS),
    "",
    muted("提示：输入 // 开头可把 / 当作普通消息发送。"),
  ].join("\n");
}
