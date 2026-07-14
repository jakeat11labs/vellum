// @ts-check
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ---- Shared shapes (JSDoc typedefs) ------------------------------------------------------------
// Documentation of the records that cross the .mjs module boundaries — they give editors hover/
// autocomplete and a single written description of the note shape. (They are not applied as types at
// call sites; @ts-check's value here is catching cross-module call-signature drift, undefined names,
// and bad arg counts, not field-name typos on the dynamically-shaped, optional-spread note record —
// reconcileNote is the runtime normalize-on-read seam for that.) Every Note field but `id` is
// absent-by-default so legacy notes round-trip byte-identically.

/** @typedef {{ x: number, y: number, w: number, h: number }} DesiredBox  Box bounds, % of frame. */
/** @typedef {{ x1: number, y1: number, x2: number, y2: number }} Arrow  From→to direction, % of frame. */
/** @typedef {{ commit?: string, indexHash?: string }} Provenance  Git HEAD + index.html hash a note was pinned against. */

/**
 * @typedef {{
 *   id: number,
 *   time?: number,
 *   timeEnd?: number,
 *   text?: string,
 *   scene?: string,
 *   status?: string,
 *   severity?: string | null,
 *   kind?: string,
 *   x?: number, y?: number, w?: number, h?: number,
 *   desiredBox?: DesiredBox,
 *   arrow?: Arrow,
 *   provenance?: Provenance,
 *   attachments?: any[],
 *   resolution?: Object,
 *   target?: Object,
 *   audio?: Object,
 *   createdAt?: string,
 *   updatedAt?: string,
 *   firstAddressedAt?: string,
 *   firstResolvedAt?: string,
 *   reopenCount?: number,
 *   origin?: { by: string, detector: string, at: string },
 * }} Note
 */

// Installed tool version. Keep in sync with package.json on release; `vellum update`
// compares this against the published package.json version.
export const VERSION = "0.10.4";

export const NOTE_STATUSES = new Set(["open", "addressed", "resolved", "wontfix"]);

// Reviewer-assigned severity, most→least urgent. Absent = unset (not all notes carry one).
export const NOTE_SEVERITIES = ["blocker", "major", "nit"];

// One source of truth for the VELLUM_DIR guard message (the smoke test matches on it)
// and the fallback composition size, so the duplicated copies of each can't drift.
const OUTSIDE_ROOT_MSG = "VELLUM_DIR must stay inside the project root:";
const DEFAULT_W = 1920;
const DEFAULT_H = 1080;

export function cleanCompDir(value) {
  const raw = String(value || "").replace(/^[/\\]+|[/\\]+$/g, "");
  if (!raw || raw === ".") return "";
  const normalized = path.normalize(raw);
  if (
    path.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`) ||
    normalized.split(path.sep).includes("..")
  ) {
    console.error(`${OUTSIDE_ROOT_MSG} ${value}`);
    process.exit(1);
  }
  return normalized;
}

export function resolveInside(base, target) {
  const full = path.resolve(base, target);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

// Split a path on BOTH separators. The single home for this primitive: `path.resolve` treats `\` as a
// separator on Windows, so any security check on path SEGMENTS (the dotfile denylist, the watch-ignore
// rule) must split on `\` too or an encoded backslash slips a `/`-only split. One definition, no drift.
export const pathSegments = (p) => String(p).split(/[\\/]/);

// Atomic write: temp file + rename so a crash mid-write can't leave a half-written file that wedges
// every subsequent read (rename is atomic within a dir). The ONE definition both the server and the
// note store call, so the temp-rename contract can't drift between them.
export function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
export const writeJsonAtomic = (file, obj) => writeFileAtomic(file, `${JSON.stringify(obj, null, 2)}\n`);

export function resolveComposition(cwd = process.cwd()) {
  const compDir = cleanCompDir(process.env.VELLUM_DIR);
  const compAbs = resolveInside(cwd, compDir || ".");
  if (!compAbs) {
    console.error(`${OUTSIDE_ROOT_MSG} ${process.env.VELLUM_DIR}`);
    process.exit(1);
  }
  return { root: cwd, compDir, compAbs };
}

export function compSize(compAbs) {
  try {
    const html = fs.readFileSync(path.join(compAbs, "index.html"), "utf8");
    const w = Number((/data-width\s*=\s*["'](\d+)["']/.exec(html) || [])[1]) || DEFAULT_W;
    const h = Number((/data-height\s*=\s*["'](\d+)["']/.exec(html) || [])[1]) || DEFAULT_H;
    return { W: w, H: h };
  } catch {
    return { W: DEFAULT_W, H: DEFAULT_H };
  }
}

// "sha256:<first 16 hex>" content fingerprint of the composition's index.html — the immutable
// baseline the server stamps into each note's provenance (computeProvenance) and the review
// packet keys its before/after frame cache by. Best-effort like compSize: returns null when
// index.html can't be read. The `sha256:`+16-hex shape is pinned by the smoke test, so the
// server's computeProvenance delegates here to stay byte-identical.
export function indexHashOf(compAbs) {
  try {
    const bytes = fs.readFileSync(path.join(compAbs, "index.html"));
    return "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

export function fmtTime(t) {
  const total = Math.max(0, Number(t) || 0);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

export function normalizeNoteStatus(value, fallback = "open") {
  const status = String(value ?? fallback).toLowerCase();
  return NOTE_STATUSES.has(status) ? status : fallback;
}

export function normalizeNoteSeverity(value, fallback = null) {
  if (value == null) return fallback;
  const severity = String(value).toLowerCase();
  return NOTE_SEVERITIES.includes(severity) ? severity : fallback;
}

// Human-readable elapsed time for the metrics readouts: "42s" / "4m12s" / "1h05m".
// Clamps negatives to 0 (wall-clock latencies can go negative on a backward clock step).
export function fmtDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  const sec = Math.floor(total / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m${String(sec % 60).padStart(2, "0")}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h${String(min % 60).padStart(2, "0")}m`;
}

// Bounded sanitizer for the agent write-back record. Mirrors sanitizeAudio's cap style:
// every string is length-clamped, edits[] are bounded and entries with no content dropped.
// `at` is server-stamped when missing or unparseable; a valid agent timestamp is preserved.
// Returns null unless the object carries real content (by/summary/edits — `at` alone is a stamp).
// PATCH/offline-only: a note is NEVER born with a resolution at POST time.
export function sanitizeResolution(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  if (raw.by != null) out.by = String(raw.by).slice(0, 80);
  out.at = raw.at != null && Number.isFinite(Date.parse(raw.at))
    ? String(raw.at).slice(0, 40)
    : new Date().toISOString();
  if (raw.summary != null) out.summary = String(raw.summary).slice(0, 800);
  if (Array.isArray(raw.edits)) {
    const edits = [];
    for (const e of raw.edits) {
      if (!e || typeof e !== "object") continue;
      const edit = {};
      if (e.file != null) edit.file = String(e.file).slice(0, 250);
      if (e.selector != null) edit.selector = String(e.selector).slice(0, 250);
      if (e.detail != null) edit.detail = String(e.detail).slice(0, 300);
      if (Object.keys(edit).length) edits.push(edit);
      if (edits.length >= 20) break;
    }
    if (edits.length) out.edits = edits;
  }
  if (out.by == null && out.summary == null && !out.edits) return null;
  return out;
}

// Bounded growth for the self-measurement ledger: once the physical line count passes
// METRICS_MAX_LINES, trim back to the last METRICS_KEEP (hysteresis avoids a rewrite on every
// append). ~1 MB ceiling for a local diagnostics file.
export const METRICS_MAX_LINES = 5000;
export const METRICS_KEEP = 4000;

// Median + average of a numeric sample (rounded to whole ms), or null when empty.
function metricStats(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  const avg = Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length);
  return { count: sorted.length, median, avg };
}

// Pure review-process metrics. No I/O — the caller supplies the notes array (always current)
// and any ledger `events`. Absent firstAddressedAt/firstResolvedAt/reopenCount count as
// never-fixed / 0; negative latencies (clock skew) are dropped. timeToNoteMs comes from the
// ledger only.
//
// First-pass fix rate = of the notes the agent ever *fixed* (reached `addressed` or `resolved`
// at least once → firstAddressedAt||firstResolvedAt), the fraction that stuck (never reopened).
// `fixed` is the denominator and `reopened` is counted only within it, so the rate stays in
// [0,1] even on the normal open→addressed→open (agent fixed, human rejected) flow.
export function computeMetrics(notes, events = []) {
  const arr = Array.isArray(notes) ? notes : [];
  const counts = { total: arr.length, open: 0, addressed: 0, resolved: 0, wontfix: 0 };
  let fixed = 0;
  let reopened = 0;
  const resolveLatencies = [];
  for (const n of arr) {
    if (!n || typeof n !== "object") continue;
    const status = normalizeNoteStatus(n.status);
    if (status === "open") counts.open += 1;
    else if (status === "addressed") counts.addressed += 1;
    else if (status === "resolved") counts.resolved += 1;
    else if (status === "wontfix") counts.wontfix += 1;
    if (n.firstAddressedAt || n.firstResolvedAt) {
      fixed += 1;
      if (Number(n.reopenCount) > 0) reopened += 1;
    }
    if (n.firstResolvedAt) {
      const created = Date.parse(n.createdAt);
      const done = Date.parse(n.firstResolvedAt);
      if (Number.isFinite(created) && Number.isFinite(done) && done - created >= 0) {
        resolveLatencies.push(done - created);
      }
    }
  }
  // time-to-note: a create minus the most recent preceding session/mount anchor of the SAME
  // run (sid), so interleaved servers sharing notes/ can't cross-pair; falls back to the most
  // recent anchor for older sid-less ledgers.
  const timeToNotes = [];
  const anchorBySid = new Map();
  let lastAnchor = null;
  // Auto-lint lift: a `propose` event per proposal SHOWN, a `create` event carrying `detector` per
  // proposal ACCEPTED. acceptRate = accepted/shown tells whether proposing beats hunting — the gate
  // before adding detector #2.
  let proposalsShown = 0;
  let proposalsAccepted = 0;
  for (const e of (Array.isArray(events) ? events : [])) {
    if (!e || typeof e !== "object") continue;
    const at = Date.parse(e.at);
    if (!Number.isFinite(at)) continue;
    if (e.type === "session" || e.type === "mount") {
      if (e.sid != null) anchorBySid.set(e.sid, at);
      lastAnchor = at;
    } else if (e.type === "create") {
      const anchor = e.sid != null && anchorBySid.has(e.sid) ? anchorBySid.get(e.sid) : lastAnchor;
      if (anchor != null && at - anchor >= 0) timeToNotes.push(at - anchor);
      if (e.detector) proposalsAccepted += 1;
    } else if (e.type === "propose") {
      proposalsShown += 1;
    }
  }
  return {
    notes: counts,
    firstPass: { fixed, reopened, rate: fixed ? Math.max(0, Math.min(1, (fixed - reopened) / fixed)) : null },
    resolveLatencyMs: metricStats(resolveLatencies),
    timeToNoteMs: metricStats(timeToNotes),
    // Absent (null) when nothing was ever proposed, so a review with no auto-lint activity has a
    // byte-identical metrics footer to before.
    proposals: proposalsShown ? { shown: proposalsShown, accepted: proposalsAccepted, acceptRate: Math.max(0, Math.min(1, proposalsAccepted / proposalsShown)) } : null,
    generatedAt: new Date().toISOString(),
  };
}

// True when `box` is an object carrying every key in `keys` as a finite number — the shape a
// coordinate field must have before a render path reads its members. Mirrors the attachments
// Array.isArray guard: a bad offline hand-edit is dropped on read so no `.x` access throws.
function hasFiniteKeys(box, keys) {
  return !!box && typeof box === "object" && keys.every((k) => Number.isFinite(box[k]));
}
// w/h must be positive — mirrors POST's sanitizeDesiredBox so the read path and write path agree
// (an offline-edited zero/negative box is dropped, not rendered as a nonsensical "→ 0×0%" delta).
const validBox = (b) => hasFiniteKeys(b, ["x", "y", "w", "h"]) && b.w > 0 && b.h > 0;
const validArrow = (a) => hasFiniteKeys(a, ["x1", "y1", "x2", "y2"]);

// Normalize a note on READ: coerce its status to the enum, drop an invalid severity, and
// sanitize an agent-written resolution. The single seam any future envelope migration would
// rewrite — keeps offline-edited annotations.json safe and back-compatible (every new field
// is absent-by-default, so a legacy note serializes byte-identically).
// ---- Auto-lint: caption-safe-area detector + note origin -----------------------------------------
// "Invert the sensor": Vellum proposes notes the reviewer confirms. The detection RULE is pure and
// lives here (browser-free, @ts-checked, smoke-tested); box EXTRACTION is client-side (geometry needs
// layout). The player inline-mirrors this rule and the smoke suite drift-guards the two copies.

// Title-safe margin — % inset on every edge, the broadcast standard for on-screen TEXT (action-safe
// 5% is for picture; title-safe 10% is for captions). A caption box crossing INTO this margin is
// proposed. An inset of 0 (or invalid) disables the detector for that composition.
export const DEFAULT_SAFE_AREA = 10;

// The detectors Vellum is allowed to stamp into a note's `origin`. One entry for v0.10.0 — widening is
// gated on measured precision, not added speculatively.
export const CAPTION_DETECTOR = "caption-safe-area";
const ORIGIN_DETECTORS = new Set([CAPTION_DETECTOR]);

/**
 * Pure caption-safe-area rule. `box` is {x,y,w,h} in % of the composition; `inset` is the title-safe
 * margin %. Returns {violates, edge, reason} where `edge` is the most-overshot crossed side. No DOM,
 * no IO — the smoke suite unit-tests it and the player's inline copy is drift-guarded against it.
 * @param {{x:number,y:number,w:number,h:number}} box
 * @param {number} [inset]
 */
export function detectCaptionSafeArea(box, inset = DEFAULT_SAFE_AREA) {
  const clear = { violates: false, edge: null, reason: null };
  if (!box || typeof box !== "object") return clear;
  const x = Number(box.x), y = Number(box.y), w = Number(box.w), h = Number(box.h);
  if (![x, y, w, h].every(Number.isFinite)) return clear;
  const m = Number(inset);
  if (!Number.isFinite(m) || m <= 0) return clear; // inset 0 / invalid → detector disabled
  // A box spanning BOTH side margins (a centered left:0;right:0 caption bar) is full-bleed by layout,
  // not text running off the left/right edge — judging it on left/right would flag EVERY normal
  // centered full-width caption (the headline false-positive). For a full-bleed box, judge top/bottom
  // only. Overshoot past each edge is positive when it crosses into the margin; flush at the line (strict >) is clean.
  const fullBleed = x <= m && x + w >= 100 - m;
  const over = {
    top: m - y,
    bottom: y + h - (100 - m),
    left: fullBleed ? 0 : m - x,
    right: fullBleed ? 0 : x + w - (100 - m),
  };
  // Vertical edges first so a real top/bottom crossing wins a tie over a horizontal one.
  let edge = null;
  let worst = 0;
  for (const e of ["top", "bottom", "left", "right"]) {
    if (over[e] > worst) { worst = over[e]; edge = e; }
  }
  if (!edge) return clear;
  return { violates: true, edge, reason: `Caption crosses the ${edge} title-safe margin by ${worst.toFixed(1)}%` };
}

/**
 * Bounded sanitizer for a note's `origin` — the provenance of a Vellum-PROPOSED note the reviewer
 * confirmed. Unlike server-authored `provenance`, `origin` is CLIENT-supplied on POST, so it's
 * validated: `detector` against the allowlist (unknown → null, i.e. not a real proposal origin),
 * `by` length-clamped, `at` ISO-validated-or-stamped. Keys emitted in fixed {by,detector,at} order so
 * server-written and read-reconciled bytes agree. Idempotent.
 */
export function sanitizeOrigin(raw) {
  if (!raw || typeof raw !== "object") return null;
  const detector = String(raw.detector || "");
  if (!ORIGIN_DETECTORS.has(detector)) return null;
  return {
    by: raw.by != null ? String(raw.by).slice(0, 40) : "vellum",
    detector,
    at: raw.at != null && Number.isFinite(Date.parse(raw.at)) ? String(raw.at).slice(0, 40) : new Date().toISOString(),
  };
}

export function reconcileNote(note) {
  if (!note || typeof note !== "object") return note;
  const out = {
    ...note,
    status: normalizeNoteStatus(note.status),
    severity: normalizeNoteSeverity(note.severity) || undefined,
  };
  if ("resolution" in note) {
    const resolution = sanitizeResolution(note.resolution);
    if (resolution) out.resolution = resolution;
    else delete out.resolution;
  }
  // `origin` marks a note Vellum PROPOSED (the reviewer confirmed). Sanitize on read so an offline
  // hand-edit can't render-break and read→write stays byte-stable — mirrors the resolution branch.
  if ("origin" in note) {
    const origin = sanitizeOrigin(note.origin);
    if (origin) out.origin = origin;
    else delete out.origin;
  }
  // Drop a non-array attachments (a hand-edit like "attachments":"sketch.png") on read so the
  // render path's .map can never throw — mirrors the severity/resolution coercion above.
  if ("attachments" in note && !Array.isArray(note.attachments)) delete out.attachments;
  // Drop a malformed desired-state field (e.g. "desiredBox":"oops" or a 3-number box) on read
  // so renderMarkers/drawMarker/describeDesiredDelta's `.x` access can never throw.
  if ("desiredBox" in note && !validBox(note.desiredBox)) delete out.desiredBox;
  if ("arrow" in note && !validArrow(note.arrow)) delete out.arrow;
  // Scoped notes (scene/audio/span) have no element/pin → never carry desired-state markup. POST
  // forces this; enforce on read too so an offline edit can't make annotations.md (which omits it
  // for scoped notes) and the review packet (which would draw it) disagree.
  if (note.kind === "scene" || note.kind === "audio" || note.kind === "span") {
    delete out.desiredBox;
    delete out.arrow;
  }
  return out;
}

// Compact percent string: at most one decimal, trailing ".0" trimmed ("24.13"→"24.1", "30"→"30").
// Keeps the delta phrasing terse and stable across the float noise of click-capture coords.
function pctStr(v) {
  return String(Number(Number(v).toFixed(1)));
}

// Axes nearer than this (% of comp) read as unchanged — mirrors the arrow zero-length and
// span-range epsilons, so a no-op ghost drag produces no noise line.
const DELTA_EPS = 0.1;

// Pure, render-free description of a note's desired-state markup, phrased as the delta a coding
// agent applies. Consumed by BOTH the server's annotations.md (renderNoteBlock) and the review
// packet's INDEX.md, so the move/resize/direction wording lives in ONE place.
//
// The "current" a desiredBox is measured against is, in order: a region note's own x/y/w/h
// (n.w != null), else the captured element rect (target.box), else nothing — a pin-only note
// states the box absolutely ("desired box 48,30 30×12%"). Unchanged axes are omitted; a
// desiredBox equal to its current box contributes nothing. A sanitized arrow is always a
// meaningful direction. Returns null when the note carries neither field or every axis is
// unchanged, so legacy notes render byte-identically.
// Returns structured `{ box, arrow }` (each a phrase string or null), or null when the note
// carries neither field / every axis is unchanged. Returning the pieces (not a joined string)
// lets the server label them directly (`- desired:` / `- direction:`) and the review packet join
// them — no consumer has to re-parse a delimiter.
export function describeDesiredDelta(note) {
  if (!note || typeof note !== "object") return null;
  let box = null;

  if (validBox(note.desiredBox)) {
    const d = note.desiredBox;
    let current = null;
    if (note.w != null && validBox(note)) current = note;            // region note → its own rect
    else if (validBox(note.target && note.target.box)) current = note.target.box; // else the element rect
    if (current) {
      const move = [];
      if (Math.abs(current.x - d.x) >= DELTA_EPS) move.push(`x ${pctStr(current.x)}→${pctStr(d.x)}%`);
      if (Math.abs(current.y - d.y) >= DELTA_EPS) move.push(`y ${pctStr(current.y)}→${pctStr(d.y)}%`);
      const seg = [];
      if (move.length) seg.push(`move ${move.join(", ")}`);
      if (Math.abs(current.w - d.w) >= DELTA_EPS || Math.abs(current.h - d.h) >= DELTA_EPS) {
        seg.push(`resize ${pctStr(current.w)}×${pctStr(current.h)}% → ${pctStr(d.w)}×${pctStr(d.h)}%`);
      }
      if (seg.length) box = seg.join(", ");
    } else {
      // Pin-only (no current box) → state it absolutely. No "desired" word — the consumer labels it.
      box = `box ${pctStr(d.x)},${pctStr(d.y)} ${pctStr(d.w)}×${pctStr(d.h)}%`;
    }
  }

  const a = note.arrow;
  const arrow = validArrow(a) ? `arrow ${pctStr(a.x1)},${pctStr(a.y1)}% → ${pctStr(a.x2)},${pctStr(a.y2)}%` : null;

  return box || arrow ? { box, arrow } : null;
}