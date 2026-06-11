// `vellum update` — check the published version and refresh the installed tool in place.
// Invoked by vellum-server.mjs when the first arg is "update". Usage:
//   vellum update           check, then update if a newer version exists
//   vellum update --check   report only; never modify anything
//   vellum update --force   reinstall the latest even if already current
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { VERSION } from "./vellum-shared.mjs";

// Source repo. Env-overridable for forks/testing; defaults to the canonical repo.
const REPO = process.env.VELLUM_REPO || "jakeat11labs/vellum";
const REF = process.env.VELLUM_REF || "main";
const BASE = (process.env.VELLUM_BASE_URL || `https://raw.githubusercontent.com/${REPO}/${REF}`).replace(/\/+$/, "");

// Compare two dotted versions. Returns 1 if a > b, -1 if a < b, 0 if equal.
function cmpVersion(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

async function fetchLatestVersion() {
  const res = await fetch(`${BASE}/package.json`, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching package.json`);
  const pkg = await res.json();
  if (!pkg.version) throw new Error("published package.json has no version field");
  return String(pkg.version);
}

// Preserve the existing install's skill location so an update doesn't reset it.
function detectSkillTargets(root) {
  const targets = [];
  for (const t of [".agents/skills/vellum", ".claude/skills/vellum"]) {
    try {
      fs.lstatSync(path.join(root, t));
      targets.push(t);
    } catch {}
  }
  return targets.join(" ");
}

// Read VELLUM_DIR / VELLUM_PORT out of .vellum.env so npm-script wiring is preserved.
function readDotEnv(root) {
  const out = {};
  try {
    const txt = fs.readFileSync(path.join(root, ".vellum.env"), "utf8");
    for (const line of txt.split("\n")) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
  } catch {}
  return out;
}

export async function runUpdate(args = []) {
  const root = process.cwd();
  const checkOnly = args.includes("--check");
  const force = args.includes("--force");

  console.log(`  Vellum ${VERSION} — checking for updates…`);
  let latest;
  try {
    latest = await fetchLatestVersion();
  } catch (e) {
    console.error(`  Could not check for updates: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  const diff = cmpVersion(latest, VERSION);
  console.log(`  Installed: ${VERSION}    Latest: ${latest}`);

  if (diff <= 0 && !force) {
    console.log(diff === 0 ? "  You're on the latest version. ✓" : "  You're ahead of the published version. ✓");
    return;
  }
  if (checkOnly) {
    console.log("  A newer version is available — run 'vellum update' to install it.");
    return;
  }

  console.log(`  Updating ${VERSION} → ${latest}…\n`);

  // Re-run the published installer in place. It is idempotent: it refreshes the tool
  // scripts, the agent skill, and the global shim, and never clobbers package.json
  // scripts. We pass the detected config through so nothing gets reset.
  const env = { ...process.env, VELLUM_NO_PROMPT: "1", VELLUM_INSTALL_BIN: "1" };
  const skillTargets = detectSkillTargets(root);
  if (skillTargets) env.VELLUM_SKILL_TARGETS = skillTargets;
  const dotenv = readDotEnv(root);
  if (dotenv.VELLUM_DIR) env.VELLUM_DIR = dotenv.VELLUM_DIR;
  if (dotenv.VELLUM_PORT) env.VELLUM_PORT = dotenv.VELLUM_PORT;

  // URL is built only from trusted constants (single-quoted); curl with wget fallback.
  const installer = `${BASE}/install.sh`;
  const fetchCmd = `if command -v curl >/dev/null 2>&1; then curl -fsSL '${installer}'; else wget -qO- '${installer}'; fi`;
  const child = spawn("sh", ["-c", `${fetchCmd} | sh -s -- --no-prompt`], {
    cwd: root,
    stdio: "inherit",
    env,
  });

  await new Promise((resolve) => {
    child.on("exit", (code) => {
      if (code === 0) {
        console.log(`\n  Updated to ${latest}. ✓`);
      } else {
        console.error(`\n  Update failed (installer exited ${code}).`);
        process.exitCode = code || 1;
      }
      resolve();
    });
    child.on("error", (e) => {
      console.error(`  Update failed: ${e.message}`);
      process.exitCode = 1;
      resolve();
    });
  });
}
