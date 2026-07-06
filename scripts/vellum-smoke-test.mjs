#!/usr/bin/env node
// Not // @ts-check'd: this harness deserializes dozens of dynamic /api JSON responses (res.json() is
// typed `unknown`) and augments the spawned ChildProcess with capture fields — type-checking it would
// mean ~170 casts that degrade the test for near-zero field-drift protection. Its correctness is
// verified by RUNNING it (npm test), which is stronger than tsc for test code. The production library
// modules (shared/notes/server/review/ui/update) ARE // @ts-check'd — that's where drift matters.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(REPO, "scripts", "vellum-server.mjs");
const INSTALLER = path.join(REPO, "install.sh");

function makeTempProject(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vellum-${name}-`));
  fs.writeFileSync(
    path.join(dir, "index.html"),
    `<!doctype html><html><body>
      <div id="root" data-composition-id="main" data-start="0" data-duration="5" data-width="1080" data-height="1920">
        <section id="intro" data-start="0" data-duration="5" data-track-index="1">Hello</section>
      </div>
    </body></html>`
  );
  return dir;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(url, child) {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (child.exitCode != null) break;
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not start; stdout=${child.stdoutText || ""} stderr=${child.stderrText || ""}`);
}

async function withServer(cwd, env, fn) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER, "--no-open"], {
    cwd,
    env: { ...process.env, ...env, VELLUM_PORT: String(port), VELLUM_OPEN: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdoutText = "";
  child.stderrText = "";
  child.stdout.on("data", (chunk) => (child.stdoutText += chunk));
  child.stderr.on("data", (chunk) => (child.stderrText += chunk));
  try {
    await waitFor(`http://127.0.0.1:${port}/vellum`, child);
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

async function testServerApi() {
  const dir = makeTempProject("api");
  fs.writeFileSync(path.join(dir, "media.bin"), "0123456789");

  await withServer(dir, {}, async (base) => {
    let res = await fetch(`${base}/api/notes`);
    assert.deepEqual(await res.json(), []);

    res = await fetch(`${base}/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ time: -1, x: 140, y: -10, text: "line one\n`line two`" }),
    });
    assert.equal(res.status, 201);
    const note = await res.json();
    assert.equal(note.time, 0);
    assert.equal(note.x, 100);
    assert.equal(note.y, 0);
    // Provenance is server-stamped on POST. The temp project's index.html always hashes, so
    // indexHash is present; `commit` only appears inside a git repo (temp dirs may nest in a
    // parent repo, so never assert its ABSENCE).
    assert.match(note.provenance.indexHash, /^sha256:[0-9a-f]{16}$/);

    let md = fs.readFileSync(path.join(dir, "notes", "annotations.md"), "utf8");
    assert.match(md, /line one \\`line two\\`/);

    // Change index.html so computeProvenance() would now hash differently — this makes the
    // immutability assertion below meaningful (it would catch a PATCH that wrongly re-stamps).
    fs.writeFileSync(path.join(dir, "index.html"), '<!doctype html><div id="root" data-width="1080" data-height="1920">changed</div>');
    res = await fetch(`${base}/api/notes/${note.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "updated note", status: "resolved" }),
    });
    assert.equal(res.status, 200);
    const patched = await res.json();
    assert.equal(patched.text, "updated note");
    assert.equal(patched.status, "resolved");
    // PATCH never re-stamps provenance — the note records its creation baseline immutably, even
    // though index.html now hashes differently.
    assert.deepEqual(patched.provenance, note.provenance);

    md = fs.readFileSync(path.join(dir, "notes", "annotations.md"), "utf8");
    assert.match(md, /\*\*note-\d+\*\*/);
    assert.match(md, /\(resolved\)/);

    res = await fetch(`${base}/api/notes/${note.id}`, { method: "DELETE" });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).notes, []);

    // Rich element targets (from picker-capable HyperFrames runtimes) are sanitized
    // field-by-field: box percentages clamp, non data-* keys drop, selector persists.
    res = await fetch(`${base}/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        time: 2.4, x: 50, y: 41.2, text: "tighten this",
        target: {
          tag: "div", cls: "card", text: "Reliable",
          selector: "#features > div.card:nth-of-type(2)",
          label: "Text",
          box: { x: 24.1, y: 30, w: 10, h: 120 },
          data: { "data-start": "8", "bogus key": "dropped", "data-duration": "4" },
          style: { fontSize: "24px", fontWeight: "600", color: "rgb(168, 155, 255)", junk: "dropped" },
        },
      }),
    });
    assert.equal(res.status, 201);
    const rich = await res.json();
    assert.equal(rich.target.selector, "#features > div.card:nth-of-type(2)");
    assert.equal(rich.target.label, "Text");
    assert.deepEqual(rich.target.box, { x: 24.1, y: 30, w: 10, h: 100 });
    assert.deepEqual(rich.target.data, { "data-start": "8", "data-duration": "4" });
    assert.deepEqual(rich.target.style, { fontSize: "24px", fontWeight: "600", color: "rgb(168, 155, 255)" }); // non-whitelisted keys dropped
    md = fs.readFileSync(path.join(dir, "notes", "annotations.md"), "utf8");
    assert.match(md, /at `#features > div\.card:nth-of-type\(2\)`/);
    // Self-sufficient work order: legend + the element sub-line surfacing label/box/data-*.
    assert.match(md, /^Legend: /m);
    assert.match(md, /- element: label "Text" · box 24\.1,30 10×100% · data data-start=8, data-duration=4/);
    // Computed style at pin time → a separate sub-line, relabeled for readability.
    assert.match(md, /- style: font-size 24px · weight 600 · color rgb\(168, 155, 255\)/);
    res = await fetch(`${base}/api/notes/${rich.id}`, { method: "DELETE" });
    assert.equal(res.status, 200);

    // ── Desired-state markup (desiredBox + arrow) ──────────────────────────────────────────────
    // Both are % of comp, bounded all-or-nothing like target.box. A valid pair persists and, with
    // a current box (target.box here), renders the shared delta as a `- desired:` (box) + a
    // `- direction:` (arrow) md sub-line.
    await fetch(`${base}/api/notes`, { method: "DELETE" });
    res = await fetch(`${base}/api/notes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        time: 3, x: 20, y: 20, text: "move + point this",
        target: { tag: "div", cls: "card", box: { x: 24, y: 30, w: 10, h: 12 } },
        desiredBox: { x: 48, y: 30, w: 30, h: 12 },
        arrow: { x1: 10, y1: 10, x2: 60, y2: 40 },
      }),
    });
    assert.equal(res.status, 201);
    const want = await res.json();
    assert.deepEqual(want.desiredBox, { x: 48, y: 30, w: 30, h: 12 });
    assert.deepEqual(want.arrow, { x1: 10, y1: 10, x2: 60, y2: 40 });
    md = fs.readFileSync(path.join(dir, "notes", "annotations.md"), "utf8");
    assert.match(md, /^ *- desired: move x 24→48%, resize 10×12% → 30×12%/m); // box delta vs target.box
    assert.match(md, /^ *- direction: arrow 10,10% → 60,40%/m);               // arrow on its own labeled line
    assert.match(md, /Legend:.*- desired:/);                                  // legend documents the new sub-lines

    // Junk sanitization, all-or-nothing: a zero-size box (w=0) and a zero-length arrow each drop the
    // WHOLE field, so the agent never sees a half-specified destination.
    res = await fetch(`${base}/api/notes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        time: 4, x: 10, y: 10, text: "junk markup",
        desiredBox: { x: 5, y: 5, w: 0, h: 10 },     // w=0 → field dropped
        arrow: { x1: 50, y1: 50, x2: 50, y2: 50 },   // zero-length → dropped
      }),
    });
    const junk = await res.json();
    assert.equal(junk.desiredBox, undefined);
    assert.equal(junk.arrow, undefined);
    // Out-of-range coords clamp to 0–100 (whole field still kept since w/h are positive).
    res = await fetch(`${base}/api/notes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ time: 4, x: 10, y: 10, text: "clamped markup", desiredBox: { x: -5, y: 200, w: 30, h: 12 } }),
    });
    assert.deepEqual((await res.json()).desiredBox, { x: 0, y: 100, w: 30, h: 12 });

    // PATCH key-presence: a present box replaces, a status-only PATCH leaves both fields untouched,
    // and present-null clears (mirrors how severity/resolution ride a PATCH).
    res = await fetch(`${base}/api/notes/${want.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ desiredBox: { x: 10, y: 10, w: 20, h: 20 } }),
    });
    assert.deepEqual((await res.json()).desiredBox, { x: 10, y: 10, w: 20, h: 20 }); // replaced
    res = await fetch(`${base}/api/notes/${want.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "resolved" }),
    });
    const kept = await res.json();
    assert.deepEqual(kept.desiredBox, { x: 10, y: 10, w: 20, h: 20 }); // status-only PATCH keeps the box
    assert.deepEqual(kept.arrow, { x1: 10, y1: 10, x2: 60, y2: 40 });  // ...and the arrow
    res = await fetch(`${base}/api/notes/${want.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ desiredBox: null }),
    });
    assert.equal((await res.json()).desiredBox, undefined); // present-null clears

    // Scoped notes (whole-scene/audio/span) carry no element to move → desired-state forced null.
    res = await fetch(`${base}/api/notes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        time: 5, scene: "intro", kind: "scene", text: "whole scene",
        desiredBox: { x: 10, y: 10, w: 20, h: 20 }, arrow: { x1: 1, y1: 1, x2: 9, y2: 9 },
      }),
    });
    const scopedMarkup = await res.json();
    assert.equal(scopedMarkup.desiredBox, undefined);
    assert.equal(scopedMarkup.arrow, undefined);

    // Back-compat: a plain pin note has NO desiredBox/arrow keys and produces no `- desired:` line.
    await fetch(`${base}/api/notes`, { method: "DELETE" });
    res = await fetch(`${base}/api/notes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ time: 6, x: 30, y: 30, text: "plain pin" }),
    });
    const plain = await res.json();
    assert.equal(plain.desiredBox, undefined);
    assert.equal(plain.arrow, undefined);
    md = fs.readFileSync(path.join(dir, "notes", "annotations.md"), "utf8");
    assert.doesNotMatch(md, /^ *- desired:/m);
    assert.doesNotMatch(md, /^ *- direction:/m);
    await fetch(`${base}/api/notes`, { method: "DELETE" });

    // Composition manifest: the player POSTs a scene/timing map; the server sanitizes
    // (clamps numbers, caps strings, fixed shape) and persists notes/composition.json.
    res = await fetch(`${base}/api/composition`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        width: 1920, height: 1080, duration: 21, fps: 30,
        scenes: [{ id: "intro", start: 0, duration: 6 }, { id: "outro", start: 6, duration: 5 }],
        audio: { voice: [{ src: "assets/vo-01.mp3", start: 0.9, dur: 26.1 }], music: [{ src: "bed.mp3", start: 0, dur: 245 }] },
        captions: true,
      }),
    });
    assert.equal(res.status, 201);
    const compPost = await res.json();
    assert.equal(compPost.scenes, 2);
    // The mount baseline is returned in the POST round-trip (player captures it for drift) and
    // persisted in composition.json.
    assert.match(compPost.provenance.indexHash, /^sha256:[0-9a-f]{16}$/);
    const comp = await (await fetch(`${base}/api/composition`)).json();
    assert.equal(comp.width, 1920);
    assert.equal(comp.scenes.length, 2);
    assert.match(comp.provenance.indexHash, /^sha256:[0-9a-f]{16}$/);
    assert.equal(comp.audio.voice[0].src, "assets/vo-01.mp3"); // src stored verbatim in manifest (player already basenames per-note)
    assert.equal(comp.captions, true);
    assert.match(comp.tool, /^vellum /);
    assert.ok(comp.savedAt, "manifest stamped with savedAt");
    // With a manifest present, annotations.md header points the agent at it.
    await fetch(`${base}/api/notes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ time: 1, scene: "intro", text: "after-manifest note" }),
    });
    md = fs.readFileSync(path.join(dir, "notes", "annotations.md"), "utf8");
    assert.match(md, /1920×1080 composition/);
    assert.match(md, /composition\.json/);
    await fetch(`${base}/api/notes`, { method: "DELETE" });

    // Scoped notes: a whole-scene note keeps kind but no target; an audio note carries a
    // sanitized audio snapshot (bounded clip metadata) and renders enriched markdown.
    res = await fetch(`${base}/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ time: 3, scene: "intro", kind: "scene", text: "whole slide feels crowded" }),
    });
    assert.equal(res.status, 201);
    const sceneNote = await res.json();
    assert.equal(sceneNote.kind, "scene");
    assert.equal(sceneNote.target, null);
    assert.equal(sceneNote.audio, undefined);

    res = await fetch(`${base}/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        time: 8.6, scene: "features", kind: "audio", text: "VO is rushed here",
        audio: {
          voice: { src: "vo-02.mp3", start: 8, dur: 4, at: 0.6, line: "Build it once.", script: "Build it once. Then reuse it.", bogus: "x" },
          music: { src: "bed.mp3", start: 0, at: 8.6 },
          prev: { src: "vo-01.mp3", start: 2, script: "Here's the idea." },
          next: { src: "vo-03.mp3", start: 12 },
        },
      }),
    });
    assert.equal(res.status, 201);
    const audioNote = await res.json();
    assert.equal(audioNote.kind, "audio");
    assert.equal(audioNote.audio.voice.src, "vo-02.mp3");
    assert.equal(audioNote.audio.voice.line, "Build it once.");
    assert.equal(audioNote.audio.voice.script, "Build it once. Then reuse it.");
    assert.equal(audioNote.audio.voice.bogus, undefined); // unknown clip fields dropped
    assert.equal(audioNote.audio.prev.src, "vo-01.mp3");
    assert.equal(audioNote.audio.prev.script, "Here's the idea."); // brief clips keep a short script
    assert.equal(audioNote.audio.prev.at, undefined); // ...but no local time
    md = fs.readFileSync(path.join(dir, "notes", "annotations.md"), "utf8");
    assert.match(md, /_\(whole scene\)_/);
    assert.match(md, /_\(audio: VO vo-02\.mp3 @ 0:00\.60, music bed\.mp3\)_/);
    assert.match(md, /VO line: "Build it once\."/);
    assert.match(md, /VO clip script: "Build it once\. Then reuse it\."/);
    assert.match(md, /clip order: prev vo-01\.mp3 \(0:02\.00\) — "Here's the idea\."; next vo-03\.mp3 \(0:12\.00\)/);
    await fetch(`${base}/api/notes`, { method: "DELETE" });

    // Agent resolution write-back: PATCH a note to "addressed" with a resolution record. The
    // server sanitizes it (junk edit dropped, unparseable `at` server-stamped) and renders it as
    // md sub-lines; "addressed" is the agent's "I edited this — human, please verify" signal.
    res = await fetch(`${base}/api/notes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ time: 4, scene: "intro", text: "duration too short" }),
    });
    const wb = await res.json();
    res = await fetch(`${base}/api/notes/${wb.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: "addressed",
        resolution: {
          by: "agent", at: "not-a-date", summary: "bumped data-duration to 6",
          edits: [{ file: "index.html", selector: "#intro", detail: "+1s" }, { bogus: 1 }],
        },
      }),
    });
    assert.equal(res.status, 200);
    const addressed = await res.json();
    assert.equal(addressed.status, "addressed");
    assert.equal(addressed.resolution.by, "agent");
    assert.equal(addressed.resolution.summary, "bumped data-duration to 6");
    assert.equal(addressed.resolution.edits.length, 1); // junk {bogus:1} entry dropped
    assert.ok(Number.isFinite(Date.parse(addressed.resolution.at))); // bad `at` server-stamped
    md = fs.readFileSync(path.join(dir, "notes", "annotations.md"), "utf8");
    assert.match(md, /_\(addressed\)_/);
    assert.match(md, /- resolution by agent .*bumped data-duration to 6/);
    assert.match(md, /- edit: `index\.html` · at `#intro` · \+1s/);
    assert.match(md, /Legend:.*addressed/); // legend documents the new status
    await fetch(`${base}/api/notes`, { method: "DELETE" });

    // Time-span notes: an optional timeEnd turns a point note into an [time, timeEnd] interval. The
    // server sanitizes timeEnd like any number and renders an M:SS.ss–M:SS.ss headline when valid.
    res = await fetch(`${base}/api/notes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ time: 4, timeEnd: 6.5, text: "cut 2s" }),
    });
    assert.equal(res.status, 201);
    const spanNote = await res.json();
    assert.equal(spanNote.time, 4);
    assert.equal(spanNote.timeEnd, 6.5);
    md = fs.readFileSync(path.join(dir, "notes", "annotations.md"), "utf8");
    assert.match(md, /\*\*0:04\.00–0:06\.50\*\*/); // interval headline timecode
    await fetch(`${base}/api/notes`, { method: "DELETE" });

    // Equal (zero-length) and inverted intervals are rejected — timeEnd drops, leaving a point note.
    res = await fetch(`${base}/api/notes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ time: 5, timeEnd: 5, text: "equal collapses to a point" }),
    });
    assert.equal((await res.json()).timeEnd, undefined);
    res = await fetch(`${base}/api/notes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ time: 5, timeEnd: 3, text: "inverted dropped" }),
    });
    assert.equal((await res.json()).timeEnd, undefined);
    md = fs.readFileSync(path.join(dir, "notes", "annotations.md"), "utf8");
    assert.match(md, /\*\*0:05\.00\*\*/);    // a plain single timecode...
    assert.doesNotMatch(md, /0:05\.00–/);    // ...with no interval en-dash
    await fetch(`${base}/api/notes`, { method: "DELETE" });

    // timeEnd clamps + rounds like every number: below time → dropped; 3.009 → 3.01 (2-decimals).
    res = await fetch(`${base}/api/notes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ time: 0, timeEnd: -2, text: "negative end dropped" }),
    });
    assert.equal((await res.json()).timeEnd, undefined);
    res = await fetch(`${base}/api/notes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ time: 1, timeEnd: 3.009, text: "rounded end" }),
    });
    assert.equal((await res.json()).timeEnd, 3.01);
    await fetch(`${base}/api/notes`, { method: "DELETE" });

    // Span scoped kind: a pure timeline-range note — no element/pin (target null, no audio snapshot).
    res = await fetch(`${base}/api/notes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ time: 8, timeEnd: 10, scene: "intro", kind: "span", text: "hold this beat" }),
    });
    assert.equal(res.status, 201);
    const spanScoped = await res.json();
    assert.equal(spanScoped.kind, "span");
    assert.equal(spanScoped.target, null);
    assert.equal(spanScoped.audio, undefined);
    assert.equal(spanScoped.timeEnd, 10);
    md = fs.readFileSync(path.join(dir, "notes", "annotations.md"), "utf8");
    assert.match(md, /\*\*0:08\.00–0:10\.00\*\*/);  // interval headline
    assert.match(md, /_\(2\.00s span\)_/);           // where-clause = duration span
    assert.doesNotMatch(md, /- element:/);           // span carries no element/style sub-lines
    // Legend stays a valid "Legend: " line and now documents the interval notation.
    assert.match(md, /^Legend: /m);
    assert.match(md, /M:SS\.ss–M:SS\.ss/);
    await fetch(`${base}/api/notes`, { method: "DELETE" });

    res = await fetch(`${base}/api/mix`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ voice: 2, music: -1 }),
    });
    assert.equal(res.status, 201);
    assert.deepEqual({ voice: (await res.json()).voice, music: (await (await fetch(`${base}/api/mix`)).json()).music }, { voice: 1, music: 0 });

    res = await fetch(`${base}/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(1_100_000) }),
    });
    assert.equal(res.status, 413);

    res = await fetch(`${base}/media.bin`, { headers: { range: "bytes=-4" } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get("content-range"), "bytes 6-9/10");
    assert.equal(await res.text(), "6789");

    res = await fetch(`${base}/other/vellum`);
    assert.equal(res.status, 404);
  });
}

async function testMalformedNotesArePreserved() {
  const dir = makeTempProject("bad-notes");
  fs.mkdirSync(path.join(dir, "notes"));
  const notesPath = path.join(dir, "notes", "annotations.json");
  fs.writeFileSync(notesPath, "{not json");

  await withServer(dir, {}, async (base) => {
    // The boot reconcile (onListen → writeNotes(readNotes())) must skip the write when readNotes
    // throws on malformed JSON, leaving the file byte-identical rather than clobbering it with [].
    assert.equal(fs.readFileSync(notesPath, "utf8"), "{not json");

    let res = await fetch(`${base}/api/notes`);
    assert.equal(res.status, 500);

    res = await fetch(`${base}/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "do not overwrite" }),
    });
    assert.equal(res.status, 500);
    assert.equal(fs.readFileSync(notesPath, "utf8"), "{not json");
  });
}

function testVellumDirGuard() {
  const dir = makeTempProject("guard");
  const result = spawnSync(process.execPath, [SERVER], {
    cwd: dir,
    env: { ...process.env, VELLUM_DIR: "..", VELLUM_PORT: "49999" },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /VELLUM_DIR must stay inside/);
}

function testInstallerSkillSymlink() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vellum-install-symlink-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{\n  \"scripts\": {}\n}\n");

  const result = spawnSync(
    "sh",
    [INSTALLER, "--no-prompt", "--no-bin", "--skill-only"],
    {
      cwd: dir,
      env: {
        ...process.env,
        VELLUM_BASE_URL: pathToFileURL(REPO).href,
        VELLUM_SKILL_TARGETS: ".agents/skills/vellum .claude/skills/vellum",
      },
      encoding: "utf8",
    }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const canonical = path.join(dir, ".agents", "skills", "vellum", "SKILL.md");
  const claudeLink = path.join(dir, ".claude", "skills", "vellum");
  assert.ok(fs.existsSync(canonical));
  assert.ok(fs.lstatSync(claudeLink).isSymbolicLink());
  assert.equal(
    fs.realpathSync(claudeLink),
    fs.realpathSync(path.join(dir, ".agents", "skills", "vellum"))
  );
}

function testInstallerSubdirScripts() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vellum-install-"));
  fs.mkdirSync(path.join(dir, "compositions", "hero"), { recursive: true });
  fs.writeFileSync(path.join(dir, "compositions", "hero", "index.html"), "<!doctype html><div id=\"root\"></div>");
  fs.writeFileSync(path.join(dir, "package.json"), "{\n  \"scripts\": {}\n}\n");

  const result = spawnSync("sh", [INSTALLER, "--no-prompt", "--no-bin", "--dir", "compositions/hero"], {
    cwd: dir,
    env: { ...process.env, VELLUM_BASE_URL: pathToFileURL(REPO).href },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(fs.existsSync(path.join(dir, "scripts", "vellum")));
  assert.ok(fs.existsSync(path.join(dir, "scripts", "vellum-shared.mjs")));
  assert.ok(fs.existsSync(path.join(dir, "scripts", "vellum-server.mjs")));
  assert.ok(fs.existsSync(path.join(dir, ".agents", "skills", "vellum", "SKILL.md")));

  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  assert.match(pkg.scripts.vellum, /VELLUM_DIR='compositions\/hero'/);
  assert.match(pkg.scripts.vellum, /vellum-server\.mjs/);
  assert.match(pkg.scripts["vellum:review"], /vellum-review\.mjs/);
}

function testVellumShimFindsProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vellum-shim-"));
  const scripts = path.join(dir, "scripts");
  fs.mkdirSync(scripts);
  const shimSrc = fs.readFileSync(path.join(REPO, "scripts", "vellum-shim"));
  fs.writeFileSync(path.join(scripts, "vellum-shim"), shimSrc);
  fs.writeFileSync(path.join(scripts, "vellum"), shimSrc);
  fs.chmodSync(path.join(scripts, "vellum-shim"), 0o755);
  fs.chmodSync(path.join(scripts, "vellum"), 0o755);
  fs.writeFileSync(
    path.join(scripts, "vellum-server.mjs"),
    `import http from "node:http";\nconst s=http.createServer((q,r)=>{r.end("ok")});\ns.listen(0,"127.0.0.1",()=>{console.log("shim-ok");s.close();});\n`
  );
  fs.writeFileSync(path.join(dir, ".vellum.env"), "VELLUM_OPEN=0\nVELLUM_PORT=4861\n");
  const sub = path.join(dir, "nested", "deep");
  fs.mkdirSync(sub, { recursive: true });
  const shim = path.join(scripts, "vellum");
  const result = spawnSync("sh", [shim, "--no-open"], {
    cwd: sub,
    env: { ...process.env, PATH: `/usr/bin:/bin:${process.env.PATH || ""}` },
    encoding: "utf8",
  });
  assert.match(result.stdout, /shim-ok/);
}

async function testVersionSourcesAgree() {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version;
  const { VERSION } = await import(pathToFileURL(path.join(REPO, "scripts", "vellum-shared.mjs")));
  assert.equal(
    VERSION,
    pkg,
    `version drift — package.json '${pkg}' vs vellum-shared.mjs '${VERSION}'. Run \`npm version\` or \`node scripts/sync-version.mjs\` to resync.`
  );
}

// Foundation (F1/F2): the pure shared helpers both readers and the smoke test rely on.
async function testSharedHelpers() {
  const shared = await import(pathToFileURL(path.join(REPO, "scripts", "vellum-shared.mjs")));
  const {
    NOTE_STATUSES, NOTE_SEVERITIES, normalizeNoteSeverity, sanitizeResolution,
    fmtDuration, computeMetrics, reconcileNote, describeDesiredDelta,
  } = shared;

  // F1: the status enum gained "addressed" (agent-edited, awaiting human verify).
  assert.ok(NOTE_STATUSES.has("addressed"));

  // Severity: ordered most→least urgent; case-insensitive; unknown/absent → fallback.
  assert.deepEqual(NOTE_SEVERITIES, ["blocker", "major", "nit"]);
  assert.equal(normalizeNoteSeverity("MAJOR"), "major");
  assert.equal(normalizeNoteSeverity("bogus"), null);
  assert.equal(normalizeNoteSeverity(null), null);
  assert.equal(normalizeNoteSeverity(undefined, "nit"), "nit");

  // fmtDuration: "42s" / "4m12s" / "1h05m"; negatives clamp to 0.
  assert.equal(fmtDuration(42000), "42s");
  assert.equal(fmtDuration(252000), "4m12s");
  assert.equal(fmtDuration(3900000), "1h05m");
  assert.equal(fmtDuration(-5), "0s");

  // sanitizeResolution: bounded caps, server-stamped `at`, content-gated, junk dropped.
  assert.equal(sanitizeResolution(null), null);
  assert.equal(sanitizeResolution({ at: "2026-01-01T00:00:00.000Z" }), null); // `at` alone is not content
  const res = sanitizeResolution({
    by: "x".repeat(200), at: "not-a-date", summary: "y".repeat(1000),
    edits: [{ file: "f".repeat(300), selector: "#s", detail: "d" }, { bogus: 1 }, "nope"]
      .concat(Array.from({ length: 30 }, () => ({ detail: "z" }))),
  });
  assert.equal(res.by.length, 80);
  assert.equal(res.summary.length, 800);
  assert.ok(Number.isFinite(Date.parse(res.at))); // bad timestamp replaced with a real ISO
  assert.equal(res.edits.length, 20); // bounded; junk/non-object entries dropped
  assert.equal(res.edits[0].file.length, 250);
  const keepAt = sanitizeResolution({ summary: "s", at: "2026-02-03T04:05:06.000Z" });
  assert.equal(keepAt.at, "2026-02-03T04:05:06.000Z"); // valid agent timestamp preserved
  assert.equal(sanitizeResolution({ summary: "s", edits: "notarray" }).edits, undefined);

  // computeMetrics: note-derived counts/first-pass/latency + ledger time-to-note.
  const empty = computeMetrics([]);
  assert.deepEqual(empty.notes, { total: 0, open: 0, addressed: 0, resolved: 0, wontfix: 0 });
  assert.equal(empty.firstPass.rate, null);
  assert.equal(empty.resolveLatencyMs, null);
  assert.equal(empty.timeToNoteMs, null);
  const m = computeMetrics([
    { status: "resolved", createdAt: "2026-01-01T00:00:00.000Z", firstResolvedAt: "2026-01-01T00:01:00.000Z" },
    { status: "open", createdAt: "2026-01-01T00:00:00.000Z", firstResolvedAt: "2026-01-01T00:02:00.000Z", reopenCount: 2 },
    { status: "wontfix" },
  ]);
  assert.deepEqual(m.notes, { total: 3, open: 1, addressed: 0, resolved: 1, wontfix: 1 });
  assert.deepEqual(m.firstPass, { fixed: 2, reopened: 1, rate: 0.5 });
  assert.deepEqual(m.resolveLatencyMs, { count: 2, median: 90000, avg: 90000 });
  // M4 regression: a note fixed-then-rejected without ever resolving (open→addressed→open) carries
  // firstAddressedAt + reopenCount but NO firstResolvedAt. It must be in the `fixed` denominator so
  // `reopened` is a subset and the rate stays in [0,1] (it used to read negative / "-100%").
  const mNeg = computeMetrics([
    { status: "open", createdAt: "2026-01-01T00:00:00.000Z", firstAddressedAt: "2026-01-01T00:00:30.000Z", reopenCount: 1 },
  ]);
  assert.deepEqual(mNeg.firstPass, { fixed: 1, reopened: 1, rate: 0 });
  assert.equal(mNeg.notes.addressed, 0); // status is "open" (was reopened), so the addressed bucket is 0
  // A clean open→addressed→resolved (fixed, never reopened) is rate 1.
  const mClean = computeMetrics([
    { status: "resolved", createdAt: "2026-01-01T00:00:00.000Z", firstAddressedAt: "2026-01-01T00:00:30.000Z", firstResolvedAt: "2026-01-01T00:01:00.000Z" },
    { status: "addressed", createdAt: "2026-01-01T00:00:00.000Z", firstAddressedAt: "2026-01-01T00:00:30.000Z" },
  ]);
  assert.deepEqual(mClean.firstPass, { fixed: 2, reopened: 0, rate: 1 });
  assert.equal(mClean.notes.addressed, 1);
  // sid-aware time-to-note: a create pairs only with the anchor of its own run, never a foreign sid.
  const mSid = computeMetrics([], [
    { type: "session", sid: "A", at: "2026-01-01T00:00:00.000Z" },
    { type: "session", sid: "B", at: "2026-01-01T00:10:00.000Z" },
    { type: "create", sid: "A", at: "2026-01-01T00:00:20.000Z" },
  ]);
  assert.deepEqual(mSid.timeToNoteMs, { count: 1, median: 20000, avg: 20000 }); // paired with A (20s), not B
  // Negative latency (clock skew) dropped; time-to-note derived only from ledger anchors.
  const m2 = computeMetrics(
    [{ status: "resolved", createdAt: "2026-01-01T00:05:00.000Z", firstResolvedAt: "2026-01-01T00:04:00.000Z" }],
    [
      { type: "session", at: "2026-01-01T00:00:00.000Z" },
      { type: "create", at: "2026-01-01T00:00:30.000Z" },
      { type: "create", at: "2026-01-01T00:01:30.000Z" },
    ]
  );
  assert.equal(m2.resolveLatencyMs, null);
  assert.deepEqual(m2.timeToNoteMs, { count: 2, median: 60000, avg: 60000 });

  // reconcileNote: coerce status, drop invalid severity, sanitize resolution.
  const recon = reconcileNote({ id: 1, status: "donezo", severity: "BOGUS", resolution: { summary: "s", edits: "notarray", bogus: 1 } });
  assert.equal(recon.status, "open");
  assert.equal(recon.severity, undefined);
  assert.equal(recon.resolution.summary, "s");
  assert.equal(recon.resolution.edits, undefined);
  assert.equal(recon.resolution.bogus, undefined);
  assert.ok(!("resolution" in reconcileNote({ resolution: { at: "2026-01-01T00:00:00.000Z" } }))); // no content → dropped
  // Back-compat: a legacy note (valid status, no new fields) serializes byte-identically.
  const legacy = { id: 9, time: 4, x: 50, y: 50, w: null, h: null, scene: "intro", target: null, text: "ok", status: "resolved", createdAt: "2026-01-01T00:00:00.000Z" };
  assert.equal(JSON.stringify(reconcileNote(legacy)), JSON.stringify(legacy));

  // reconcileNote drops a malformed desired-state field (offline hand-edit) so a render path's
  // `.x` access can't throw, but preserves a well-formed one and never invents an absent field.
  assert.ok(!("desiredBox" in reconcileNote({ desiredBox: "oops" })));
  assert.ok(!("desiredBox" in reconcileNote({ desiredBox: { x: 1, y: 2, w: 3 } }))); // 3 numbers → dropped
  assert.ok(!("arrow" in reconcileNote({ arrow: { x1: 1, y1: 2, x2: 3 } }))); // missing y2 → dropped
  const goodMarkup = { id: 1, desiredBox: { x: 1, y: 2, w: 3, h: 4 }, arrow: { x1: 1, y1: 2, x2: 3, y2: 4 } };
  assert.deepEqual(reconcileNote(goodMarkup).desiredBox, { x: 1, y: 2, w: 3, h: 4 }); // valid box preserved
  assert.deepEqual(reconcileNote(goodMarkup).arrow, { x1: 1, y1: 2, x2: 3, y2: 4 }); // valid arrow preserved

  // describeDesiredDelta: the single shared delta phrasing, returned STRUCTURED as {box, arrow}
  // (the server labels each piece, the review packet joins them).
  assert.equal(describeDesiredDelta({ id: 1 }), null); // neither field → null
  // Region note: "current" is its OWN x/y/w/h. x + w/h change; the unchanged y axis is omitted.
  const region = describeDesiredDelta({ x: 24, y: 30, w: 10, h: 12, desiredBox: { x: 48, y: 30, w: 30, h: 12 } });
  assert.match(region.box, /move x 24→48%/);
  assert.match(region.box, /resize 10×12% → 30×12%/);
  assert.doesNotMatch(region.box, /y /); // y unchanged → omitted
  assert.equal(region.arrow, null);
  // desiredBox equal to the current box → no delta.
  assert.equal(describeDesiredDelta({ x: 24, y: 30, w: 10, h: 12, desiredBox: { x: 24, y: 30, w: 10, h: 12 } }), null);
  // Element pin: "current" comes from target.box when there is no region rect.
  assert.equal(
    describeDesiredDelta({ x: 50, y: 50, w: null, h: null, target: { box: { x: 24, y: 30, w: 10, h: 12 } }, desiredBox: { x: 48, y: 30, w: 30, h: 12 } }).box,
    "move x 24→48%, resize 10×12% → 30×12%"
  );
  // Pin-only, no current box → absolute phrasing (no doubled "desired" word — the consumer labels it).
  assert.equal(
    describeDesiredDelta({ x: 50, y: 50, w: null, h: null, target: null, desiredBox: { x: 48, y: 30, w: 30, h: 12 } }).box,
    "box 48,30 30×12%"
  );
  // Arrow phrasing, independent of pin coords; a malformed box on the same note is ignored.
  const arrowOnly = describeDesiredDelta({ arrow: { x1: 10, y1: 10, x2: 60, y2: 40 } });
  assert.equal(arrowOnly.arrow, "arrow 10,10% → 60,40%");
  assert.equal(arrowOnly.box, null);
}

// Foundation (F3): boot regenerates annotations.{json,md} from reconciled notes, so an
// offline-edited annotations.json (unknown status, junk resolution) is coerced on next boot.
async function testBootReconcilesOfflineEdits() {
  const dir = makeTempProject("boot-reconcile");
  fs.mkdirSync(path.join(dir, "notes"));
  const notesPath = path.join(dir, "notes", "annotations.json");
  fs.writeFileSync(notesPath, JSON.stringify([
    {
      id: 1, time: 2, x: 50, y: 50, w: null, h: null, scene: "intro", target: null,
      text: "offline edit", status: "donezo", severity: "BOGUS",
      resolution: { summary: "bumped duration", edits: "notarray", bogus: 1 },
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ]));

  await withServer(dir, {}, async (base) => {
    const notes = await (await fetch(`${base}/api/notes`)).json();
    assert.equal(notes.length, 1);
    const n = notes[0];
    assert.equal(n.status, "open"); // unknown status coerced
    assert.equal(n.severity, undefined); // invalid severity dropped
    assert.equal(n.resolution.summary, "bumped duration");
    assert.equal(n.resolution.edits, undefined); // non-array edits dropped
    assert.equal(n.resolution.bogus, undefined); // unknown field dropped
    assert.ok(Number.isFinite(Date.parse(n.resolution.at))); // server-stamped `at`

    // annotations.md regenerated on boot; annotations.json rewritten canonical.
    const md = fs.readFileSync(path.join(dir, "notes", "annotations.md"), "utf8");
    assert.match(md, /\*\*note-1\*\* .* offline edit/);
    const onDisk = fs.readFileSync(notesPath, "utf8");
    assert.doesNotMatch(onDisk, /donezo|BOGUS|notarray|bogus/);
  });
}

// Write-back caps + clear semantics, exercised through the live PATCH endpoint (the pure
// sanitizer is unit-tested in testSharedHelpers; this proves the round-trip, the delete-on-null
// clear, and that a status-only PATCH leaves an existing resolution untouched).
async function testAgentResolutionWriteback() {
  const dir = makeTempProject("writeback");
  await withServer(dir, {}, async (base) => {
    let res = await fetch(`${base}/api/notes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ time: 1, text: "fix me" }),
    });
    const note = await res.json();

    // Oversized strings clamp; a 30-element edits array is bounded to 20; `at` is stamped.
    res = await fetch(`${base}/api/notes/${note.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: "addressed",
        resolution: {
          by: "b".repeat(200), summary: "s".repeat(1000),
          edits: Array.from({ length: 30 }, (_, i) => ({ file: "f".repeat(300), detail: `edit ${i}` })),
        },
      }),
    });
    assert.equal(res.status, 200);
    let patched = await res.json();
    assert.equal(patched.resolution.by.length, 80);
    assert.equal(patched.resolution.summary.length, 800);
    assert.equal(patched.resolution.edits.length, 20);
    assert.equal(patched.resolution.edits[0].file.length, 250);
    assert.ok(Number.isFinite(Date.parse(patched.resolution.at))); // stamped (none supplied)

    // resolution:null clears it (field deleted, not stored as null); status untouched.
    res = await fetch(`${base}/api/notes/${note.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolution: null }),
    });
    assert.equal(res.status, 200);
    patched = await res.json();
    assert.equal(patched.resolution, undefined);
    assert.equal(patched.status, "addressed");

    // A status-only PATCH (resolution absent) must NOT wipe an existing resolution — this is the
    // human-verify path (addressed→resolved keeps the audit trail).
    await fetch(`${base}/api/notes/${note.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolution: { summary: "again" } }),
    });
    res = await fetch(`${base}/api/notes/${note.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "resolved" }),
    });
    patched = await res.json();
    assert.equal(patched.status, "resolved");
    assert.equal(patched.resolution.summary, "again"); // preserved through a status-only PATCH
  });
}

// Write-back, offline path: an agent edits annotations.json directly while the server is stopped,
// setting status "addressed" + a resolution (and another note with junk status/edits). On boot the
// server reconciles (preserves a valid status, coerces a junk one, sanitizes resolution, stamps a
// missing `at`) and regenerates annotations.md with the write-back sub-lines.
async function testAgentJsonReconciledOnBoot() {
  const dir = makeTempProject("writeback-boot");
  fs.mkdirSync(path.join(dir, "notes"));
  const notesPath = path.join(dir, "notes", "annotations.json");
  fs.writeFileSync(notesPath, JSON.stringify([
    {
      id: 1, time: 4, x: null, y: null, w: null, h: null, scene: "intro", target: null,
      text: "duration too short", status: "addressed",
      resolution: {
        by: "agent", summary: "bumped data-duration to 6",
        edits: [{ file: "index.html", selector: "#intro", detail: "+1s" }, { bogus: 1 }],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: 2, time: 6, x: null, y: null, w: null, h: null, scene: "outro", target: null,
      text: "second", status: "donezo",
      resolution: { summary: "x", edits: "notarray", bogus: 1 },
      createdAt: "2026-01-01T00:00:01.000Z",
    },
    {
      // A hand-edit that set attachments to a non-array with a truthy length would, unguarded,
      // throw in the md render (.map) and wedge EVERY write. It must be dropped on read, not crash.
      id: 3, time: 7, x: null, y: null, w: null, h: null, scene: "outro", target: null,
      text: "bad attachments", status: "open", attachments: "sketch.png",
      createdAt: "2026-01-01T00:00:02.000Z",
    },
  ]));

  await withServer(dir, {}, async (base) => {
    const notes = await (await fetch(`${base}/api/notes`)).json();
    const a = notes.find((n) => n.id === 1);
    const b = notes.find((n) => n.id === 2);
    const c = notes.find((n) => n.id === 3);
    assert.equal(c.attachments, undefined); // non-array attachments dropped on read, not crashed-on
    // Writes are NOT wedged by the bad note: a fresh POST still succeeds and the md regenerates.
    const fresh = await fetch(`${base}/api/notes`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ time: 1, text: "still writable" }),
    });
    assert.equal(fresh.status, 201);
    assert.equal(a.status, "addressed"); // valid agent status preserved
    assert.equal(a.resolution.edits.length, 1); // junk {bogus:1} edit dropped
    assert.ok(Number.isFinite(Date.parse(a.resolution.at))); // server-stamped (none supplied)
    assert.equal(b.status, "open"); // unknown status coerced
    assert.equal(b.resolution.summary, "x");
    assert.equal(b.resolution.edits, undefined); // non-array edits dropped
    assert.equal(b.resolution.bogus, undefined); // unknown field dropped

    // annotations.md regenerated on boot with the write-back sub-lines; json canonicalized.
    const md = fs.readFileSync(path.join(dir, "notes", "annotations.md"), "utf8");
    assert.match(md, /_\(addressed\)_/);
    assert.match(md, /- resolution by agent .*bumped data-duration to 6/);
    assert.match(md, /- edit: `index\.html` · at `#intro` · \+1s/);
    const onDisk = fs.readFileSync(notesPath, "utf8");
    assert.doesNotMatch(onDisk, /donezo|notarray/);
    assert.doesNotMatch(onDisk, /"bogus"/);
  });
}

function gitAvailable() {
  try {
    return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

function ffmpegAvailable() {
  try {
    return spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

// Recursive fs.watch is the engine behind /api/watch live-reload. Some platforms don't deliver
// recursive watch events at all (observed on certain macOS builds; also network filesystems), so a
// rev-bump assertion would fail there for reasons unrelated to the code. Probe the real capability —
// watch a temp dir, write into it, see if an event arrives — and let testWatchEndpoint skip when it
// doesn't, mirroring the gitAvailable()/ffmpegAvailable() gates. CI on Linux/inotify still exercises it.
async function recursiveWatchDelivers() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vellum-watchcap-"));
  let watcher;
  try {
    return await new Promise((resolve) => {
      let done = false;
      const finish = (val) => { if (!done) { done = true; resolve(val); } };
      try {
        watcher = fs.watch(dir, { recursive: true }, () => finish(true));
        watcher.on("error", () => finish(false));
      } catch { return finish(false); }
      setTimeout(() => { try { fs.writeFileSync(path.join(dir, "probe.txt"), "x"); } catch {} }, 50);
      setTimeout(() => finish(false), 1500); // resolves fast when watch works; full wait only when broken
    });
  } finally {
    try { watcher?.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A 1×1 PNG — stand-in for a rendered composition frame in the before/after cache tests. drawMarker
// just copyFileSync's it for a coord-less note, so its exact bytes don't matter, only that it exists.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

// Provenance (keystone): each note + the composition manifest are stamped with the git commit
// and the sha256 of index.html they were pinned against. A note whose hash differs from the
// current mount baseline is flagged `_(stale: …)_` in annotations.md, and the header cites the
// baseline. Git-gated (skipped where git is unavailable) since it needs a real commit SHA.
async function testProvenanceStaleDetection() {
  if (!gitAvailable()) {
    console.log("  (skipped testProvenanceStaleDetection — git unavailable)");
    return;
  }
  const dir = makeTempProject("provenance");
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  };
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Vellum Test");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");

  await withServer(dir, {}, async (base) => {
    // note-1 is pinned against the original index.html (baseline A).
    let res = await fetch(`${base}/api/notes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ time: 1, scene: "intro", text: "first note" }),
    });
    assert.equal(res.status, 201);
    const note1 = await res.json();
    assert.match(note1.provenance.commit, /^[0-9a-f]{40}$/); // inside a git repo → commit present
    assert.match(note1.provenance.indexHash, /^sha256:[0-9a-f]{16}$/);

    // Mount baseline A.
    await fetch(`${base}/api/composition`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ width: 1080, height: 1920, duration: 5, scenes: [{ id: "intro", start: 0, duration: 5 }] }),
    });

    // The composition's index.html changes under the note.
    fs.writeFileSync(
      path.join(dir, "index.html"),
      `<!doctype html><html><body><div id="root" data-width="1080" data-height="1920">Edited body</div></body></html>`
    );

    // Mount baseline B (the new content).
    res = await fetch(`${base}/api/composition`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ width: 1080, height: 1920, duration: 5, scenes: [{ id: "intro", start: 0, duration: 5 }] }),
    });
    const baselineB = (await res.json()).provenance.indexHash;
    assert.notEqual(note1.provenance.indexHash, baselineB); // content genuinely drifted

    // note-2 is pinned against baseline B (the current bytes).
    res = await fetch(`${base}/api/notes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ time: 2, scene: "intro", text: "second note" }),
    });
    const note2 = await res.json();
    assert.equal(note2.provenance.indexHash, baselineB);

    // annotations.md: note-1 (hash A) is stale vs the manifest (hash B); note-2 (hash B) is not.
    const md = fs.readFileSync(path.join(dir, "notes", "annotations.md"), "utf8");
    const lines = md.split("\n");
    const n1 = lines.find((l) => l.includes("**note-1**"));
    const n2 = lines.find((l) => l.includes("**note-2**"));
    assert.match(n1, /_\(stale: composition changed since pinned\)_/);
    assert.doesNotMatch(n2, /stale/);
    // Header cites the current mount baseline (commit + index hash).
    assert.match(md, /Review baseline: commit `[0-9a-f]{7}` · index `sha256:[0-9a-f]{16}`/);
  });
}

// indexHashOf (shared) is the single content fingerprint the server's computeProvenance stamps
// onto every note and the review packet's before/after cache keys off. Guards the step-4 refactor:
// the helper must keep the pinned `sha256:`+16-hex shape AND produce the EXACT value the server
// stamps for the same index.html (no git needed — indexHash is present regardless of a repo).
async function testIndexHashOf() {
  const { indexHashOf } = await import(pathToFileURL(path.join(REPO, "scripts", "vellum-shared.mjs")));
  const dir = makeTempProject("indexhash");
  const local = indexHashOf(dir);
  assert.match(local, /^sha256:[0-9a-f]{16}$/);
  assert.equal(indexHashOf(path.join(dir, "does-not-exist")), null); // missing index.html → null
  await withServer(dir, {}, async (base) => {
    const res = await fetch(`${base}/api/notes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ time: 1, scene: "intro", text: "n" }),
    });
    assert.equal(res.status, 201);
    const note = await res.json();
    // The shared helper must equal what computeProvenance() stamped server-side.
    assert.equal(note.provenance.indexHash, local);
  });
}

// Severity (reviewer-set blocker/major/nit) + same-target clustering. Severity round-trips through
// POST/PATCH (presence-guarded clear), renders a bold ` · **<sev>**` headline token, and reorders the
// markdown severity-then-time. Notes sharing a target.selector (≥2) cluster under a header bullet;
// loose notes and clusters share the one renderNoteBlock path. annotations.json stays a flat array.
async function testSeverityAndClustering() {
  const dir = makeTempProject("severity");
  await withServer(dir, {}, async (base) => {
    const post = (body) => fetch(`${base}/api/notes`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }).then((r) => r.json());
    const readMd = () => fs.readFileSync(path.join(dir, "notes", "annotations.md"), "utf8");

    // --- round-trip: set on POST, garbage → omitted, PATCH change + null-clear ---
    const nA = await post({ time: 1, text: "A", severity: "blocker" });
    assert.equal(nA.severity, "blocker");
    const nB = await post({ time: 2, text: "B", severity: "bogus" });
    assert.equal(nB.severity, undefined); // invalid enum → field omitted (never persisted)
    const nC = await post({ time: 3, text: "C" });
    assert.equal(nC.severity, undefined); // absent → omitted

    let md = readMd();
    // Bold headline token after the scene slot, distinct from the italic status tag.
    assert.match(md, /\*\*note-1\*\* · \*\*0:01\.00\*\* · \*\*blocker\*\* — A/);

    let res = await fetch(`${base}/api/notes/${nB.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ severity: "major" }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).severity, "major");
    assert.match(readMd(), /\*\*major\*\*/);

    // null clears it (presence-guard: "severity" in parsed) → key deleted, token gone from md.
    res = await fetch(`${base}/api/notes/${nB.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ severity: null }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).severity, undefined);
    assert.doesNotMatch(readMd(), /\*\*major\*\*/); // nB was the only major note

    await fetch(`${base}/api/notes`, { method: "DELETE" });

    // --- clustering + severity-then-time ordering ---
    const target = (selector, tag, cls) => ({ tag, cls, selector });
    const c1 = await post({ time: 2, text: "cluster member nit", severity: "nit", target: target("#hero .title", "h1", "title") });
    const c2 = await post({ time: 1, text: "cluster member blocker", severity: "blocker", target: target("#hero .title", "h1", "title") });
    await post({ time: 0.5, text: "lonely nit", severity: "nit", target: target("#para-nit", "p", "") });
    await post({ time: 9, text: "lonely blocker", severity: "blocker", target: target("#para-blocker", "p", "") });

    md = readMd();
    // Cluster header bullet: count, tag.cls, top-severity token, shared selector.
    assert.match(md, /- \*\*2 notes on `h1\.title`\*\* · \*\*blocker\*\* · at `#hero \.title`/);
    // Both members render under the header, indented two spaces (clustered).
    assert.match(md, new RegExp(`\\n  - \\*\\*note-${c1.id}\\*\\*`));
    assert.match(md, new RegExp(`\\n  - \\*\\*note-${c2.id}\\*\\*`));
    // Exactly one cluster formed — the two single-selector notes stayed loose (no "1 notes on" header).
    assert.equal((md.match(/notes on `/g) || []).length, 1);
    // Within the cluster, the blocker member precedes the nit member (severity-then-time).
    assert.ok(md.indexOf("cluster member blocker") < md.indexOf("cluster member nit"));
    // Across units, the blocker note sorts before the nit note despite being LATER in time.
    assert.ok(md.indexOf("lonely blocker") < md.indexOf("lonely nit"));
    // Cluster members stay grouped: the cluster's nit member still precedes the loose blocker note.
    assert.ok(md.indexOf("cluster member nit") < md.indexOf("lonely blocker"));

    // annotations.json stays a bare top-level array (no envelope) carrying the severity field.
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "notes", "annotations.json"), "utf8"));
    assert.ok(Array.isArray(onDisk));
    assert.equal(onDisk.find((n) => n.id === c2.id).severity, "blocker");
  });
}

async function testAttachments() {
  const dir = makeTempProject("attachments");
  // 1×1 transparent PNG — a real, valid image so the magic-byte sniff passes on genuine bytes.
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );

  await withServer(dir, {}, async (base) => {
    const postNote = (body) => fetch(`${base}/api/notes`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const upload = (buf, type) => fetch(`${base}/api/attachments`, { method: "POST", headers: { "content-type": type }, body: buf });
    const readMd = () => fs.readFileSync(path.join(dir, "notes", "annotations.md"), "utf8");

    // --- raw-binary upload: a real PNG → 201, server-generated path, file actually written ---
    let res = await upload(PNG, "image/png");
    assert.equal(res.status, 201);
    const desc = await res.json();
    assert.match(desc.file, /^attachments\/att-.*\.png$/);
    assert.equal(desc.bytes, PNG.length);
    assert.equal(desc.type, "image/png");
    assert.ok(fs.existsSync(path.join(dir, "notes", desc.file)), "uploaded PNG written under notes/attachments/");

    // --- each remaining allowlisted format, positively: minimal valid header → 201 + correct ext,
    //     pinning the JPEG/GIF/WEBP magic-byte branches (only PNG was covered before) ---
    const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const GIF = Buffer.from("GIF89a", "latin1");
    const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);
    for (const [buf, type, ext] of [[JPG, "image/jpeg", "jpg"], [GIF, "image/gif", "gif"], [WEBP, "image/webp", "webp"]]) {
      const r = await upload(buf, type);
      assert.equal(r.status, 201, `${type} should upload`);
      assert.match((await r.json()).file, new RegExp(`^attachments/att-.*\\.${ext}$`));
    }

    // --- type allowlist: SVG (stored-XSS) and text rejected; magic-byte mismatch rejected ---
    assert.equal((await upload(Buffer.from("<svg/>"), "image/svg+xml")).status, 415);
    assert.equal((await upload(Buffer.from("hello"), "text/plain")).status, 415);
    assert.equal((await upload(Buffer.from("hello"), "image/png")).status, 415); // claims PNG, bytes aren't
    assert.equal(fs.readdirSync(path.join(dir, "notes", "attachments")).length, 4); // PNG + JPG + GIF + WEBP landed; rejects wrote nothing

    // --- over the size cap → 413 (mirrors the notes 413 case) ---
    assert.equal((await upload(Buffer.alloc(4_000_001), "image/png")).status, 413);
    // --- non-POST → 405 ---
    assert.equal((await fetch(`${base}/api/attachments`)).status, 405);

    // --- note-link sanitization: only the valid, on-disk, allowed-type entry survives ---
    res = await postNote({
      time: 1, text: "see sketch",
      attachments: [
        { file: desc.file, name: desc.name, bytes: desc.bytes, type: "image/png", w: 1280, h: 720 },
        { file: "../../etc/passwd", name: "x", bytes: 1, type: "image/png" },          // traversal → regex fails
        { file: "attachments/att-missing.png", name: "y", bytes: 1, type: "image/png" }, // not on disk → dropped
        { file: desc.file, name: "z", bytes: 1, type: "text/plain" },                    // bad type → dropped
      ],
    });
    assert.equal(res.status, 201);
    const note = await res.json();
    assert.equal(note.attachments.length, 1);
    assert.equal(note.attachments[0].file, desc.file);
    assert.equal(note.attachments[0].w, 1280);
    assert.equal(note.attachments[0].h, 720);

    // --- annotations.md surfaces the openable path + (PNG, W×H, size) hint; legend documents it ---
    assert.match(readMd(), /- ref images: `attachments\/att-[\w.-]+\.png` \(PNG, 1280×720,/);
    assert.match(readMd(), /Legend:.*ref images/);

    // --- PATCH: status-only leaves attachments untouched (key absent); empty array clears them ---
    res = await fetch(`${base}/api/notes/${note.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "resolved" }),
    });
    assert.equal((await res.json()).attachments.length, 1);
    res = await fetch(`${base}/api/notes/${note.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ attachments: [] }),
    });
    assert.equal((await res.json()).attachments, undefined); // empty → field removed
    // The legend always mentions "- ref images: …"; the per-note sub-line is the backtick-path form.
    assert.doesNotMatch(readMd(), /- ref images: `attachments\//);
    await fetch(`${base}/api/notes`, { method: "DELETE" });

    // --- per-note cap: 6 valid refs (same on-disk file) → clamped to 4 ---
    const six = Array.from({ length: 6 }, () => ({ file: desc.file, name: desc.name, bytes: desc.bytes, type: "image/png" }));
    res = await postNote({ time: 2, text: "many", attachments: six });
    assert.equal((await res.json()).attachments.length, 4);

    // --- back-compat: a note with no attachments renders no ref-images sub-line ---
    await fetch(`${base}/api/notes`, { method: "DELETE" });
    await postNote({ time: 3, text: "plain note" });
    assert.doesNotMatch(readMd(), /- ref images: `attachments\//);
  });
}

// Self-measuring metrics ledger: two per-note counters (firstResolvedAt/reopenCount maintained by
// applyNotePatch) plus an append-only notes/metrics.jsonl event log, surfaced via GET /api/metrics, a
// ## Metrics footer, and a shutdown summary. The pure computeMetrics math is unit-tested in
// testSharedHelpers; this proves the live lifecycle counters, the endpoint shape, the JSONL contents,
// and the additive footer.
async function testMetricsLedger() {
  const dir = makeTempProject("metrics");
  await withServer(dir, {}, async (base) => {
    const post = (body) => fetch(`${base}/api/notes`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }).then((r) => r.json());
    const patch = (id, body) => fetch(`${base}/api/notes/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }).then((r) => r.json());

    // A mount anchor (composition POST) so a later create has a time-to-note baseline in the ledger.
    await fetch(`${base}/api/composition`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ width: 1080, height: 1920, duration: 5, scenes: [{ id: "intro", start: 0, duration: 5 }] }),
    });

    // --- lifecycle counters live INSIDE the notes array (applyNotePatch maintains them) ---
    const n = await post({ time: 1, scene: "intro", text: "fix me" });
    assert.equal(n.firstResolvedAt, undefined); // born open — no counters yet
    assert.equal(n.reopenCount, undefined);

    let p = await patch(n.id, { status: "resolved" });
    assert.ok(Number.isFinite(Date.parse(p.firstResolvedAt))); // stamped on the first →resolved
    assert.equal(p.reopenCount, undefined);
    const firstResolved = p.firstResolvedAt;

    p = await patch(n.id, { status: "open" }); // human rejected the fix → failed first pass
    assert.equal(p.reopenCount, 1);
    p = await patch(n.id, { status: "addressed" }); // agent re-edits
    p = await patch(n.id, { status: "open" }); // rejected again — (addressed→open) also counts
    assert.equal(p.reopenCount, 2);

    p = await patch(n.id, { status: "resolved" }); // re-resolve must NOT move firstResolvedAt
    assert.equal(p.firstResolvedAt, firstResolved); // set once, never overwritten
    assert.equal(p.reopenCount, 2);

    // --- GET /api/metrics: note-derived summary shape ---
    const metrics = await (await fetch(`${base}/api/metrics`)).json();
    assert.deepEqual(Object.keys(metrics.notes).sort(), ["addressed", "open", "resolved", "total", "wontfix"]);
    assert.equal(metrics.notes.total, 1);
    assert.equal(metrics.notes.resolved, 1);
    assert.equal(metrics.firstPass.fixed, 1);     // one note was fixed (firstAddressedAt/firstResolvedAt)
    assert.equal(metrics.firstPass.reopened, 1);  // one note carries reopenCount>0
    assert.equal(metrics.firstPass.rate, 0);      // (1-1)/1
    assert.ok(metrics.resolveLatencyMs); // a resolved note → a latency sample
    // Value check (not just key-presence): the mount anchor + this create pair via sid into one sample,
    // exercising the loadMetricsEvents → /api/metrics → computeMetrics(events) wiring.
    assert.ok(metrics.timeToNoteMs && metrics.timeToNoteMs.count >= 1);

    // ?events=1 returns the bounded raw ledger alongside the summary.
    const withEvents = await (await fetch(`${base}/api/metrics?events=1`)).json();
    assert.ok(Array.isArray(withEvents.events));
    assert.ok(withEvents.summary && withEvents.summary.notes);
    assert.ok(withEvents.events.every((e) => e && typeof e === "object"));

    // --- metrics.jsonl is valid JSONL, server-authored, and carries NO note text ---
    const raw = fs.readFileSync(path.join(dir, "notes", "metrics.jsonl"), "utf8");
    const events = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l)); // throws on any invalid line
    assert.ok(events.some((e) => e.type === "session")); // boot anchor
    assert.ok(events.some((e) => e.type === "mount"));    // composition POST
    const create = events.find((e) => e.type === "create");
    assert.ok(create && create.id === n.id && create.scene === "intro" && !("text" in create));
    assert.ok(events.some((e) => e.type === "status" && e.from === "open" && e.to === "resolved"));
    assert.ok(!raw.includes("fix me")); // never stores note text (bounded size, no PII)

    // --- annotations.md ## Metrics footer (note-derived; additive; existing md assertions still hold) ---
    const md = fs.readFileSync(path.join(dir, "notes", "annotations.md"), "utf8");
    assert.match(md, /## Metrics/);
    assert.match(md, /First-pass fix rate/);
    assert.match(md, /\*\*note-\d+\*\*/); // the footer didn't displace the note list
  });
}

// Best-effort isolation: a corrupt metrics ledger must never wedge the note path. A torn line is
// skipped, POST still 201s, and /api/metrics 200s (NOT 500). For parity, a corrupt notes ARRAY does
// 500 /api/metrics (it reuses withNotes(readNotes)) — proving only the ledger failure is isolated.
async function testMetricsCorruptLedgerIsolation() {
  const dir = makeTempProject("metrics-corrupt");
  fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "notes", "metrics.jsonl"),
    '{"sid":"seed","at":"2026-01-01T00:00:00.000Z","type":"session"}\n{not json\n'
  );
  await withServer(dir, {}, async (base) => {
    let res = await fetch(`${base}/api/notes`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ time: 1, text: "still works" }),
    });
    assert.equal(res.status, 201); // metrics path is isolated from the note write

    res = await fetch(`${base}/api/metrics`);
    assert.equal(res.status, 200); // torn line skipped, not a 500
    assert.equal((await res.json()).notes.total, 1);
  });

  // Parity: a malformed annotations.json 500s /api/metrics, exactly like /api/notes.
  const dir2 = makeTempProject("metrics-badnotes");
  fs.mkdirSync(path.join(dir2, "notes"), { recursive: true });
  fs.writeFileSync(path.join(dir2, "notes", "annotations.json"), "{not json");
  await withServer(dir2, {}, async (base) => {
    assert.equal((await fetch(`${base}/api/metrics`)).status, 500);
  });
}

// Bounded growth: a pre-existing oversized ledger (older-bug recovery) is trimmed to the last
// METRICS_KEEP lines on boot, then anchored with a single session event — so the file stays
// ≤ METRICS_MAX_LINES and the most-recent KEEP lines are the survivors.
async function testMetricsTrimBound() {
  const { METRICS_MAX_LINES, METRICS_KEEP } = await import(pathToFileURL(path.join(REPO, "scripts", "vellum-shared.mjs")));
  const dir = makeTempProject("metrics-trim");
  fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
  const over = METRICS_MAX_LINES + 1;
  const seeded = Array.from({ length: over }, (_, i) =>
    JSON.stringify({ sid: "seed", at: "2026-01-01T00:00:00.000Z", type: "edit", id: 1, seq: i })
  ).join("\n") + "\n";
  fs.writeFileSync(path.join(dir, "notes", "metrics.jsonl"), seeded);

  await withServer(dir, {}, async (base) => {
    await fetch(`${base}/api/metrics`); // ensure the server booted (boot already trimmed)
    const lines = fs.readFileSync(path.join(dir, "notes", "metrics.jsonl"), "utf8").split("\n").filter(Boolean);
    assert.ok(lines.length <= METRICS_MAX_LINES, `ledger bounded: ${lines.length} ≤ ${METRICS_MAX_LINES}`);
    const seqs = lines.map((l) => JSON.parse(l)).filter((e) => typeof e.seq === "number").map((e) => e.seq);
    assert.equal(seqs.length, METRICS_KEEP);                 // exactly the last KEEP seeded lines kept
    assert.equal(Math.min(...seqs), over - METRICS_KEEP);    // earliest survivor is over-KEEP
    assert.equal(Math.max(...seqs), over - 1);               // newest seeded line retained
  });
}

// Live composition reload (poll-only): GET /api/watch returns an in-memory {rev} that fs.watch bumps
// (debounced) on a composition-file edit but NOT on a notes/ write — that ignore is what stops the
// reload from self-triggering on every annotations.json rewrite. OPTIONS→204, non-GET→405, no CORS
// headers (local-only). Nothing is persisted, so the note record + smoke JSON/MD stay unchanged.
async function testWatchEndpoint() {
  if (!(await recursiveWatchDelivers())) {
    console.log("  (skipped testWatchEndpoint — recursive fs.watch not delivered on this platform)");
    return;
  }
  const dir = makeTempProject("watch");
  const watchRev = async (base) =>
    (await (await fetch(`${base}/api/watch`, { headers: { accept: "application/json" } })).json()).rev;
  // Poll until rev moves off `fromRev` (returns the new rev) or the budget elapses (returns fromRev).
  const settleRev = async (base, fromRev, ms) => {
    const started = Date.now();
    while (Date.now() - started < ms) {
      const r = await watchRev(base);
      if (r !== fromRev) return r;
      await new Promise((res) => setTimeout(res, 40));
    }
    return fromRev;
  };

  await withServer(dir, {}, async (base) => {
    // Poll mode: 200 + numeric rev, and no CORS header (same-origin only).
    let res = await fetch(`${base}/api/watch`, { headers: { accept: "application/json" } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
    const rev0 = (await res.json()).rev;
    assert.equal(typeof rev0, "number");

    // Method handling: OPTIONS preflight → 204, anything but GET → 405.
    assert.equal((await fetch(`${base}/api/watch`, { method: "OPTIONS" })).status, 204);
    assert.equal((await fetch(`${base}/api/watch`, { method: "POST" })).status, 405);

    // A composition-file edit bumps the counter (after the ~250ms debounce).
    fs.writeFileSync(
      path.join(dir, "index.html"),
      `<!doctype html><html><body><div id="root" data-width="1080" data-height="1920">edited</div></body></html>`
    );
    const rev1 = await settleRev(base, rev0, 3000);
    assert.ok(rev1 > rev0, `comp edit bumped rev (${rev0} → ${rev1})`);

    // A write under notes/ must NOT bump — assert the rev stays put across a window wider than the
    // debounce, proving notes/ is skipped and the reload can't self-trigger on annotations rewrites.
    fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "notes", "scratch.txt"), "ignored");
    const rev2 = await settleRev(base, rev1, 600);
    assert.equal(rev2, rev1, "notes/ write did not bump rev");
  });
}

// Zero-dependency guardrail A: the shipped player must load NO external resource — that offline /
// single-download property IS the moat, and nothing else enforces it. Scan for absolute http(s) URLs
// AND protocol-relative (//host) resource loads. This catches a stray <script src>, <link href>, CSS
// url()/@import, OR a fetch() in the inline script alike.
function testPlayerNoExternalResources() {
  const template = path.join(REPO, "scripts", "vellum-template.html");
  const html = fs.readFileSync(template, "utf8");
  // Exact XML-namespace literals (used by createElementNS, never fetched). Matched exactly, NOT by
  // host prefix — so a genuinely fetched asset like https://www.w3.org/StyleSheets/TR/base.css is
  // still flagged rather than waved through.
  const ALLOW = new Set(["http://www.w3.org/2000/svg", "http://www.w3.org/1999/xlink"]);
  const absolute = [...new Set(html.match(/https?:\/\/[^\s"'`)<>]+/gi) || [])].filter((u) => !ALLOW.has(u));
  assert.deepEqual(absolute, [], `player must load no external resources — found: ${absolute.join(", ")}`);
  // Protocol-relative loads (`src="//cdn…"`, `url(//…)`) carry no scheme, so the absolute scan misses
  // them. Scan ONLY resource-loading contexts so a JS `//` comment in the inline script can't false-positive.
  const protoRel = [/(?:src|href)\s*=\s*["']\/\//gi, /url\(\s*["']?\/\//gi, /@import\s+["']?\/\//gi]
    .flatMap((re) => html.match(re) || []);
  assert.deepEqual(protoRel, [], `player must load no protocol-relative resources — found: ${protoRel.join(", ")}`);
}

// Zero-dependency guardrail B: a fresh install must be self-contained — every LOCAL import in every
// shipped tool must resolve to a file that exists, so no dangling ./module smuggles in a missing
// file. Globs scripts/*.mjs (auto-covers vellum-notes.mjs) and resolves static AND dynamic local
// specifiers; node:/bare specifiers (the hyperframes runtime dep, resolved separately) are skipped.
function testToolImportsResolve() {
  const scriptsDir = path.join(REPO, "scripts");
  const files = fs.readdirSync(scriptsDir).filter((f) => f.endsWith(".mjs"));
  const STATIC = /(?:^|[\s;])(?:import|export)\b[^'"]*?\sfrom\s*["']([^"']+)["']/g;
  const BARE = /(?:^|[\s;])import\s*["']([^"']+)["']/g; // side-effect import "x"
  const DYN = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g; // dynamic import("x") with a string literal
  let checked = 0;
  for (const f of files) {
    const src = fs.readFileSync(path.join(scriptsDir, f), "utf8");
    const specs = new Set();
    for (const re of [STATIC, BARE, DYN]) {
      let m;
      while ((m = re.exec(src))) specs.add(m[1]);
    }
    for (const spec of specs) {
      if (!spec.startsWith("./") && !spec.startsWith("../")) continue; // skip node: / bare deps
      const resolved = path.resolve(scriptsDir, spec);
      assert.ok(fs.existsSync(resolved), `${f} imports "${spec}" which does not resolve (${path.relative(REPO, resolved)})`);
      checked++;
    }
  }
  assert.ok(checked > 0, "expected to resolve at least one local import across the tools");
}

// Zero-dependency guardrail C: the installer's TOOL_FILES manifest must be CLOSED under local
// imports. testToolImportsResolve only proves imports resolve in THIS repo; a file split (like
// vellum-notes.mjs in v0.9.0) can pass that while install.sh still ships a subset that crashes at
// import time on a fresh install (the shipped server imports a module the installer never
// downloaded). Parse TOOL_FILES out of install.sh and walk each shipped .mjs: every ./x.mjs it
// imports must itself be listed in the manifest.
function testInstallerManifestClosure() {
  const installer = fs.readFileSync(INSTALLER, "utf8");
  const m = /^TOOL_FILES="([^"]+)"/m.exec(installer);
  assert.ok(m, "install.sh must define TOOL_FILES=\"…\"");
  const manifest = new Set(m[1].trim().split(/\s+/));
  const scriptsDir = path.join(REPO, "scripts");
  const STATIC = /(?:^|[\s;])(?:import|export)\b[^'"]*?\sfrom\s*["']([^"']+)["']/g;
  const BARE = /(?:^|[\s;])import\s*["']([^"']+)["']/g;
  const DYN = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  let checked = 0;
  for (const f of manifest) {
    assert.ok(fs.existsSync(path.join(scriptsDir, f)), `TOOL_FILES lists "${f}" but scripts/${f} does not exist`);
    if (!f.endsWith(".mjs") && f !== "vellum" && f !== "vellum-shim") continue;
    const src = fs.readFileSync(path.join(scriptsDir, f), "utf8");
    const specs = new Set();
    for (const re of [STATIC, BARE, DYN]) {
      let sm;
      while ((sm = re.exec(src))) specs.add(sm[1]);
    }
    for (const spec of specs) {
      if (!spec.startsWith("./")) continue; // node: / bare deps resolved separately
      const dep = spec.slice(2);
      assert.ok(
        manifest.has(dep),
        `install.sh TOOL_FILES is missing "${dep}" — shipped ${f} imports it, so a fresh install crashes with ERR_MODULE_NOT_FOUND`
      );
      checked++;
    }
  }
  assert.ok(checked > 0, "expected to check at least one local import against TOOL_FILES");
}

// Server hardening (a-harden): the dotfile denylist + the loopback Host allowlist. Uses raw
// http.request so the Host header can be forged (fetch/undici won't let it be overridden) — the TCP
// connection still lands on 127.0.0.1, only the Host header is a foreign / rebound domain.
async function testServerHardening() {
  const dir = makeTempProject("harden");
  // Plant sensitive dotfiles in the served ROOT — without the denylist serveStatic would 200 them.
  fs.writeFileSync(path.join(dir, ".env"), "SECRET=xyz");
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "config"), "[core]\n");
  // A file literally named "\.env": on POSIX `\` is NOT a path separator, so `GET /%5C.env` decodes
  // to `/\.env` and resolves to THIS real file — which the denylist must still reject by splitting on
  // `\` too. Planting the file makes the assertion go red if the split regresses to "/"-only (the
  // Windows-bypass class), instead of passing vacuously because the file is absent.
  fs.writeFileSync(path.join(dir, "\\.env"), "SECRET=backslash");

  await withServer(dir, {}, async (base) => {
    const port = Number(new URL(base).port);
    const reqStatus = (pathname, hostHeader) =>
      new Promise((resolve, reject) => {
        const r = http.request(
          { host: "127.0.0.1", port, path: pathname, method: "GET", headers: hostHeader ? { host: hostHeader } : {} },
          (res) => { res.resume(); resolve(res.statusCode); }
        );
        r.on("error", reject);
        r.end();
      });

    // Dotfile denylist: sensitive dotfiles → 404 (even though they exist); a normal file still 200s.
    assert.equal(await reqStatus("/.env", `127.0.0.1:${port}`), 404, "/.env denied");
    assert.equal(await reqStatus("/.git/config", `127.0.0.1:${port}`), 404, "/.git/config denied");
    assert.equal(await reqStatus("/%5C.env", `127.0.0.1:${port}`), 404, "encoded-backslash dotfile denied (Windows-bypass class)");
    assert.equal(await reqStatus("/index.html", `127.0.0.1:${port}`), 200, "normal file served");

    // Host allowlist: loopback names pass (any port); a foreign / rebound Host → 403 on static AND api.
    assert.equal(await reqStatus("/index.html", `localhost:${port}`), 200, "localhost Host allowed");
    assert.equal(await reqStatus("/index.html", `[::1]:${port}`), 200, "[::1] Host allowed");
    assert.equal(await reqStatus("/api/notes", `127.0.0.1:${port}`), 200, "api allowed from loopback");
    assert.equal(await reqStatus("/index.html", "evil.com"), 403, "foreign Host rejected (static)");
    assert.equal(await reqStatus("/api/notes", "attacker.example:1234"), 403, "foreign Host rejected (api)");
  });
}

// vellum-review.mjs resilience (F4 + the Array.isArray guard): a hand-edited annotations.json that
// is malformed JSON or valid-but-not-an-array must not crash the review-packet build — readNotes()
// warns and returns [], so main() reaches its "no notes" exit(0) instead of process.exit(1)/a raw
// stack. Agents hand-edit this file, so a daemon-free review pass has to tolerate a bad one.
function testReviewResilience() {
  const REVIEW = path.join(REPO, "scripts", "vellum-review.mjs");
  for (const bad of ["{ not json", '{"not":"array"}']) {
    const dir = makeTempProject("review");
    fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "notes", "annotations.json"), bad);
    const r = spawnSync(process.execPath, [REVIEW], { cwd: dir, env: { ...process.env }, encoding: "utf8" });
    assert.equal(r.status, 0, `vellum-review survived ${JSON.stringify(bad)} (exit ${r.status}): ${r.stderr}`);
    assert.match(`${r.stderr || ""}${r.stdout || ""}`, /skipping|no notes/i);
  }
}

// Desired-state in the review packet (vellum-review.mjs drawMarker / INDEX.md). The marker-filter
// construction is pure and render-free, so the helpers are unit-tested directly: %→px conversion,
// the finite/zero-size guards (coords must stay numeric — no shell interpolation), the amber
// destination box drawn at t=3 (distinct from the teal current-state marker), and the dotted-drawbox
// arrow approximation (stock ffmpeg has no line filter). The actual PNG draw needs ffmpeg + npx
// hyperframes; that render path is covered by the before/after slice, which SKIPS-with-warning when
// those tools are unavailable. Importing the module is safe because main() is guarded (invokedDirectly).
async function testReviewDesiredState() {
  const review = await import(pathToFileURL(path.join(REPO, "scripts", "vellum-review.mjs")));
  const { desiredBoxPx, arrowPx, lineBoxes, ghostFilters } = review;

  // Destination box %→px; bad or zero-size data → null so the filter never gets a non-numeric coord.
  assert.equal(desiredBoxPx({}), null);                                            // no field
  assert.equal(desiredBoxPx({ desiredBox: { x: 5, y: 5, w: 0, h: 10 } }), null);   // zero width
  assert.equal(desiredBoxPx({ desiredBox: { x: 5, y: 5, w: 30, h: "x" } }), null); // non-finite
  const box = desiredBoxPx({ desiredBox: { x: 48, y: 30, w: 30, h: 12 } });
  assert.ok(box && [box.x, box.y, box.w, box.h].every(Number.isFinite));
  assert.ok(box.w >= 4 && box.h >= 4); // floored to a visible minimum like targetBox

  // Arrow points; missing/garbage → null.
  assert.equal(arrowPx({}), null);
  assert.equal(arrowPx({ arrow: { x1: 1, y1: 2, x2: 3 } }), null); // missing y2 → null
  const arr = arrowPx({ arrow: { x1: 10, y1: 10, x2: 60, y2: 40 } });
  assert.ok(arr && [arr.x1, arr.y1, arr.x2, arr.y2].every(Number.isFinite));

  // The dotted arrow is a chain of filled drawboxes in the requested color (sampled line + from-dot + head).
  const segs = lineBoxes(0, 0, 100, 100, "0xFFB000", 14, 3);
  assert.ok(Array.isArray(segs) && segs.length >= 14);
  assert.ok(segs.every((s) => s.startsWith("drawbox=") && s.includes("0xFFB000") && s.includes("t=fill")));

  // ghostFilters is the factored fn drawMarker (and the before/after pass) layer on: amber box at t=3
  // plus the arrow chain; empty for a note carrying neither field; each field contributes independently.
  assert.deepEqual(ghostFilters({ id: 1 }), []);
  const ghost = ghostFilters({ desiredBox: { x: 48, y: 30, w: 30, h: 12 }, arrow: { x1: 10, y1: 10, x2: 60, y2: 40 } });
  assert.ok(ghost.some((s) => s.includes("0xFFB000") && s.includes("t=3")), "amber destination box at t=3");
  assert.ok(ghost.filter((s) => s.includes("t=fill")).length >= 14, "dotted arrow chain present");
  assert.equal(ghostFilters({ desiredBox: { x: 48, y: 30, w: 30, h: 12 } }).length, 1); // box-only → just the box
  assert.ok(ghostFilters({ arrow: { x1: 10, y1: 10, x2: 60, y2: 40 } }).every((s) => s.includes("t=fill"))); // arrow-only
}

// Before/after pairing GATE (vellum-review.mjs shouldPairBeforeAfter) — pure, render-free, so it runs
// everywhere regardless of ffmpeg/hyperframes. A note pairs only when the agent handled it
// (addressed/resolved) AND the bytes it was pinned against (provenance.indexHash) have since drifted.
async function testReviewBeforeAfterGate() {
  const { shouldPairBeforeAfter } = await import(pathToFileURL(path.join(REPO, "scripts", "vellum-review.mjs")));
  const H1 = "sha256:1111111111111111";
  const H2 = "sha256:2222222222222222";
  // addressed/resolved + drift → pair.
  assert.equal(shouldPairBeforeAfter({ status: "addressed", provenance: { indexHash: H1 } }, H2), true);
  assert.equal(shouldPairBeforeAfter({ status: "resolved", provenance: { indexHash: H1 } }, H2), true);
  assert.equal(shouldPairBeforeAfter({ status: "ADDRESSED", provenance: { indexHash: H1 } }, H2), true); // status normalized
  // open / wontfix → no pair even with drift (open is already surfaced as stale, not paired).
  assert.equal(shouldPairBeforeAfter({ status: "open", provenance: { indexHash: H1 } }, H2), false);
  assert.equal(shouldPairBeforeAfter({ status: "wontfix", provenance: { indexHash: H1 } }, H2), false);
  // no drift (pinned == current) → nothing to compare.
  assert.equal(shouldPairBeforeAfter({ status: "resolved", provenance: { indexHash: H2 } }, H2), false);
  // missing provenance / hash → no pair (back-compat: legacy notes stay single-frame).
  assert.equal(shouldPairBeforeAfter({ status: "resolved" }, H2), false);
  assert.equal(shouldPairBeforeAfter({ status: "resolved", provenance: {} }, H2), false);
  // missing curHash (unreadable index.html) → no pair.
  assert.equal(shouldPairBeforeAfter({ status: "resolved", provenance: { indexHash: H1 } }, null), false);
}

// Before/after pairing END-TO-END (vellum-review.mjs main loop). The expensive hyperframes render is
// avoided by pre-seeding the on-disk frame cache (rawFrame returns a cache hit), and the notes carry no
// pin/region coords so drawMarker just copies the frame — but the CLI still gates on ffmpeg up front
// (ensureCommand), so SKIP-with-warning when ffmpeg is unavailable rather than red-failing CI.
async function testReviewBeforeAfterPairing() {
  if (!ffmpegAvailable()) {
    console.log("  (skipped testReviewBeforeAfterPairing — ffmpeg unavailable)");
    return;
  }
  const { indexHashOf } = await import(pathToFileURL(path.join(REPO, "scripts", "vellum-shared.mjs")));
  const REVIEW = path.join(REPO, "scripts", "vellum-review.mjs");
  const REVIEW_DIR = (dir) => path.join(dir, "notes", "review");
  const sanitizeHash = (h) => h.replace(/[^a-z0-9]/gi, "_");
  // Seed a cached raw frame for (hash, time) — i.e. simulate a review run having rendered it.
  const seed = (dir, hash, time) => {
    const bucket = path.join(REVIEW_DIR(dir), "baseline", sanitizeHash(hash));
    fs.mkdirSync(bucket, { recursive: true });
    fs.writeFileSync(path.join(bucket, `t${Number(time).toFixed(3)}.png`), TINY_PNG);
  };
  const writeNotes = (dir, notes) => {
    fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "notes", "annotations.json"), JSON.stringify(notes));
  };
  const drift = (dir) =>
    fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><div data-width="1080" data-height="1920">edited</div>`);
  const run = (dir) => spawnSync(process.execPath, [REVIEW], { cwd: dir, env: { ...process.env }, encoding: "utf8" });
  const exists = (dir, name) => fs.existsSync(path.join(REVIEW_DIR(dir), name));

  // (a) PAIRED happy path: addressed note pinned at H1, composition drifts to H2, before-frame cached.
  {
    const dir = makeTempProject("ba-pair");
    const H1 = indexHashOf(dir);
    writeNotes(dir, [{ id: 1, time: 1, scene: "intro", text: "drifted", status: "addressed", provenance: { indexHash: H1 } }]);
    seed(dir, H1, 1);                 // a PRE-EDIT run cached the before-frame
    drift(dir);
    const H2 = indexHashOf(dir);
    assert.notEqual(H1, H2);
    seed(dir, H2, 1);                 // after-frame is a cache hit → no hyperframes render needed
    const r = run(dir);
    assert.equal(r.status, 0, `paired review exited ${r.status}: ${r.stderr}`);
    assert.ok(exists(dir, "note-1.png"), "after frame written");
    assert.ok(exists(dir, "note-1-before.png"), "before frame written");
    // The referenced before-bucket survives the opportunistic prune (still pinned by the note).
    assert.ok(fs.existsSync(path.join(REVIEW_DIR(dir), "baseline", sanitizeHash(H1))), "pinned cache bucket kept");
    const md = fs.readFileSync(path.join(REVIEW_DIR(dir), "INDEX.md"), "utf8");
    assert.match(md, /\| Before .* \| After .* \|/, "2-column before/after table");
    assert.ok(md.includes("note-1-before.png") && md.includes("note-1.png"), "INDEX references both frames");
  }

  // (b) GRACEFUL FALLBACK: addressed + drift but NO pre-edit run cached H1 → single frame, exit 0.
  {
    const dir = makeTempProject("ba-nopre");
    const H1 = indexHashOf(dir);
    writeNotes(dir, [{ id: 1, time: 1, scene: "intro", text: "no pre-edit run", status: "addressed", provenance: { indexHash: H1 } }]);
    drift(dir);
    seed(dir, indexHashOf(dir), 1);  // only the after-frame is cached (the before never was)
    const r = run(dir);
    assert.equal(r.status, 0, `fallback review exited ${r.status}: ${r.stderr}`);
    assert.ok(exists(dir, "note-1.png"), "after frame written");
    assert.ok(!exists(dir, "note-1-before.png"), "no before frame on a cache miss");
    assert.match(`${r.stderr || ""}`, /before-frame/i, "warns about the missing before-frame");
    const md = fs.readFileSync(path.join(REVIEW_DIR(dir), "INDEX.md"), "utf8");
    assert.ok(md.includes("![note 1](note-1.png)"), "single-frame block");
    assert.doesNotMatch(md, /\| Before/, "no pair table");
  }

  // (c) BACK-COMPAT: a legacy note with NO provenance → single frame regardless of cache.
  {
    const dir = makeTempProject("ba-noprov");
    const H1 = indexHashOf(dir);
    writeNotes(dir, [{ id: 1, time: 1, scene: "intro", text: "legacy", status: "resolved" }]);
    seed(dir, H1, 1);                 // after-frame cache hit (no drift since index.html is unchanged)
    const r = run(dir);
    assert.equal(r.status, 0, `legacy review exited ${r.status}: ${r.stderr}`);
    assert.ok(exists(dir, "note-1.png"));
    assert.ok(!exists(dir, "note-1-before.png"), "no before frame without provenance");
    const md = fs.readFileSync(path.join(REVIEW_DIR(dir), "INDEX.md"), "utf8");
    assert.ok(md.includes("![note 1](note-1.png)"));
    assert.doesNotMatch(md, /\| Before/);
  }

  // (d) AUTO BADGE: an origin-bearing note (a confirmed proposal) is tagged `(auto: …)` in INDEX.md;
  // a human note is not — transparency without disturbing legacy notes.
  {
    const dir = makeTempProject("ba-auto");
    const H1 = indexHashOf(dir);
    writeNotes(dir, [
      { id: 1, time: 1, scene: "intro", text: "caption past bottom safe-area", status: "open", origin: { by: "vellum", detector: "caption-safe-area", at: "2026-06-28T00:00:00.000Z" } },
      { id: 2, time: 2, scene: "intro", text: "human note", status: "open" },
    ]);
    seed(dir, H1, 1);
    seed(dir, H1, 2);
    const r = run(dir);
    assert.equal(r.status, 0, `auto-badge review exited ${r.status}: ${r.stderr}`);
    const md = fs.readFileSync(path.join(REVIEW_DIR(dir), "INDEX.md"), "utf8");
    assert.match(md, /### note-1 .*_\(auto: caption-safe-area\)_/, "origin note tagged (auto)");
    assert.doesNotMatch(md, /### note-2 .*_\(auto/, "human note not tagged");
  }
}

// The player is a single inline ES module in the HTML template — there's no browser harness here, but
// a syntax error would silently break the whole reviewer UI. Parse-check it on every run, and assert
// the desired-state (ghost-box / arrow) wiring this slice added is present and correctly ordered.
// Drift-guard for the auto-lint rule: the standalone player can't import vellum-shared, so it inline-
// mirrors detectCaptionSafeArea. Extract the marked mirror, eval it (pure — no DOM), and assert it
// agrees with the canonical rule across a synthetic battery — plus that the proposer is wired in.
async function testAutolintInlineMirror() {
  const shared = await import(pathToFileURL(path.join(REPO, "scripts", "vellum-shared.mjs")));
  const html = fs.readFileSync(path.join(REPO, "scripts", "vellum-template.html"), "utf8");

  const mirror = html.match(/\/\/ <vellum-detector-mirror>([\s\S]*?)\/\/ <\/vellum-detector-mirror>/);
  assert.ok(mirror, "inline detector mirror markers present");
  const inlineFn = new Function(`${mirror[1]}\nreturn detectCaptionSafeArea;`)();
  const boxes = [
    { x: 20, y: 20, w: 40, h: 10 }, { x: 20, y: 5, w: 40, h: 10 }, { x: 5, y: 40, w: 10, h: 10 },
    { x: 20, y: 60, w: 40, h: 35 }, { x: 60, y: 40, w: 35, h: 10 }, { x: 10, y: 10, w: 80, h: 80 },
    { x: 10, y: 9.9, w: 80, h: 80 }, { x: -5, y: -5, w: 50, h: 50 }, { x: 15, y: 15, w: 30, h: 10 },
    { x: 0, y: 45, w: 100, h: 8 }, { x: 0, y: 94, w: 100, h: 5 }, { x: 0, y: 2, w: 100, h: 5 }, // full-bleed
  ];
  // Compare the FULL result (incl. the reason string that becomes the stored note text), and exercise
  // the default-inset (one-arg) path too, so the inline copy can't drift from shared on any axis.
  for (const inset of [0, 5, 10, 20]) {
    for (const box of boxes) {
      assert.deepEqual(inlineFn(box, inset), shared.detectCaptionSafeArea(box, inset), `inline/shared drift on ${JSON.stringify(box)} @${inset}`);
    }
  }
  for (const box of boxes) {
    assert.deepEqual(inlineFn(box), shared.detectCaptionSafeArea(box), `default-inset drift on ${JSON.stringify(box)}`);
  }

  // Wiring: mount-time scan, origin-bearing confirm, session dismissal, escape hatches, scoped hotkeys,
  // and the lift beacon are all present in the inline player.
  const js = (html.match(/<script type="module">([\s\S]*?)<\/script>/) || [])[1] || "";
  assert.match(js, /function scanProposals\(/);
  assert.match(js, /origin: \{ by: "vellum", detector: CAPTION_DETECTOR/); // confirm builds an origin-bearing note
  assert.match(js, /data-vellum-safe/); // per-element escape hatch
  assert.match(js, /data-safe-area-inset/); // comp-level override
  assert.match(js, /e\.code === "KeyY" && proposals\.length/); // scoped confirm hotkey (inert otherwise)
  assert.match(js, /e\.code === "KeyX" && proposals\.length/); // scoped dismiss hotkey
  assert.match(js, /proposalsShown: drainUnreportedProposals\(\)/); // reported once-per-session inside the composition POST
  assert.match(html, /<div id="proposals" hidden><\/div>/); // the dock element exists in static markup
  // Re-mount/duplicate hardening (the review's must-fixes): both confirm AND dismiss suppress the key,
  // shown is reported once per session, confirmed captions are de-duped against existing notes, and the
  // dedupe key is position-independent (selector / tag.cls:text — never live box coords).
  assert.equal((js.match(/actedProposals\.add\(/g) || []).length >= 2, true, "confirm AND dismiss suppress the key");
  assert.match(js, /reportedProposals\.has\(p\.key\)/); // shown counted once per session
  assert.match(js, /function alreadyNoted\(/); // cross-session dedup vs existing origin notes
  assert.match(js, /target\.selector \|\| `\$\{target\.tag\}\.\$\{target\.cls\}:\$\{target\.text\}`/); // position-independent key
  assert.doesNotMatch(js, /dismissedProposals/); // old name fully removed

  // safeAreaInset regression guard: an ABSENT data-safe-area-inset must default to 10, NOT 0 — because
  // getAttribute → null and Number(null) === 0 would silently disable the detector on every comp that
  // doesn't set it. Eval the real function with a stub root/doc and pin every branch.
  const fn = html.match(/\/\/ <vellum-safearea-fn>([\s\S]*?)\/\/ <\/vellum-safearea-fn>/);
  assert.ok(fn, "safeAreaInset marker present");
  const insetOf = (attr) => {
    const stubDoc = { root: { getAttribute: () => attr } };
    const compRoot = (doc) => doc.root;
    return new Function("compRoot", "compDoc", `${fn[1]}\nreturn safeAreaInset();`)(compRoot, stubDoc);
  };
  assert.equal(insetOf(null), 10, "absent attribute → default 10 (not 0)");
  assert.equal(insetOf(""), 10, "empty attribute → default 10");
  assert.equal(insetOf("0"), 0, "explicit 0 → disabled");
  assert.equal(insetOf("15"), 15, "explicit value honored");
  assert.equal(insetOf("junk"), 10, "garbage → default 10");
}

function testTemplateDesiredState() {
  const TEMPLATE = path.join(REPO, "scripts", "vellum-template.html");
  const html = fs.readFileSync(TEMPLATE, "utf8");
  const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(m, "template has an inline module script");
  const js = m[1];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vellum-template-"));
  const file = path.join(dir, "inline.mjs");
  fs.writeFileSync(file, js);
  const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.equal(r.status, 0, `inline player script must parse: ${r.stderr}`);
  fs.rmSync(dir, { recursive: true, force: true });

  // Markup: ghost overlay (live box + SVG arrow layer + arrowhead marker) and the composer sub-row.
  for (const id of ['id="ghostbox"', 'id="ghost-layer"', 'id="vellum-arrowhead"', 'id="composer-ghost"', 'id="composer-arrow"', 'id="composer-desired"']) {
    assert.ok(html.includes(id), `template markup is missing ${id}`);
  }
  // The ghost sub-gesture must short-circuit each #pins handler — and the mousedown guard must sit
  // ABOVE the pending bail so a ghost drag never makes a second note or clobbers the in-flight pending.
  const md = js.indexOf("if (ghostCapture) { onGhostMouseDown(e); return; }");
  const mm = js.indexOf("if (ghostCapture) { onGhostMouseMove(e); return; }");
  const mu = js.indexOf("if (ghostCapture) { onGhostMouseUp(e); return; }");
  assert.ok(md > 0 && mm > 0 && mu > 0, "each #pins handler guards on ghostCapture");
  assert.ok(js.indexOf("if (pending) {", md) > md, "mousedown ghost guard precedes the pending bail");
  // renderMarkers renders desiredBox + arrow independently of pin coords, and clears its own elements.
  assert.ok(js.includes("if (n.desiredBox)") && js.includes("if (n.arrow)"), "renderMarkers branches on desiredBox/arrow");
  assert.ok(js.includes('"note-arrow"') && js.includes('"ghost-box"'), "renderMarkers builds ghost-box + note-arrow");
  assert.ok(/querySelectorAll\("\.pin, \.region, \.ghost-box"\)/.test(js), "renderMarkers clears ghost boxes too");
  // Save threads the fields: POST adds them only when present; PATCH sends present-key replace/clear.
  assert.ok(js.includes("payload.desiredBox = pending.desiredBox") && js.includes("payload.arrow = pending.arrow"), "POST payload threads desiredBox/arrow");
  assert.ok(js.includes("desiredBox: pending.desiredBox ?? null") && js.includes("arrow: pending.arrow ?? null"), "PATCH sends present-key desiredBox/arrow");
  // The SVG arrow viewBox is the comp size (single-uniform-scale invariant) so arrows stay resize-safe.
  assert.ok(/ghostLayer\.setAttribute\("viewBox", `0 0 \$\{compW\} \$\{compH\}`\)/.test(js), "ghost-layer viewBox is compW×compH");
}

// The note store (vellum-notes.mjs) is the single read/write seam for annotations.json. Its read
// contract (ENOENT→[], malformed/non-array→throw, drop non-object elements, reconcile) is what both
// Tier 4 auto-lint: the pure caption-safe-area rule + the note `origin` sanitizer/reconcile guard.
// The rule is browser-free so it unit-tests directly here; the player's inline mirror is drift-guarded
// against it in testAutolintInlineMirror.
async function testAutolintRule() {
  const shared = await import(pathToFileURL(path.join(REPO, "scripts", "vellum-shared.mjs")));
  const { detectCaptionSafeArea, DEFAULT_SAFE_AREA, CAPTION_DETECTOR, sanitizeOrigin, reconcileNote } = shared;

  assert.equal(DEFAULT_SAFE_AREA, 10);
  assert.equal(CAPTION_DETECTOR, "caption-safe-area");

  // A caption fully inside the title-safe box → no proposal.
  assert.equal(detectCaptionSafeArea({ x: 20, y: 20, w: 40, h: 10 }).violates, false);
  // Each edge crossing → a violation with the correct edge label (default 10% inset).
  assert.equal(detectCaptionSafeArea({ x: 20, y: 5, w: 40, h: 10 }).edge, "top"); // y=5 < 10
  assert.equal(detectCaptionSafeArea({ x: 5, y: 40, w: 10, h: 10 }).edge, "left"); // x=5 < 10
  assert.equal(detectCaptionSafeArea({ x: 20, y: 60, w: 40, h: 35 }).edge, "bottom"); // y+h=95 > 90
  assert.equal(detectCaptionSafeArea({ x: 60, y: 40, w: 35, h: 10 }).edge, "right"); // x+w=95 > 90
  // Boundary pinned at exactly 10%: flush against the line passes; 0.1% past violates.
  assert.equal(detectCaptionSafeArea({ x: 10, y: 10, w: 80, h: 80 }).violates, false);
  assert.equal(detectCaptionSafeArea({ x: 10, y: 9.9, w: 80, h: 80 }).edge, "top");
  // Inset 0 disables the detector even for an off-frame box; custom inset shifts the boundary.
  assert.equal(detectCaptionSafeArea({ x: -5, y: -5, w: 50, h: 50 }, 0).violates, false);
  assert.equal(detectCaptionSafeArea({ x: 15, y: 15, w: 30, h: 10 }, 10).violates, false);
  assert.equal(detectCaptionSafeArea({ x: 15, y: 15, w: 30, h: 10 }, 20).violates, true);
  // Garbage never throws / never violates.
  assert.equal(detectCaptionSafeArea(null).violates, false);
  assert.equal(detectCaptionSafeArea({ x: "a", y: 1, w: 1, h: 1 }).violates, false);

  // Full-bleed (centered left:0;right:0) captions must NOT false-flag left/right — the headline false-
  // positive. They're judged on top/bottom only; a genuinely left-edge (non-full-bleed) caption still flags.
  assert.equal(detectCaptionSafeArea({ x: 0, y: 45, w: 100, h: 8 }).violates, false, "centered full-width caption is clean");
  assert.equal(detectCaptionSafeArea({ x: 0, y: 94, w: 100, h: 5 }).edge, "bottom", "full-width past bottom → bottom (not 'left')");
  assert.equal(detectCaptionSafeArea({ x: 0, y: 2, w: 100, h: 5 }).edge, "top", "full-width past top → top");
  assert.equal(detectCaptionSafeArea({ x: 2, y: 45, w: 30, h: 8 }).edge, "left", "a real left-edge caption still flags left");

  // sanitizeOrigin: known detector, default `by`, fixed key order, stamp a bad `at`, bound `by`, idempotent.
  const o = sanitizeOrigin({ detector: "caption-safe-area", at: "2026-01-01T00:00:00.000Z" });
  assert.deepEqual(Object.keys(o), ["by", "detector", "at"]); // fixed order → stable bytes
  assert.equal(o.by, "vellum");
  assert.equal(o.at, "2026-01-01T00:00:00.000Z");
  assert.equal(sanitizeOrigin({ detector: "made-up" }), null); // unknown detector → not an origin
  assert.equal(sanitizeOrigin("nope"), null);
  assert.ok(Number.isFinite(Date.parse(sanitizeOrigin({ detector: "caption-safe-area", at: "garbage" }).at)));
  assert.equal(sanitizeOrigin({ detector: "caption-safe-area", by: "x".repeat(99) }).by.length, 40);
  assert.deepEqual(sanitizeOrigin(o), o); // idempotent

  // reconcileNote drops a malformed origin, preserves a well-formed one unchanged.
  assert.ok(!("origin" in reconcileNote({ id: 1, origin: "oops" })));
  assert.ok(!("origin" in reconcileNote({ id: 1, origin: { detector: "unknown" } })));
  assert.deepEqual(reconcileNote({ id: 1, origin: o }).origin, o);
}

// Server half of the proposer loop: origin passes through POST validated (spoofed detector stripped),
// is immutable on PATCH, never persisted into composition.json, and lift (accepted/shown) is computed
// from `propose` (reported in the composition POST) + `create`-with-detector events.
async function testProposalServer() {
  const dir = makeTempProject("proposals");
  await withServer(dir, {}, async (base) => {
    const post = (body) => fetch(`${base}/api/notes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

    // Mount + report two SHOWN caption-safe-area proposals inside the existing composition POST; an
    // unknown-detector entry is dropped server-side.
    await fetch(`${base}/api/composition`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ width: 1080, height: 1920, duration: 5, proposalsShown: [
        { detector: "caption-safe-area", selector: "#cap1", edge: "bottom" },
        { detector: "caption-safe-area", selector: "#cap2", edge: "top" },
        { detector: "made-up", selector: "#x", edge: "top" },
      ] }),
    });
    const comp = await (await fetch(`${base}/api/composition`)).json();
    assert.equal(comp.proposalsShown, undefined, "proposalsShown never persisted to composition.json");

    // Accept one proposal: a note with a valid origin → origin persisted + round-tripped.
    const accepted = await post({ time: 1, x: 10, y: 92, w: 40, h: 6, text: "caption past bottom safe-area", origin: { by: "vellum", detector: "caption-safe-area", at: "2026-06-28T00:00:00.000Z" } });
    assert.deepEqual(accepted.origin, { by: "vellum", detector: "caption-safe-area", at: "2026-06-28T00:00:00.000Z" });
    // A spoofed/unknown detector is stripped (origin never trusted verbatim).
    const spoof = await post({ time: 2, x: 5, y: 5, w: 5, h: 5, text: "spoof", origin: { by: "evil", detector: "rm -rf", at: "x" } });
    assert.equal(spoof.origin, undefined, "unknown-detector origin stripped by sanitizeOrigin");
    // A human note carries no origin (byte-identical to a pre-0.10.0 note).
    const human = await post({ time: 3, x: 20, y: 20, w: 10, h: 10, text: "human" });
    assert.equal(human.origin, undefined);

    // origin is immutable on PATCH (like provenance).
    const patched = await fetch(`${base}/api/notes/${accepted.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "resolved" }) }).then((r) => r.json());
    assert.deepEqual(patched.origin, accepted.origin, "origin immutable on PATCH");

    // Lift: 2 shown, 1 accepted (the create stamped with detector) → acceptRate 0.5.
    const m = await (await fetch(`${base}/api/metrics?events=1`)).json();
    assert.deepEqual(m.summary.proposals, { shown: 2, accepted: 1, acceptRate: 0.5 });
  });
}

// the server and the review packet now depend on; its writer must keep the on-disk format a bare
// array, byte-identical to legacy, NEVER an envelope.
async function testNoteStore() {
  const store = await import(pathToFileURL(path.join(REPO, "scripts", "vellum-notes.mjs")));
  const { readNotes, writeNotes, SCHEMA_VERSION } = store;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vellum-store-"));
  const file = path.join(dir, "notes", "annotations.json");
  try {
    // SCHEMA_VERSION is a code-only integer, decoupled from the tool VERSION (never serialized).
    assert.equal(typeof SCHEMA_VERSION, "number");

    // Missing file → [] (created on first write), never throws.
    assert.deepEqual(readNotes(file), []);

    // writeNotes emits a BARE top-level array (writer mkdirs the notes/ dir): first non-ws byte "[",
    // a trailing newline, and never the substring "schema_version" — the on-disk contract agents edit.
    writeNotes(file, [{ id: 1, time: 1, text: "hi", status: "open" }]);
    const onDisk = fs.readFileSync(file, "utf8");
    assert.equal(onDisk.trimStart()[0], "[", "first non-whitespace byte is '['");
    assert.ok(onDisk.endsWith("]\n"), "trailing newline preserved");
    assert.ok(!onDisk.includes("schema_version"), "writer never emits an envelope");
    assert.ok(Array.isArray(JSON.parse(onDisk)));
    // The tmp+rename write leaves no .tmp- file behind.
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".tmp-")), []);

    // BACK-COMPAT INVARIANT: read (which reconciles) → write is byte-identical. A legacy note with no
    // new fields round-trips with the same bytes (severity:undefined from the spread is dropped by
    // JSON.stringify), so legacy projects are never silently rewritten.
    writeNotes(file, [{ id: 5, time: 2, x: 10, y: 20, w: 30, h: 40, text: "rt", status: "resolved", createdAt: "2026-01-01T00:00:00.000Z" }]);
    const first = fs.readFileSync(file, "utf8");
    writeNotes(file, readNotes(file));
    assert.equal(fs.readFileSync(file, "utf8"), first, "read→write is byte-identical (no envelope, no field churn)");

    // Same invariant for an origin-bearing note (a confirmed proposal): origin round-trips intact, in
    // fixed {by,detector,at} order, with no churn — so an accepted-proposal note is provably stable.
    writeNotes(file, [{ id: 6, time: 1, text: "cap", status: "open", origin: { by: "vellum", detector: "caption-safe-area", at: "2026-01-01T00:00:00.000Z" } }]);
    const withOrigin = fs.readFileSync(file, "utf8");
    writeNotes(file, readNotes(file));
    assert.equal(fs.readFileSync(file, "utf8"), withOrigin, "origin-bearing note read→write is byte-identical");
    assert.equal(readNotes(file)[0].origin.detector, "caption-safe-area", "origin preserved through the store");

    // Malformed JSON and a wrong-shape (non-array, non-envelope) file both THROW — the server turns
    // that into a 500 and boot leaves the bad file untouched; the review packet warns and continues.
    fs.writeFileSync(file, "{not json");
    assert.throws(() => readNotes(file), /parse/i);
    fs.writeFileSync(file, JSON.stringify({ foo: 1 }));
    assert.throws(() => readNotes(file), /must contain a JSON array/);

    // Forward-compat: a future {schema_version, notes:[…]} envelope is accepted on read (never written).
    fs.writeFileSync(file, JSON.stringify({ schema_version: 2, notes: [{ id: 7, time: 1, text: "env", status: "open" }] }));
    const fromEnvelope = readNotes(file);
    assert.equal(fromEnvelope.length, 1);
    assert.equal(fromEnvelope[0].id, 7);

    // Non-object array elements are dropped BEFORE anything indexes them, and each survivor is
    // reconciled (an unknown status coerces to "open") — the exact divergence the store closes.
    fs.writeFileSync(file, JSON.stringify([null, 5, "x", { id: 8, time: 1, text: "ok", status: "donezo" }]));
    const cleaned = readNotes(file);
    assert.equal(cleaned.length, 1, "non-object elements dropped");
    assert.equal(cleaned[0].status, "open", "unknown status coerced via reconcileNote");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

await testVersionSourcesAgree();
await testSharedHelpers();
await testAutolintRule();
await testNoteStore();
testPlayerNoExternalResources();
testToolImportsResolve();
testInstallerManifestClosure();
testTemplateDesiredState();
await testAutolintInlineMirror();
await testServerApi();
await testWatchEndpoint();
await testServerHardening();
await testSeverityAndClustering();
await testAttachments();
await testMalformedNotesArePreserved();
await testBootReconcilesOfflineEdits();
await testAgentResolutionWriteback();
await testAgentJsonReconciledOnBoot();
await testProvenanceStaleDetection();
await testIndexHashOf();
await testMetricsLedger();
await testProposalServer();
await testMetricsCorruptLedgerIsolation();
await testMetricsTrimBound();
testVellumDirGuard();
testReviewResilience();
await testReviewDesiredState();
await testReviewBeforeAfterGate();
await testReviewBeforeAfterPairing();
testInstallerSkillSymlink();
testInstallerSubdirScripts();
testVellumShimFindsProject();

console.log("Vellum smoke tests passed");
