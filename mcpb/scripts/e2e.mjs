#!/usr/bin/env node
// End-to-end test against a real Spotify URL, driven through the MCP server the
// way Claude Desktop drives it. Downloads one track, polls to completion, then
// checks the files that actually landed on disk.
//
//   node scripts/e2e.mjs [spotify-url]

import { spawn } from "node:child_process";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const URL_ARG =
  process.argv[2] || "https://open.spotify.com/track/4wajJ1o7jWIg62YqpkHC7S";

const server = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
  stdio: ["pipe", "pipe", "pipe"],
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
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});
server.stderr.on("data", (c) => process.stderr.write(`  [server] ${c}`));

let nextId = 1;
function request(method, params = {}, timeoutMs = 90000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    server.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
    );
    setTimeout(() => reject(new Error(`timeout: ${method}`)), timeoutMs);
  });
}
const callText = async (name, args = {}) =>
  (await request("tools/call", { name, arguments: args })).result?.content?.[0]
    ?.text ?? "";

let failures = 0;
function check(label, ok, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
}

await request("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "e2e", version: "0" },
});
server.stdin.write(
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
);

console.log(`\nDownloading: ${URL_ARG}\n`);
const started = await callText("start_playlist_download", { url: URL_ARG });
const jobId = started.match(/Job id: (\w+)/)?.[1];
check("job started", !!jobId, jobId);
if (!jobId) {
  console.log(started);
  process.exit(1);
}

// Poll to a terminal phase rather than sleeping a fixed amount - the whole point
// of the job model is that the caller does not know how long this takes.
//
// 25 minutes, not 7. A 10-track album took under 5 minutes on a fast connection
// and over 20 through a VPN, and the short deadline reported three separate
// "failures" for runs that were downloading correctly the whole time. A test
// that calls working software broken is worse than no test.
let status = "";
const deadline = Date.now() + 25 * 60 * 1000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 5000));
  status = await callText("get_download_status", { job_id: jobId });
  const phase = status.match(/- (\w+)/)?.[1];
  process.stdout.write(`\r  phase: ${phase ?? "?"}          `);
  if (["completed", "failed", "cancelled"].includes(phase ?? "")) break;
}
console.log("\n");
console.log(
  status
    .split("\n")
    .map((l) => `      ${l}`)
    .join("\n"),
);

check("reached completed", /- completed/.test(status));

const folder = status.match(/Folder: (.+)/)?.[1]?.trim();
check("reported an output folder", !!folder, folder);

if (folder) {
  const names = await readdir(folder).catch(() => []);
  const audio = names.filter((n) => /\.(mp3|m4a|flac|opus)$/i.test(n));
  check("at least one audio file on disk", audio.length > 0, audio.join(", "));

  // The filename template is the fix for miscounting; confirm it produced
  // something sane rather than a name starting with "None - ".
  check(
    "filename is not malformed",
    audio.every((n) => !/^(None|undefined|\s*-)/.test(n)),
    audio[0] ?? "",
  );

  const report = await readFile(
    path.join(folder, "download-report.txt"),
    "utf8",
  ).catch(() => "");
  check("report written", report.length > 0);
  if (report) {
    console.log(
      report
        .split("\n")
        .map((l) => `      ${l}`)
        .join("\n"),
    );
  }

  if (process.argv.includes("--clean")) {
    await rm(folder, { recursive: true, force: true });
    console.log(`\n  cleaned up ${folder}`);
  }
}

server.kill();
console.log(failures ? `\n${failures} check(s) failed` : "\nend-to-end passed");
process.exit(failures ? 1 : 0);
