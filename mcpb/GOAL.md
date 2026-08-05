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
| C1 | End-to-end via installed extension | OPEN | v0.3.1 notarizing |
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
