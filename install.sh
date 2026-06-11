#!/bin/sh
# Vellum installer - run from the root of your HyperFrames project:
#   curl -fsSL https://raw.githubusercontent.com/jakeat11labs/vellum/main/install.sh | sh
#
# Installs the review tool into scripts/ and the agent skill into .claude/skills/vellum/.
# Re-runnable; it never overwrites existing package.json scripts.
set -e

REPO="jakeat11labs/vellum"
REF="${VELLUM_REF:-main}"
BASE="${VELLUM_BASE_URL:-https://raw.githubusercontent.com/$REPO/$REF}"
BASE="${BASE%/}"
SCRIPTS_DIR="${VELLUM_SCRIPTS_DIR:-scripts}"
SKILL_DIR="${VELLUM_SKILL_DIR:-.claude/skills/vellum}"
INSTALL_MODE="${VELLUM_INSTALL:-all}"
COMPOSITION_DIR="${VELLUM_COMPOSITION_DIR:-${VELLUM_DIR:-}}"
PORT_VALUE="${VELLUM_PORT_VALUE:-${VELLUM_PORT:-}}"
NO_PROMPT="${VELLUM_NO_PROMPT:-}"
NO_PACKAGE_SCRIPTS="${VELLUM_NO_PACKAGE_SCRIPTS:-}"
HAS_VELLUM_SCRIPT=0

usage() {
  cat <<'EOF'
Vellum installer

Usage:
  curl -fsSL https://raw.githubusercontent.com/jakeat11labs/vellum/main/install.sh | sh
  curl -fsSL https://raw.githubusercontent.com/jakeat11labs/vellum/main/install.sh | sh -s -- --dir M01L01

Options:
  --dir <path>       Default HyperFrames composition directory for npm scripts
  --port <number>    Default Vellum port for npm scripts
  --tool-only        Install scripts only
  --skill-only       Install the agent skill only
  --no-prompt, -y    Accept defaults; useful for CI/automation
  --no-package       Do not modify package.json scripts
  --help             Show this help

Environment:
  VELLUM_COMPOSITION_DIR, VELLUM_PORT, VELLUM_INSTALL=all|tool|skill,
  VELLUM_NO_PROMPT=1, VELLUM_NO_PACKAGE_SCRIPTS=1, VELLUM_REF=<git-ref>
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

can_prompt() {
  [ -z "$NO_PROMPT" ] && [ -r /dev/tty ] && [ -w /dev/tty ]
}

ask() {
  prompt="$1"
  default="$2"
  printf '  %s [%s]: ' "$prompt" "$default" > /dev/tty
  IFS= read -r answer < /dev/tty || answer=""
  [ -n "$answer" ] || answer="$default"
  printf '%s' "$answer"
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

COMPOSITION_DIR="$(normalize_dir "$COMPOSITION_DIR")"
COMPOSITIONS="$(find_compositions)"
COMP_COUNT="$(printf '%s\n' "$COMPOSITIONS" | count_lines)"

say ""
say "  ${bold}${cyan}Vellum installer${reset}"
say "  ${dim}Transparent review notes for HyperFrames compositions${reset}"
say ""
info "Project: $(pwd)"

if [ -z "$COMPOSITION_DIR" ]; then
  if [ "$COMP_COUNT" -eq 1 ]; then
    only="$(printf '%s\n' "$COMPOSITIONS" | first_line)"
    [ "$only" = "." ] || COMPOSITION_DIR="$only"
  elif [ "$COMP_COUNT" -gt 1 ] && can_prompt; then
    info "Detected compositions:"
    printf '%s\n' "$COMPOSITIONS" | sed 's/^/    - /' > /dev/tty
    COMPOSITION_DIR="$(normalize_dir "$(ask "Default composition directory for npm scripts" ".")")"
  fi
fi

if [ "$INSTALL_MODE" = "all" ] && can_prompt; then
  answer="$(ask "Install agent skill too? (recommended)" "Y")"
  case "$answer" in
    n|N|no|NO|No) INSTALL_MODE="tool" ;;
  esac
fi

case "$INSTALL_MODE" in
  all) WANT_TOOL=1; WANT_SKILL=1 ;;
  tool) WANT_TOOL=1; WANT_SKILL=0 ;;
  skill) WANT_TOOL=0; WANT_SKILL=1 ;;
esac

if [ -n "$COMPOSITION_DIR" ]; then
  if [ ! -f "$COMPOSITION_DIR/index.html" ]; then
    warn "no index.html found at $COMPOSITION_DIR/index.html"
  else
    ok "composition: $COMPOSITION_DIR/index.html"
  fi
elif [ -f index.html ]; then
  ok "composition: index.html"
elif [ "$COMP_COUNT" -gt 1 ]; then
  warn "multiple compositions detected; pass --dir <path> to wire npm scripts to one"
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
  mkdir -p "$SCRIPTS_DIR"
  download "$BASE/scripts/vellum-server.mjs" "$SCRIPTS_DIR/vellum-server.mjs" || fail "could not download vellum-server.mjs"
  download "$BASE/scripts/vellum-template.html" "$SCRIPTS_DIR/vellum-template.html" || fail "could not download vellum-template.html"
  download "$BASE/scripts/vellum-review.mjs" "$SCRIPTS_DIR/vellum-review.mjs" || fail "could not download vellum-review.mjs"
  ok "installed $SCRIPTS_DIR/vellum-server.mjs"
  ok "installed $SCRIPTS_DIR/vellum-template.html"
  ok "installed $SCRIPTS_DIR/vellum-review.mjs"
fi

if [ "$WANT_SKILL" -eq 1 ]; then
  mkdir -p "$SKILL_DIR"
  download "$BASE/skills/vellum/SKILL.md" "$SKILL_DIR/SKILL.md" || fail "could not download Vellum skill"
  ok "installed $SKILL_DIR/SKILL.md"
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
    HAS_VELLUM_SCRIPT="$(node -e 'try{const p=require("./package.json");const s=p.scripts&&p.scripts.vellum||"";console.log(/vellum-server\.mjs/.test(s)?"1":"0")}catch{console.log("0")}' 2>/dev/null || printf '0')"
  else
    warn "package.json found, but Node is unavailable; npm scripts were not changed"
  fi
elif [ "$WANT_TOOL" -eq 1 ] && [ ! -f package.json ]; then
  warn "no package.json found; use node $SCRIPTS_DIR/vellum-server.mjs"
fi

say ""
say "  ${bold}Done.${reset} Start reviewing:"
if [ "$HAS_VELLUM_SCRIPT" = "1" ]; then
  info "npm run vellum"
fi
if [ -n "$COMPOSITION_DIR" ]; then
  info "VELLUM_DIR=$COMPOSITION_DIR node $SCRIPTS_DIR/vellum-server.mjs"
else
  info "node $SCRIPTS_DIR/vellum-server.mjs"
fi
info "Then open the printed URL, pin notes, and tell your agent: \"address my Vellum review notes\"."
say ""
