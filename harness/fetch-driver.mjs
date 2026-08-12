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
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const pins = JSON.parse(fs.readFileSync(path.join(root, "pins.json"), "utf8"));

/**
 * The supply-chain gate: refuse any payload whose sha256 does not match the
 * pinned value. Extracted as a named, pure function so it is unit-testable —
 * the whole "never curl | sh" promise rests on this one comparison, and an
 * untested guard is a guard you only find disabled after it mattered.
 * Throws on mismatch; returns the verified bytes on success.
 */
export function verifyDigest(bytes, expectedSha256, artifactName = "artifact") {
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== expectedSha256) {
    throw new Error(
      `checksum mismatch for ${artifactName}:\n  expected ${expectedSha256}\n  got      ${digest}\nRefusing to install.`,
    );
  }
  return bytes;
}

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

  // Cache OUTSIDE the package: node_modules is wiped on every reinstall, and
  // re-downloading 3 MB per `npm i` is silly. TUI_IT_CACHE_DIR overrides;
  // version-keyed so a pin bump can never reuse a stale binary. The old
  // in-package location is honored if it already has the binary.
  const cacheRoot =
    process.env.TUI_IT_CACHE_DIR ??
    path.join(os.homedir(), ".cache", "tui-integration-tests");
  const legacy = path.join(root, ".tui-test-cache", pins.version, "tui-test");
  if (fs.existsSync(legacy)) {
    return legacy;
  }
  const cacheDir = path.join(cacheRoot, pins.version);
  const driverPath = path.join(cacheDir, "tui-test");
  if (fs.existsSync(driverPath)) {
    return driverPath;
  }

  await fsp.mkdir(cacheDir, { recursive: true });
  const url = `https://github.com/${pins.driver}/releases/download/${pins.version}/${artifact.name}`;
  // CONCURRENT-SAFE: node --test runs test files in parallel, and on a cold
  // cache every file's first launch() fetches. Stage everything under a
  // per-process name and finish with an atomic rename — the losers of the
  // race simply find the winner's binary. (The original shared-path version
  // let one process rm the archive out from under another, or extract a
  // half-written file: observed in CI the first time a consumer grew a
  // second test file.)
  const staging = path.join(cacheDir, `.staging-${process.pid}`);
  await fsp.mkdir(staging, { recursive: true });
  try {
    process.stderr.write(`fetching ${url}\n`);
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) {
      throw new Error(`download failed: ${response.status} ${response.statusText} for ${url}`);
    }
    // Verify BEFORE extracting: a tampered or truncated archive must never
    // reach tar, let alone produce an executable.
    const bytes = verifyDigest(
      Buffer.from(await response.arrayBuffer()),
      artifact.sha256,
      artifact.name,
    );
    const archivePath = path.join(staging, artifact.name);
    await fsp.writeFile(archivePath, bytes);
    execFileSync("tar", ["xzf", archivePath, "-C", staging]);
    const staged = path.join(staging, "tui-test");
    if (!fs.existsSync(staged)) {
      throw new Error(`archive extracted but tui-test is missing; artifact layout changed upstream?`);
    }
    await fsp.chmod(staged, 0o755);
    try {
      await fsp.rename(staged, driverPath);
    } catch (error) {
      // A concurrent fetch won the rename; their binary is as good as ours.
      if (!fs.existsSync(driverPath)) throw error;
    }
    return driverPath;
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }
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
