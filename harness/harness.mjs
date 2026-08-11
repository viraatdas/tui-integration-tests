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
  constructor(config) {
    this.config = config;
    this.name = config.name ?? `tit-${process.pid}-${sessionCounter++}`;
    this.pid = null;
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
    const out = await this.driver([
      "run",
      "--json",
      "--cols", String(cols),
      "--rows", String(rows),
      ...(cwd ? ["--cwd", cwd] : []),
      ...envFlags,
      binary,
      ...args,
    ]);
    this.pid = JSON.parse(out).pid ?? null;
    liveSessions.add(this);
    return this;
  }

  async type(text) {
    await this.driver(["type", text]);
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
    await this.driver(["wait", "exit", "--timeout", String(timeout)]);
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
    const next = new Session({ ...this.config, name: undefined });
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
 * Launch a TUI under test.
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
export async function launch(config) {
  return await new Session(config).start();
}
