import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { acquireFileLock, LockHeldError, lockOwnerPid } from "../src/fs-utils.js";

async function temporaryDirectory(t: TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test("acquireFileLock grants, rejects a second live holder, and releases", async (t) => {
  const lockPath = join(await temporaryDirectory(t, "deepseek-lock-"), "session.json.lock");

  const first = await acquireFileLock(lockPath);
  assert.equal(lockOwnerPid(lockPath), process.pid);
  await assert.rejects(acquireFileLock(lockPath), LockHeldError);

  await first.release();
  assert.equal(lockOwnerPid(lockPath), undefined);

  const second = await acquireFileLock(lockPath);
  assert.equal(second.ownerPid, process.pid);
  await second.release();
});

test("acquireFileLock takes over a stale lock left by a dead process", async (t) => {
  const lockPath = join(await temporaryDirectory(t, "deepseek-lock-"), "stale.json.lock");
  await writeFile(lockPath, JSON.stringify({ pid: 2_147_483_647, acquiredAt: "2026-01-01T00:00:00.000Z" }), "utf8");

  const lock = await acquireFileLock(lockPath);
  assert.equal(lockOwnerPid(lockPath), process.pid);
  await lock.release();
});

test("release leaves a lock taken over by another process alone", async (t) => {
  const lockPath = join(await temporaryDirectory(t, "deepseek-lock-"), "takeover.json.lock");
  const lock = await acquireFileLock(lockPath);

  // Simulate another process stealing the lock out from under us.
  await writeFile(lockPath, JSON.stringify({ pid: 424242, acquiredAt: "2026-01-01T00:00:00.000Z" }), "utf8");
  await lock.release();

  assert.equal(lockOwnerPid(lockPath), 424242);
});
