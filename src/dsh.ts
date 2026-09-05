import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { accessSync, closeSync, constants, existsSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { readFile, rename, unlink } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { isRecord, writeJsonAtomic, ensurePrivateDirectory } from "./fs-utils.js";

const DSH_PACKAGE_NAME = "@deepseek-ai/dsh";
/** npm dist-tag installed by `dsh install` when no version is requested. */
const DEFAULT_DSH_TAG = "latest";
/** How far up from the executable to look for the package's own manifest. */
const MANIFEST_SEARCH_DEPTH = 6;
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

/** Reads a `version` from a manifest, but only if it really is dsh's own. */
function dshManifestVersion(manifestPath: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    if (!isRecord(manifest) || manifest.name !== DSH_PACKAGE_NAME) return undefined;
    return typeof manifest.version === "string" && manifest.version ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Version of the DSH that `commandPath` will actually run, discovered from the
 * package's own manifest rather than from a pinned constant. Symlinks are
 * resolved first, so a global shim (`/opt/homebrew/bin/dsh`), an npx cache
 * copy and a `DEEPSEEK_DSH_COMMAND` path all report the truth.
 */
export function detectDshVersion(commandPath: string): string | undefined {
  let current: string;
  try {
    current = dirname(realpathSync(commandPath));
  } catch {
    return undefined;
  }
  // A Windows global install leaves `dsh.cmd` beside node_modules rather than
  // inside the package. Probe that sibling tree, but only for the directory
  // the executable itself sits in: doing it at every level up would happily
  // attribute an unrelated project's node_modules copy to this binary.
  const sibling = dshManifestVersion(join(current, "node_modules", ...DSH_PACKAGE_NAME.split("/"), "package.json"));
  if (sibling) return sibling;
  for (let depth = 0; depth < MANIFEST_SEARCH_DEPTH; depth += 1) {
    const own = dshManifestVersion(join(current, "package.json"));
    if (own) return own;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function manifestCommand(requireFrom: NodeRequire): DshCommand | undefined {
  try {
    const manifestPath = requireFrom.resolve(`${DSH_PACKAGE_NAME}/package.json`);
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
    const version = detectDshVersion(command);
    return { command, argsPrefix: [], source: "custom", display: command, ...(version ? { version } : {}) };
  }
  const bundled = manifestCommand(options.requireFrom ?? createRequire(import.meta.url));
  if (bundled) return bundled;
  const fromPath = findOnPath("dsh", env);
  if (fromPath) {
    const version = detectDshVersion(fromPath);
    return { command: fromPath, argsPrefix: [], source: "path", display: fromPath, ...(version ? { version } : {}) };
  }
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
  // Ask for an unlimited-width command line. BSD/macOS ps otherwise may
  // truncate a long Node executable path before the identifying DSH segment.
  const result = spawnImpl("ps", ["-ww", "-p", String(pid), "-o", "command="], {
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
 * Installs DSH as an explicit global dependency. Since v0.1,
 * `@deepseek-ai/dsh` is no longer an optional dependency of this package (it
 * pulled in hundreds of packages); users opt in with `deepseek dsh install`
 * once. Without an explicit `version` this tracks the `latest` dist-tag —
 * there is no pinned "verified" version to fall behind any more.
 */
export async function installDsh(options: InstallDshOptions = {}): Promise<InstallDshResult> {
  const env = options.env ?? process.env;
  const spawnImpl = options.spawnImpl ?? spawnSync;
  const version = options.version ?? DEFAULT_DSH_TAG;

  const existing = resolveDshCommand({ env, ...(options.requireFrom ? { requireFrom: options.requireFrom } : {}) });
  if (existing) {
    return {
      installed: false,
      command: existing,
      message: `DSH 已可用：${existing.display}${existing.version ? ` (v${existing.version})` : ""}`,
    };
  }

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const shell = process.platform === "win32";
  const prefixResult = spawnImpl(npm, ["config", "get", "prefix"], {
    encoding: "utf8",
    env,
    timeout: 30_000,
    shell,
  });
  const prefix = prefixResult.status === 0 ? prefixResult.stdout.trim() : "";
  const spec = `${DSH_PACKAGE_NAME}@${version}`;
  const installResult = spawnImpl(
    npm,
    ["install", "--global", "--no-fund", "--no-audit", spec],
    { stdio: "inherit", env, timeout: 10 * 60_000, shell },
  );
  if (installResult.error) throw new Error(`无法运行 npm：${installResult.error.message}`);
  if (installResult.status !== 0) throw new Error(`DSH 安装失败（npm 退出码 ${installResult.status}）`);

  const binDirectory = prefix ? (process.platform === "win32" ? prefix : join(prefix, "bin")) : "";
  const binName = process.platform === "win32" ? "dsh.cmd" : "dsh";
  if (binDirectory) {
    const candidate = join(binDirectory, binName);
    if (executable(candidate)) {
      // Report what npm actually put on disk; `version` may just be a tag.
      const resolved = detectDshVersion(candidate) ?? (version === DEFAULT_DSH_TAG ? undefined : version);
      const command: DshCommand = {
        command: candidate,
        argsPrefix: [],
        source: "path",
        display: candidate,
        ...(resolved ? { version: resolved } : {}),
      };
      return {
        installed: true,
        command,
        message: resolved ? `已安装 DSH ${resolved}（${candidate}）` : `已安装 DSH（${candidate}）`,
      };
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

  /**
   * Version of the DSH currently installed on this machine, or undefined when
   * none can be found. Read from the package manifest each time so it tracks
   * upgrades without the client needing to know any version in advance.
   */
  installedVersion(env: NodeJS.ProcessEnv = process.env): string | undefined {
    return resolveDshCommand({ env })?.version;
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
    // `state.dshVersion` is the version the running process was started from.
    // Comparing it against what is installed *now* is a warning that can
    // actually fire and can actually be acted on, unlike the old comparison
    // against a hardcoded "verified" version that went stale on its own.
    const installed = this.installedVersion();
    const warning =
      state.dshVersion && installed && state.dshVersion !== installed
        ? `正在运行的 DSH ${state.dshVersion} 与当前安装的 ${installed} 不一致，可用 /dsh restart 切换`
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
      // Only a global install (or an explicit path) is discoverable: an
      // `npx @deepseek-ai/dsh` copy lives inside npm's private cache, which
      // is not on PATH, so having run npx before does not count as installed.
      throw new Error(
        "未找到 DSH。请任选一种方式安装：\n" +
          "  · 在本终端内输入 /dsh install（命令行下为 deepseek dsh install）\n" +
          "  · 自行全局安装：npm install -g @deepseek-ai/dsh\n" +
          "  · 已有一份 dsh：用 DEEPSEEK_DSH_COMMAND=<dsh 可执行文件路径> 指向它\n" +
          "注意：npx 装的副本只在 npm 缓存里，不在 PATH 上，因此不会被自动发现。",
      );
    }
    await ensurePrivateDirectory(this.home);
    await rotateLogIfNeeded(this.logPath);
    const logDescriptor = openSync(this.logPath, "a", 0o600);
    const args = [...command.argsPrefix, "web", "--host", "127.0.0.1", "--port", String(port)];
    // Node on Windows cannot CreateProcess a .cmd/.bat shim directly;
    // hand those to cmd.exe through the `shell` option.
    const windowsShellCommand = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command.command);
    const child = spawn(command.command, args, {
      cwd: options.cwd ?? process.cwd(),
      // A detached cmd.exe shim gets a fresh console on Windows and the
      // Node grandchild's stdout no longer reaches the inherited log file.
      detached: windowsShellCommand ? false : true,
      stdio: ["ignore", logDescriptor, logDescriptor],
      env: dshChildEnvironment(),
      windowsHide: true,
      ...(windowsShellCommand ? { shell: true } : {}),
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
    if (process.platform === "win32") {
      // The recorded PID is cmd.exe when DSH was launched through a
      // .cmd shim; taskkill /T terminates the wrapper and the Node child.
      const killed = spawnSync("taskkill", ["/pid", String(state.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      if (killed.error) throw new Error(`无法停止 Windows DSH 进程：${killed.error.message}`);
    } else {
      process.kill(-state.pid, "SIGTERM");
    }
    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline && pidAlive(state.pid)) await delay(100);
    if (pidAlive(state.pid)) {
      if (process.platform === "win32") process.kill(state.pid);
      else process.kill(-state.pid, "SIGKILL");
    }
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
