# Changelog

All notable changes to Vellum are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/jakeat11labs/vellum/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jakeat11labs/vellum/releases/tag/v0.1.0
