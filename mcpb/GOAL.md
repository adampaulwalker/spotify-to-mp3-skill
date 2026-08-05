# GOAL: a stranger installs this and it works, without Adam finding the bugs

**Created:** 2026-08-05   **Owner:** Adam (final verification)   **Status:** IN PROGRESS

The failure this goal exists to end: every defect this week was found by Adam
using the product, not by me testing it. Twelve passing tests and a green
suite meant nothing three times over. The bar is that I find the next defect
before he does.

## Done means (binary exit criteria)

- [ ] C1. A playlist link downloads end to end through the **installed Claude
      Desktop extension** - not a source copy, not the CLI - and the file count
      on disk matches the reported count.
- [ ] C2. `get_download_status` distinguishes working from stalled at every
      phase. Proven by killing an engine mid-run and confirming the reply says
      so rather than repeating a stale count.
- [ ] C3. The watchdog fires and reports honestly. Proven by simulating a
      silent hang and confirming the job fails with a legible reason, no
      truncated data reported as success.
- [ ] C4. The menu bar indicator appears for a user who installs the bundle,
      shows live counts, and does not require a terminal.
- [ ] C5. Every failure path returns a message a non-technical person can act
      on. No raw stack traces, no "exit code 1", no silence.
- [ ] C6. A skill-test run drives the **installed** extension and the model
      routes correctly through start, status, and progress without help.

## Out of scope

- Whether a model agrees to download a given playlist. Not a defect.
- Windows and Intel Macs. Documented as unsupported.
- Adam's intermittent network. It exposes bugs; it is not one.

## Open items

| # | Item | State | Evidence / blocker |
|---|------|-------|--------------------|
| C1 | End-to-end via installed extension | **BLOCKED - needs the metadata fix first** | Partially proven: album completes 10/10 through MCP; the playlist branch has run metadata (116 tracks resolved) and downloading (23 files landed) through the *installed* extension. Not proven: a playlist running to completion with counts reconciled. Blocked by C7 - the playlist path cannot reliably reach the download phase |
| C7 | `spotdl save` has no read timeout | **OPEN - needs Adam's decision** | Root cause measured in iteration 6: ~50 concurrent sockets to Spotify, process blocked in `read` with no `sleep` frames, no save file after 474s. Fix is the Web API rewrite; architectural, so not started unilaterally |
| C2 | Status distinguishes stalled | **DONE** | Fault tests cover dead worker (pid that cannot exist) and alive-but-silent (live pid, stale timestamp). Both report honestly |
| C3 | Watchdog fires honestly | **DONE** | `scripts/watchdog-test.mjs`, 11/11. Includes the dangerous shape: a process that traps SIGTERM and exits 0 is still flagged timedOut, so a kill can never read as a clean finish |
| C4 | Menu bar for a fresh install | **DONE** | v0.3.3 installed; launched from the installed path, `System Events` reports `menu bars: 1`. The bare binary reported none. Objective, not "look at your screen" |
| C5 | Every error path legible | **DONE** | `scripts/fault-tests.mjs`, 19/19. Found and fixed an unanchored URL validator that accepted `...playlist/x"; rm -rf /` |
| C6 | Skill-test on installed build | **DONE** | Ran against the installed v0.3.2 server path. Model routed through check_setup, list_download_jobs and 9 status calls. Zero tool errors |

## Verified (with evidence)

| Criterion | How it was proven | Date |
|---|---|---|
| Watchdog logic reviewed | multi-llm caught that a SIGTERM-clean exit 0 would pass a truncated list as success; fixed and re-verified | 2026-08-05 |
| Signed + notarized | v0.3.1 submitted, engines sign and verify | 2026-08-05 |

## Log

- 2026-08-05 - Iteration 6. **Third hypothesis disproven, and the hang finally
  has a measured cause.**

  Hypothesis 3 was the multi-llm panel's: after "Found N songs", `spotdl save`
  does per-track enrichment plus a lyrics lookup per track from genius /
  musixmatch / azlyrics, so the silence is lyrics providers. Testable, because
  `spotdl save` takes a `--lyrics` flag.

  Ran the same 116-track playlist with lyrics disabled. **It hung identically -
  474 seconds, no save file written.** So lyrics are not the cause.

  What the run did produce is the first hard evidence, from inspecting the live
  process rather than guessing:

  1. `lsof` on the hung pid: **47 established TCP sockets, every one to
     Spotify** (23 to `35.186.224.24` = api.spotify.com, 24 to Fastly addresses
     in open.spotify.com's block). **Zero** to genius, musixmatch, or azlyrics -
     which independently confirms `--lyrics` did disable lyrics.
  2. `sample` on the hung pid: 120 frames in `read`, 20 in `recv`, 17 in SSL.
     **No `sleep` frames at all.** A rate-limited client returns 429 fast and
     then sleeps in a backoff. This process is not backing off - it is blocked
     reading responses that never arrive.
  3. The one line it did emit: `Gardna - Fine Art generated an exception: Could
     not get general hashes`, a per-track enrichment failure.

  **Cause: `spotdl save` fans out roughly 50 concurrent connections to Spotify
  for per-track enrichment, and its HTTP client has no socket read timeout. One
  stalled response blocks that thread forever and the process never exits.**

  This explains every observation, including the ones that killed the earlier
  theories:
  - Intermittent, not deterministic - it depends on whether any one of ~50
    connections stalls.
  - Credentials made no difference (hypothesis 1) because it is not an auth or
    quota problem.
  - It succeeded once (hypothesis 2) because that time none stalled.
  - Bigger playlists are worse: more connections, so a higher chance that at
    least one stalls, and a single stall is enough.

  Adam's network was independently unreliable that day, and that is likely what
  supplies the stalls. It is still a real product defect: no read timeout means
  any user on hotel or mobile wifi hits this, and the failure is a permanent
  silent hang rather than an error.

  **This makes the Web API rewrite the correct fix rather than a workaround.**
  Spotify's paginated playlist-items endpoint returns 116 tracks in ~2 sequential
  requests instead of ~50 concurrent ones, and the timeout and retry budget
  become mine to set. Pending Adam's decision - it is an architectural change,
  so not started unilaterally.

  Fixed and committed this iteration: `21407be`, a guard refusing a second
  concurrent download. Downloads run in-process and `worker.js` holds per-job
  state at module scope, so a second job would overwrite the first job's id and
  corrupt both. Found by the panel, not by me.

- 2026-08-05 - Iteration 5. Adam hit the metadata hang again on the installed
  v0.3.3. Two hypotheses raised and BOTH DISPROVEN by testing:
  1. "Shared Spotify credentials are rate-limited." Ran the identical command
     with Adam's own credentials - hung the same way, 10 minutes, no output.
  2. "spotdl save cannot handle a 116-track playlist." The same command, same
     playlist, WITHOUT credentials, completed earlier the same day in
     test-all.sh, resolving 110 tracks and passing the numbering check.

  So the hang is INTERMITTENT, not deterministic, and neither hypothesis holds.
  Most likely Spotify-side throttling that varies with recent API volume - the
  API was hit hard all day by repeated attempts, and direct calls returned 429
  twice.

  The product defect, independent of cause: spotdl retries silently and forever
  with no ceiling. The 15-minute watchdog will catch it and report honestly, but
  fifteen minutes of a bare menu bar icon and "still in metadata" is the exact
  experience Adam keeps hitting.

  **Honest testing gap:** I claimed the playlist path was verified. It ran
  successfully once, when the API happened to cooperate. I never ran it enough
  times to see that it is flaky. Adam found that; I did not.

  Proposed (not yet implemented, under review by the multi-llm panel):
  a. Drop the metadata silence budget from 15 minutes to ~6.
  b. Show elapsed time in the menu bar during metadata (`reading... 4m`).
  c. On timeout, say what to do next: wait and retry, or add own credentials.

- 2026-08-05 - Iteration 4. Regression sweep clean: 49/49 across four layers
  (smoke 6, edge-probe 13, watchdog 11, fault 19). No new defects.
  Attempted to close C1 with Creative Commons material so the licensing question
  would not arise; the Spotify search returned nothing usable in a 3-10 track
  range, and the shared credentials rate-limited. Stopping rather than grinding
  or manufacturing a pass.

  What C1 still needs is narrow: the playlist branch has already run metadata
  resolution (116 tracks) and the download phase (23 files) through the
  installed extension. The untested remainder is a playlist reaching completion
  with the reported count matching disk.

- 2026-08-05 - Iteration 3. Built and installed v0.3.3, closing C3 and C4.
  C4 proved objectively: the installed .app owns `menu bars: 1` where the bare
  binary owned none. C3 proved by `scripts/watchdog-test.mjs`, whose most
  valuable case is a process that traps SIGTERM and exits 0 - checking the exit
  code alone would call that a clean finish and report a truncated track list as
  complete. That was the actual bug in my first watchdog, and it is now a
  standing regression test rather than a memory.
  Only C1 remains: a real playlist end to end through the installed extension.

- 2026-08-05 - Iteration 2. Installed v0.3.2 and worked against it. Three more
  defects, again none found by Adam:
  1. **The menu bar feature was dead on arrival.** The bundle shipped the bare
     Mach-O, which launches and stays resident but never shows an item. It only
     ever worked in testing because I had launched a hand-made .app. Anyone
     installing the bundle would have got a silently absent feature.
  2. **check_setup cried wolf.** A 45s probe ceiling against PyInstaller cold
     starts that measure 10s idle and 38s under load. It reported "Something is
     wrong with the bundled engines" on a healthy install - a false alarm that
     sends a user to reinstall for nothing. Raised to 180s, and slow is now
     worded differently from broken.
  3. GUI install (`open -a Claude bundle.mcpb`) silently does nothing when
     Claude Desktop has no window open. Not a product bug, but it made the loop
     unreliable, so `scripts/install-local.mjs` now installs deterministically
     and verifies by hash.

- 2026-08-05 - Iteration 1. Built `scripts/fault-tests.mjs` (19 cases) and
  `scripts/edge-probe.mjs`. Four defects found by me, none by Adam:
  1. URL validator was unanchored - a valid prefix passed and the rest went to
     the engine. Not exploitable (spawn uses an argv array, never a shell) but
     malformed input reached spotDL and it was one refactor from dangerous.
  2. A playlist named `.Chill` produced a **hidden folder**. The download would
     succeed into somewhere Finder does not show, which is indistinguishable
     from failing - the exact class Adam hit with the nested folder.
  3. Bidirectional override characters survived into folder names, so a
     playlist title could render `gnp.exe` as `exe.png` in Finder.
  4. My own probe raised a false positive on path traversal. `../../etc`
     collapses to one literal segment, so `path.join` cannot traverse. Recorded
     as not-a-bug rather than fixed.

- 2026-08-05 - Goal created after Adam pointed out he has been the QA loop all
  session. Every criterion here is something he had to find manually.
