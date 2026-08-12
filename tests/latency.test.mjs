// Latency + visual integrity: a TUI can be correct in content yet broken in
// responsiveness (frozen, sluggish) or in rendering (torn borders, escape
// bleed). These prove the framework can measure and assert both.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { launch } from "../harness/harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const demo = path.resolve(here, "../examples/counter-demo/counter.mjs");

test("keystrokeLatency measures a keystroke-to-render time within budget", async (t) => {
  const session = await launch({ binary: process.execPath, args: [demo], cols: 60, rows: 20 }, t);
  await session.waitForText("count: 0");
  // A local process reflecting a keypress should be well under a second.
  const ms = await session.keystrokeLatency("count: 1", "+");
  assert.ok(ms >= 0, "returns a duration");
  assert.ok(ms < 1000, `keystroke reflected in ${ms}ms (budget 1000ms)`);
});

test("timeToScreen times an arbitrary action", async (t) => {
  const session = await launch({ binary: process.execPath, args: [demo], cols: 60, rows: 20 }, t);
  await session.waitForText("count: 0");
  const ms = await session.timeToScreen(
    () => session.type("+++++"),
    (screen) => screen.includes("count: 5"),
  );
  assert.ok(ms < 2000, `five increments landed in ${ms}ms`);
});

test("a healthy screen reports no visual issues and passes assertIntact", async (t) => {
  const session = await launch({ binary: process.execPath, args: [demo], cols: 60, rows: 20 }, t);
  await session.waitForText("counter-demo");
  assert.deepEqual(await session.visualIssues(), [], "the demo renders cleanly");
  await session.assertIntact();
});

test("visualIssues catches a torn box border and escape-byte bleed", async (t) => {
  // A TUI that draws a box top with no closing corner AND leaks a raw escape
  // byte into content — both structural corruptions a text assertion misses.
  const broken = `${here}/../.tui-report/broken-tui.mjs`;
  const fs = await import("node:fs/promises");
  await fs.mkdir(`${here}/../.tui-report`, { recursive: true });
  await fs.writeFile(
    broken,
    // A '┌' with no '┐', plus a stray ESC byte in the body.
    'process.stdout.write("\\x1b[2J\\x1b[H");\n' +
      'process.stdout.write("\\u250c broken top with no corner\\n");\n' +
      'process.stdout.write("body with a stray \\x1b escape byte\\n");\n' +
      'setInterval(() => {}, 1000);\n',
  );
  const session = await launch({ binary: process.execPath, args: [broken], cols: 60, rows: 10 }, t);
  await session.waitForText("broken top");
  const issues = await session.visualIssues();
  assert.ok(issues.length > 0, "corruption is detected");
  assert.ok(
    issues.some((i) => /never closes/.test(i)),
    `torn border flagged: ${JSON.stringify(issues)}`,
  );
  await assert.rejects(session.assertIntact(), /not visually intact/);
});
