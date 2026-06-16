import fs from "node:fs";
import path from "node:path";

// Installed tool version. Keep in sync with package.json on release; `vellum update`
// compares this against the published package.json version.
export const VERSION = "0.5.0";

export const NOTE_STATUSES = new Set(["open", "resolved", "wontfix"]);

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