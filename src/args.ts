export type CliCommand = "chat" | "login" | "usage" | "sessions" | "dsh";

export interface CliOptions {
  command: CliCommand;
  commandArgs: string[];
  prompt?: string;
  model?: string;
  baseUrl?: string;
  resume?: string | true;
  continueLast: boolean;
  showLogo: boolean;
  color: boolean;
  showReasoning: boolean;
  help: boolean;
  version: boolean;
}

function takeValue(argv: string[], index: number, option: string): [string, number] {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`${option} 需要一个值`);
  return [value, index + 1];
}

export function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    command: "chat",
    commandArgs: [],
    continueLast: false,
    showLogo: true,
    color: true,
    showReasoning: false,
    help: false,
    version: false,
  };
  const prompt: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === "--") {
      prompt.push(...argv.slice(index + 1));
      break;
    }
    if (index === 0 && ["login", "usage", "sessions", "dsh"].includes(argument)) {
      options.command = argument as CliCommand;
      options.commandArgs = argv.slice(1);
      break;
    }
    if (index === 0 && argument === "resume") {
      options.resume = argv[1] ?? true;
      if (argv.length > 2) prompt.push(...argv.slice(2));
      break;
    }
    if (argument === "-h" || argument === "--help") options.help = true;
    else if (argument === "-V" || argument === "--version") options.version = true;
    else if (argument === "--no-logo") options.showLogo = false;
    else if (argument === "--no-color") options.color = false;
    else if (argument === "--thinking") options.showReasoning = true;
    else if (argument === "-c" || argument === "--continue") options.continueLast = true;
    else if (argument === "-m" || argument === "--model") {
      const [value, next] = takeValue(argv, index, argument);
      options.model = value;
      index = next;
    } else if (argument === "--endpoint" || argument === "--base-url") {
      const [value, next] = takeValue(argv, index, argument);
      options.baseUrl = value;
      index = next;
    } else if (argument === "-r" || argument === "--resume") {
      const candidate = argv[index + 1];
      if (candidate && !candidate.startsWith("-")) {
        options.resume = candidate;
        index += 1;
      } else {
        options.resume = true;
      }
    } else if (argument.startsWith("-")) {
      throw new Error(`未知选项：${argument}`);
    } else {
      prompt.push(argument);
    }
  }
  if (prompt.length > 0) options.prompt = prompt.join(" ");
  return options;
}

export function cliHelp(): string {
  return `DeepSeek Terminal

用法：
  deepseek                            启动交互终端
  deepseek "解释这个项目"             单次提问
  deepseek --model deepseek-v4-pro    指定模型
  deepseek --continue                 恢复当前目录最近会话
  deepseek resume [ID]                恢复指定会话
  deepseek login                      配置 API Key
  deepseek usage                      查询余额并打开用量页
  deepseek sessions                   列出本地会话
  deepseek dsh install                安装固定版本的官方 DSH
  deepseek dsh [start|open|status|stop|logs|restart]
                                      管理官方 DSH Web 后台

别名：dstui 与 deepseek 等价，可在命令冲突时使用。

选项：
  -m, --model <名称>      模型名称
  -c, --continue          恢复最近会话
  -r, --resume [ID]       选择或恢复会话
      --endpoint <URL>    OpenAI-compatible API 地址
      --thinking          显示思考过程
      --no-logo           不显示鲸鱼 Logo
      --no-color          禁用 ANSI 颜色
  -h, --help              显示帮助
  -V, --version           显示版本`;
}
