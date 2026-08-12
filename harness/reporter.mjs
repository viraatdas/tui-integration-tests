// A node:test custom reporter that writes a self-contained HTML report:
// summary, per-test results, every failure's final SCREEN (extracted from the
// harness's timeout errors, which embed it), and a gallery of each session's
// last screen (written by Session.close() to .tui-report/screens, because
// test files run in child processes while this reporter runs in the parent).
//
// Usage (both reporters, so the terminal output stays):
//   node --test \
//     --test-reporter=spec --test-reporter-destination=stdout \
//     --test-reporter=tui-integration-tests/reporter --test-reporter-destination=tui-report.html \
//     tests/tui/*.test.mjs
import fs from "node:fs";
import path from "node:path";

const esc = (text) =>
  String(text).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);

function failureDetail(error) {
  const parts = [];
  let current = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (current.message) parts.push(String(current.message));
    current = current.cause;
  }
  return parts.join("\n");
}

function journeys() {
  const dir = path.join(process.env.TUI_IT_REPORT_DIR ?? ".tui-report", "journeys");
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")))
      .filter((entry) => entry && Array.isArray(entry.steps));
  } catch {
    return [];
  }
}

function screensGallery() {
  const dir = path.join(process.env.TUI_IT_REPORT_DIR ?? ".tui-report", "screens");
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".txt"))
      .sort()
      .map((name) => {
        const raw = fs.readFileSync(path.join(dir, name), "utf8");
        const split = raw.indexOf("\n---\n");
        const base = name.replace(/\.txt$/, "");
        // Inline the matching SVG (full-color pixels) as a data URI so the
        // report is one self-contained file — a visual bug is visible, not
        // just describable.
        let svg = null;
        try {
          svg = fs.readFileSync(path.join(dir, `${base}.svg`), "utf8");
        } catch {
          svg = null;
        }
        return {
          name: base,
          meta: split >= 0 ? raw.slice(0, split) : "",
          screen: split >= 0 ? raw.slice(split + 5) : raw,
          svg,
        };
      });
  } catch {
    return [];
  }
}

export default async function* tuiReporter(source) {
  const tests = [];
  const startedAt = new Date();
  for await (const event of source) {
    if (event.type === "test:pass" || event.type === "test:fail") {
      // Suites (files) also emit pass/fail; keep leaf tests only.
      if (event.data.details?.type === "suite") continue;
      tests.push({
        ok: event.type === "test:pass",
        name: event.data.name,
        file: event.data.file ? path.basename(event.data.file) : "",
        durationMs: event.data.details?.duration_ms ?? 0,
        skipped: Boolean(event.data.skip),
        detail: event.type === "test:fail" ? failureDetail(event.data.details?.error) : "",
      });
    }
  }

  const failed = tests.filter((test) => !test.ok);
  const passed = tests.filter((test) => test.ok && !test.skipped);
  const skipped = tests.filter((test) => test.skipped);
  const totalMs = tests.reduce((sum, test) => sum + test.durationMs, 0);
  const gallery = screensGallery();
  const stories = journeys();
  const verdictColor = failed.length ? "#e05252" : "#3fb37f";

  const storylines = stories
    .map((story) => {
      const bad = story.steps.some((step) => !step.ok);
      const stepHtml = story.steps
        .map(
          (step, index) => `<details${step.ok ? "" : " open"}>
  <summary><span class="st ${step.ok ? "ok" : "bad"}">${step.ok ? "✓" : "✖"}</span> step ${index + 1} — ${esc(step.label)}</summary>
  <pre class="screen">${esc(step.screen || "(no screen captured)")}</pre>
</details>`,
        )
        .join("\n");
      return `<section>
  <h3><span class="st ${bad ? "bad" : "ok"}">${bad ? "✖" : "✓"}</span> ${esc(story.name)} <span class="dim">(${story.steps.length} steps)</span></h3>
  ${stepHtml}
</section>`;
    })
    .join("\n");

  const rows = tests
    .map(
      (test) => `<tr>
  <td class="st ${test.ok ? "ok" : "bad"}">${test.skipped ? "skip" : test.ok ? "pass" : "FAIL"}</td>
  <td>${esc(test.name)}</td>
  <td class="mono dim">${esc(test.file)}</td>
  <td class="mono">${(test.durationMs / 1000).toFixed(2)}s</td>
</tr>`,
    )
    .join("\n");

  const failures = failed
    .map(
      (test) => `<section class="fail">
  <h3>✖ ${esc(test.name)}</h3>
  <pre class="screen">${esc(test.detail || "(no error detail)")}</pre>
</section>`,
    )
    .join("\n");

  const screens = gallery
    .map((entry) => {
      const img = entry.svg
        ? `<img class="shot" alt="screenshot of ${esc(entry.name)}" src="data:image/svg+xml;base64,${Buffer.from(entry.svg).toString("base64")}">`
        : "";
      return `<details>
  <summary class="mono">${esc(entry.name)} <span class="dim">${esc(entry.meta.split("\n")[1] ?? "")}</span></summary>
  ${img}
  <pre class="screen">${esc(entry.screen)}</pre>
</details>`;
    })
    .join("\n");

  yield `<!doctype html>
<meta charset="utf-8">
<title>TUI test report — ${failed.length ? `${failed.length} failed` : "all passing"}</title>
<style>
  :root { color-scheme: dark; }
  body { background:#101418; color:#d8dee6; font:15px/1.5 system-ui, sans-serif; max-width:1000px; margin:2rem auto; padding:0 1rem; }
  h1 { font-size:1.3rem; } h3 { margin:1.2rem 0 .4rem; }
  .mono { font-family: ui-monospace, monospace; font-size:.85em; }
  .dim { color:#7a8494; }
  .verdict { color:${verdictColor}; font-weight:600; }
  table { border-collapse:collapse; width:100%; margin:1rem 0; }
  td { padding:.35rem .6rem; border-bottom:1px solid #232a33; }
  .st { font-weight:600; width:3.5rem; } .ok { color:#3fb37f; } .bad { color:#e05252; }
  img.shot { max-width:100%; border:1px solid #232a33; margin:.4rem 0; display:block; }
  pre.screen { background:#0b0e12; border:1px solid #232a33; padding: .8rem 1rem; overflow-x:auto; font-size:12px; line-height:1.35; }
  details { margin:.4rem 0; } summary { cursor:pointer; }
</style>
<h1>TUI test report <span class="verdict">${failed.length ? `${failed.length} failed` : "all passing"}</span></h1>
<p class="dim">${esc(startedAt.toISOString())} · ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped · ${(totalMs / 1000).toFixed(1)}s</p>
<table>${rows}</table>
${failures ? `<h2>Failures — what the user was looking at</h2>${failures}` : ""}
${storylines ? `<h2>Journeys — step by step, with screens</h2>${storylines}` : ""}
${screens ? `<h2>Final screens (${gallery.length} sessions)</h2>${screens}` : ""}
`;
}
