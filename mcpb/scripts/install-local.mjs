#!/usr/bin/env node
// Deterministic local install, for the test loop.
//
// The GUI flow (`open -a Claude bundle.mcpb`) is not reliable enough to drive a
// test loop: it silently does nothing when Claude Desktop has no window open,
// and it refuses to replace an install of the same version while showing a
// dialog that looks like success. Neither is a product bug - a human clicking
// once hits neither - but a loop that reinstalls on every iteration cannot
// depend on it.
//
// This writes the same three pieces of state the GUI writes, verified against a
// GUI-installed extension:
//   Claude Extensions/<id>/                       the unpacked bundle
//   Claude Extensions Settings/<id>.json          {"isEnabled": true}
//   extensions-installations.json                 the registry entry
//
//   node scripts/install-local.mjs [path-to.mcpb]

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = path.join(os.homedir(), "Library/Application Support/Claude");
const REGISTRY = path.join(BASE, "extensions-installations.json");

const bundle =
  process.argv[2] ??
  (() => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
    return path.join(ROOT, `spotify-playlist-downloader-${manifest.version}.mcpb`);
  })();

if (!existsSync(bundle)) {
  console.error(`bundle not found: ${bundle}`);
  process.exit(1);
}

const manifest = JSON.parse(
  execFileSync("unzip", ["-p", bundle, "manifest.json"], { encoding: "utf8" }),
);
const id = `local.mcpb.${(manifest.author?.name ?? "unknown")
  .toLowerCase()
  .replace(/\s+/g, "-")}.${manifest.name}`;
const dest = path.join(BASE, "Claude Extensions", id);

// Refuse to install a bundle whose archive is damaged. A truncated download
// installs without complaint and fails later on the user's machine.
try {
  execFileSync("unzip", ["-t", bundle], { stdio: "ignore" });
} catch {
  console.error("bundle is not a complete archive - refusing to install");
  process.exit(1);
}

console.log(`installing ${path.basename(bundle)}  (${id})`);

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
execFileSync("unzip", ["-qo", bundle, "-d", dest]);

// Merge, never overwrite. This file holds the user's saved settings - including
// the Spotify credentials they typed into the extension's own settings panel.
// Writing {"isEnabled": true} over it silently wiped them, so every reinstall
// looked fine and then failed to authenticate for a reason nothing explained.
const settingsDir = path.join(BASE, "Claude Extensions Settings");
mkdirSync(settingsDir, { recursive: true });
const settingsFile = path.join(settingsDir, `${id}.json`);
let settings = {};
if (existsSync(settingsFile)) {
  try {
    settings = JSON.parse(readFileSync(settingsFile, "utf8"));
  } catch {
    settings = {}; // unreadable, so there is nothing to preserve
  }
}
const keptKeys = Object.keys(settings.userConfig ?? {});
writeFileSync(settingsFile, JSON.stringify({ ...settings, isEnabled: true }, null, 2));
if (keptKeys.length) console.log(`  kept user settings: ${keptKeys.join(", ")}`);

const registry = JSON.parse(readFileSync(REGISTRY, "utf8"));
registry.extensions ??= {};
registry.extensions[id] = {
  id,
  version: manifest.version,
  hash: createHash("sha256").update(readFileSync(bundle)).digest("hex"),
  installedAt: new Date().toISOString(),
  manifest,
  signatureInfo: { status: "valid" },
  source: "local",
};
writeFileSync(REGISTRY, JSON.stringify(registry, null, 2));

// Verify against source rather than trusting the copy. Every install this week
// that "looked fine" was checked by hash before it was believed.
let stale = 0;
for (const f of [
  "server/index.js",
  "server/worker.js",
  "server/paths.js",
  "server/jobs.js",
  "server/spotify.js",
  "manifest.json",
]) {
  const a = createHash("sha256").update(readFileSync(path.join(dest, f))).digest("hex");
  const b = createHash("sha256").update(readFileSync(path.join(ROOT, f))).digest("hex");
  const ok = a === b;
  if (!ok) stale++;
  console.log(`  ${ok ? "MATCH" : "STALE"}  ${f}`);
}

console.log(`\ninstalled ${manifest.version} at ${dest}`);
console.log("Claude Desktop must be restarted to load it.");
process.exit(stale ? 1 : 0);
