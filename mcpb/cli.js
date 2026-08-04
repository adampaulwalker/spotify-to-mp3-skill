#!/usr/bin/env node
// Command-line front door to the same worker the Claude Desktop extension uses.
//
//   node cli.js <spotify-url> [--format mp3|m4a|flac] [--out DIR] [--watch]
//   node cli.js --status <jobId>
//   node cli.js --list
//
// Same engines, same job records, same output. The only difference is that
// nothing sits between you and your own software.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJob, loadJob, listJobs, reconcile, requestCancel } from "./server/jobs.js";
import { defaultOutputRoot, enginePath, unsupportedPlatformReason } from "./server/paths.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, "server", "worker.js");

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const SPOTIFY_URL =
  /^https?:\/\/open\.spotify\.com\/(intl-[a-z]{2}\/)?(playlist|album|track)\/[A-Za-z0-9]+/;

function describe(job) {
  const j = reconcile(job);
  const pct = j.trackTotal ? ` (${Math.round((j.trackCount / j.trackTotal) * 100)}%)` : "";
  const missing =
    typeof j.trackTotal === "number" ? Math.max(0, j.trackTotal - j.trackCount) : 0;
  const lines = [
    `${j.id}  ${j.phase}`,
    `  ${j.playlistName || j.url}`,
    `  ${j.trackCount}${j.trackTotal ? ` of ${j.trackTotal}` : ""}${pct}`,
  ];
  if (j.outputDir) lines.push(`  ${j.outputDir}`);
  if (j.error) lines.push(`  error: ${j.error}`);
  if (j.phase === "completed" && missing > 0) {
    lines.push(`  ${missing} track(s) unavailable:`);
    for (const f of (j.failed ?? []).slice(0, 20)) lines.push(`    - ${f.name}`);
  }
  return lines.join("\n");
}

// --- subcommands ----------------------------------------------------------

if (has("list")) {
  const jobs = await listJobs();
  if (!jobs.length) console.log("no jobs yet");
  for (const j of jobs) {
    const r = reconcile(j);
    console.log(
      `${r.id}  ${r.phase.padEnd(18)} ${String(r.trackCount).padStart(3)}${r.trackTotal ? `/${r.trackTotal}` : ""}  ${r.playlistName || r.url}`,
    );
  }
  process.exit(0);
}

if (has("status")) {
  const job = await loadJob(flag("status"));
  console.log(job ? describe(job) : `no job ${flag("status")}`);
  process.exit(job ? 0 : 1);
}

if (has("cancel")) {
  const id = flag("cancel");
  const job = await loadJob(id);
  if (!job) { console.error(`no job ${id}`); process.exit(1); }
  await requestCancel(id);
  console.log(`cancelling ${id}; files already downloaded are kept`);
  process.exit(0);
}

// --- start a download -----------------------------------------------------

const url = argv.find((a) => !a.startsWith("--") && SPOTIFY_URL.test(a));
if (!url) {
  console.error(`usage: node cli.js <spotify-url> [--format mp3|m4a|flac] [--out DIR] [--watch]
       node cli.js --list
       node cli.js --status <jobId>
       node cli.js --cancel <jobId>`);
  process.exit(2);
}

const blocked = unsupportedPlatformReason();
if (blocked) { console.error(blocked); process.exit(1); }
for (const bin of ["spotdl", "ffmpeg"]) {
  if (!enginePath(bin)) {
    console.error(`bundled ${bin} is missing. Run: node scripts/fetch-binaries.mjs`);
    process.exit(1);
  }
}

const job = await createJob({
  url,
  format: flag("format", "mp3"),
  outputRoot: flag("out", defaultOutputRoot()),
});

// Detached so a long download survives closing the terminal. --watch just
// tails the job file; killing the watcher does not kill the download.
const child = spawn(process.execPath, [WORKER, job.id], {
  detached: true,
  stdio: "ignore",
  env: process.env,
});
child.unref();

console.log(`job ${job.id} started`);
console.log(`  ${url}`);
console.log(`  files land in ${flag("out", defaultOutputRoot())}`);
console.log(`\n  node cli.js --status ${job.id}`);
console.log(`  node cli.js --cancel ${job.id}`);

if (!has("watch")) process.exit(0);

// --- watch mode -----------------------------------------------------------

console.log("\nwatching (ctrl-c to stop watching; the download keeps going)\n");
let lastLine = "";
const timer = setInterval(async () => {
  const j = await loadJob(job.id);
  if (!j) return;
  const line = `  ${j.phase.padEnd(18)} ${j.trackCount}${j.trackTotal ? `/${j.trackTotal}` : ""}`;
  if (line !== lastLine) {
    process.stdout.write(`\r${line.padEnd(60)}`);
    lastLine = line;
  }
  if (["completed", "failed", "cancelled"].includes(j.phase)) {
    clearInterval(timer);
    console.log("\n");
    console.log(describe(j));
    process.exit(j.phase === "completed" ? 0 : 1);
  }
}, 3000);
