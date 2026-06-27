---
name: vellum
description: Apply human review feedback to a HyperFrames video composition. Use after a user has reviewed a HyperFrames video with Vellum and left time-coded notes — i.e. when the user says "address my review notes", "apply the Vellum notes", "I left feedback on the video", "check the annotations", or points you at notes/annotations.md. Vellum is a local review player that mounts the real index.html composition and lets a human pin point/region notes onto specific frames; each note carries the composition time, the on-screen element it points at, and the feedback text. This skill is the receiving end: read those notes and edit the composition to satisfy them. Defer to the `hyperframes` skill for composition-editing patterns and `hyperframes-cli` for lint/preview/render commands.
---

# Vellum — apply review feedback to a HyperFrames composition

Vellum is a companion tool, not a builder. The human runs it, scrubs the video, and pins
feedback onto frames. **Your job is to read that feedback and make the edits.**

## How Vellum fits with the HyperFrames skills

| Skill | Owns |
|---|---|
| `hyperframes` | building/editing the composition (scenes, captions, animation) |
| `hyperframes-cli` | CLI: `lint`, `inspect`, `preview`, `snapshot`, `render` |
| **`vellum`** (this) | receiving human review notes and turning them into edits |

When a note requires a composition change, follow the `hyperframes` skill's patterns for the
actual edit. Use `hyperframes-cli` to verify (`lint`, then `snapshot --at <time>`).

## The workflow

1. **Locate the notes.** They live at `<comp>/notes/annotations.md` (readable) and
   `annotations.json` (structured). In a single-composition project that's `./notes/`; if the
   composition lives in a subfolder, notes are under that subdir (e.g. `compositions/hero/notes/`).

2. **Read them.** `annotations.md` lists each note as:
   `- **note-<id>** · **M:SS.ss** \`scene-id\`[ · **<severity>**] — <feedback>  _(pin x%, y% | box …)_ · on \`tag.class\` "text" · at \`<css selector>\` · _(status)_`
   The `note-<id>` links to `notes/review/note-<id>.png`. Use `time`, `scene`, and `target` to find the edit in `index.html`.
   The optional bold `· **<severity>**` token is the reviewer's triage (`blocker` > `major` > `nit`) — the
   file is ordered severity-first then by time, so **fix blockers first**. Notes that share an on-screen
   element are grouped under a `- **N notes on \`tag.cls\`** · at \`selector\`` header — address every note in a
   cluster together rather than reopening the scene once per note.
   Statuses are `open` / `addressed` (you edited it, awaiting the human's verify) / `resolved` / `wontfix` — skip
   `resolved`/`wontfix` unless the user asks you to revisit them. An `addressed` note also renders a
   `- resolution by <agent> · <at> — <summary>` sub-line (plus a `- edit: …` line per file/selector you
   touched) recording your write-back. A `_(stale: …)_` tag means the composition's index.html changed
   since the note was pinned — re-verify before applying. A timecode written as `M:SS.ss–M:SS.ss` is an
   in/out **time span** (a range to trim/retime), not a point. A `- ref images:` sub-line lists reviewer
   sketches under `notes/attachments/` — open them before acting. A trailing `## Metrics` section is
   self-measured review diagnostics (first-pass fix rate, etc.) — informational, not feedback to act on.

3. **See what each note points at (optional but recommended for visual notes).** Run the
   review-packet builder to render the actual frame with the marker drawn on it:
   ```bash
   npm run vellum:review                  # installer path
   node scripts/vellum-review.mjs         # clone/manual path
   npx vellum-review                      # package/bin path
   # subfolder composition:
   VELLUM_DIR=compositions/hero node scripts/vellum-review.mjs
   ```
   Then read `<comp>/notes/review/INDEX.md` and the `note-<id>.png` images — they show the
   frame at the note's time with the pin/box overlaid.

4. **Translate each note to an edit.**
   - The note's `time` is composition-time in seconds. Map it to the owning scene's
     `data-start`/`data-duration` in `index.html`, and to any timeline cue.
   - The `target` identifies the on-screen element to change. When `target.selector` is
     present (notes pinned with a picker-capable HyperFrames runtime) it is an **exact CSS
     selector** captured live at pin time — trust it over the fuzzy tag/class/text triple.
     `annotations.json` may also carry `target.label` (human-readable element name),
     `target.box` (the element's bounding box at pin time, in % of comp size), and
     `target.data` (the element's `data-*` attributes — e.g. `data-start`/`data-duration`,
     which give you the element's own timing without hunting for it).
   - `note.severity` (in `annotations.json`, enum `blocker`/`major`/`nit`, absent = unset) is the
     reviewer's priority — they set it because it can't be inferred from the prose. Triage by it.
   - `note.timeEnd` (when present) makes the note an interval `[time, timeEnd]` — apply the change
     across that whole range (e.g. a trim/retime), not at a single instant.
   - `note.attachments[]` reference reviewer sketches saved under `notes/attachments/` — open the
     `file` paths to see the desired result before editing.
   - Older notes carry only tag + class + text — match those against `index.html` manually.
   - Timing notes ("cut 2s here", "caption lands late") usually mean adjusting `data-start` /
     `data-duration` and re-syncing dependent cues — follow the `hyperframes` timing rules.

5. **Verify.** After edits, run the project's lint, then snapshot at the note's time to confirm
   the fix (`npx hyperframes snapshot --at <time>`). Prefer `annotations.json` for exact
   coordinates/timing, inspect review images for visual notes, re-snapshot after each fix, and
   re-read the original note before marking it satisfied.

6. **Write back what you changed, per note.** Vellum has a structured write-back channel so your
   edits flow back to the human's review player for verification. For each note you acted on, record a
   resolution and flip the status to `addressed` (NOT `resolved` — leave the final verify to the human).
   Two equivalent ways:
   - **Server running** — `PATCH /api/notes/<id>` with
     `{"status":"addressed","resolution":{"by":"<your agent name>","summary":"<one line: what you changed>","edits":[{"file":"index.html","selector":"<css>","detail":"<what changed>"}]}}`.
   - **Server stopped** — edit `notes/annotations.json` directly: set the note's `"status":"addressed"`
     and add the same `"resolution"` object, keeping the file a valid JSON array.

   Leave the status at `addressed` so the human verifies it (a click in the player flips
   `addressed → resolved`); use `"wontfix"` plus a resolution `summary` if you chose not to act. The
   server stamps `resolution.at` when you omit it, bounds/sanitizes the record, and regenerates
   `annotations.md` (and canonicalizes `annotations.json`) on its next boot so offline edits surface —
   a malformed file is preserved untouched. Reference `note-<id>` in your chat summary so it lines up
   with the review packet.

## Saved audio mix

If `<comp>/notes/mix.json` exists, the human balanced voice vs music levels in the player and
saved them. Apply by setting the matching `data-volume` on the relevant `<audio>` clips
(voice clips → `voice`, the music bed → `music`).

## Running Vellum (to tell the user)

Vellum is started by the human, not by you — it opens a browser review player automatically:
```bash
vellum                          # installer path — opens the browser
npm run vellum                  # if you skipped the global command
npx vellum                      # composition is ./index.html
VELLUM_DIR=compositions/hero vellum    # composition is ./compositions/hero/index.html
```
If they haven't reviewed yet and ask you to, point them at the command above, then wait for the
notes to appear before acting.

## Don'ts

- Don't invent feedback the notes don't contain.
- Don't start or assume the server is running — read the notes files from disk.
- Don't bypass the `hyperframes` editing patterns; a note is *what* to change, that skill is *how*.
