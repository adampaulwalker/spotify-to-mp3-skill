# Notarizing an MCPB - handoff notes

Written for whoever picks this up next, human or agent. Everything here was
learned by hitting it, not from documentation.

## Why this is necessary

Measured, not assumed. An unsigned binary carrying `com.apple.quarantine` is
killed by Gatekeeper with **SIGKILL, exit 137, and no output whatsoever**.
`spctl -a -t execute` reports `rejected`.

The trap: files you build locally never get the quarantine attribute. So the
extension works flawlessly on the build machine and dies instantly for every
person who downloads it. You cannot discover this by testing your own install.

## Already done on this machine

Do not redo these.

| Thing | Where |
|---|---|
| Apple Developer Program | Active, Team ID `NLVS8YTTQT`, renews 4 Feb 2027 |
| Developer ID Application cert | Login keychain, valid to Aug 2031 |
| Private key + CSR | `~/mcps/credentials/apple/` (perms 600, outside git and sync) |
| Notary credential | Keychain profile `spotify-mcpb-notary` |

So for this project the whole flow is now one command:

```bash
bash scripts/sign-and-notarize.sh
```

## Setting it up from scratch on another machine or project

### 1. Certificate

An **Apple Development** certificate is not sufficient. It only signs builds for
your own devices. Distribution outside the App Store needs **Developer ID
Application**, which is included in the same membership at no extra cost.

Generate the request locally:

```bash
openssl req -new -newkey rsa:2048 -nodes \
  -keyout developerID.key -out developerID.certSigningRequest \
  -subj "/emailAddress=<apple-id>/CN=<name>/C=US"
```

Then at developer.apple.com/account/resources/certificates/add:

- Choose **Developer ID Application**.
- **Choose the G2 Sub-CA intermediary.** The page defaults to "Previous
  Sub-CA", which is the legacy chain.
- Upload the `.certSigningRequest`, download the `.cer`.

A key generated with openssl is a file, and `codesign` cannot see it. Combine
key and certificate into a PKCS#12 and import that, or the identity never
appears:

```bash
openssl pkcs12 -export -legacy -inkey developerID.key \
  -in <(openssl x509 -inform DER -in developerID.cer) \
  -out developerID.p12 -passout pass:temp
security import developerID.p12 -k ~/Library/Keychains/login.keychain-db \
  -P temp -T /usr/bin/codesign
rm developerID.p12
```

Confirm with `security find-identity -v -p codesigning`. You want a line reading
`Developer ID Application: <name> (<team>)` with no `CSSMERR_TP_CERT_REVOKED`.

**Blocker to expect:** if Apple has updated the Program License Agreement,
Certificates is locked entirely until it is accepted. The account page shows a
banner, and the "Certificates, IDs & Profiles" card renders with no links under
it. An agent should not accept that agreement - it is a legal assent in the
account holder's name.

### 2. Notary credential

```bash
xcrun notarytool store-credentials "<profile-name>" \
  --apple-id <apple-id> --team-id <team-id>
```

Both flags matter. Without them the command falls back to interactive mode and
asks for an App Store Connect API key path instead.

It prompts for an **app-specific password** (from appleid.apple.com, Sign-In and
Security), not the Apple ID password. **An agent must not enter this** - hand
the command to the human. It validates against Apple before saving, so a wrong
paste fails immediately rather than surfacing later as a confusing notarization
error.

## The pipeline, and why each step is shaped that way

### Entitlements for PyInstaller binaries

`spotdl` and `yt-dlp` are PyInstaller onefile bundles: they extract an embedded
Python runtime and its shared libraries at startup and execute them. The
hardened runtime, which notarization requires, blocks both. **They sign cleanly
and then refuse to run.**

`scripts/pyinstaller.entitlements` grants exactly two things, and only to those
two binaries:

- `com.apple.security.cs.allow-unsigned-executable-memory`
- `com.apple.security.cs.disable-library-validation`

`ffmpeg` is a plain native binary and gets neither. Keep entitlements as narrow
as they can be.

### Verify by executing, not by exit code

`codesign` exiting 0 does not mean the binary still runs. The script runs each
engine after signing. That check is what caught spotDL, before a wasted round
trip to Apple.

### Sign, then pack - in that order

Packing first notarizes a bundle full of unsigned binaries. The script repacks
after signing for this reason.

### Expect a transient signing failure

`codesign` intermittently returns `errSecInternalComponent` when signing several
binaries back to back. Seen on `yt-dlp`, the only universal (x86_64 + arm64)
binary here, with roughly twice the hashes to compute. An immediate retry
succeeds, so the script retries once.

### Do not verify with `spctl`

`spctl -a -t install` on a `.mcpb` **always** reports
`rejected: no usable signature`. A `.mcpb` is a zip, and a zip carries no
signature - the signatures are on the binaries inside it. This is the wrong
tool, and a check that always fails trains you to ignore it.

Verify like this instead, which is what a downloaded copy actually faces:

```bash
cp bundle.mcpb /tmp/t.mcpb
xattr -w com.apple.quarantine "0083;0;Safari;$(uuidgen)" /tmp/t.mcpb
unzip -qo /tmp/t.mcpb -d /tmp/tx
/tmp/tx/vendor/darwin-arm64/spotdl --version    # must run, not SIGKILL
```

Extracted files inherit the quarantine attribute from the archive, which is
precisely the condition being tested.

## What an agent should not do here

- Accept the Program License Agreement. Legal assent in the account holder's name.
- Enter the app-specific password, or any password, into a command or field.
- Sign in to the Apple ID.

Everything else - generating the key and CSR, driving the certificate creation
flow, importing the identity, signing, submitting, verifying - is fair game and
was done that way.

## Known limitation

A notarization ticket cannot be stapled to a bare Mach-O binary or to a zip, so
Gatekeeper validates online on first run. A machine with no network on that
first launch may still refuse. Not hit in practice here, but it is the remaining
sharp edge.
