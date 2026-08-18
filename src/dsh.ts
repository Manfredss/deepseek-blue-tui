import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { accessSync, closeSync, constants, existsSync, openSync, readFileSync, statSync } from "node:fs";
import { readFile, rename, unlink } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { isRecord, writeJsonAtomic, ensurePrivateDirectory } from "./fs-utils.js";

const VERIFIED_DSH_VERSION = "0.1.0-rc.7";
const LOG_MAX_BYTES = 1_048_576; // Rotate the DSH log at 1 MiB.
const LOG_KEPT_ROTATIONS = 1;

export interface DshCommand {
  command: string;
  argsPrefix: string[];
  source: "bundled" | "path" | "custom";
  display: string;
  version?: string;
}

export interface DshState {
  version: 1;
  pid: number;
  port: number;
  url: string;
  cwd: string;
  logFile: string;
  startedAt: string;
  launchDisplay: string;
  dshVersion?: string;
}

export interface DshStatus {
  phase: "running" | "starting" | "stopped" | "external";
  port: number;
  url: string;
  pid?: number;
  logFile?: string;
  cwd?: string;
  version?: string;
  warning?: string;
}

function executable(path: string): boolean {
  try {
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const pathValue = env.PATH;
  if (!pathValue) return undefined;
  const suffixes = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    for (const suffix of suffixes) {
      const candidate = join(directory, `${name}${suffix}`);
      if (executable(candidate)) return candidate;
    }
  }
  return undefined;
}

function manifestCommand(requireFrom: NodeRequire): DshCommand | undefined {
  try {
    const manifestPath = requireFrom.resolve("@deepseek-ai/dsh/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    if (!isRecord(manifest) || !isRecord(manifest.bin) || typeof manifest.bin.dsh !== "string") return undefined;
    const binPath = resolve(dirname(manifestPath), manifest.bin.dsh);
    if (!existsSync(binPath)) return undefined;
    const result: DshCommand = {
      command: process.execPath,
      argsPrefix: [binPath],
      source: "bundled",
      display: `${process.execPath} ${binPath}`,
    };
    if (typeof manifest.version === "string") result.version = manifest.version;
    return result;
  } catch {
    return undefined;
  }
}

export function resolveDshCommand(options: {
  env?: NodeJS.ProcessEnv;
  requireFrom?: NodeRequire;
} = {}): DshCommand | undefined {
  const env = options.env ?? process.env;
  if (env.DEEPSEEK_DSH_COMMAND?.trim()) {
    const command = env.DEEPSEEK_DSH_COMMAND.trim();
    if (isAbsolute(command) && !executable(command)) return undefined;
    return { command, argsPrefix: [], source: "custom", display: command };
  }
  const bundled = manifestCommand(options.requireFrom ?? createRequire(import.meta.url));
  if (bundled) return bundled;
  const fromPath = findOnPath("dsh", env);
  if (fromPath) return { command: fromPath, argsPrefix: [], source: "path", display: fromPath };
  return undefined;
}

export function dshChildEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  // The chat client's credential must not silently cross into the independent
  // Harness trust boundary. DSH manages its own provider credentials.
  delete childEnv.DEEPSEEK_API_KEY;
  delete childEnv.DEEPSEEK_BASE_URL;
  return childEnv;
}

export async function isPortOpen(port: number, host = "127.0.0.1", timeoutMs = 350): Promise<boolean> {
  return await new Promise<boolean>((resolvePort) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePort(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function looksLikeDsh(pid: number, spawnImpl: typeof spawnSync = spawnSync): boolean {
  if (process.platform === "win32") return true;
  const result = spawnImpl("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    timeout: 2_000,
  });
  if (result.status !== 0) return false;
  return /(?:@deepseek-ai[\\/]dsh|[\\/]dsh(?:[\\/]|\s)|lib[\\/]bin\.js)/i.test(result.stdout);
}

function validState(value: unknown): DshState | undefined {
  if (!isRecord(value)) return undefined;
  if (!Number.isInteger(value.pid) || Number(value.pid) <= 1) return undefined;
  if (!Number.isInteger(value.port) || Number(value.port) <= 0 || Number(value.port) > 65_535) return undefined;
  if (
    typeof value.url !== "string" ||
    typeof value.cwd !== "string" ||
    typeof value.logFile !== "string" ||
    typeof value.startedAt !== "string" ||
    typeof value.launchDisplay !== "string"
  ) {
    return undefined;
  }
  const state: DshState = {
    version: 1,
    pid: Number(value.pid),
    port: Number(value.port),
    url: value.url,
    cwd: value.cwd,
    logFile: value.logFile,
    startedAt: value.startedAt,
    launchDisplay: value.launchDisplay,
  };
  if (typeof value.dshVersion === "string") state.dshVersion = value.dshVersion;
  return state;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export function redactSecrets(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-••••••••")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, "Bearer ••••••••")
    .replace(/\bAuthorization:\s*[^\r\n]+/gi, "Authorization: ••••••••");
}

async function rotateLogIfNeeded(logPath: string): Promise<void> {
  try {
    if (statSync(logPath).size < LOG_MAX_BYTES) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (let index = LOG_KEPT_ROTATIONS; index >= 1; index -= 1) {
    const rotated = `${logPath}.${index}`;
    if (index === LOG_KEPT_ROTATIONS) {
      await unlink(rotated).catch(() => undefined); // rename cannot replace on Windows.
    } else {
      const next = `${logPath}.${index + 1}`;
      await rename(rotated, next).catch(() => undefined);
    }
  }
  await rename(logPath, `${logPath}.1`);
}

export interface InstallDshOptions {
  version?: string;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: typeof spawnSync;
  requireFrom?: NodeRequire;
}

export interface InstallDshResult {
  installed: boolean;
  command?: DshCommand;
  message: string;
}

/**
 * Installs the pinned DSH version as an explicit global dependency. Since
 * v0.1, `@deepseek-ai/dsh` is no longer an optional dependency of this
 * package (it pulled in hundreds of packages); users opt in with
 * `deepseek dsh install` once.
 */
export async function installDsh(options: InstallDshOptions = {}): Promise<InstallDshResult> {
  const env = options.env ?? process.env;
  const spawnImpl = options.spawnImpl ?? spawnSync;
  const version = options.version ?? VERIFIED_DSH_VERSION;

  const existing = resolveDshCommand({ env, ...(options.requireFrom ? { requireFrom: options.requireFrom } : {}) });
  if (existing) {
    return {
      installed: false,
      command: existing,
      message: `DSH 已可用：${existing.display}${existing.version ? ` (v${existing.version})` : ""}`,
    };
  }

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const prefixResult = spawnImpl(npm, ["config", "get", "prefix"], { encoding: "utf8", env, timeout: 30_000 });
  const prefix = prefixResult.status === 0 ? prefixResult.stdout.trim() : "";
  const spec = `@deepseek-ai/dsh@${version}`;
  const installResult = spawnImpl(
    npm,
    ["install", "--global", "--no-fund", "--no-audit", spec],
    { stdio: "inherit", env, timeout: 10 * 60_000 },
  );
  if (installResult.error) throw new Error(`无法运行 npm：${installResult.error.message}`);
  if (installResult.status !== 0) throw new Error(`DSH 安装失败（npm 退出码 ${installResult.status}）`);

  const binDirectory = prefix ? (process.platform === "win32" ? prefix : join(prefix, "bin")) : "";
  const binName = process.platform === "win32" ? "dsh.cmd" : "dsh";
  if (binDirectory) {
    const candidate = join(binDirectory, binName);
    if (executable(candidate)) {
      const command: DshCommand = { command: candidate, argsPrefix: [], source: "path", display: candidate, version };
      return { installed: true, command, message: `已安装 DSH ${version}（${candidate}）` };
    }
  }
  return {
    installed: true,
    message: `已运行安装命令，但未在 ${binDirectory || "npm 全局目录"} 找到 dsh。请重开终端，或用 DEEPSEEK_DSH_COMMAND 指向它。`,
  };
}

export class DshManager {
  readonly home: string;
  readonly statePath: string;
  readonly logPath: string;
  private readonly psImpl: typeof spawnSync;

  /**
   * `psImpl` exists so tests can emulate the process-identity check on
   * platforms where `/bin/ps` is unavailable; production always uses the
   * real one (fail-safe: if the identity cannot be verified, stop refuses).
   */
  constructor(home: string, psImpl: typeof spawnSync = spawnSync) {
    this.home = join(home, "dsh");
    this.statePath = join(this.home, "state.json");
    this.logPath = join(this.home, "dsh.log");
    this.psImpl = psImpl;
  }

  async readState(): Promise<DshState | undefined> {
    try {
      return validState(JSON.parse(await readFile(this.statePath, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  async status(port = 3080): Promise<DshStatus> {
    const state = await this.readState();
    const effectivePort = state?.port ?? port;
    const open = await isPortOpen(effectivePort);
    const url = `http://127.0.0.1:${effectivePort}`;
    if (!state) return { phase: open ? "external" : "stopped", port: effectivePort, url };
    const alive = pidAlive(state.pid);
    const common = {
      port: effectivePort,
      url,
      pid: state.pid,
      logFile: state.logFile,
      cwd: state.cwd,
      ...(state.dshVersion ? { version: state.dshVersion } : {}),
    };
    const warning = state.dshVersion && state.dshVersion !== VERIFIED_DSH_VERSION
      ? `当前 DSH ${state.dshVersion} 未经本版本验证（已验证 ${VERIFIED_DSH_VERSION}）`
      : undefined;
    if (alive && open) return { phase: "running", ...common, ...(warning ? { warning } : {}) };
    if (alive) return { phase: "starting", ...common, ...(warning ? { warning } : {}) };
    if (open) {
      return { phase: "external", ...common, warning: "记录的 DSH 进程已退出，但该端口仍由其他进程占用" };
    }
    return { phase: "stopped", ...common, warning: "发现已失效的 DSH PID 记录" };
  }

  async start(options: {
    port?: number;
    cwd?: string;
    waitMs?: number;
    command?: DshCommand;
  } = {}): Promise<DshStatus> {
    const port = options.port ?? 3080;
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error("DSH 端口必须在 1 到 65535 之间");
    const current = await this.status(port);
    if (current.phase === "running" || current.phase === "starting") return current;
    if (current.phase === "external") throw new Error(`端口 ${port} 已被其他进程占用`);

    const command = options.command ?? resolveDshCommand();
    if (!command) {
      throw new Error(`未找到 DSH。请运行 deepseek dsh install，或用 DEEPSEEK_DSH_COMMAND 指定已安装的 dsh`);
    }
    await ensurePrivateDirectory(this.home);
    await rotateLogIfNeeded(this.logPath);
    const logDescriptor = openSync(this.logPath, "a", 0o600);
    const args = [...command.argsPrefix, "web", "--host", "127.0.0.1", "--port", String(port)];
    const child = spawn(command.command, args, {
      cwd: options.cwd ?? process.cwd(),
      detached: true,
      stdio: ["ignore", logDescriptor, logDescriptor],
      env: dshChildEnvironment(),
      windowsHide: true,
    });
    try {
      await new Promise<void>((resolveSpawn, rejectSpawn) => {
        child.once("spawn", resolveSpawn);
        child.once("error", rejectSpawn);
      });
    } finally {
      closeSync(logDescriptor);
    }
    if (!child.pid) throw new Error("DSH 进程未返回 PID");
    child.unref();
    const url = `http://127.0.0.1:${port}`;
    const state: DshState = {
      version: 1,
      pid: child.pid,
      port,
      url,
      cwd: options.cwd ?? process.cwd(),
      logFile: this.logPath,
      startedAt: new Date().toISOString(),
      launchDisplay: `${command.display} web --host 127.0.0.1 --port ${port}`,
    };
    if (command.version) state.dshVersion = command.version;
    await writeJsonAtomic(this.statePath, state);

    const deadline = Date.now() + (options.waitMs ?? 45_000);
    while (Date.now() < deadline) {
      if (await isPortOpen(port)) return await this.status(port);
      if (!pidAlive(child.pid)) {
        const tail = await this.logs(20);
        throw new Error(`DSH 启动失败。日志：\n${tail || "(无输出)"}`);
      }
      await delay(250);
    }
    return await this.status(port);
  }

  async stop(): Promise<{ stopped: boolean; message: string }> {
    const state = await this.readState();
    if (!state) return { stopped: false, message: "没有由 deepseek 管理的 DSH 进程" };
    if (!pidAlive(state.pid)) {
      await unlink(this.statePath).catch(() => undefined);
      return { stopped: false, message: "DSH 已停止，已清理失效的 PID 记录" };
    }
    if (!looksLikeDsh(state.pid, this.psImpl)) {
      throw new Error(`PID ${state.pid} 与 DSH 不匹配；为避免误杀，拒绝停止`);
    }
    const targetPid = process.platform === "win32" ? state.pid : -state.pid;
    process.kill(targetPid, "SIGTERM");
    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline && pidAlive(state.pid)) await delay(100);
    if (pidAlive(state.pid)) process.kill(targetPid, "SIGKILL");
    await unlink(this.statePath).catch(() => undefined);
    return { stopped: true, message: `DSH 已停止 (PID ${state.pid})` };
  }

  async logs(lines = 80): Promise<string> {
    try {
      const text = await readFile(this.logPath, "utf8");
      return redactSecrets(
        text.split(/\r?\n/).slice(-Math.max(1, lines)).join("\n").trimEnd(),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }
}

export function formatDshStatus(status: DshStatus): string {
  const labels: Record<DshStatus["phase"], string> = {
    running: "运行中",
    starting: "启动中",
    stopped: "已停止",
    external: "端口由外部进程占用",
  };
  const details = [labels[status.phase], status.url];
  if (status.pid) details.push(`PID ${status.pid}`);
  if (status.version) details.push(`DSH ${status.version}`);
  if (status.warning) details.push(status.warning);
  return details.join(" · ");
}

export function dshExecutableName(command: DshCommand): string {
  return basename(command.command);
}
