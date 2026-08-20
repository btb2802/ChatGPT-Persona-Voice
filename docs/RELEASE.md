# Release engineering

Status: no supported production release exists.

The repository can build local artifacts, but artifact creation is not release readiness. The only
complete data path is an experimental Apple Silicon macOS 14.2+ preview.

## Current artifact policy

- `bun run package:mac`, `package:win`, and `package:linux` are developer experiments.
- Packaging must run on its target operating system; cross-target invocation fails explicitly.
- Normal CI does not publish. Pushing a `v*` tag matching `package.json` runs the separate release
  workflow on macOS ARM64, Windows x64, and Linux x64 and publishes the resulting GitHub Release.
- Local packaging writes a `SHA256SUMS` file for generated artifacts. This is an integrity aid, not
  signed provenance or release attestation.
- Tag publication discards per-host manifests, regenerates one canonical `SHA256SUMS` covering
  every uploaded artifact and standalone notice, and signs its exact bytes with the offline
  Ed25519 update key.
- Windows/Linux artifacts contain an unsupported shell/discovery experience, not a transparent
  voice relay.
- A macOS artifact contains an in-app engine install/resume/remove path. Engine package migration
  across future lock versions and clean-machine qualification remain release gates.
- Without an explicitly configured signing identity, local macOS packaging is ad hoc. It is not
  notarized or suitable for public distribution.
- A published DMG, ZIP, EXE, or AppImage must remain described as experimental until the relevant
  gates below are complete. GitHub transport and updater compatibility are not support evidence.

## GitHub Releases update channel

The packaged launcher checks `miuuyy/ChatGPT-Persona-Voice` once at startup. Development runs remain
offline with respect to the update channel. A newer release is offered only when all of these are
true:

1. the latest tag is valid semver and newer than the packaged version;
2. the release contains the exact OS/architecture artifact name;
3. the artifact, `SHA256SUMS`, and `SHA256SUMS.sig` URLs resolve to the exact repository/tag path
   over HTTPS;
4. the manifest signature verifies against the public key embedded in the packaged launcher;
5. the downloaded artifact matches its signed SHA-256 entry.

Only then is a detached worker started. The main process first drains/stops the voice relay and
engine; if safe shutdown fails, the worker is cancelled and the installed app is left untouched.
The worker replaces/reinstalls the native artifact and relaunches the application after the parent
process exits. macOS uses a signed native helper and `renameatx_np(RENAME_SWAP)` so a crash before
the exchange leaves the old app in place and a crash after it leaves the new app at the canonical
path. Packaged artifacts carry a pinned Bun 1.3.11 executable solely for this detached worker,
together with its exact version-specific notice.

This signed-manifest updater does not require an Apple developer certificate to authenticate a
release. The private Ed25519 key is not in the repository; tag publication fails closed unless the
protected `release-signing` environment supplies `UPDATE_SIGNING_PRIVATE_KEY`. Apple
code signing and notarization solve a different problem: Gatekeeper trust for a publicly
distributed app and every nested executable. An ad-hoc artifact may update itself correctly and
still be inappropriate to present as a normal trusted public install.

When the repository is private, the desktop client deliberately has no embedded GitHub token, so
unauthenticated update discovery returns no usable release. This is intentional; shipping a
repository token in every client would compromise the private repository. Public repositories use
the same unauthenticated channel and still require the separate manifest signature.

## Packaged macOS engine boundary

The app artifact intentionally excludes the large Python environment and model cache. Its macOS
resources contain a pinned `uv` 0.11.14 bootstrap, the package/model locks, verifier, worker, and
pinned Seed-VC source. **Settings → Voice → Install engine** acquires a private managed Python 3.11,
synchronizes the exact package lock, downloads the seven locked model files, verifies package
metadata and SHA-256 hashes, and only then atomically publishes the runtime beneath Electron's
user-data directory.

The staging directory survives cancellation so Retry can resume downloads. A valid previous
runtime remains active until the replacement passes verification; an interrupted publication is
reconciled on next launch. Remove deletes only the engine runtime, staging area, managed Python, and
installer cache. This mechanism requires network access and at least 6 GiB free, but no terminal,
Homebrew, global Python, GitHub token, or Apple signing credential.

This implements the product path; it does not by itself prove clean-machine behavior across every
supported OS/hardware version or define migration between future engine-lock versions.

## macOS release gates

### Product and recovery

- Clean install on every supported macOS version and hardware class.
- Qualify the implemented engine size/license disclosure, phase progress, cancellation/resume,
  verification, rollback/recovery, version migration, and removal on clean machines.
- Deterministic Audio Capture onboarding and recovery after denial/revocation.
- Failure injection for source/output device changes, helper/engine/app crash, suspend/resume,
  logout, restart, update, downgrade, and uninstall.
- Proof that the original route is restored after every supported stop/crash/uninstall path.

### Performance

- A versioned end-to-end benchmark harness with capture and hardware timestamps.
- p50/p95/p99 first-audio and steady-state added latency on named hardware/OS versions.
- Explicit accounting for the 3-second startup discard policy, 300 ms model blocks, native output
  prebuffer/rebuffer policy, underruns, and device scheduling.
- Long-session queue/memory/thermal evidence and voice-quality review.

Local inference microbenchmarks alone do not satisfy these gates. `startupPrebufferMs: 500` is a
configuration field, not an end-to-end result.

### Security and distribution

- Reviewed entitlements and hardened-runtime behavior.
- Developer ID signing of the app and every nested native/Python executable that ships.
- Verification with `codesign`, Gatekeeper assessment, notarization, and stapling.
- No signing credentials in repository files, logs, or pull requests.
- Reproducible/tagged build procedure and artifact checksums/provenance.
- Security/privacy review of installer, model acquisition, updater, and child-process boundaries.

### Licensing

- MIT license delivery for original launcher code.
- GPL-3.0 license and corresponding-source obligations for the Seed-VC worker distribution.
- Model licenses/terms for every downloaded or redistributed weight.
- VOICEVOX terms, required credits, and reference hashes.
- Community JARVIS reference attribution, source metadata, and reference hash.
- Donald Trump AI-likeness reference attribution, disclosure, pinned upstream path, and reference hash.
- Third-party notices generated/reviewed against the final artifact contents.

## Windows release gates

Windows cannot qualify by packaging the renderer. It needs:

- a process capture implementation;
- a signed, consented virtual endpoint/driver or another route that proves original suppression;
- bounded converted output;
- a qualified engine/accelerator profile and installer;
- driver install/update/removal and crash-recovery tests;
- Authenticode signing and installer reputation/testing;
- the cross-platform gates in [Platform matrix](PLATFORM_MATRIX.md).

WASAPI loopback alone is insufficient because it does not mute the original endpoint.

## Linux release gates

Linux needs:

- owned PipeWire graph objects and stable stream identity;
- atomic reroute/capture/converted-output behavior;
- restoration after stream recreation, device changes, daemon restart, app crash, and uninstall;
- qualified engine profiles and packaging for named distributions/architectures;
- desktop/session coverage and the cross-platform gates in [Platform matrix](PLATFORM_MATRIX.md).

The presence of `pw-dump`, `pw-cli`, and `pw-link` proves tool availability only.

## Release procedure once gates exist

The tag workflow automates artifact transport, but the following qualification sequence still
defines a supported release:

1. Freeze a reviewed scope and write the release notes from the reviewed pull requests.
2. Run frozen install, unit tests, typecheck, renderer build, native tests, engine conformance, and
   permissioned end-to-end qualification on named hosts.
3. Audit dependency/model locks, submodule revision, voices, licenses, notices, and SBOM/provenance.
4. Build from a reviewed tag in a controlled target-host environment.
5. Sign/notarize as required without exposing secrets to untrusted jobs.
6. Verify installed app, nested signatures, engine setup, update/removal, TCC, route recovery,
   history deletion, and benchmark thresholds on clean machines.
7. Publish checksums, support matrix, known limitations, privacy/license notices, and rollback plan.
8. Monitor only through an explicitly reviewed privacy-preserving process; no telemetry should be
   added implicitly for release convenience.

## Versioning

The package currently reports `0.1.0`. A release tag must be exactly `v0.1.0` (or the matching future
package version), otherwise publication fails. Until a public compatibility contract exists,
changes to CPV1/CPVE, settings, and adapter behavior may be breaking and must be called out in the
release notes.

See [Roadmap](ROADMAP.md) for the evidence order and [Security](../SECURITY.md) for reporting.
