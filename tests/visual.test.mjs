// VISUAL coverage: screen() reads characters, so a color/style regression is
// invisible to it. These assert on cell ATTRIBUTES — what the user actually
// sees. The counter demo color-codes its value (green up, red down); a test
// that only read the text "count: 3" would never notice if the green broke.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { launch } from "../harness/harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const demo = path.resolve(here, "../examples/counter-demo/counter.mjs");

test("styleAt reads the color of on-screen text", async (t) => {
  const session = await launch({ binary: process.execPath, args: [demo], cols: 60, rows: 20 }, t);
  await session.waitForText("count: 0");

  // At zero the value is plain (no state color).
  await session.type("+++");
  await session.waitForText("count: 3");
  const positive = await session.styleAt("3");
  assert.ok(positive, "found the value cell");
  // 16-color ANSI green is palette index 2 (see styleAt docs on fg encoding).
  assert.equal(positive.fg, 2, "a positive count renders green");
  assert.equal(positive.char, "3");

  // Going negative flips the color — a purely visual state change.
  await session.type("------");
  await session.waitForText("count: -3");
  const negative = await session.styleAt("-3");
  assert.ok(negative, "found the negative value cell");
  assert.equal(negative.fg, 1, "a negative count renders red");
  assert.notEqual(negative.fg, positive.fg, "the state color actually changed");
});

test("cellAt exposes raw per-cell attributes", async (t) => {
  const session = await launch({ binary: process.execPath, args: [demo], cols: 60, rows: 20 }, t);
  await session.waitForText("counter-demo");
  const cell = await session.cellAt(0, 0);
  assert.ok(cell, "a cell exists at the origin");
  assert.ok("fg" in cell && "bold" in cell && "char" in cell, "attributes are present");
});
