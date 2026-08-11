// Fetch the pinned tui-test driver binary for this platform, verify its
// checksum, and cache it. Never `curl | sh`: the version and per-artifact
// sha256 live in pins.json, so what CI runs is exactly what was reviewed.
//
// Usable both ways:
//   node harness/fetch-driver.mjs      # CLI: prints the driver path
//   import { ensureDriver } from ...   # library: harness calls this lazily
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const pins = JSON.parse(fs.readFileSync(path.join(root, "pins.json"), "utf8"));

function platformKey() {
  const key = `${process.platform}-${process.arch}`;
  // Alpine and friends: set TUI_IT_MUSL=1 to select the musl artifact.
  if (process.platform === "linux" && process.env.TUI_IT_MUSL === "1") {
    return `${key}-musl`;
  }
  return key;
}

/**
 * Ensure the pinned driver exists locally and return its absolute path.
 * Cache layout: .tui-test-cache/<version>/tui-test — keyed by version so a
 * pin bump can never reuse a stale binary.
 */
export async function ensureDriver() {
  const key = platformKey();
  const artifact = pins.artifacts[key];
  if (!artifact) {
    throw new Error(
      `no pinned tui-test artifact for ${key}; add one to pins.json (known: ${Object.keys(pins.artifacts).join(", ")})`,
    );
  }
  if (artifact.name.endsWith(".zip")) {
    throw new Error(
      "Windows artifacts are pinned but extraction is not wired up yet; see the roadmap in README.md",
    );
  }

  const cacheDir = path.join(root, ".tui-test-cache", pins.version);
  const driverPath = path.join(cacheDir, "tui-test");
  if (fs.existsSync(driverPath)) {
    return driverPath;
  }

  await fsp.mkdir(cacheDir, { recursive: true });
  const url = `https://github.com/${pins.driver}/releases/download/${pins.version}/${artifact.name}`;
  const archivePath = path.join(cacheDir, artifact.name);
  process.stderr.write(`fetching ${url}\n`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`download failed: ${response.status} ${response.statusText} for ${url}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());

  // Verify BEFORE extracting: a tampered or truncated archive must never
  // reach tar, let alone produce an executable.
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== artifact.sha256) {
    throw new Error(
      `checksum mismatch for ${artifact.name}:\n  expected ${artifact.sha256}\n  got      ${digest}\nRefusing to install.`,
    );
  }
  await fsp.writeFile(archivePath, bytes);
  execFileSync("tar", ["xzf", archivePath, "-C", cacheDir]);
  await fsp.rm(archivePath);
  if (!fs.existsSync(driverPath)) {
    throw new Error(`archive extracted but ${driverPath} is missing; artifact layout changed upstream?`);
  }
  await fsp.chmod(driverPath, 0o755);
  return driverPath;
}

// CLI mode: print the path so shells can capture it.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  ensureDriver().then(
    (driverPath) => {
      console.log(driverPath);
    },
    (error) => {
      console.error(String(error?.message ?? error));
      process.exit(1);
    },
  );
}
