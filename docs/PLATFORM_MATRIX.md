# Platform matrix

This matrix separates code that can render or discover sources from a relay that owns the complete
audio path. `Possible` is an architectural assessment; it must never be presented as `Ready`.

## Current implementation

| Capability | Apple Silicon macOS 14.2+ | Intel macOS | Windows | Linux |
| --- | --- | --- | --- | --- |
| Electron renderer/build | Implemented | Buildable, not relay-qualified | Buildable | Buildable |
| Source discovery | Process tree | Process tree | Process tree | PipeWire output streams via `pw-dump` |
| Existing-app capture | Core Audio process tap | Helper may build, engine unsupported | Not implemented | Not implemented |
| Suppress original route | `CATapMutedWhenTapped` after engagement proof | Not end-to-end qualified | Not available through loopback alone | Isolated route not implemented |
| Converted output | Core Audio helper | Helper may build, engine unsupported | Not implemented | Not implemented |
| Engine setup | Source installer + packaged in-app Seed-VC/MPS installer | Blocked | Blocked | Blocked |
| Transparent relay | Experimental preview | Blocked | Blocked | Blocked |
| Packaged clean install | Implemented; qualification pending | Not implemented | Not implemented | Not implemented |
| Signing/notarization | Local ad hoc only | Not complete | Not complete | N/A / packaging unsigned |
| End-to-end p95 evidence | Not established | Not established | Not established | Not established |
| Supported release | No | No | No | No |

Windows and Linux may run the launcher shell, tests, discovery, and renderer build. Runtime probes
still report capture/suppression/engine/output blockers, so an unsupported shell artifact cannot be
mistaken for a functioning voice relay.

## Apple Silicon macOS development evidence

Present in the repository:

- minimum transparent-tap capability probe for macOS 14.2;
- user-mediated Audio Capture permission copy (TCC is not bypassed);
- deferred lifecycle observation while armed;
- in-place `CATapMutedWhenTapped` engagement after format and first-frame proof;
- 64-slot capture ring and owner-process monitoring;
- exact-format output with 64 AudioQueue buffers, 40 ms maximum frames, and explicit jitter status;
- pinned Apple MPS Seed-VC runtime setup and install-manifest validation;
- packaged in-app acquisition with embedded pinned `uv`, private managed Python, exact package
  synchronization, seven-file hash verification, resumable staging, atomic publication, and
  scoped removal;
- thirteen hash-validated VOICEVOX references, one community JARVIS reference, and one upstream
  Seed-VC Donald Trump AI-likeness reference;
- contract/unit tests, native self-tests, engine smoke, and opt-in live smokes.

Still missing before a supported macOS release:

- clean-machine qualification of engine install/resume/removal and a versioned engine-update
  policy;
- signing identity, hardened-runtime verification of every nested executable, notarization, and
  stapling;
- repeatable permission/onboarding behavior on clean machines;
- automated crash/restart/uninstall recovery evidence on supported OS versions;
- representative end-to-end p50/p95/p99 latency and underrun evidence;
- published support policy and release artifacts built from a reviewed tag.

The checked-in packaging configuration can produce local ad-hoc artifacts with the engine
installer bootstrap. Artifact generation and an isolated clean-runtime smoke are still not a
substitute for the full clean-machine, permission, recovery, and distribution matrix.

## Cross-platform release gates

Every platform must independently prove all of the following:

1. Stable source identity and exact source PCM format.
2. A reversible, crash-safe route that proves the original cannot reach the selected output while
   converted playback is active.
3. A qualified local engine profile with reproducible installation and license inventory.
4. Exact-format bounded output with underrun/overflow behavior.
5. Failure injection for source exit, sequence gaps, queue overflow, engine timeout/crash, output
   loss, device changes, app crash, and OS logout/restart.
6. Clean install, update, downgrade policy, and uninstall recovery.
7. End-to-end latency/quality methodology and published results for named hardware.
8. Platform signing/distribution requirements and third-party license delivery.

## Linux route plan

PipeWire discovery is implemented, but relay ownership is not. A qualifying adapter must create
owned graph objects with deterministic identities, reroute only the selected stream, capture from
the isolated route, and restore topology after stream recreation, device changes, crashes, and
uninstall. Desktop coverage must include supported PipeWire environments; a list of command-line
tools is not itself a route guarantee.

## Windows route plan

WASAPI process loopback can capture a process but does not suppress the application's normal
endpoint. A qualifying path therefore needs a consented, signed virtual endpoint/driver or another
mechanism that can prove original-route silence and deterministic removal. Default-device mutation
is not acceptable without a reversible crash-safe transaction.

## CI scope

Repository CI intentionally runs frozen dependency installation, unit tests, typecheck, and renderer
build across macOS, Windows, and Linux. It does not build native installers, run permissioned audio
smokes, publish artifacts, or imply relay support on a passing shell platform.

See [Release engineering](RELEASE.md) for artifact policy and [Roadmap](ROADMAP.md) for the evidence
sequence.
