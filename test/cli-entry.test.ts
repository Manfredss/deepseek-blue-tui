import assert from "node:assert/strict";
import { mkdtemp, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("CLI executes when its entry point is reached through a global-style symlink", {
  skip: process.platform === "win32" ? "symlink creation can require elevated privileges on Windows" : false,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "deepseek-cli-link-"));
  const link = join(directory, "deepseek.ts");
  await symlink(resolve("src/cli.ts"), link);
  const result = spawnSync(process.execPath, ["--import", "tsx", link, "--version"], {
    cwd: resolve("."),
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "0.1.0");
});
