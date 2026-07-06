#!/bin/sh
# Vellum installer - run from the root of your HyperFrames project:
#   curl -fsSL https://tryvellum.vercel.app/install | sh
#
# Installs the review tool into scripts/ and the agent skill (default: .agents/skills/vellum/).
# Re-runnable; it never overwrites existing package.json scripts.
set -e

REPO="jakeat11labs/vellum"
REF="${VELLUM_REF:-main}"
BASE="${VELLUM_BASE_URL:-https://raw.githubusercontent.com/$REPO/$REF}"
BASE="${BASE%/}"
SCRIPTS_DIR="${VELLUM_SCRIPTS_DIR:-scripts}"
SKILL_DIR="${VELLUM_SKILL_DIR:-.agents/skills/vellum}"
SKILL_TARGETS="${VELLUM_SKILL_TARGETS:-}"
INSTALL_MODE="${VELLUM_INSTALL:-all}"
COMPOSITION_DIR="${VELLUM_COMPOSITION_DIR:-${VELLUM_DIR:-}}"
PORT_VALUE="${VELLUM_PORT_VALUE:-${VELLUM_PORT:-}}"
NO_PROMPT="${VELLUM_NO_PROMPT:-}"
NO_PACKAGE_SCRIPTS="${VELLUM_NO_PACKAGE_SCRIPTS:-}"
START_AFTER="${VELLUM_START:-0}"
INIT_MODE="${VELLUM_INIT:-ask}"
INSTALL_BIN="${VELLUM_INSTALL_BIN:-}"
BIN_DIR="${VELLUM_BIN_DIR:-$HOME/.local/bin}"
HAS_VELLUM_SCRIPT=0
HAS_VELLUM_CMD=0

usage() {
  cat <<'EOF'
Vellum installer

Usage:
  curl -fsSL https://tryvellum.vercel.app/install | sh
  curl -fsSL https://tryvellum.vercel.app/install | sh -s -- --dir compositions/hero

Options:
  --dir <path>       Default HyperFrames composition directory for npm scripts
  --port <number>    Default Vellum port for npm scripts
  --tool-only        Install scripts only
  --skill-only       Install the agent skill only
  --init             Scaffold a new HyperFrames project here if none exists
  --no-init          Never scaffold; just warn when no composition is found
  --start            Launch the review player when install finishes
  --no-bin           Don't install the global vellum command (installed by default)
  --no-prompt, -y    Accept defaults; useful for CI/automation
  --no-package       Do not modify package.json scripts
  --help             Show this help

Environment:
  VELLUM_COMPOSITION_DIR, VELLUM_PORT, VELLUM_INSTALL=all|tool|skill,
  VELLUM_SKILL_TARGETS (space-separated dirs), VELLUM_SKILL_DIR (single dir),
  VELLUM_NO_PROMPT=1, VELLUM_NO_PACKAGE_SCRIPTS=1, VELLUM_INSTALL_BIN=0|1,
  VELLUM_INIT=ask|1|0, VELLUM_BIN_DIR=~/.local/bin, VELLUM_START=1, VELLUM_REF=<git-ref>
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir)
      shift
      [ "$#" -gt 0 ] || { printf 'error: --dir needs a value\n' >&2; exit 1; }
      COMPOSITION_DIR="$1"
      ;;
    --port)
      shift
      [ "$#" -gt 0 ] || { printf 'error: --port needs a value\n' >&2; exit 1; }
      PORT_VALUE="$1"
      ;;
    --tool-only)
      INSTALL_MODE="tool"
      ;;
    --skill-only)
      INSTALL_MODE="skill"
      ;;
    --start)
      START_AFTER=1
      ;;
    --init)
      INIT_MODE=1
      ;;
    --no-init)
      INIT_MODE=0
      ;;
    --no-bin)
      INSTALL_BIN=0
      ;;
    --no-prompt|-y)
      NO_PROMPT=1
      ;;
    --no-package)
      NO_PACKAGE_SCRIPTS=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'error: unknown option: %s\n\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

case "$INSTALL_MODE" in
  all|tool|skill) ;;
  *) printf 'error: VELLUM_INSTALL must be all, tool, or skill\n' >&2; exit 1 ;;
esac

ESC="$(printf '\033')"
TRUECOLOR=0
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && command -v tput >/dev/null 2>&1; then
  bold="$(tput bold 2>/dev/null || true)"
  dim="$(tput dim 2>/dev/null || true)"
  green="$(tput setaf 2 2>/dev/null || true)"
  cyan="$(tput setaf 6 2>/dev/null || true)"
  yellow="$(tput setaf 3 2>/dev/null || true)"
  red="$(tput setaf 1 2>/dev/null || true)"
  reset="$(tput sgr0 2>/dev/null || true)"
  case "${COLORTERM:-}" in
    *truecolor*|*24bit*) TRUECOLOR=1 ;;
  esac
  case "${TERM_PROGRAM:-}" in
    iTerm.app|WezTerm|ghostty|vscode) TRUECOLOR=1 ;;
  esac
else
  bold=""; dim=""; green=""; cyan=""; yellow=""; red=""; reset=""
fi

# Brand teal ramp, light to deep (matches the player accent). Truecolor terminals
# get the real gradient; everything else falls back to plain cyan shades.
if [ "$TRUECOLOR" = "1" ]; then
  t1="${ESC}[38;2;153;246;228m"
  t2="${ESC}[38;2;94;234;212m"
  t3="${ESC}[38;2;45;212;191m"
  t4="${ESC}[38;2;20;184;166m"
  t5="${ESC}[38;2;13;148;136m"
  t6="${ESC}[38;2;15;118;110m"
elif [ -n "$cyan" ]; then
  t1="$bold$cyan"; t2="$bold$cyan"; t3="$cyan"; t4="$cyan"; t5="$dim$cyan"; t6="$dim$cyan"
else
  t1=""; t2=""; t3=""; t4=""; t5=""; t6=""
fi

say() { printf '%s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
ok() { printf '  %s✓%s %s\n' "$green" "$reset" "$*"; }
warn() { printf '  %s!%s %s\n' "$yellow" "$reset" "$*"; }
fail() { printf '  %s✗ ERROR%s %s\n' "$red" "$reset" "$*" >&2; exit 1; }

repeat_rule() {
  n="$1"
  s=""
  while [ "$n" -gt 0 ]; do s="${s}─"; n=$((n - 1)); done
  printf '%s' "$s"
}

section() {
  label="$1"
  rule_len=$((42 - ${#label}))
  [ "$rule_len" -lt 4 ] && rule_len=4
  printf '\n  %s──%s %s%s%s %s%s%s\n' "$t5" "$reset" "$bold" "$label" "$reset" "$t5" "$(repeat_rule "$rule_len")" "$reset"
}

has_tty() {
  { : > /dev/tty; } 2>/dev/null
}

can_prompt() {
  [ -z "$NO_PROMPT" ] && has_tty
}

tty_say() {
  if has_tty; then
    printf '%s\n' "$*" > /dev/tty 2>/dev/null || printf '%s\n' "$*"
  else
    printf '%s\n' "$*"
  fi
}

ask() {
  prompt="$1"
  default="$2"
  if ! has_tty; then
    printf '%s' "$default"
    return
  fi
  printf '  %s?%s %s %s[%s]%s ' "$t3" "$reset" "$prompt" "$dim" "$default" "$reset" > /dev/tty
  IFS= read -r answer < /dev/tty || answer=""
  [ -n "$answer" ] || answer="$default"
  printf '%s' "$answer"
}

pick_number() {
  prompt="$1"
  default="$2"
  max="$3"
  while true; do
    choice="$(ask "$prompt" "$default")"
    case "$choice" in
      *[!0-9]*) tty_say "  Enter a number from 1 to $max."; continue ;;
    esac
    if [ "$choice" -ge 1 ] 2>/dev/null && [ "$choice" -le "$max" ] 2>/dev/null; then
      printf '%s' "$choice"
      return
    fi
    tty_say "  Enter a number from 1 to $max."
  done
}

download() {
  url="$1"
  dest="$2"
  tmp="${dest}.tmp.$$"
  rm -f "$tmp"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$tmp" || { rm -f "$tmp"; return 1; }
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$tmp" "$url" || { rm -f "$tmp"; return 1; }
  else
    fail "need curl or wget installed"
  fi
  mv "$tmp" "$dest"
}

normalize_dir() {
  dir="$1"
  dir="${dir#/}"
  dir="${dir%/}"
  [ "$dir" = "." ] && dir=""
  old_ifs="$IFS"
  IFS="/"
  for part in $dir; do
    [ "$part" = ".." ] && { IFS="$old_ifs"; fail "composition directory cannot contain '..': $1"; }
  done
  IFS="$old_ifs"
  printf '%s' "$dir"
}

find_compositions() {
  [ -f index.html ] && printf '.\n'
  for f in */index.html; do
    [ -f "$f" ] || continue
    printf '%s\n' "${f%/index.html}"
  done
}

count_lines() {
  awk 'NF { n++ } END { print n + 0 }'
}

first_line() {
  awk 'NF { print; exit }'
}

composition_label() {
  comp="$1"
  if [ "$comp" = "." ]; then
    printf './index.html'
  else
    printf '%s/index.html' "$comp"
  fi
}

pick_composition_dir() {
  if [ -n "$COMPOSITION_DIR" ]; then
    return
  fi
  COMPOSITIONS="$(find_compositions)"
  COMP_COUNT="$(printf '%s\n' "$COMPOSITIONS" | count_lines)"

  if [ "$COMP_COUNT" -eq 0 ]; then
    return
  fi

  if [ "$COMP_COUNT" -eq 1 ]; then
    only="$(printf '%s\n' "$COMPOSITIONS" | first_line)"
    [ "$only" = "." ] || COMPOSITION_DIR="$only"
    return
  fi

  if can_prompt; then
    say ""
    info "${bold}Multiple compositions found:${reset}"
    i=1
    for comp in $COMPOSITIONS; do
      tty_say "    ${t3}$i${reset}) $(composition_label "$comp")"
      i=$((i + 1))
    done
    choice="$(pick_number "Choose composition" "1" "$COMP_COUNT")"
    i=1
    for comp in $COMPOSITIONS; do
      if [ "$i" -eq "$choice" ]; then
        [ "$comp" = "." ] || COMPOSITION_DIR="$comp"
        return
      fi
      i=$((i + 1))
    done
  else
    warn "multiple compositions detected; pass --dir <path> to wire npm scripts to one"
    say ""
    info "Available compositions:"
    for comp in $COMPOSITIONS; do
      info "  - $(composition_label "$comp")"
    done
    say ""
    info "Re-run with: curl -fsSL …/install.sh | sh -s -- --dir <folder>"
  fi
}

pick_hf_example() {
  HF_EXAMPLE="blank"
  if can_prompt; then
    say ""
    info "${bold}Start your new HyperFrames project from:${reset}"
    tty_say "    ${t3}1${reset}) Blank composition ${dim}(empty stage — recommended)${reset}"
    tty_say "    ${t3}2${reset}) Starter example ${dim}(sample scenes to review right away)${reset}"
    choice="$(pick_number "Choose" "1" "2")"
    case "$choice" in
      1) HF_EXAMPLE="blank" ;;
      2) HF_EXAMPLE="warm-grain" ;;
    esac
  fi
}

# Scaffold a HyperFrames project in the current directory (in place), then layer on the
# full /hyperframes agent skill set and install deps so the first `vellum` run is ready.
# All subprocesses read from /dev/null so they can't consume a piped `curl ... | sh` script.
# Returns non-zero (without aborting the installer) if the scaffold can't proceed.
scaffold_hyperframes() {
  if ! command -v npx >/dev/null 2>&1; then
    warn "npx not found (needs Node >= 18) — skipping project scaffold"
    return 1
  fi
  section "New HyperFrames project"
  pick_hf_example
  info "${t3}▸${reset} Scaffolding composition ${dim}(example: $HF_EXAMPLE)${reset}…"
  if ! npx hyperframes@latest init . --non-interactive --skip-skills --skip-transcribe -e "$HF_EXAMPLE" </dev/null; then
    warn "hyperframes init failed — continuing without a scaffolded project"
    return 1
  fi
  ok "created HyperFrames project (index.html, package.json)"

  info "${t3}▸${reset} Installing HyperFrames + GSAP agent skills…"
  if npx hyperframes@latest skills </dev/null; then
    ok "installed the /hyperframes skill set"
  else
    warn "could not install HyperFrames skills (run 'npx hyperframes skills' later)"
  fi

  # `hyperframes init` scaffolds scripts that call `npx --yes hyperframes@<ver>` rather than
  # listing hyperframes as a dependency, so a bare `npm install` installs nothing. Install the
  # runtime explicitly so the first `vellum` run resolves it from local node_modules (no CDN).
  if command -v npm >/dev/null 2>&1; then
    info "${t3}▸${reset} Installing the HyperFrames runtime ${dim}(npm install hyperframes)${reset}…"
    if npm install hyperframes </dev/null >/dev/null 2>&1; then
      ok "HyperFrames runtime installed (node_modules/hyperframes)"
    else
      warn "could not install hyperframes — the runtime loads from the CDN on first run"
    fi
  else
    warn "npm not found — run 'npm install hyperframes' to fetch the runtime locally"
  fi
  return 0
}

pick_install_mode() {
  if [ "$INSTALL_MODE" != "all" ] || ! can_prompt; then
    return
  fi
  say ""
  info "${bold}What do you want to install?${reset}"
  tty_say "    ${t3}1${reset}) Full setup — review tool + agent skill ${dim}(recommended)${reset}"
  tty_say "    ${t3}2${reset}) Review tool only"
  tty_say "    ${t3}3${reset}) Agent skill only"
  choice="$(pick_number "Choose" "1" "3")"
  case "$choice" in
    1) INSTALL_MODE="all" ;;
    2) INSTALL_MODE="tool" ;;
    3) INSTALL_MODE="skill" ;;
  esac
}

pick_skill_targets() {
  if [ "$WANT_SKILL" -ne 1 ]; then
    return
  fi
  if [ -n "$SKILL_TARGETS" ]; then
    return
  fi
  if [ -n "$VELLUM_SKILL_DIR" ]; then
    SKILL_TARGETS="$VELLUM_SKILL_DIR"
    return
  fi
  if ! can_prompt; then
    SKILL_TARGETS=".agents/skills/vellum"
    return
  fi
  say ""
  info "${bold}Which coding agent do you use?${reset}"
  tty_say "    ${t3}1${reset}) Cursor / Codex / Windsurf / most ${dim}(.agents/skills — recommended)${reset}"
  tty_say "    ${t3}2${reset}) Claude Code ${dim}(.claude/skills)${reset}"
  tty_say "    ${t3}3${reset}) Both ${dim}(.agents/skills + .claude/skills symlink)${reset}"
  choice="$(pick_number "Choose" "1" "3")"
  case "$choice" in
    1) SKILL_TARGETS=".agents/skills/vellum" ;;
    2) SKILL_TARGETS=".claude/skills/vellum" ;;
    3) SKILL_TARGETS=".agents/skills/vellum .claude/skills/vellum" ;;
  esac
}

canonical_skill_target() {
  for target in $SKILL_TARGETS; do
    if [ "$target" = ".agents/skills/vellum" ]; then
      printf '%s' "$target"
      return
    fi
  done
  for target in $SKILL_TARGETS; do
    printf '%s' "$target"
    return
  done
}

skill_link_relative() {
  from_dir="$1"
  to_path="$2"
  if [ "$from_dir" = ".claude/skills" ] && [ "$to_path" = ".agents/skills/vellum" ]; then
    printf '%s' "../../.agents/skills/vellum"
    return
  fi
  if command -v node >/dev/null 2>&1; then
    VELLUM_LINK_FROM="$from_dir" VELLUM_LINK_TO="$to_path" node -e '
const path = require("path");
console.log(path.relative(process.env.VELLUM_LINK_FROM, process.env.VELLUM_LINK_TO));
'
    return
  fi
  fail "need Node to symlink multiple skill targets; install one target or set VELLUM_SKILL_DIR"
}

link_skill_target() {
  link_path="$1"
  canonical="$2"
  parent="$(dirname "$link_path")"
  mkdir -p "$parent"
  if [ -e "$link_path" ] || [ -L "$link_path" ]; then
    rm -rf "$link_path"
  fi
  rel="$(skill_link_relative "$parent" "$canonical")" || return 1
  ln -s "$rel" "$link_path" || fail "could not link $link_path → $canonical"
}

install_agent_skills() {
  [ "$WANT_SKILL" -eq 1 ] || return 0
  section "Agent skill"
  canonical="$(canonical_skill_target)"
  [ -n "$canonical" ] || fail "no skill install target configured"

  mkdir -p "$canonical"
  download "$BASE/skills/vellum/SKILL.md" "$canonical/SKILL.md" || fail "could not download Vellum skill to $canonical"
  ok "installed $canonical/SKILL.md (canonical)"

  for target in $SKILL_TARGETS; do
    [ "$target" = "$canonical" ] && continue
    link_skill_target "$target" "$canonical" || fail "could not link $target to $canonical"
    ok "symlinked $target → $canonical"
  done
}

pick_bin_install() {
  if [ "$WANT_TOOL" -ne 1 ]; then
    return
  fi
  if [ -n "$VELLUM_INSTALL_BIN" ]; then
    INSTALL_BIN="$VELLUM_INSTALL_BIN"
    return
  fi
  if [ "$INSTALL_BIN" = "0" ]; then
    return
  fi
  # The global 'vellum' command is part of setup, not a question. It's installed
  # once and works from any HyperFrames project you set up — it auto-detects which
  # project you're in. Opt out with --no-bin or VELLUM_INSTALL_BIN=0.
  INSTALL_BIN=1
}

write_vellum_env() {
  [ "$WANT_TOOL" -eq 1 ] || return
  env_file=".vellum.env"
  tmp="${env_file}.tmp.$$"
  : > "$tmp"
  if [ -n "$COMPOSITION_DIR" ]; then
    printf 'VELLUM_DIR=%s\n' "$COMPOSITION_DIR" >> "$tmp"
  fi
  if [ -n "$PORT_VALUE" ]; then
    printf 'VELLUM_PORT=%s\n' "$PORT_VALUE" >> "$tmp"
  fi
  if [ -s "$tmp" ]; then
    mv "$tmp" "$env_file"
    ok "wrote $env_file (defaults for the vellum command)"
  else
    rm -f "$tmp" "$env_file"
  fi
}

install_bin_shims() {
  if [ "$INSTALL_BIN" != "1" ] || [ "$WANT_TOOL" -ne 1 ]; then
    return 0
  fi
  [ -f "$SCRIPTS_DIR/vellum-shim" ] || fail "missing $SCRIPTS_DIR/vellum-shim"
  mkdir -p "$BIN_DIR"
  cp "$SCRIPTS_DIR/vellum-shim" "$BIN_DIR/vellum"
  cp "$SCRIPTS_DIR/vellum-shim" "$BIN_DIR/vellum-review"
  chmod +x "$BIN_DIR/vellum" "$BIN_DIR/vellum-review" 2>/dev/null || true
  ok "global vellum command → $BIN_DIR (run 'vellum' from any project — it auto-detects which one)"
  HAS_VELLUM_CMD=1
  case ":$PATH:" in
    *:"$BIN_DIR":*) ;;
    *)
      warn "$BIN_DIR is not on your PATH"
      info "Add to ~/.zshrc or ~/.bashrc:  export PATH=\"$BIN_DIR:\$PATH\""
      ;;
  esac
}

ensure_gitignore_notes() {
  if [ ! -f .gitignore ]; then
    return
  fi
  # Vellum reviews now travel through git: notes/annotations.{json,md} stay TRACKED so the
  # review baseline + agent write-back ship with the repo. Only regenerable caches, binaries,
  # and diagnostics are ignored.
  ignore_lines="notes/composition.json notes/mix.json notes/review/ notes/attachments/ notes/metrics.jsonl notes/*.tmp-* snapshots/"

  # Migrate an older install that ignored the whole notes/ tree to the narrowed policy. Only
  # the exact bare `notes/` line is removed (conservative — never rewrites custom patterns).
  migrated=0
  if grep -q '^notes/$' .gitignore 2>/dev/null; then
    if can_prompt; then
      answer="$(ask "Narrow the existing notes/ ignore so reviews travel through git? (recommended)" "Y")"
      case "$answer" in
        n|N|no|NO|No) return ;;
      esac
    fi
    grep -v '^notes/$' .gitignore > .gitignore.vellum-tmp 2>/dev/null && mv .gitignore.vellum-tmp .gitignore
    migrated=1
  fi

  # Append only the targeted lines that aren't already present.
  missing=""
  for line in $ignore_lines; do
    if ! grep -qxF "$line" .gitignore 2>/dev/null; then
      missing="$missing $line"
    fi
  done
  if [ -z "$missing" ]; then
    return
  fi
  if [ "$migrated" -eq 0 ] && can_prompt; then
    answer="$(ask "Add Vellum's narrowed .gitignore entries (track annotations, ignore caches/binaries)? (recommended)" "Y")"
    case "$answer" in
      n|N|no|NO|No) return ;;
    esac
  fi
  printf '\n# Vellum / HyperFrames local artifacts (notes/annotations.{json,md} are tracked)\n' >> .gitignore
  for line in $missing; do
    printf '%s\n' "$line" >> .gitignore
  done
  ok "updated .gitignore for Vellum artifacts"
}

start_vellum() {
  if [ "$WANT_TOOL" -ne 1 ]; then
    return 0
  fi
  say ""
  info "${t3}▸${reset} Starting Vellum — your browser should open automatically."
  say ""
  if command -v vellum >/dev/null 2>&1; then
    exec vellum
  fi
  if [ -f "$SCRIPTS_DIR/vellum" ]; then
    exec sh "$SCRIPTS_DIR/vellum"
  fi
  if [ "$HAS_VELLUM_SCRIPT" = "1" ] && command -v npm >/dev/null 2>&1; then
    exec npm run vellum
  fi
  warn "could not start Vellum automatically; run vellum"
}

COMPOSITION_DIR="$(normalize_dir "$COMPOSITION_DIR")"

# Logo banner — recreates the blue→purple "V" mark (assets/logo-mark.png) as
# truecolor half-block pixel art, with the same gradient swept across the
# letters: blue on the V, purple on the M, light at the top fading deep below.
# mark=1 draws the V glyph beside the wordmark; mark=0 letters only.
print_logo_banner() {
  awk -v esc="$ESC" -v mark="$1" '
function fgs(s, p) { split(s, p, " "); return esc "[38;2;" p[1] ";" p[2] ";" p[3] "m" }
function bgs(s, p) { split(s, p, " "); return esc "[48;2;" p[1] ";" p[2] ";" p[3] "m" }
# Pixel color of the V mark at pixel row r (0-11), col c (0-13); "" = transparent.
# Left arm runs light blue → blue, right arm (in front) light violet → violet.
function vc(r, c,  t, lx, rx) {
  t = r / 11.0; lx = t * 5.0; rx = 14 - 3.6 - t * 5.0
  if (c >= rx && c < rx + 3.6)
    return int(196 + (124 - 196) * t + 0.5) " " int(181 + (58 - 181) * t + 0.5) " " int(253 + (237 - 253) * t + 0.5)
  if (c >= lx && c < lx + 3.6)
    return int(157 + (59 - 157) * t + 0.5) " " int(221 + (130 - 221) * t + 0.5) " " int(252 + (246 - 252) * t + 0.5)
  return ""
}
BEGIN {
  # gradient corner colors: blue top/bottom, purple top/bottom
  bt[1] = 157; bt[2] = 221; bt[3] = 252;  bb[1] = 59;  bb[2] = 130; bb[3] = 246
  pt[1] = 196; pt[2] = 181; pt[3] = 253;  pb[1] = 124; pb[2] = 58;  pb[3] = 237
  split("██╗   ██╗|███████╗|██╗     |██╗     |██╗   ██╗|███╗   ███╗", art1, "|")
  split("██║   ██║|██╔════╝|██║     |██║     |██║   ██║|████╗ ████║", art2, "|")
  split("██║   ██║|█████╗  |██║     |██║     |██║   ██║|██╔████╔██║", art3, "|")
  split("╚██╗ ██╔╝|██╔══╝  |██║     |██║     |██║   ██║|██║╚██╔╝██║", art4, "|")
  split(" ╚████╔╝ |███████╗|███████╗|███████╗|╚██████╔╝|██║ ╚═╝ ██║", art5, "|")
  split("  ╚═══╝  |╚══════╝|╚══════╝|╚══════╝| ╚═════╝ |╚═╝     ╚═╝", art6, "|")
  for (i = 1; i <= 6; i++) {
    art[1, i] = art1[i]; art[2, i] = art2[i]; art[3, i] = art3[i]
    art[4, i] = art4[i]; art[5, i] = art5[i]; art[6, i] = art6[i]
  }
  for (row = 0; row < 6; row++) {
    line = "  "
    if (mark == 1) {
      for (c = 0; c < 14; c++) {
        top = vc(row * 2, c); bot = vc(row * 2 + 1, c)
        if (top == "" && bot == "") line = line esc "[0m "
        else if (top != "" && bot != "") line = line fgs(top) bgs(bot) "▀" esc "[0m"
        else if (top != "") line = line esc "[0m" fgs(top) "▀" esc "[0m"
        else line = line esc "[0m" fgs(bot) "▄" esc "[0m"
      }
      line = line "    "
    }
    for (i = 1; i <= 6; i++) {
      h = (i - 1) / 5.0; t = row / 5.0
      for (k = 1; k <= 3; k++) {
        topk = bt[k] + (pt[k] - bt[k]) * h
        botk = bb[k] + (pb[k] - bb[k]) * h
        col[k] = int(topk + (botk - topk) * t + 0.5)
      }
      line = line esc "[38;2;" col[1] ";" col[2] ";" col[3] "m" art[row + 1, i]
    }
    print line esc "[0m"
  }
}' </dev/null
}

print_banner() {
  cols=80
  if [ -t 1 ] && command -v tput >/dev/null 2>&1; then
    cols="$(tput cols 2>/dev/null || printf '80')"
  fi
  say ""
  if [ "$TRUECOLOR" = "1" ] && [ "${cols:-80}" -ge 60 ] && command -v awk >/dev/null 2>&1; then
    if [ "${cols:-80}" -ge 76 ]; then
      print_logo_banner 1
    else
      print_logo_banner 0
    fi
  elif [ -n "$t1" ] && [ "${cols:-80}" -ge 60 ]; then
    say "  ${t1}██╗   ██╗███████╗██╗     ██╗     ██╗   ██╗███╗   ███╗${reset}"
    say "  ${t2}██║   ██║██╔════╝██║     ██║     ██║   ██║████╗ ████║${reset}"
    say "  ${t3}██║   ██║█████╗  ██║     ██║     ██║   ██║██╔████╔██║${reset}"
    say "  ${t4}╚██╗ ██╔╝██╔══╝  ██║     ██║     ██║   ██║██║╚██╔╝██║${reset}"
    say "  ${t5} ╚████╔╝ ███████╗███████╗███████╗╚██████╔╝██║ ╚═╝ ██║${reset}"
    say "  ${t6}  ╚═══╝  ╚══════╝╚══════╝╚══════╝ ╚═════╝ ╚═╝     ╚═╝${reset}"
  else
    say "  ${bold}${cyan}◆ VELLUM${reset}  ${dim}· HyperFrames review layer${reset}"
  fi
  say ""
  say "  ${dim}Pin time-coded notes on any frame — your agent reads them back.${reset}"
  say ""
}

print_banner
info "${dim}Project${reset}  $(pwd)"
info "${dim}Source${reset}   $REPO @ $REF"

pick_composition_dir
COMPOSITIONS="$(find_compositions)"
COMP_COUNT="$(printf '%s\n' "$COMPOSITIONS" | count_lines)"
COMPOSITION_DIR="$(normalize_dir "$COMPOSITION_DIR")"
pick_install_mode

case "$INSTALL_MODE" in
  all) WANT_TOOL=1; WANT_SKILL=1 ;;
  tool) WANT_TOOL=1; WANT_SKILL=0 ;;
  skill) WANT_TOOL=0; WANT_SKILL=1 ;;
esac

pick_bin_install
pick_skill_targets

# Nothing to review yet? Offer to scaffold a HyperFrames project here (in place), pull in the
# /hyperframes skill set, and install deps — then the rest of the install wires up against it.
if [ "$WANT_TOOL" -eq 1 ] && [ -z "$COMPOSITION_DIR" ] && [ "$COMP_COUNT" -eq 0 ]; then
  do_init=0
  case "$INIT_MODE" in
    1) do_init=1 ;;
    0) do_init=0 ;;
    *)
      if can_prompt; then
        answer="$(ask "No HyperFrames project here — create one? (installs HF skills + deps)" "Y")"
        case "$answer" in
          y|Y|yes|YES|Yes) do_init=1 ;;
        esac
      fi
      ;;
  esac
  if [ "$do_init" -eq 1 ] && scaffold_hyperframes; then
    # Re-detect now that index.html exists; the composition is the project root.
    COMPOSITIONS="$(find_compositions)"
    COMP_COUNT="$(printf '%s\n' "$COMPOSITIONS" | count_lines)"
    COMPOSITION_DIR=""
  fi
fi

section "Project check"

if [ -n "$COMPOSITION_DIR" ]; then
  if [ ! -f "$COMPOSITION_DIR/index.html" ]; then
    warn "no index.html found at $COMPOSITION_DIR/index.html"
  else
    ok "composition → $(composition_label "$COMPOSITION_DIR")"
  fi
elif [ -f index.html ]; then
  ok "composition → index.html"
elif [ "$COMP_COUNT" -gt 1 ]; then
  warn "multiple compositions — npm scripts won't set VELLUM_DIR until you pass --dir"
else
  warn "no index.html found; run from a HyperFrames project root or pass --dir <path>"
fi

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0')"
  if [ "$NODE_MAJOR" -ge 18 ] 2>/dev/null; then
    ok "Node $(node -v)"
  else
    warn "Node >= 18 is required; found $(node -v 2>/dev/null || printf unknown)"
  fi
else
  warn "Node >= 18 is required to run Vellum and add npm scripts"
fi

if [ -d node_modules/hyperframes ] || { [ -n "$COMPOSITION_DIR" ] && [ -d "$COMPOSITION_DIR/node_modules/hyperframes" ]; }; then
  ok "HyperFrames runtime found"
else
  warn "node_modules/hyperframes not found; run npm install in your HyperFrames project before reviewing"
fi

TOOL_FILES="vellum vellum-shim vellum-shared.mjs vellum-ui.mjs vellum-notes.mjs vellum-server.mjs vellum-template.html vellum-review.mjs vellum-update.mjs"

if [ "$WANT_TOOL" -eq 1 ]; then
  section "Review tool"
  mkdir -p "$SCRIPTS_DIR"
  tool_count=0
  for f in $TOOL_FILES; do
    if [ -t 1 ]; then
      printf '\r%s[K  %s↓ fetching %s…%s' "$ESC" "$dim" "$f" "$reset"
    fi
    if ! download "$BASE/scripts/$f" "$SCRIPTS_DIR/$f"; then
      if [ -t 1 ]; then printf '\r%s[K' "$ESC"; fi
      fail "could not download $f"
    fi
    tool_count=$((tool_count + 1))
  done
  if [ -t 1 ]; then printf '\r%s[K' "$ESC"; fi
  chmod +x "$SCRIPTS_DIR/vellum" "$SCRIPTS_DIR/vellum-shim" 2>/dev/null || true
  ok "review tool → $SCRIPTS_DIR/ ($tool_count files)"
  info "${dim}vellum · vellum-shim · vellum-shared.mjs · vellum-ui.mjs · vellum-notes.mjs${reset}"
  info "${dim}vellum-server.mjs · vellum-template.html · vellum-review.mjs · vellum-update.mjs${reset}"
fi

if [ "$WANT_TOOL" -eq 1 ]; then
  write_vellum_env
  ensure_gitignore_notes
  install_bin_shims
fi

if [ "$WANT_TOOL" -eq 1 ] && [ -f package.json ] && [ -z "$NO_PACKAGE_SCRIPTS" ]; then
  if command -v node >/dev/null 2>&1; then
    VELLUM_SCRIPTS_DIR="$SCRIPTS_DIR" \
    VELLUM_COMPOSITION_DIR="$COMPOSITION_DIR" \
    VELLUM_PORT_VALUE="$PORT_VALUE" \
    VELLUM_C_OK="$green" \
    VELLUM_C_DIM="$dim" \
    VELLUM_C_RESET="$reset" \
    node <<'NODE'
const fs = require("fs");
const path = require("path");

const pkgPath = "package.json";
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.scripts = pkg.scripts || {};

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
const scriptsDir = process.env.VELLUM_SCRIPTS_DIR || "scripts";
const compositionDir = process.env.VELLUM_COMPOSITION_DIR || "";
const port = process.env.VELLUM_PORT_VALUE || "";
const env = [];

if (compositionDir && compositionDir !== ".") env.push(`VELLUM_DIR=${shellQuote(compositionDir)}`);
if (port) env.push(`VELLUM_PORT=${shellQuote(port)}`);

const prefix = env.length ? `${env.join(" ")} ` : "";
const server = `${prefix}node ${shellQuote(path.posix.join(scriptsDir, "vellum-server.mjs"))}`;
const review = `${prefix}node ${shellQuote(path.posix.join(scriptsDir, "vellum-review.mjs"))}`;
const added = [];
const kept = [];

if (!pkg.scripts.vellum) {
  pkg.scripts.vellum = server;
  added.push("vellum");
} else {
  kept.push("vellum");
}

if (!pkg.scripts["vellum:review"]) {
  pkg.scripts["vellum:review"] = review;
  added.push("vellum:review");
} else {
  kept.push("vellum:review");
}

fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

const G = process.env.VELLUM_C_OK || "";
const D = process.env.VELLUM_C_DIM || "";
const R = process.env.VELLUM_C_RESET || "";
if (added.length) console.log(`  ${G}✓${R} added npm scripts: ${added.join(", ")}`);
if (kept.length) console.log(`  ${D}kept existing npm scripts: ${kept.join(", ")}${R}`);
NODE
    HAS_VELLUM_SCRIPT="$(node -e 'try{const p=require("./package.json");const s=p.scripts&&p.scripts.vellum||"";console.log(/vellum/.test(s)?"1":"0")}catch{console.log("0")}' 2>/dev/null || printf '0')"
  else
    warn "package.json found, but Node is unavailable; npm scripts were not changed"
  fi
elif [ "$WANT_TOOL" -eq 1 ] && [ ! -f package.json ]; then
  warn "no package.json found; run ./$SCRIPTS_DIR/vellum from your project root"
fi

install_agent_skills

say ""
say "  ${t4}$(repeat_rule 46)${reset}"
say ""
say "  ${green}✓${reset} ${bold}Vellum is ready.${reset} From this project directory:"
say ""
if [ "$HAS_VELLUM_CMD" = "1" ]; then
  say "    ${bold}${t2}vellum${reset}                  ${dim}open the review player in your browser${reset}"
elif [ -f "$SCRIPTS_DIR/vellum" ]; then
  say "    ${bold}${t2}./$SCRIPTS_DIR/vellum${reset}   ${dim}open the review player in your browser${reset}"
elif [ "$HAS_VELLUM_SCRIPT" = "1" ]; then
  say "    ${bold}${t2}npm run vellum${reset}          ${dim}open the review player in your browser${reset}"
fi
if [ "$HAS_VELLUM_CMD" = "1" ]; then
  say "    ${bold}${t2}vellum update${reset}           ${dim}check for and install the latest version${reset}"
fi
say ""
say "  ${dim}Pin notes on any frame, then tell your agent:${reset}"
say "  ${t3}\"address my Vellum review notes\"${reset}"
say ""

if [ "$START_AFTER" = "1" ]; then
  start_vellum
elif [ "$WANT_TOOL" -eq 1 ] && can_prompt; then
  answer="$(ask "Start Vellum now?" "Y")"
  case "$answer" in
    y|Y|yes|YES|Yes) start_vellum ;;
  esac
fi