# AI setup prompt

Copy everything in the block below into your AI coding agent (Claude Code,
Cursor, Codex, …) inside the repository of the TUI you want tested. It carries
the field-tested playbook, so the agent avoids the traps that cost us real
debugging time.

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
    "test:tui:report": "rm -rf .tui-report tui-report.html && node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=tui-integration-tests/reporter --test-reporter-destination=tui-report.html tests/tui/*.test.mjs"
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
  One launch helper that calls `launch(config, t)` from tui-integration-tests
  with the binary, cols/rows (120x40 is a good default), a scratch cwd, and
  the hermetic env. Passing the node:test context `t` makes every session —
  including ones from respawn() — clean itself up via t.after(). Add app-specific normalizers for anything that churns per run
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
