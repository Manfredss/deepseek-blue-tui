import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { platform } from "node:os";

/**
 * Getting a code block out of the terminal without reaching for the mouse.
 *
 * Two paths, in order: the platform's own clipboard command, and failing that
 * OSC 52, which asks the terminal itself to do it — the only thing that works
 * over SSH, where the "local" clipboard is on the wrong machine.
 */

export interface ClipboardTarget {
  command: string;
  args: string[];
  /** Shown to the user so it is obvious which mechanism ran. */
  label: string;
}

function onPath(command: string, env: NodeJS.ProcessEnv): boolean {
  const entries = (env.PATH ?? "").split(delimiter).filter(Boolean);
  return entries.some((directory) => {
    try {
      accessSync(join(directory, command), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * The clipboard command for this platform, or undefined when none is
 * installed. Linux has no single answer, so the display server decides:
 * `wl-copy` under Wayland, then the X11 tools.
 */
export function clipboardCommand(
  osPlatform: string = platform(),
  env: NodeJS.ProcessEnv = process.env,
  has: (command: string) => boolean = (command) => onPath(command, env),
): ClipboardTarget | undefined {
  // One executable or command name, never a shell string — the same rule
  // DEEPSEEK_DSH_COMMAND follows, and for the same reason.
  const override = env.DEEPSEEK_TUI_CLIPBOARD?.trim();
  if (override) return { command: override, args: [], label: override };
  if (osPlatform === "darwin") return { command: "pbcopy", args: [], label: "pbcopy" };
  if (osPlatform === "win32") return { command: "clip", args: [], label: "clip" };
  if (env.WAYLAND_DISPLAY?.trim() && has("wl-copy")) return { command: "wl-copy", args: [], label: "wl-copy" };
  if (has("xclip")) return { command: "xclip", args: ["-selection", "clipboard"], label: "xclip" };
  if (has("xsel")) return { command: "xsel", args: ["--clipboard", "--input"], label: "xsel" };
  if (has("wl-copy")) return { command: "wl-copy", args: [], label: "wl-copy" };
  return undefined;
}

/** Pipes text into the clipboard command. Rejects when it is not usable. */
export async function writeClipboard(text: string, target: ClipboardTarget): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(target.command, target.args, { stdio: ["pipe", "ignore", "ignore"] });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${target.label} 退出码 ${String(code)}`));
    });
    child.stdin.on("error", reject);
    child.stdin.end(text, "utf8");
  });
}

/**
 * Most terminals refuse an OSC 52 payload beyond roughly this size, and a
 * refusal is silent — so it is checked here rather than discovered by the user
 * pasting nothing.
 */
export const OSC52_MAX_BYTES = 74_994;

/** The escape sequence asking the terminal to put `text` on its clipboard. */
export function osc52(text: string): string {
  return `]52;c;${Buffer.from(text, "utf8").toString("base64")}`;
}
