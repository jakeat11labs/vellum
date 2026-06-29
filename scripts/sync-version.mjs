#!/usr/bin/env node
// @ts-check
// Keep scripts/vellum-shared.mjs's VERSION constant in lockstep with package.json.
//
// The release workflow (.github/workflows/release.yml) refuses to publish unless the
// git tag, package.json version, and this constant all match — they used to drift
// because releases hand-edit package.json. Wired as the npm `version` lifecycle
// script, so `npm version patch|minor|major` syncs (and stages) the constant before
// npm makes the version commit. The smoke test asserts the two agree as a backstop.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHARED = path.join(REPO, "scripts", "vellum-shared.mjs");

const version = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version;
const src = fs.readFileSync(SHARED, "utf8");

const VERSION_LINE = /export const VERSION = "[^"]*";/;
if (!VERSION_LINE.test(src)) {
  console.error(`sync-version: no \`export const VERSION = "..."\` line found in ${SHARED}`);
  process.exit(1);
}

const next = src.replace(VERSION_LINE, `export const VERSION = "${version}";`);
if (next === src) {
  console.log(`sync-version: vellum-shared.mjs already at ${version}`);
} else {
  fs.writeFileSync(SHARED, next);
  console.log(`sync-version: vellum-shared.mjs VERSION → ${version}`);
}
