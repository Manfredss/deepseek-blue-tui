import { spawn } from "node:child_process";
export const DEEPSEEK_URLS = {
    apiKeys: "https://platform.deepseek.com/api_keys",
    usage: "https://platform.deepseek.com/usage",
    topUp: "https://platform.deepseek.com/top_up",
};
export function commandForUrl(url, runtimePlatform = process.platform) {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("仅允许打开 http(s) 链接");
    }
    if (runtimePlatform === "darwin")
        return { command: "open", args: [parsed.href] };
    if (runtimePlatform === "win32") {
        return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", parsed.href] };
    }
    return { command: "xdg-open", args: [parsed.href] };
}
export async function openUrl(url, spawnImpl = spawn, runtimePlatform = process.platform) {
    const launch = commandForUrl(url, runtimePlatform);
    return await new Promise((resolve) => {
        let child;
        try {
            child = spawnImpl(launch.command, launch.args, { detached: true, stdio: "ignore", windowsHide: true });
        }
        catch {
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
