---
name: spotify-to-mp3
description: Download a Spotify playlist as MP3s. Handles rate limits, age-restricted YouTube, and a multi-source fallback chain (YouTube → SoundCloud → Bandcamp) to maximize coverage toward 100%. Triggers on "download spotify playlist", "spotify to mp3", "rip playlist", "get mp3s from spotify".
allowed-tools:
  - Bash
  - Read
  - Write
---

# Spotify Playlist → MP3

Spotify audio is DRM-locked. This skill uses `spotdl`: it reads playlist
metadata from the Spotify API, then downloads matching audio from YouTube
Music / YouTube / SoundCloud / Bandcamp and writes tagged MP3s.

## When to use

User shares a Spotify playlist URL and asks for MP3s. Also use for single
track URLs or saved `.spotdl` files.

## Output directory

Default: `~/Downloads/spotify-playlist/`. One folder per rip.

## Requirements

This skill only works in **Claude Code on macOS** (or Linux, with the
Homebrew commands swapped for your package manager). It shells out to
`brew`, `pipx`, `spotdl`, and `yt-dlp`, reads browser cookies from a local
Chrome install, and writes large files to your home directory.

Homebrew is the one prerequisite the agent can't install on its own - see
Step 0 for how to handle a Mac that doesn't have it yet.

It will **not** run inside the claude.ai web or desktop chat. Uploading it
there as a skill lets Claude read and explain the steps, but the sandbox has
no Homebrew, no local Chrome, and no open outbound access to YouTube /
SoundCloud / Bandcamp, so nothing will actually download.

## Step 0 - Homebrew

Every other tool comes from Homebrew, so check for it first:

```bash
command -v brew >/dev/null && brew --version
```

If it's already there, skip to Step 1. If it prints nothing, Homebrew is
missing. **You cannot install it yourself** - the official installer runs
`sudo` and blocks on an interactive admin-password prompt that an agent
can't answer. It may also trigger an Xcode Command Line Tools download,
which opens a graphical dialog.

Do not try to work around this with `echo password | sudo -S`, and do not
attempt a `NONINTERACTIVE=1` run hoping sudo is cached. Instead, stop and
give the user this command to paste into their own Terminal:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Tell them: it asks for their Mac login password (the prompt shows no
characters as they type, which is normal), and it can take a while on a
fresh machine because of the Command Line Tools download. If the user is in
Claude Code they can run it in-session by prefixing the line with `! `.

When they say it's done, verify and put `brew` on PATH for this session -
the installer prints these two lines but they only apply to new shells:

```bash
# Apple Silicon
[ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
# Intel
[ -x /usr/local/bin/brew ]   && eval "$(/usr/local/bin/brew shellenv)"

brew --version   # must succeed before continuing
```

`brew shellenv` only affects the current shell. Since each Bash call is a
fresh shell, either re-run the matching `eval` line at the top of any later
command, or use absolute paths (`$(brew --prefix)/bin/...`).

## Step 1 - Verify prereqs

Run this silently. If any tool is missing, install it without asking.

```bash
# ffmpeg (required for MP3 encoding)
command -v ffmpeg >/dev/null || brew install ffmpeg

# deno (required for yt-dlp JS challenge solving on newer YouTube)
command -v deno >/dev/null || brew install deno

# pipx
command -v pipx >/dev/null || brew install pipx

# Python 3.13 - spotdl 4.x breaks on Python 3.14, and a fresh Mac won't
# have 3.13 at all. Resolve the path via brew --prefix, which differs
# between Apple Silicon (/opt/homebrew) and Intel (/usr/local).
PY313="$(brew --prefix)/bin/python3.13"
[ -x "$PY313" ] || brew install python@3.13

# spotdl 4.x
if ! ~/.local/bin/spotdl --version 2>/dev/null | grep -q "^4\."; then
  pipx install spotdl --python "$PY313" --force
fi
```

Always call spotdl via its absolute path `~/.local/bin/spotdl` to avoid
colliding with a stale copy from an older Python install
(e.g. `~/Library/Python/3.9/bin/spotdl`) that may sit higher on PATH.

## Step 2 - Spotify API credentials

The default shared spotdl app is **heavily rate-limited** (24-hour lockouts
are common). Register your own free Spotify app instead - it takes a minute
and removes the rate limiting entirely:

1. Go to https://developer.spotify.com/dashboard and log in
2. "Create app" - any name/description, redirect URI `http://localhost:8888`
3. Copy the Client ID and Client Secret from the app's settings

Store them locally (not in this file, not in git):

```bash
# ~/.spotdl-creds  (chmod 600)
export CID="your_client_id"
export CS="your_client_secret"
```

Then `source ~/.spotdl-creds` before running, and pass via
`--client-id "$CID"` / `--client-secret "$CS"`.

If spotdl still complains about rate limits, `rm ~/.spotdl/.spotipy` to
clear the cached (expired) token.

## Step 3 - Save playlist metadata

```bash
mkdir -p ~/Downloads/spotify-playlist
cd ~/Downloads/spotify-playlist
~/.local/bin/spotdl save "<PLAYLIST_URL>" \
  --save-file playlist.spotdl \
  --client-id "$CID" --client-secret "$CS"
```

Output ends with `Saved N songs to ...`. Record `N` as the target count.
You'll compare against this at the end to verify 100% coverage.

## Step 4 - Bulk download

```bash
cd ~/Downloads/spotify-playlist
~/.local/bin/spotdl download playlist.spotdl \
  --client-id "$CID" --client-secret "$CS" \
  --format mp3 --bitrate 320k \
  --threads 4 \
  --save-errors errors.log
```

Expect ~95% coverage on this first pass. Run in background for large
playlists; poll `ls *.mp3 | wc -l` for progress. `--audio-providers` is NOT
a valid flag in spotdl 4.x (rejected with usage error) - don't pass it.

## Step 5 - Recovery chain for failed tracks

`errors.log` lists two failure types:

1. **LookupError: No results found** - YouTube Music couldn't find the track
2. **AudioProviderError: YT-DLP download error** - track was found but
   download failed (age-restricted, geo-blocked, or removed)

For each failure, resolve the exact Spotify metadata (title, artists,
duration_ms) by calling the Spotify API:

```bash
python3 <<'PY'
import urllib.request, urllib.parse, json, base64, os
cid, cs = os.environ['CID'], os.environ['CS']
auth = base64.b64encode(f'{cid}:{cs}'.encode()).decode()
req = urllib.request.Request(
    'https://accounts.spotify.com/api/token',
    data=urllib.parse.urlencode({'grant_type':'client_credentials'}).encode(),
    headers={'Authorization': f'Basic {auth}'})
tok = json.loads(urllib.request.urlopen(req).read())['access_token']
# Paste failed track IDs (comma-separated)
ids = 'ID1,ID2,ID3'
r = urllib.request.Request(
    f'https://api.spotify.com/v1/tracks?ids={ids}',
    headers={'Authorization': f'Bearer {tok}'})
for t in json.loads(urllib.request.urlopen(r).read())['tracks']:
    dur = t['duration_ms'] // 1000
    print(f"{t['id']} | {dur}s | {', '.join(a['name'] for a in t['artists'])} - {t['name']}")
PY
```

Then walk the fallback chain in order, stopping as soon as a source works:

### 5a - Retry YouTube with EJS + Chrome cookies

Handles the two most common YT-DLP errors: JS challenge failures (needed
for newer YouTube signatures) and age-restricted videos.

```bash
~/.local/pipx/venvs/spotdl/bin/yt-dlp \
  --remote-components ejs:github \
  --cookies-from-browser chrome \
  -x --audio-format mp3 --audio-quality 0 \
  -o "%(uploader)s - %(title)s [yt-fallback].%(ext)s" \
  "<YOUTUBE_URL_FROM_ERROR_LOG>"
```

Safari cookies are blocked by SIP (`Operation not permitted`), so always
use Chrome. User needs to have been signed into YouTube in Chrome at some
point; cookies unlock age-restricted videos.

### 5b - Direct YouTube search

When spotdl's YouTube Music search came up empty. Match results against the
Spotify duration (±2s) to avoid picking a DJ mix instead of the track:

```bash
~/.local/pipx/venvs/spotdl/bin/yt-dlp \
  --remote-components ejs:github --cookies-from-browser chrome \
  --default-search ytsearch3 \
  --print "title=%(title)s | uploader=%(uploader)s | url=%(webpage_url)s | dur=%(duration)s" \
  "<artist> <title>"
```

Pick the result whose duration matches Spotify within a few seconds, then
download it with the command from 5a.

### 5c - SoundCloud

Indie / electronic / underground artists often release on SC first:

```bash
~/.local/pipx/venvs/spotdl/bin/yt-dlp \
  --default-search scsearch5 \
  --print "title=%(title)s | uploader=%(uploader)s | url=%(webpage_url)s | dur=%(duration)s" \
  "<artist> <title>"
```

If the artist's profile appears, also try
`yt-dlp --flat-playlist "https://soundcloud.com/<artist>/tracks"` to list
everything under their handle in case search missed an exact title.

### 5d - Bandcamp

Good for net labels and experimental artists. Bandcamp doesn't expose a
clean search API, so scrape the search page:

```bash
python3 <<'PY'
import urllib.request, urllib.parse, re
q = "<artist> <title>"
html = urllib.request.urlopen(
    f"https://bandcamp.com/search?q={urllib.parse.quote(q)}&item_type=t",
    timeout=15).read().decode()
for m in sorted(set(re.findall(
    r'href="(https://[^"]+\.bandcamp\.com/track/[^"]+)"', html))):
    print(m.split('?')[0])
PY
```

Download the hit with the 5a yt-dlp command - yt-dlp handles Bandcamp
natively.

### 5e - When the track genuinely isn't public

If nothing on YT / YT Music / SC / BC, the track is Spotify-exclusive
(common for brand-new indie releases in the first few months). Report
this honestly: give the album name and label, and note the release is too
recent to have leaked elsewhere. Don't fake coverage. Don't use
DRM-circumvention tools - that violates Spotify ToS more directly and
increases account suspension risk.

## Step 6 - Verify coverage

```bash
cd ~/Downloads/spotify-playlist
ls *.mp3 | wc -l                    # actual count
grep -c '^https' playlist.spotdl    # target count (JSON lines)
```

If counts don't match, the delta is the retry list. Report:
`"N / TARGET downloaded (PCT%). Missing: <list>, reason: <per-track>"`.

## Credential safety

Keep the Spotify client ID and secret in a local file outside any git repo
or synced folder (see Step 2). Do **not** write them into this skill file,
commit them, or paste them into chat logs beyond what's needed to run the
command.

## Format choice: MP3 320k is correct for Rekordbox

Default is MP3 @ 320k. Don't second-guess it:

- **Rekordbox doesn't support Opus** (long-standing gap). Using `--format
  opus` to skip the MP3 transcode would technically preserve YouTube's
  native bitrate, but the resulting files won't import into Rekordbox.
- **Source ceiling is ~160k Opus anyway** from YouTube/YT Music. FLAC or
  WAV output can't recover information the source never had - it just
  bloats files.
- **320k MP3 is the DJ industry standard.** Beatport, Traxsource, Juno
  all sell 320k MP3. Club PA systems can't resolve higher fidelity.
- Rekordbox track analysis (beatgrid, key, cue) is identical on 320k MP3
  vs FLAC.

**One exception:** Bandcamp fallback tracks. Artists often upload lossless
FLAC masters there, and Rekordbox supports FLAC. If a track matters and it
came from Bandcamp, re-run just that track with `--format flac` in
yt-dlp to get the lossless original. Worth it only for personal
listening - makes no audible difference on a DJ rig.

**True lossless from Spotify** would require DRM circumvention (Zotify +
Premium account). Don't - violates ToS more directly and raises ban risk.
If you need genuine lossless, buy from Bandcamp or Beatport.

## Risk note

Spotify Developer ToS technically prohibits using the API "to enable
downloading of Spotify Content." Using it only for playlist metadata
(which is what spotdl does) is a gray area that's rarely enforced on
small-scale personal use. Realistic risks:

- Developer app credentials revoked: low but non-zero at very high volume
- Listener account suspension: effectively zero documented cases

If paranoid, register a throwaway app under a non-primary Spotify account
and use those credentials.
