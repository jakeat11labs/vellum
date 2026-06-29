// @ts-check
/**
 * Vellum — the note store: the ONE module that reads and writes notes/annotations.json.
 *
 * Before this existed, two readers had drifted: the server filtered non-object elements and ran
 * reconcileNote; the review packet did neither (so an offline hand-edit that left a stray null in
 * the array reached its `.sort()`/render path, and offline status/severity edits weren't coerced —
 * the server and the packet could disagree). Routing both through readNotes() here makes the read
 * contract identical everywhere.
 *
 * On-disk format is, and stays, a BARE top-level JSON array — every note field is an optional
 * spread (absent-by-default), so a legacy note round-trips byte-identically. writeNotes emits
 * exactly `JSON.stringify(notes, null, 2) + "\n"` and NEVER an envelope. SCHEMA_VERSION is a
 * code-only integer (never serialized): it documents the shape and bumps only when reconcileNote's
 * normalization semantics change — it is intentionally decoupled from the tool VERSION and is not
 * part of the release parity gate. readNotes also TOLERATES a future `{schema_version, notes:[…]}`
 * envelope if some later tool ever writes one, so a newer file can't wedge an older reader — but
 * nothing here ever produces that shape.
 *
 * Zero dependencies. Imports ONLY the pure vellum-shared.mjs (reconcileNote + the shared atomic
 * writer) — never vellum-server.mjs, importing which would boot the HTTP daemon.
 */

import fs from "node:fs";
import path from "node:path";
import { reconcileNote, writeJsonAtomic } from "./vellum-shared.mjs";

// Bump ONLY when reconcileNote's normalization semantics change. Not serialized, not the tool
// version, not part of sync-version.mjs or the release sed gate — it's the version a future
// envelope-writer would stamp, and the marker readNotes tolerates on the way in (see extractArray).
export const SCHEMA_VERSION = 1;

// Accept the bare array (the only shape ever written) or a forward-compat envelope; return the raw
// notes array, or null when the parsed JSON is neither.
function extractArray(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object" && data.schema_version !== undefined && Array.isArray(data.notes)) {
    return data.notes;
  }
  return null;
}

/**
 * Read + normalize the note store at absPath.
 *  - missing file (ENOENT) → [] (the file is created on the first write)
 *  - malformed JSON or a non-array/non-envelope shape → THROWS (callers decide: the server 500s via
 *    withNotes; the review packet warns and continues with no notes; boot leaves the bad file as-is)
 *  - otherwise → drops non-object elements (a stray null/number from a hand-edit) BEFORE anything can
 *    index them, then maps reconcileNote so every consumer gets the same coercion. reconcileNote is
 *    idempotent, so callers must NOT reconcile again.
 */
export function readNotes(absPath) {
  let raw;
  try {
    raw = fs.readFileSync(absPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw new Error(`Could not read ${path.basename(absPath)}: ${err.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Could not parse ${path.basename(absPath)}: ${err.message}`);
  }
  const arr = extractArray(data);
  if (!arr) throw new Error(`${path.basename(absPath)} must contain a JSON array`);
  return arr.filter((n) => n && typeof n === "object").map(reconcileNote);
}

/**
 * Atomically write the bare-array note store. writeJsonAtomic (vellum-shared) emits EXACTLY
 * `JSON.stringify(notes, null, 2) + "\n"` via a temp file + rename — byte-identical to what Vellum has
 * always written, a bare top-level array, never an envelope (the on-disk contract agents hand-edit).
 */
export function writeNotes(absPath, notes) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  writeJsonAtomic(absPath, notes);
}
