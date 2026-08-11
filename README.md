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

## Plugging in your TUI

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

See [`.github/workflows/ci.yml`](.github/workflows/ci.yml): Ubuntu + macOS,
driver cached by a key that includes `pins.json` (a pin bump is automatically
a cache miss), checksum verified on every fresh fetch.

## Roadmap

- npm publish, so `npm i -D tui-integration-tests` works without cloning
- Windows driver extraction (artifacts are already pinned in `pins.json`)
- TERM matrix runs (`xterm-256color` / `screen-256color` / `xterm-ghostty`)
- output-byte invariants (alt-screen balanced, no stray CSI) as built-in checks
- cell-attribute assertions (color/bold) via the driver's `cells` command

## License

MIT
