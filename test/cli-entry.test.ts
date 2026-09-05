import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink } from "node:fs/promises";
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
  // What matters is that the CLI still resolves its own manifest when reached
  // through a symlink, not which version happens to be current — hardcoding
  // the literal here meant every release broke this test.
  const { version } = JSON.parse(await readFile(resolve("package.json"), "utf8")) as { version: string };
  assert.match(version, /^\d+\.\d+\.\d+/, "the manifest should carry a real version");
  assert.equal(result.stdout.trim(), version);
});
