#!/usr/bin/env node
// Detached download worker. Spawned by the MCP server and then orphaned on
// purpose, so the download survives Claude Desktop restarting or the stdio
// server being respawned. Communicates only through the job file on disk.
//
//   node worker.js <jobId>

import { spawn } from "node:child_process";
import { mkdir, readdir, writeFile, appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import {
  enginePath,
  defaultOutputRoot,
  sanitizeFolderName,
  appDataDir,
  IS_WINDOWS,
} from "./paths.js";
import { loadJob, mergeJob, isCancelRequested } from "./jobs.js";

const AUDIO_EXTS = new Set([".mp3", ".m4a", ".opus", ".flac"]);
const POLL_MS = 4000;

// The leading list position is not decoration. Without it, two tracks with the
// same artist and title - a clean and an explicit cut, or the same song on two
// albums - collapse onto one filename, so the file count undershoots and the
// report invents missing tracks that actually downloaded. It also preserves
// playlist order in the folder, which is what someone browsing it expects.
//
// Which numbering variable applies depends on the link type, verified by
// running each one rather than assumed: {list-position} is populated only for
// playlists, and is empty for both albums and single tracks, where it yields a
// filename beginning " - ". Albums carry {track-number} instead, and a lone
// track cannot collide with itself so it needs no prefix at all.
const TEMPLATES = {
  playlist: "{list-position} - {artists} - {title}.{output-ext}",
  album: "{track-number} - {artists} - {title}.{output-ext}",
  track: "{artists} - {title}.{output-ext}",
};

function outputTemplate(url) {
  const kind = url.match(
    /open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(playlist|album|track)\//,
  )?.[1];
  return TEMPLATES[kind] ?? TEMPLATES.track;
}

const jobId = process.argv[2];
if (!jobId) {
  process.stderr.write("worker: missing job id\n");
  process.exit(2);
}

const logPath = path.join(appDataDir(), "logs", `${jobId}.log`);

async function log(line) {
  await mkdir(path.dirname(logPath), { recursive: true });
  await appendFile(logPath, `[${new Date().toISOString()}] ${line}\n`);
}

/** Count finished audio files, ignoring the partial files engines leave behind. */
async function countAudioFiles(dir) {
  try {
    const names = await readdir(dir);
    return names.filter((n) => {
      const lower = n.toLowerCase();
      if (lower.endsWith(".part") || lower.endsWith(".temp")) return false;
      return AUDIO_EXTS.has(path.extname(lower));
    }).length;
  } catch {
    return 0;
  }
}

let currentChild = null;

/**
 * Kill the whole process tree, not just the process we spawned. spotDL forks
 * ffmpeg and download workers; SIGTERM to the parent alone leaves those running
 * and the job reports cancelled while the machine keeps downloading.
 */
function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    if (IS_WINDOWS) {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } else {
      // Negative pid targets the process group created by detached: true.
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/**
 * Run an engine to completion. Resolves with the exit code and the tail of its
 * output; never rejects on a non-zero exit, because the caller has to decide
 * whether a given code means "some tracks missing" or "nothing worked".
 */
function run(bin, args, { onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group so killTree can take the children with it.
      detached: !IS_WINDOWS,
    });
    currentChild = child;

    const tail = [];
    let buffered = "";

    const handle = (chunk) => {
      buffered += chunk.toString();
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        log(line).catch(() => {});
        tail.push(line);
        if (tail.length > 40) tail.shift();
        onLine?.(line);
      }
    };

    child.stdout.on("data", handle);
    child.stderr.on("data", handle);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      currentChild = null;
      resolve({ code, signal, tail: tail.join("\n") });
    });
  });
}

/**
 * Cancellation arrives as a marker file written by the server process. Watch it
 * for the whole run, not just the download phase - a long metadata fetch on a
 * 500-track playlist would otherwise be uncancellable.
 *
 * The timer is never cleared on detection. If cancellation lands between phases
 * while no child is running, clearing it would mean nothing gets killed and the
 * next phase starts anyway; the flag plus a live watcher covers both cases.
 */
let cancelSeen = false;

function startCancelWatch() {
  const timer = setInterval(() => {
    if (isCancelRequested(jobId)) {
      cancelSeen = true;
      killTree(currentChild);
    }
  }, 1500);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Checked at every phase boundary as well as by the watcher. */
function isCancelled() {
  if (cancelSeen) return true;
  cancelSeen = isCancelRequested(jobId);
  return cancelSeen;
}

async function main() {
  const job = await loadJob(jobId);
  if (!job) {
    process.stderr.write(`worker: job ${jobId} not found\n`);
    process.exit(2);
  }

  await mergeJob(jobId, { workerPid: process.pid });

  const spotdl = enginePath("spotdl");
  const ffmpeg = enginePath("ffmpeg");
  if (!spotdl) throw new Error("The bundled spotdl engine is missing.");
  if (!ffmpeg) throw new Error("The bundled ffmpeg engine is missing.");

  const workDir = path.join(appDataDir(), "work", jobId);
  await mkdir(workDir, { recursive: true });
  const saveFile = path.join(workDir, "playlist.spotdl");

  const stopWatch = startCancelWatch();

  try {
    // --- Phase 1: metadata -----------------------------------------------
    await mergeJob(jobId, { phase: "fetching_metadata" });

    const credArgs = [];
    if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
      credArgs.push(
        "--client-id",
        process.env.SPOTIFY_CLIENT_ID,
        "--client-secret",
        process.env.SPOTIFY_CLIENT_SECRET,
      );
    }

    const saved = await run(spotdl, [
      "save",
      job.url,
      "--save-file",
      saveFile,
      ...credArgs,
    ]);

    if (isCancelled()) return finish("cancelled");

    if (saved.code !== 0) {
      throw new Error(
        `Could not read that Spotify link. ${friendlyEngineError(saved.tail)}`,
      );
    }

    let tracks = [];
    try {
      const parsed = JSON.parse(await readFile(saveFile, "utf8"));
      tracks = Array.isArray(parsed) ? parsed : [];
    } catch {
      tracks = [];
    }

    if (!tracks.length) {
      throw new Error(
        "That link contained no tracks. It may be a private playlist, or empty.",
      );
    }

    const playlistName =
      tracks[0]?.list_name || tracks[0]?.album_name || "playlist";
    await mergeJob(jobId, { trackTotal: tracks.length, playlistName });

    // --- Phase 2: download -----------------------------------------------
    const outputDir = path.join(
      job.outputRoot || defaultOutputRoot(),
      `${sanitizeFolderName(playlistName)} (${jobId})`,
    );
    await mkdir(outputDir, { recursive: true });
    await mergeJob(jobId, { phase: "downloading", outputDir });

    const poll = setInterval(async () => {
      const count = Math.min(await countAudioFiles(outputDir), tracks.length);
      const current = await loadJob(jobId);
      if (current && count !== current.trackCount) {
        await mergeJob(jobId, { trackCount: count });
      }
    }, POLL_MS);

    const errorsLog = path.join(workDir, "errors.log");
    let result;
    try {
      result = await run(spotdl, [
        "download",
        saveFile,
        "--output",
        path.join(outputDir, outputTemplate(job.url)),
        "--format",
        job.format || "mp3",
        "--bitrate",
        job.bitrate || "320k",
        "--threads",
        String(job.threads || 4),
        "--ffmpeg",
        ffmpeg,
        "--save-errors",
        errorsLog,
        ...credArgs,
      ]);
    } finally {
      clearInterval(poll);
    }

    if (isCancelled()) return finish("cancelled");

    // --- Phase 3: report -------------------------------------------------
    const downloaded = Math.min(await countAudioFiles(outputDir), tracks.length);
    const failed = await readFailures(errorsLog, tracks.length, downloaded);

    // A non-zero exit with nothing downloaded is a real failure, not a playlist
    // where a few tracks were unavailable. Reporting that as "completed with 0
    // of 50" would hide a broken ffmpeg or an unwritable folder.
    if (downloaded === 0) {
      throw new Error(
        result.code === 0
          ? "No tracks could be downloaded from any source."
          : `The download engine failed. ${friendlyEngineError(result.tail)}`,
      );
    }

    // Separate a mid-run engine crash from ordinary per-track unavailability.
    // Both leave files on disk and a non-zero exit, but they mean different
    // things to the user: unavailable tracks are final, whereas a crash means
    // the remaining tracks were never attempted and retrying is worth it.
    //
    // Death by signal is unambiguous. Otherwise the tell is a non-zero exit
    // combined with tracks that vanished without the engine logging a reason.
    //
    // Measured on real runs: spotDL exits 0 even when a track is genuinely
    // unavailable (two album downloads, 9 of 10, engineExit 0, one logged
    // AudioProviderError). Normal completed-with-errors is therefore exit 0,
    // so a non-zero exit with unexplained gaps means the run was interrupted.
    // An earlier version only flagged this when NOTHING was explained, which
    // missed the common mixed case: one real failure logged, then a crash.
    const crashed =
      Boolean(result.signal) ||
      (result.code !== 0 && unexplainedCount(failed) > 0);

    if (crashed) {
      await mergeJob(jobId, { trackCount: downloaded, failed, outputDir });
      throw new Error(
        `The download engine stopped early after ${downloaded} of ${tracks.length} tracks` +
          (result.signal ? ` (killed by ${result.signal})` : "") +
          `. The rest were never attempted, so retrying should pick them up. ` +
          friendlyEngineError(result.tail),
      );
    }

    await mergeJob(jobId, {
      trackCount: downloaded,
      failed,
      outputDir,
      engineExit: result.code,
      engineTail: result.code === 0 ? null : friendlyEngineError(result.tail),
    });
    const fresh = await loadJob(jobId);
    await writeReport(outputDir, fresh);
    return finish("completed");
  } finally {
    stopWatch();
  }
}

/** Surface the most useful line of engine output instead of a raw stack trace. */
function friendlyEngineError(tail = "") {
  const line = tail
    .split("\n")
    .reverse()
    .find((l) => /error|failed|denied|not found|invalid/i.test(l));
  return (line || tail.split("\n").pop() || "").trim().slice(0, 300);
}

const ANSI = /\[[0-9;]*m/g;

/**
 * Parse spotDL's error log into per-track reasons a non-technical user can read.
 *
 * Only lines carrying a known error marker count as a failed track: the log also
 * contains headers and wrapped stack traces, and treating every line as a
 * failure invents tracks that never existed. Whatever the log does not explain
 * is reconciled against the count delta so the total always adds up.
 */
async function readFailures(errorsLog, total, downloaded) {
  let raw = "";
  try {
    raw = await readFile(errorsLog, "utf8");
  } catch {
    raw = "";
  }

  const failures = [];
  for (const line of raw.split(/\r?\n/)) {
    const clean = line.replace(ANSI, "").trim();
    if (!clean) continue;

    const isLookup = /LookupError/.test(clean);
    const isProvider = /AudioProviderError|DownloadError/.test(clean);
    if (!isLookup && !isProvider) continue; // header, traceback, or noise

    const name =
      clean.match(/["']([^"']{3,150})["']/)?.[1] ??
      clean.replace(/^.*?(LookupError|AudioProviderError|DownloadError):\s*/, "");

    failures.push({
      name: name.trim().slice(0, 150),
      reason: isLookup
        ? "Could not be found on YouTube, SoundCloud, or Bandcamp."
        : "Found but could not be downloaded. It may be age-restricted, blocked in your country, or removed.",
    });
  }

  // spotDL can write more than one marker line for a single track, so cap the
  // parsed list at the number actually missing. Dedupe by name first, since the
  // duplicate lines usually name the same track twice.
  const missing = Math.max(0, total - downloaded);
  const seen = new Set();
  const unique = failures.filter((f) => {
    const key = f.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const capped = unique.slice(0, missing);

  // The log did not account for every missing track, so say so rather than
  // letting the numbers quietly disagree with each other.
  const unexplained = missing - capped.length;
  if (unexplained > 0) {
    capped.push({
      name: `${unexplained} further track${unexplained === 1 ? "" : "s"}`,
      reason: "Did not download, and the engine gave no reason.",
      count: unexplained,
    });
  }

  return capped;
}

/** Tracks covered by the catch-all entry rather than by a real engine message. */
function unexplainedCount(failed = []) {
  return failed.reduce((n, f) => n + (f.count ?? 0), 0);
}

/**
 * Number of tracks missing, which is not the same as the number of report
 * entries: one aggregate entry can stand for several tracks. Headings must use
 * this, or a report says "1 track" above a bullet reading "3 further tracks".
 */
function missingTrackCount(job) {
  if (typeof job.trackTotal === "number" && typeof job.trackCount === "number") {
    return Math.max(0, job.trackTotal - job.trackCount);
  }
  return (job.failed ?? []).reduce((n, f) => n + (f.count ?? 1), 0);
}

/** A plain-text summary beside the music, so the result is legible without Claude. */
async function writeReport(outputDir, job) {
  const lines = [
    `Playlist: ${job.playlistName || job.url}`,
    `Downloaded: ${job.trackCount}${job.trackTotal ? ` of ${job.trackTotal}` : ""}`,
    `Finished: ${new Date().toLocaleString()}`,
    "",
  ];
  if (job.engineExit) {
    lines.push(
      `Note: the download engine exited with code ${job.engineExit}. Some tracks may be missing for that reason rather than being unavailable.`,
      job.engineTail ? `  ${job.engineTail}` : "",
      "",
    );
  }

  const missing = missingTrackCount(job);
  if (missing > 0) {
    lines.push(`Could not download ${missing} track(s):`, "");
    for (const f of job.failed ?? [])
      lines.push(`  - ${f.name}`, `      ${f.reason}`);
  } else {
    lines.push("Every track downloaded.");
  }
  await writeFile(path.join(outputDir, "download-report.txt"), lines.join("\n"));
}

async function finish(phase) {
  await mergeJob(jobId, { phase, workerPid: null });
  process.exit(0);
}

main().catch(async (err) => {
  await log(`FATAL ${err?.stack || err}`);
  await mergeJob(jobId, {
    phase: "failed",
    error: String(err?.message || err),
    workerPid: null,
  });
  process.exit(1);
});
