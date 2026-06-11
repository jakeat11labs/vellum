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
 *   VELLUM_DIR=M01L01 npx vellum   # composition is ./M01L01/index.html (monorepo)
 * Then open the printed URL.
 *
 * Local-only by design: binds to 127.0.0.1, no CORS headers, path-traversal guarded.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd(); // the HyperFrames project root (holds index.html + node_modules)
const PORT = Number(process.env.VELLUM_PORT) || 4848;

function cleanCompDir(value) {
  const raw = String(value || "").replace(/^[/\\]+|[/\\]+$/g, "");
  if (!raw || raw === ".") return "";
  const normalized = path.normalize(raw);
  if (
    path.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`) ||
    normalized.split(path.sep).includes("..")
  ) {
    console.error(`VELLUM_DIR must stay inside the project root: ${value}`);
    process.exit(1);
  }
  return normalized;
}

function resolveInside(base, target) {
  const full = path.resolve(base, target);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

const COMP_DIR = cleanCompDir(process.env.VELLUM_DIR); // optional subdir
const COMP_ABS = resolveInside(ROOT, COMP_DIR || ".");
if (!COMP_ABS) {
  console.error(`VELLUM_DIR must stay inside the project root: ${process.env.VELLUM_DIR}`);
  process.exit(1);
}
const NOTES_DIR = path.join(COMP_ABS, "notes");
const NOTES_JSON = path.join(NOTES_DIR, "annotations.json");
const NOTES_MD = path.join(NOTES_DIR, "annotations.md");
const MIX_JSON = path.join(NOTES_DIR, "mix.json");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_FILE = path.join(HERE, "vellum-template.html");
// Path the player opens — "/annotate.html" at root, or "/<dir>/annotate.html" in a monorepo.
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

function fmtTime(t) {
  const total = Math.max(0, Number(t) || 0);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

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
      return `- **${fmtTime(n.time)}**${n.scene ? ` \`${escapeMd(n.scene)}\`` : ""} — ${noteText}${where ? `  _(${where})_` : ""}${tgt}`;
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

function handleNoteById(req, res, idValue) {
  const id = noteId(idValue);
  if (!id) return sendJson(res, 400, { error: "invalid note id" });
  if (req.method !== "DELETE") return sendJson(res, 405, { error: "method not allowed" });

  return withNotes(res, (notes) => {
    const next = notes.filter((n) => n.id !== id);
    if (next.length === notes.length) return sendJson(res, 404, { error: "note not found" });
    if (!recoverableWriteNotes(res, next)) return;
    return sendJson(res, 200, { ok: true, notes: next });
  });
}

function handleNotes(req, res) {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  if (req.method === "GET") return withNotes(res, (notes) => sendNotes(res, 200, notes));
  if (req.method === "DELETE") {
    if (!recoverableWriteNotes(res, [])) return;
    return sendNotesObject(res, 200, { ok: true, notes: [] });
  }
  if (req.method === "POST") {
    return readBody(req, res, 1e6, (parsed) => {
      const text = String(parsed.text ?? "").slice(0, 2000).trim();
      if (!text) return sendJson(res, 400, { error: "empty note" });
      const pct = (v) => boundedNumber(v, null, { min: 0, max: 100 });
      let target = null;
      if (parsed.target && typeof parsed.target === "object") {
        target = {
          tag: String(parsed.target.tag ?? "").slice(0, 20),
          cls: String(parsed.target.cls ?? "").slice(0, 120),
          text: String(parsed.target.text ?? "").slice(0, 120),
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
          createdAt: new Date().toISOString(),
        };
        notes.push(note);
        if (!recoverableWriteNotes(res, notes)) return;
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
  const noteMatch = /^\/api\/notes\/(\d+)$/.exec(pathname);
  if (noteMatch) return handleNoteById(req, res, noteMatch[1]);
  if (pathname === "/api/notes") return handleNotes(req, res);
  if (pathname === "/api/mix") return handleMix(req, res);
  return serveStatic(req, res);
});

server.listen(PORT, "127.0.0.1", () => {
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  if (!fs.existsSync(NOTES_JSON)) writeNotes(emptyNotesOnMissing());
  const compRel = path.relative(ROOT, path.join(COMP_ABS, "index.html")) || "index.html";
  if (!fs.existsSync(path.join(COMP_ABS, "index.html"))) {
    console.warn(`⚠  No composition found at ${compRel}. Run vellum from your HyperFrames project root, or set VELLUM_DIR.`);
  }
  console.log(`\n  Vellum review server  ·  http://localhost:${PORT}${ANNOTATE_PATH}`);
  console.log(`  Composition:  ${compRel}`);
  console.log(`  Notes:        ${path.relative(ROOT, NOTES_JSON)}  (+ annotations.md)\n`);
});
