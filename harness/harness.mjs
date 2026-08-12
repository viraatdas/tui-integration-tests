// The framework layer: plug in your TUI binary, drive it with real keystrokes
// through a real PTY, and assert on what the user actually sees.
//
// microsoft/tui-test (pinned via pins.json) is the driver underneath: it owns
// the PTY and the terminal emulation. This module owns the parts a test suite
// needs on top:
//
//   * sessions that clean themselves up (no orphaned daemons after a red run)
//   * deterministic waiting — poll the screen for a condition, never sleep.
//     A fixed sleep is a flake with a timer attached: it fails on a loaded CI
//     box and wastes time everywhere else.
//   * normalization — TUIs print timestamps, ids, and spinners; snapshots must
//     not churn on every run
//   * respawn — kill the process and boot it again against the same state dir.
//     Restart bugs are invisible to in-process tests by construction, and they
//     are real: the bug that motivated this project passed 502 unit tests.
import { execFile, execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import { join as pathJoin } from "node:path";
import { promisify } from "node:util";
import { ensureDriver } from "./fetch-driver.mjs";

const run = promisify(execFile);

let driverPath = null;
let sessionCounter = 0;
const liveSessions = new Set();

// Whatever happens to the test process, do not leave driver daemons behind.
process.on("exit", () => {
  for (const session of liveSessions) {
    try {
      session.closeSync();
    } catch {
      // Exit handler: nothing sane to do with a failure here.
    }
  }
});

/** Normalizers applied by screen(): [pattern, replacement] pairs. */
export const defaultNormalizers = [
  // Long digit runs are ids/timestamps (epoch nanos, pids), never UI copy.
  [/\d{10,}/g, "<id>"],
  // Braille spinner glyphs advance on a timer; the frame is never the point.
  [/[⠀-⣿]/g, "<spin>"],
];

export class Session {
  constructor(config, testContext = null) {
    this.config = config;
    this.testContext = testContext;
    this.name = config.name ?? `tit-${process.pid}-${sessionCounter++}`;
    this.pid = null;
    this.recordingPath = null;
    this.normalizers = config.normalizers ?? defaultNormalizers;
  }

  async driver(args, opts = {}) {
    driverPath ??= await ensureDriver();
    const result = await run(driverPath, ["--session", this.name, ...args], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      ...opts,
    });
    return result.stdout;
  }

  async start() {
    const { binary, args = [], cols = 120, rows = 40, cwd, env = {} } = this.config;
    const envFlags = Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
    let out;
    try {
      out = await this.driver([
        "run",
        "--json",
        "--cols", String(cols),
        "--rows", String(rows),
        ...(cwd ? ["--cwd", cwd] : []),
        ...envFlags,
        binary,
        ...args,
      ]);
    } catch (error) {
      // The raw failure is "Command failed: <driver path + 10 args>", which
      // buries the only fact that matters. Name the binary; keep the driver's
      // stderr, which says why.
      const detail = (error?.stderr || error?.message || String(error)).trim();
      throw new Error(`failed to launch ${binary}: ${detail}`, { cause: error });
    }
    // The driver envelopes JSON as {ok, data:{...}}; tolerate bare objects
    // too, since that is what an earlier build emitted.
    const parsed = JSON.parse(out);
    const info = parsed?.data ?? parsed;
    this.pid = info.pid ?? null;
    // Every session is recorded as an asciinema cast by the driver; keep the
    // path so tests and reports can point at a rewatchable replay.
    this.recordingPath = info.recording ?? null;
    liveSessions.add(this);
    if (this.testContext?.after) {
      this.testContext.after(() => this.close());
    }
    return this;
  }

  async type(text) {
    // `--` guards text that starts with '-' (e.g. "-3", "--flag") from being
    // parsed as driver options.
    await this.driver(["type", "--", text]);
  }

  /** Named keys, driver syntax: press("Enter"), press("Ctrl+C"), press("Escape"). */
  async press(...keys) {
    await this.driver(["press", ...keys]);
  }

  /** Raw bytes straight down the PTY, for what named keys cannot say. */
  async write(bytes) {
    await this.driver(["write", bytes]);
  }

  async resize(cols, rows) {
    // Positional, unlike run's --cols/--rows: `tui-test resize <COLS> <ROWS>`.
    await this.driver(["resize", String(cols), String(rows)]);
  }

  /** The visible screen as text, normalized. Assert against this. */
  async screen() {
    let text = await this.driver(["text"]);
    for (const [pattern, replacement] of this.normalizers) {
      text = text.replace(pattern, replacement);
    }
    return text;
  }

  /** The window title (OSC 0/2), normalized like the screen. */
  /**
   * VISUAL layer. screen() reads only the characters, so a row rendered in
   * the wrong color, stripped of its bold, or drawn with a broken attribute
   * passes every text assertion. These expose the per-cell ATTRIBUTES the
   * driver already tracks (fg/bg hex, bold, italic, underline, inverse, dim),
   * so a test can assert what the user actually SEES, not just reads.
   */

  /** Raw cell attribute objects for a region (0-based x/y, w/h default 1). */
  async cells(x, y, w = 1, h = 1) {
    const out = await this.driver([
      "cells", "--json", String(x), String(y), String(w), String(h),
    ]);
    const parsed = JSON.parse(out);
    const cells = parsed?.data?.cells ?? parsed?.cells ?? parsed;
    return Array.isArray(cells) ? cells.flat() : [];
  }

  /** The single cell at (x, y): {char, fg, bg, bold, italic, ...}. */
  async cellAt(x, y) {
    const [cell] = await this.cells(x, y, 1, 1);
    return cell ?? null;
  }

  /**
   * The style of the first character of `text` on screen — the ergonomic
   * visual assertion. Returns the cell's attributes (fg/bg/bold/…) so a test
   * can say "the merged status is green" or "the header is bold" without
   * hunting coordinates. Returns null when the text is not visible.
   *
   * NOTE on color: `fg`/`bg` are a PALETTE INDEX (number) for 16/256-color
   * output — e.g. 1=red, 2=green, 4=blue — and a hex STRING ("#6b7280") for
   * 24-bit truecolor. Assert against whichever the app under test emits.
   */
  async styleAt(text, { occurrence = 0 } = {}) {
    const raw = await this.driver(["text"]); // un-normalized: coordinates must match
    const rows = raw.split("\n");
    let seen = -1;
    for (let y = 0; y < rows.length; y += 1) {
      let from = 0;
      for (;;) {
        const x = rows[y].indexOf(text, from);
        if (x < 0) break;
        seen += 1;
        if (seen === occurrence) return await this.cellAt(x, y);
        from = x + 1;
      }
    }
    return null;
  }

  /**
   * Write a full-color SVG screenshot to `outPath` (crisp at any zoom). The
   * report embeds these, so a visual regression is human-visible, not just a
   * diff of attribute JSON. `full: true` includes scrollback.
   */
  async screenshot(outPath, { full = false } = {}) {
    await this.driver(["screenshot", ...(full ? ["--full"] : []), outPath]);
    return outPath;
  }

  async title() {
    // `get` emits JSON ({"value": ...}); tolerate plain text if that changes.
    const raw = (await this.driver(["get", "title"])).trim();
    let text;
    try {
      text = String(JSON.parse(raw).value ?? "");
    } catch {
      text = raw;
    }
    for (const [pattern, replacement] of this.normalizers) {
      text = text.replace(pattern, replacement);
    }
    return text;
  }

  /**
   * Poll until predicate(screen) holds. THE waiting primitive — everything
   * else is sugar over it. On timeout the error carries the last screen, so a
   * red CI run shows what the user was looking at, not just "timed out".
   */
  /**
   * `stablePolls`: how many CONSECUTIVE polls must satisfy the predicate.
   * Presence waits default to 1 — text on screen is monotone enough. Absence
   * waits default to 3, because a repaint blanks the region for a frame and a
   * single poll landing in that gap reads as "gone": observed in the field,
   * where a deletion test green-lit a build in which deletion was provably
   * refused.
   */
  async waitFor(
    predicate,
    { timeout = 10_000, interval = 100, label = "condition", stablePolls = 1 } = {},
  ) {
    const deadline = Date.now() + timeout;
    let lastScreen = "";
    let streak = 0;
    for (;;) {
      lastScreen = await this.screen();
      streak = predicate(lastScreen) ? streak + 1 : 0;
      if (streak >= stablePolls) {
        return lastScreen;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out after ${timeout}ms waiting for ${label}\n--- last screen (${this.name}) ---\n${lastScreen}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  async waitForText(text, opts = {}) {
    return await this.waitFor((screen) => screen.includes(text), {
      ...opts,
      label: `text ${JSON.stringify(text)}`,
    });
  }

  /**
   * LATENCY. A frozen or sluggish TUI passes every content assertion — the
   * words are right, they just arrive too late. These measure how long the
   * app takes to REACT, so a test can hold a responsiveness budget.
   *
   * Run `action`, then poll (fast, no fixed sleep) until `predicate(screen)`
   * holds, and return the elapsed milliseconds. Throws if the budget is blown,
   * with the last screen — so a latency regression reads like any other
   * failure. Use a tight `interval` (default 10ms) to keep the measurement
   * from being dominated by the poll granularity.
   */
  async timeToScreen(action, predicate, { timeout = 10_000, interval = 10, label = "response" } = {}) {
    const start = Date.now();
    await action();
    const deadline = start + timeout;
    for (;;) {
      const screen = await this.screen();
      if (predicate(screen)) {
        return Date.now() - start;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `no ${label} within ${timeout}ms\n--- last screen (${this.name}) ---\n${screen}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  /** Milliseconds from a keystroke to `text` appearing — the keystroke-to-render budget. */
  async keystrokeLatency(text, keys, { timeout = 5_000 } = {}) {
    const send = Array.isArray(keys) ? keys : [keys];
    return await this.timeToScreen(
      async () => {
        for (const k of send) await this.press(k);
      },
      (screen) => screen.includes(text),
      { timeout, label: `text ${JSON.stringify(text)} after keystroke` },
    );
  }

  /**
   * VISUAL INTEGRITY — "nothing looks broken." A render can be structurally
   * corrupt while every text assertion still passes: raw escape bytes bleeding
   * into the grid, replacement glyphs from an encoding break, a box whose
   * border does not close, or a wholly blank frame from a failed paint. This
   * returns a list of detected problems (empty = clean); assertIntact() throws
   * on any. Heuristic by design — it catches gross corruption, not subtle
   * layout taste.
   */
  async visualIssues() {
    const raw = await this.driver(["text"]); // un-normalized: keep every byte
    const issues = [];
    const rows = raw.replace(/\n$/, "").split("\n");

    // 1. A live TUI is never wholly blank.
    if (rows.every((r) => r.trim() === "")) {
      issues.push("the screen is entirely blank");
    }
    // 2. Raw ESC / C0 control bytes must not survive into the cell text; the
    //    driver strips real styling, so a leftover means ANSI leaked as content.
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(raw)) {
      issues.push("raw control/escape bytes are present in the screen text");
    }
    // 3. Unicode replacement char = an encoding break (a multi-byte glyph
    //    rendered as garbage).
    if (raw.includes("�")) {
      issues.push("replacement character (�) present — an encoding break");
    }
    // 4. Box-drawing integrity: a row that OPENS a box border (┌ or └) must
    //    also close it (┐ or ┘) — a border that starts and never ends is a
    //    truncated/broken frame.
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i];
      const opensTop = r.includes("┌");
      const opensBot = r.includes("└");
      if (opensTop && !r.includes("┐")) {
        issues.push(`row ${i}: box top border opens (┌) but never closes (┐)`);
      }
      if (opensBot && !r.includes("┘")) {
        issues.push(`row ${i}: box bottom border opens (└) but never closes (┘)`);
      }
    }
    return issues;
  }

  /** Throw if the screen shows structural corruption. See visualIssues(). */
  async assertIntact() {
    const issues = await this.visualIssues();
    if (issues.length) {
      const screen = await this.screen();
      throw new Error(
        `screen is not visually intact:\n  - ${issues.join("\n  - ")}\n--- screen (${this.name}) ---\n${screen}`,
      );
    }
  }

  /** Wait until text is ABSENT — for asserting something went away. */
  async waitForGone(text, opts = {}) {
    return await this.waitFor((screen) => !screen.includes(text), {
      stablePolls: 3,
      ...opts,
      label: `disappearance of ${JSON.stringify(text)}`,
    });
  }

  /** Wait for the child process to exit on its own (e.g. after a quit key). */
  async waitForExit({ timeout = 10_000 } = {}) {
    try {
      await this.driver(["wait", "exit", "--timeout", String(timeout)]);
    } catch (error) {
      const lastScreen = await this.screen().catch(() => "(screen unavailable)");
      throw new Error(
        `process did not exit within ${timeout}ms\n--- last screen (${this.name}) ---\n${lastScreen}`,
        { cause: error },
      );
    }
  }

  /** Kill the child process. The session (and its screen) remains inspectable. */
  async kill() {
    await this.driver(["kill"]);
  }

  /**
   * Boot the same binary/config again as a NEW session. State on disk is
   * whatever the previous life left behind — which is the point: this is how
   * you test that a restart derives its state honestly.
   */
  async respawn() {
    await this.close();
    // The new session inherits the test context, so auto-cleanup follows the
    // story across process death — no re-registering, no leaked sessions.
    const next = new Session({ ...this.config, name: undefined }, this.testContext);
    return await next.start();
  }

  async close() {
    liveSessions.delete(this);
    // Capture the final screen for the report before tearing the session down.
    // Test files run in child processes while the reporter runs in the parent,
    // so the handoff goes through disk: one small text file per session under
    // .tui-report/screens (override with TUI_IT_REPORT_DIR). Best-effort — a
    // failed capture must never fail a green test.
    try {
      const reportDir = process.env.TUI_IT_REPORT_DIR ?? ".tui-report";
      const screensDir = pathJoin(reportDir, "screens");
      await fsp.mkdir(screensDir, { recursive: true });
      const screen = await this.screen();
      const header = `session: ${this.name}\nbinary: ${this.config.binary} ${(this.config.args ?? []).join(" ")}\n---\n`;
      await fsp.writeFile(pathJoin(screensDir, `${this.name}.txt`), header + screen);
      // Also a full-color SVG, so the report shows the pixels, not just the
      // characters — a visual regression is then visible at a glance.
      await this.screenshot(pathJoin(screensDir, `${this.name}.svg`)).catch(() => {});
    } catch {
      // No screen to capture (already dead) or nowhere to write it: fine.
    }
    try {
      await this.driver(["close"]);
    } catch {
      // Already closed or the daemon is gone: both fine — close is cleanup,
      // not an assertion.
    }
  }

  closeSync() {
    // exit-handler path; best-effort and synchronous by necessity.
    if (!driverPath) return;
    execFileSync(driverPath, ["--session", this.name, "close"], { stdio: "ignore" });
  }
}

/**
 * A JOURNEY: a named multi-step user sequence — the "open it, do the thing,
 * change your mind, restart, finish" flows where TUIs actually break. Each
 * step is checkpointed with the screen as it looked when the step finished
 * (or failed), and the whole storyline lands in the HTML report, so a red
 * journey reads like a bug report a human wrote: which step, what the user
 * saw.
 *
 *   const j = journey(session, "first-run experience");
 *   await j.step("boots to the empty state", () => session.waitForText("no items"));
 *   await j.step("adding an item shows it", async () => {
 *     await session.type("a"); await session.waitForText("1 item");
 *   });
 *   session = await j.step("survives a restart", async () => {
 *     await session.kill();
 *     const revived = await session.respawn();
 *     await revived.waitForText("1 item");
 *     return revived;                    // steps may hand back a new session
 *   });
 *   await j.end();
 *
 * A failing step records the failure screen, flushes the storyline, and
 * rethrows — the test goes red AND the report keeps the narrative.
 */
export function journey(session, name) {
  const steps = [];
  let current = session;
  const flush = async () => {
    try {
      const reportDir = process.env.TUI_IT_REPORT_DIR ?? ".tui-report";
      const dir = pathJoin(reportDir, "journeys");
      await fsp.mkdir(dir, { recursive: true });
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      await fsp.writeFile(
        pathJoin(dir, `${slug || "journey"}.json`),
        JSON.stringify({ name, steps }, null, 2),
      );
    } catch {
      // The storyline is evidence, not an assertion; never fail a test over it.
    }
  };
  return {
    async step(label, fn) {
      try {
        const result = await fn();
        if (result instanceof Session) {
          current = result;
        }
        steps.push({ label, ok: true, screen: await current.screen().catch(() => "") });
        return result;
      } catch (error) {
        steps.push({
          label,
          ok: false,
          screen: await current.screen().catch(() => String(error?.message ?? error)),
        });
        await flush();
        throw error;
      }
    },
    async end() {
      await flush();
    },
  };
}

/**
 * Launch a TUI under test.
 *
 * launch(config, t) — pass the node:test context and the session cleans
 * itself up via t.after(); respawn() carries it across process death.
 *
 * launch({
 *   binary: "./target/debug/my-tui",  // or "node", with args: ["app.mjs"]
 *   args: [],
 *   cols: 120, rows: 40,
 *   cwd: "/tmp/scratch-repo",
 *   env: { MY_APP_STATE: "/tmp/state" },
 *   normalizers: defaultNormalizers,  // or your own [pattern, replacement][]
 * })
 */
export async function launch(config, testContext = null) {
  return await new Session(config, testContext).start();
}
