#!/usr/bin/env node
// Fault injection. Every defect this week lived on a failure path, and every
// test so far only exercised the happy one.
//
// Each case forces a specific failure and asserts the product reports it in a
// way a non-technical person can act on. Silence, a stack trace, or a stale
// count all count as a failure of the case.
//
//   node scripts/fault-tests.mjs

import { spawn } from "node:child_process";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JOBS = path.join(
  os.homedir(),
  "Library/Application Support/SpotifyPlaylistDownloader/jobs",
);

let pass = 0,
  fail = 0;
const results = [];

function check(label, ok, detail = "") {
  ok ? pass++ : fail++;
  results.push(`${ok ? "PASS" : "FAIL"}  ${label}`);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
}

// --- MCP client plumbing --------------------------------------------------

function startServer() {
  const server = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const pending = new Map();
  server.stdout.on("data", (c) => {
    buffer += c.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        const r = pending.get(m.id);
        if (r) {
          pending.delete(m.id);
          r(m);
        }
      } catch {
        /* not json */
      }
    }
  });
  let id = 1;
  const request = (method, params = {}, ms = 90000) =>
    new Promise((res, rej) => {
      const myId = id++;
      pending.set(myId, res);
      server.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n",
      );
      setTimeout(() => rej(new Error(`timeout ${method}`)), ms);
    });
  return { server, request };
}

const callText = async (request, name, args = {}) =>
  (await request("tools/call", { name, arguments: args })).result?.content?.[0]
    ?.text ?? "";

/** A message a non-technical person can act on: no stack traces, no jargon. */
function isLegible(msg) {
  if (!msg || msg.length < 15) return false;
  const jargon = [
    /\bat [A-Za-z]+\.[a-z]+ \(/, // stack frame
    /node:internal/,
    /Error: connect E/,
    /undefined is not/,
    /Cannot read propert/,
    /\bENOENT\b/,
    /Traceback/,
  ];
  return !jargon.some((p) => p.test(msg));
}

// --- Cases ----------------------------------------------------------------

const { server, request } = startServer();
await request("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "fault", version: "0" },
});
server.stdin.write(
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
);

console.log("\n=== Bad input ===");
for (const [label, url] of [
  ["empty url", ""],
  ["not a url", "hello"],
  ["wrong site", "https://music.apple.com/playlist/123"],
  ["spotify but malformed", "https://open.spotify.com/nonsense/abc"],
  ["url with injection chars", 'https://open.spotify.com/playlist/x"; rm -rf /'],
]) {
  const out = await callText(request, "start_playlist_download", { url });
  check(
    `rejects ${label}`,
    /does not look like|not a Spotify/i.test(out) && isLegible(out),
    out.slice(0, 60),
  );
}

console.log("\n=== Missing or unknown jobs ===");
for (const [label, tool] of [
  ["status", "get_download_status"],
  ["cancel", "cancel_download"],
  ["open folder", "open_output_folder"],
  ["show progress", "show_progress"],
]) {
  const out = await callText(request, tool, { job_id: "doesnotexist" });
  check(`${label} on unknown id is legible`, isLegible(out) && /No job|no job/i.test(out), out.slice(0, 50));
}

console.log("\n=== A job whose worker died (the hang scenario) ===");
await mkdir(JOBS, { recursive: true });
const deadId = "faulttest1";
await writeFile(
  path.join(JOBS, `${deadId}.json`),
  JSON.stringify(
    {
      id: deadId,
      phase: "downloading",
      url: "https://open.spotify.com/playlist/test",
      playlistName: "Fault Test",
      trackCount: 12,
      trackTotal: 40,
      // A pid that cannot be alive, standing in for a worker killed mid-run.
      workerPid: 999999,
      createdAt: new Date(Date.now() - 3600e3).toISOString(),
      updatedAt: new Date(Date.now() - 3600e3).toISOString(),
      failed: [],
    },
    null,
    2,
  ),
);
const deadOut = await callText(request, "get_download_status", { job_id: deadId });
check(
  "dead worker reported, not shown as running",
  /stopped|interrupt|fail/i.test(deadOut),
  deadOut.split("\n")[0],
);
check("dead worker message is legible", isLegible(deadOut));

console.log("\n=== A job that is alive but silent (stall detection) ===");
const staleId = "faulttest2";
await writeFile(
  path.join(JOBS, `${staleId}.json`),
  JSON.stringify(
    {
      id: staleId,
      phase: "fetching_metadata",
      url: "https://open.spotify.com/playlist/test",
      playlistName: "Stale Test",
      trackCount: 0,
      trackTotal: null,
      workerPid: process.pid, // alive, so reconcile() will not flag it
      createdAt: new Date(Date.now() - 40 * 60e3).toISOString(),
      updatedAt: new Date(Date.now() - 40 * 60e3).toISOString(),
      failed: [],
    },
    null,
    2,
  ),
);
const staleOut = await callText(request, "get_download_status", { job_id: staleId });
check(
  "long-running job reports elapsed time",
  /Running for|min|hour/i.test(staleOut),
  staleOut.split("\n").find((l) => /Running for/.test(l)) ?? "",
);
check(
  "silent metadata phase is explained, not left ambiguous",
  /quiet by design|no files|reading the track list/i.test(staleOut),
);

console.log("\n=== Progress reporting ===");
const progId = "faulttest3";
await writeFile(
  path.join(JOBS, `${progId}.json`),
  JSON.stringify(
    {
      id: progId,
      phase: "downloading",
      url: "https://open.spotify.com/playlist/test",
      playlistName: "Progress Test",
      trackCount: 47,
      trackTotal: 116,
      workerPid: process.pid,
      createdAt: new Date(Date.now() - 600e3).toISOString(),
      updatedAt: new Date().toISOString(),
      failed: [],
    },
    null,
    2,
  ),
);
const progOut = await callText(request, "get_download_status", { job_id: progId });
check("shows a visual progress bar", /[█░]{10,}/.test(progOut));
check("shows counts", /47 of 116/.test(progOut));
check("estimates time remaining", /remaining/i.test(progOut));

console.log("\n=== Setup diagnostics ===");
const setup = await callText(request, "check_setup");
check("check_setup executes engines", /OK\s+spotdl|MISSING|FAILED/.test(setup));
check("check_setup names the save location", /Downloads/.test(setup));
check("check_setup output is legible", isLegible(setup));

// --- Cleanup --------------------------------------------------------------
for (const id of [deadId, staleId, progId]) {
  await rm(path.join(JOBS, `${id}.json`), { force: true });
}
server.kill();

console.log("\n" + "=".repeat(46));
console.log(`${pass} passed, ${fail} failed`);
if (fail) {
  console.log("\nFailures:");
  results.filter((r) => r.startsWith("FAIL")).forEach((r) => console.log("  " + r));
}
process.exit(fail ? 1 : 0);
