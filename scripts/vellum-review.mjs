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
import { compSize, fmtTime, resolveComposition, VERSION } from "./vellum-shared.mjs";
import * as ui from "./vellum-ui.mjs";

const { root: ROOT, compDir: COMP_DIR, compAbs: COMP } = resolveComposition();
const NOTES_JSON = path.join(COMP, "notes", "annotations.json");
const SNAP_DIR = path.join(COMP, "snapshots");
const OUT_DIR = path.join(COMP, "notes", "review");
const ACCENT = "0x5EEAD4";

const { W, H } = compSize(COMP);

function readNotes() {
  try {
    return JSON.parse(fs.readFileSync(NOTES_JSON, "utf8"));
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      console.error(`Could not read ${path.relative(ROOT, NOTES_JSON)}: ${err.message}`);
      process.exit(1);
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

// Draw the note's marker (pin dot or region box) onto the snapshot. Pin notes whose
// target carries an element bounding box (captured via the HyperFrames picker at pin
// time) get the element's actual outline plus a small filled dot at the click point;
// older notes fall back to the generic 40px square.
function targetBox(note) {
  const b = note.target && note.target.box;
  if (!b) return null;
  const vals = [b.x, b.y, b.w, b.h].map(Number);
  if (!vals.every(Number.isFinite) || vals[2] <= 0 || vals[3] <= 0) return null;
  return {
    x: Math.round((vals[0] / 100) * W),
    y: Math.round((vals[1] / 100) * H),
    w: Math.max(4, Math.round((vals[2] / 100) * W)),
    h: Math.max(4, Math.round((vals[3] / 100) * H)),
  };
}

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
    const box = targetBox(note);
    if (box) {
      const d = 9;
      filter = `drawbox=x=${box.x}:y=${box.y}:w=${box.w}:h=${box.h}:color=${ACCENT}@1.0:t=4,drawbox=x=${cx - d}:y=${cy - d}:w=${d * 2}:h=${d * 2}:color=${ACCENT}@1.0:t=fill`;
    } else {
      const s = 40;
      filter = `drawbox=x=${cx - s}:y=${cy - s}:w=${s * 2}:h=${s * 2}:color=${ACCENT}@1.0:t=5`;
    }
  } else {
    // no coordinates — just copy the frame
    fs.copyFileSync(srcPng, outPng);
    return true;
  }
  const r = spawnSync("ffmpeg", ["-y", "-i", srcPng, "-vf", filter, outPng], { encoding: "utf8" });
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
  const index = [`# Review packet${COMP_DIR ? ` — ${COMP_DIR}` : ""}`, "", `${notes.length} note(s).`, ""];
  let failures = 0;

  notes.forEach((n, i) => {
    const label = `${ui.bold(`note-${n.id}`)} ${ui.dim(`@ ${fmtTime(n.time)}`)} ${ui.dim(`— "${ui.truncate(n.text, 44)}"`)}`;
    if (ui.interactive) {
      process.stdout.write(`\r\x1b[K  ${ui.bar((i + 1) / notes.length)} ${i + 1}/${notes.length}  ${label}`);
    } else {
      console.log(`[${i + 1}/${notes.length}] note-${n.id} ${fmtTime(n.time)} — ${n.text.slice(0, 60)}`);
    }
    const snap = snapshot(n.time);
    const out = path.join(OUT_DIR, `note-${n.id}.png`);
    let drawn = false;
    if (snap) drawn = drawMarker(snap, n, out);
    if (!drawn) failures += 1;
    if (ui.interactive) {
      process.stdout.write("\r\x1b[K");
      console.log(`  ${drawn ? ui.glyph.ok : ui.glyph.err} ${label}`);
    }
    const where = n.w != null ? `box ${n.w}×${n.h}%` : n.x != null ? `pin ${n.x}%,${n.y}%` : "—";
    const tgt = n.target ? ` · on \`${n.target.tag}${n.target.cls ? "." + n.target.cls : ""}\`` : "";
    const sel = n.target && n.target.selector ? ` · at \`${n.target.selector}\`` : "";
    index.push(`### note-${n.id} · ${fmtTime(n.time)} ${n.scene ? `\`${n.scene}\`` : ""}`);
    index.push("");
    index.push(`${n.text}`);
    index.push("");
    index.push(`_(${where}${tgt}${sel})_`);
    if (drawn) index.push("", `![note ${n.id}](note-${n.id}.png)`);
    index.push("");
  });

  fs.writeFileSync(path.join(OUT_DIR, "INDEX.md"), index.join("\n"));
  if (failures) {
    console.error(`\n  ${ui.glyph.err} Failed to render ${failures} review marker(s). See messages above.\n`);
    process.exit(1);
  }
  console.log(`\n  ${ui.glyph.ok} Wrote ${ui.bold(notes.length)} frame(s) → ${ui.teal(`${path.relative(ROOT, OUT_DIR)}/`)}  ${ui.dim("(see INDEX.md)")}\n`);
}

main();
