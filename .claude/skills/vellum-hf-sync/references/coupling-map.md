# Vellum ↔ HyperFrames coupling map

Every place Vellum reaches into HyperFrames. When the probe reports drift, this is the
list you walk to decide whether it matters. Line numbers drift as the code moves — treat
them as starting points and grep the anchor string if a jump lands in the wrong place.

Grouped by how the two projects touch: the runtime the player injects, the CLI Vellum
shells out to, the dependency declaration, and the prose that promises things about
HyperFrames to users.

## Contents

- [1. Browser runtime (the load-bearing surface)](#1-browser-runtime-the-load-bearing-surface)
- [2. CLI shell-outs](#2-cli-shell-outs)
- [3. Dependency + environment declarations](#3-dependency--environment-declarations)
- [4. Prose that makes promises about HyperFrames](#4-prose-that-makes-promises-about-hyperframes)
- [5. What is deliberately NOT coupled](#5-what-is-deliberately-not-coupled)

---

## 1. Browser runtime (the load-bearing surface)

If any of this breaks, the player will not mount and Vellum is dead in the water. The
probe marks these `broken` rather than `warn` for that reason.

| Where | Anchor | Depends on |
| --- | --- | --- |
| `scripts/vellum-template.html:367` | `HyperFrames runtime contract Vellum depends on` | The canonical comment listing the contract. **Keep this and `hf-probe.mjs`'s `RUNTIME_CONTRACT` in sync** — if they disagree, one of them is lying. |
| `scripts/vellum-template.html:589` | `sc.src = RUNTIME` | Injects the runtime `<script>` into the composition iframe. |
| `scripts/vellum-template.html:594` | `win.__playerReady && win.__player` | Polls for mount, 8s timeout. A rename here surfaces as "player did not mount". |
| `scripts/vellum-template.html:595` | `player.getDuration()` | Timeline length; falls back to `data-duration` on the root. |
| `scripts/vellum-template.html:485` | `[data-start] direct children` | Scene list and tick marks. Generic on purpose — no per-project config. |
| `scripts/vellum-template.html:907` | `contentWindow.__HF_PICKER_API` | **Optional.** Friendly element labels. Guarded with a `typeof` check, so a missing picker degrades to locally-generated labels rather than failing. |
| `scripts/vellum-server.mjs:158` | `findRuntimeFile` | Globs `dist/` for `/runtime/i` + `.iife.js`. This glob is why the 0.6→0.7 dist reshuffle didn't break anything — resist any temptation to hardcode the filename. |
| `scripts/vellum-server.mjs:144` | `detectHyperframesVersion` | Reads the version out of the *user's* project `package.json` (deps, then `hyperframes@x.y.z` inside scripts) to pick a CDN tag. |
| `scripts/vellum-server.mjs:173` | `findNpxRuntimeDir` | Walks `~/.npm/_npx/*/node_modules/hyperframes` so `npx`-style projects work with no local install. |
| `scripts/vellum-server.mjs:212` | `serveRuntime` | Local → npx cache → 302 to jsDelivr. The CDN fallback means a dist rename breaks *silently* in the browser, not loudly on the server. |

**Resolution order matters:** local `node_modules` wins, then the npx cache, then the CDN.
A user on HF 0.7.x gets 0.7.x's runtime even though Vellum's own `package.json` pins 0.6.x
— Vellum's pin only governs Vellum's own dev/test environment, not what users load. That's
why a stale pin is a testing-fidelity problem rather than a user-facing outage.

## 2. CLI shell-outs

| Where | Command | Breaks what |
| --- | --- | --- |
| `scripts/vellum-review.mjs:74` | `npx hyperframes snapshot --at <t>` | The visual review packet. Optional feature — Vellum's core loop doesn't need it. |
| `install.sh:339` | `npx hyperframes@latest init . --non-interactive --skip-skills --skip-transcribe -e <example>` | Scaffolding into an empty folder. Four separate flags to keep alive. |
| `install.sh:346` | `npx hyperframes@latest skills` | Installing the HF agent skill set. |
| `install.sh:357` | `npm install hyperframes` | Fetching the runtime locally after a scaffold. |

Note `install.sh` uses `@latest` while `package.json` pins `^0.6.91`. A fresh install
therefore scaffolds with a *newer* HyperFrames than Vellum's own CI ever exercises. This
is the single widest gap between what's tested and what ships.

## 3. Dependency + environment declarations

| Where | Declares | Watch for |
| --- | --- | --- |
| `package.json` `dependencies.hyperframes` | `^0.6.91` | `^0.x` locks the **minor**. `npm install` cannot cross 0.6 → 0.7. Bumps are manual. |
| `package.json` `engines.node` | `>=18` | HyperFrames requires `>=22` and hard-errors below it (`dist/runtimeVersion.js`). |
| `package.json` `keywords` | includes `hyperframes` | Discovery only, no behavior. |

## 4. Prose that makes promises about HyperFrames

Documentation drift is the most common failure mode here, because nothing tests it.

| Where | Claims |
| --- | --- |
| `README.md:77` | the installer sets up "the full `/hyperframes` + GSAP agent skill set" |
| `README.md:85` | "Node ≥ 18" |
| `README.md:180` | `hyperframes-cli` does "`lint` · `preview` · `snapshot` · `render`" |
| `README.md:222` | review-packet caveat about `snapshot` and `data-start` clip toggling |
| `skills/vellum/SKILL.md:3` | defers to the `hyperframes` and `hyperframes-cli` skills |
| `skills/vellum/SKILL.md:15-20` | table mapping each HF skill to its job |
| `skills/vellum/SKILL.md:107` | tells the agent to verify with `npx hyperframes snapshot --at <time>` |
| `skills/vellum/SKILL.md:149` | "Don't bypass the `hyperframes` editing patterns" |

`skills/vellum/SKILL.md` is the one that ships to users' agents, so a wrong skill name
there sends someone's coding agent looking for a file that doesn't exist.

## 5. What is deliberately NOT coupled

Worth knowing so you don't "fix" something that's intentionally loose:

- **No composition parsing.** Vellum reads `data-start` off the DOM after the real
  `index.html` has run. It never parses HTML itself, so composition-format changes are
  invisible to it.
- **No HyperFrames imports.** `scripts/*.mjs` use only Node built-ins. The dependency
  exists to have a runtime to serve, not to call into.
- **No hardcoded dist paths on the client.** The player fetches `/__vellum/runtime.js`;
  the server resolves what that actually is.

These three choices are why a full minor-version jump upstream produced zero broken
symbols. Preserve them.
