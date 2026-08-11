// counter-demo: the smallest TUI that still exercises everything the harness
// tests for — alt screen, raw keys, live redraw, resize handling, clean exit,
// and STATE THAT SURVIVES A RESTART (persisted to $COUNTER_STATE), so the
// kill-and-respawn test has something real to assert.
//
// Keys:  +/-  change the counter     r  reset to 0     q / Ctrl+C  quit
import fs from "node:fs";

const stateFile = process.env.COUNTER_STATE;

function loadCount() {
  if (!stateFile) return 0;
  try {
    const raw = fs.readFileSync(stateFile, "utf8").trim();
    return Number.parseInt(raw, 10) || 0;
  } catch {
    return 0;
  }
}

function saveCount(value) {
  if (!stateFile) return;
  fs.writeFileSync(stateFile, String(value));
}

let count = loadCount();
const restored = stateFile && fs.existsSync(stateFile);

const out = process.stdout;

function draw() {
  const cols = out.columns ?? 80;
  const rows = out.rows ?? 24;
  const line = "─".repeat(Math.max(0, cols - 2));
  out.write("\x1b[2J\x1b[H"); // clear + home
  out.write(`┌${line}┐\n`);
  out.write(`│ counter-demo${restored ? "  (restored)" : ""}\n`);
  out.write(`│ count: ${count}\n`);
  out.write(`│ size: ${cols}x${rows}\n`);
  out.write(`│ keys: + - r q\n`);
  out.write(`└${line}┘\n`);
}

function cleanup(code) {
  out.write("\x1b[?1049l\x1b[?25h"); // leave alt screen, show cursor
  process.exit(code);
}

out.write("\x1b[?1049h\x1b[?25l"); // alt screen, hide cursor
process.title = "counter-demo";
out.write("\x1b]0;counter-demo\x07"); // window title, so title() is testable
draw();

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  for (const byte of chunk) {
    const key = String.fromCharCode(byte);
    if (key === "+" || key === "=") count += 1;
    else if (key === "-") count -= 1;
    else if (key === "r") count = 0;
    else if (key === "q" || byte === 3) {
      saveCount(count);
      cleanup(0);
    }
  }
  saveCount(count);
  draw();
});

process.stdout.on("resize", draw);
process.on("SIGTERM", () => cleanup(0));
