// Developer-experience guarantees, each one a former weakness found by
// auditing the package as its own harshest consumer:
//   - a bad binary produces an error naming the binary, not a driver argv dump
//   - launch(config, t) auto-closes; respawn() carries the cleanup across death
//   - every session exposes its rewatchable asciinema cast path
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { launch } from "../harness/harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const demo = path.resolve(here, "../examples/counter-demo/counter.mjs");

test("a missing binary fails with a message that names it", async () => {
  await assert.rejects(
    launch({ binary: "/nonexistent/definitely-not-a-tui", cols: 40, rows: 10 }),
    (error) => {
      assert.match(error.message, /failed to launch \/nonexistent\/definitely-not-a-tui/);
      return true;
    },
  );
});

test("launch(config, t) cleans up automatically, across respawn", async (t) => {
  // A fake test context records what would run at test end.
  const cleanups = [];
  const fakeT = { after: (fn) => cleanups.push(fn) };

  let session = await launch({ binary: process.execPath, args: [demo], cols: 60, rows: 20 }, fakeT);
  await session.waitForText("counter-demo");
  assert.equal(cleanups.length, 1, "launch registered its own cleanup");

  await session.kill();
  session = await session.respawn();
  await session.waitForText("counter-demo");
  assert.equal(cleanups.length, 2, "respawn registered the NEW session's cleanup");

  for (const fn of cleanups) await fn();
  // After cleanup the session is gone: the driver refuses the name.
  await assert.rejects(session.screen(), undefined, "closed session no longer answers");
});

test("every session exposes its asciinema recording path", async (t) => {
  const session = await launch({ binary: process.execPath, args: [demo], cols: 60, rows: 20 }, t);
  await session.waitForText("counter-demo");
  assert.ok(session.recordingPath, "recordingPath is set");
  assert.match(session.recordingPath, /\.cast$/);
  await fsp.access(session.recordingPath);
});

test("verifyDigest refuses a payload whose checksum does not match", async () => {
  const { verifyDigest } = await import("../harness/fetch-driver.mjs");
  const bytes = Buffer.from("pretend this is a driver tarball");
  const { createHash } = await import("node:crypto");
  const realSha = createHash("sha256").update(bytes).digest("hex");

  // Matching digest passes and returns the bytes unchanged.
  assert.equal(verifyDigest(bytes, realSha, "good.tar.gz"), bytes);

  // A tampered payload (or wrong pin) is refused before it can reach tar —
  // the entire "never curl | sh" guarantee is this one check.
  assert.throws(
    () => verifyDigest(bytes, "0".repeat(64), "tampered.tar.gz"),
    (error) => {
      assert.match(error.message, /checksum mismatch for tampered\.tar\.gz/);
      assert.match(error.message, /Refusing to install/);
      return true;
    },
  );
});
