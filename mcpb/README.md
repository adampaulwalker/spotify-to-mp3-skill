# Spotify Playlist Downloader - Claude Desktop extension

A `.mcpb` desktop extension. Paste a Spotify link into Claude Desktop and the
tracks are saved as tagged audio files in your Downloads folder. Everything runs
on your own machine and the audio engines are bundled, so there is no terminal,
no Homebrew, no Python, and no Spotify developer account.

This is the non-technical counterpart to the [Claude Code skill](../spotify-to-mp3)
in this repo. Same pipeline, packaged as a double-click install.

## Platform support

| Platform | Status |
|---|---|
| macOS, Apple Silicon | Supported and tested |
| macOS, Intel | **Not supported** |
| Windows | Not built yet |
| Linux | Not applicable - Claude Desktop does not run there |

Intel Macs are excluded for a hard reason rather than a lack of effort. spotDL
publishes exactly one macOS release artifact and it is an arm64 binary. Rosetta
translates x86_64 to arm64, not the reverse, so there is no way to run it on an
Intel Mac. The extension detects this and says so rather than failing with an
opaque error part-way through a download.

Windows is deliberately absent from `manifest.json`. `scripts/fetch-binaries.mjs`
can vendor `win32-x64` engines, but nothing has been tested there, and an install
that succeeds and then reports missing engines is worse than no install at all.
Add `win32` to the manifest only after a real end-to-end run on Windows.

## Build

```bash
npm install
node scripts/fetch-binaries.mjs      # vendor engines for this platform
npm run smoke                        # MCP protocol checks
npm run pack                         # produces the .mcpb
```

Engine binaries are not committed. They are ~115 MB and reproducible from the
pinned versions and checksums in `vendor/binaries.lock.json`.

## Test

```bash
node scripts/smoke.mjs                    # protocol surface, no network
node scripts/e2e.mjs [url] [--clean]      # real download through the MCP server
```

`e2e.mjs` drives the server exactly as Claude Desktop does: starts a job, polls
to a terminal phase, then inspects the files that landed on disk.

Verified end to end: single track links, and album links (9 of 10 tracks, with
the tenth correctly reported as unavailable rather than silently missing).
**Playlist links have not been run end to end yet** - the numbering variable
differs per link type, and only the playlist branch is untested.

## Design notes

**Jobs, not blocking calls.** `start_playlist_download` returns a job id
immediately and a detached worker owns the download, so it survives Claude
Desktop restarting. An MCP call that blocks for twenty minutes is not viable.

**Cancellation is a marker file**, not a field in the job JSON. The server writes
it and the worker only reads it. Storing it in the job object meant a worker that
had read `false` a second earlier could merge that stale value back over the
user's cancel request. Cancelling kills the whole process group, because spotDL
forks ffmpeg and killing only the parent leaves those running.

**Filenames carry a number** on albums and playlists. Without it, two tracks with
the same artist and title collapse onto one filename, the file count undershoots,
and the report invents missing tracks that actually downloaded.

**Counts are reconciled.** The report counts missing tracks, not error-log
entries, so a single aggregate entry standing for three tracks cannot produce a
heading that disagrees with its own bullet list.

## Known limitations

- Playlist-link numbering is implemented but not yet verified end to end.
- A non-zero engine exit with some files present is reported as completed, with
  the exit code surfaced in the report. It is not currently distinguished from a
  mid-run engine crash.
- The bundle is unsigned. macOS Gatekeeper may block the vendored binaries when
  the `.mcpb` is downloaded from the internet rather than built locally.
  Notarization requires a paid Apple Developer account and has not been done.
- ffmpeg is vendored from `@ffmpeg-installer`. Its license terms need confirming,
  with third-party notices included, before this is distributed publicly.

## Credits

[spotDL](https://github.com/spotdl/spotify-downloader) and
[yt-dlp](https://github.com/yt-dlp/yt-dlp) do the real work.
