#!/usr/bin/env node
// Vendors the pinned engine binaries into vendor/<platform>/.
// Every artifact is version-pinned and checksum-verified: an unpinned engine
// means a bundle that silently changes behaviour between builds.
//
//   node scripts/fetch-binaries.mjs            # current platform
//   node scripts/fetch-binaries.mjs --all      # every supported platform

import { createWriteStream } from "node:fs";
import { mkdir, chmod, rm, stat, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = path.join(ROOT, "vendor");

const SPOTDL_VERSION = "4.5.2";
const YTDLP_VERSION = "2026.07.04";

// ffmpeg comes from npm rather than a scraped download page: the @ffmpeg-installer
// packages are versioned, immutable on the registry, and resolve per platform.
// The published version differs per platform package, so it is pinned per target
// rather than globally - darwin-arm64 only ships 4.1.5, the others stop at 4.1.0.
const TARGETS = {
  "darwin-arm64": {
    spotdl: `https://github.com/spotDL/spotify-downloader/releases/download/v${SPOTDL_VERSION}/spotdl-${SPOTDL_VERSION}-darwin`,
    ytdlp: `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_macos`,
    ffmpegPkg: "@ffmpeg-installer/darwin-arm64",
    ffmpegVersion: "4.1.5",
  },
  "darwin-x64": {
    spotdl: `https://github.com/spotDL/spotify-downloader/releases/download/v${SPOTDL_VERSION}/spotdl-${SPOTDL_VERSION}-darwin`,
    ytdlp: `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_macos`,
    ffmpegPkg: "@ffmpeg-installer/darwin-x64",
    ffmpegVersion: "4.1.0",
  },
  "win32-x64": {
    spotdl: `https://github.com/spotDL/spotify-downloader/releases/download/v${SPOTDL_VERSION}/spotdl-${SPOTDL_VERSION}-win32.exe`,
    ytdlp: `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp.exe`,
    ffmpegPkg: "@ffmpeg-installer/win32-x64",
    ffmpegVersion: "4.1.0",
  },
};

const LOCKFILE = path.join(ROOT, "vendor", "binaries.lock.json");

async function sha256(file) {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return hash.digest("hex");
}

async function download(url, dest) {
  process.stderr.write(`  fetching ${path.basename(dest)} ... `);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  await pipeline(res.body, createWriteStream(dest));
  const { size } = await stat(dest);
  process.stderr.write(`${(size / 1024 / 1024).toFixed(1)} MB\n`);
}

// The ffmpeg binary is extracted from an npm tarball rather than installed as a
// dependency, so the bundle carries only the executable and not a node_modules tree.
async function fetchFfmpeg(pkg, version, destDir, isWindows) {
  process.stderr.write(`  fetching ffmpeg (${pkg}@${version}) ... `);
  const tmp = path.join(destDir, ".ffmpeg-tmp");
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  const { stdout } = await execFileAsync("npm", [
    "pack",
    `${pkg}@${version}`,
    "--pack-destination",
    tmp,
    "--silent",
  ]);
  const tarball = path.join(tmp, stdout.trim().split("\n").pop());
  await execFileAsync("tar", ["-xzf", tarball, "-C", tmp]);
  const binName = isWindows ? "ffmpeg.exe" : "ffmpeg";
  const src = path.join(tmp, "package", binName);
  const dest = path.join(destDir, binName);
  await execFileAsync("cp", [src, dest]);
  await rm(tmp, { recursive: true, force: true });
  const { size } = await stat(dest);
  process.stderr.write(`${(size / 1024 / 1024).toFixed(1)} MB\n`);
  return dest;
}

async function fetchTarget(key) {
  const target = TARGETS[key];
  if (!target) throw new Error(`unknown target ${key}`);
  const isWindows = key.startsWith("win32");
  const dir = path.join(VENDOR, key);
  await mkdir(dir, { recursive: true });
  process.stderr.write(`${key}\n`);

  const spotdlPath = path.join(dir, isWindows ? "spotdl.exe" : "spotdl");
  const ytdlpPath = path.join(dir, isWindows ? "yt-dlp.exe" : "yt-dlp");
  await download(target.spotdl, spotdlPath);
  await download(target.ytdlp, ytdlpPath);
  const ffmpegPath = await fetchFfmpeg(
    target.ffmpegPkg,
    target.ffmpegVersion,
    dir,
    isWindows,
  );

  if (!isWindows) {
    for (const f of [spotdlPath, ytdlpPath, ffmpegPath]) await chmod(f, 0o755);
  }

  return {
    spotdl: { version: SPOTDL_VERSION, sha256: await sha256(spotdlPath) },
    ytdlp: { version: YTDLP_VERSION, sha256: await sha256(ytdlpPath) },
    ffmpeg: {
      version: target.ffmpegVersion,
      sha256: await sha256(ffmpegPath),
    },
  };
}

// Explicit targets can be named so a Mac can vendor the Intel build it cannot
// itself run: node scripts/fetch-binaries.mjs darwin-arm64 darwin-x64
const args = process.argv.slice(2);
const named = args.filter((a) => !a.startsWith("--"));
const keys = args.includes("--all")
  ? Object.keys(TARGETS)
  : named.length
    ? named
    : [`${process.platform}-${process.arch}`];

let lock = {};
try {
  lock = JSON.parse(await readFile(LOCKFILE, "utf8"));
} catch {
  /* first run */
}

for (const key of keys) {
  lock[key] = await fetchTarget(key);
}

await mkdir(path.dirname(LOCKFILE), { recursive: true });
await writeFile(LOCKFILE, JSON.stringify(lock, null, 2) + "\n");
process.stderr.write(`\nwrote ${path.relative(ROOT, LOCKFILE)}\n`);
