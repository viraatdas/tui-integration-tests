// Proof against a famous TUI nobody here wrote: vim. It ships preinstalled on
// macOS, Linux, and both GitHub CI runners, so this example costs you zero
// setup — and if the framework can drive vim's modal editing through a real
// PTY, it can drive your app.
//
// `-u NONE -i NONE -N` = no vimrc, no viminfo, nocompatible: vim behaves
// identically on every machine, which is what makes screen tests portable.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { launch } from "../harness/harness.mjs";

function vimAvailable() {
  try {
    execFileSync("vim", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const haveVim = vimAvailable();

async function launchVim(t, file) {
  const session = await launch({
    binary: "vim",
    args: ["-u", "NONE", "-i", "NONE", "-N", file],
    cols: 80,
    rows: 24,
    env: { TERM: "xterm-256color" },
  });
  t.after(() => session.close());
  return session;
}

test("vim: insert mode, type text, :wq writes it to disk", { skip: !haveVim }, async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tit-vim-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "note.txt");

  const session = await launchVim(t, file);
  // A fresh buffer shows the tilde column; that is vim on screen.
  await session.waitForText("~");

  await session.press("i");
  await session.waitForText("-- INSERT --");
  await session.type("hello from a real PTY");
  await session.waitForText("hello from a real PTY");

  await session.press("Escape");
  await session.waitForGone("-- INSERT --");
  await session.type(":wq");
  await session.press("Enter");
  await session.waitForExit();

  // The screen said it; the disk must agree.
  assert.equal(await fsp.readFile(file, "utf8"), "hello from a real PTY\n");
});

test("vim: search finds a line, dd deletes it, the file agrees", { skip: !haveVim }, async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tit-vim-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "list.txt");
  await fsp.writeFile(file, "alpha\nbravo\ncharlie\n");

  const session = await launchVim(t, file);
  await session.waitForText("charlie");

  await session.type("/bravo");
  await session.press("Enter");
  await session.type("dd");
  await session.waitForGone("bravo");

  await session.type(":wq");
  await session.press("Enter");
  await session.waitForExit();

  assert.equal(await fsp.readFile(file, "utf8"), "alpha\ncharlie\n");
});
