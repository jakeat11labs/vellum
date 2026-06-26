#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
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

    let md = fs.readFileSync(path.join(dir, "notes", "annotations.md"), "utf8");
    assert.match(md, /line one \\`line two\\`/);

    res = await fetch(`${base}/api/notes/${note.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "updated note", status: "resolved" }),
    });
    assert.equal(res.status, 200);
    const patched = await res.json();
    assert.equal(patched.text, "updated note");
    assert.equal(patched.status, "resolved");

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
    assert.equal((await res.json()).scenes, 2);
    const comp = await (await fetch(`${base}/api/composition`)).json();
    assert.equal(comp.width, 1920);
    assert.equal(comp.scenes.length, 2);
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

await testVersionSourcesAgree();
await testServerApi();
await testMalformedNotesArePreserved();
testVellumDirGuard();
testInstallerSkillSymlink();
testInstallerSubdirScripts();
testVellumShimFindsProject();

console.log("Vellum smoke tests passed");
