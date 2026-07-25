# spotify-to-mp3

A Claude Code skill that turns a Spotify playlist link into a folder of tagged
320k MP3s, and keeps going when individual tracks fail.

It wraps [spotDL](https://github.com/spotdl/spotify-downloader): playlist
metadata comes from the Spotify API, audio comes from YouTube Music, YouTube,
SoundCloud, or Bandcamp. Spotify's own audio is DRM-locked and this does not
touch it.

## Where it runs

**Claude Code on macOS.** On Linux, swap the Homebrew commands for your
package manager.

**It does not work in the claude.ai web or desktop chat**, and no version of
this file can change that. Skills in chat run inside a sandbox whose network
allowlist is limited to package managers - PyPI, npm, Yarn, GitHub, Rust
crates, Ubuntu repos, and two Anthropic hosts. On Free, Pro, and Max plans
that allowlist is
[not user-configurable](https://support.claude.com/en/articles/12111783-create-and-edit-files-with-claude);
only Team and Enterprise owners can add domains. `pip install spotdl` will
succeed there and every audio fetch will fail.

## Install

```bash
git clone https://github.com/adampaulwalker/spotify-to-mp3-skill.git
cp -r spotify-to-mp3-skill/spotify-to-mp3 ~/.claude/skills/
```

Restart Claude Code. Confirm it loaded with `/spotify-to-mp3`.

Homebrew is the one prerequisite the agent cannot install for you, because the
installer needs an admin password typed into a real terminal. Step 0 of the
skill detects this and hands you the command.

## Setup

Register a free app at
[developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) and
keep the client ID and secret in a local file outside any git repo or synced
folder. Step 2 of the skill walks through it.

This matters more than it looks: spotDL's default shared credentials are
heavily rate-limited, and 24-hour lockouts are common.

## Usage

Point Claude at a playlist:

> Use the spotify-to-mp3 skill to download this playlist:
> `https://open.spotify.com/playlist/...`

Files land in `~/Downloads/spotify-playlist/`. At the end you get a count of
what downloaded against the playlist total, plus a per-track reason for
anything missing.

## What this adds over running spotDL directly

A first pass of `spotdl download` typically lands around 95% of a playlist and
leaves you to work out the rest by hand. The skill encodes the recovery:

- **Reads the two failure modes differently.** "No results found" means the
  search missed; a yt-dlp download error means the track was found but is
  age-restricted, geo-blocked, or pulled.
- **A fallback chain**, stopping at the first source that works: retry YouTube
  with browser cookies and JS challenge solving, then direct YouTube search,
  then SoundCloud, then Bandcamp.
- **Duration matching.** Candidates are checked against the Spotify track
  length so a search doesn't hand you a 90-minute DJ mix instead of the track.
- **Coverage verification.** Actual file count against playlist count, with
  the delta reported honestly rather than rounded up to "done."
- **Version pinning that matters.** spotDL 4.x breaks under Python 3.14, so
  installation is pinned to 3.13.
- **Format reasoning.** 320k MP3 is the default because Rekordbox cannot read
  Opus and the source ceiling is roughly 160k Opus anyway, so a larger
  container recovers nothing. The one exception is Bandcamp, where artists
  often upload lossless masters worth pulling as FLAC.

## Notes

For personal use. Downloading music you do not have rights to may infringe
copyright and generally violates the terms of service of the sites the audio
comes from. Spotify's developer terms prohibit using their API "to enable
downloading of Spotify Content"; this uses it only for playlist metadata, which
is a gray area rather than a settled one. Check what applies where you live,
and buy from Bandcamp or Beatport when you want a copy you actually own.

The skill will not use DRM-circumvention tools, and says so where a user might
be tempted to reach for one.

## Credits

[spotDL](https://github.com/spotdl/spotify-downloader) and
[yt-dlp](https://github.com/yt-dlp/yt-dlp) do the real work here. This is the
workflow around them.

## License

MIT
