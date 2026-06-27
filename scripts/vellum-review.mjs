#!/usr/bin/env node
/**
 * Vellum — build a visual review packet from the saved annotation notes.
 *
 * For each note it renders the authoritative composition frame at the note's time
 * (via `hyperframes snapshot`) and draws the note's pin/region marker onto it
 * (via ffmpeg drawbox), so a coding agent can SEE exactly what each note points at.
 *
 * Output: <comp>/notes/review/note-<id>.png  +  <comp>/notes/review/INDEX.md
 *
 * Run from your HyperFrames project root:  npx vellum-review   (or: node scripts/vellum-review.mjs)
 *   VELLUM_DIR=compositions/hero node scripts/vellum-review.mjs   # subfolder composition
 *
 * External processes are invoked with argument ARRAYS (no shell string interpolation);
 * all marker coordinates are numbers derived from the note percentages.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compSize, fmtTime, resolveComposition, VERSION, describeDesiredDelta, indexHashOf, normalizeNoteStatus } from "./vellum-shared.mjs";
import * as ui from "./vellum-ui.mjs";

const { root: ROOT, compDir: COMP_DIR, compAbs: COMP } = resolveComposition();
const NOTES_JSON = path.join(COMP, "notes", "annotations.json");
const SNAP_DIR = path.join(COMP, "snapshots");
const OUT_DIR = path.join(COMP, "notes", "review");
const ACCENT = "0x5EEAD4";
// Desired-state markup is drawn in amber so it reads distinctly from the teal current-state marker:
// the destination box (where/how big the element should be) and the from→to direction arrow.
const AMBER = "0xFFB000";

const { W, H } = compSize(COMP);

// Percent-of-composition → pixel. Notes store coordinates as 0–100% of comp size.
const px = (pct) => Math.round((pct / 100) * W);
const py = (pct) => Math.round((pct / 100) * H);

function readNotes() {
  try {
    const notes = JSON.parse(fs.readFileSync(NOTES_JSON, "utf8"));
    // Valid JSON of the wrong shape (a hand-edit that left an object/number) would crash main()'s
    // .sort(); tolerate it the same way as a parse error — warn and continue with no notes.
    if (!Array.isArray(notes)) {
      console.warn(`${path.relative(ROOT, NOTES_JSON)} is not a JSON array — skipping`);
      return [];
    }
    return notes;
  } catch (err) {
    // A bad offline edit to annotations.json must not crash the review-packet build — agents
    // hand-edit this file, so warn and continue with no notes rather than process.exit(1).
    if (err && err.code !== "ENOENT") {
      console.warn(`Could not read ${path.relative(ROOT, NOTES_JSON)}: ${err.message} — skipping`);
    }
    return [];
  }
}

function ensureCommand(name, args) {
  const r = spawnSync(name, args, { encoding: "utf8" });
  if (r.error && r.error.code === "ENOENT") {
    console.error(`Missing required command: ${name}`);
    process.exit(1);
  }
  return true;
}

// Render the composition frame at time t; return the path to the produced PNG.
function snapshot(t) {
  const before = new Set(fs.existsSync(SNAP_DIR) ? fs.readdirSync(SNAP_DIR) : []);
  const r = spawnSync("npx", ["hyperframes", "snapshot", "--at", String(t)], { cwd: COMP, encoding: "utf8" });
  if (r.error && r.error.code === "ENOENT") {
    console.error("Missing required command: npx");
    return null;
  }
  if (r.status !== 0) {
    console.error(`  snapshot @ ${t}s failed: ${(r.stderr || r.stdout || "").trim().split("\n").pop()}`);
    return null;
  }
  const pngs = fs.existsSync(SNAP_DIR) ? fs.readdirSync(SNAP_DIR).filter((f) => f.endsWith(".png")) : [];
  const fresh = pngs.filter((f) => !before.has(f));
  const pick = (fresh.length ? fresh : pngs)
    .map((f) => ({ f, m: fs.statSync(path.join(SNAP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)[0];
  return pick ? path.join(SNAP_DIR, pick.f) : null;
}

// A %-of-comp {x,y,w,h} box → pixels for ffmpeg: finite-guarded, w/h floored to a visible minimum,
// null on bad or zero-size data so the coordinates handed to ffmpeg always stay numeric (no shell
// interpolation). Shared by the element-outline (targetBox) and desired-state (desiredBoxPx) draws.
function boxToPx(b) {
  if (!b) return null;
  const vals = [b.x, b.y, b.w, b.h].map(Number);
  if (!vals.every(Number.isFinite) || vals[2] <= 0 || vals[3] <= 0) return null;
  return { x: px(vals[0]), y: py(vals[1]), w: Math.max(4, px(vals[2])), h: Math.max(4, py(vals[3])) };
}

// Draw the note's marker (pin dot or region box) onto the snapshot. Pin notes whose
// target carries an element bounding box (captured via the HyperFrames picker at pin
// time) get the element's actual outline plus a small filled dot at the click point;
// older notes fall back to the generic 40px square.
function targetBox(note) {
  return boxToPx(note.target && note.target.box);
}

// The desired-state destination box (where/how big the element SHOULD be) → pixels.
export function desiredBoxPx(note) {
  return boxToPx(note.desiredBox);
}

// The desired-state direction arrow (from-point → to-point) → pixels. Finite-guarded, null on bad data.
export function arrowPx(note) {
  const a = note.arrow;
  if (!a) return null;
  const vals = [a.x1, a.y1, a.x2, a.y2].map(Number);
  if (!vals.every(Number.isFinite)) return null;
  return { x1: px(vals[0]), y1: py(vals[1]), x2: px(vals[2]), y2: py(vals[3]) };
}

// Stock ffmpeg has no line/drawline filter, so a direction arrow is approximated as a chain of small
// filled drawboxes sampled along the segment, plus a from-dot at the origin and a larger arrowhead
// box at the destination. Returns an array of filter strings (numeric coords only) — the accepted v1
// approximation: a faithful reference hint, not pixel-clean.
export function lineBoxes(x1, y1, x2, y2, color, n = 14, size = 3) {
  const segs = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const sx = Math.round(x1 + (x2 - x1) * t);
    const sy = Math.round(y1 + (y2 - y1) * t);
    segs.push(`drawbox=x=${sx - size}:y=${sy - size}:w=${size * 2}:h=${size * 2}:color=${color}@1.0:t=fill`);
  }
  const fd = size + 2; // from-dot at the origin
  segs.push(`drawbox=x=${Math.round(x1) - fd}:y=${Math.round(y1) - fd}:w=${fd * 2}:h=${fd * 2}:color=${color}@1.0:t=fill`);
  const ah = size + 4; // larger arrowhead box at the destination
  segs.push(`drawbox=x=${Math.round(x2) - ah}:y=${Math.round(y2) - ah}:w=${ah * 2}:h=${ah * 2}:color=${color}@1.0:t=fill`);
  return segs;
}

// The desired-state filter segments — amber destination box (t=3) + dotted direction arrow — for a
// note, as an array of ffmpeg drawbox strings. Factored out of drawMarker so the before/after frame
// pass can draw the SAME ghost onto its own snapshot; returns [] when the note carries neither field.
export function ghostFilters(note) {
  const segs = [];
  const dest = desiredBoxPx(note);
  if (dest) segs.push(`drawbox=x=${dest.x}:y=${dest.y}:w=${dest.w}:h=${dest.h}:color=${AMBER}@1.0:t=3`);
  const arr = arrowPx(note);
  if (arr) segs.push(...lineBoxes(arr.x1, arr.y1, arr.x2, arr.y2, AMBER));
  return segs;
}

// Whether a note warrants a before|after pair in the packet: the agent claims to have handled it
// (addressed/resolved) AND the composition has drifted from the bytes it was pinned against
// (provenance.indexHash present and != the current hash). Open notes are already surfaced as stale,
// and a note pinned against the current bytes has nothing to compare. Pure so the gate is unit-tested
// without a render.
export function shouldPairBeforeAfter(note, curHash) {
  if (!note || !curHash) return false;
  const status = normalizeNoteStatus(note.status);
  if (status !== "addressed" && status !== "resolved") return false;
  const pinned = note.provenance && note.provenance.indexHash;
  return !!pinned && pinned !== curHash;
}

function drawMarker(srcPng, note, outPng) {
  const filters = [];
  if (note.w != null) {
    const x = px(note.x);
    const y = py(note.y);
    const w = px(note.w);
    const h = py(note.h);
    filters.push(`drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${ACCENT}@1.0:t=5`);
  } else if (note.x != null) {
    const cx = px(note.x);
    const cy = py(note.y);
    const box = targetBox(note);
    if (box) {
      const d = 9;
      filters.push(`drawbox=x=${box.x}:y=${box.y}:w=${box.w}:h=${box.h}:color=${ACCENT}@1.0:t=4`);
      filters.push(`drawbox=x=${cx - d}:y=${cy - d}:w=${d * 2}:h=${d * 2}:color=${ACCENT}@1.0:t=fill`);
    } else {
      const s = 40;
      filters.push(`drawbox=x=${cx - s}:y=${cy - s}:w=${s * 2}:h=${s * 2}:color=${ACCENT}@1.0:t=5`);
    }
  }
  // Desired-state markup (amber destination box + dotted direction arrow) layers on top of the teal
  // current-state marker — and renders even for a note with no pin/region coords (an arrow-only note).
  filters.push(...ghostFilters(note));
  if (!filters.length) {
    // no coordinates of any kind — just copy the frame
    fs.copyFileSync(srcPng, outPng);
    return true;
  }
  const r = spawnSync("ffmpeg", ["-y", "-i", srcPng, "-vf", filters.join(","), outPng], { encoding: "utf8" });
  if (r.error && r.error.code === "ENOENT") {
    console.error("  ffmpeg is required to draw note markers. Install ffmpeg or run without review packets.");
    return false;
  }
  if (r.status !== 0) {
    console.error(`  ffmpeg draw failed for note ${note.id}: ${(r.stderr || "").trim().split("\n").pop()}`);
    return false;
  }
  return true;
}

function main() {
  const notes = readNotes().sort((a, b) => a.time - b.time);
  console.log("");
  console.log(ui.wordmark(`v${VERSION} · review packet`));
  console.log("");
  if (!notes.length) {
    console.log(`  ${ui.dim("No notes to render — pin some in the Vellum player first.")}\n`);
    return;
  }
  ensureCommand("ffmpeg", ["-version"]);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Before/after pairing. A note carries the immutable index.html fingerprint it was pinned against
  // (provenance.indexHash); when the composition has since drifted, the CURRENT frame (after) is
  // rendered fresh while the BEFORE frame is recovered from the cache of a PRE-EDIT review run —
  // historical bytes can't be re-rendered, so a before-frame is a pure cache lookup that is simply
  // absent (single-frame fallback) when no earlier run cached it. The cache lives under the
  // already-gitignored notes/review/ tree, keyed by (content hash, time).
  const curHash = indexHashOf(COMP);
  const CACHE_DIR = path.join(OUT_DIR, "baseline");
  const sanitizeHash = (h) => String(h).replace(/[^a-z0-9]/gi, "_"); // ":" → "_" for a valid dir name

  // A raw (un-marked) composition frame by (hash, time). The CURRENT hash is always re-rendered the
  // first time it's needed this run (then memoized in-run for notes sharing a time) — a prior run's
  // cached frame for the current hash may be STALE, because indexHashOf only fingerprints index.html
  // but the rendered output also depends on assets/JS/CSS (e.g. shared/academy-kit.js) that can change
  // while index.html stays byte-identical. The fresh frame is cached so a LATER run (after an edit
  // bumps the hash) can serve it as a before-frame. Historical hashes are cache-only — old bytes can't
  // be re-rendered — so a before-frame is a pure lookup.
  const renderedThisRun = new Set();
  const rawFrame = (time, hash) => {
    const dir = path.join(CACHE_DIR, sanitizeHash(hash));
    const cachePath = path.join(dir, `t${Number(time).toFixed(3)}.png`);
    if (hash === curHash) {
      if (renderedThisRun.has(time) && fs.existsSync(cachePath)) return cachePath; // in-run memo only
      const snap = snapshot(time);
      if (!snap) return null;
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(snap, cachePath);
      renderedThisRun.add(time);
      return cachePath;
    }
    return fs.existsSync(cachePath) ? cachePath : null; // historical (before-frame): cache-only
  };
  const shortHash = (h) => String(h || "").replace(/^sha256:/, "").slice(0, 10);

  const index = [
    `# Review packet${COMP_DIR ? ` — ${COMP_DIR}` : ""}`,
    "",
    `${notes.length} note(s).`,
    "",
    "_Addressed/resolved notes whose composition drifted since they were pinned show a **Before · After** pair (the pinned frame from a pre-edit review run beside the current frame); the rest show a single current frame._",
    "",
  ];
  let failures = 0;

  notes.forEach((n, i) => {
    const label = `${ui.bold(`note-${n.id}`)} ${ui.dim(`@ ${fmtTime(n.time)}`)} ${ui.dim(`— "${ui.truncate(n.text, 44)}"`)}`;
    if (ui.interactive) {
      process.stdout.write(`\r\x1b[K  ${ui.bar((i + 1) / notes.length)} ${i + 1}/${notes.length}  ${label}`);
    } else {
      console.log(`[${i + 1}/${notes.length}] note-${n.id} ${fmtTime(n.time)} — ${n.text.slice(0, 60)}`);
    }
    // The "after" is the current frame (kept as note-<id>.png for back-compat). When index.html is
    // unreadable (no hash) caching is impossible, so fall back to a direct, uncached snapshot.
    const afterRaw = curHash ? rawFrame(n.time, curHash) : snapshot(n.time);
    const out = path.join(OUT_DIR, `note-${n.id}.png`);
    let drawn = false;
    if (afterRaw) drawn = drawMarker(afterRaw, n, out);
    if (!drawn) failures += 1;

    // The "before" is the pinned-hash frame, drawn with the SAME marker so the move reads on both. A
    // miss (no pre-edit run cached it) or a draw failure is NON-FATAL: warn, fall back to the single
    // current frame, and do NOT count it against `failures` — only the after-frame is load-bearing.
    let beforeDrawn = false;
    const beforeOut = path.join(OUT_DIR, `note-${n.id}-before.png`);
    if (drawn && shouldPairBeforeAfter(n, curHash)) {
      const beforeRaw = rawFrame(n.time, n.provenance.indexHash);
      if (beforeRaw) {
        beforeDrawn = drawMarker(beforeRaw, n, beforeOut);
        if (!beforeDrawn) console.warn(`  before-frame draw failed for note ${n.id} — showing the current frame only`);
      } else {
        console.warn(`  no cached before-frame for note ${n.id} (run vellum-review before editing to capture one) — showing the current frame only`);
      }
    }
    if (!beforeDrawn) fs.rmSync(beforeOut, { force: true }); // drop a stale pair image from a prior run

    if (ui.interactive) {
      process.stdout.write("\r\x1b[K");
      console.log(`  ${drawn ? ui.glyph.ok : ui.glyph.err} ${label}`);
    }
    const span = n.timeEnd != null && n.timeEnd > n.time;
    const where = n.kind === "span" ? (span ? `time span ${(n.timeEnd - n.time).toFixed(2)}s` : "time span")
      : n.w != null ? `box ${n.w}×${n.h}%` : n.x != null ? `pin ${n.x}%,${n.y}%` : "—";
    const tgt = n.target ? ` · on \`${n.target.tag}${n.target.cls ? "." + n.target.cls : ""}\`` : "";
    const sel = n.target && n.target.selector ? ` · at \`${n.target.selector}\`` : "";
    // The desired-state delta rides the where-line in the same words the agent reads in annotations.md
    // (one shared phrasing via describeDesiredDelta), alongside the amber ghost drawn on the frame.
    const delta = describeDesiredDelta(n);
    const want = delta ? ` · ${[delta.box, delta.arrow].filter(Boolean).join("; ")}` : "";
    index.push(`### note-${n.id} · ${span ? `${fmtTime(n.time)}–${fmtTime(n.timeEnd)}` : fmtTime(n.time)} ${n.scene ? `\`${n.scene}\`` : ""}`);
    index.push("");
    index.push(`${n.text}`);
    index.push("");
    index.push(`_(${where}${tgt}${sel}${want})_`);
    if (drawn && beforeDrawn) {
      // Paired: a 2-column table renders the pinned frame beside the current one (with short hashes).
      index.push("");
      index.push(`| Before · pinned \`${shortHash(n.provenance.indexHash)}\` | After · current \`${shortHash(curHash)}\` |`);
      index.push("| --- | --- |");
      index.push(`| ![before](note-${n.id}-before.png) | ![after](note-${n.id}.png) |`);
    } else if (drawn) {
      index.push("", `![note ${n.id}](note-${n.id}.png)`);
    }
    index.push("");
  });

  // Opportunistic prune: drop cache buckets for content versions no longer referenced by the current
  // hash or any note's pinned hash, so the local cache stays bounded as versions accumulate. Runs
  // after the loop (never deletes a frame in use) and is best-effort — a prune error never fails the packet.
  try {
    if (fs.existsSync(CACHE_DIR)) {
      const keep = new Set(
        [curHash, ...notes.map((n) => n.provenance && n.provenance.indexHash)].filter(Boolean).map(sanitizeHash)
      );
      for (const entry of fs.readdirSync(CACHE_DIR)) {
        if (!keep.has(entry)) fs.rmSync(path.join(CACHE_DIR, entry), { recursive: true, force: true });
      }
    }
  } catch {}

  fs.writeFileSync(path.join(OUT_DIR, "INDEX.md"), index.join("\n"));
  if (failures) {
    console.error(`\n  ${ui.glyph.err} Failed to render ${failures} review marker(s). See messages above.\n`);
    process.exit(1);
  }
  console.log(`\n  ${ui.glyph.ok} Wrote ${ui.bold(notes.length)} frame(s) → ${ui.teal(`${path.relative(ROOT, OUT_DIR)}/`)}  ${ui.dim("(see INDEX.md)")}\n`);
}

// Run as a CLI, but stay importable so the marker-filter helpers can be unit-tested. Resolve symlinks
// on both sides so an npm/global bin shim still triggers main(), while a module that imports this file
// (the smoke test) does not.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (invokedDirectly()) main();
