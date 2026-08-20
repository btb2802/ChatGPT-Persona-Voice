# CPV1 native audio protocol

CPV1 is the bounded local protocol between Electron main and the macOS capture/output helpers. It
uses child-process pipes: no TCP port, shared audio file, or raw-PCM log is part of the transport.

This is an internal version-1 contract, not a public compatibility promise.

## Framing

All integers are little-endian. Every frame begins with a packed 12-byte header:

| Offset | Field | Type | Constraint |
| ---: | --- | --- | --- |
| 0 | magic | `uint32` | bytes `CPV1` (`0x31565043`) |
| 4 | version | `uint16` | `1` |
| 6 | type | `uint16` | one of the values below |
| 8 | payload bytes | `uint32` | at most 16 MiB |

| Type id | Name | Payload |
| ---: | --- | --- |
| 1 | Ready | UTF-8 JSON with `type: "ready"` |
| 2 | Audio | 16-byte audio metadata followed by interleaved PCM |
| 3 | Error | UTF-8 JSON with `type: "error"` |
| 4 | Status | UTF-8 JSON with `type: "status"` |

Unknown versions/types, oversized payloads, invalid JSON, and truncated frames are terminal parser
errors. Ready, Error, and Status payloads must be JSON objects whose string `type` matches the
binary frame type.

## Audio payload

| Offset | Field | Type | Constraint |
| ---: | --- | --- | --- |
| 0 | sequence | `uint32` | wraps modulo 2^32 |
| 4 | sample rate | `uint32` | 8,000–192,000 Hz |
| 8 | channels | `uint16` | 1 or 2 |
| 10 | sample format | `uint16` | `1` = `f32le` |
| 12 | samples per channel | `uint32` | greater than zero |
| 16 | PCM | bytes | exactly `samples × channels × 4` |

Capture sequence gaps are terminal in Electron. Format changes after preparation are also terminal.

## Capture control messages

The capture helper writes control and audio frames to stdout.

Ready establishes observer state and declared PCM format. Electron currently requires at least:

```json
{
  "type": "ready",
  "helper": "capture",
  "protocolVersion": 1,
  "sampleRate": 48000,
  "channels": 2,
  "sampleFormat": "f32le",
  "supportsArming": true,
  "supportsDeferredTap": true,
  "supportsCaptureProof": true,
  "armed": true,
  "state": "armed",
  "originalSuppressed": false,
  "tapActive": false,
  "activationSignal": "duplex_process_io"
}
```

The sample rate in this example is illustrative; the helper declares the current default output
format. Route lifecycle is carried by Status (`type id 4`):

| State | Required proof |
| --- | --- |
| `armed` | `originalSuppressed: false`, `tapActive: false`, `captureVerified: false` |
| `engaged` | `originalSuppressed: true`, `tapActive: true`, `captureVerified: true` |

Audio is accepted only in `engaged`. The native capture callback writes into a preallocated 64-slot
single-producer/single-consumer ring. Ring overflow emits an Error with suppression state instead of
silently dropping speech. The writer continues to keep the tap owned until explicit cleanup.

The capture helper monitors its Electron owner process and the stable roots of the selected source
application. It resolves descendants again throughout the session because Chromium can create or
replace its Audio Service after the helper starts. The active tap records the exact normalized
Core Audio process-object set it was created for. If that set changes, the helper first restores
and closes the old tap, emits `armed` with reason `voice_audio_process_membership_changed`, and only
then may engage a new tap for the new set. It never reports an old tap as covering new process IDs.
If the owner exits, the helper tears down the active Core Audio resources rather than leaving an
orphaned tap. If every application root exits,
it emits terminal `source_process_exited` after restoration proof; a failed restore emits
`route_disengage_failed` with `suppressionHeld: true`. PCM streaming skips the one slot that may
already have entered the realtime callback before suppression was engaged.

## Output control messages

Electron writes Audio frames to the output helper's stdin. The helper writes Ready, Status, and
Error frames to stdout.

Ready must echo the exact prepared `sampleRate`, `channels`, and `f32le` format. The current helper
also declares:

```json
{
  "type": "ready",
  "helper": "output",
  "protocolVersion": 1,
  "maximumFrameDurationMs": 40,
  "queueCapacityFrames": 64,
  "supportsJitterBuffer": true,
  "startsWhenQueueFull": true,
  "startupPrebufferMs": 500,
  "deviceUid": "resolved-output-device",
  "memberDeviceUids": [],
  "memberDeviceUidsVerified": true,
  "isAggregateDevice": false
}
```

The output helper pins the queue to the resolved device UID, reports active aggregate-device
members plus whether every member UID was verified, and allocates exactly 64 AudioQueue buffers
sized for at most 40 ms each. Converted-only recording-bus setup requires a non-aggregate default
listening device and fails closed when membership cannot be fully attested. Playback starts when
either the 500 ms target or all 64 slots are full, so protocol-valid short frames cannot deadlock
prebuffering. It rejects format changes, zero-length audio, oversized frames, invalid byte lengths,
and unsupported CPV1 messages.

Status (`type id 4`) reports output lifecycle:

- `running` after the jitter buffer is primed or recovered;
- `rebuffering` after starvation, including an underrun count and the 500 ms target.

`startupPrebufferMs: 500` is a configured buffer target. It must not be presented as measured
capture-to-speaker latency.

## Failure rules

- Protocol errors are terminal to the active helper session.
- Capture overflow and sequence gaps never trigger pass-through audio.
- Output starvation transitions through explicit rebuffering; invalid output is rejected.
- Electron retains source suppression on processing faults until Stop can complete ordered cleanup.
- CPV1 has no negotiation beyond its exact version and readiness fields. A breaking change requires
  a new protocol version and matching native/Electron implementations.

See [Architecture](ARCHITECTURE.md) for lifecycle ordering and [Engine contract](ENGINE_CONTRACT.md)
for the separate CPVE sidecar protocol.
