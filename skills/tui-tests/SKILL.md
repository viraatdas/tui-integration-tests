---
name: tui-tests
description: Set up or extend screen-level integration tests for a terminal (TUI) application using the tui-integration-tests npm package, or debug a failing TUI test from its embedded screen dump. Use when the user asks to test a TUI end-to-end, simulate keystrokes against their terminal app, add screen-level/e2e tests for a CLI dashboard, or investigate a failing tui test.
---

# Screen-level TUI integration tests

These tests boot the user's real compiled binary in a real PTY, send real
keystroke bytes, and assert on the visible screen. The driver underneath
(microsoft/tui-test, Alacritty-based emulation) is fetched automatically,
pinned and checksum-verified. macOS/Linux, Node >= 20.

## Setting up in a repo that has none

1. `npm i -D tui-integration-tests`, then add scripts:
   - `"test:tui": "node --test tests/tui/*.test.mjs"`
   - `"test:tui:report": "rm -rf .tui-report tui-report.html && node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=tui-integration-tests/reporter --test-reporter-destination=tui-report.html tests/tui/*.test.mjs"`
   - add `tui-report.html` and `.tui-report/` to .gitignore
2. Find how this repo builds/runs its TUI. Make the app hermetic-testable —
   add these switches if missing (they are small changes and every test needs
   them): state in a settable directory (env var); an offline/no-network
   switch; env overrides for external binaries the app shells out to, so
   tests point them at fake scripts.
3. Write `tests/tui/helpers.mjs`: one launch helper calling `launch()` from
   `tui-integration-tests` with the binary, cols/rows (120x40 default), a
   scratch cwd (ALWAYS `fsp.realpath` it — macOS /var vs /private/var breaks
   path-keyed fixtures), and the hermetic env. Add normalizers for anything
   that churns per run; defaults already scrub long digit runs and spinner
   glyphs.
4. Write the first tests in this order: boot (waitForText for something only
   the real UI renders) → keystroke changes the screen → restart if the app
   persists state (`kill()`, `respawn()`, assert state came back — restart
   bugs are invisible to in-process tests) → `resize(60, 20)` survives and
   stays interactive.

## Journeys: the shape real assessment takes

Structure meaningful tests as JOURNEYS — one continuous multi-turn user story
(mutate state, change your mind, resize mid-flow, kill and respawn, verify
memory, quit) with every step checkpointed:

    const story = journey(session, "first-run: create, restart, verify");
    await story.step("boots empty", () => session.waitForText("no items"));
    session = await story.step("survives restart", async () => {
      await session.kill();
      const revived = await session.respawn();
      await revived.waitForText("1 item");
      return revived;                  // steps may hand back a new session
    });
    await story.end();

Each step records the screen as it looked when the step finished (or failed);
the HTML report tells the storyline step by step. A failing step flushes the
story before rethrowing, so red runs keep their narrative. Prefer one journey
of 6-10 steps over ten disconnected one-key tests: multi-turn flows are where
TUIs actually break (focus drift, stale state after restart, transient
notices).

## API essentials

`launch(config, t)` (pass the node:test context; sessions auto-clean via
t.after(), including after respawn()) → Session with
`type/press/write`, `screen()`, `waitForText/waitForGone/waitFor`,
`resize`, `title()`, `kill/respawn/waitForExit`, `close()`. There is
deliberately no sleep in the API: every wait polls the screen and timeout
errors embed the final screen.

## Rules (each bought with real debugging time)

- Poll, never sleep. A fixed sleep is a flake with a timer attached.
- Wait on UNAMBIGUOUS text — the exact affordance/notice, never a word that
  also appears in help text or legends ("done" matched "Done when:";
  "merged" matched a "clear merged" legend).
- Prefer POSITIVE post-state asserts over absence. `waitForGone` defends
  itself with 3 consecutive polls, but "the empty-state placeholder
  appeared" is stronger than "the row text vanished" (a repaint blanks
  regions for a frame).
- Focus is part of the flow: apps move focus between panes after commands;
  keystrokes typed blind land in the wrong widget. Drive focus with the
  app's own keys.
- If the app shows a transient "working… press X again" notice, follow its
  instruction in a bounded loop — slow CI runners render states a fast dev
  machine never shows.
- Where the screen could lie, also assert on disk (the file a merge should
  have produced; the state a restart should have restored).
- Retry scratch-dir cleanup (apps flush state async; ENOTEMPTY is normal).

## Debugging a failing test

Read the screen embedded in the timeout error first — it shows exactly what
the app displayed when the wait gave up. Typical causes, in order: the wait
text was ambiguous or transient; focus was in a different pane than assumed;
an async probe/notice needed another keypress; the fixture path was not
realpath'd. Do not add sleeps; fix the wait or the fixture.

## Definition of done

- `npm run test:tui` green; each test verified HONEST: break the feature it
  guards, watch red, restore, watch green. A test never seen red proves
  nothing.
- `npm run test:tui:report` writes tui-report.html (results + every
  failure's final screen + a gallery of session screens).
- CI runs the suite and uploads tui-report.html with `if: always()` so red
  runs keep their evidence.
