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
const COMP_DIR = (process.env.VELLUM_DIR || "").replace(/^\/+|\/+$/g, ""); // optional subdir
const PORT = Number(process.env.VELLUM_PORT) || 4848;
const COMP_ABS = path.join(ROOT, COMP_DIR);
const NOTES_DIR = path.join(COMP_ABS, "notes");
const NOTES_JSON = path.join(NOTES_DIR, "annotations.json");
const NOTES_MD = path.join(NOTES_DIR, "annotations.md");
const MIX_JSON = path.join(NOTES_DIR, "mix.json");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_FILE = path.join(HERE, "vellum-template.html");
// Path the player opens — "/annotate.html" at root, or "/<dir>/annotate.html" in a monorepo.
const ANNOTATE_PATH = COMP_DIR ? `/${COMP_DIR}/annotate.html` : "/annotate.html";

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
    return JSON.parse(fs.readFileSync(NOTES_JSON, "utf8"));
  } catch {
    return [];
  }
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
      const tgt = n.target
        ? ` · on \`${n.target.tag}${n.target.cls ? "." + n.target.cls : ""}\`${n.target.text ? ` “${n.target.text}”` : ""}`
        : "";
      return `- **${fmtTime(n.time)}**${n.scene ? ` \`${n.scene}\`` : ""} — ${n.text}${where ? `  _(${where})_` : ""}${tgt}`;
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
  req.on("data", (c) => {
    body += c;
    if (body.length > limit) req.destroy();
  });
  req.on("end", () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return sendJson(res, 400, { error: "invalid json" });
    }
    done(parsed);
  });
}

function handleNotes(req, res) {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  if (req.method === "GET") return sendJson(res, 200, readNotes());
  if (req.method === "DELETE") {
    writeNotes([]);
    return sendJson(res, 200, { ok: true, notes: [] });
  }
  if (req.method === "POST") {
    return readBody(req, res, 1e6, (parsed) => {
      const text = String(parsed.text ?? "").slice(0, 2000).trim();
      if (!text) return sendJson(res, 400, { error: "empty note" });
      const num = (v) => (v == null ? null : Math.round(Number(v) * 10) / 10);
      let target = null;
      if (parsed.target && typeof parsed.target === "object") {
        target = {
          tag: String(parsed.target.tag ?? "").slice(0, 20),
          cls: String(parsed.target.cls ?? "").slice(0, 120),
          text: String(parsed.target.text ?? "").slice(0, 120),
        };
      }
      const notes = readNotes();
      const note = {
        id: notes.length ? Math.max(...notes.map((n) => n.id || 0)) + 1 : 1,
        time: Number(parsed.time) || 0,
        x: num(parsed.x),
        y: num(parsed.y),
        w: num(parsed.w),
        h: num(parsed.h),
        scene: parsed.scene ? String(parsed.scene).slice(0, 60) : null,
        target,
        text,
        createdAt: new Date().toISOString(),
      };
      notes.push(note);
      writeNotes(notes);
      return sendJson(res, 201, note);
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
      const clamp = (v, d) => (v == null ? d : Math.min(1, Math.max(0, Number(v))));
      const mix = { voice: clamp(parsed.voice, 1), music: clamp(parsed.music, 0.2), savedAt: new Date().toISOString() };
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

  // The player template — served for "/" and any "<dir>/annotate.html".
  if (pathname === "/" || pathname === ANNOTATE_PATH || /\/annotate\.html$/.test(pathname)) {
    return serveTemplate(res);
  }

  const full = path.normalize(path.join(ROOT, pathname));
  // Path-traversal guard: the resolved path must stay within ROOT.
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) {
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
        start = Math.max(0, st.size - end);
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
      return fs.createReadStream(full, { start, end }).pipe(res);
    }

    res.writeHead(200, {
      "content-type": type,
      "content-length": st.size,
      "accept-ranges": "bytes",
      "cache-control": "no-cache",
    });
    fs.createReadStream(full).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (pathname === "/api/notes") return handleNotes(req, res);
  if (pathname === "/api/mix") return handleMix(req, res);
  return serveStatic(req, res);
});

server.listen(PORT, "127.0.0.1", () => {
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  if (!fs.existsSync(NOTES_JSON)) writeNotes([]);
  const compRel = path.relative(ROOT, path.join(COMP_ABS, "index.html")) || "index.html";
  if (!fs.existsSync(path.join(COMP_ABS, "index.html"))) {
    console.warn(`⚠  No composition found at ${compRel}. Run vellum from your HyperFrames project root, or set VELLUM_DIR.`);
  }
  console.log(`\n  Vellum review server  ·  http://localhost:${PORT}${ANNOTATE_PATH}`);
  console.log(`  Composition:  ${compRel}`);
  console.log(`  Notes:        ${path.relative(ROOT, NOTES_JSON)}  (+ annotations.md)\n`);
});
