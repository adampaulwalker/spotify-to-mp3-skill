# GOAL: the MCPB extension is trustworthy enough to hand to a non-technical user

**Created:** 2026-07-26   **Owner:** Adam (final verification)   **Status:** IN PROGRESS - 2/5 verified, 3 blocked on Adam

## Done means (binary exit criteria)

- [ ] C1. A real Spotify **playlist** link downloads end to end via
      `scripts/e2e.mjs`, files are numbered by list position, and reported
      counts match the files on disk.
- [ ] C2. The vendored ffmpeg's licence is determined from the binary's own
      build configuration, and a `THIRD-PARTY-NOTICES.md` records it plus
      spotDL's and yt-dlp's terms.
- [ ] C3. Gatekeeper behaviour is measured with `com.apple.quarantine` actually
      set on the vendored binaries, answering whether notarization is required
      for the extension to function or only to avoid a warning.
- [ ] C4. A mid-run engine crash is distinguished from ordinary per-track
      unavailability, rather than both reporting `completed`.
- [ ] C5. Codex reviews the final state and no high-severity finding is left
      unresolved or unexplained.

## Out of scope

- **Notarization / code signing.** Needs a paid Apple Developer account and
  Adam's signing identity. C3 measures the impact; it does not remove it.
- **Installing the `.mcpb` into Claude Desktop.** GUI install dialog, human clicks.
- **Windows support.** No test machine, so it stays out of the manifest.
- **Intel Macs.** Impossible: spotDL ships only an arm64 macOS binary.

## Open items

| # | Item | State | Evidence / blocker |
|---|------|-------|--------------------|
| C1 | Playlist end-to-end | BLOCKED | Needs a playlist URL from Adam. Searching for one hit HTTP 429 on spotDL's shared credentials - the documented rate limit, reproduced live |
| C2 | ffmpeg licence | **DECISION NEEDED** | Measured: current binary is `--enable-gpl --enable-nonfree`, which FFmpeg states cannot be redistributed at all. `ffmpeg-static` carries the identical flag - both repackage the same osxexperts build. Homebrew's is clean (`gpl`, no `nonfree`) but `--enable-shared`, so not portable. Needs a source build or a product change |
| C3 | Gatekeeper | **BLOCKED ON ADAM** | Measured: quarantined binary is SIGKILLed (exit 137, zero output); `spctl -a -t execute` returns "rejected". Binaries are adhoc/linker-signed only. Notarization needs a paid Apple Developer account. Mitigation shipped: `check_setup` now names the cause and gives the fix command |
| C4 | Crash vs unavailability | **DONE** | Hardened after Codex round 3 found the mixed case (one real failure logged, then a crash) still reported completed. Evidence gathered: spotDL exits 0 even with an unavailable track (two album runs, engineExit 0), so non-zero + unexplained gaps now means interrupted. Album e2e re-run clean: 10/10 |
| C5 | Codex final review | **DONE** | Round 3 returned 4 findings, all fixed: mixed-case crash detection, `os.arch()` misreading hardware under Rosetta, and a stale `cancelRequested` field. Codex confirmed the marker-file cancellation is race-free |

## Verified (with evidence)

| Criterion | How it was proven | Date |
|---|---|---|
| Single-track download | `e2e.mjs` - `Radiohead - Weird Fishes Arpeggi.mp3` on disk, report written | 2026-07-25 |
| Album download | `e2e.mjs` - 9 of 10 files, numbered `02 - ...`, missing track reported with reason | 2026-07-25 |
| MCP protocol surface | `smoke.mjs` - 6/6 checks pass | 2026-07-25 |
| Intel Mac refusal | `unsupportedPlatformReason()` returns an explanation instead of an opaque exec failure | 2026-07-25 |

## Log
- 2026-07-26 - Codex round 3: 4 findings, all fixed. Album e2e re-run 10/10
  (the track that failed earlier was transient, which the reporting handled
  correctly in both directions). Smoke 6/6.

- 2026-07-25 - Built extension, two Codex review rounds, 15 defects fixed.
- 2026-07-26 - Goal formalised with binary criteria. Five criteria open.
- 2026-07-26 - C4 done. C3 measured and confirmed fatal for downloaded bundles:
  Gatekeeper SIGKILLs the unsigned engines, so the extension cannot work for
  anyone who downloads it until it is notarized. Mitigation added so the failure
  explains itself instead of being silent.
- 2026-07-26 - C2 escalated from paperwork to a real blocker. The vendored
  ffmpeg is a non-free build that cannot legally be redistributed, and the
  obvious alternative package has the same problem.
- 2026-07-26 - C1 attempt hit HTTP 429 on spotDL's shared Spotify credentials,
  reproducing the documented rate limit and confirming the optional-credentials
  setting earns its place.

## Decisions Adam needs to make

1. **Apple Developer account** (~USD 99/year) to notarize. Without it the
   extension works only for people who build it themselves, which is nobody in
   the intended audience. This is the gating decision - the licence question
   below does not matter until this is resolved.
2. **ffmpeg strategy**, pick one:
   - Build a static LGPL ffmpeg from source with only the encoders needed.
     Clean licence, portable, but it is a real build pipeline to maintain.
   - Ship GPL and accept its terms: publish the bundle under GPL with the
     written offer of source. Simplest legally, changes the repo's licence.
   - Default to native M4A and drop ffmpeg entirely. No licence problem, ~35 MB
     smaller, plays on any phone - but no 320k MP3, so it stops serving the
     Rekordbox use case the skill was built for.
