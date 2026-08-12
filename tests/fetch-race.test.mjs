// The cold-cache race, reproduced: two processes ensureDriver() into the
// same empty cache concurrently; both must succeed and agree on the binary.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const fetcher = path.resolve(here, "../harness/fetch-driver.mjs");

test("two concurrent cold-cache fetches both succeed", { timeout: 120_000 }, async (t) => {
  const cache = await fsp.mkdtemp(path.join(os.tmpdir(), "tit-race-"));
  t.after(() => fsp.rm(cache, { recursive: true, force: true }));
  const env = { ...process.env, TUI_IT_CACHE_DIR: cache };
  delete env.NODE_TEST_CONTEXT;

  const [a, b] = await Promise.all([
    run(process.execPath, [fetcher], { env }),
    run(process.execPath, [fetcher], { env }),
  ]);
  const pathA = a.stdout.trim();
  const pathB = b.stdout.trim();
  assert.equal(pathA, pathB, "both processes agree on the driver path");
  await fsp.access(pathA);
  const { stdout } = await run(pathA, ["--version"]);
  assert.match(stdout, /tui-test/);
});
