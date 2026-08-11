# tui-integration-tests

Screen-level integration tests for any terminal UI. Plug in your binary, send
real keystrokes through a real PTY, and assert on **what the user actually
sees** — not on what your structs claim.

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

## How it works

[microsoft/tui-test](https://github.com/microsoft/tui-test) is the driver
underneath: a Rust CLI that owns the PTY and terminal emulation (Alacritty's
engine — real terminfo, real wide-glyph handling, not a toy parser). This
project is the **test framework on top** of it:

| layer | owns |
|---|---|
| tui-test (pinned) | PTY, emulation, keys/mouse, screen text, window title |
| this project | sessions + cleanup, deterministic waiting, normalization, respawn, checksummed installs, CI recipe |

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
