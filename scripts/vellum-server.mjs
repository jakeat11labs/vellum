#!/usr/bin/env node
/**
 * Vellum — review/annotation server for HyperFrames compositions.
 *
 *  - Serves the user's project statically (index.html, assets, node_modules/hyperframes
 *    runtime) so the review player can mount the real composition in an iframe.
 *  - Collects time-coded review notes posted by the player and persists them to
 *    <comp>/notes/annotations.json (+ a readable annotations.md) for a coding agent to read.
 *  - Stores a saved voice/music mix to <comp>/notes/mix.json.
 *  - Watches the composition directory and bumps an in-memory revision counter (GET /api/watch)
 *    so the open player can poll for edits and live-reload the iframe at the same frame.
 *
 * Zero dependencies — Node built-ins only. Run from your HyperFrames project root:
 *   npx vellum                 # composition is ./index.html
 *   VELLUM_DIR=compositions/hero npx vellum   # composition is ./compositions/hero/index.html
 * Opens your browser to the review player automatically (disable with --no-open or VELLUM_OPEN=0).
 *
 * Local-only by design: binds to 127.0.0.1, no CORS headers, path-traversal guarded.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
// sanitizeResolution is PATCH/offline-only — a note is NEVER born with a resolution at POST.
import { computeMetrics, describeDesiredDelta, fmtDuration, fmtTime, indexHashOf, METRICS_KEEP, METRICS_MAX_LINES, normalizeNoteSeverity, normalizeNoteStatus, reconcileNote, resolveComposition, resolveInside, sanitizeResolution, VERSION } from "./vellum-shared.mjs";
import * as ui from "./vellum-ui.mjs";

const ROOT = process.cwd(); // the HyperFrames project root (holds index.html + node_modules)
const PORT = Number(process.env.VELLUM_PORT) || 4848;
const argv = process.argv.slice(2);

// Subcommands handled before the server boots, so they skip composition/runtime setup.
if (argv[0] === "update") {
  const { runUpdate } = await import("./vellum-update.mjs");
  await runUpdate(argv.slice(1));
  process.exit(process.exitCode || 0);
}
if (argv[0] === "version" || argv.includes("--version") || argv.includes("-v")) {
  console.log(`vellum ${VERSION}`);
  process.exit(0);
}

function shouldOpenBrowser() {
  if (argv.includes("--no-open") || process.env.VELLUM_OPEN === "0") return false;
  if (argv.includes("--open") || process.env.VELLUM_OPEN === "1") return true;
  return true;
}

const OPEN_BROWSER = shouldOpenBrowser();

function openInBrowser(url) {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.on("error", () => console.log(`  Open manually → ${url}`));
  child.unref();
}

// Live activity feed — one line per review event so the terminal feels alive
// while notes come in from the browser.
function logEvent(glyph, text) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`  ${ui.dim(ts)} ${glyph} ${text}`);
}

function noteLabel(note) {
  return `${ui.bold(`note-${note.id}`)} ${ui.dim(`@ ${fmtTime(note.time)}`)}`;
}

// Sanitize the audio snapshot carried by an audio-scoped note into a fixed shape with
// bounded strings/numbers — never trust the browser's payload verbatim. `detail` clips
// (active VO/music) keep timing + optional script text; `brief` clips (prev/next VO for
// series context) keep just a filename and start time.
function sanitizeAudioClip(c, detail) {
  if (!c || typeof c !== "object") return null;
  const num = (v) => boundedNumber(v, null, { min: 0, decimals: 100 });
  const clip = { src: c.src != null ? String(c.src).slice(0, 200) : null };
  if (c.start != null) clip.start = num(c.start);
  if (c.script != null) clip.script = String(c.script).slice(0, detail ? 800 : 200);
  if (detail) {
    if (c.dur != null) clip.dur = num(c.dur);
    if (c.at != null) clip.at = num(c.at);
    if (c.line != null) clip.line = String(c.line).slice(0, 500);
  }
  return clip;
}
function sanitizeAudio(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {
    voice: sanitizeAudioClip(raw.voice, true),
    music: sanitizeAudioClip(raw.music, true),
    prev: sanitizeAudioClip(raw.prev, false),
    next: sanitizeAudioClip(raw.next, false),
  };
  return Object.values(out).some(Boolean) ? out : null;
}

const { compDir: COMP_DIR, compAbs: COMP_ABS } = resolveComposition(ROOT);

// Server-authoritative review baseline: the git commit the review was made against plus a
// sha256 of the composition's index.html at pin time. Stamped on each note (POST) and on the
// composition manifest, so the consuming agent can detect drift ("pinned against older
// content") and cite the exact commit during write-back. Best-effort and never throws: a
// non-git project drops `commit`, a missing index.html drops `indexHash`, and the whole field
// is omitted when neither resolves (mirrors the ...(kind ? {kind} : {}) optional-spread
// precedent). Never read from the browser payload — a client cannot spoof provenance. PATCH
// leaves it immutable; each note records the baseline it was created against.
function computeProvenance() {
  const prov = {};
  try {
    const out = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", timeout: 2000 });
    if (out.status === 0) {
      const sha = String(out.stdout || "").trim();
      if (/^[0-9a-f]{40}$/.test(sha)) prov.commit = sha;
    }
  } catch {}
  // sha256 of index.html via the shared helper, so the player/server and the review packet's
  // before/after cache all key off the IDENTICAL fingerprint (null when index.html is missing).
  const indexHash = indexHashOf(COMP_ABS);
  if (indexHash) prov.indexHash = indexHash;
  return prov.commit || prov.indexHash ? prov : null;
}

// HyperFrames runtime resolution. The runtime the player injects is NOT referenced by
// the composition's HTML, and its filename is not declared in the hyperframes package
// (no `exports`/`main`, and dist/ ships more than one build). So we resolve it
// DYNAMICALLY rather than hardcoding the path: glob the dist/ of a local
// node_modules/hyperframes, else the npx download cache, else fall back to the jsDelivr
// CDN. The player fetches it from a stable Vellum endpoint (RUNTIME_ENDPOINT) so the
// exact filename never has to be hardcoded on the client. A real local install wins.
const HF_BASE = "/node_modules/hyperframes";
const RUNTIME_ENDPOINT = "/__vellum/runtime.js";
const HF_CDN = "https://cdn.jsdelivr.net/npm/hyperframes";

function detectHyperframesVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const dep =
      (pkg.dependencies && pkg.dependencies.hyperframes) ||
      (pkg.devDependencies && pkg.devDependencies.hyperframes);
    const fromDep = dep && String(dep).match(/\d+\.\d+\.\d+/);
    if (fromDep) return fromDep[0];
    const fromScripts = JSON.stringify(pkg.scripts || {}).match(/hyperframes@(\d+\.\d+\.\d+)/);
    if (fromScripts) return fromScripts[1];
  } catch {}
  return "latest";
}

// Locate the browser runtime build inside a hyperframes package by globbing dist/, so a
// future rename (e.g. hyperframe.runtime.iife.js → *.runtime.min.js) still resolves.
function findRuntimeFile(hfDir) {
  const dist = path.join(hfDir, "dist");
  try {
    const files = fs.readdirSync(dist);
    const pick =
      files.find((f) => /runtime/i.test(f) && /\.iife\.js$/i.test(f)) ||
      files.find((f) => /runtime/i.test(f) && f.endsWith(".js"));
    if (pick) return path.join(dist, pick);
  } catch {}
  return null;
}

function findNpxRuntimeDir(version) {
  try {
    const base = path.join(os.homedir(), ".npm", "_npx");
    for (const sub of fs.readdirSync(base)) {
      const hf = path.join(base, sub, "node_modules", "hyperframes");
      try {
        const v = JSON.parse(fs.readFileSync(path.join(hf, "package.json"), "utf8")).version;
        if ((version === "latest" || v === version) && findRuntimeFile(hf)) return hf;
      } catch {}
    }
  } catch {}
  return null;
}

const HF_VERSION = detectHyperframesVersion();
const HF_LOCAL_DIR = path.join(ROOT, "node_modules", "hyperframes");
const HF_LOCAL_RUNTIME = findRuntimeFile(HF_LOCAL_DIR);
const HF_NPX_DIR = HF_LOCAL_RUNTIME ? null : findNpxRuntimeDir(HF_VERSION);
const HF_NPX_RUNTIME = HF_NPX_DIR ? findRuntimeFile(HF_NPX_DIR) : null;
const HF_VER_TAG = HF_VERSION === "latest" ? "" : `@${HF_VERSION}`;

function streamFile(res, filePath) {
  const st = fs.statSync(filePath);
  const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, { "content-type": type, "content-length": st.size, "cache-control": "no-cache" });
  const stream = fs.createReadStream(filePath);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

// Stable endpoint the player injects. Resolves the real runtime file (local → npx cache),
// else redirects to the CDN — so the client never hardcodes the dist filename.
function serveRuntime(res) {
  const local = HF_LOCAL_RUNTIME || HF_NPX_RUNTIME;
  if (local) {
    try {
      return streamFile(res, local);
    } catch {}
  }
  res.writeHead(302, { location: `${HF_CDN}${HF_VER_TAG}/dist/hyperframe.runtime.iife.js`, "cache-control": "no-cache" });
  return res.end();
}

// Legacy passthrough: anything still requesting /node_modules/hyperframes/* directly.
function serveHyperframesRuntime(req, res, pathname) {
  const rest = pathname.slice(HF_BASE.length);
  if (HF_NPX_DIR) {
    const cacheFull = resolveInside(HF_NPX_DIR, `.${rest}`);
    if (cacheFull) {
      try {
        if (fs.statSync(cacheFull).isFile()) return streamFile(res, cacheFull);
      } catch {}
    }
  }
  res.writeHead(302, { location: `${HF_CDN}${HF_VER_TAG}${rest}`, "cache-control": "no-cache" });
  return res.end();
}
const NOTES_DIR = path.join(COMP_ABS, "notes");
const NOTES_JSON = path.join(NOTES_DIR, "annotations.json");
const NOTES_MD = path.join(NOTES_DIR, "annotations.md");
const MIX_JSON = path.join(NOTES_DIR, "mix.json");
const COMP_JSON = path.join(NOTES_DIR, "composition.json"); // scene/timing manifest the player POSTs at mount

// Self-measurement: an append-only lifecycle ledger (gitignored), the event half of the metrics
// feature. `sid` stamps every line so time-to-note can pair a create with the session/mount anchor
// that preceded it within a run. `metricsLines` tracks the physical line count so trim hysteresis is
// correct without a stat() per append.
const METRICS_JSONL = path.join(NOTES_DIR, "metrics.jsonl");
const BOOT_AT = new Date().toISOString();
const SID = `${BOOT_AT}#${process.pid}`;
let metricsLines = 0;

// Reference-image attachments — raw image files uploaded via POST /api/attachments and stored under
// notes/attachments/. Bounded "not a gallery": a small per-note cap + size cap, an allowlist of
// raster types (SVG deliberately excluded — script-bearing → stored-XSS), magic-byte sniffing, and a
// 100% server-generated filename so the stored path can never be client-controlled.
const ATTACH_DIR = path.join(NOTES_DIR, "attachments");
const IMG_LIMIT = 4e6; // 4 MB raw-bytes cap per upload (413 over)
const MAX_ATTACHMENTS = 4; // per note
const ATTACH_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const ATTACH_FILE_RE = /^attachments\/att-[\w.-]+\.(png|jpe?g|webp|gif)$/;

// Live composition reload — the player polls GET /api/watch ~1×/s and re-mounts the iframe whenever
// `compRev` changes. An fs.watch on COMP_ABS bumps the counter (debounced) on any non-ignored edit.
// In-memory only: nothing is persisted, so the note record, composition.json, and the bare-array
// reader contract are all untouched. The notes/ ignore is load-bearing — writeNotes/handleMix/
// handleComposition rewrite under NOTES_DIR on every save, so an un-ignored watch would self-trigger
// an endless reload loop.
let compRev = 0;
let watchDebounce = null;
let watchStarted = false;

// Validate the note's attachment descriptors: keep only entries whose type is allowlisted, whose
// server-generated relative path matches ATTACH_FILE_RE AND resolves inside notes/ AND still exists
// on disk (triple-guard — `file` is the one client-supplied path, so traversal and dangling refs are
// dropped). Bounded like sanitizeAudio; capped at MAX_ATTACHMENTS. Returns [] for a non-array, so the
// optional spread omits the field entirely when nothing valid survives.
function sanitizeAttachments(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw.slice(0, MAX_ATTACHMENTS)) {
    if (!entry || typeof entry !== "object") continue;
    const type = entry.type;
    if (!ATTACH_TYPES[type]) continue;
    const file = typeof entry.file === "string" ? entry.file : "";
    if (!ATTACH_FILE_RE.test(file)) continue;
    const full = resolveInside(NOTES_DIR, file);
    if (!full || !fs.existsSync(full)) continue;
    const att = {
      file,
      name: String(entry.name ?? "").slice(0, 120),
      bytes: boundedNumber(entry.bytes, 0, { min: 0 }),
      type,
    };
    if (entry.w != null) att.w = boundedNumber(entry.w, null, { min: 0, max: 100000 });
    if (entry.h != null) att.h = boundedNumber(entry.h, null, { min: 0, max: 100000 });
    out.push(att);
  }
  return out;
}

// Write via a temp file + rename so a crash mid-write can't leave a half-written
// annotations.json that wedges every subsequent /api/notes read. Rename is atomic
// within the same directory.
function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
const writeJsonAtomic = (file, obj) => writeFileAtomic(file, `${JSON.stringify(obj, null, 2)}\n`);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_FILE = path.join(HERE, "vellum-template.html");
// Path the player opens — "/vellum" at root, or "/<dir>/vellum" for a subfolder composition.
// Extension-less and fully virtual: serveStatic matches this before any disk lookup and
// returns the player template; the iframe inside loads index.html relative to this URL.
const PLAYER_PATH = COMP_DIR
  ? `/${COMP_DIR.split(path.sep).map(encodeURIComponent).join("/")}/vellum`
  : "/vellum";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".otf": "font/otf",
  ".ttf": "font/ttf",
};

function readNotes() {
  try {
    const notes = JSON.parse(fs.readFileSync(NOTES_JSON, "utf8"));
    if (!Array.isArray(notes)) throw new Error("annotations.json must contain an array");
    // Normalize on read so offline agent edits (status/severity/resolution) are coerced and
    // sanitized everywhere notes are consumed (GET/PATCH/POST/boot), without an envelope.
    // Drop non-object array elements (a stray null/number/string from a hand-edit) BEFORE they
    // reach any element-accessing path — otherwise the next POST id-calc / PATCH find / md
    // render throws inside a request handler and takes the daemon down.
    return notes.filter((n) => n && typeof n === "object").map(reconcileNote);
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw new Error(`Could not read ${path.relative(ROOT, NOTES_JSON)}: ${err.message}`);
  }
}

function withNotes(res, fn) {
  let notes;
  try {
    notes = readNotes();
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
  // Guard the handler body too: a throw here runs inside readBody's req 'end' listener, which
  // would otherwise be an uncaught exception that exits the daemon mid-review.
  try {
    return fn(notes);
  } catch (err) {
    return sendJson(res, 500, { error: `note handler failed: ${err.message}` });
  }
}

function recoverableWriteNotes(res, notes) {
  try {
    writeNotes(notes);
    return true;
  } catch (err) {
    sendJson(res, 500, { error: `Could not write notes: ${err.message}` });
    return false;
  }
}

function emptyNotesOnMissing() {
  try {
    return readNotes();
  } catch {
    return [];
  }
}

// Append one lifecycle event to the metrics ledger. Server-authored ONLY (no POST endpoint writes it),
// so the metric stays un-tamperable and the client carries no metrics code. The entire body is
// best-effort: a metrics failure must never throw into a note-write path (mirrors the client's
// best-effort postComposition). Lines are whole-JSON (appendFileSync writes one line atomically) and
// never carry note text — only ids/times/statuses/scene/kind (bounded size, no PII).
function recordMetric(ev) {
  try {
    fs.mkdirSync(NOTES_DIR, { recursive: true });
    fs.appendFileSync(METRICS_JSONL, `${JSON.stringify({ sid: SID, at: new Date().toISOString(), ...ev })}\n`);
    metricsLines += 1;
    if (metricsLines > METRICS_MAX_LINES) trimMetrics();
  } catch {}
}

// Tolerant JSONL reader: one event per line, bad/torn lines skipped (a crash mid-append can leave a
// partial last line — appendFileSync writes whole lines, so at most one is affected). Absent ledger →
// []. Never throws, so a corrupt ledger can't wedge /api/metrics or the shutdown summary.
function loadMetricsEvents() {
  try {
    const events = [];
    for (const line of fs.readFileSync(METRICS_JSONL, "utf8").split("\n")) {
      if (!line) continue;
      try { events.push(JSON.parse(line)); } catch {}
    }
    return events;
  } catch {
    return [];
  }
}

// Bound the ledger: re-count physical lines from disk (two servers sharing notes/ can desync the
// in-memory counter), keep the last METRICS_KEEP, and rewrite atomically. metricsLines is reset to the
// post-trim count so we don't rewrite on every subsequent append (hysteresis).
function trimMetrics() {
  try {
    const lines = fs.readFileSync(METRICS_JSONL, "utf8").split("\n").filter(Boolean);
    if (lines.length <= METRICS_MAX_LINES) {
      metricsLines = lines.length;
      return;
    }
    const kept = lines.slice(-METRICS_KEEP);
    writeFileAtomic(METRICS_JSONL, `${kept.join("\n")}\n`);
    metricsLines = kept.length;
  } catch {}
}

function escapeMd(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/`/g, "\\`")
    .replace(/\|/g, "\\|")
    .trim();
}

// One-line "where" for an audio note: which VO/music clip was playing (filename + local time).
function audioWhere(a) {
  if (!a) return "audio";
  const parts = [];
  if (a.voice && a.voice.src) parts.push(`VO ${escapeMd(a.voice.src)}${a.voice.at != null ? ` @ ${fmtTime(a.voice.at)}` : ""}`);
  if (a.music && a.music.src) parts.push(`music ${escapeMd(a.music.src)}`);
  return `audio: ${parts.join(", ") || "this moment"}`;
}
// Extra indented context lines for an audio note: the spoken VO line at the playhead, the
// active clip's full script, and the surrounding clips (with their scripts) — so the coding
// agent reads the actual words and can place a clip within a series.
function audioDetailLines(a) {
  if (!a) return [];
  const lines = [];
  const v = a.voice;
  if (v && v.line) lines.push(`  - VO line: "${escapeMd(v.line)}"`);
  if (v && v.script && v.script !== v.line) lines.push(`  - VO clip script: "${escapeMd(v.script)}"`);
  const neighbor = (n, label) => n && n.src
    ? `${label} ${escapeMd(n.src)}${n.start != null ? ` (${fmtTime(n.start)})` : ""}${n.script ? ` — "${escapeMd(n.script)}"` : ""}`
    : null;
  const ctx = [neighbor(a.prev, "prev"), neighbor(a.next, "next")].filter(Boolean);
  if (ctx.length) lines.push(`  - clip order: ${ctx.join("; ")}`);
  return lines;
}

// Whitelist of computed-style keys accepted on target.style — mirrors the player.
const STYLE_KEYS = new Set(["fontSize", "fontWeight", "fontFamily", "color", "backgroundColor", "lineHeight", "letterSpacing", "textAlign", "opacity"]);
const STYLE_LABELS = { fontSize: "font-size", fontWeight: "weight", fontFamily: "font", color: "color", backgroundColor: "bg", lineHeight: "line-height", letterSpacing: "tracking", textAlign: "align", opacity: "opacity" };

// Indented detail for an element-targeted note: the picker label, the element's bounds,
// and its captured data-* attrs (e.g. data-start/data-duration) — the timing/layout context
// an agent needs to act, which the note already stores but the headline line omits.
function elementDetailLine(t) {
  if (!t) return null;
  const bits = [];
  if (t.label) bits.push(`label "${escapeMd(t.label)}"`);
  if (t.box && t.box.x != null) bits.push(`box ${t.box.x},${t.box.y} ${t.box.w}×${t.box.h}%`);
  if (t.data && Object.keys(t.data).length) {
    bits.push(`data ${Object.entries(t.data).map(([k, v]) => `${escapeMd(k)}=${escapeMd(String(v))}`).join(", ")}`);
  }
  return bits.length ? `  - element: ${bits.join(" · ")}` : null;
}
// The element's current computed style at pin time — what an "make it bigger/bolder/another
// color" edit starts from. Ordered + relabeled for readability.
function styleDetailLine(t) {
  if (!t || !t.style) return null;
  const bits = Object.keys(STYLE_LABELS).filter((k) => t.style[k]).map((k) => `${STYLE_LABELS[k]} ${escapeMd(String(t.style[k]))}`);
  return bits.length ? `  - style: ${bits.join(" · ")}` : null;
}
// Desired-state markup as agent-facing sub-lines: the box delta on a `- desired:` line and the
// from→to arrow on a `- direction:` line. Phrasing comes from the shared describeDesiredDelta,
// which returns the box/arrow pieces structured so we label each directly. Returns [] when the
// note carries neither field, so legacy notes render byte-identically.
function desiredDetailLine(n) {
  const d = describeDesiredDelta(n);
  if (!d) return [];
  const lines = [];
  if (d.box) lines.push(`  - desired: ${d.box}`);
  if (d.arrow) lines.push(`  - direction: ${d.arrow}`);
  return lines;
}

// The coding agent's write-back: what it changed to address the note. Renders a headline
// resolution line (who/when + one-line summary) plus one `- edit:` line per file/selector
// touched. PATCH/offline-authored and bounded by sanitizeResolution; guarded by n.resolution
// at the call site so notes without a write-back render byte-identically to before.
function resolutionDetailLines(r) {
  if (!r) return [];
  const at = r.at ? ` · ${escapeMd(r.at)}` : "";
  const summary = r.summary ? ` — ${escapeMd(r.summary)}` : "";
  const lines = [`  - resolution by ${escapeMd(r.by || "agent")}${at}${summary}`];
  if (Array.isArray(r.edits)) {
    for (const e of r.edits) {
      const bits = [];
      if (e.file != null) bits.push(`\`${escapeMd(e.file)}\``);
      if (e.selector != null) bits.push(`at \`${escapeMd(e.selector)}\``);
      if (e.detail != null) bits.push(escapeMd(e.detail));
      if (bits.length) lines.push(`  - edit: ${bits.join(" · ")}`);
    }
  }
  return lines;
}

// Human-readable byte size for the attachment markdown hint: "84 KB" / "3.1 MB" / "512 B".
function humanBytes(n) {
  const b = Number(n) || 0;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${Math.round(b / 1e3)} KB`;
  return `${b} B`;
}
// Reference-image sub-line: the openable notes-relative path(s) the agent should view before acting,
// each with a (TYPE, W×H, size) hint. Guarded by n.attachments?.length at the call site so notes
// without attachments render byte-identically. Scope-independent — element, scene, audio, and span
// notes can all carry sketches.
function attachmentDetailLine(n) {
  // Array.isArray (not just truthy .length): a hand-edited note with attachments set to a string
  // ("sketch.png") or {length:N} would otherwise pass and throw on .map, wedging every write.
  if (!Array.isArray(n.attachments) || !n.attachments.length) return null;
  const parts = n.attachments.map((a) => {
    const label = (ATTACH_TYPES[a.type] || "img").toUpperCase();
    const dims = a.w != null && a.h != null ? `, ${a.w}×${a.h}` : "";
    const size = a.bytes != null ? `, ${humanBytes(a.bytes)}` : "";
    return `\`${escapeMd(a.file)}\` (${label}${dims}${size})`;
  });
  return `  - ref images: ${parts.join("; ")}`;
}

// Reviewer-assigned severity as a bold headline token (` · **blocker**`) — distinct from the
// italic status tag and orthogonal to it. Empty when unset, so severity-less notes render
// byte-identically to before. Normalized defensively in case an offline edit slipped a raw value.
function severityTag(n) {
  const s = normalizeNoteSeverity(n && n.severity);
  return s ? ` · **${s}**` : "";
}

// Render one note as its markdown block: a headline line plus any indented detail sub-lines
// (audio context / element + style). `indent` shifts the whole block right (e.g. when notes
// are clustered under a shared-element header). `manifest` is the composition map, available
// for richer headlines. Returns the joined block — the single seam every md-touching feature
// funnels through, so loose and clustered notes share one render path.
function renderNoteBlock(n, manifest, indent = 0) {
  const pad = " ".repeat(indent);
  // Scoped notes (whole scene / audio / time span) describe their subject instead of a pin/box + element.
  const scoped = n.kind === "scene" || n.kind === "audio" || n.kind === "span";
  // An optional timeEnd > time makes the note an [time, timeEnd] interval; absent = today's point note.
  const span = n.timeEnd != null && n.timeEnd > n.time;
  const dur = span ? (n.timeEnd - n.time).toFixed(2) : null;
  let where = n.kind === "scene" ? "whole scene"
    : n.kind === "audio" ? audioWhere(n.audio)
    : n.kind === "span" ? (span ? `${dur}s span` : "time span")
    : n.w != null ? `box ${n.x},${n.y} ${n.w}×${n.h}%` : n.x != null ? `pin ${n.x}%, ${n.y}%` : "";
  // A non-span note that still carries an interval appends the duration so the parenthetical conveys it.
  if (span && n.kind !== "span" && where) where += ` · ${dur}s span`;
  const noteText = escapeMd(n.text);
  const targetText = !scoped && n.target && n.target.text ? ` "${escapeMd(n.target.text)}"` : "";
  const tgt = !scoped && n.target
    ? ` · on \`${escapeMd(n.target.tag)}${n.target.cls ? "." + escapeMd(n.target.cls) : ""}\`${targetText}`
    : "";
  const sel = !scoped && n.target && n.target.selector ? ` · at \`${escapeMd(n.target.selector)}\`` : "";
  const status = normalizeNoteStatus(n.status);
  const statusTag = status !== "open" ? ` · _(${status})_` : "";
  // Content drift: the note was pinned against an index.html whose sha256 differs from the
  // composition's current mount baseline. Pure string compare of on-disk data (zero cost);
  // guarded by n.provenance && so pre-feature notes render identically.
  const baseHash = manifest && manifest.provenance && manifest.provenance.indexHash;
  const staleTag = baseHash && n.provenance && n.provenance.indexHash && n.provenance.indexHash !== baseHash
    ? " · _(stale: composition changed since pinned)_"
    : "";
  const head = `- **note-${n.id}** · **${span ? `${fmtTime(n.time)}–${fmtTime(n.timeEnd)}` : fmtTime(n.time)}**${n.scene ? ` \`${escapeMd(n.scene)}\`` : ""}${severityTag(n)} — ${noteText}${where ? `  _(${where})_` : ""}${tgt}${sel}${statusTag}${staleTag}`;
  const baseExtra = n.kind === "audio" ? audioDetailLines(n.audio)
    : scoped ? []
    : [elementDetailLine(n.target), styleDetailLine(n.target), ...desiredDetailLine(n)].filter(Boolean);
  // Agent write-back sub-lines (resolution + per-edit) append after the element/audio context, and
  // any reference-image paths follow last — each present only when the note carries that field.
  const extra = [
    ...baseExtra,
    ...(n.resolution ? resolutionDetailLines(n.resolution) : []),
    ...(Array.isArray(n.attachments) && n.attachments.length ? [attachmentDetailLine(n)] : []),
  ];
  return [head, ...extra].map((line) => `${pad}${line}`).join("\n");
}

// Severity ranks for ordering the markdown: blocker floats to the top, nits sink, and an unset
// note ranks between major and nit so untagged feedback stays roughly chronological. (Deliberately
// NOT NOTE_SEVERITIES.indexOf — unset must sit at 2, between major=1 and nit=3.)
const SEVERITY_RANK = { blocker: 0, major: 1, nit: 3 };
function severityRank(n) {
  const s = normalizeNoteSeverity(n && n.severity);
  return s ? SEVERITY_RANK[s] : 2;
}

// Group notes that pin the same DOM element (shared target.selector, ≥2 of them) into a cluster so
// the consuming agent fixes all feedback on one element together, then order every unit (loose note
// or cluster) by [severity, time, id] so blockers come first. Pure render-time grouping over the same
// flat array — annotations.json stays a bare top-level array, so no reader/envelope changes. Scoped
// (scene/audio) notes and untargeted pins never cluster: each is a loose single rendered as before.
function clusterNoteUnits(notes) {
  const bySelector = new Map();
  const units = [];
  for (const n of notes) {
    const scoped = n.kind === "scene" || n.kind === "audio" || n.kind === "span";
    const selector = !scoped && n.target && n.target.selector ? n.target.selector : null;
    if (selector) {
      if (!bySelector.has(selector)) bySelector.set(selector, []);
      bySelector.get(selector).push(n);
    } else {
      units.push({ members: [n] });
    }
  }
  for (const [selector, members] of bySelector) {
    if (members.length >= 2) {
      members.sort((a, b) => severityRank(a) - severityRank(b) || a.time - b.time || a.id - b.id);
      units.push({ selector, members });
    } else {
      units.push({ members });
    }
  }
  const unitKey = (u) => u.members.reduce(
    (k, m) => ({ sev: Math.min(k.sev, severityRank(m)), time: Math.min(k.time, m.time), id: Math.min(k.id, m.id) }),
    { sev: Infinity, time: Infinity, id: Infinity }
  );
  return units
    .map((u) => ({ unit: u, key: unitKey(u) }))
    .sort((a, b) => a.key.sev - b.key.sev || a.key.time - b.key.time || a.key.id - b.key.id)
    .map((x) => x.unit);
}

// Render a unit as markdown: a loose note is one block; a cluster is a header bullet
// (`- **N notes on `tag.cls`** · **<topSev>** · at `selector``) followed by each member block
// indented two spaces so they read as belonging to the element.
function renderNoteUnit(unit, manifest) {
  if (!unit.selector) return renderNoteBlock(unit.members[0], manifest);
  const top = unit.members[0]; // members are pre-sorted, so the first is the top-severity one
  const tagCls = top.target ? `${escapeMd(top.target.tag)}${top.target.cls ? "." + escapeMd(top.target.cls) : ""}` : "";
  const header = `- **${unit.members.length} notes on \`${tagCls}\`**${severityTag(top)} · at \`${escapeMd(unit.selector)}\``;
  return [header, ...unit.members.map((m) => renderNoteBlock(m, manifest, 2))].join("\n");
}

function writeNotes(notes) {
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  writeJsonAtomic(NOTES_JSON, notes);
  // Severity-then-time ordering with same-element clustering (pure render-time; the JSON above
  // stays a bare chronological array). Loose notes and clusters share the one renderNoteBlock path.
  const units = clusterNoteUnits(notes);
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(COMP_JSON, "utf8")); } catch {}
  const dims = manifest && manifest.width && manifest.height ? ` on a ${manifest.width}×${manifest.height} composition` : "";
  const hasMap = manifest && Array.isArray(manifest.scenes) && manifest.scenes.length;
  // Review baseline citation — the commit + index.html hash this review was pinned against,
  // so the consuming agent can `git show`/`git diff` the exact source and spot drift. Only
  // emitted when the manifest carries provenance (git-less / manifest-less comps stay byte-
  // identical to before).
  const prov = manifest && manifest.provenance;
  let baselineLine = null;
  if (prov && (prov.commit || prov.indexHash)) {
    const bits = [];
    if (prov.commit) bits.push(`commit \`${prov.commit.slice(0, 7)}\``);
    if (prov.indexHash) bits.push(`index \`${prov.indexHash}\``);
    baselineLine = `Review baseline: ${bits.join(" · ")}`;
  }
  const md = [
    `# Review notes${COMP_DIR ? ` — ${COMP_DIR}` : ""}`,
    "",
    `${notes.length} note(s)${dims}. Times are composition-time (M:SS.ss).${hasMap ? " Scene & clip timings: `composition.json` (same folder)." : ""}`,
    ...(baselineLine ? [baselineLine] : []),
    "Legend: `_(where)_` = pin/box/whole-scene/audio/time-span · `on tag.cls` = targeted element · `at selector` = exact DOM path · `box` = element bounds x,y w×h (% of frame) · `data-*` = the element's own timing attrs · `M:SS.ss` = a point in time, `M:SS.ss–M:SS.ss` = an in/out time span · `· **<sev>**` = reviewer severity (blocker > major > nit) · `_(stale: …)_` = composition's index.html changed since the note was pinned · `- desired: …` = the target position/size the reviewer wants (a delta from the current box) · `- direction: …` = a from→to arrow the reviewer drew · `- resolution …` = the coding agent's write-back of what it changed · `- ref images: …` = reference sketch paths under notes/ the agent can open · status ∈ open / addressed / resolved / wontfix. Notes sharing an element are grouped under a header; blockers first.",
    "",
    ...units.map((u) => renderNoteUnit(u, manifest)),
    "",
  ].join("\n");
  // Self-measured review diagnostics footer — note-derived ONLY (computeMetrics(notes, []) reads no
  // ledger on the write hot path; applyNotePatch already mutated the counters before this write).
  // Own try/catch so a metrics failure never costs the notes md; rendered only when notes exist.
  let footer = "";
  if (notes.length) {
    try {
      const m = computeMetrics(notes, []);
      const rate = m.firstPass.rate == null ? "n/a" : `${Math.round(m.firstPass.rate * 100)}%`;
      const lat = m.resolveLatencyMs;
      footer = [
        "---",
        "## Metrics",
        "",
        "_Self-measured review diagnostics, not feedback to action (see SKILL.md)._",
        "",
        `- Notes: ${m.notes.total} (${m.notes.open} open · ${m.notes.addressed} addressed · ${m.notes.resolved} resolved · ${m.notes.wontfix} wontfix)`,
        `- First-pass fix rate: ${rate} (${m.firstPass.fixed} fixed · ${m.firstPass.reopened} reopened)`,
        ...(lat ? [`- Create→resolve latency: median ${fmtDuration(lat.median)} · avg ${fmtDuration(lat.avg)} (n=${lat.count})`] : []),
        "",
      ].join("\n");
    } catch { footer = ""; }
  }
  writeFileAtomic(NOTES_MD, md + footer);
}

function sendJson(res, code, body) {
  // No CORS headers: the player is served from this same origin, so cross-origin
  // requests are rejected by the browser — keeps the notes API local-only.
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req, res, limit, done) {
  let body = "";
  let tooLarge = false;
  req.on("data", (c) => {
    if (tooLarge) return;
    body += c;
    if (body.length > limit) {
      tooLarge = true;
      sendJson(res, 413, { error: "request body too large" });
      req.resume();
    }
  });
  req.on("end", () => {
    if (tooLarge) return;
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return sendJson(res, 400, { error: "invalid json" });
    }
    done(parsed);
  });
  req.on("error", () => {
    if (!res.headersSent) sendJson(res, 400, { error: "request failed" });
  });
}

// Binary sibling of readBody for the raw-bytes upload endpoint: collect Buffer chunks up to `limit`
// (413 + drain on overflow) and hand the assembled Buffer to `done`. Does NOT JSON.parse — readBody
// is unusable for image bytes, so this is a parallel reader, not a reuse.
function readRawBody(req, res, limit, done) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  req.on("data", (c) => {
    if (tooLarge) return;
    size += c.length;
    if (size > limit) {
      tooLarge = true;
      sendJson(res, 413, { error: "request body too large" });
      req.resume();
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    if (tooLarge) return;
    done(Buffer.concat(chunks));
  });
  req.on("error", () => {
    if (!res.headersSent) sendJson(res, 400, { error: "request failed" });
  });
}

// Cheap magic-byte check: the declared content-type must match the actual leading bytes, so a
// renamed non-image (or an empty/zero-byte body) can't land a bogus file in the user's project tree.
function sniffImage(buf, ext) {
  if (!buf || buf.length < 4) return false;
  if (ext === "png") return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (ext === "jpg") return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (ext === "gif") return buf.length >= 6 && buf.toString("latin1", 0, 4) === "GIF8";
  if (ext === "webp") return buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP";
  return false;
}

function boundedNumber(value, fallback, { min = -Infinity, max = Infinity, decimals = 10 } = {}) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const bounded = Math.min(max, Math.max(min, n));
  return Math.round(bounded * decimals) / decimals;
}

// A single percent-of-comp coordinate clamped to 0–100 (null on absent/garbage) — the same
// bound target.box uses. Module-scope so both the POST sanitizer and applyNotePatch share one
// clamp; the local `pct` in handleNotes delegates here so the logic isn't duplicated.
const clampPct = (v) => boundedNumber(v, null, { min: 0, max: 100 });

// Desired-state ghost box (where/how big the element SHOULD be), % of comp. All-or-nothing — any
// non-finite axis drops the whole field — and requires positive size (w>0 && h>0), mirroring the
// POST target.box block. Returns null on bad/absent input so it slots into an optional-spread.
function sanitizeDesiredBox(raw) {
  if (!raw || typeof raw !== "object") return null;
  const box = { x: clampPct(raw.x), y: clampPct(raw.y), w: clampPct(raw.w), h: clampPct(raw.h) };
  if (Object.values(box).some((v) => v == null)) return null;
  if (!(box.w > 0 && box.h > 0)) return null;
  return box;
}

// Desired-state arrow (a from→to direction), % of comp. All four points required; a zero-length
// arrow (|dx|<0.1 && |dy|<0.1) is rejected, mirroring the timeEnd<=time and span-range epsilon
// rejections. Returns null on bad/absent/degenerate input.
function sanitizeArrow(raw) {
  if (!raw || typeof raw !== "object") return null;
  const a = { x1: clampPct(raw.x1), y1: clampPct(raw.y1), x2: clampPct(raw.x2), y2: clampPct(raw.y2) };
  if (Object.values(a).some((v) => v == null)) return null;
  if (Math.abs(a.x2 - a.x1) < 0.1 && Math.abs(a.y2 - a.y1) < 0.1) return null;
  return a;
}

function noteId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function applyNotePatch(note, parsed) {
  const now = new Date().toISOString();
  if (parsed.text != null) {
    const text = String(parsed.text).slice(0, 2000).trim();
    if (!text) return { error: "empty note" };
    note.text = text;
  }
  if (parsed.status != null) {
    // Capture the prev status BEFORE mutating, so the self-measurement counters reason over the real
    // transition. The two counters live inside the note record (so the live summary needs zero ledger
    // I/O) and are mutated before the write below, so they persist in the same atomic write and the
    // md footer reflects them immediately. firstResolvedAt stamps once on the first →resolved (never
    // overwritten — distinct from updatedAt, which every edit clobbers). reopenCount counts a failed
    // first pass: an agent-edited note kicked back to open. wontfix→open is uncounted (never fixed).
    // firstAddressedAt marks the first time the agent *fixed* it (addressed OR resolved) — it is the
    // first-pass denominator population, so reopenCount stays a subset of it and the rate can't go
    // negative on the normal open→addressed→open flow. firstResolvedAt is kept solely for latency.
    const prev = normalizeNoteStatus(note.status);
    const next = normalizeNoteStatus(parsed.status, note.status || "open");
    note.status = next;
    if ((next === "addressed" || next === "resolved") && !note.firstAddressedAt) note.firstAddressedAt = now;
    if (next === "resolved" && !note.firstResolvedAt) note.firstResolvedAt = now;
    if ((prev === "resolved" || prev === "addressed") && next === "open") note.reopenCount = (note.reopenCount || 0) + 1;
  }
  // Severity uses key-presence (not != null) so the client can CLEAR it by sending null/"" — a
  // valid enum value sets it, anything else deletes the field. Absent key leaves it untouched.
  if ("severity" in parsed) {
    const severity = normalizeNoteSeverity(parsed.severity, null);
    if (severity) note.severity = severity;
    else delete note.severity;
  }
  // Reference images: a present `attachments` key fully replaces the set (the player sends the
  // surviving list on edit); absent leaves it untouched so status-only/text-only PATCHes (and the
  // status cycle) never clear sketches. Invalid/empty → field removed.
  if (parsed.attachments != null) {
    const a = sanitizeAttachments(parsed.attachments);
    if (a.length) note.attachments = a;
    else delete note.attachments;
  }
  // Agent write-back (PATCH/offline-only): an object records what the agent changed (bounded,
  // `at` server-stamped if missing/bad); null clears it. `undefined` (key absent) leaves an
  // existing resolution untouched, so a status-only PATCH — e.g. a human verifying
  // addressed→resolved — keeps the audit trail.
  if (parsed.resolution !== undefined) {
    const resolution = parsed.resolution === null ? null : sanitizeResolution(parsed.resolution);
    if (resolution) note.resolution = resolution;
    else delete note.resolution;
  }
  // Desired-state markup uses key-presence (mirroring severity): a present `desiredBox`/`arrow`
  // key replaces the field, or clears it when null/invalid; an absent key leaves it untouched, so a
  // status-only/text-only PATCH (or the status cycle) never wipes the ghost/arrow. PATCH never
  // flips scope, so these aren't re-forced-null against kind here.
  if ("desiredBox" in parsed) {
    const d = sanitizeDesiredBox(parsed.desiredBox);
    if (d) note.desiredBox = d;
    else delete note.desiredBox;
  }
  if ("arrow" in parsed) {
    const a = sanitizeArrow(parsed.arrow);
    if (a) note.arrow = a;
    else delete note.arrow;
  }
  note.updatedAt = now;
  return { note };
}

function handleNoteById(req, res, idValue) {
  const id = noteId(idValue);
  if (!id) return sendJson(res, 400, { error: "invalid note id" });

  if (req.method === "DELETE") {
    return withNotes(res, (notes) => {
      const removed = notes.find((n) => n.id === id);
      const next = notes.filter((n) => n.id !== id);
      if (next.length === notes.length) return sendJson(res, 404, { error: "note not found" });
      if (!recoverableWriteNotes(res, next)) return;
      logEvent(ui.glyph.del, `${noteLabel(removed)} deleted`);
      recordMetric({ type: "delete", id });
      return sendJson(res, 200, { ok: true, notes: next });
    });
  }

  if (req.method === "PATCH") {
    return readBody(req, res, 1e6, (parsed) =>
      withNotes(res, (notes) => {
        const note = notes.find((n) => n.id === id);
        if (!note) return sendJson(res, 404, { error: "note not found" });
        const prevStatus = normalizeNoteStatus(note.status);
        const result = applyNotePatch(note, parsed);
        if (result.error) return sendJson(res, 400, { error: result.error });
        if (!recoverableWriteNotes(res, notes)) return;
        const newStatus = normalizeNoteStatus(note.status);
        if (newStatus !== prevStatus) {
          const glyph = newStatus === "open" ? ui.glyph.add : newStatus === "resolved" ? ui.glyph.ok : ui.glyph.edit;
          logEvent(glyph, `${noteLabel(note)} ${newStatus === "open" ? "reopened" : newStatus}`);
          recordMetric({ type: "status", id, from: prevStatus, to: newStatus });
        } else if (parsed.text != null) {
          logEvent(ui.glyph.edit, `${noteLabel(note)} edited ${ui.dim(`— "${ui.truncate(note.text, 48)}"`)}`);
          recordMetric({ type: "edit", id });
        }
        return sendJson(res, 200, result.note);
      })
    );
  }

  return sendJson(res, 405, { error: "method not allowed" });
}

function handleNotes(req, res) {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  if (req.method === "GET") return withNotes(res, (notes) => sendJson(res, 200, notes));
  if (req.method === "DELETE") {
    const count = emptyNotesOnMissing().length; // capture BEFORE writing [] so the ledger keeps the size
    if (!recoverableWriteNotes(res, [])) return;
    logEvent(ui.glyph.del, "all notes cleared");
    recordMetric({ type: "clear", count });
    return sendJson(res, 200, { ok: true, notes: [] });
  }
  if (req.method === "POST") {
    return readBody(req, res, 1e6, (parsed) => {
      const text = String(parsed.text ?? "").slice(0, 2000).trim();
      if (!text) return sendJson(res, 400, { error: "empty note" });
      const pct = clampPct; // bounded percent-of-comp coordinate; shared with the sanitizers above
      let target = null;
      if (parsed.target && typeof parsed.target === "object") {
        // Element bounding box at pin time (percent of comp size) — lets vellum-review
        // draw the actual element outline instead of a generic marker.
        let box = null;
        const b = parsed.target.box;
        if (b && typeof b === "object") {
          const candidate = { x: pct(b.x), y: pct(b.y), w: pct(b.w), h: pct(b.h) };
          if (Object.values(candidate).every((v) => v != null)) box = candidate;
        }
        // data-* attributes captured from the element (e.g. data-start/data-duration) —
        // timing context the agent can use directly. Keys/values capped defensively.
        let data = null;
        if (parsed.target.data && typeof parsed.target.data === "object" && !Array.isArray(parsed.target.data)) {
          data = {};
          for (const [k, v] of Object.entries(parsed.target.data)) {
            if (!/^data-[\w-]{1,40}$/.test(k)) continue;
            data[k] = String(v).slice(0, 120);
            if (Object.keys(data).length >= 12) break;
          }
          if (!Object.keys(data).length) data = null;
        }
        // Computed style at pin time (whitelisted) — the current value an edit starts from.
        let style = null;
        if (parsed.target.style && typeof parsed.target.style === "object" && !Array.isArray(parsed.target.style)) {
          style = {};
          for (const [k, v] of Object.entries(parsed.target.style)) {
            if (!STYLE_KEYS.has(k)) continue;
            style[k] = String(v).slice(0, 80);
          }
          if (!Object.keys(style).length) style = null;
        }
        target = {
          tag: String(parsed.target.tag ?? "").slice(0, 20),
          cls: String(parsed.target.cls ?? "").slice(0, 120),
          text: String(parsed.target.text ?? "").slice(0, 120),
          selector: parsed.target.selector ? String(parsed.target.selector).slice(0, 250) : null,
          label: parsed.target.label ? String(parsed.target.label).slice(0, 80) : null,
          box,
          data,
          style,
        };
      }
      // Time: a point (just `time`) or an [time, timeEnd] interval. timeEnd is bounded like every
      // number and dropped unless strictly greater than time, so an inverted/zero-length range can
      // never persist — absent timeEnd serializes byte-identically to today's point note.
      const time = boundedNumber(parsed.time, 0, { min: 0, decimals: 100 });
      let timeEnd = boundedNumber(parsed.timeEnd, null, { min: 0, decimals: 100 });
      if (timeEnd == null || timeEnd <= time) timeEnd = null;
      // Scope: "scene" (the whole current slide), "audio" (what's playing now), or "span" (a pure
      // timeline range, no element/pin). Anything else is a normal element/region/pin note, so kind
      // stays null and isn't stored.
      const kind = parsed.kind === "scene" || parsed.kind === "audio" || parsed.kind === "span" ? parsed.kind : null;
      // A scoped note (scene/audio/span) describes a moment/range, not an element or pin — force
      // target + coords to null so a hand-authored/buggy client can never persist stale element
      // data that would render as dead, never-shown fields. (The player already omits them.)
      const scopedKind = kind === "scene" || kind === "audio" || kind === "span";
      const audio = kind === "audio" ? sanitizeAudio(parsed.audio) : null;
      // Reference images attached to the note (paste/drag/file-pick → uploaded via /api/attachments,
      // then referenced here). Re-validated against the on-disk files and bounded at MAX_ATTACHMENTS;
      // optional spread keeps attachment-less notes byte-identical.
      const attachments = sanitizeAttachments(parsed.attachments);
      // Reviewer-assigned triage severity (blocker/major/nit) — orthogonal to kind/status, enum-
      // bounded by normalizeNoteSeverity (garbage → null → field omitted). Optional spread keeps
      // severity-less notes byte-identical.
      const severity = normalizeNoteSeverity(parsed.severity);
      // Desired-state markup: where the element SHOULD be (ghost box) and/or a from→to direction
      // (arrow), both % of comp. Forced null on scoped notes (no element/pin to move) like x/y/w/h,
      // and bounded all-or-nothing by the module-scope sanitizers; optional spread keeps notes
      // without them byte-identical.
      const desiredBox = scopedKind ? null : sanitizeDesiredBox(parsed.desiredBox);
      const arrow = scopedKind ? null : sanitizeArrow(parsed.arrow);
      // Server-authored baseline this note is pinned against (commit + index.html hash).
      // Stamped here, never read from parsed (a client cannot spoof it); immutable on PATCH.
      const prov = computeProvenance();
      return withNotes(res, (notes) => {
        const note = {
          id: notes.length ? Math.max(...notes.map((n) => n.id || 0)) + 1 : 1,
          time,
          ...(timeEnd != null ? { timeEnd } : {}),
          x: scopedKind ? null : pct(parsed.x),
          y: scopedKind ? null : pct(parsed.y),
          w: scopedKind ? null : pct(parsed.w),
          h: scopedKind ? null : pct(parsed.h),
          scene: parsed.scene ? String(parsed.scene).slice(0, 60) : null,
          target: scopedKind ? null : target,
          ...(desiredBox ? { desiredBox } : {}),
          ...(arrow ? { arrow } : {}),
          ...(kind ? { kind } : {}),
          ...(audio ? { audio } : {}),
          ...(attachments.length ? { attachments } : {}),
          ...(severity ? { severity } : {}),
          text,
          status: "open",
          ...(prov ? { provenance: prov } : {}),
          createdAt: new Date().toISOString(),
        };
        notes.push(note);
        if (!recoverableWriteNotes(res, notes)) return;
        logEvent(ui.glyph.add, `${noteLabel(note)} ${ui.dim(`— "${ui.truncate(note.text, 48)}"`)}`);
        // Ledger AFTER the confirmed write — a 500 (e.g. malformed existing JSON) leaves no phantom
        // create event. No note text is stored, only id/time/scene/kind.
        recordMetric({ type: "create", id: note.id, t: note.time, scene: note.scene, kind: note.kind || null });
        return sendJson(res, 201, note);
      });
    });
  }
  return sendJson(res, 405, { error: "method not allowed" });
}

// POST /api/attachments — raw-binary image upload (NOT JSON/base64; base64 would inflate ~33% and
// blow the readBody cap). The content-type header picks the extension from the allowlist (415 on a
// type we don't store — SVG is deliberately absent), the magic bytes must match it (415 on mismatch),
// the body is capped at IMG_LIMIT (413 over), and the filename is 100% server-generated so the stored
// path can never be client-controlled (resolveInside is belt-and-suspenders on that name). Returns
// {file,name,bytes,type}; the browser merges intrinsic w/h before referencing it on a note.
function handleAttachments(req, res) {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
  const mime = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  const ext = ATTACH_TYPES[mime];
  if (!ext) {
    req.resume(); // drain the upload we're rejecting so the socket frees
    return sendJson(res, 415, { error: "unsupported image type" });
  }
  return readRawBody(req, res, IMG_LIMIT, (buf) => {
    if (!buf.length || !sniffImage(buf, ext)) return sendJson(res, 415, { error: "unsupported image type" });
    const name = `att-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
    const full = resolveInside(ATTACH_DIR, name);
    if (!full) return sendJson(res, 500, { error: "could not store attachment" });
    try {
      fs.mkdirSync(ATTACH_DIR, { recursive: true });
      writeFileAtomic(full, buf);
    } catch (err) {
      return sendJson(res, 500, { error: `could not store attachment: ${err.message}` });
    }
    logEvent(ui.glyph.add, `attachment saved ${ui.dim(`— ${name} (${humanBytes(buf.length)})`)}`);
    return sendJson(res, 201, { file: `attachments/${name}`, name, bytes: buf.length, type: mime });
  });
}

function handleMix(req, res) {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  if (req.method === "GET") {
    try {
      return sendJson(res, 200, JSON.parse(fs.readFileSync(MIX_JSON, "utf8")));
    } catch {
      return sendJson(res, 200, {});
    }
  }
  if (req.method === "POST") {
    return readBody(req, res, 1e5, (parsed) => {
      const mix = {
        voice: boundedNumber(parsed.voice, 1, { min: 0, max: 1, decimals: 100 }),
        music: boundedNumber(parsed.music, 0.2, { min: 0, max: 1, decimals: 100 }),
        savedAt: new Date().toISOString(),
      };
      try {
        fs.mkdirSync(NOTES_DIR, { recursive: true });
        writeJsonAtomic(MIX_JSON, mix);
      } catch (err) {
        return sendJson(res, 500, { error: `could not save mix: ${err.message}` });
      }
      logEvent(ui.glyph.music, `mix saved ${ui.dim(`— voice ${Math.round(mix.voice * 100)}% · music ${Math.round(mix.music * 100)}%`)}`);
      return sendJson(res, 201, mix);
    });
  }
  return sendJson(res, 405, { error: "method not allowed" });
}

// notes/composition.json — a bounded scene/timing manifest the player POSTs once at mount.
// It gives the consuming agent the full scene map + audio clip layout to resolve any note's
// scene window and timing without re-parsing the composition. The browser is the source of
// truth (it ran the GSAP timeline); the server only sanitizes and persists.
function handleComposition(req, res) {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  if (req.method === "GET") {
    try { return sendJson(res, 200, JSON.parse(fs.readFileSync(COMP_JSON, "utf8"))); }
    catch { return sendJson(res, 200, {}); }
  }
  if (req.method === "POST") {
    return readBody(req, res, 2e5, (parsed) => {
      const num = (v) => boundedNumber(v, null, { min: 0, decimals: 1000 });
      const clip = (c) => c && typeof c === "object"
        ? { src: c.src != null ? String(c.src).slice(0, 200) : null, start: num(c.start), dur: c.dur != null ? num(c.dur) : null }
        : null;
      const clips = (x) => (Array.isArray(x) ? x.slice(0, 100).map(clip).filter(Boolean) : []);
      const scenes = Array.isArray(parsed.scenes)
        ? parsed.scenes.slice(0, 300).map((s) => ({ id: String((s && s.id) ?? "").slice(0, 80), start: num(s && s.start), duration: s && s.duration != null ? num(s.duration) : null }))
        : [];
      const manifest = {
        composition: COMP_DIR ? `${COMP_DIR}/index.html` : "index.html",
        width: boundedNumber(parsed.width, null, { min: 0, max: 100000 }),
        height: boundedNumber(parsed.height, null, { min: 0, max: 100000 }),
        duration: num(parsed.duration),
        fps: parsed.fps != null ? boundedNumber(parsed.fps, null, { min: 0, max: 1000, decimals: 1000 }) : null,
        scenes,
        audio: { voice: clips(parsed.audio && parsed.audio.voice), music: clips(parsed.audio && parsed.audio.music) },
        captions: Boolean(parsed.captions),
        tool: `vellum ${VERSION}`,
        savedAt: new Date().toISOString(),
        // Per-file mount baseline (same helper as the per-note stamp) — the reference hash the
        // annotations.md header cites and the player diffs each note against to flag drift.
        provenance: computeProvenance(),
      };
      try {
        fs.mkdirSync(NOTES_DIR, { recursive: true });
        writeJsonAtomic(COMP_JSON, manifest);
      } catch (err) {
        return sendJson(res, 500, { error: `could not save composition: ${err.message}` });
      }
      // The real "review player opened" signal — the primary time-to-note anchor in the ledger.
      recordMetric({ type: "mount" });
      // Return the baseline in the round-trip the player already makes so it can capture the
      // current content hash without a second GET.
      return sendJson(res, 201, { ok: true, scenes: manifest.scenes.length, provenance: manifest.provenance });
    });
  }
  return sendJson(res, 405, { error: "method not allowed" });
}

// GET /api/metrics — the self-measured review summary. Note-derived stats (counts, first-pass rate,
// resolve latency) come from the live notes array via withNotes(readNotes) — so it inherits the
// 500-on-corrupt-array behavior for parity with /api/notes; time-to-note comes from the tolerant
// ledger (a corrupt ledger is skipped, never 500s). No POST: the ledger is server-authored only, so
// the metric can't be spoofed and the client stays metrics-free. ?events=1 also returns the bounded
// raw events for offline recompute.
function handleMetrics(req, res) {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
  return withNotes(res, (notes) => {
    const events = loadMetricsEvents();
    const summary = computeMetrics(notes, events);
    const wantEvents = new URL(req.url, "http://localhost").searchParams.get("events") === "1";
    return sendJson(res, 200, wantEvents ? { summary, events } : summary);
  });
}

function serveTemplate(res) {
  let html;
  try {
    html = fs.readFileSync(TEMPLATE_FILE, "utf8");
  } catch {
    res.writeHead(500);
    return res.end("vellum-template.html missing");
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
  res.end(html);
}

function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    res.writeHead(400);
    return res.end("bad request");
  }

  // The player template is served only at the configured review URL. This keeps
  // iframe composition paths aligned with the notes directory.
  if (pathname === "/" || pathname === PLAYER_PATH) {
    return serveTemplate(res);
  }

  const full = resolveInside(ROOT, `.${pathname}`);
  if (!full) {
    res.writeHead(403);
    return res.end("forbidden");
  }

  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      // npx-style HyperFrames projects have no local node_modules/hyperframes; resolve the
      // injected runtime from the npx cache or the CDN instead of 404ing.
      if (pathname === HF_BASE || pathname.startsWith(`${HF_BASE}/`)) {
        return serveHyperframesRuntime(req, res, pathname);
      }
      res.writeHead(404);
      return res.end("not found");
    }
    const type = MIME[path.extname(full).toLowerCase()] || "application/octet-stream";

    // HTTP Range support — required for the browser to seek <audio>/<video>, which is
    // how playback works anywhere but t=0 in the review player.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : null;
      let end = range[2] ? Number(range[2]) : null;
      if (start === null) {
        const suffixLength = end || 0;
        start = Math.max(0, st.size - suffixLength);
        end = st.size - 1;
      } else if (end === null || end >= st.size) {
        end = st.size - 1;
      }
      if (start > end || start >= st.size) {
        res.writeHead(416, { "content-range": `bytes */${st.size}` });
        return res.end();
      }
      res.writeHead(206, {
        "content-type": type,
        "content-range": `bytes ${start}-${end}/${st.size}`,
        "content-length": end - start + 1,
        "accept-ranges": "bytes",
        "cache-control": "no-cache",
      });
      const stream = fs.createReadStream(full, { start, end });
      stream.on("error", () => res.destroy());
      return stream.pipe(res);
    }

    res.writeHead(200, {
      "content-type": type,
      "content-length": st.size,
      "accept-ranges": "bytes",
      "cache-control": "no-cache",
    });
    const stream = fs.createReadStream(full);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  });
}

// Skip the dirs Vellum itself writes to (notes/ is load-bearing — see compRev) plus heavy/irrelevant
// trees and editor/atomic-write noise. `filename` is the path relative to COMP_ABS (recursive watch)
// or a bare basename (non-recursive fallback); split path.sep-aware and test the first segment.
function shouldIgnoreWatchPath(filename) {
  const parts = String(filename).split(/[\\/]/);
  const first = parts[0];
  const base = parts[parts.length - 1];
  if (first === "notes" || first === "snapshots" || first === "node_modules") return true;
  if (first.startsWith(".")) return true; // .git, dotfiles/dotdirs at the root
  if (base.startsWith(".")) return true; // nested dotfiles (e.g. .DS_Store)
  if (base.includes(".tmp-") || base.endsWith("~") || base.endsWith(".swp")) return true;
  return false;
}

// Best-effort recursive watch of the composition dir; a trailing debounce coalesces a burst of saves
// (the agent rewriting several files per edit) into a single rev bump. Recursive is cheap on macOS
// (FSEvents); older Linux that lacks it falls back to a flat watch (top-level edits still reload),
// and a total failure leaves the player's manual Reload as the only path. Never crashes the server.
function startWatching() {
  if (watchStarted) return;
  watchStarted = true;
  const onChange = (type, filename) => {
    if (!filename || shouldIgnoreWatchPath(filename)) return;
    clearTimeout(watchDebounce);
    watchDebounce = setTimeout(() => { compRev += 1; }, 250);
  };
  const attach = (opts) => {
    const w = opts ? fs.watch(COMP_ABS, opts, onChange) : fs.watch(COMP_ABS, onChange);
    w.on("error", () => {}); // an async watch error (e.g. inotify ENOSPC) must never crash the server
    return w;
  };
  try {
    attach({ recursive: true });
  } catch {
    try { attach(null); } catch { /* no watch available — the player's manual Reload remains */ }
  }
}

// GET /api/watch — poll-only live-reload channel. Returns the current in-memory revision; the player
// re-mounts when it changes. No SSE, no held connections, no CORS (same-origin, 127.0.0.1-only). A
// 404 here (older server) just makes the player's support probe a graceful no-op.
function handleWatch(req, res) {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
  return sendJson(res, 200, { rev: compRev });
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (pathname === RUNTIME_ENDPOINT) return serveRuntime(res);
  const noteMatch = /^\/api\/notes\/(\d+)$/.exec(pathname);
  if (noteMatch) return handleNoteById(req, res, noteMatch[1]);
  if (pathname === "/api/notes") return handleNotes(req, res);
  if (pathname === "/api/attachments") return handleAttachments(req, res);
  if (pathname === "/api/mix") return handleMix(req, res);
  if (pathname === "/api/composition") return handleComposition(req, res);
  if (pathname === "/api/metrics") return handleMetrics(req, res);
  if (pathname === "/api/watch") return handleWatch(req, res);
  return serveStatic(req, res);
});

// Honor an explicit VELLUM_PORT exactly (fail clearly if taken); otherwise hunt for the
// next free port instead of crashing with a raw EADDRINUSE stack trace.
const EXPLICIT_PORT = Boolean(process.env.VELLUM_PORT);
let activePort = PORT;

function onListen() {
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  // Regenerate annotations.{json,md} from the reconciled notes so offline agent edits surface
  // on boot. readNotes() returns [] on ENOENT (so the file is created on first run) and THROWS
  // on malformed JSON. Read ONCE: on success, canonicalize + regenerate and reuse the array for
  // the banner; on malformed, leave the bad file untouched (never clobber with []) and WARN, so
  // corruption isn't silently misreported as an empty review.
  let existing = [];
  let notesReadable = true;
  try {
    existing = readNotes();
    writeNotes(existing);
  } catch (err) {
    notesReadable = false;
    console.warn(`  ${ui.glyph.warn} ${path.relative(ROOT, NOTES_JSON)} is unreadable — fix the JSON. ${ui.dim(`(${err.message})`)}`);
  }
  // Metrics ledger: seed the in-memory line count (physical non-empty lines, matching trimMetrics'
  // own definition) so trim hysteresis is correct from the first append; trim a pre-existing
  // oversized ledger (older-bug recovery), then anchor this session. Best-effort — never block boot.
  try {
    metricsLines = fs.readFileSync(METRICS_JSONL, "utf8").split("\n").filter(Boolean).length;
    if (metricsLines > METRICS_MAX_LINES) trimMetrics();
  } catch { metricsLines = 0; }
  recordMetric({ type: "session", vellum: VERSION });
  startWatching(); // watch the composition dir so the open player can live-reload on edits (best-effort)
  const compRel = path.relative(ROOT, path.join(COMP_ABS, "index.html")) || "index.html";
  const url = `http://127.0.0.1:${activePort}${PLAYER_PATH}`;
  const hfSource = HF_LOCAL_RUNTIME
    ? `node_modules/hyperframes ${ui.dim(`(${path.basename(HF_LOCAL_RUNTIME)})`)}`
    : HF_NPX_DIR
      ? `npx cache ${ui.dim(`(hyperframes@${HF_VERSION})`)}`
      : `jsDelivr CDN ${ui.dim(`(hyperframes@${HF_VERSION})`)}`;

  console.log("");
  console.log(ui.wordmark(`v${VERSION} · HyperFrames review layer`));
  console.log("");
  if (!fs.existsSync(path.join(COMP_ABS, "index.html"))) {
    console.warn(`  ${ui.glyph.warn} No composition found at ${ui.bold(compRel)}. Run vellum from your HyperFrames project root, or set VELLUM_DIR.`);
    console.log("");
  }
  if (activePort !== PORT) {
    console.log(`  ${ui.glyph.warn} Port ${PORT} was busy — using ${ui.bold(activePort)} instead.`);
    console.log("");
  }
  const noteCount = !notesReadable
    ? `${path.relative(ROOT, NOTES_JSON)}  ${ui.dim("(unreadable — fix the JSON)")}`
    : existing.length
      ? `${path.relative(ROOT, NOTES_JSON)}  ${ui.dim(`(${existing.length} saved)`)}`
      : `${path.relative(ROOT, NOTES_JSON)}  ${ui.dim("(+ annotations.md)")}`;
  console.log(
    ui.box([
      `${ui.glyph.play} ${ui.bold(ui.teal(ui.link(url)))}`,
      "",
      ...ui.rows([
        ["Composition", compRel],
        ["Runtime", hfSource],
        ["Notes", noteCount],
      ]),
    ])
  );
  console.log("");
  if (OPEN_BROWSER) {
    openInBrowser(url);
    console.log(`  ${ui.dim("Browser opened — pin notes on any frame, then tell your agent:")}`);
  } else {
    console.log(`  Open → ${url}`);
    console.log(`  ${ui.dim("Pin notes on any frame, then tell your agent:")}`);
  }
  console.log(`  ${ui.teal('"address my Vellum review notes"')}`);
  console.log("");
  console.log(`  ${ui.dim("Watching for notes · Ctrl+C to stop")}`);
  console.log("");
}

// Defense-in-depth: a throw inside a request 'end' listener would otherwise be uncaught and
// exit the daemon mid-review (taking down the open player). The handlers already guard their
// own writes + note bodies; this is the last backstop so no future codepath can kill a
// long-running local server. Log loudly and keep serving.
process.on("uncaughtException", (err) => {
  try { console.error(`  ${ui.glyph.warn} uncaught: ${err && err.stack ? err.stack : err}`); } catch {}
});

// Graceful shutdown: leave a session summary instead of a bare ^C.
let shuttingDown = false;
process.on("SIGINT", () => {
  if (shuttingDown) process.exit(130);
  shuttingDown = true;
  const notes = emptyNotesOnMissing();
  const open = notes.filter((n) => normalizeNoteStatus(n.status) === "open").length;
  console.log("\n");
  if (notes.length) {
    const breakdown = open === notes.length ? "" : ui.dim(` (${open} open · ${notes.length - open} done)`);
    console.log(`  ${ui.glyph.ok} ${ui.bold(notes.length)} note(s) saved → ${path.relative(ROOT, NOTES_JSON)}${breakdown}`);
    if (open) console.log(`  ${ui.dim('Tell your agent: "address my Vellum review notes"')}`);
    // One-line self-measurement summary (best-effort — never throw during shutdown).
    try {
      const m = computeMetrics(notes, loadMetricsEvents());
      const bits = [];
      if (m.firstPass.rate != null) bits.push(`first-pass ${Math.round(m.firstPass.rate * 100)}%`);
      if (m.resolveLatencyMs) bits.push(`median fix ${fmtDuration(m.resolveLatencyMs.median)}`);
      if (m.timeToNoteMs) bits.push(`median time-to-note ${fmtDuration(m.timeToNoteMs.median)}`);
      if (bits.length) console.log(`  ${ui.dim(bits.join(" · "))}`);
    } catch {}
  } else {
    console.log(`  ${ui.dim("Vellum stopped — no notes this session.")}`);
  }
  console.log("");
  process.exit(0);
});

server.on("listening", onListen);
server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    if (!EXPLICIT_PORT && activePort < PORT + 20) {
      activePort += 1;
      server.listen(activePort, "127.0.0.1");
      return;
    }
    console.error(`\n  ${ui.glyph.err} Port ${ui.bold(activePort)} is already in use. Free it or pick another:  ${ui.bold("VELLUM_PORT=5050 vellum")}\n`);
    process.exit(1);
  }
  console.error(`\n  ${ui.glyph.err} Server error: ${err && err.message}\n`);
  process.exit(1);
});

server.listen(activePort, "127.0.0.1");
