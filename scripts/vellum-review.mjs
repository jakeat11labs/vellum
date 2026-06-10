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
 *   VELLUM_DIR=M01L01 node scripts/vellum-review.mjs   # monorepo
 *
 * External processes are invoked with argument ARRAYS (no shell string interpolation);
 * all marker coordinates are numbers derived from the note percentages.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const COMP_DIR = (process.env.VELLUM_DIR || "").replace(/^\/+|\/+$/g, "");
const COMP = path.join(ROOT, COMP_DIR);
const NOTES_JSON = path.join(COMP, "notes", "annotations.json");
const SNAP_DIR = path.join(COMP, "snapshots");
const OUT_DIR = path.join(COMP, "notes", "review");
const ACCENT = "0x5EEAD4";

// Composition pixel size — read from index.html #root, default 1920x1080.
function compSize() {
  try {
    const html = fs.readFileSync(path.join(COMP, "index.html"), "utf8");
    const w = Number((/data-width="(\d+)"/.exec(html) || [])[1]) || 1920;
    const h = Number((/data-height="(\d+)"/.exec(html) || [])[1]) || 1080;
    return { W: w, H: h };
  } catch {
    return { W: 1920, H: 1080 };
  }
}
const { W, H } = compSize();

function fmt(t) {
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

function readNotes() {
  try {
    return JSON.parse(fs.readFileSync(NOTES_JSON, "utf8"));
  } catch {
    return [];
  }
}

// Render the composition frame at time t; return the path to the produced PNG.
function snapshot(t) {
  const before = new Set(fs.existsSync(SNAP_DIR) ? fs.readdirSync(SNAP_DIR) : []);
  const r = spawnSync("npx", ["hyperframes", "snapshot", "--at", String(t)], { cwd: COMP, encoding: "utf8" });
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

// Draw the note's marker (pin dot or region box) onto the snapshot.
function drawMarker(srcPng, note, outPng) {
  let filter;
  if (note.w != null) {
    const x = Math.round((note.x / 100) * W);
    const y = Math.round((note.y / 100) * H);
    const w = Math.round((note.w / 100) * W);
    const h = Math.round((note.h / 100) * H);
    filter = `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${ACCENT}@1.0:t=5`;
  } else if (note.x != null) {
    const cx = Math.round((note.x / 100) * W);
    const cy = Math.round((note.y / 100) * H);
    const s = 40;
    filter = `drawbox=x=${cx - s}:y=${cy - s}:w=${s * 2}:h=${s * 2}:color=${ACCENT}@1.0:t=5`;
  } else {
    // no coordinates — just copy the frame
    fs.copyFileSync(srcPng, outPng);
    return true;
  }
  const r = spawnSync("ffmpeg", ["-y", "-i", srcPng, "-vf", filter, outPng], { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`  ffmpeg draw failed for note ${note.id}: ${(r.stderr || "").trim().split("\n").pop()}`);
    return false;
  }
  return true;
}

function main() {
  const notes = readNotes().sort((a, b) => a.time - b.time);
  if (!notes.length) {
    console.log("No notes to render. Pin some in the Vellum player first.");
    return;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const index = [`# Review packet${COMP_DIR ? ` — ${COMP_DIR}` : ""}`, "", `${notes.length} note(s).`, ""];

  notes.forEach((n, i) => {
    console.log(`[${i + 1}/${notes.length}] ${fmt(n.time)} — ${n.text.slice(0, 60)}`);
    const snap = snapshot(n.time);
    const out = path.join(OUT_DIR, `note-${n.id}.png`);
    let drawn = false;
    if (snap) drawn = drawMarker(snap, n, out);
    const where = n.w != null ? `box ${n.w}×${n.h}%` : n.x != null ? `pin ${n.x}%,${n.y}%` : "—";
    const tgt = n.target ? ` · on \`${n.target.tag}${n.target.cls ? "." + n.target.cls : ""}\`` : "";
    index.push(`### ${i + 1}. ${fmt(n.time)} ${n.scene ? `\`${n.scene}\`` : ""}`);
    index.push("");
    index.push(`${n.text}`);
    index.push("");
    index.push(`_(${where}${tgt})_`);
    if (drawn) index.push("", `![note ${n.id}](note-${n.id}.png)`);
    index.push("");
  });

  fs.writeFileSync(path.join(OUT_DIR, "INDEX.md"), index.join("\n"));
  console.log(`\nWrote ${notes.length} frame(s) → ${path.relative(ROOT, OUT_DIR)}/  (see INDEX.md)`);
}

main();
