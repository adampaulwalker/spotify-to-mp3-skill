#!/usr/bin/env node
// Drives the INSTALLED extension end to end, the way Claude Desktop drives it:
// MCP over stdio, real Spotify link, real downloads, then reconciles what the
// job reports against what is actually on disk.
//
// This is criterion C1 in GOAL.md, and it deliberately targets the installed
// copy rather than the source tree. Every "it works" this project has been
// wrong about was a source-tree run standing in for an installed one.
//
//   node scripts/e2e-installed.mjs <spotify-url> [--source]
//
// Credentials come from SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET in the
// environment, which is exactly how manifest.json passes the user's settings
// into the server.

import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLED = path.join(
  os.homedir(),
  "Library/Application Support/Claude/Claude Extensions",
  "local.mcpb.adam-walker.spotify-playlist-downloader",
);

const useSource = process.argv.includes("--source");
const url = process.argv.find((a) => a.startsWith("http"));
if (!url) {
  console.error("usage: node scripts/e2e-installed.mjs <spotify-url> [--source]");
  process.exit(2);
}

const base = useSource ? ROOT : INSTALLED;
const serverPath = path.join(base, "server", "index.js");
console.log(`driving: ${serverPath}\n`);

const AUDIO = new Set([".mp3", ".m4a", ".opus", ".flac"]);
let pass = 0,
  fail = 0;
const check = (label, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
};

const server = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});
server.stderr.on("data", (c) => {
  const s = String(c).trim();
  if (s) console.log(`  [server] ${s.slice(0, 200)}`);
});

let buffer = "";
const pending = new Map();
server.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const r = pending.get(msg.id);
    if (r) {
      pending.delete(msg.id);
      r(msg);
    }
  }
});

let nextId = 1;
function rpc(method, params = {}, timeoutMs = 120000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const done = (m) => {
      clearTimeout(t);
      resolve(m);
    };
    pending.set(id, done);
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const callTool = async (name, args = {}, timeoutMs = 120000) => {
  const res = await rpc("tools/call", { name, arguments: args }, timeoutMs);
  return res.result?.content?.[0]?.text ?? JSON.stringify(res.result ?? res.error);
};

async function countAudio(dir) {
  let n = 0;
  const names = [];
  try {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isFile() && AUDIO.has(path.extname(e.name).toLowerCase())) {
        const s = await stat(path.join(dir, e.name));
        // A zero-byte or near-empty file is a failed download that still counts
        // in a naive listing. Only real audio counts here.
        if (s.size > 100 * 1024) {
          n++;
          names.push(`${e.name} (${(s.size / 1048576).toFixed(1)}MB)`);
        }
      }
    }
  } catch {
    /* dir may not exist yet */
  }
  return { n, names };
}

try {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "e2e", version: "1" },
  });
  const tools = await rpc("tools/list");
  const names = (tools.result?.tools ?? []).map((t) => t.name);
  check("server exposes its tools", names.length >= 5, names.join(", "));
  check("start_playlist_download present", names.includes("start_playlist_download"));

  console.log("\n=== starting the download ===");
  const started = await callTool("start_playlist_download", { url });
  console.log(`  ${started.split("\n")[0].slice(0, 140)}`);
  const jobId = /\b([a-z0-9]{6,})\b/.exec(started.match(/job id[: ]+(\S+)/i)?.[1] ?? "")?.[1]
    ?? started.match(/`([^`]+)`/)?.[1]
    ?? null;

  const listed = await callTool("list_download_jobs");
  const id = jobId ?? /([0-9a-z]{8,})/.exec(listed)?.[1];
  check("a job id was returned", Boolean(id), String(id));

  console.log("\n=== polling to completion ===");
  const t0 = Date.now();
  let status = "";
  let outputDir = null;
  let lastPrint = "";
  const DEADLINE_MS = 45 * 60 * 1000;

  while (Date.now() - t0 < DEADLINE_MS) {
    status = await callTool("get_download_status", id ? { job_id: id } : {});
    // Read the folder to end-of-line. An earlier version stopped at the first
    // space and turned "/Users/adam/Downloads/Demon slayer intro theme" into
    // "/Users/adam/Downloads/Demon", then reported zero files - the same
    // path-with-spaces mistake that produced a false "0 files" report earlier
    // in this project.
    const folder = /^Folder:[ \t]*(.+?)[ \t]*$/m.exec(status)?.[1];
    if (folder) outputDir = folder;
    const line = status.split("\n").find((l) => l.trim()) ?? "";
    if (line !== lastPrint) {
      console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] ${line.slice(0, 130)}`);
      lastPrint = line;
    }
    if (/\b(completed|finished|done)\b/i.test(status) && !/downloading/i.test(status)) break;
    if (/\b(failed|error|cancelled)\b/i.test(status)) break;
    await new Promise((r) => setTimeout(r, 10000));
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`\n=== final status after ${elapsed}s ===\n${status.slice(0, 900)}\n`);

  check("the job reached a terminal state", /completed|finished|failed|cancelled/i.test(status));
  check("it did not fail", !/\bfailed\b/i.test(status), status.slice(0, 100));

  // Reconcile the reported count against the filesystem. This is the whole
  // point of C1: "23 files reported" has been wrong before, in both directions.
  // "Downloaded: 2 of 3 (67%)" is the shape the status actually prints. The
  // first version of this guessed at the wording and silently parsed nothing.
  const m = /^Downloaded:[ \t]*(\d+)[ \t]*of[ \t]*(\d+)/m.exec(status);
  const reported = m ? Number(m[1]) : NaN;
  const total = m ? Number(m[2]) : NaN;
  const unavailable = (status.match(/^ +- /gm) ?? []).length;

  if (outputDir) {
    const { n, names: files } = await countAudio(outputDir);
    console.log(`  folder: ${outputDir}`);
    files.forEach((f) => console.log(`    ${f}`));

    check("a count was reported", Number.isFinite(reported), status.slice(0, 80));
    check("audio files are on disk", n > 0, `${n} file(s)`);
    check(
      "reported count matches disk",
      reported === n,
      `reported ${reported}, disk ${n}`,
    );
    // A track missing from every source is a real outcome, not a bug - but it
    // has to be accounted for, or a silent shortfall reads as success.
    check(
      "every track is accounted for",
      reported + unavailable === total,
      `${reported} downloaded + ${unavailable} unavailable = ${reported + unavailable}, expected ${total}`,
    );
  } else {
    check("an output folder was reported", false, "no Folder: line in the status text");
  }
} catch (err) {
  check("the run completed without throwing", false, String(err?.message).slice(0, 120));
} finally {
  server.kill();
}

console.log("\n" + "=".repeat(46));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
