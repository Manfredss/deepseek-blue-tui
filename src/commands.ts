export const SLASH_COMMANDS = [
  "/help",
  "/model",
  "/login",
  "/logout",
  "/usage",
  "/clear",
  "/resume",
  "/rename",
  "/status",
  "/thinking",
  "/dsh",
  "/exit",
] as const;

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
    "  /dsh [install|start|open|status|stop|logs|restart]  管理官方 DSH Web",
    "  /exit                  保存并退出（也可按 Ctrl+C）",
    "",
    "提示：输入 // 开头可把 / 当作普通消息发送。",
  ].join("\n");
}
