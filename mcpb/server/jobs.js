// Job records live on disk, not in memory. Claude Desktop can restart, the MCP
// server can be respawned, and the machine can sleep while a 200-track playlist
// is still downloading - a status query after any of those has to still work.

import { readFile, writeFile, readdir, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { jobsDir } from "./paths.js";

/** @typedef {"queued"|"fetching_metadata"|"downloading"|"retrying"|"completed"|"failed"|"cancelled"} JobPhase */

export function newJobId() {
  // Short and case-insensitive: users read these back to Claude out loud.
  return randomUUID().split("-")[0];
}

function jobFile(id) {
  return path.join(jobsDir(), `${id}.json`);
}

export async function createJob(fields) {
  await mkdir(jobsDir(), { recursive: true });
  const job = {
    id: newJobId(),
    phase: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    url: null,
    playlistName: null,
    outputDir: null,
    trackTotal: null,
    trackCount: 0,
    failed: [],
    error: null,
    workerPid: null,
    cancelRequested: false,
    ...fields,
  };
  await saveJob(job);
  return job;
}

// Writes are serialized per job id within this process. The worker's progress
// poller, its final save, and finish() all fire against the same file and can
// overlap; without this they race on the temp path and one rename hits ENOENT.
const writeChains = new Map();
let tmpCounter = 0;

function serialize(id, fn) {
  const prev = writeChains.get(id) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // Keep the chain from growing without bound, and swallow nothing.
  writeChains.set(
    id,
    next.catch(() => {}),
  );
  return next;
}

/**
 * Write via a unique temp file and rename. The status tool reads this file while
 * the worker writes it; a torn read would surface as a JSON parse error
 * mid-download, so the rename has to be the only thing readers ever observe.
 */
export async function saveJob(job) {
  return serialize(job.id, async () => {
    await mkdir(jobsDir(), { recursive: true });
    job.updatedAt = new Date().toISOString();
    const target = jobFile(job.id);
    const tmp = `${target}.${process.pid}.${tmpCounter++}.tmp`;
    await writeFile(tmp, JSON.stringify(job, null, 2));
    await rename(tmp, target);
    return job;
  });
}

/**
 * Read-modify-write against the file on disk rather than an in-memory copy the
 * caller may have been holding for seconds. Use this for every partial update.
 *
 * This is safe for fields only one process writes. It is NOT a cross-process
 * lock: the server and the worker can each read, merge, and rename, and the last
 * rename wins. Any signal that crosses the process boundary must therefore live
 * outside this file - see the cancel marker below.
 */
export async function mergeJob(id, patch) {
  return serialize(id, async () => {
    const current = (await readJobFile(id)) ?? { id };
    const merged = { ...current, ...patch };
    await mkdir(jobsDir(), { recursive: true });
    merged.updatedAt = new Date().toISOString();
    const target = jobFile(id);
    const tmp = `${target}.${process.pid}.${tmpCounter++}.tmp`;
    await writeFile(tmp, JSON.stringify(merged, null, 2));
    await rename(tmp, target);
    return merged;
  });
}

// --- Cancellation ---------------------------------------------------------
//
// Cancellation is a separate marker file, not a field in the job JSON. The
// server writes it and the worker only ever reads it, so there is no
// read-modify-write cycle that can lose the signal. Storing it in the job
// object meant a worker that had read `false` a second earlier would merge that
// stale value straight back over the user's cancel request.

function cancelFile(id) {
  return path.join(jobsDir(), `${id}.cancel`);
}

export async function requestCancel(id) {
  await mkdir(jobsDir(), { recursive: true });
  await writeFile(cancelFile(id), new Date().toISOString());
}

export function isCancelRequested(id) {
  return existsSync(cancelFile(id));
}

async function readJobFile(id) {
  try {
    return JSON.parse(await readFile(jobFile(id), "utf8"));
  } catch {
    return null;
  }
}

export async function loadJob(id) {
  try {
    return JSON.parse(await readFile(jobFile(id), "utf8"));
  } catch {
    return null;
  }
}

export async function updateJob(id, patch) {
  const job = await loadJob(id);
  if (!job) return null;
  return mergeJob(id, patch);
}

export async function listJobs(limit = 20) {
  let names = [];
  try {
    names = await readdir(jobsDir());
  } catch {
    return [];
  }
  const jobs = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const job = await loadJob(path.basename(name, ".json"));
    if (job) jobs.push(job);
  }
  return jobs
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit);
}

/**
 * A job whose worker is gone but that never reached a terminal phase was killed
 * mid-flight (machine restart, force quit). Report it honestly as interrupted
 * rather than leaving it to look like it is still running forever.
 */
export function reconcile(job) {
  const terminal = ["completed", "failed", "cancelled"];
  if (terminal.includes(job.phase)) return job;
  if (!job.workerPid) return job;
  try {
    process.kill(job.workerPid, 0); // signal 0 = liveness probe only
    return job;
  } catch {
    job.phase = "failed";
    job.error =
      "The download stopped unexpectedly, most likely because the computer " +
      "restarted or Claude was force quit. Retry the job to resume.";
    return job;
  }
}
