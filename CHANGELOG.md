# Changelog

All notable changes to Vellum are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.10.3] - July 6, 2026

A launcher fix so `VELLUM_DIR` from `.vellum.env` is actually honored. No player, server, or note-format changes.

### Fixed
- **`.vellum.env` is now exported, not just sourced.** The `vellum-shim` sourced `.vellum.env` but without `set -a`, so a plain `VELLUM_DIR=…` assignment became a shell variable the exec'd `node` child never saw — the shim could serve the empty project root instead of the configured composition subfolder (surfacing as a blank player or a "no composition root" mount error). Both launchers now wrap the source in `set -a` / `set +a` so `VELLUM_DIR` reaches the server.
- **`./scripts/vellum` loads `.vellum.env` too.** The in-project launcher previously ignored `.vellum.env` entirely, so `./scripts/vellum` and `npm run vellum` could resolve different compositions. It now loads (and exports) the same env, so every entry point — `npm run vellum`, `./scripts/vellum`, and the global `vellum` shim — resolves one composition.

## [0.10.2] - July 6, 2026

An installer fix. No player, server, or note-format changes.

### Fixed
- **Fresh installs boot again.** `vellum-notes.mjs` was split out of the server in v0.9.0, but `install.sh`'s `TOOL_FILES` manifest was never updated — so every fresh install since then downloaded a `vellum-server.mjs` that crashed at import time with `ERR_MODULE_NOT_FOUND`. The note store now ships with the tool. Existing installs pick it up via `vellum update` (the updater re-runs the published installer).
- **Manifest-closure guardrail.** A new smoke test (`testInstallerManifestClosure`) parses `TOOL_FILES` out of `install.sh` and asserts the shipped set is closed under local imports — the guardrail the v0.9.0 split slipped past (`testToolImportsResolve` only proves imports resolve in the repo, not that the installer ships them).

## [0.10.1] - July 2, 2026

A layout-hardening patch for the transport bar. No behavior change, no note-format change.

### Fixed
- **Scrubber no longer slips while scrubbing.** The scene-name label (`#scene-tag`) on the right of the transport bar had a `max-width` but no fixed width, so its footprint grew and shrank with each scene's name length. Because the label is rewritten every tick during playback/scrubbing and the scrubber wrapper is `flex: 1`, that variance reflowed the whole bar and slid the scrubber under the cursor. The label now occupies a constant-width slot (`flex: 0 0 88px`), so scene changes never reflow the bar. Long names still truncate with an ellipsis and now surface the full name on hover (`title`); the label's DOM is only rewritten when the name actually changes.

## [0.10.0] - June 28, 2026

The roadmap's "bold bet" — **invert the sensor**. Until now the human was the sole detector and Vellum the scribe. This flips it: Vellum pre-lints the mounted composition and **proposes** candidate notes you confirm or dismiss with one key. Ships one detector first, measures whether it's worth it, then decides on more. Notes stay a bare JSON array; a confirmed proposal is a normal note carrying one optional field, so older notes are byte-identical.

### Added
- **Caption-safe-area auto-lint proposer.** At mount, Vellum scans on-screen captions (`[data-caption]`, `.caption`, `.subtitle`, `[role=caption]`) and flags any whose box crosses the title-safe margin (10% inset default; per-composition `data-safe-area-inset`, per-element `data-vellum-safe="off"` escape hatch). Proposals render as a dismissible amber dock + markers; **one key confirms** (`Y` → a real note carrying `origin:{by:"vellum",detector,at}` and a pre-filled reason) or **dismisses** (`X`). Vellum never edits the composition — proposing isn't editing. The detection rule is pure and unit-tested; the player mirrors it inline (it can't import a Node module) and a smoke drift-guard keeps the two byte-identical.
- **Lift measurement.** A `proposals:{shown,accepted,acceptRate}` block in `GET /api/metrics` and the shutdown summary, fed by `propose`/`create`-with-detector events in the local ledger — so you can see whether proposing beats hunting before adding a second detector. The review packet tags confirmed proposals `_(auto: …)_`.

### Precision (why it's trustworthy, not noisy)
- Full-bleed/centered captions are judged on top/bottom only (a `left:0;right:0` bar isn't "off the left edge"), so a normal centered subtitle never false-flags. Only captions actually presented at the scanned frame are linted (ancestor opacity/visibility + off-frame gated), so mid-entrance and hidden-scene captions don't cry wolf. Confirmed/dismissed captions are de-duplicated against existing notes and within the session, and `shown` is counted once per session — so the lift metric stays honest across live-reloads, and confirm is idempotent against key-repeat (no duplicate notes).

### Notes
- One detector by design — `.lower-third` and other layouts are opt-in via `data-caption` until the dismiss rate says otherwise. Known limitations for a follow-up: the scan covers the loaded frame (not yet a per-cue sweep of every scene), and proposal markers aren't time-scoped to their caption's window.

The roadmap's "Architecture & hardening" tier — structural work that protects the moat (local-first, zero-dependency, single-download) and converges the note-read path. No new reviewer-facing features; notes stay a bare JSON array and every prior note is byte-identical.

### Added
- **Schema-versioned note store (`scripts/vellum-notes.mjs`).** One module now owns reading and writing `annotations.json`, so the server and the review packet share an identical read contract (drop non-object elements, then `reconcileNote`) instead of two readers that had drifted. The on-disk format stays a bare top-level array, written byte-identically (atomic temp+rename); `readNotes` additionally tolerates a forward-compat `{schema_version, notes:[…]}` envelope on the way in, so a newer file can't wedge an older reader.
- **Localhost server hardening.** A loopback **Host-header allowlist** (`localhost`/`127.0.0.1`/`::1`) rejects cross-origin requests whose `Host` is a rebound domain (DNS-rebinding defense), and a **dotfile denylist** stops `serveStatic` from ever serving `/.env`, `/.git/config`, or any dot-segment path — split on both `/` and `\` so an encoded backslash can't bypass it on Windows.
- **Zero-dependency guardrail tests.** Two smoke tests enforce the moat that nothing checked before: the shipped player loads **no external resource** (absolute *or* protocol-relative), and every local `import` across the tools resolves to a present file (a fresh install is complete).
- **`@ts-check` + JSDoc typedefs + CI typecheck.** The library modules now run under `tsc --noEmit` (`npm run typecheck`, wired into both CI workflows) with shared typedefs for the note/markup shapes, catching cross-module signature drift. The player's inline `<script>` and the test harness stay unchecked by design.

### Changed
- The atomic-write primitive and the both-separator path split now live once in `vellum-shared.mjs` and are reused by the server and the note store. The review packet's "unreadable notes" warning no longer double-prefixes its message. `testWatchEndpoint` skips gracefully on platforms where recursive `fs.watch` delivers no events (it runs in CI).

### Notes
- **Re-anchoring notes to scene offsets remains deferred by design** (see 0.8.0). The headless capture contract test (Playwright) was also deferred to keep this tier free of a new test-time browser dependency.

The roadmap's "Later" tier — turning feedback from a description into an instruction, and letting the agent check its own work. Notes stay a bare JSON array; every new field is absent-by-default, so older notes are byte-identical.

### Added
- **Desired-state markup (ghost box / arrow).** A reviewer can now show *where/how big* an element should be, not just point at it. After pinning a note, drag a dashed **ghost target box** (▭) or an **arrow** (↗) from the composer. The note carries optional `desiredBox`/`arrow` (% of comp) and `annotations.md` emits a ready-to-apply delta — e.g. `- desired: move x 24→48%, resize 10×12% → 30×12%` and `- direction: arrow 10,10% → 60,40%` — so "move this here / make it bigger" is an exact instruction. Drawn in amber in the player and the review packet, distinct from the current-state marker.
- **Before/after frames in the review packet.** `vellum-review` caches the frame each note was pinned against (keyed by the note's content hash). Run it once **before** editing to bank the baselines; after you edit and re-run, any `addressed`/`resolved` note whose composition drifted shows a **Before · After** pair in `INDEX.md` so you (and the agent) can self-check the edit. Degrades to a single current frame when there's no pre-edit baseline.

### Notes
- **Re-anchoring notes to scene offsets was evaluated and deliberately deferred.** Provenance + the shipped `_(stale: …)_` flag already surface the real drift, the recompute is unsound without a manifest-freshness gate, and the before/after pair subsumes its one genuine benefit (a relocated single frame). An implementation-ready spec is parked behind a real-drift metric.

## [0.7.0] - June 26, 2026

The "Next" tier from the roadmap — seven features that close the review loop and make the handoff artifact carry far more of its own context. Notes stay a bare JSON array; every new field is absent-by-default, so old notes are byte-identical.

### Added
- **Agent resolution write-back.** The consuming agent can record what it changed and flip a note to a new `addressed` status (open → addressed → resolved/wontfix) — via `PATCH /api/notes/<id>` with a `resolution{by,at,summary,edits[]}`, or by editing `annotations.json` offline (reconciled + sanitized on the server's next boot). A human click verifies (`addressed → resolved`). Renders as `- resolution …` / `- edit …` sub-lines.
- **Git-tracked notes + provenance.** `notes/annotations.{json,md}` are no longer gitignored, so reviews travel through git. Each note + the composition manifest are stamped (best-effort) with the commit and the `index.html` content hash they were made against; a note pinned against changed content is flagged `_(stale: …)_` and gets an amber timeline dot.
- **Time-span (in/out) notes.** Mark an in/out range with the `I`/`O` keys (or the dock's Time-span target) so "cut 2s", "hold this beat", and retimes are lossless intervals (`0:11.00–0:14.50`), not a single guessed instant.
- **Severity + same-target clustering.** Tag a note `blocker` / `major` / `nit`; `annotations.md` orders severity-first ("fix blockers first") and groups notes that share an element under one header so the agent addresses a scene once.
- **Self-measuring metrics.** A local, gitignored `notes/metrics.jsonl` ledger powers a first-pass fix rate, create→resolve latency, and time-to-note — surfaced in a `## Metrics` footer, `GET /api/metrics`, and the shutdown summary. Diagnostics, not feedback to act on.
- **Reference-image attachments.** Paste / drop / pick an image on a note (raw-binary upload, magic-byte sniffed, SVG excluded, capped) stored under `notes/attachments/` and surfaced as an openable `- ref images:` path for the agent.
- **Live composition reload.** With the player open, editing `index.html` reloads the iframe at the same frame (poll-only `GET /api/watch`), deferring while a note is open and offering a manual reload.

### Changed
- The note record now also carries optional `timeEnd`, `severity`, `attachments`, `resolution`, `provenance`, and the `addressed` status; `annotations.md` gained a baseline header, an expanded legend, and clustered/severity-ordered output. The server normalizes notes on read (tolerant of offline hand-edits) and regenerates `annotations.md` on boot.

### Fixed
- Hardened the daemon against malformed/hand-edited `annotations.json`: non-object/non-array fields are filtered or coerced on read, write handlers return 500 instead of throwing, and an `uncaughtException` backstop keeps a long-running review alive.

## [0.6.1] - June 25, 2026

The rest of the feature-evaluation "Now" tier — sharper capture for the reviewer, clearer signal for the agent.

### Added
- **Computed style captured with element notes.** A note on an element now records its current font size / weight / family, color, background, line-height, tracking, alignment, and opacity — surfaced on a `style:` line in `annotations.md` — so "make this bigger" or "use another color" is an edit from a known value, not a guess.
- **Live VO captions while scrubbing.** When a composition ships captions, a **CC** toggle appears (or press **C**) and the current VO line shows as a subtitle over the video, so VO/visual desync is obvious at a glance. The toggle state persists.
- **Frame-accurate stepping.** `,` and `.` nudge the playhead one frame — the composition's fps when it declares `data-fps`, otherwise a fine 1/30s step (finer than the 0.1s arrow keys).
- **Stale-note flag.** When a note's targeted element no longer resolves in the composition (it changed underneath the note), the note shows an "unresolved — re-verify" badge in the drawer and an amber ring on its timeline dot — so drift after edits is visible instead of silent.

## [0.6.0] - June 25, 2026

A pass at making the handoff artifact carry more of its own context, so the consuming coding agent gets things right on the first pass.

### Added
- **`composition.json` manifest.** The player now writes `notes/composition.json` describing the composition the way an agent needs it — the scene map (`id`/`start`/`duration`), dimensions, duration, fps, the VO/music clip layout, and whether captions exist — so an agent can resolve any note's scene and timing without re-parsing the source. New `/api/composition` endpoint; the browser posts it once at mount.
- **`annotations.md` is now a self-sufficient work order.** Each element-targeted note surfaces the picker label, the element's on-frame bounds, and its captured timing attrs (`data-start`/`data-duration`) on an indented sub-line, and the file carries a legend plus composition dimensions and a pointer to `composition.json` — so an agent can act from the Markdown alone, without cross-referencing the JSON or the skill.

### Fixed
- **Atomic note/mix/manifest writes.** `annotations.json`, `mix.json`, and `composition.json` are written via a temp file + atomic rename, so a crash mid-write can't truncate the notes file and wedge the review API.

## [0.5.4] - June 25, 2026

### Added
- **Audio notes carry the real VO script.** When a composition ships a `timing/voiceover-captions.vtt` (HyperFrames' TTS/transcribe step writes one), Vellum now reads it and attaches the spoken words to audio notes — the exact line at the playhead, the active clip's full script, and the previous/next VO clips with their text for series context. It renders in `annotations.md` as `VO line:` / `VO clip script:` / `clip order:` lines, so a coding agent gets the actual narration, not just a filename. Compositions without captions degrade silently to the filename + timestamp. No changes required to HyperFrames — Vellum reads the artifact the pipeline already emits.

### Added
- **Whole-scene and audio feedback notes.** A collapsible dock on the left edge of the player lets you drop a note scoped to the entire current scene (▣) or to the audio playing right now (🔊) — no element click needed, and it works outside note mode. Audio notes auto-capture the active VO and music clips (filename + local timestamp) plus the previous/next VO clips for series context, and surface the VO script text when the composition embeds it on the clip. Scoped notes get distinct timeline markers (square for scene, ring for audio), a kind badge in the notes drawer, and render in `annotations.md` as `_(whole scene)_` / `_(audio: VO … @ m:ss, music …)_` with indented script/clip-order context — so a coding agent knows exactly what each note is about.

### Added
- **The Save button shows its keyboard shortcut.** "Save note" / "Save changes" now carries a key-cap hint — `⌘↵` on macOS, `Ctrl+↵` on Windows/Linux — so the ⌘/Ctrl+Enter save shortcut is discoverable.

## [0.5.1] - June 24, 2026

### Added
- **Hover a timeline note dot for a quick preview.** Mousing over a note's color-coded dot now pops a small card above the timeline showing the note's id, timecode, scene, and text — scan notes without opening the drawer. The card floats above the viewer in the note's color.
- **⌘/Ctrl+Enter saves a note.** In the note composer, press ⌘+Enter (macOS) or Ctrl+Enter (Windows/Linux) to save without reaching for the button.

### Changed
- **Timeline note dots are easier to hit.** Each dot now has a larger invisible hit area, so the cursor catches it without pixel-perfect aim.

## [0.5.0] - June 15, 2026

### Added
- **The installer can scaffold a HyperFrames project.** Run the install script in a folder with no composition and it now offers to create one in place — `npx hyperframes init .` for the `index.html` (pick a blank composition or a starter example), the full `/hyperframes` + GSAP agent skill set via `npx hyperframes skills`, and `npm install` so the runtime is local on the first `vellum` run. Then it wires the Vellum tool and skill on top, leaving an empty folder ready to edit and review in one command. Force it with `--init` / `VELLUM_INIT=1`, or skip with `--no-init` / `VELLUM_INIT=0`; it never fires when a composition already exists or you pass `--dir`.

### Changed
- **The review player opens at `/vellum`** (extension-less) instead of `/annotate.html` — `http://127.0.0.1:4848/vellum`, or `/<dir>/vellum` for a subfolder composition. Purely the player's URL; the notes API, files, and `annotations.md`/`annotations.json` are unchanged.

## [0.4.3] - June 15, 2026

### Changed
- **Codebase cleanup pass (no behavior change).** Removed duplicated and dead code and pulled repeated logic into shared helpers across the server, review, shared, terminal-UI, and browser-player modules: the server reuses the shared `resolveInside` path guard instead of a second copy, percent→pixel and timeline-position math collapse into single helpers, `<audio>` timing attributes are parsed once at mount instead of on every animation frame, and unused UI exports were dropped. Smoke tests unchanged and passing.
- **Demo video uses the light-theme cut.** README hero and "Try the demo" now point at the light promo video and poster.

## [0.4.2] - June 11, 2026

### Changed
- **The note-mode button shows its state.** "＋ Add note" is now "Note mode" with a status dot: gray when off; when on, the dot lights up teal and the button gains a teal fill and a slow pulsing glow — so it's obvious at a glance that clicks will pin notes.

## [0.4.1] - June 11, 2026

### Added
- **Sticky note mode.** ＋ Add note (or `N`) now toggles a mode instead of arming a single note: stay armed and keep clicking/dragging to pin note after note, then exit with the button, `N`, or `Esc`. `Esc` escalates — first close the open composer, then exit note mode, then close the notes panel. Clicking an existing pin while in note mode seeks to it without dropping a stray new note, and a composer with typed text must be saved or cancelled before the next placement (an empty one is simply replaced).
- **Draggable composer.** The note composer has a top bar (grip + note metadata) you can grab to drag the popover out of the way when it covers the thing you're annotating. Clamped to the viewport.
- **Composer wears the note's color.** The composer border, save button, target line, and grip now match the color the note's pin will get (predicted for new notes, exact for edits), and the element-confirmation flashes use the same color — so what you see while composing is what lands on the timeline.

## [0.4.0] - June 11, 2026

### Added
- **Precise element targeting via the HyperFrames picker.** When the injected runtime exposes `__HF_PICKER_API` (the same element inspector Studio's layers panel uses), notes now capture an exact CSS selector, a human-readable label, the element's bounding box, and its `data-*` attributes (including `data-start`/`data-duration`) — so the agent gets an addressable element instead of a fuzzy tag/class/text guess. Older runtimes fall back to the previous heuristic automatically.
- **Live hover highlight while arming.** With ＋ Add note armed, the element under the crosshair gets a teal outline and a floating name tag before you click — no more pinning blind.
- **Overlap disambiguation in the composer.** When several elements stack under the pin point, the composer's target line becomes a dropdown of all candidates (topmost first); picking one flashes that element in the composition to confirm the choice.
- **Flash-to-verify on notes.** Hovering a note row, pin, or region flashes its target element in the note's own color; clicking seeks to the note's time and then flashes — instant confirmation a note still points at the right thing after edits.
- **Element outlines in review packets.** `vellum-review` now draws the target element's actual bounding box (plus a small dot at the click point) for pin notes that captured one, instead of the generic 40px square.

### Changed
- **Region notes capture their target at the box center** rather than the drag-start corner — the element a box surrounds is the subject, not whatever was under the first click.
- `annotations.md` lines append `· at \`<selector>\`` when an exact selector was captured, and the agent skill now instructs agents to prefer `target.selector` over the tag/class/text triple.

## [0.3.7] - June 11, 2026

### Added
- **Per-note colors.** Each note gets its own stable color from a 12-color palette (mapped by note id, so a note keeps its color for life). Pins, region boxes, their badges, and the notes-panel rows all share that color, making notes easy to tell apart at a glance.
- **Timeline note dots.** A colored dot sits above the scrubber at each note's point on the timeline, matching that note's color — click one to jump straight to it. Hover to preview `note-N · time — text`.
- **Scene-break ghost lines.** Faint vertical ticks on the scrubber mark where each scene begins, so you can see where ⏮/⏭ (and ↑/↓) will land the playhead before you jump. Hover a tick for the scene name and timestamp.

### Changed
- **Pins, regions, and dots brighten in their own color on hover** (with a matching glow), replacing the old fixed teal/white hover state now that markers are individually colored.
- **README leads with the demo.** Added the 52-second promo video (poster + link) to the hero and "Try the demo" sections, plus an animated terminal GIF (`assets/vellum-tui.gif`) showing the `vellum` startup — logo banner, status panel, and live note feed.

## [0.3.6] - June 11, 2026

### Changed
- **Installer banner now wears the logo.** The blue→purple layered "V" mark (`assets/logo-mark.png`) is recreated as truecolor half-block pixel art beside the VELLUM letters, and the same gradient sweeps the letters — blue on the V through purple on the M, light at the top fading deep below. Terminals 60–75 columns wide get the gradient letters without the mark; non-truecolor terminals keep the previous teal banner; piped/`NO_COLOR` output stays plain.
- **`◆ vellum` wordmark matches the logo.** New blue→purple `brandGradient()` in `scripts/vellum-ui.mjs`, used by the server, updater, and review wordmark. Teal accents elsewhere (rules, spinners, progress bars) unchanged.

## [0.3.5] - June 11, 2026

### Added
- **Terminal UI overhaul.** New zero-dependency `scripts/vellum-ui.mjs` toolkit: teal-gradient brand styling on truecolor terminals (256/16-color fallbacks, `NO_COLOR` honored, plain text when piped), rounded boxes, spinners, progress bars, and OSC-8 clickable links.
- **Live activity feed.** The review server now logs each event as it happens — note added/edited/resolved/reopened/deleted, notes cleared, mix saved — with timestamps, instead of sitting silent while you review.
- **Session summary on Ctrl+C.** Stopping the server prints how many notes were saved (open vs. done) and where, plus the agent handoff prompt.

### Changed
- **Server startup panel.** Gradient `◆ vellum` wordmark and a boxed status panel with a clickable review URL, composition, runtime source, and notes path (shows saved-note count when resuming a review).
- **`vellum update` polish.** Animated spinner while checking, styled `v0.3.x → v0.3.y` version diff, and clear up-to-date / available / failed states.
- **`vellum-review` progress.** Live progress bar with per-note ✓/✗ result lines while frames render (plain numbered lines when piped).
- **Installer redesign.** Teal-gradient VELLUM banner (compact fallback on narrow/no-color terminals), sectioned steps (`── Project check ──`, `── Review tool ──`, `── Agent skill ──`), one-line download progress instead of seven repeated "installed" lines, styled prompts/choice lists, and a cleaner "Vellum is ready" summary.

## [0.3.4] - June 11, 2026

### Changed
- **Control bar redesigned** — single fixed row that never wraps. Logo is now an inline SVG V mark with a teal glow (no more faint-on-dark PNG). Controls grouped by function with hairline separators: transport · scrub+timecode+scene · audio mix · actions. Secondary buttons (Copy prompt, Clear all) are icon-only. "Save mix" → "Mix", emoji audio labels → compact "VO"/"MX" text. Scrubber gets all remaining width.

## [0.3.3] - June 11, 2026

### Changed
- **Runtime is resolved dynamically, not by hardcoded filename.** The player now fetches the HyperFrames runtime from a stable `/__vellum/runtime.js` endpoint; the server globs the real build out of a local `node_modules/hyperframes` → npx cache → CDN. Survives a future runtime rename instead of hardcoding `dist/hyperframe.runtime.iife.js` on the client.
- **Audio bed detection honors an explicit `data-vellum-audio="music"|"voice"`** attribute on `<audio>` elements, falling back to the previous id/longest-clip heuristic.

### Added
- **Automatic port fallback.** If the default port (4848) is busy, the server hops to the next free port instead of crashing with `EADDRINUSE`. An explicit `VELLUM_PORT` is still honored exactly (clear error if taken).

## [0.3.2] - June 11, 2026

### Fixed
- Review player now locates the composition root by its `data-composition-id` attribute instead of requiring a literal `id="root"`. Compositions whose root element uses a different id (e.g. `id="stage"`) now mount correctly instead of failing with "no #root composition in index.html". Scene detection and the pin hit-test use the same lookup.

## [0.3.1] - June 11, 2026

### Fixed
- Installer no longer aborts under `set -e` right after installing the agent skill. On a root-composition install (no `--dir`, no existing `.vellum.env`), `write_vellum_env` ended on a `[ -f .vellum.env ] && rm -f …` test that returned non-zero, killing the script before the global `vellum` command was installed and before the "Start Vellum now?" step. Root-composition installs now complete cleanly.

## [0.3.0] - June 11, 2026

### Added
- **`vellum update`** — checks the published version and, when newer, updates the install in place by re-running the installer non-interactively while preserving your config (skill target, `VELLUM_DIR`/port). `vellum update --check` reports only; `--force` reinstalls. Adds `vellum version` too.
- **HyperFrames runtime resolution for `npx`-style projects** — when `node_modules/hyperframes` isn't installed (e.g. lessons that run `npx hyperframes@x`), the review server now serves the injected runtime from the npx cache (matching the version in `package.json`) or redirects to the jsDelivr CDN, so the composition mounts instead of failing to load. The startup banner shows the runtime source.

### Changed
- Installer sets up the global `vellum` command by default and no longer prompts for it (`--no-bin` / `VELLUM_INSTALL_BIN=0` still opt out).
- Agent-skill picker: **Claude Code** now installs to `.claude/skills` only; **Both** creates the canonical `.agents/skills` copy plus a `.claude/skills` symlink. Cursor/Codex/Windsurf unchanged.

### Fixed
- README license badge is now a static badge, avoiding shields.io "unable to select next github token from pool" errors.

## [0.2.0] - June 11, 2026

### Added
- **Global `vellum` command** — installer drops a shim into `~/.local/bin` (plus `vellum-review`) that walks up from your cwd, finds `scripts/vellum-server.mjs`, and reads `.vellum.env` for defaults.
- **Project launcher** (`scripts/vellum`) and shared module (`scripts/vellum-shared.mjs`) for composition resolution, formatting, and path guards.
- **Browser auto-open** on start (`--no-open` or `VELLUM_OPEN=0` to disable).
- **Note editing API** — `PATCH /api/notes/:id` for inline text edits and status (`open` | `resolved` | `wontfix`); stable `note-<id>` prefixes in `annotations.md` and review-packet filenames.
- **Player QoL** — **N** add-note shortcut, **Copy prompt**, inline edit, status cycle, responsive control bar.
- **Guided installer** — composition picker, install-mode menu, `--start`, `--no-bin`, `.vellum.env` defaults, gitignore prompt for `notes/` + `snapshots/`.
- **Agent skill routing** — installer asks which coding agent you use; skill installs to `.agents/skills/vellum/` by default; Claude Code gets `.claude/skills/vellum/` as a symlink to the same copy.
- **CI** — GitHub Actions workflow runs `npm test` on push and PR.
- `vellum-review` bin entry in `package.json`, so package installs expose both commands.
- Subresource Integrity (SRI) hashes on the CDN GSAP script tags in the demo composition.
- Installer options: `--dir`, `--port`, `--tool-only`, `--skill-only`, `--no-prompt`, and `--no-package`, plus subdir-aware npm script generation.
- Smoke tests for the server API, range requests, `VELLUM_DIR` guard, installer subdir wiring, global shim discovery, and skill symlink layout.

### Removed
- **Promo video** (`promo/`) — the embedded HyperFrames marketing composition and its assets were removed to keep the package focused on the review tooling and demo composition.
- Stale `Vellum-code.txt` monolith.

### Changed
- **README overhauled**: hook-first hero, quickstart above the fold, `vellum` command docs, a "What your agent sees" sample of `annotations.md`, merged agent-handoff section, and an "Under the hood" section with security/playback guarantees.
- README keyboard table now correctly describes arrow-key scrubbing as 0.1s steps (Shift = 1s).
- shadcn registry skill target moved to `.agents/skills/vellum/SKILL.md`.
- Package scripts now include `vellum`, `vellum:review`, and `test`, with `annotate` / `review` kept as aliases.
- The review player now reads `data-width` / `data-height` from the composition instead of assuming 1920×1080.
- Agent skill documents the `note-<id>` workflow, PATCH/status handling, and `.agents/skills` install path.

### Fixed
- `examples/demo` scene visibility is now timeline-driven (opacity crossfades), so `hyperframes snapshot` and `vellum-review` packets show the correct scene — the static-render path does not toggle `data-start` clip visibility. Also documented this as a heads-up in the README.
- Single-note delete now uses `DELETE /api/notes/:id` instead of clearing and reposting all notes.
- Hardened `VELLUM_DIR` path handling, oversized request responses, note/mix numeric bounds, suffix range requests, and review-packet failure exits.
- Installer fixes for `set -e` subshell returns, bin-shim prompt ordering, and non-TTY multi-composition prompts.

## [0.1.0] - June 10, 2026

Initial release — a transparent review-and-annotate layer for HyperFrames videos.

### Added
- **Review player** that mounts your real `index.html` composition in an iframe via the HyperFrames runtime — works with any composition, no per-project configuration. Scenes are read from the `data-start` attributes every composition already has.
- **Point pins and region boxes**: click a spot or drag a box on any frame to attach a note. Each note captures the composition time, the on-screen element it points at (tag, class, text), and pin/box coordinates.
- **Notes persisted to disk** at `<composition>/notes/` as `annotations.json` (structured) and `annotations.md` (human-readable cue sheet) for a coding agent to read.
- **Live audio mix** — voice/music sliders with a "Save mix" that writes `notes/mix.json` to bake into `data-volume`. Levels are re-asserted every frame, and each audio clip is kept seek-accurate so scrubbing into the middle of a clip still plays.
- **Scene-aware markers** (a pin only shows while its own scene is on screen), keyboard transport (play/scrub/frame-step), and scene jumping.
- **Visual review packet** (`vellum-review.mjs`): renders the composition frame at each note's time with the pin/box drawn on it, into `notes/review/`.
- **Companion agent skill** (`.claude/skills/vellum`) that teaches a coding agent to read the notes and apply them, deferring to the `hyperframes` / `hyperframes-cli` skills for the actual edits.
- **One-command installer** — `curl -fsSL …/install.sh | sh` drops the tool into `scripts/`, the agent skill into `.claude/skills/vellum/`, and wires `npm run vellum`.
- **shadcn GitHub registry** manifest (`registry.json`) distributing the tool and the skill as separate items.
- **Example composition** (`examples/demo/`) — a self-contained sample for trying Vellum immediately.
- **Brand assets** — logo, transparent mark, banner, generated social preview (1280×640), and favicon; the mark is embedded in the player as favicon and bar icon.

### Security
- Local-only by design: the server binds to `127.0.0.1`, sends no CORS headers, guards against path traversal, validates and length-caps note input, and invokes external tools (`hyperframes`, `ffmpeg`) with argument arrays only.

[Unreleased]: https://github.com/jakeat11labs/vellum/commits/main
