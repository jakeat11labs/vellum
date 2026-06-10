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
   `annotations.json` (structured). In a single-composition project that's `./notes/`; in a
   monorepo it's under the lesson subdir (e.g. `M01L01/notes/`).

2. **Read them.** `annotations.md` lists each note as:
   `- **M:SS.ss** \`scene-id\` — <feedback>  _(pin x%, y% | box …)_ · on \`tag.class\` "text"`
   The `time`, `scene`, and `target` tell you *exactly* where in the composition the note lands.

3. **See what each note points at (optional but recommended for visual notes).** Run the
   review-packet builder to render the actual frame with the marker drawn on it:
   ```bash
   node scripts/vellum-review.mjs          # or: VELLUM_DIR=<subdir> node scripts/vellum-review.mjs
   ```
   Then read `<comp>/notes/review/INDEX.md` and the `note-<id>.png` images — they show the
   frame at the note's time with the pin/box overlaid.

4. **Translate each note to an edit.**
   - The note's `time` is composition-time in seconds. Map it to the owning scene's
     `data-start`/`data-duration` in `index.html`, and to any timeline cue.
   - The `target` (tag + class + text) identifies the on-screen element to change.
   - Timing notes ("cut 2s here", "caption lands late") usually mean adjusting `data-start` /
     `data-duration` and re-syncing dependent cues — follow the `hyperframes` timing rules.

5. **Verify.** After edits, run the project's lint, then snapshot at the note's time to confirm
   the fix (`npx hyperframes snapshot --at <time>`). Re-read the note and check it's satisfied.

6. **Report back per note.** Tell the user, note by note, what you changed (or why you didn't).

## Saved audio mix

If `<comp>/notes/mix.json` exists, the human balanced voice vs music levels in the player and
saved them. Apply by setting the matching `data-volume` on the relevant `<audio>` clips
(voice clips → `voice`, the music bed → `music`).

## Running Vellum (to tell the user)

Vellum is started by the human, not by you — it opens a browser review player:
```bash
npx vellum                      # composition is ./index.html
VELLUM_DIR=M01L01 npx vellum    # composition is ./M01L01/index.html
```
If they haven't reviewed yet and ask you to, point them at the command above, then wait for the
notes to appear before acting.

## Don'ts

- Don't invent feedback the notes don't contain.
- Don't start or assume the server is running — read the notes files from disk.
- Don't bypass the `hyperframes` editing patterns; a note is *what* to change, that skill is *how*.
