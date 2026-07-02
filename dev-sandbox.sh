#!/usr/bin/env bash
#
# dev-sandbox.sh — a throwaway HyperFrames project for dogfooding Vellum.
#
# Scaffolds a real `hyperframes init` project under sandbox/ and installs Vellum
# into it FROM YOUR LOCAL WORKING TREE — running the real install.sh, fetching
# scripts/ + the skill over file:// (VELLUM_BASE_URL), so you exercise the
# genuine installer codepath against your edits without publishing anything.
#
# Everything lives under sandbox/ which is gitignored, so it never ships.
#
# Usage:
#   ./dev-sandbox.sh              scaffold (if missing) + (re)install Vellum from the working tree
#   ./dev-sandbox.sh --reinstall  re-run install.sh only (skip scaffold) — fastest loop after editing scripts/
#   ./dev-sandbox.sh --fresh      wipe sandbox/project and rebuild from scratch
#   ./dev-sandbox.sh --run        ...then launch the Vellum player when done
#
# Env knobs:
#   SANDBOX_EXAMPLE   hyperframes example to scaffold (default: warm-grain; try: blank, swiss-grid)
#   SANDBOX_DIR       where the sandbox lives (default: <repo>/sandbox)
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX="${SANDBOX_DIR:-$REPO/sandbox}"
PROJECT="$SANDBOX/project"
BIN_DIR="$SANDBOX/bin"
EXAMPLE="${SANDBOX_EXAMPLE:-warm-grain}"

FRESH=0
RUN=0
REINSTALL_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --fresh)     FRESH=1 ;;
    --run)       RUN=1 ;;
    --reinstall) REINSTALL_ONLY=1 ;;
    -h|--help)
      awk 'NR>1 && /^#/{sub(/^# ?/,"");print} NR>1 && !/^#/{exit}' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      printf 'dev-sandbox: unknown option %s (try --help)\n' "$arg" >&2
      exit 1
      ;;
  esac
done

say() { printf '\033[36m▸\033[0m %s\n' "$1"; }

if ! command -v npx >/dev/null 2>&1; then
  printf 'dev-sandbox: needs Node/npx (>= 18) on PATH\n' >&2
  exit 1
fi

# 1 ─ Scaffold a real HyperFrames project (unless we're only reinstalling).
if [ "$FRESH" -eq 1 ]; then
  say "Wiping $PROJECT"
  rm -rf "$PROJECT"
fi

if [ "$REINSTALL_ONLY" -eq 0 ] && [ ! -f "$PROJECT/index.html" ]; then
  say "Scaffolding HyperFrames project (example: $EXAMPLE) → sandbox/project"
  mkdir -p "$PROJECT"
  ( cd "$PROJECT" && npx hyperframes@latest init . \
      --non-interactive --skip-skills --skip-transcribe -e "$EXAMPLE" </dev/null )
  # `hyperframes init` wires npx-based scripts and lists no hyperframes dep, so a bare
  # `npm install` fetches nothing. Install the runtime explicitly so the player resolves it
  # from local node_modules (no CDN) — matching what install.sh --init does for real users.
  say "Installing HyperFrames runtime (npm install hyperframes)"
  ( cd "$PROJECT" && npm install --silent --no-audit --no-fund hyperframes )
elif [ ! -f "$PROJECT/index.html" ]; then
  printf 'dev-sandbox: no project at %s — run without --reinstall first\n' "$PROJECT" >&2
  exit 1
fi

# 2 ─ Install Vellum into the sandbox from the LOCAL working tree.
#     file:// base → the real install.sh fetches scripts/ + skill from this repo.
#     NO_PROMPT → fully non-interactive even from a real terminal.
#     A sandbox-local bin dir so we never clobber a globally-installed `vellum`.
say "Installing Vellum from working tree → sandbox/project"
( cd "$PROJECT" && \
  VELLUM_BASE_URL="file://$REPO" \
  VELLUM_SKILL_TARGETS=".agents/skills/vellum .claude/skills/vellum" \
  VELLUM_BIN_DIR="$BIN_DIR" \
  VELLUM_NO_PROMPT=1 \
  VELLUM_START=0 \
  sh "$REPO/install.sh" --no-init </dev/null )

say "Sandbox ready: $PROJECT"
printf '   Player : \033[36mcd sandbox/project && npm run vellum\033[0m  (or %s/vellum)\n' "$BIN_DIR"
printf '   Notes  : sandbox/project/notes/annotations.md\n'
printf '   Reload : ./dev-sandbox.sh --reinstall   after editing scripts/ or install.sh\n'

# 3 ─ Optionally launch the player.
if [ "$RUN" -eq 1 ]; then
  say "Launching Vellum player"
  exec sh -c 'cd "$0" && npm run vellum' "$PROJECT"
fi
