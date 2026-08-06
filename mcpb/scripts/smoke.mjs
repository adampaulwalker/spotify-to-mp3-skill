#!/usr/bin/env node
// Speaks MCP over stdio to server/index.js the way Claude Desktop does, so a
// protocol-level break is caught here rather than after packing and installing.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
// check_setup really executes each engine, and spotdl is a PyInstaller bundle
// that unpacks itself on a cold start, so the ceiling has to clear that.
function request(method, params = {}, timeoutMs = 90000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    server.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
    );
    setTimeout(
      () => reject(new Error(`timeout waiting for ${method}`)),
      timeoutMs,
    );
  });
}

let failures = 0;
function check(label, condition, detail = "") {
  const mark = condition ? "PASS" : "FAIL";
  if (!condition) failures++;
  console.log(`  ${mark}  ${label}${detail ? ` - ${detail}` : ""}`);
}

const init = await request("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke", version: "0" },
});
check("initialize", !!init.result, init.result?.serverInfo?.name);

server.stdin.write(
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
);

const tools = await request("tools/list");
const names = (tools.result?.tools || []).map((t) => t.name);
// Named, not just counted. A bare count passes when a tool is swapped for
// another, and it fails noisily for the harmless case of adding one.
for (const t of [
  "start_playlist_download",
  "get_download_status",
  "list_download_jobs",
  "cancel_download",
  "open_output_folder",
  "show_progress",
  "watch_download",
  "check_setup",
]) {
  check(`tools/list exposes ${t}`, names.includes(t));
}

const setup = await request("tools/call", {
  name: "check_setup",
  arguments: {},
});
const setupText = setup.result?.content?.[0]?.text || "";
check("check_setup finds all engines", !setupText.includes("MISSING"));
console.log(
  setupText
    .split("\n")
    .map((l) => `      ${l}`)
    .join("\n"),
);

// A bad URL must be refused before any job is created, or a typo silently
// spawns a worker that fails minutes later with nothing useful to show.
const bad = await request("tools/call", {
  name: "start_playlist_download",
  arguments: { url: "https://example.com/not-spotify" },
});
check(
  "rejects a non-Spotify URL",
  (bad.result?.content?.[0]?.text || "").includes("does not look like"),
);

const jobs = await request("tools/call", {
  name: "list_download_jobs",
  arguments: {},
});
check("list_download_jobs responds", !!jobs.result);

const missing = await request("tools/call", {
  name: "get_download_status",
  arguments: { job_id: "nope" },
});
check(
  "unknown job id handled",
  (missing.result?.content?.[0]?.text || "").includes("No job"),
);

server.kill();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
