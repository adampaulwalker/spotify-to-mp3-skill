# Handoff - Spotify Playlist Downloader MCPB

Paste this after a `/compact` to resume with full context.

## What this is

A Claude Desktop extension (`.mcpb`) that turns a Spotify link into tagged audio
files on the user's own Mac. Spotify supplies the track list only; the audio
comes from YouTube, SoundCloud, or Bandcamp via bundled `spotdl`, `yt-dlp`, and
a self-built LGPL `ffmpeg`.

Built for public distribution, not for Adam personally. Adam's playlist runs are
**tests of the product**, not attempts to acquire music. Do not suggest he use
the CLI to "just get his music" - that is solving the wrong problem, and it was
a repeated mistake earlier in this project.

| | |
|---|---|
| Repo | `~/code/spotify-to-mp3-skill` (public on GitHub) |
| Extension source | `mcpb/` |
| Installed at | `~/Library/Application Support/Claude/Claude Extensions/local.mcpb.adam-walker.spotify-playlist-downloader` |
| Landing page | https://spotify-playlist-downloader-7lk.pages.dev (Cloudflare Pages, NOT atlanticlabs.ai) |
| Current version | 0.3.3, signed and notarized |
| Goal + criteria | `mcpb/GOAL.md` |
| Failure catalogue | `mcpb/FAILURE-MODES.md` |
| Notarization notes | `mcpb/NOTARIZATION.md` |

## The open problem

`spotdl save` on a large playlist hangs: logs "Found 116 songs", then permanent
silence with the process alive. Seen 4+ times.

**Both obvious explanations are disproven by testing. Do not re-propose them.**

1. *Shared-credential rate limiting* - re-ran with Adam's own Spotify app
   credentials, hung identically for 10 minutes.
2. *Large playlists are unsupported* - the same command, same playlist, without
   credentials, completed earlier the same day and resolved 110 tracks.

It is intermittent. Direct `curl` to api.spotify.com returned 429 twice that
day, and the machine's network was independently unreliable (DNS dropping, a
92MB download truncating at 12MB, 17MB, and 353KB on three attempts).

The product defect regardless of cause: spotdl retries silently and forever. A
15-minute watchdog catches it and reports honestly, but fifteen minutes of a
bare menu bar icon is exactly the experience Adam keeps hitting.

Proposed and under multi-llm review, **not yet implemented**:
a. Metadata silence budget 15 min -> ~6 min.
b. Elapsed time in the menu bar during metadata ("reading... 4m").
c. On timeout, say what to do next.

The most promising unexplored option: **skip `spotdl save` entirely** and call
the Spotify Web API's paginated playlist endpoint directly for the track list.
That removes the opaque hang and gives per-track progress during the phase that
is currently silent.

## Architecture, and why it looks odd

- **Downloads run IN-PROCESS.** Claude Desktop is Electron, so `process.execPath`
  is the Claude binary; spawning a detached child launches a second copy of the
  whole app (verified - it booted a browser stack and collided on a database
  lock). `ELECTRON_RUN_AS_NODE` does not fix it. Trade-off accepted: a download
  no longer survives quitting Claude Desktop.
- **Progress lives outside the chat.** The chat is turn-based and cannot be
  pushed to. Hence a menu bar app (`menubar/StatusBar.swift`, shipped as a
  `.app` with `LSUIElement` - a bare binary launches but shows no item) and a
  self-refreshing `progress.html` written beside the music.
- **ffmpeg is built from source** by `scripts/build-ffmpeg.sh`. Every prebuilt
  macOS ffmpeg is `--enable-nonfree`, which cannot be redistributed. GPL enters
  only via x264/x265, which are video encoders this never touches.
- **Apple Silicon only.** spotdl publishes one macOS binary and it is arm64;
  Rosetta cannot translate that direction.

## Test layers (all currently passing, 49 checks)

```bash
cd ~/code/spotify-to-mp3-skill/mcpb
node scripts/smoke.mjs          # 6  - MCP protocol surface
node scripts/edge-probe.mjs     # 13 - hostile playlist names
node scripts/watchdog-test.mjs  # 11 - timeout behaviour
node scripts/fault-tests.mjs    # 19 - failure paths, message legibility
node scripts/install-local.mjs  # deterministic install, hash-verified
```

Rebuild and ship:
```bash
bash scripts/build-menubar.sh      # .app, not a bare binary
bash scripts/sign-and-notarize.sh  # may need Adam's terminal for the keychain prompt
node scripts/install-local.mjs     # GUI install silently no-ops with no window open
```

**Claude Desktop must be restarted after installing, or it keeps running the old
server in memory.** This has caused false "the fix didn't work" reports.

## Criteria status (`mcpb/GOAL.md`)

Verified: C2 status distinguishes stalled, C3 watchdog fires honestly, C4 menu
bar appears (`menu bars: 1`), C5 error paths legible, C6 skill-test on the
installed build.

Open: **C1** - a playlist reaching completion with the reported count matching
disk. Blocked by the hang above.

## Working agreements learned the hard way

- **Verify by hash, never by a dialog.** Installing over the same version shows a
  detail page that is indistinguishable from success while the old code keeps
  running.
- **Check timestamps against the clock.** A progress number that has not moved is
  not proof of progress; it was read three times before noticing it was stale.
- **Test in the host runtime.** Every test passed under plain `node` while the
  product was broken under Electron.
- **Do not narrow a criterion to make it pass.** C1 stays open.
- Adam does not want to be the QA loop. Find defects before he does.
