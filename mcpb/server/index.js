#!/usr/bin/env node
// MCP stdio server for Claude Desktop.
//
// Every tool returns in under a second. Downloads run in a detached worker and
// are observed through the job file, because an MCP call that blocks for twenty
// minutes is not a viable shape for this work.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import { runJob } from "./worker.js";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  enginePath,
  defaultOutputRoot,
  IS_WINDOWS,
  unsupportedPlatformReason,
  isQuarantined,
  BUNDLE_ROOT,
  appDataDir,
} from "./paths.js";
import {
  createJob,
  loadJob,
  listJobs,
  updateJob,
  reconcile,
  requestCancel,
} from "./jobs.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, "worker.js");

// Anchored at both ends. The unanchored version matched only the prefix, so
// `https://open.spotify.com/playlist/abc"; rm -rf /` passed validation and the
// whole string was handed to the engine. Not a live injection - arguments go
// through spawn() with an array and never touch a shell - but it let malformed
// input reach the engine, produced a confusing failure instead of a clean
// rejection, and would become dangerous the moment anything used a shell.
//
// A trailing query string is allowed because Spotify's share links carry one
// (?si=...); anything else is rejected.
const SPOTIFY_URL =
  /^https?:\/\/open\.spotify\.com\/(intl-[a-z]{2}\/)?(playlist|album|track)\/[A-Za-z0-9]{16,32}(\?[A-Za-z0-9_=&%.-]*)?$/;

const server = new Server(
  { name: "spotify-playlist-downloader", version: "0.3.2" },
  { capabilities: { tools: {} } },
);

const text = (s) => ({ content: [{ type: "text", text: s }] });

/**
 * Execute an engine with a short timeout and report the real error. spotdl is a
 * PyInstaller bundle that unpacks itself on first run, so the timeout is
 * generous enough for a cold start on a slow disk.
 */
function probeEngine(bin, args, timeoutMs = 45000) {
  return new Promise((resolve) => {
    const p = enginePath(bin);
    if (!p) {
      return resolve({ ok: false, line: `MISSING  ${bin}` });
    }

    const child = spawn(p, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({
        ok: false,
        line: `TIMEOUT  ${bin}  did not respond within ${timeoutMs / 1000}s`,
      });
    }, timeoutMs);

    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, line: `FAILED   ${bin}  ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const version = out.trim().split("\n")[0]?.slice(0, 60) || "";
      resolve(
        code === 0
          ? { ok: true, line: `OK       ${bin}  ${version}` }
          : {
              ok: false,
              line: `FAILED   ${bin}  exit ${code}  ${out.trim().slice(0, 120)}`,
            },
      );
    });
  });
}

/**
 * How long since the engine last wrote anything, in seconds, or null if there is
 * no log yet.
 *
 * This is the only signal that separates "working" from "hung". Phase and track
 * count are both static during metadata resolution - spotDL reads 100+ tracks
 * without logging per track - so a status reply built on those alone forces the
 * model to guess, and it guesses "give it another minute" forever.
 */
function secondsSinceEngineOutput(jobId) {
  try {
    const p = path.join(appDataDir(), "logs", `${jobId}.log`);
    return Math.round((Date.now() - statSync(p).mtimeMs) / 1000);
  } catch {
    return null;
  }
}

function humanDuration(sec) {
  if (sec == null) return "unknown";
  if (sec < 90) return `${sec}s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  return `${(sec / 3600).toFixed(1)} hours`;
}

function describe(job) {
  const j = reconcile(job);
  const pct =
    j.trackTotal && j.trackCount
      ? ` (${Math.round((j.trackCount / j.trackTotal) * 100)}%)`
      : "";
  const bar = (() => {
    if (!j.trackTotal) return null;
    const pct = Math.round((j.trackCount / j.trackTotal) * 100);
    const filled = Math.round((j.trackCount / j.trackTotal) * 24);
    return `${"\u2588".repeat(filled)}${"\u2591".repeat(24 - filled)}  ${pct}%`;
  })();

  const lines = [
    `Job ${j.id} - ${j.phase}`,
    j.playlistName ? `Playlist: ${j.playlistName}` : `URL: ${j.url}`,
    `Downloaded: ${j.trackCount}${j.trackTotal ? ` of ${j.trackTotal}` : ""}${pct}`,
  ];
  if (bar) lines.push(bar);
  if (j.outputDir) lines.push(`Folder: ${j.outputDir}`);
  if (j.error) lines.push(`Error: ${j.error}`);

  // Liveness and pace, so the answer distinguishes progress from a stall
  // instead of leaving that to inference.
  const active = !["completed", "failed", "cancelled"].includes(j.phase);
  if (active) {
    const quiet = secondsSinceEngineOutput(j.id);
    const started = Date.parse(j.createdAt);
    const elapsed = Number.isFinite(started)
      ? Math.round((Date.now() - started) / 1000)
      : null;

    lines.push(`Running for: ${humanDuration(elapsed)}`);
    lines.push(
      quiet == null
        ? "Engine output: none yet"
        : `Last engine output: ${humanDuration(quiet)} ago`,
    );

    if (j.phase === "fetching_metadata") {
      lines.push(
        "Reading the track list from Spotify. This stage is quiet by design - " +
          "the engine resolves every track before it logs again, which takes " +
          "a few minutes on a large playlist. No files are written yet.",
      );
    }

    if (j.trackCount > 0 && elapsed) {
      const perTrack = elapsed / j.trackCount;
      const left = j.trackTotal ? j.trackTotal - j.trackCount : 0;
      if (left > 0) {
        lines.push(
          `Pace: about ${humanDuration(Math.round(perTrack))} per track, ` +
            `roughly ${humanDuration(Math.round(perTrack * left))} remaining`,
        );
      }
    }

    if (quiet != null && quiet > 600) {
      lines.push(
        `WARNING: nothing for ${humanDuration(quiet)}. This job may be stuck; ` +
          "it will stop itself after 15 minutes of no progress.",
      );
    }
  }

  // Count missing tracks, not report entries - one aggregate entry can stand
  // for several tracks, so failed.length would understate the total.
  const missing =
    typeof j.trackTotal === "number" && typeof j.trackCount === "number"
      ? Math.max(0, j.trackTotal - j.trackCount)
      : (j.failed ?? []).reduce((n, f) => n + (f.count ?? 1), 0);

  if (j.phase === "completed" && missing > 0) {
    lines.push("", `Could not download ${missing} track(s):`);
    for (const f of (j.failed ?? []).slice(0, 25))
      lines.push(`  - ${f.name}: ${f.reason}`);
  }
  if (j.phase === "completed" && j.engineExit) {
    lines.push(
      "",
      `Note: the download engine exited with code ${j.engineExit}, so some tracks may be missing for that reason rather than being unavailable.`,
    );
  }
  return lines.join("\n");
}

const TOOLS = [
  {
    name: "start_playlist_download",
    description:
      "Save audio files to this computer for the tracks on a Spotify playlist, album, or track link. " +
      "How it works: the Spotify link is read for metadata only - track titles, artists and durations - " +
      "using the public Spotify Web API. No audio is taken from Spotify, whose streams are DRM-protected " +
      "and never accessed. The audio itself is located on public sources (YouTube, SoundCloud, Bandcamp) " +
      "by matching title, artist and duration, and is downloaded from there. " +
      "Returns a job id immediately; the download continues in the background. " +
      "Use get_download_status to check progress.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "A Spotify playlist, album, or track link.",
        },
        format: {
          type: "string",
          enum: ["mp3", "m4a", "flac"],
          description: "Audio format. Defaults to mp3.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "get_download_status",
    description:
      "Check how a download is going: how many tracks are done, which failed and why, and where the folder is.",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string" } },
      required: ["job_id"],
    },
  },
  {
    name: "list_download_jobs",
    description: "List recent download jobs and their status.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cancel_download",
    description: "Stop a download that is currently running.",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string" } },
      required: ["job_id"],
    },
  },
  {
    name: "open_output_folder",
    description:
      "Open the folder containing the downloaded music in Finder or File Explorer.",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string" } },
      required: ["job_id"],
    },
  },
  {
    name: "show_progress",
    description:
      "Open a live progress window for a download. The page updates itself every few seconds, so it can be left open on screen instead of asking for status repeatedly.",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string" } },
      required: ["job_id"],
    },
  },
  {
    name: "check_setup",
    description:
      "Verify the extension is correctly installed and that its bundled download tools " +
      "(spotdl, yt-dlp, ffmpeg) can run on this machine. Reads nothing and downloads nothing. " +
      "Use this first if anything fails.",
    inputSchema: { type: "object", properties: {} },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  try {
    switch (name) {
      case "check_setup": {
        const blocked = unsupportedPlatformReason();
        if (blocked) return text(blocked);

        // Existence is not enough. A binary can be present but the wrong
        // architecture, quarantined by Gatekeeper, non-executable, or unable to
        // unpack itself - all of which look fine to a file check and then fail
        // minutes into a download. Run each one and report what actually happens.
        const results = await Promise.all(
          [
            ["spotdl", ["--version"]],
            ["ffmpeg", ["-version"]],
            ["yt-dlp", ["--version"]],
          ].map(([bin, args]) => probeEngine(bin, args)),
        );

        const ok = results.every((r) => r.ok);

        // A quarantined engine is killed by Gatekeeper with no output at all,
        // so name that cause explicitly rather than leaving the user with an
        // unexplained failure.
        const quarantined = ["spotdl", "ffmpeg", "yt-dlp"].filter((b) =>
          isQuarantined(enginePath(b)),
        );

        const lines = [
          ok
            ? "Setup looks good. Everything needed is bundled with the extension, and all three engines run."
            : "Something is wrong with the bundled engines.",
          "",
          ...results.map((r) => r.line),
        ];

        if (quarantined.length) {
          lines.push(
            "",
            "macOS has marked these files as downloaded from the internet and is",
            "blocking them: " + quarantined.join(", ") + ".",
            "",
            "This extension is not yet signed by Apple, so macOS refuses to run",
            "its audio engines. Removing the download flag fixes it. Paste this",
            "into Terminal, then ask me to check setup again:",
            "",
            `  xattr -dr com.apple.quarantine "${path.join(BUNDLE_ROOT, "vendor")}"`,
          );
        }

        lines.push("", `Music will be saved to: ${defaultOutputRoot()}`);
        return text(lines.join("\n"));
      }

      case "start_playlist_download": {
        const url = String(args.url || "").trim();
        if (!SPOTIFY_URL.test(url)) {
          return text(
            "That does not look like a Spotify link. Paste a link that starts with https://open.spotify.com/playlist/ (or /album/ or /track/).",
          );
        }
        const blocked = unsupportedPlatformReason();
        if (blocked) return text(blocked);

        if (!enginePath("spotdl") || !enginePath("ffmpeg")) {
          return text(
            "The bundled audio engines are missing, so nothing can be downloaded. Run check_setup, then reinstall the extension.",
          );
        }

        const job = await createJob({
          url,
          format: args.format || "mp3",
          outputRoot: defaultOutputRoot(),
        });

        // Run the download in THIS process, deliberately, rather than
        // spawning a child.
        //
        // Claude Desktop hosts this server under Electron, so process.execPath
        // is the Claude binary, not node. Spawning it launches a second copy of
        // the entire app - observed booting a browser stack and colliding with
        // the running instance's database lock - and ELECTRON_RUN_AS_NODE does
        // not change that. Every spawn attempt produced a job stuck at
        // "queued" with no log line written and no visible error.
        //
        // Not awaited: the tool call must return an id immediately. The catch
        // is required because an unhandled rejection here would take the whole
        // MCP server down.
        //
        // Trade-off accepted: the download no longer survives Claude Desktop
        // quitting. reconcile() already reports an interrupted job honestly,
        // and a design property that never once worked is worth less than a
        // download that starts. The CLI still spawns a real detached process,
        // where a real node exists.
        runJob(job.id).catch(() => {});
        await updateJob(job.id, { workerPid: process.pid });

        return text(
          [
            `Started. Job id: ${job.id}`,
            "",
            "The download runs in the background, so this may take a while for a long playlist. Ask me to check the status whenever you like.",
          ].join("\n"),
        );
      }

      case "get_download_status": {
        const job = await loadJob(String(args.job_id || ""));
        if (!job) return text(`No job with id ${args.job_id}.`);
        return text(describe(job));
      }

      case "list_download_jobs": {
        const jobs = await listJobs();
        if (!jobs.length) return text("No downloads yet.");
        return text(
          jobs
            .map((j) => {
              const r = reconcile(j);
              return `${r.id}  ${r.phase.padEnd(18)}  ${r.trackCount}${r.trackTotal ? `/${r.trackTotal}` : ""}  ${r.playlistName || r.url}`;
            })
            .join("\n"),
        );
      }

      case "cancel_download": {
        const id = String(args.job_id || "");
        const job = await loadJob(id);
        if (!job) return text(`No job with id ${args.job_id}.`);
        // A marker file, not a job field: the worker must not be able to merge
        // a stale "not cancelled" value back over this.
        await requestCancel(id);
        return text(
          `Cancelling job ${job.id}. Tracks already downloaded are kept in ${job.outputDir || "the output folder"}.`,
        );
      }

      case "show_progress": {
        const job = await loadJob(String(args.job_id || ""));
        if (!job) return text(`No job with id ${args.job_id}.`);
        const page = job.outputDir
          ? path.join(job.outputDir, "progress.html")
          : null;
        if (!page || !existsSync(page)) {
          return text(
            "No progress window yet. It appears once downloading starts - " +
              "reading the track list from Spotify comes first and writes no files.",
          );
        }
        spawn("open", [page], { detached: true, stdio: "ignore" }).unref();
        return text(
          "Opened the progress window. It refreshes itself, so you can leave it open.",
        );
      }

      case "open_output_folder": {
        const job = await loadJob(String(args.job_id || ""));
        if (!job) return text(`No job with id ${args.job_id}.`);
        if (!job.outputDir || !existsSync(job.outputDir))
          return text("That job has no output folder yet.");
        const opener = IS_WINDOWS ? "explorer" : "open";
        spawn(opener, [job.outputDir], { detached: true, stdio: "ignore" }).unref();
        return text(`Opened ${job.outputDir}`);
      }

      default:
        return text(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return text(`Something went wrong: ${err?.message || err}`);
  }
});

await server.connect(new StdioServerTransport());
