/**
 * Vellum terminal UI toolkit — zero dependencies, Node built-ins only.
 *
 * Renders the teal-gradient brand styling on truecolor terminals, falls back to
 * 256/16-color where needed, and degrades to plain unstyled text when output is
 * piped or NO_COLOR is set — so logs, CI output, and the smoke tests stay clean.
 */

const out = process.stdout;

function detectLevel() {
  const env = process.env;
  if (env.NO_COLOR != null && env.NO_COLOR !== "") return 0;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return 3;
  if (!out.isTTY) return 0;
  if (env.TERM === "dumb") return 0;
  if (/truecolor|24bit/i.test(env.COLORTERM || "")) return 3;
  if (/^(iTerm\.app|WezTerm|ghostty|vscode)$/i.test(env.TERM_PROGRAM || "")) return 3;
  if (/256color/.test(env.TERM || "")) return 2;
  return 1;
}

const LEVEL = detectLevel();
export const interactive = Boolean(out.isTTY);
export const styled = LEVEL > 0;

// Brand ramp — tailwind teal, light to deep. ACCENT matches the player/logo teal.
export const TEAL = [94, 234, 212]; // #5eead4
export const TEAL_DEEP = [20, 184, 166]; // #14b8a6
export const GREEN = [134, 239, 172];
export const YELLOW = [253, 224, 71];
export const RED = [252, 165, 165];
// Logo ramp — the blue→purple sweep of the layered "V" mark (assets/logo-mark.png).
const BRAND_RAMP = [
  [125, 211, 252],
  [96, 165, 250],
  [167, 139, 250],
  [139, 92, 246],
];

function to256([r, g, b]) {
  const v = (c) => Math.round((c / 255) * 5);
  return 16 + 36 * v(r) + 6 * v(g) + v(b);
}

function fgCode(rgb) {
  if (LEVEL >= 3) return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
  if (LEVEL === 2) return `\x1b[38;5;${to256(rgb)}m`;
  return "\x1b[36m"; // basic cyan
}

export function fg(rgb, s) {
  if (!styled) return String(s);
  return `${fgCode(rgb)}${s}\x1b[39m`;
}

export function bold(s) {
  return styled ? `\x1b[1m${s}\x1b[22m` : String(s);
}

export function dim(s) {
  return styled ? `\x1b[2m${s}\x1b[22m` : String(s);
}

export const teal = (s) => fg(TEAL, s);
export const green = (s) => fg(GREEN, s);
export const yellow = (s) => fg(YELLOW, s);
export const red = (s) => fg(RED, s);

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function rampAt(ramp, t) {
  const pos = Math.min(0.9999, Math.max(0, t)) * (ramp.length - 1);
  const i = Math.floor(pos);
  const f = pos - i;
  const [a, b] = [ramp[i], ramp[i + 1]];
  return [lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f)];
}

function rampGradient(ramp, s, fallback) {
  const str = String(s);
  if (!styled) return str;
  if (LEVEL < 2) return fg(fallback, str);
  const chars = [...str];
  const n = Math.max(1, chars.length - 1);
  return (
    chars.map((ch, i) => (ch === " " ? ch : `${fgCode(rampAt(ramp, i / n))}${ch}`)).join("") + "\x1b[39m"
  );
}

// Per-character blue→purple logo gradient for the brand wordmark.
export function brandGradient(s) {
  return rampGradient(BRAND_RAMP, s, TEAL);
}

export function stripAnsi(s) {
  return String(s)
    .replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;]*m/g, "");
}

export function visibleWidth(s) {
  return [...stripAnsi(s)].length;
}

export function truncate(s, max) {
  const str = String(s);
  return [...str].length > max ? [...str].slice(0, max - 1).join("") + "…" : str;
}

// OSC 8 hyperlink — clickable in iTerm/WezTerm/kitty/VS Code, ignored elsewhere.
export function link(url, text = url) {
  if (!styled) return text;
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

export function wordmark(sub = "") {
  const mark = bold(brandGradient("◆ vellum"));
  return `  ${mark}${sub ? `  ${dim(sub)}` : ""}`;
}

// Aligned key/value rows: dim keys padded to the longest, values as given.
export function rows(pairs, { gap = 2 } = {}) {
  const width = Math.max(...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `${dim(k.padEnd(width))}${" ".repeat(gap)}${v}`);
}

// Rounded box around pre-styled lines. When piped (or the terminal is too
// narrow) it degrades to plain indented lines so output stays grep-friendly.
export function box(lines, { indent = "  ", pad = 1 } = {}) {
  const cols = out.columns || 80;
  const width = Math.max(...lines.map(visibleWidth));
  if (!interactive || indent.length + width + 2 * pad + 2 > cols) {
    return lines.map((l) => indent + l).join("\n");
  }
  const edge = fg(TEAL_DEEP, "│");
  const padStr = " ".repeat(pad);
  const top = indent + fg(TEAL_DEEP, `╭${"─".repeat(width + 2 * pad)}╮`);
  const bottom = indent + fg(TEAL_DEEP, `╰${"─".repeat(width + 2 * pad)}╯`);
  const body = lines.map(
    (l) => `${indent}${edge}${padStr}${l}${" ".repeat(width - visibleWidth(l))}${padStr}${edge}`
  );
  return [top, ...body, bottom].join("\n");
}

export function bar(frac, width = 18) {
  const filled = Math.round(Math.min(1, Math.max(0, frac)) * width);
  return teal("█".repeat(filled)) + dim("░".repeat(width - filled));
}

const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Animated spinner on TTYs; a single static line otherwise. stop(finalLine)
// replaces the spinner with the final line.
export function spinner(text) {
  let label = text;
  if (!interactive) {
    console.log(`  ${stripAnsi(label)}`);
    return {
      update(next) {
        label = next;
      },
      stop(finalLine) {
        if (finalLine) console.log(finalLine);
      },
    };
  }
  let i = 0;
  const render = () => out.write(`\r\x1b[K  ${teal(SPIN_FRAMES[i++ % SPIN_FRAMES.length])} ${label}`);
  render();
  const id = setInterval(render, 80);
  return {
    update(next) {
      label = next;
    },
    stop(finalLine) {
      clearInterval(id);
      out.write("\r\x1b[K");
      if (finalLine) console.log(finalLine);
    },
  };
}

export const glyph = {
  ok: green("✓"),
  warn: yellow("!"),
  err: red("✗"),
  add: teal("+"),
  edit: teal("~"),
  del: red("×"),
  music: teal("♪"),
  play: teal("▸"),
  up: teal("↑"),
};
