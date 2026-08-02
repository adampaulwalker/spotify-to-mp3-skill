# Third-party notices

This extension bundles three executables it invokes as separate processes. It
does not link against any of them, so their terms apply to the binaries as
distributed here, not to this project's own source, which is MIT.

## FFmpeg

- **Licence:** LGPL v2.1 or later
- **Version:** 7.1
- **Upstream:** https://ffmpeg.org
- **Source:** https://ffmpeg.org/releases/ffmpeg-7.1.tar.xz

The bundled binary is built from unmodified upstream source by
`scripts/build-ffmpeg.sh`, which records the exact configure line used. It is
deliberately built **without** `--enable-gpl` and **without** `--enable-nonfree`.

This matters. The convenient prebuilt macOS binaries - `@ffmpeg-installer` and
`ffmpeg-static` - both repackage an upstream build configured
`--enable-gpl --enable-nonfree`. FFmpeg's own position is that a non-free build
may not be redistributed at all, which makes those binaries unusable in anything
shipped to other people. GPL enters only through x264 and x265, which are video
encoders this tool never uses, and MP3 encoding needs no GPL component because
LAME is itself LGPL.

Per the LGPL, the complete corresponding source is available at the upstream URL
above, and the build script here reproduces the binary from it.

## LAME (libmp3lame)

- **Licence:** LGPL v2
- **Upstream:** https://lame.sourceforge.io
- Statically linked into the FFmpeg binary above. Source available from upstream.

## spotDL

- **Licence:** MIT
- **Version:** 4.5.2
- **Upstream:** https://github.com/spotDL/spotify-downloader

Redistributed unmodified as the official release executable.

## yt-dlp

- **Licence:** Unlicense (public domain)
- **Version:** 2026.07.04
- **Upstream:** https://github.com/yt-dlp/yt-dlp

Redistributed unmodified as the official release executable.

## This project

MIT. See `../LICENSE`.

The bundled executables are aggregated with this software, not combined into it:
each is invoked as a separate process over its command-line interface. Under both
the LGPL and the GPL this is mere aggregation, so no copyleft obligation extends
to this project's own source.

## Verifying

Every bundled binary is version-pinned with a SHA-256 checksum in
`vendor/binaries.lock.json`. The FFmpeg build refuses to install a binary whose
own `-version` output reports `--enable-gpl` or `--enable-nonfree`, so a
licence regression fails the build rather than shipping silently.
