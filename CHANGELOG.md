# Changelog

All notable changes to Vellum are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
