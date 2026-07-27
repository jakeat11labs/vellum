#!/usr/bin/env node
// @ts-check
// hf-probe — fingerprint the published HyperFrames package and diff it against the
// version Vellum was last verified against (baseline.json).
//
// This is the mechanical half of the vellum-hf-sync skill. It answers "what changed
// upstream?" with facts; SKILL.md handles "so what should we do about it?".
//
// Usage:
//   node hf-probe.mjs                  probe dist-tag `latest` against baseline.json
//   node hf-probe.mjs --version 0.7.76 probe a specific version
//   node hf-probe.mjs --json           emit only JSON (for piping); default prints both
//   node hf-probe.mjs --save-baseline  overwrite baseline.json with the probed version
//
// Exit codes let a caller triage without parsing:
//   0  no drift — probed version matches the baseline fingerprint
//   1  drift — something changed, but every contract symbol Vellum needs is intact
//   2  BROKEN — a contract symbol Vellum depends on is missing; the player may not mount
//   3  probe itself failed (network, npm, bad version)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, "..");
const BASELINE_PATH = path.join(SKILL_DIR, "baseline.json");
const REPO_ROOT = path.resolve(SKILL_DIR, "..", "..", "..");

// ---------------------------------------------------------------------------
// The contract. Every entry is something Vellum reads out of the HyperFrames
// package at runtime or install time. Keep this list in sync with the comment
// block in scripts/vellum-template.html and with references/coupling-map.md —
// the whole point of the probe is that this list is the single source of truth
// for "what would break us".
// ---------------------------------------------------------------------------

/** Globals + attributes the injected browser runtime must still provide. */
const RUNTIME_CONTRACT = [
  { symbol: "__playerReady", why: "player-mounted flag; mount() polls it", critical: true },
  { symbol: "__player", why: "playback object the scrubber drives", critical: true },
  { symbol: "getDuration", why: "timeline length; sets scrub.max", critical: true },
  { symbol: "__timelines", why: "per-composition GSAP timelines", critical: true },
  { symbol: "data-composition-id", why: "identifies the composition root", critical: true },
  { symbol: "data-start", why: "scene boundaries; drives the tick marks", critical: true },
  { symbol: "data-duration", why: "scene length + duration fallback", critical: true },
  { symbol: "__HF_PICKER_API", why: "element inspector for friendly labels", critical: false },
  { symbol: "getCandidatesAtPoint", why: "picker call Vellum makes for labels", critical: false },
];

/** CLI surface Vellum shells out to. Missing critical entries break install or review. */
const CLI_CONTRACT = [
  { symbol: "snapshot", why: "vellum-review.mjs renders packet frames", critical: true },
  { symbol: "init", why: "install.sh scaffolds an empty folder", critical: true },
  { symbol: "skills", why: "install.sh installs the HF agent skills", critical: true },
  { symbol: "--non-interactive", why: "install.sh runs init headless", critical: true },
  { symbol: "skip-skills", why: "install.sh defers skill install to its own step", critical: true },
  { symbol: "skip-transcribe", why: "install.sh skips transcription during scaffold", critical: true },
];

// ---------------------------------------------------------------------------

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] ?? true;
}
const WANT_JSON_ONLY = process.argv.includes("--json");
const SAVE_BASELINE = process.argv.includes("--save-baseline");

function npm(args) {
  return execFileSync("npm", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Recursively list files under dir, returned as sorted dir-relative posix paths. */
function listFiles(dir, base = dir) {
  /** @type {string[]} */
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out.sort();
}

/** Find the browser runtime build the same way vellum-server.mjs does, so the probe
 *  fails exactly when the server's glob would fail — not one heuristic earlier or later. */
function findRuntimeFile(distDir) {
  let files;
  try {
    files = fs.readdirSync(distDir);
  } catch {
    return null;
  }
  const pick =
    files.find((f) => /runtime/i.test(f) && /\.iife\.js$/i.test(f)) ||
    files.find((f) => /runtime/i.test(f) && f.endsWith(".js"));
  return pick ? path.join(distDir, pick) : null;
}

/** Download a published version and reduce it to the facts Vellum cares about. */
function fingerprint(version) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hf-probe-"));
  try {
    npm(["pack", `hyperframes@${version}`, "--silent", "--pack-destination", tmp]);
    const tgz = fs.readdirSync(tmp).find((f) => f.endsWith(".tgz"));
    if (!tgz) throw new Error(`npm pack produced no tarball for hyperframes@${version}`);
    execFileSync("tar", ["xzf", path.join(tmp, tgz), "-C", tmp]);

    const pkgDir = path.join(tmp, "package");
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    const distDir = path.join(pkgDir, "dist");

    const runtimeFile = findRuntimeFile(distDir);
    const runtimeSrc = runtimeFile ? fs.readFileSync(runtimeFile, "utf8") : "";
    const cliPath = path.join(distDir, "cli.js");
    const cliSrc = fs.existsSync(cliPath) ? fs.readFileSync(cliPath, "utf8") : "";

    /** @param {string} src @param {{symbol:string}[]} contract */
    const probeAll = (src, contract) =>
      Object.fromEntries(contract.map((c) => [c.symbol, src.includes(c.symbol)]));

    // dist/ top level only — nested command/template churn is noise for our purposes,
    // but the skills tree is tracked in full because Vellum's docs promise specific skills.
    const distTop = fs
      .readdirSync(distDir, { withFileTypes: true })
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();

    const skillsDir = path.join(distDir, "skills");
    const skills = fs.existsSync(skillsDir)
      ? Object.fromEntries(
          fs
            .readdirSync(skillsDir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => [e.name, listFiles(path.join(skillsDir, e.name))])
        )
      : {};

    return {
      version: pkg.version,
      engines: pkg.engines || {},
      runtimeFile: runtimeFile ? path.basename(runtimeFile) : null,
      distTop,
      skills,
      runtimeContract: probeAll(runtimeSrc, RUNTIME_CONTRACT),
      cliContract: probeAll(cliSrc, CLI_CONTRACT),
      // The CLI skill's frontmatter description enumerates every command; capturing it
      // verbatim makes new commands (a feature opportunity) visible in the diff.
      cliSkillDescription: readCliSkillDescription(skillsDir),
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function readCliSkillDescription(skillsDir) {
  const p = path.join(skillsDir, "hyperframes-cli", "SKILL.md");
  try {
    const md = fs.readFileSync(p, "utf8");
    const fm = md.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) return null;
    const desc = fm[1].match(/description:\s*>?\s*\n?([\s\S]*?)(?:\n\w+:|$)/);
    return desc ? desc[1].replace(/\s+/g, " ").trim() : null;
  } catch {
    return null;
  }
}

/** What Vellum's own repo currently declares — the third data point beyond baseline/latest. */
function readVellumState() {
  const out = { declaredRange: null, engines: null, installedVersion: null };
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
    out.declaredRange = (pkg.dependencies && pkg.dependencies.hyperframes) || null;
    out.engines = pkg.engines || null;
  } catch {}
  try {
    const hf = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "node_modules", "hyperframes", "package.json"), "utf8")
    );
    out.installedVersion = hf.version;
  } catch {}
  return out;
}

const setDiff = (a, b) => ({
  added: b.filter((x) => !a.includes(x)),
  removed: a.filter((x) => !b.includes(x)),
});

/** Parse a `>=N` style engines range down to the major it demands. */
function minMajor(range) {
  const m = String(range || "").match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

/** Standing mismatches between Vellum's own manifest and HyperFrames' requirements.
 *  These aren't "drift" — they can be wrong even when the versions match — so they're
 *  computed separately and always reported. */
function selfChecks(next, vellum) {
  const out = [];

  const hfNode = minMajor(next.engines?.node);
  const vlNode = minMajor(vellum.engines?.node);
  if (hfNode && vlNode && vlNode < hfNode) {
    out.push({
      kind: "engines-mismatch",
      severity: "warn",
      detail: `Vellum promises node ${vellum.engines.node} but HyperFrames requires ${next.engines.node}`,
      note: "the player itself is pure Node built-ins, but every `npx hyperframes` path (install.sh scaffold, vellum-review snapshot) hard-errors below node " + hfNode,
    });
  }

  // A caret range on a 0.x version locks the MINOR, so `npm install` can never cross
  // 0.6 → 0.7. This is the failure mode that let Vellum sit 85 releases behind silently.
  const declared = vellum.declaredRange;
  const dm = String(declared || "").match(/^\^0\.(\d+)\./);
  const nm = String(next.version).match(/^0\.(\d+)\./);
  if (dm && nm && dm[1] !== nm[1]) {
    out.push({
      kind: "pin-frozen",
      severity: "warn",
      detail: `dependency pin ${declared} can never reach ${next.version}`,
      note: "^0.x locks the minor — npm install will not cross a 0.x minor bump. The pin has to be raised by hand.",
    });
  }

  return out;
}

function diff(base, next) {
  const changes = [];

  if (base.runtimeFile !== next.runtimeFile) {
    changes.push({
      kind: "runtime-file",
      severity: next.runtimeFile ? "warn" : "broken",
      detail: `browser runtime build renamed: ${base.runtimeFile} → ${next.runtimeFile}`,
      note: "vellum-server.mjs globs dist/ for /runtime/i + .iife.js — confirm the new name still matches",
    });
  }
  if (JSON.stringify(base.engines) !== JSON.stringify(next.engines)) {
    changes.push({
      kind: "engines",
      severity: "warn",
      detail: `engines changed: ${JSON.stringify(base.engines)} → ${JSON.stringify(next.engines)}`,
      note: "Vellum's own package.json engines and the README requirements line must not promise less",
    });
  }

  for (const [label, contract, key] of [
    ["runtime", RUNTIME_CONTRACT, "runtimeContract"],
    ["cli", CLI_CONTRACT, "cliContract"],
  ]) {
    for (const c of contract) {
      const had = base[key]?.[c.symbol];
      const has = next[key]?.[c.symbol];
      if (has === false) {
        changes.push({
          kind: `${label}-contract`,
          severity: c.critical ? "broken" : "warn",
          detail: `${c.symbol} not found in ${label === "runtime" ? "the runtime build" : "cli.js"}`,
          note: c.why,
        });
      } else if (had === false && has === true) {
        changes.push({
          kind: `${label}-contract`,
          severity: "opportunity",
          detail: `${c.symbol} is now available (was missing at baseline)`,
          note: c.why,
        });
      }
    }
  }

  const dist = setDiff(base.distTop, next.distTop);
  if (dist.added.length || dist.removed.length) {
    changes.push({
      kind: "dist",
      severity: "info",
      detail: `dist/ contents changed`,
      added: dist.added,
      removed: dist.removed,
      note: "new *.global.js bundles often signal new runtime capabilities worth evaluating",
    });
  }

  const skillNames = setDiff(Object.keys(base.skills), Object.keys(next.skills));
  if (skillNames.added.length || skillNames.removed.length) {
    changes.push({
      kind: "skills",
      severity: skillNames.removed.length ? "warn" : "info",
      detail: "the shipped HyperFrames agent skill set changed",
      added: skillNames.added,
      removed: skillNames.removed,
      note: "Vellum's README, install.sh and skills/vellum/SKILL.md name these skills by hand — a removed skill makes our docs wrong",
    });
  }
  for (const name of Object.keys(next.skills)) {
    if (!base.skills[name]) continue;
    const f = setDiff(base.skills[name], next.skills[name]);
    if (f.added.length || f.removed.length) {
      changes.push({
        kind: "skill-contents",
        severity: "info",
        detail: `skills/${name} contents changed`,
        added: f.added,
        removed: f.removed,
      });
    }
  }

  if (base.cliSkillDescription !== next.cliSkillDescription) {
    changes.push({
      kind: "cli-commands",
      severity: "info",
      detail: "the hyperframes-cli skill description changed (its command list lives here)",
      before: base.cliSkillDescription,
      after: next.cliSkillDescription,
      note: "diff the two strings for newly added commands — these are the feature opportunities",
    });
  }

  return changes;
}

// ---------------------------------------------------------------------------

function main() {
  const target = typeof arg("--version") === "string" ? String(arg("--version")) : npm(["view", "hyperframes", "version"]);

  let baseline = null;
  try {
    baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  } catch {}

  const next = fingerprint(target);
  const vellum = readVellumState();

  if (SAVE_BASELINE) {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify({ ...next, verifiedAgainstVellum: vellum.declaredRange }, null, 2) + "\n");
    if (!WANT_JSON_ONLY) console.log(`baseline.json updated → hyperframes@${next.version}`);
    return 0;
  }

  if (!baseline) {
    const report = { error: "no baseline.json — run with --save-baseline to establish one", probed: next, vellum };
    console.log(JSON.stringify(report, null, 2));
    return 3;
  }

  // Upstream drift and standing self-checks are kept apart on purpose. Drift is news — it
  // means HyperFrames moved. A self-check can be a deliberate, permanent state (Vellum's
  // node floor is intentionally below HyperFrames' because the player doesn't need the CLI).
  // Folding them together would leave the verdict stuck on DRIFT forever, and a tool that is
  // permanently yellow stops being read.
  const changes = baseline.version === next.version ? [] : diff(baseline, next);
  const advisories = selfChecks(next, vellum);
  const broken = [...changes, ...advisories].filter((c) => c.severity === "broken");

  const report = {
    baselineVersion: baseline.version,
    latestVersion: next.version,
    upToDate: baseline.version === next.version,
    vellum,
    verdict: broken.length ? "BROKEN" : changes.length ? "DRIFT" : "CURRENT",
    changes,
    advisories,
    probed: next,
  };

  if (WANT_JSON_ONLY) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(summarize(report));
    console.log("\n--- full JSON ---\n" + JSON.stringify(report, null, 2));
  }

  return broken.length ? 2 : changes.length ? 1 : 0;
}

function summarize(r) {
  const L = [];
  L.push(`hyperframes: baseline ${r.baselineVersion} → latest ${r.latestVersion}   [${r.verdict}]`);
  L.push(`vellum declares: ${r.vellum.declaredRange ?? "—"}   installed: ${r.vellum.installedVersion ?? "none"}   engines: ${JSON.stringify(r.vellum.engines ?? {})}`);

  const rank = { broken: 0, warn: 1, opportunity: 2, info: 3 };
  const section = (title, items) => {
    if (!items.length) return;
    L.push("", title);
    for (const c of [...items].sort((a, b) => rank[a.severity] - rank[b.severity])) {
      L.push(`[${c.severity.toUpperCase()}] ${c.kind}: ${c.detail}`);
      if (c.added?.length) L.push(`    + ${c.added.join(", ")}`);
      if (c.removed?.length) L.push(`    - ${c.removed.join(", ")}`);
      if (c.note) L.push(`    ↳ ${c.note}`);
    }
  };

  if (!r.changes.length) L.push("", "No upstream drift since the verified baseline.");
  section("── upstream drift ──", r.changes);
  // Advisories persist across runs by design; some are accepted trade-offs, not to-dos.
  section("── standing advisories (may be deliberate) ──", r.advisories);
  return L.join("\n");
}

try {
  process.exit(main());
} catch (err) {
  console.error(`probe failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(3);
}
