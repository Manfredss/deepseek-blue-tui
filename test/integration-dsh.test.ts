import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { DshManager, isPortOpen, resolveDshCommand } from "../src/dsh.js";

async function temporaryDirectory(t: TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

const STUB_SOURCE = `
import { createServer } from "node:net";
const index = process.argv.indexOf("--port");
const port = Number(index >= 0 ? process.argv[index + 1] : "0");
const server = createServer((socket) => {
  // Readiness probes disconnect as soon as TCP opens, so ignore that expected reset.
  socket.on("error", () => undefined);
  socket.end("HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\n\\r\\nok");
});
server.listen(port, "127.0.0.1", () => {
  console.log("dsh web: http://127.0.0.1:" + port);
});
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
`;

/**
 * Writes a fake `dsh` executable whose parent directory segment is literally
 * `dsh`, so the Unix identity check in DshManager.stop() can match it the
 * same way it matches a real DSH process.
 */
async function writeDshStub(directory: string): Promise<string> {
  const stubDirectory = join(directory, "dsh");
  await mkdir(join(stubDirectory, "lib"), { recursive: true });
  await writeFile(join(stubDirectory, "lib", "stub.mjs"), STUB_SOURCE, "utf8");
  const entry = join(stubDirectory, process.platform === "win32" ? "dsh.cmd" : "dsh");
  if (process.platform === "win32") {
    const escaped = join(stubDirectory, "lib", "stub.mjs").replaceAll("/", "\\");
    await writeFile(entry, `@echo off\r\n"${process.execPath}" "${escaped}" %*\r\n`, "utf8");
  } else {
    await writeFile(entry, `#!/bin/sh\nexec "${process.execPath}" "${join(stubDirectory, "lib", "stub.mjs")}" "$@"\n`, "utf8");
    await chmod(entry, 0o755);
  }
  return entry;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    probe.once("error", rejectListen);
    probe.listen(0, "127.0.0.1", resolveListen);
  });
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));
  return port;
}

/** Returns deterministic process metadata without depending on host ps permissions. */
function matchingPsFor(stubEntry: string): typeof spawnSync {
  const stubSource = join(stubEntry, "..", "lib", "stub.mjs");
  return ((_command: string, args: string[]) => {
    const pid = Number(args[args.indexOf("-p") + 1]);
    return {
      status: 0,
      signal: null,
      pid: 0,
      output: ["", ""],
      stdout: `node ${stubSource} web --host 127.0.0.1 --port ${pid}`,
      stderr: "",
      error: undefined,
    };
  }) as unknown as typeof spawnSync;
}

test("DshManager runs the full cross-platform lifecycle against a stub DSH", async (t) => {
  let cleanupPid: number | undefined;
  t.after(() => {
    if (!cleanupPid) return;
    try {
      process.kill(cleanupPid, "SIGKILL");
    } catch {
      // Already gone.
    }
  });
  const directory = await temporaryDirectory(t, "deepseek-dsh-lifecycle-");
  const stub = await writeDshStub(directory);
  const home = join(directory, "home");
  const manager = new DshManager(home, matchingPsFor(stub));
  const port = await freePort();

  // Pre-fill an oversized log so start() must rotate it.
  await mkdir(join(home, "dsh"), { recursive: true });
  await writeFile(manager.logPath, "x".repeat(1_100_000), "utf8");

  const env = { ...process.env, DEEPSEEK_DSH_COMMAND: stub };
  const command = resolveDshCommand({ env });
  assert.ok(command, "stub must resolve via DEEPSEEK_DSH_COMMAND");
  assert.equal(command.source, "custom");

  const running = await manager.start({ port, command, cwd: directory, waitMs: 15_000 }).catch(async (error: unknown) => {
    cleanupPid = (await manager.readState())?.pid;
    throw error;
  });
  cleanupPid = running.pid;
  assert.equal(running.phase, "running");
  assert.equal(running.port, port);
  assert.ok(running.pid);
  assert.equal(await isPortOpen(port, "127.0.0.1", 500), true);

  const logs = await manager.logs(10);
  assert.match(logs, /dsh web: http:\/\/127\.0\.0\.1/);

  // Rotation moved the oversized log aside and started a fresh one.
  assert.equal(existsSync(`${manager.logPath}.1`), true);
  assert.ok((await stat(manager.logPath)).size < 1_100_000);

  const stopped = await manager.stop();
  assert.equal(stopped.stopped, true);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  assert.equal(await isPortOpen(port, "127.0.0.1", 300), false);
  assert.deepEqual(await manager.status(port), {
    phase: "stopped",
    port,
    url: `http://127.0.0.1:${port}`,
  });
  cleanupPid = undefined;
});

test("DshManager refuses to stop when process identity cannot be confirmed", {
  skip: process.platform === "win32" ? "Windows skips the ps-based identity check by design" : false,
}, async (t) => {
  let cleanupPid: number | undefined;
  t.after(() => {
    if (!cleanupPid) return;
    try {
      process.kill(cleanupPid, "SIGKILL");
    } catch {
      // Already gone.
    }
  });
  const directory = await temporaryDirectory(t, "deepseek-dsh-refuse-");
  const stub = await writeDshStub(directory);
  let psCommand: string | undefined;
  let psArgs: readonly string[] | undefined;
  const mismatchingPs = ((command: string, args: readonly string[]) => {
    psCommand = command;
    psArgs = args;
    return {
      status: 0,
      signal: null,
      pid: 0,
      output: ["", ""],
      stdout: "some-unrelated-process",
      stderr: "",
      error: undefined,
    };
  }) as unknown as typeof spawnSync;
  const manager = new DshManager(join(directory, "home"), mismatchingPs);
  const port = await freePort();

  const command = resolveDshCommand({ env: { ...process.env, DEEPSEEK_DSH_COMMAND: stub } });
  assert.ok(command);
  const running = await manager.start({ port, command, cwd: directory, waitMs: 15_000 }).catch(async (error: unknown) => {
    cleanupPid = (await manager.readState())?.pid;
    throw error;
  });
  cleanupPid = running.pid;
  assert.equal(running.phase, "running");
  assert.ok(running.pid);

  await assert.rejects(manager.stop(), /与 DSH 不匹配/);
  assert.equal(psCommand, "ps");
  assert.deepEqual(psArgs, ["-ww", "-p", String(running.pid), "-o", "command="]);
  assert.equal(await isPortOpen(port, "127.0.0.1", 300), true, "the stub must still be running");
});
