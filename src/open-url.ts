import { spawn, type ChildProcess } from "node:child_process";

export const DEEPSEEK_URLS = {
  apiKeys: "https://platform.deepseek.com/api_keys",
  usage: "https://platform.deepseek.com/usage",
  topUp: "https://platform.deepseek.com/top_up",
} as const;

export interface OpenCommand {
  command: string;
  args: string[];
}

export function commandForUrl(url: string, runtimePlatform = process.platform): OpenCommand {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("仅允许打开 http(s) 链接");
  }
  if (runtimePlatform === "darwin") return { command: "open", args: [parsed.href] };
  if (runtimePlatform === "win32") {
    return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", parsed.href] };
  }
  return { command: "xdg-open", args: [parsed.href] };
}

export async function openUrl(
  url: string,
  spawnImpl: typeof spawn = spawn,
  runtimePlatform = process.platform,
): Promise<boolean> {
  const launch = commandForUrl(url, runtimePlatform);
  return await new Promise<boolean>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnImpl(launch.command, launch.args, { detached: true, stdio: "ignore", windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
    child.once("error", () => resolve(false));
  });
}
