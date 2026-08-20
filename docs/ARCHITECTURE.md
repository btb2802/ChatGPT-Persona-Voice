# Architecture

Status: implemented development path on Apple Silicon macOS; not a release assurance.

## Product boundary

Codex Persona Voice is a standalone desktop audio relay. It is not an MCP server, an OpenAI
component, or a Persona extension. It owns its renderer, settings, process discovery, audio route,
conversion worker, output helper, and local history.

The design invariant is:

> Converted playback may begin only after the selected source proves that its original route is
> suppressed. If that proof or any downstream stage is lost, the relay must fault rather than play
> the original source as a fallback.

This invariant drives the adapter contracts and failure ordering. It does not substitute for the
clean-machine, latency, and release validation still listed in [Release engineering](RELEASE.md).

## Process boundaries

| Process | Responsibility | Trust boundary |
| --- | --- | --- |
| Electron renderer | Presentation and user intent | Sandboxed, context-isolated, no Node.js |
| Electron main | Validated IPC, settings, discovery, pipeline lifecycle, history, logs | Resolves all filesystem paths and child processes |
| `cpv-audio-capture` | macOS process observation, tap ownership, suppression, PCM capture | Native helper over CPV1 stdout |
| Seed-VC worker | Local model load, streaming conversion, SOLA state | Separate GPL Python process over CPVE pipes |
| `cpv-audio-output` | Exact-format converted playback and rebuffering | Native helper over CPV1 stdin/stdout |

The preload exposes a narrow IPC API. Renderer navigation is limited to the local dev-server origin
or the packaged renderer file; new windows are denied. Terms and repository links are opened by
explicit main-process handlers.

## Source backends

### Existing desktop application — implemented on macOS

The current end-to-end path resolves stable application roots for a selected or automatic
ChatGPT/Codex process tree. The native helper refreshes every descendant from those roots while it
runs, so a Chromium `audio.mojom.AudioService` created after relay startup is detected without
restarting either application. It initially observes process I/O without creating a tap, so arming
does not mute the app or open Persona Voice output during WebRTC setup.

When the selected process tree has active input and new audible output, the helper creates a private
Core Audio process tap and aggregate device, verifies the declared PCM format and first frame, then
changes the tap to `CATapMutedWhenTapped`. Only after that proof does it emit `engaged` status and
PCM. After input has stopped for 750 ms, it restores `CATapUnmuted`, closes the active tap, and
returns to `armed`.

Transparent process taps require macOS 14.2 or newer. The installed engine profile additionally
requires Apple Silicon.

### Owned Codex realtime session — contract only

An owned App Server session could receive assistant PCM before hardware playback, which would avoid
OS route interception. The capability is described in the UI and adapter architecture, but the
source bridge is not implemented. Selecting it remains blocked.

### Windows and Linux — discovery only

Windows can enumerate process trees, and Linux can enumerate PipeWire output streams. Neither has a
runtime capture/suppression/output adapter today. WASAPI process loopback alone cannot prove that
the original endpoint is silent; Linux still needs crash-safe ownership of an isolated PipeWire
route. Both platforms fail closed.

## Data path

```text
selected process tree
        │
        ▼
unmuted lifecycle observer ───────────────┐
        │ engaged                         │ armed/disengaged
        ▼                                 ▼
muted Core Audio tap                original route unchanged
        │ CPV1 f32le
        ▼
Electron conversion queue (1,000 ms target; 6,000 ms safety bound)
        │
        ▼
Seed-VC adapter: discard first 3 s → accumulate 300 ms → CPVE convert
        │
        ▼
22.05 kHz mono f32le, split into 20 ms frames
        │
        ├── Core Audio output: 64 buffers, ≤ 40 ms each, 500 ms prebuffer target
        ├── optional BlackHole 2ch mirror (same converted frames)
        └── optional converted-only WAV history
```

Frames carry explicit metadata:

```text
sequence, itemId, capturedAt, sampleRate, channels, sampleFormat, samplesPerChannel, pcm
```

Every active stage validates sample rate, channel count, format, duration, sequence, and PCM byte
length. There is no implicit format guess. A future resampler must be an explicit adapter
capability.

## Lifecycle

### Start and arm

1. Probe source, suppression, engine, and output capabilities.
2. Describe the source format.
3. Prepare and warm the engine for that exact source format.
4. Acquire the native source observer and require `armed === true` with no suppression held.
5. Open source callbacks and transition to `armed`.

No converted output helper exists while merely armed.

Stop is also valid during `starting`: it marks the active startup operation cancelled, invalidates
stale readiness results, waits for any late resource to settle, and uses the normal ordered rollback
before returning to `stopped`. A concurrent restart remains rejected. Application quit first seals
every mutating IPC operation, drains the stopped-state mutation gate and pipeline, then shuts down
the engine; a model worker cannot begin or survive behind that shutdown barrier.

### Engage

1. Native capture proves active duplex process I/O, a valid tap format, a first PCM frame, and
   `originalSuppressed === true`.
2. Electron transitions `armed → engaging`.
3. Electron refreshes the already-loaded engine warmup.
4. Electron creates an exact-format output session.
5. The runtime transitions to `running` and accepts capture frames.
6. The Seed-VC adapter discards the first three seconds for the newly prepared/reset session, then
   begins 300 ms conversions.

Reference conditioning has two explicit bounds. The 3-second acoustic mel/semantic prompt is part
of every diffusion block; a separate CAMPPlus speaker embedding is computed once from up to 17
seconds of the selected reference. Longer voice material therefore improves identity conditioning
without increasing the realtime sequence length.

Frames received before the runtime reaches `running` are ignored; they are never replayed as an
unconverted copy.

### Disengage and stop

When native status returns to `armed`, Electron resets the engine, drains serialized work, closes
the output helper, clears queue accounting, and remains armed for another voice session. Explicit
Stop closes source processing and the engine session, then releases the source observer last.
Every native route boundary is queued as an event with its observed state. Even if `armed` and a
new `engaged` status arrive in the same stdout turn, Electron completes the reset/output-close
boundary before accepting the new session; it does not re-read a later live suppression value and
skip the earlier transition.
If native restoration cannot be proven, the suppression guard remains owned and the renderer shows
`Route restoration unproven`; an unknown route is never converted into a successful stopped state.

The observer owns stable application roots for one relay run and resolves their descendants on each
Core Audio lifecycle pass. A disappearing or replacement Chromium audio-service PID therefore does
not fault the relay: a changed Core Audio process-object set first restores the old tap and returns
the runtime to `armed`, then a newly proved duplex set may engage a replacement tap. If every
application root exits, it restores the route if necessary, emits
`source_process_exited`, and faults. After the application itself relaunches with a new root PID,
Stop and Start deliberately resolve the new root.

Allowed states:

```text
stopped → starting → armed → engaging → running
                    ▲          │           │
                    └──────────┴───────────┘

armed / engaging / running → faulted → stopping → stopped
armed / engaging / running ─────────→ stopping → stopped
```

## Fault semantics

- Failed readiness leaves the relay stopped.
- Startup rollback closes source/output/engine before suppression. If processing cleanup cannot be
  proven, the state stays faulted rather than claiming a clean rollback.
- During an engaged session, invalid PCM, sequence gaps, queue overflow, conversion errors, output
  errors, and timeout failures are terminal for that relay session.
- A processing fault closes converted processing while the suppression session remains held until
  explicit Stop. Silence is preferred to an identity/pass-through fallback.
- If the capture helper exits after explicitly proving restoration, the runtime reports route loss.
  If a process/control failure makes restoration unknowable, the guard reports the conservative
  `suppressionUncertain` state instead of claiming either mute or restoration as fact.
- Shutdown requires engine reset/quiescence before output and suppression release. The JavaScript
  drain timeout is five seconds.

## Bounds and timing

| Boundary | Current value |
| --- | ---: |
| Native capture SPSC ring | 64 slots |
| Maximum native payload | 16 MiB |
| JavaScript queued source duration | 6,000 ms safety bound |
| Seed-VC source block | 300 ms |
| Seed-VC conversion request timeout | 8,000 ms |
| Seed-VC control timeout | 5,000 ms |
| Engine output frame | 20 ms |
| Maximum native output frame | 40 ms |
| Native output pool | 64 buffers |
| Native output startup/rebuffer target | 500 ms |

These are implementation limits, not an end-to-end latency SLO. Local microbenchmarks show that a
warmed ten-step conversion can run faster than a 300 ms block on one M4 Pro setup, but the project
does not yet have a reproducible end-to-end p95 measurement across capture, discard policy,
conversion, buffering, scheduling, and hardware output. In particular, `500 ms` in the output
helper is a prebuffer configuration value, not proof of 500 ms first-audio latency.

## Persistence and privacy

Electron stores state beneath its configured user-data directory. JSON state and history indices
use atomic replacement; POSIX-capable systems receive private directory/file modes where possible.

- Settings include source identity/name, voice selection, history policy, recording-bus choice,
  launch-at-login, and window behavior.
- Logs are JSON Lines diagnostics. They do not intentionally contain PCM, but may contain process
  paths, adapter errors, or child-process stderr. The main log rotates at 5 MiB with three archives;
  rotation is size-based rather than a time-retention promise.
- Raw source PCM is not intentionally persisted. History accepts converted frames only after they
  are submitted to the output session.
- Converted history is PCM16 WAV, segmented by item/format, silence, idle time, or a 20-second
  memory bound. Default retention is six hours; cleanup runs at startup and every five minutes.
- Disabling history stops future writes. It does not delete existing files; Clear history is a
  separate operation.

See [Privacy](PRIVACY.md) for network and deletion boundaries.

## Implemented and missing

Implemented in the development tree:

- Electron shell, renderer, validated preload IPC, tray/autostart, and local state;
- macOS/Windows process discovery and Linux PipeWire stream discovery;
- capability reporting and fail-closed pipeline state machine;
- macOS deferred process observation, engaged muted tap, CPV1 transport, and output helper;
- pinned Apple MPS Seed-VC profile, CPVE worker, thirteen integrity-checked VOICEVOX references,
  one community JARVIS reference, and one upstream Seed-VC Donald Trump AI-likeness reference;
- separate packaged macOS engine acquisition with resumable staging, locked verification, atomic
  publication/recovery, and scoped removal;
- converted-only history and optional converted-only BlackHole mirror;
- explicit language selection followed by one-time support/engine onboarding, plus a GitHub Release
  updater with exact asset/URL binding, an Ed25519-signed SHA-256 manifest, and atomic macOS swap;
- unit/contract tests, native self-tests, and opt-in local smoke commands.

Not ready or not implemented:

- owned Codex App Server realtime bridge;
- Windows or Linux transparent relay adapters;
- Intel macOS/non-MPS engine profiles;
- clean-machine qualification and future lock-to-lock engine migration policy;
- production signing, notarization, and supported installers;
- end-to-end p95 latency evidence and clean-machine recovery testing;
- a stable external engine SDK or Persona event bridge.

## Related contracts

- [Platform matrix](PLATFORM_MATRIX.md)
- [CPV1 native protocol](NATIVE_PROTOCOL.md)
- [Voice engine contract](ENGINE_CONTRACT.md)
- [Model adapter guide](MODEL_ADAPTERS.md)
- [Engine SDK plan](ENGINE_SDK.md)
