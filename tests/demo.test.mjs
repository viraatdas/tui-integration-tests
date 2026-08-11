// The framework's own proof: drive the bundled counter-demo TUI through a
// real PTY and assert on what is visible. Every capability the README claims
// is exercised here — if these are green, plugging in your own binary is a
// config change, not a leap of faith.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { launch } from "../harness/harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const demo = path.resolve(here, "../examples/counter-demo/counter.mjs");

async function launchDemo(t, env = {}) {
  const session = await launch({
    binary: process.execPath, // node
    args: [demo],
    cols: 80,
    rows: 24,
    env,
  });
  t.after(() => session.close());
  return session;
}

test("keystrokes change what is on screen", async (t) => {
  const session = await launchDemo(t);
  await session.waitForText("counter-demo");
  await session.waitForText("count: 0");

  await session.type("+++");
  await session.waitForText("count: 3");

  await session.type("-");
  await session.waitForText("count: 2");

  await session.type("r");
  await session.waitForText("count: 0");
});

test("resize reflows the UI without killing the process", async (t) => {
  const session = await launchDemo(t);
  await session.waitForText("size: 80x24");

  await session.resize(60, 20);
  await session.waitForText("size: 60x20");

  // Still interactive after the reflow — the redraw did not wedge input.
  await session.type("+");
  await session.waitForText("count: 1");
});

test("state survives kill and respawn", async (t) => {
  // THE test that in-process harnesses cannot express: boot, mutate state,
  // kill the process, boot a NEW process against the same state on disk, and
  // assert the restart derived its state honestly.
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tit-demo-"));
  t.after(() => fsp.rm(stateDir, { recursive: true, force: true }));
  const env = { COUNTER_STATE: path.join(stateDir, "count") };

  let session = await launchDemo(t, env);
  await session.waitForText("count: 0");
  await session.type("+++++");
  await session.waitForText("count: 5");

  await session.kill();
  session = await session.respawn();
  t.after(() => session.close());

  await session.waitForText("(restored)");
  await session.waitForText("count: 5");
});

test("waitForGone observes disappearance, and q exits cleanly", async (t) => {
  const session = await launchDemo(t);
  await session.waitForText("count: 0");
  await session.type("+");
  await session.waitForGone("count: 0");

  await session.type("q");
  await session.waitForExit();
});

test("normalizers keep volatile output out of assertions", async (t) => {
  const session = await launchDemo(t);
  // The demo has no timestamps, so prove the mechanism with a custom rule.
  session.normalizers = [[/count: \d+/g, "count: <n>"]];
  await session.type("+++++++");
  await session.waitForText("count: <n>");
  const screen = await session.screen();
  assert.ok(!/count: \d/.test(screen), `normalizer left digits behind:\n${screen}`);
});

test("window title is assertable", async (t) => {
  const session = await launchDemo(t);
  await session.waitForText("counter-demo");
  assert.equal(await session.title(), "counter-demo");
});
