import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface FileLock {
  /** Path of the lock file; the lock is held until `release()` is called. */
  readonly path: string;
  /** Owner PID recorded in the lock file. */
  readonly ownerPid: number;
  release: () => Promise<void>;
}

/**
 * Acquires an advisory lock backed by an exclusive-creation lock file.
 *
 * A stale lock (owner PID no longer alive) is taken over automatically, so a
 * crashed terminal never leaves a session permanently locked. The lock file
 * is removed on release only if this process still owns it.
 */
export async function acquireFileLock(lockPath: string): Promise<FileLock> {
  await ensurePrivateDirectory(dirname(lockPath));
  const payload = (): string => `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`;
  const tryAcquire = async (): Promise<FileLock | undefined> => {
    try {
      const descriptor = openSync(lockPath, "wx", 0o600);
      writeFileSync(descriptor, payload(), "utf8");
      closeSync(descriptor);
      return ownedLock(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return undefined;
    }
  };
  const ownedLock = (path: string): FileLock => ({
    path,
    ownerPid: process.pid,
    release: async () => {
      try {
        const raw = readFileSync(path, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        const pid = isRecord(parsed) && Number.isInteger(parsed.pid) ? parsed.pid : undefined;
        if (pid !== process.pid) return; // Someone else took the lock over; do not delete it.
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      }
      await unlink(path).catch(() => undefined);
    },
  });

  const first = await tryAcquire();
  if (first) return first;

  // Lock file exists: check whether its owner is still alive before failing.
  const ownerPid = lockOwnerPid(lockPath);
  if (ownerPid !== undefined && !processAlive(ownerPid)) {
    await unlink(lockPath).catch(() => undefined);
    const retried = await tryAcquire();
    if (retried) return retried;
    throw new LockHeldError(lockPath, lockOwnerPid(lockPath));
  }
  throw new LockHeldError(lockPath, ownerPid);
}

export class LockHeldError extends Error {
  readonly lockPath: string;
  readonly ownerPid: number | undefined;

  constructor(lockPath: string, ownerPid?: number) {
    super(
      ownerPid !== undefined
        ? `会话正被另一个进程使用 (PID ${ownerPid})`
        : `会话正被另一个进程使用`,
    );
    this.name = "LockHeldError";
    this.lockPath = lockPath;
    if (ownerPid !== undefined) this.ownerPid = ownerPid;
  }
}

export function lockOwnerPid(lockPath: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as unknown;
    return isRecord(parsed) && typeof parsed.pid === "number" && Number.isInteger(parsed.pid)
      ? parsed.pid
      : undefined;
  } catch {
    return undefined;
  }
}
