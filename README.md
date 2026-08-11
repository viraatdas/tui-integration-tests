# tui-integration-tests

Screen-level integration tests for any terminal UI. Plug in your binary, send
real keystrokes through a real PTY, and assert on **what the user actually
sees** — not on what your structs claim.

Precisely what it does:

- **spawns your real compiled binary** inside a real PTY session — any
  language, nothing simulated in-process
- **types real keystroke bytes** (`type("text")`, `press("Enter")`,
  `press("Ctrl+C")`) — the app cannot tell it isn't a human at a terminal
- **reads the emulated screen** (Alacritty engine, real terminfo) and **polls
  it for assertions** — `waitForText`, `waitFor(predicate)`; there is no
  `sleep()` in the API, and every timeout error embeds the final screen
- **kills and respawns the process** against the same on-disk state, so
  restart bugs — invisible to every in-process test — are testable
- **runs multi-turn journeys**: named user stories of many steps (mutate,
  resize mid-flow, die, return, verify memory, quit), each step checkpointed
  with its screen
- **writes an HTML report** (`tui-report.html`): results, every failure with
  the screen the user was looking at, journey storylines, session gallery
- driver auto-fetched once, **sha256-pinned**; macOS/Linux; Node ≥ 20

## Use it from Claude Code (plugin — fastest)

```
/plugin marketplace add viraatdas/tui-integration-tests
/plugin install tui-tests@tui-integration-tests
```

Then, in your TUI's repo, say **"add screen-level tests for this TUI"** or
**"debug this failing tui test"**. The `tui-tests` skill sets everything up —
install, hermetic switches, four smoke tests, one real journey, the report —
following the field-tested rules below. (~140 tokens always-on; verified
end to end: marketplace add → install → skill loads.) Other agents — Cursor,
Codex — use the [prompt block](#fastest-path-paste-this-into-your-ai) instead.

## The API in one glance

```js
import { launch } from "tui-integration-tests";

const session = await launch({
  binary: "./target/release/my-tui",
  cols: 120, rows: 40,
  cwd: scratchRepo,
  env: { MY_APP_OFFLINE: "1" },
});

await session.type("add a task");
await session.press("Enter");
await session.waitForText("task created");   // polls the screen; never sleeps

await session.kill();
const revived = await session.respawn();     // same state dir, new process
await revived.waitForText("task created");   // restart derived state honestly
```

## Why this exists

Unit tests for TUIs overwhelmingly assert on internal state: `app.notice`
contains the right words, `app.rows.len()` is 3. A suite like that can be
entirely green while the actual screen is wrong, the actual keybinding is
dead, or the app panics on resize. The bug that motivated this project — state
collapsing after a process restart — sailed through **502 passing unit tests**,
because not one of them ever restarted the process.

Three ideas fix that class of failure:

1. **Assert on the screen.** The PTY output is the contract with the user.
2. **Poll, never sleep.** A fixed `sleep 2` is a flake with a timer attached.
   Every wait here polls the screen for a condition and fails loudly — with
   the final screen contents in the error — on timeout.
3. **Restart is a feature; test it.** `kill()` + `respawn()` boots a fresh
   process against the same on-disk state. If your app derives state at
   startup, this is the only kind of test that exercises that path.

## What actually happens when a test runs

```
your test (node:test)
  └─ launch()                 spawns YOUR binary inside a fresh PTY session
       └─ tui-test daemon     owns the PTY + emulation (Alacritty engine)
            └─ your app       runs exactly as it does for a user
  type()/press()              real keystroke bytes down the PTY
  screen()/waitForText()      polls the EMULATED SCREEN until the condition holds
  close()                     snapshots the final screen, tears the session down
```

First run only: the pinned driver binary (~3 MB) is downloaded from the
microsoft/tui-test release, its sha256 verified against `pins.json`, and
cached in `.tui-test-cache/`. Nothing else is installed, nothing runs at
import time, and no test ever talks to the network.

## How it works

[microsoft/tui-test](https://github.com/microsoft/tui-test) is the driver
underneath: a Rust CLI that owns the PTY and terminal emulation (Alacritty's
engine — real terminfo, real wide-glyph handling, not a toy parser). This
project is the **test framework on top** of it:

| layer | owns |
|---|---|
| tui-test (pinned) | PTY, emulation, keys/mouse, screen text, window title |
| this project | sessions + cleanup, deterministic waiting, normalization, respawn, checksummed installs, CI recipe |

**Is the driver a good bet?** Assessed by use, not by stars: it drove a Rust
ratatui dashboard, vim, and the bundled demo through real PTYs on two OSes
with zero emulation bugs; its quirks (a beta CLI, evolving flags) are
absorbed here. It exposes ~27 subcommands; this framework uses **10** of
them — the monitor/recording/agent extras are inert for testing. If the
project ever goes sideways, the exposure is one file (`harness/harness.mjs`,
~250 lines): every driver call goes through it, so swapping drivers is a
rewrite of that file, not of anyone's tests.

The driver version is pinned in [`pins.json`](pins.json) with a sha256 for
every platform artifact. `npm run fetch-driver` downloads and **verifies**
the binary before it will run — never `curl | sh`.

## Quickstart

Requires Node ≥ 20 and `tar` (macOS/Linux; Windows is on the roadmap).

```sh
git clone https://github.com/viraatdas/tui-integration-tests
cd tui-integration-tests
npm test        # fetches the pinned driver, then drives the bundled demo TUI
```

The suite in [`tests/demo.test.mjs`](tests/demo.test.mjs) runs against
[`examples/counter-demo`](examples/counter-demo/counter.mjs), a ~90-line TUI
bundled precisely so the framework can prove itself in CI. Six tests, ~2s
total: keystrokes, resize, kill/respawn persistence, disappearance, custom
normalizers, window title.

## Proof on a TUI nobody here wrote: vim

[`tests/vim.test.mjs`](tests/vim.test.mjs) drives **real vim** — preinstalled
on macOS, Linux, and both GitHub CI runners, so it demonstrates the framework
against a famous third-party binary with zero setup:

```js
const session = await launch({ binary: "vim", args: ["-u", "NONE", "-i", "NONE", "-N", file] });
await session.press("i");                          // modal editing, for real
await session.waitForText("-- INSERT --");
await session.type("hello from a real PTY");
await session.press("Escape");
await session.type(":wq"); await session.press("Enter");
await session.waitForExit();
assert.equal(await fsp.readFile(file, "utf8"), "hello from a real PTY\n");
```

Insert mode, `/search`, `dd`, `:wq` — asserted on the screen *and* on disk,
in under a second. If it can drive vim's modal editing, it can drive your app.
The point of the flags: `-u NONE -i NONE -N` makes vim identical on every
machine, which is exactly the determinism your own app's tests need (state in
a fixed dir, no user config, no network).

## Fastest path: paste this into your AI

Copy the block below into your AI coding agent (Claude Code, Cursor, Codex,
…) inside your TUI's repository. The agent installs the package, makes your
app hermetic-testable, writes the first four screen-level tests, and wires up
the HTML report — following field-tested rules so it does not re-hit the traps
(ambiguous waits, repaint races, focus drift, sleep-based flakiness). Also
available as [`SETUP_PROMPT.md`](SETUP_PROMPT.md).

````text
Set up screen-level integration tests for the terminal (TUI) application in
this repository, using the `tui-integration-tests` npm package. These tests
boot the real compiled binary in a real PTY, send real keystroke bytes, and
assert on the visible screen — the driver underneath (microsoft/tui-test,
Alacritty-based emulation) is fetched automatically, pinned and
checksum-verified. macOS/Linux, Node >= 20.

STEP 1 — install and wire scripts
  npm i -D tui-integration-tests
  Add to package.json scripts:
    "test:tui": "node --test tests/tui/*.test.mjs"
    "test:tui:report": "node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=tui-integration-tests/reporter --test-reporter-destination=tui-report.html tests/tui/*.test.mjs"
  Add `tui-report.html` and `.tui-report/` to .gitignore.

STEP 2 — find the binary and make the app hermetic
  Identify how this repo builds/runs its TUI (a compiled binary, or an
  interpreter + entry script). Then find or add the switches tests need:
  - state in a settable directory (env var), so tests never touch real state
  - an offline/no-network switch, so no update banner repaints mid-assert
  - env overrides for any external binaries the app shells out to, so tests
    point them at fake scripts instead of real services
  If a switch is missing, add it — it is a small change and every test needs it.

STEP 3 — write tests/tui/helpers.mjs
  One launch helper that calls `launch()` from tui-integration-tests with the
  binary, cols/rows (120x40 is a good default), a scratch cwd, and the
  hermetic env. Add app-specific normalizers for anything that churns per run
  (ids, timestamps); the defaults already scrub long digit runs and spinner
  glyphs.

STEP 4 — write the first tests (tests/tui/smoke.test.mjs), in this order
  1. boot: launch, waitForText for something only the real UI renders
  2. interaction: send a keystroke, assert the screen changed
  3. restart (if the app persists state): kill(), respawn(), assert state
     came back — restart bugs are invisible to every in-process test
  4. resize(60, 20): app survives, still responds to input
  Run with `npm run test:tui`. Every timeout error embeds the final screen —
  read it, fix the assertion or the fixture, re-run. Do not guess.

STEP 5 — then write one real JOURNEY (import { journey } from the package):
  a continuous multi-turn story of 6-10 steps — mutate state, change course,
  resize mid-flow, kill() + respawn(), verify memory, quit cleanly — each
  step checkpointed with its screen via journey(session, name).step(...).
  The HTML report renders the storyline step by step; failing steps keep
  their narrative. Multi-turn flows are where TUIs actually break.

RULES (each one bought with real debugging time)
  - Poll, never sleep. waitForText/waitFor poll the screen; a fixed sleep is
    a flake with a timer attached.
  - Wait on UNAMBIGUOUS text: the exact affordance or notice, not a word
    that also appears in help text or legends ("done" matched "Done when:").
  - Prefer POSITIVE post-state asserts over absence: waitForGone can race a
    repaint (it defends itself with 3 consecutive polls, but "the empty-state
    placeholder appeared" is stronger than "the row text vanished").
  - Focus is part of the flow: after some commands apps move focus between
    panes, and keystrokes typed blind land in the wrong widget. Drive focus
    with the app's own keys.
  - If the app shows a transient "working on it… press X again" notice,
    follow its instructions in a bounded loop; slow CI runners hit states a
    fast dev machine never renders.
  - realpath scratch dirs (macOS /var -> /private/var breaks path-keyed
    fixtures); retry scratch-dir cleanup (apps flush state async; ENOTEMPTY).
  - Where the screen could lie, also assert on disk (the file the merge
    should have produced, the state the restart should have restored).

DEFINITION OF DONE
  - `npm run test:tui` green locally, at least the 4 smoke tests
  - each test verified honest: break the feature it guards, watch it go red,
    restore it, watch it go green — a test never seen red proves nothing
  - `npm run test:tui:report` writes tui-report.html (results + the final
    screen of every session; failures embed the screen the user was looking
    at)
  - wire test:tui into CI; upload tui-report.html as an artifact with
    if: always() so red runs keep their evidence
````

## Journeys: multi-turn stories, told step by step

Real TUI assessment is not "does one key work" — it is a session that lives,
changes its mind, resizes, dies, comes back, and still holds together.
`journey()` makes that first-class: name a story, checkpoint each step, and
the report renders the storyline with the screen at every step (failing steps
keep their narrative). The bundled
[`tests/journey.test.mjs`](tests/journey.test.mjs) runs an 8-step story —
increment, reset, resize mid-flow, kill, respawn with memory, quit — in ~0.5s.

## Every run can produce a report

```sh
npm run test:tui:report        # or see SETUP_PROMPT.md for the raw command
```

writes **`tui-report.html`**: pass/fail table with timings, every failure with
the final screen the user was looking at, and a gallery of each session's last
screen. Self-contained HTML — attach it to a PR, upload it as a CI artifact
(`if: always()`, so red runs keep their evidence), or just open it.

## Using it in your own project

```sh
npm install --save-dev tui-integration-tests
```

(Or pin straight to a git commit if you prefer:
`npm i -D "tui-integration-tests@github:viraatdas/tui-integration-tests#<commit>"`.)

Add a script and a test directory:

```jsonc
// package.json
"scripts": {
  "test:tui": "node --test tests/tui/*.test.mjs"
}
```

That is the entire integration. This is not hypothetical:
[rudder's `tests/tui/`](https://github.com/viraatdas/rudder/tree/main/tests/tui)
consumes exactly this way — six end-to-end tests driving a Rust ratatui
dashboard (spawn workers, kill and respawn the process, merge-gate keystrokes)
in ~7 seconds, with zero changes needed in this framework. Use its
`helpers.mjs` as the template for your own fixture glue.

1. Write a test file next to your project (or in this repo's `tests/`):

```js
import test from "node:test";
import { launch } from "tui-integration-tests";

test("worker row appears", async (t) => {
  const session = await launch({
    binary: "/path/to/your-tui",       // or process.execPath + args for node apps
    cols: 120, rows: 40,
    cwd: freshScratchDir,              // never your real working tree
    env: { YOUR_APP_HOME: tmpDir },    // isolate state; fake your backends
  });
  t.after(() => session.close());

  await session.type("do the thing");
  await session.press("Enter");
  await session.waitForText("thing started");
});
```

2. Make your app testable — the checklist that mattered in practice:
   - **an offline/no-network switch**, so no update banner repaints mid-assert
   - **injectable external binaries** (env vars pointing at fake scripts), so
     tests never hit real APIs
   - **state in a settable directory**, so `respawn()` tests mean something

3. Normalize what churns. IDs, timestamps and spinners will differ per run:

```js
session.normalizers = [
  [/\d{10,}/g, "<id>"],        // epoch timestamps, pids   (default)
  [/[⠀-⣿]/g, "<spin>"],        // braille spinner frames   (default)
  [/run-[a-f0-9]{8}/g, "<run>"], // yours
];
```

## Lessons from the first real consumer

Wiring a production dashboard into this framework surfaced four traps worth
knowing before you hit them. Each was diagnosed from the screen embedded in a
timeout error — which is the debugging loop working as designed:

- **`realpath` your scratch dirs.** macOS tmpdirs live behind the
  `/var → /private/var` symlink, and apps often canonicalize their cwd.
  Fixtures keyed on the uncanonicalized spelling silently miss.
- **Wait on unambiguous text.** Waiting for `"done"` matched a `"Done when:"`
  help sentence while the app was still running, so the next keystroke fired
  too early. Wait for the exact affordance (`"press m to read the diff"`),
  not a word that appears in prose.
- **Focus is part of the flow.** After some commands, the app moves focus to
  another pane — keystrokes typed "blind" become input to the wrong widget.
  Drive focus the way a user does (the app's own pane-switch keys), and
  assert on the result.
- **Absence is repaint-racy; the API now defends it.** A full-screen redraw
  blanks a region for a frame, and a single poll landing in the gap reads as
  "the text is gone" — one deletion test green-lit a build where deletion was
  provably refused. `waitForGone` therefore requires 3 consecutive absent
  polls (tunable via `stablePolls`). Prefer a positive post-state assert when
  one exists ("empty-list placeholder returned" beats "row text vanished").
- **Retry cleanup, don't assert it.** An app's children can still be flushing
  state files while `rm -rf` walks the tree (`ENOTEMPTY`). Deleting a scratch
  dir is cleanup; give it a few retries instead of failing a green test.

## API

| method | what it does |
|---|---|
| `launch({binary, args, cols, rows, cwd, env, normalizers})` | boot the TUI in a fresh PTY session |
| `type(text)` / `press(...keys)` / `write(bytes)` | real input; `press("Ctrl+C")`, `press("Escape")` |
| `screen()` | visible screen as text, normalized |
| `waitForText(text)` / `waitForGone(text)` / `waitFor(fn)` | poll until the condition holds; timeout errors include the last screen |
| `resize(cols, rows)` | resize the PTY and emulator |
| `title()` | window title (OSC 0/2) |
| `kill()` / `respawn()` / `waitForExit()` | process lifecycle; respawn reuses the config against whatever is on disk |
| `close()` | tear down the session (also runs on process exit) |

One rule above all: **there is no `sleep()` in this API, on purpose.**

## CI

This repo's own workflow ([`.github/workflows/ci.yml`](.github/workflows/ci.yml))
runs the self-test suite on Ubuntu + macOS, with the driver cached by a key
that includes `pins.json` (a pin bump is automatically a cache miss) and the
checksum verified on every fresh fetch.

In **your** project's CI, no special setup is needed beyond your binary:

```yaml
- run: npm ci                 # installs the framework from the git pin
- run: cargo build --release  # or however your TUI is built
- run: npm run test:tui
  env:
    MY_TUI_BIN: target/release/my-tui   # however your tests resolve the binary
```

The framework fetches its pinned driver on first use, checksum-verified.
GitHub's `download-artifact` drops the execute bit — `chmod +x` prebuilt
binaries before pointing tests at them.

## Roadmap

- Windows driver extraction (artifacts are already pinned in `pins.json`)
- TERM matrix runs (`xterm-256color` / `screen-256color` / `xterm-ghostty`)
- output-byte invariants (alt-screen balanced, no stray CSI) as built-in checks
- cell-attribute assertions (color/bold) via the driver's `cells` command

## License

MIT
