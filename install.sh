#!/bin/sh
# Vellum installer — run from the root of your HyperFrames project:
#   curl -fsSL https://raw.githubusercontent.com/jakeat11labs/vellum/main/install.sh | sh
#
# Installs the review tool into scripts/ and the agent skill into .claude/skills/vellum/.
# Zero dependencies beyond curl (or wget). Re-runnable; never overwrites your package.json scripts.
set -e

REPO="jakeat11labs/vellum"
REF="${VELLUM_REF:-main}"
BASE="https://raw.githubusercontent.com/$REPO/$REF"
SCRIPTS_DIR="scripts"
SKILL_DIR=".claude/skills/vellum"

printf '\n  Installing Vellum into %s\n\n' "$(pwd)"

# Gentle sanity check — Vellum reviews a HyperFrames composition (index.html).
if [ ! -f index.html ] && ! ls -d */index.html >/dev/null 2>&1; then
  printf '  note: no index.html found here. Run this from your HyperFrames project root\n'
  printf '        (the folder with index.html and node_modules/hyperframes).\n\n'
fi

dl() { # dl <url> <dest>
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else printf '  error: need curl or wget installed.\n' >&2; exit 1
  fi
}

mkdir -p "$SCRIPTS_DIR" "$SKILL_DIR"

dl "$BASE/scripts/vellum-server.mjs"    "$SCRIPTS_DIR/vellum-server.mjs"
dl "$BASE/scripts/vellum-template.html" "$SCRIPTS_DIR/vellum-template.html"
dl "$BASE/scripts/vellum-review.mjs"    "$SCRIPTS_DIR/vellum-review.mjs"
dl "$BASE/skills/vellum/SKILL.md"       "$SKILL_DIR/SKILL.md"

printf '  + %s/vellum-server.mjs\n'   "$SCRIPTS_DIR"
printf '  + %s/vellum-template.html\n' "$SCRIPTS_DIR"
printf '  + %s/vellum-review.mjs\n'   "$SCRIPTS_DIR"
printf '  + %s/SKILL.md\n'            "$SKILL_DIR"

# Add convenience npm scripts if there's a package.json and Node is available.
if [ -f package.json ] && command -v node >/dev/null 2>&1; then
  node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));p.scripts=p.scripts||{};const a=[];if(!p.scripts.vellum){p.scripts.vellum="node scripts/vellum-server.mjs";a.push("vellum")}if(!p.scripts["vellum:review"]){p.scripts["vellum:review"]="node scripts/vellum-review.mjs";a.push("vellum:review")}fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\n");if(a.length)console.log("  added npm scripts: "+a.join(", "))'
fi

printf '\n  Done. Start reviewing:\n'
if [ -f package.json ]; then
  printf '    npm run vellum\n'
fi
printf '    node scripts/vellum-server.mjs            # composition is ./index.html\n'
printf '    VELLUM_DIR=M01L01 node scripts/vellum-server.mjs   # monorepo subdir\n\n'
printf '  Then open the printed URL, pin notes, and tell your agent: "address my Vellum review notes".\n\n'
