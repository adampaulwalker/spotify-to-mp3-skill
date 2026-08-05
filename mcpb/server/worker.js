#!/usr/bin/env node
// Detached download worker. Spawned by the MCP server and then orphaned on
// purpose, so the download survives Claude Desktop restarting or the stdio
// server being respawned. Communicates only through the job file on disk.
//
//   node worker.js <jobId>

import { spawn, spawnSync } from "node:child_process";
import { mkdir, readdir, writeFile, appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  enginePath,
  defaultOutputRoot,
  sanitizeFolderName,
  appDataDir,
  IS_WINDOWS,
  BUNDLE_ROOT,
} from "./paths.js";
import { loadJob, mergeJob, isCancelRequested } from "./jobs.js";

const AUDIO_EXTS = new Set([".mp3", ".m4a", ".opus", ".flac"]);
const POLL_MS = 4000;

// Silence budgets differ by phase because expected behaviour differs.
//
// `spotdl save` resolves every track against the Spotify API and logs nothing
// between "Found N songs" and completion - on a 100+ track playlist that gap is
// legitimately long, so a short timeout would kill healthy runs.
//
// The download phase logs a line per track, so prolonged silence there means
// something is actually wrong.
const METADATA_SILENCE_MS = 15 * 60 * 1000;
const DOWNLOAD_SILENCE_MS = 5 * 60 * 1000;

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

// Set by runJob(). Module-level because the helpers below close over it, and
// the worker only ever handles one job per invocation.
let jobId = null;
let logPath = null;

async function log(line) {
  if (!logPath) return;
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
let latestLine = "";

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
function run(bin, args, { onLine, silenceMs = 5 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group so killTree can take the children with it.
      detached: !IS_WINDOWS,
    });
    currentChild = child;

    // Output watchdog, at the level of every engine invocation.
    //
    // The engines have no internal timeout. A dropped connection kills their
    // in-flight requests and they sit there with a live process and no output,
    // forever. Observed three times: 30 Spotify requests failing in the same
    // millisecond during metadata resolution, then permanent silence.
    //
    // The download phase had a stall detector keyed on new files appearing, but
    // metadata writes no files, so nothing guarded it. Guarding output here
    // covers every phase, including any added later.
    let silenceTimer = null;
    let timedOut = false;
    const resetSilence = () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        timedOut = true;
        log(`WATCHDOG: no engine output for ${Math.round(silenceMs / 1000)}s, stopping`).catch(
          () => {},
        );
        killTree(child);
      }, silenceMs);
    };
    resetSilence();

    const tail = [];
    let buffered = "";

    const handle = (chunk) => {
      buffered += chunk.toString();
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        resetSilence();
        log(line).catch(() => {});
        latestLine = line;
        tail.push(line);
        if (tail.length > 40) tail.shift();
        onLine?.(line);
      }
    };

    child.stdout.on("data", handle);
    child.stderr.on("data", handle);
    child.on("error", (err) => {
      if (silenceTimer) clearTimeout(silenceTimer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (silenceTimer) clearTimeout(silenceTimer);
      currentChild = null;
      resolve({ code, signal, timedOut, tail: tail.join("\n") });
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

/**
 * Post a macOS notification.
 *
 * The chat window is turn-based, so the extension can only report progress when
 * asked. Notifications close that gap: the user starts a job and is told when it
 * passes milestones and when it finishes, without having to ask.
 *
 * Failures are swallowed on purpose. A notification is a nicety, and a download
 * should never die because Notification Centre was unhappy.
 */
function notify(title, message) {
  if (IS_WINDOWS) return;
  const esc = (s) => String(s).replace(/["\\]/g, "\\$&");
  spawn(
    "osascript",
    ["-e", `display notification "${esc(message)}" with title "${esc(title)}"`],
    { stdio: "ignore", detached: true },
  ).unref();
}

/**
 * Write a self-refreshing progress page next to the music.
 *
 * The chat window is turn-based, so an extension cannot push a live widget into
 * it. This is the workaround: a plain HTML file that reloads itself from disk
 * every few seconds, showing whatever the worker last wrote. Open it once and
 * it moves on its own.
 *
 * Deliberately no local server and no port. A meta-refresh on a file:// page
 * needs no network, works offline, and adds no security surface.
 */
async function writeProgressPage(dir, state) {
  const { playlistName, done, total, phase, lastLine } = state;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const finished = ["completed", "failed", "cancelled"].includes(phase);
  const esc = (t) =>
    String(t ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]);

  const html = `<!doctype html><meta charset="utf-8">
${finished ? "" : '<meta http-equiv="refresh" content="4">'}
<title>${esc(playlistName)} - ${pct}%</title>
<style>
:root{color-scheme:light dark}
body{font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
     margin:0;display:grid;place-items:center;min-height:100vh;
     background:#0f1117;color:#e6e8ec}
@media(prefers-color-scheme:light){body{background:#fff;color:#1a1a2e}}
.card{width:min(560px,90vw);padding:8px}
h1{font-size:1.35rem;margin:0 0 4px;letter-spacing:-.01em}
.sub{color:#9aa4b2;margin:0 0 28px;font-size:.95rem}
.track{font-variant-numeric:tabular-nums;font-size:2.6rem;font-weight:600;
       letter-spacing:-.02em;margin:0 0 14px}
.track span{font-size:1.1rem;font-weight:400;color:#9aa4b2}
.bar{height:10px;border-radius:99px;background:#262b35;overflow:hidden}
@media(prefers-color-scheme:light){.bar{background:#e5e7eb}}
.fill{height:100%;width:${pct}%;border-radius:99px;background:#16a34a;
      transition:width .6s ease}
.done .fill{background:#16a34a}
.failed .fill{background:#dc2626}
.now{margin:22px 0 0;color:#9aa4b2;font-size:.9rem;
     white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.status{margin:26px 0 0;font-size:.9rem;color:#9aa4b2}
</style>
<div class="card">
  <h1>${esc(playlistName)}</h1>
  <p class="sub">${finished ? "Finished" : "Downloading"}</p>
  <p class="track">${done}<span> / ${total || "?"} tracks</span></p>
  <div class="bar ${phase === "failed" ? "failed" : finished ? "done" : ""}"><div class="fill"></div></div>
  <p class="now">${esc(lastLine || "")}</p>
  <p class="status">${
    finished
      ? "You can close this page."
      : "This page updates itself. Leave it open."
  }</p>
</div>`;
  try {
    await writeFile(path.join(dir, "progress.html"), html);
  } catch {
    /* a progress page is a nicety; never fail a download over it */
  }
}

/** Checked at every phase boundary as well as by the watcher. */
function isCancelled() {
  if (cancelSeen) return true;
  cancelSeen = isCancelRequested(jobId);
  return cancelSeen;
}

/**
 * Bring up the menu bar indicator if it is not already there.
 *
 * The menu bar is the only surface on macOS that is always on screen, which is
 * where a job measured in tens of minutes belongs. The chat window cannot be
 * pushed to, and a progress page only helps while you are looking at it.
 *
 * The indicator is a read-only viewer over the same job files, so a second copy
 * or a killed copy is harmless. It exits on its own from its Quit menu.
 */
function ensureStatusBar() {
  if (IS_WINDOWS) return;
  // A .app, not a bare executable. A bare Mach-O launches and stays resident
  // but never shows a menu bar item; the identical code inside a .app with
  // LSUIElement appears immediately. The first build shipped the bare binary,
  // so the feature was dead for everyone who installed the bundle.
  const app = path.join(BUNDLE_ROOT, "vendor", "darwin-arm64", "SpotifyProgress.app");
  if (!existsSync(app)) return;
  try {
    const running = spawnSync("pgrep", ["-f", "SpotifyProgress"], {
      encoding: "utf8",
    });
    if (running.status === 0 && running.stdout.trim()) return;
    spawn("open", [app], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* the indicator is a nicety; never fail a download over it */
  }
}

async function main() {
  ensureStatusBar();
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

    const saved = await run(
      spotdl,
      ["save", job.url, "--save-file", saveFile, ...credArgs],
      { silenceMs: METADATA_SILENCE_MS },
    );

    if (isCancelled()) return finish("cancelled");

    // Checked before the exit code, and separately from it. A watchdog kill can
    // still exit 0 if the engine handles SIGTERM cleanly, in which case the
    // save file is truncated and parsing it would silently drop tracks.
    if (saved.timedOut) {
      throw new Error(
        "Reading the track list stalled: the engine produced no output for " +
          `${METADATA_SILENCE_MS / 60000} minutes. This is usually a dropped ` +
          "network connection. Nothing was downloaded; starting the job again is safe.",
      );
    }

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
    notify(
      playlistName,
      `Starting ${tracks.length} track${tracks.length === 1 ? "" : "s"}`,
    );

    // --- Phase 2: download -----------------------------------------------
    //
    // Plain playlist name, with the job id appended only if that folder already
    // exists. The id used to be unconditional, which guaranteed uniqueness and
    // made every folder look like a machine artefact. Re-running the same
    // playlist is rare; an ugly name every time is not.
    const root = job.outputRoot || defaultOutputRoot();
    const base = sanitizeFolderName(playlistName);
    let outputDir = path.join(root, base);
    if (existsSync(outputDir)) outputDir = path.join(root, `${base} (${jobId})`);
    await mkdir(outputDir, { recursive: true });
    await mergeJob(jobId, { phase: "downloading", outputDir });

    // Milestones every 25%, so a long playlist reports in without becoming
    // noise. A short job crosses several at once, hence the >= and the guard.
    let lastMilestone = 0;
    let lastCount = -1;
    let lastProgressAt = Date.now();
    const STALL_MS = 15 * 60 * 1000;
    const poll = setInterval(async () => {
      const count = Math.min(await countAudioFiles(outputDir), tracks.length);
      const current = await loadJob(jobId);
      if (current && count !== current.trackCount) {
        await mergeJob(jobId, { trackCount: count });
        lastProgressAt = Date.now();
        await writeProgressPage(outputDir, {
          playlistName, done: count, total: tracks.length,
          phase: "downloading", lastLine: latestLine,
        });
        const pct = Math.floor((count / tracks.length) * 100);
        const milestone = Math.floor(pct / 25) * 25;
        if (milestone > lastMilestone && milestone < 100) {
          lastMilestone = milestone;
          notify(playlistName, `${count} of ${tracks.length} downloaded`);
        }
      }
      // A download that has produced nothing for fifteen minutes is stuck, not
      // slow. Killing it surfaces a real error and keeps the files already on
      // disk, which beats a job that reports "downloading" indefinitely.
      if (count === lastCount && Date.now() - lastProgressAt > STALL_MS) {
        await log(`STALL: no progress for ${STALL_MS / 60000} minutes, stopping`);
        killTree(currentChild);
      }
      lastCount = count;
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
        // Without a socket timeout yt-dlp waits indefinitely on a stalled
        // read. Observed hanging 27 minutes mid-playlist with the process
        // alive and no output, which is indistinguishable from "slow" to
        // anyone watching. A bounded wait plus retries turns a dead job into
        // one skipped track.
        "--yt-dlp-args",
        "--socket-timeout 30 --retries 3",
        "--save-errors",
        errorsLog,
        ...credArgs,
      ], { silenceMs: DOWNLOAD_SILENCE_MS });
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
      Boolean(result.timedOut) ||
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
    await writeProgressPage(outputDir, {
      playlistName, done: downloaded, total: tracks.length,
      phase: "completed", lastLine: "",
    });
    const missing = missingTrackCount(fresh);
    notify(
      `${fresh.playlistName || "Download"} finished`,
      missing > 0
        ? `${downloaded} of ${tracks.length} saved, ${missing} unavailable`
        : `All ${downloaded} track${downloaded === 1 ? "" : "s"} saved`,
    );
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
}



/**
 * Run a job to completion in the current process.
 *
 * Exported because Claude Desktop cannot spawn a child process at all: it hosts
 * the MCP server under Electron, so process.execPath is the Claude binary.
 * Spawning it launches a second copy of the whole app - observed booting a
 * browser stack and colliding with the running instance's database lock - and
 * ELECTRON_RUN_AS_NODE does not change that. The download therefore runs inside
 * the server process there.
 *
 * The CLI still spawns this file as a detached child, because a real node is
 * available in a terminal and that keeps long downloads alive after the shell
 * closes.
 */
export async function runJob(id) {
  jobId = id;
  logPath = path.join(appDataDir(), "logs", `${id}.log`);
  try {
    await main();
  } catch (err) {
    await log(`FATAL ${err?.stack || err}`);
    notify("Download failed", String(err?.message || err).slice(0, 180));
    await mergeJob(id, {
      phase: "failed",
      error: String(err?.message || err),
      workerPid: null,
    });
  }
}

// CLI entry: only when executed directly, not when imported.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const id = process.argv[2];
  if (!id) {
    process.stderr.write("worker: missing job id\n");
    process.exit(2);
  }
  await runJob(id);
  process.exit(0);
}
