// The reporter's own proof: run a scratch suite (one pass, one fail whose
// error embeds a screen, the way harness timeouts do) through `node --test`
// with the HTML reporter, then assert on the report it wrote.
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
const reporter = path.resolve(here, "../harness/reporter.mjs");

test("the HTML report carries results and the failure's screen", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tit-reporter-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  await fsp.writeFile(
    path.join(dir, "scratch.test.mjs"),
    `import test from "node:test";
test("a passing thing", () => {});
test("a failing thing", () => {
  throw new Error("timed out waiting for text \\"gone\\"\\n--- last screen (fake) ---\\n| the screen the user saw |");
});
`,
  );

  const report = path.join(dir, "report.html");
  // Strip the parent runner's context: a nested `node --test` that inherits
  // NODE_TEST_CONTEXT acts as a subtest and ignores its own reporter flags.
  const env = { ...process.env, TUI_IT_REPORT_DIR: path.join(dir, ".tui-report") };
  delete env.NODE_TEST_CONTEXT;
  await run(
    process.execPath,
    ["--test", `--test-reporter=${reporter}`, `--test-reporter-destination=${report}`, "scratch.test.mjs"],
    { cwd: dir, env },
  ).catch(() => {
    // node --test exits non-zero when a test fails; the report must exist anyway.
  });

  const html = await fsp.readFile(report, "utf8");
  assert.ok(html.includes("a passing thing"), "pass row present");
  assert.ok(html.includes("a failing thing"), "fail row present");
  assert.ok(html.includes("1 failed"), "summary counts the failure");
  assert.ok(
    html.includes("the screen the user saw"),
    "the failure section embeds the screen from the error",
  );
});
