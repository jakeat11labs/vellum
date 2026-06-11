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
  --start            Launch the review player when install finishes
  --no-bin           Don't install the global vellum command (installed by default)
  --no-prompt, -y    Accept defaults; useful for CI/automation
  --no-package       Do not modify package.json scripts
  --help             Show this help

Environment:
  VELLUM_COMPOSITION_DIR, VELLUM_PORT, VELLUM_INSTALL=all|tool|skill,
  VELLUM_SKILL_TARGETS (space-separated dirs), VELLUM_SKILL_DIR (single dir),
  VELLUM_NO_PROMPT=1, VELLUM_NO_PACKAGE_SCRIPTS=1, VELLUM_INSTALL_BIN=0|1,
  VELLUM_BIN_DIR=~/.local/bin, VELLUM_START=1, VELLUM_REF=<git-ref>
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

if [ -t 1 ] && command -v tput >/dev/null 2>&1; then
  bold="$(tput bold 2>/dev/null || true)"
  dim="$(tput dim 2>/dev/null || true)"
  green="$(tput setaf 2 2>/dev/null || true)"
  cyan="$(tput setaf 6 2>/dev/null || true)"
  yellow="$(tput setaf 3 2>/dev/null || true)"
  red="$(tput setaf 1 2>/dev/null || true)"
  reset="$(tput sgr0 2>/dev/null || true)"
else
  bold=""; dim=""; green=""; cyan=""; yellow=""; red=""; reset=""
fi

say() { printf '%s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
ok() { printf '  %sOK%s %s\n' "$green" "$reset" "$*"; }
warn() { printf '  %sWARN%s %s\n' "$yellow" "$reset" "$*"; }
fail() { printf '  %sERROR%s %s\n' "$red" "$reset" "$*" >&2; exit 1; }

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
  printf '  %s [%s]: ' "$prompt" "$default" > /dev/tty
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
    info "Multiple compositions found:"
    i=1
    for comp in $COMPOSITIONS; do
      tty_say "    $i) $(composition_label "$comp")"
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

pick_install_mode() {
  if [ "$INSTALL_MODE" != "all" ] || ! can_prompt; then
    return
  fi
  say ""
  info "What do you want to install?"
  tty_say "    1) Full setup — review tool + agent skill ${dim}(recommended)${reset}"
  tty_say "    2) Review tool only"
  tty_say "    3) Agent skill only"
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
  info "Which coding agent do you use?"
  tty_say "    1) Cursor / Codex / Windsurf / most ${dim}(.agents/skills — recommended)${reset}"
  tty_say "    2) Claude Code ${dim}(.claude/skills)${reset}"
  tty_say "    3) Both ${dim}(.agents/skills + .claude/skills symlink)${reset}"
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
  say ""
  info "Installing agent skill…"
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
    rm -f "$tmp"
    [ -f "$env_file" ] && rm -f "$env_file"
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
  if grep -q '^notes/$' .gitignore 2>/dev/null || grep -q '^notes/' .gitignore 2>/dev/null; then
    has_notes=1
  else
    has_notes=0
  fi
  if grep -q '^snapshots/$' .gitignore 2>/dev/null || grep -q '^snapshots/' .gitignore 2>/dev/null; then
    has_snapshots=1
  else
    has_snapshots=0
  fi
  if [ "$has_notes" -eq 1 ] && [ "$has_snapshots" -eq 1 ]; then
    return
  fi
  if can_prompt; then
    answer="$(ask "Add notes/ + snapshots/ to .gitignore? (recommended)" "Y")"
    case "$answer" in
      n|N|no|NO|No) return ;;
    esac
  fi
  if [ "$has_notes" -eq 0 ] || [ "$has_snapshots" -eq 0 ]; then
    printf '\n# Vellum / HyperFrames local artifacts\n' >> .gitignore
  fi
  if [ "$has_notes" -eq 0 ]; then
    printf 'notes/\n' >> .gitignore
  fi
  if [ "$has_snapshots" -eq 0 ]; then
    printf 'snapshots/\n' >> .gitignore
  fi
  ok "updated .gitignore for Vellum artifacts"
}

start_vellum() {
  if [ "$WANT_TOOL" -ne 1 ]; then
    return 0
  fi
  info "Starting Vellum — your browser should open automatically."
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

say ""
say "  ${bold}${cyan}╭──────────────────────────────────────────────╮${reset}"
say "  ${bold}${cyan}│${reset}  ${bold}VELLUM${reset}  ·  HyperFrames review layer       ${bold}${cyan}│${reset}"
say "  ${bold}${cyan}╰──────────────────────────────────────────────╯${reset}"
say "  ${dim}Pin time-coded notes on any frame — your agent reads them back.${reset}"
say ""
info "Project: $(pwd)"
info "Source:  $REPO @ $REF"

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

say ""
info "Checking project…"

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

if [ "$WANT_TOOL" -eq 1 ]; then
  say ""
  info "Installing review tool…"
  mkdir -p "$SCRIPTS_DIR"
  download "$BASE/scripts/vellum" "$SCRIPTS_DIR/vellum" || fail "could not download vellum launcher"
  download "$BASE/scripts/vellum-shim" "$SCRIPTS_DIR/vellum-shim" || fail "could not download vellum-shim"
  download "$BASE/scripts/vellum-shared.mjs" "$SCRIPTS_DIR/vellum-shared.mjs" || fail "could not download vellum-shared.mjs"
  download "$BASE/scripts/vellum-server.mjs" "$SCRIPTS_DIR/vellum-server.mjs" || fail "could not download vellum-server.mjs"
  download "$BASE/scripts/vellum-template.html" "$SCRIPTS_DIR/vellum-template.html" || fail "could not download vellum-template.html"
  download "$BASE/scripts/vellum-review.mjs" "$SCRIPTS_DIR/vellum-review.mjs" || fail "could not download vellum-review.mjs"
  download "$BASE/scripts/vellum-update.mjs" "$SCRIPTS_DIR/vellum-update.mjs" || fail "could not download vellum-update.mjs"
  chmod +x "$SCRIPTS_DIR/vellum" "$SCRIPTS_DIR/vellum-shim" 2>/dev/null || true
  ok "installed $SCRIPTS_DIR/vellum"
  ok "installed $SCRIPTS_DIR/vellum-shim"
  ok "installed $SCRIPTS_DIR/vellum-shared.mjs"
  ok "installed $SCRIPTS_DIR/vellum-server.mjs"
  ok "installed $SCRIPTS_DIR/vellum-template.html"
  ok "installed $SCRIPTS_DIR/vellum-review.mjs"
  ok "installed $SCRIPTS_DIR/vellum-update.mjs"
fi

install_agent_skills

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

if (added.length) console.log(`  added npm scripts: ${added.join(", ")}`);
if (kept.length) console.log(`  kept existing npm scripts: ${kept.join(", ")}`);
NODE
    HAS_VELLUM_SCRIPT="$(node -e 'try{const p=require("./package.json");const s=p.scripts&&p.scripts.vellum||"";console.log(/vellum/.test(s)?"1":"0")}catch{console.log("0")}' 2>/dev/null || printf '0')"
  else
    warn "package.json found, but Node is unavailable; npm scripts were not changed"
  fi
elif [ "$WANT_TOOL" -eq 1 ] && [ ! -f package.json ]; then
  warn "no package.json found; run ./$SCRIPTS_DIR/vellum from your project root"
fi

say ""
say "  ${bold}${green}Done!${reset} From this project directory:"
say ""
if [ "$HAS_VELLUM_CMD" = "1" ]; then
  say "    ${bold}vellum${reset}                  ${dim}← opens your browser to the review player${reset}"
elif [ -f "$SCRIPTS_DIR/vellum" ]; then
  say "    ${bold}./$SCRIPTS_DIR/vellum${reset}   ${dim}← opens your browser to the review player${reset}"
elif [ "$HAS_VELLUM_SCRIPT" = "1" ]; then
  say "    ${bold}npm run vellum${reset}          ${dim}← opens your browser to the review player${reset}"
fi
if [ "$HAS_VELLUM_CMD" = "1" ]; then
  say "    ${bold}vellum update${reset}           ${dim}← check for and install the latest version${reset}"
fi
say ""
say "  ${dim}Pin notes on any frame, then tell your agent:${reset}"
say "  ${dim}\"address my Vellum review notes\"${reset}"
say ""

if [ "$START_AFTER" = "1" ]; then
  start_vellum
elif [ "$WANT_TOOL" -eq 1 ] && can_prompt; then
  answer="$(ask "Start Vellum now?" "Y")"
  case "$answer" in
    y|Y|yes|YES|Yes) start_vellum ;;
  esac
fi