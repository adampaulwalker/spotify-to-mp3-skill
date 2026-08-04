# Failure modes when testing skills and MCPBs

Every item here was hit while building and shipping one Claude Desktop
extension. None came from documentation. They are grouped by *why the test
missed it*, which is more useful than grouping by symptom.

The through-line: **a green test suite meant nothing, three separate times,
because the suite ran somewhere the user never runs.**

---

## 1. Environment gaps - the test ran in the wrong place

The most expensive category. Each of these passed every test and failed for the
user.

### 1.1 Electron is not Node (`process.execPath`)

**Symptom:** user starts a job through Claude Desktop. Job record is created,
phase stays `queued` forever, `trackTotal` never populates, **no log file is
written at all**. From the chat it looks like a download that silently never
starts.

**Cause:** Claude Desktop is Electron. When it hosts an MCP server,
`process.execPath` is the *Claude binary*, not a standalone `node`. Code doing
`spawn(process.execPath, [worker.js, id])` launches a second copy of Claude
Desktop instead of running the script.

**Why every test missed it:** the smoke test, the e2e test, and the skill-test
harness all launched the server with `node server/index.js`. Under plain Node,
`process.execPath` *is* node, so the spawn worked perfectly in all of them.

**Fix:** `env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }`. Harmless when
execPath really is node.

**Generalisation for a test harness:** any MCP server that spawns a child
process must be tested under the actual host runtime, or at minimum with
`process.execPath` pointed at an Electron binary. This class extends to anything
reading `process.execPath`, `process.argv0`, `__dirname` relative to the host, or
assuming a particular Node version.

### 1.2 Gatekeeper quarantine

**Symptom:** bundled binaries killed with **SIGKILL, exit 137, and zero output**
on any machine that downloaded the bundle. Not an error message - silence.

**Cause:** unsigned binaries carrying `com.apple.quarantine`. `spctl -a -t
execute` reports `rejected`.

**Why tests missed it:** **files created locally never get the quarantine
attribute.** The attribute is applied by browsers, mail clients, AirDrop - the
delivery mechanism, not the file. So it is structurally impossible to observe by
testing your own build.

**Fix in the test, not just the product:**

```bash
cp bundle.mcpb /tmp/t.mcpb
xattr -w com.apple.quarantine "0083;0;Safari;$(uuidgen)" /tmp/t.mcpb
unzip -qo /tmp/t.mcpb -d /tmp/tx
/tmp/tx/path/to/binary --version    # must run, not SIGKILL
```

Extracted files inherit quarantine from the archive, which is the real condition.

**Generalisation:** reproduce the *delivery mechanism*, not just the artifact.
Ask what the file goes through between your disk and theirs.

### 1.3 Linking against build-machine libraries

**Symptom:** would have been "command not found"-class failure on any machine
without Homebrew.

**Cause:** Homebrew ships `libmp3lame.a` and `libmp3lame.0.dylib` in one
directory and the macOS linker prefers the dylib. A statically-intended ffmpeg
build came out linked against `/opt/homebrew/opt/lame/lib/libmp3lame.0.dylib`.

**Why it nearly shipped:** it ran flawlessly on the build machine. The build
"succeeded".

**Fix:** hard-fail the build when `otool -L` shows anything outside `/usr/lib`
and `/System`. Originally written as a warning, which was the wrong severity -
see §4.4.

---

## 2. Install and deployment

### 2.1 Same-version install is a no-op

**Symptom:** install the corrected bundle, see the extension's detail page with
an "Uninstall" button, an "Enabled" toggle, and a plausible description. Every
visible signal says success. **The old code keeps running.**

**Cause:** Claude Desktop does not replace an existing extension with the same
name *and* the same `manifest.json` version. It shows what is already installed.

**Why it went unnoticed:** it is genuinely indistinguishable from a successful
install by eye. It was caught only by hashing the installed `server/index.js`
against source.

**Fix:** bump `version` in `manifest.json` for every build intended for install,
and verify by content:

```bash
EXT=~/Library/Application\ Support/Claude/Claude\ Extensions/local.mcpb.<author>.<name>
for f in server/index.js manifest.json; do
  diff <(shasum -a 256 "$EXT/$f" | cut -d' ' -f1) \
       <(shasum -a 256 "./$f" | cut -d' ' -f1) >/dev/null \
    && echo "MATCH $f" || echo "STALE $f"
done
```

**Generalisation:** never accept a UI affirmation as evidence of deployment.
Verify the bytes that are running.

### 2.2 Packaging sweeps in what you did not intend

Twice, in two different ignore files.

- A build directory absent from `.mcpbignore` took a bundle from 2,093 files /
  94 MB to 10,979 files / 181 MB. Nothing in the pack output flagged it.
- The same directory absent from `.gitignore` committed 12,683 files and
  2.2M lines to a public repo.

**Fix:** assert on the artifact's shape, not just that packaging exited 0.

```bash
COUNT=$(unzip -l bundle.mcpb | tail -1 | awk '{print $2}')
[ "$COUNT" -lt 3000 ] || { echo "bundle has $COUNT files - something swept in"; exit 1; }
```

---

## 3. Signing and notarization

### 3.1 Signs cleanly, then refuses to run

PyInstaller onefile binaries extract an embedded Python runtime and its shared
libraries at startup and execute them. The hardened runtime, which notarization
requires, blocks both. `codesign` exits 0 and the binary is dead.

Needs `com.apple.security.cs.allow-unsigned-executable-memory` and
`com.apple.security.cs.disable-library-validation`, scoped to those binaries
only.

**Lesson for a harness:** a zero exit code from a signing tool is not evidence
the artifact still works. **Execute it after signing, before submitting.**
Catching this pre-submission saves a multi-minute Apple round trip.

### 3.2 Transient signing failures

`codesign` intermittently returns `errSecInternalComponent` when signing several
binaries back to back - observed on the only universal (x86_64 + arm64) binary,
which has roughly twice the hashes to compute. An immediate retry succeeds.
Retry once rather than failing the build.

### 3.3 Order dependency

Sign, *then* pack. Packing first notarizes a bundle full of unsigned binaries,
and every check still passes.

---

## 4. Tests that lie

The most dangerous category, because they produce confident wrong answers.

### 4.1 A gate that can only fail

`spctl -a -t install` on a `.mcpb` **always** reports
`rejected: no usable signature` - a `.mcpb` is a zip and a zip carries no
signature. It reported failure on a correctly notarized bundle.

A check that cannot pass trains everyone to ignore it, which is worse than no
check. **Every gate must be able to both pass and fail, and you should confirm
both directions once.**

### 4.2 Timeouts that report "failed" instead of "still running"

A 7-minute deadline in the e2e harness. A 10-track album took under 5 minutes on
a fast connection and over 20 through a VPN. The harness reported **three
separate failures** for runs that were downloading correctly the entire time,
with files landing on disk while the test declared it broken.

**Fix:** generous deadlines, and distinguish *timed out while progressing* from
*failed*. Poll a progress signal; if it is advancing, extend rather than fail.

### 4.3 Reading the wrong artifact

A glob for the newest run directory picked up a different project's run
entirely, and its output was reported as this test's result. Pin the exact
artifact path the harness printed; never re-derive it by "most recent".

### 4.4 Wrong severity

The build-machine-linkage check was written as a `WARNING`. It fired, was noted
in passing, and the defect nearly shipped. Anything that makes an artifact
non-portable is a hard failure, not a warning.

### 4.5 An assertion that never actually ran

A test meant to check opus *decoding* failed at the *encode* step, because the
encoder was not built. It then printed "opus decode NOT available" - a confident
wrong conclusion from a test that never reached the thing under test. Assert on
the specific capability, and make setup failures distinguishable from assertion
failures.

---

## 5. Shell patterns that fail silently

All three produced *exit 1 with no output*, which is maximally confusing.

**`set -euo pipefail` plus a `grep` that finds nothing.** A no-match `grep`
returns 1, `pipefail` fails the pipeline, `set -e` kills the script *at the
assignment* - before the code that would have explained the situation. Absence
of a match is often the expected first-run state.

```bash
IDENTITY="$(security find-identity ... | grep "Developer ID" || true)"
```

**Empty array expansion under `set -u` on bash 3.2**, which is what macOS ships.
`"${ARR[@]}"` on an empty array is an unbound variable error. Use
`"${ARR[@]+"${ARR[@]}"}"` or restructure.

**`$?` after a pipeline** captures the last element's status. `cmd | head` gives
you `head`'s exit code, not `cmd`'s. Capture explicitly.

---

## 6. External flakiness misread as defects

Two failures looked like code bugs and were not:

- **DNS dropping** (VPN cycling) produced `NameResolutionError` mid-download.
  `github.com` resolved fine while `music.youtube.com` did not, so it looked
  selective and code-related.
- **Concurrent jobs competing** for one rate-limited API. A metadata fetch for a
  110-track playlist starved a 10-track album run, which then hit the harness
  timeout and reported failure.

**Fix:** before diagnosing a failure as a defect, check the boundaries -
resolution, reachability, and whether another job is competing. Record which
external services a test depends on, so "is it me or is it them" is answerable.

---

## 7. What to build, for an agent doing this work

1. **Test in the host runtime.** For Claude Desktop, that means Electron with
   `ELECTRON_RUN_AS_NODE`, not plain `node`. This one failure outweighs the rest
   combined.
2. **Reproduce delivery**, not just the artifact: quarantine attributes, a fresh
   user account, a machine without your dev dependencies.
3. **Verify deployment by content hash**, never by a UI affirmation.
4. **Execute after every transformation** - signing, packing, extraction. Exit
   codes describe the tool, not the artifact.
5. **Assert on shape**: file counts, bundle size, linked libraries.
6. **Confirm each gate can pass and fail.** Retire gates that cannot.
7. **Separate "in progress" from "failed"** in anything with a deadline.
8. **Prefer non-hermetic tests at the boundaries.** Every defect above sat at a
   boundary a mock would have hidden. A fully mocked suite here would have been
   green throughout and wrong throughout.

The honest summary: the suite reached 12/12, including a real model driving the
real tools, and the extension still did nothing when the user tried it. The gap
was never coverage. It was that every test ran in an environment the user never
touches.
