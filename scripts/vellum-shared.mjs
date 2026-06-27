import fs from "node:fs";
import path from "node:path";

// Installed tool version. Keep in sync with package.json on release; `vellum update`
// compares this against the published package.json version.
export const VERSION = "0.7.0";

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
    }
  }
  return {
    notes: counts,
    firstPass: { fixed, reopened, rate: fixed ? Math.max(0, Math.min(1, (fixed - reopened) / fixed)) : null },
    resolveLatencyMs: metricStats(resolveLatencies),
    timeToNoteMs: metricStats(timeToNotes),
    generatedAt: new Date().toISOString(),
  };
}

// Normalize a note on READ: coerce its status to the enum, drop an invalid severity, and
// sanitize an agent-written resolution. The single seam any future envelope migration would
// rewrite — keeps offline-edited annotations.json safe and back-compatible (every new field
// is absent-by-default, so a legacy note serializes byte-identically).
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
  // Drop a non-array attachments (a hand-edit like "attachments":"sketch.png") on read so the
  // render path's .map can never throw — mirrors the severity/resolution coercion above.
  if ("attachments" in note && !Array.isArray(note.attachments)) delete out.attachments;
  return out;
}