// A JOURNEY in anger: one continuous multi-turn user story — mutate state,
// reset, mutate again, resize mid-flow, die, come back, verify memory, quit
// cleanly — with every step checkpointed and told in the HTML report. This is
// the shape real TUI assessment takes: not "does one key work", but "does a
// session that lives, changes its mind, and restarts still hold together".
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { journey, launch } from "../harness/harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const demo = path.resolve(here, "../examples/counter-demo/counter.mjs");

test("a full user story survives mutation, resize, and death", { timeout: 60_000 }, async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tit-journey-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const env = { COUNTER_STATE: path.join(dir, "count") };

  let session = await launch({ binary: process.execPath, args: [demo], cols: 80, rows: 24, env });
  t.after(() => session.close());
  const story = journey(session, "counter: a session that lives, breaks, and returns");

  await story.step("boots to a zero counter", async () => {
    await session.waitForText("count: 0");
  });

  await story.step("five increments show 5", async () => {
    await session.type("+++++");
    await session.waitForText("count: 5");
  });

  await story.step("reset takes it back to zero", async () => {
    await session.type("r");
    await session.waitForText("count: 0");
  });

  await story.step("three more land at 3, mid-journey", async () => {
    await session.type("+++");
    await session.waitForText("count: 3");
  });

  await story.step("a resize mid-flow reflows without losing state", async () => {
    await session.resize(60, 20);
    await session.waitForText("size: 60x20");
    await session.waitForText("count: 3");
  });

  session = await story.step("the process dies and a new one remembers", async () => {
    await session.kill();
    const revived = await session.respawn();
    await revived.waitForText("(restored)");
    await revived.waitForText("count: 3");
    return revived;
  });
  t.after(() => session.close());

  await story.step("still interactive after resurrection", async () => {
    await session.type("+");
    await session.waitForText("count: 4");
  });

  await story.step("quits cleanly and the disk agrees with the screen", async () => {
    await session.type("q");
    await session.waitForExit();
    assert.equal(await fsp.readFile(env.COUNTER_STATE, "utf8"), "4");
  });

  await story.end();

  // The storyline itself is an artifact; assert it exists and is complete.
  const stored = JSON.parse(
    await fsp.readFile(
      path.join(
        process.env.TUI_IT_REPORT_DIR ?? ".tui-report",
        "journeys",
        "counter-a-session-that-lives-breaks-and-returns.json",
      ),
      "utf8",
    ),
  );
  assert.equal(stored.steps.length, 8);
  assert.ok(stored.steps.every((step) => step.ok));
  assert.ok(stored.steps[5].screen.includes("(restored)"), "step screens capture the moment");
});
