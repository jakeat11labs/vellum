#!/usr/bin/env node
/**
 * Vellum — review/annotation server for HyperFrames compositions.
 *
 *  - Serves the user's project statically (index.html, assets, node_modules/hyperframes
 *    runtime) so the review player can mount the real composition in an iframe.
 *  - Collects time-coded review notes posted by the player and persists them to
 *    <comp>/notes/annotations.json (+ a readable annotations.md) for a coding agent to read.
 *  - Stores a saved voice/music mix to <comp>/notes/mix.json.
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
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fmtTime, normalizeNoteStatus, resolveComposition, VERSION } from "./vellum-shared.mjs";
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

const { compDir: COMP_DIR, compAbs: COMP_ABS } = resolveComposition(ROOT);

function resolveInside(base, target) {
  const full = path.resolve(base, target);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
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
  const local = HF_LOCAL_RUNTIME || (HF_NPX_DIR ? findRuntimeFile(HF_NPX_DIR) : null);
  if (local) {
    try {
      return streamFile(res, local);
    } catch {}
  }
  const verTag = HF_VERSION === "latest" ? "" : `@${HF_VERSION}`;
  res.writeHead(302, { location: `${HF_CDN}${verTag}/dist/hyperframe.runtime.iife.js`, "cache-control": "no-cache" });
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
  const verTag = HF_VERSION === "latest" ? "" : `@${HF_VERSION}`;
  res.writeHead(302, { location: `${HF_CDN}${verTag}${rest}`, "cache-control": "no-cache" });
  return res.end();
}
const NOTES_DIR = path.join(COMP_ABS, "notes");
const NOTES_JSON = path.join(NOTES_DIR, "annotations.json");
const NOTES_MD = path.join(NOTES_DIR, "annotations.md");
const MIX_JSON = path.join(NOTES_DIR, "mix.json");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_FILE = path.join(HERE, "vellum-template.html");
// Path the player opens — "/annotate.html" at root, or "/<dir>/annotate.html" for a subfolder composition.
const ANNOTATE_PATH = COMP_DIR
  ? `/${COMP_DIR.split(path.sep).map(encodeURIComponent).join("/")}/annotate.html`
  : "/annotate.html";

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
    return notes;
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
  return fn(notes);
}

function sendNotes(res, code, notes) {
  return sendJson(res, code, notes);
}

function sendNotesObject(res, code, body) {
  return sendJson(res, code, body);
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

function escapeMd(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/`/g, "\\`")
    .replace(/\|/g, "\\|")
    .trim();
}

function writeNotes(notes) {
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  fs.writeFileSync(NOTES_JSON, `${JSON.stringify(notes, null, 2)}\n`);
  const sorted = [...notes].sort((a, b) => a.time - b.time);
  const md = [
    `# Review notes${COMP_DIR ? ` — ${COMP_DIR}` : ""}`,
    "",
    `${notes.length} note(s). Times are composition-time (M:SS.ss).`,
    "",
    ...sorted.map((n) => {
      const where = n.w != null ? `box ${n.x},${n.y} ${n.w}×${n.h}%` : n.x != null ? `pin ${n.x}%, ${n.y}%` : "";
      const noteText = escapeMd(n.text);
      const targetText = n.target && n.target.text ? ` "${escapeMd(n.target.text)}"` : "";
      const tgt = n.target
        ? ` · on \`${escapeMd(n.target.tag)}${n.target.cls ? "." + escapeMd(n.target.cls) : ""}\`${targetText}`
        : "";
      const sel = n.target && n.target.selector ? ` · at \`${escapeMd(n.target.selector)}\`` : "";
      const status = normalizeNoteStatus(n.status);
      const statusTag = status !== "open" ? ` · _(${status})_` : "";
      return `- **note-${n.id}** · **${fmtTime(n.time)}**${n.scene ? ` \`${escapeMd(n.scene)}\`` : ""} — ${noteText}${where ? `  _(${where})_` : ""}${tgt}${sel}${statusTag}`;
    }),
    "",
  ].join("\n");
  fs.writeFileSync(NOTES_MD, md);
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

function boundedNumber(value, fallback, { min = -Infinity, max = Infinity, decimals = 10 } = {}) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const bounded = Math.min(max, Math.max(min, n));
  return Math.round(bounded * decimals) / decimals;
}

function noteId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function applyNotePatch(note, parsed) {
  if (parsed.text != null) {
    const text = String(parsed.text).slice(0, 2000).trim();
    if (!text) return { error: "empty note" };
    note.text = text;
  }
  if (parsed.status != null) note.status = normalizeNoteStatus(parsed.status, note.status || "open");
  note.updatedAt = new Date().toISOString();
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
        } else if (parsed.text != null) {
          logEvent(ui.glyph.edit, `${noteLabel(note)} edited ${ui.dim(`— "${ui.truncate(note.text, 48)}"`)}`);
        }
        return sendJson(res, 200, result.note);
      })
    );
  }

  return sendJson(res, 405, { error: "method not allowed" });
}

function handleNotes(req, res) {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  if (req.method === "GET") return withNotes(res, (notes) => sendNotes(res, 200, notes));
  if (req.method === "DELETE") {
    if (!recoverableWriteNotes(res, [])) return;
    logEvent(ui.glyph.del, "all notes cleared");
    return sendNotesObject(res, 200, { ok: true, notes: [] });
  }
  if (req.method === "POST") {
    return readBody(req, res, 1e6, (parsed) => {
      const text = String(parsed.text ?? "").slice(0, 2000).trim();
      if (!text) return sendJson(res, 400, { error: "empty note" });
      const pct = (v) => boundedNumber(v, null, { min: 0, max: 100 });
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
        target = {
          tag: String(parsed.target.tag ?? "").slice(0, 20),
          cls: String(parsed.target.cls ?? "").slice(0, 120),
          text: String(parsed.target.text ?? "").slice(0, 120),
          selector: parsed.target.selector ? String(parsed.target.selector).slice(0, 250) : null,
          label: parsed.target.label ? String(parsed.target.label).slice(0, 80) : null,
          box,
          data,
        };
      }
      return withNotes(res, (notes) => {
        const note = {
          id: notes.length ? Math.max(...notes.map((n) => n.id || 0)) + 1 : 1,
          time: boundedNumber(parsed.time, 0, { min: 0, decimals: 100 }),
          x: pct(parsed.x),
          y: pct(parsed.y),
          w: pct(parsed.w),
          h: pct(parsed.h),
          scene: parsed.scene ? String(parsed.scene).slice(0, 60) : null,
          target,
          text,
          status: "open",
          createdAt: new Date().toISOString(),
        };
        notes.push(note);
        if (!recoverableWriteNotes(res, notes)) return;
        logEvent(ui.glyph.add, `${noteLabel(note)} ${ui.dim(`— "${ui.truncate(note.text, 48)}"`)}`);
        return sendJson(res, 201, note);
      });
    });
  }
  return sendJson(res, 405, { error: "method not allowed" });
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
      fs.mkdirSync(NOTES_DIR, { recursive: true });
      fs.writeFileSync(MIX_JSON, `${JSON.stringify(mix, null, 2)}\n`);
      logEvent(ui.glyph.music, `mix saved ${ui.dim(`— voice ${Math.round(mix.voice * 100)}% · music ${Math.round(mix.music * 100)}%`)}`);
      return sendJson(res, 201, mix);
    });
  }
  return sendJson(res, 405, { error: "method not allowed" });
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
  if (pathname === "/" || pathname === ANNOTATE_PATH) {
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

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (pathname === RUNTIME_ENDPOINT) return serveRuntime(res);
  const noteMatch = /^\/api\/notes\/(\d+)$/.exec(pathname);
  if (noteMatch) return handleNoteById(req, res, noteMatch[1]);
  if (pathname === "/api/notes") return handleNotes(req, res);
  if (pathname === "/api/mix") return handleMix(req, res);
  return serveStatic(req, res);
});

// Honor an explicit VELLUM_PORT exactly (fail clearly if taken); otherwise hunt for the
// next free port instead of crashing with a raw EADDRINUSE stack trace.
const EXPLICIT_PORT = Boolean(process.env.VELLUM_PORT);
let activePort = PORT;

function onListen() {
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  if (!fs.existsSync(NOTES_JSON)) writeNotes(emptyNotesOnMissing());
  const compRel = path.relative(ROOT, path.join(COMP_ABS, "index.html")) || "index.html";
  const url = `http://127.0.0.1:${activePort}${ANNOTATE_PATH}`;
  const hfSource = HF_LOCAL_RUNTIME
    ? `node_modules/hyperframes ${ui.dim(`(${path.basename(HF_LOCAL_RUNTIME)})`)}`
    : HF_NPX_DIR
      ? `npx cache ${ui.dim(`(hyperframes@${HF_VERSION})`)}`
      : `jsDelivr CDN ${ui.dim(`(hyperframes@${HF_VERSION})`)}`;
  const existing = emptyNotesOnMissing();

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
  const noteCount = existing.length
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
