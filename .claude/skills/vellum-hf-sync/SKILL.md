---
name: vellum-hf-sync
description: >
  Check whether Vellum still works against the latest HyperFrames release, and evaluate
  new HyperFrames capabilities Vellum could adopt. Use this whenever the user asks about
  HyperFrames versions, upstream changes, or drift — including "is our HyperFrames pin
  stale", "did HyperFrames break us", "what's new in HyperFrames", "check upstream",
  "are we still compatible", "should we bump hyperframes", or "what could we pull in from
  HyperFrames". Also use proactively before cutting a Vellum release, when a bug report
  mentions the player failing to mount or the runtime failing to load, or when touching
  any of vellum-server.mjs's runtime resolution, vellum-review.mjs's snapshot call, or
  install.sh's scaffold path — all of which are coupled to HyperFrames and can rot
  silently. This is a maintainer-only skill for the Vellum repo; it never ships to users.
---

# Vellum ↔ HyperFrames sync

Vellum is a companion tool. HyperFrames ships constantly — dozens of releases a month —
and Vellum has no compile-time link to it, so drift is invisible until a user hits it.
This skill makes the drift visible on demand and turns it into a decision.

Two questions get answered every run, and both matter:

1. **Does Vellum still work?** Which is mostly a question about a small set of runtime
   globals and CLI flags, not about the version number.
2. **What did HyperFrames build that Vellum should use?** This is the half that's easy to
   skip and the half with the upside. Vellum's job is to close the human-feedback loop on
   AI-edited video; every new HyperFrames capability is a potential shortcut for that.

## Step 1 — probe

```bash
node .claude/skills/vellum-hf-sync/scripts/hf-probe.mjs
```

The probe downloads the published package, fingerprints it, and diffs against
`baseline.json` (the last version a human verified Vellum against). It prints a human
summary followed by the full JSON. Useful variants:

| Command | Use |
| --- | --- |
| `--version 0.7.12` | probe a specific release instead of `latest` |
| `--json` | JSON only, for piping |
| `--save-baseline` | record the probed version as the new verified baseline |

Output comes in two sections, and the distinction matters:

- **Upstream drift** — HyperFrames moved since the verified baseline. This is news; act on it.
- **Standing advisories** — mismatches between Vellum's own manifest and HyperFrames'
  requirements. These persist across runs and some are *deliberate*: Vellum's Node floor is
  intentionally below HyperFrames' because the player never shells out to the CLI. Read
  these as "still true", not "still broken", and check `README.md` before treating one as a
  bug — the current split is documented there on purpose.

Exit codes: `0` current · `1` drift, contract intact · `2` **contract broken** · `3` probe
failed. Don't lean on the exit code alone — a `1` can hide a docs problem that matters
more to users than a `2` would.

## Step 2 — triage the findings

Read `references/coupling-map.md` before interpreting anything. It lists every place
Vellum touches HyperFrames with file and line, plus — importantly — the three things that
are *deliberately* decoupled. A finding that lands in a decoupled area is noise.

Sort each finding into one of four buckets. The buckets exist because they have genuinely
different urgency, and reporting them as one undifferentiated list buries the real news:

**Broken** — a critical contract symbol is gone. The player won't mount, or the review
packet won't render. Verify before believing the probe: it does substring matching on a
bundled build, so a minifier change could produce a false positive. Confirm by actually
running Vellum against the new version (Step 3) before telling anyone it's broken.

**At risk** — nothing is broken yet, but an assumption got weaker. A renamed dist file
that still matches the glob, a new engines floor, a frozen dependency pin. These are the
findings worth acting on early, because they're cheap now and expensive after a user
reports them.

**Docs drift** — Vellum's prose promises something about HyperFrames that is no longer
true. Nothing tests this, so it accumulates. It matters more than its severity suggests:
`skills/vellum/SKILL.md` ships to users' coding agents, so a wrong skill name there sends
someone's agent hunting for a file that doesn't exist.

**Opportunity** — a new capability. Handle these in Step 4.

## Step 3 — verify, don't assume

The probe reads files. It doesn't run anything. Before reporting either "we're fine" or
"we're broken", exercise the real path:

```bash
npm install --no-save hyperframes@<version>   # temporarily swap the runtime
npm test                                       # the smoke test suite
node scripts/vellum-server.mjs --help          # server boots, resolution logic runs
```

Then start the server against `examples/demo` and confirm the player actually mounts and
the scrubber moves. The smoke test covers a lot but it stubs the browser; mounting is the
thing that breaks, and only a real mount proves it doesn't.

Restore the pin afterward (`npm install` re-reads `package.json`) unless the plan is to
adopt the new version.

## Step 4 — evaluate new capabilities honestly

The temptation is to list everything new and call it a report. Resist that — an
undifferentiated feature list pushes the judgment work back onto the reader.

Score each candidate against what Vellum actually is. These four properties are load-
bearing product decisions, not incidental implementation details, and a feature that
violates one is usually not worth its cost no matter how appealing it looks:

- **It never modifies the composition.** Vellum reads and overlays. A capability that
  requires writing to `index.html` changes what Vellum *is*.
- **It needs no per-project configuration.** Scenes come from `data-start` attributes
  every composition already has. A capability that needs a config file breaks the "works
  on any HyperFrames project" promise.
- **The server has zero runtime dependencies.** Pure Node built-ins. A capability that
  needs a package is a real cost, not a free add.
- **It strengthens the pin → note → agent loop.** Vellum's whole value is that feedback
  keeps its *where* and *when*. Features that don't feed that loop are someone else's job.

For each candidate worth proposing, state: what it does, which part of Vellum it would
replace or extend, which of the four properties it pressures, and roughly what it costs.
A one-line "could be interesting" is not useful to anyone.

Where to look for what's new:

- The `cli-commands` finding diffs the `hyperframes-cli` skill description, which
  enumerates every command. New verbs appear there first.
- New `dist/*.global.js` bundles signal new browser-side runtime capabilities.
- `dist/skills/hyperframes-cli/references/*.md` in the downloaded package documents each
  command properly. The probe cleans up its temp dir, so re-download to read them:
  `npm pack hyperframes@latest` in a scratch directory.

## Step 5 — report

Use this structure. It leads with the answer to "are we OK", because that's what the
reader came for:

```markdown
## Verdict
[CURRENT | DRIFT | BROKEN] — baseline X.Y.Z → latest A.B.C
One sentence on whether Vellum works today.

## Contract status
Table of the runtime + CLI symbols, present/missing, and what was actually verified
(probe alone, or probe + real mount).

## What needs fixing
Grouped by bucket, each with the file:line to change and why it matters to a user.
Say plainly if a bucket is empty.

## Worth adopting
Each candidate scored against the four properties, with a cost estimate.
Say plainly if nothing qualifies — that's a legitimate result.

## Recommendation
What to do now, what to defer, what to ignore. Take a position.
```

## Step 6 — update the baseline

Only after a human has accepted the new version — meaning Step 3 passed and any fixes are
in — record it:

```bash
node .claude/skills/vellum-hf-sync/scripts/hf-probe.mjs --save-baseline
```

This is deliberately manual. The baseline means "a human confirmed Vellum works here", and
auto-advancing it would quietly destroy the only record of that. If you skip this after
adopting a version, the next run re-reports drift that was already handled — annoying, but
strictly safer than the alternative.

## Extending the contract

When Vellum starts depending on a new HyperFrames global, attribute, or CLI flag, add it
to `RUNTIME_CONTRACT` or `CLI_CONTRACT` in `scripts/hf-probe.mjs` **and** to the comment
block at `scripts/vellum-template.html:367`. Those two lists are supposed to say the same
thing; when they disagree, the probe is checking for something the player doesn't use, or
worse, missing something it does.

Mark an entry `critical: false` when the code guards its absence — the picker API is the
model here: Vellum checks `typeof api.getCandidatesAtPoint === "function"` and falls back
to locally-generated labels, so losing it degrades quality rather than breaking the tool.
