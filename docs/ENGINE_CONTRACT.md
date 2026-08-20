# Voice engine contract

The engine boundary has two layers:

1. an internal Electron adapter lifecycle used by `PipelineRuntime`;
2. the CPVE framed process protocol used by the current Seed-VC adapter.

Both are internal development contracts. There is no published engine SDK or dynamic third-party
adapter loader yet; the proposed stabilization work is tracked in [Engine SDK plan](ENGINE_SDK.md).

## Electron adapter lifecycle

An adapter provides:

```text
probe(config) -> readiness
prepare(config, sourceFormat) -> session

session.outputFormat
session.prime() -> timing
session.convert(frame) -> ordered frame[]
session.reset(itemId) -> void
session.close() -> void
```

### Readiness

`probe` must return a stable diagnostic shape:

```json
{
  "label": "Voice engine",
  "ready": false,
  "code": "engine_not_installed",
  "detail": "No local voice conversion engine is configured"
}
```

Readiness is false when the runtime, weights, hardware profile, or authorized target voice is
missing or invalid. An identity converter is not valid readiness.

### Preparation

- `prepare` receives an exact `f32le` source format with an 8–192 kHz sample rate and one or two
  channels.
- Model load, target conditioning, and required warmup complete before the source observer is armed.
- If the prepared worker has been idle, `prime` repeats the bounded inference warmup after native
  route engagement and before the converted output sink opens. Seed-VC resets its streaming state
  before acknowledging.
- The returned session declares an exact `outputFormat` with `sampleRate`, `channels`, and
  `sampleFormat: "f32le"`.
- Output hardware is not opened by the engine. Electron opens it only after source suppression is
  engaged.
- Only one active engine session is allowed by the current Seed-VC adapter.

### Conversion and reset

- Input and output frames carry unsigned 32-bit sequence numbers, exact format metadata, a positive
  sample count, and byte-length-matched interleaved PCM.
- Output ordering follows input ordering. The runtime serializes conversion work.
- The runtime targets at most 1,000 ms of latency and faults if queued source duration would exceed
  the separate 6,000 ms safety bound or if an output frame
  is longer than 40 ms.
- `reset` clears buffered input and model streaming state before acknowledging. If in-process reset
  fails, the adapter terminates the worker to prove quiescence, invalidates the session, and still
  returns an explicit reset error; worker termination is cleanup evidence, not reset success.
- `close` is idempotent and may not leave work able to emit into a later session.
- Any conversion/protocol/timeout error is terminal to the active relay session.

## CPVE framing

Each CPVE message consists of:

| Offset | Field | Type | Constraint |
| ---: | --- | --- | --- |
| 0 | magic | 4 bytes | ASCII `CPVE` |
| 4 | JSON header bytes | `uint32le` | 1–65,536 |
| 8 | body bytes | `uint32le` | 0–4 MiB |
| 12 | header | UTF-8 JSON | object with string `type` |
| variable | body | bytes | optional `f32le` PCM |

The prefix does not contain an independent version field. The current worker proves
`protocolVersion: 1` in its Ready header. Until an external SDK exists, any incompatible CPVE
change must update Electron, worker, tests, and this document together.

## CPVE message lifecycle

| Direction | Header type | Body | Meaning |
| --- | --- | --- | --- |
| worker → Electron | `status` | empty | Loading/warming progress for logs |
| worker → Electron | `ready` | empty | Profile, formats, block sizes, version, metrics |
| Electron → worker | `prime` | empty | Refresh inference warmup before converted playback |
| worker → Electron | `prime` | empty | Matching acknowledgement with elapsed milliseconds |
| Electron → worker | `convert` | exact source block PCM | Convert request with positive `id` |
| worker → Electron | `result` | converted PCM | Matching `id`, format, samples, elapsed/diagnostic metrics |
| Electron → worker | `reset` | empty | Clear streaming state |
| worker → Electron | `reset` | empty | Matching reset acknowledgement |
| Electron → worker | `shutdown` | empty | Reset and terminate |
| worker → Electron | `shutdown` | empty | Matching shutdown acknowledgement |
| worker → Electron | `error` | empty | Fatal/nonfatal protocol or engine error |

Request ids are unsigned-positive integers in practice and wrap back to 1 after `0xffffffff`.
Electron allows at most one conversion at a time through the serialized adapter path. Current
timeouts are 60 seconds for startup/warmup, 8 seconds for conversion, and 5 seconds for control
requests. A request timeout fails the worker. Engine shutdown seals new preparation, cancels and
drains any worker startup already in flight, and does not return while a replacement worker can
still become active. Correlation requires both the matching id and response type: `convert` accepts
only `result`, `prime` only `prime`, `reset` only `reset`, and `shutdown` only `shutdown`; control
acknowledgements must have an empty body.

## Current Seed-VC profile

The checked-in adapter is intentionally fixed:

| Property | Value |
| --- | --- |
| Supported host | Apple Silicon macOS |
| Accelerator | Apple MPS |
| Model | Seed-VC tiny realtime |
| Diffusion steps | 10 |
| Source format | 8–192 kHz, 1–2 channel `f32le` |
| Input block | 300 ms |
| Acoustic reference prompt | 3 seconds, declared by the worker |
| Speaker-style reference | Up to 17 seconds, declared by the worker |
| Output format | 22,050 Hz, mono `f32le` |
| Output frame | 20 ms |
| Per-session startup discard | 3,000 ms of captured source |

For this fixed profile, a worker Ready message must declare exactly the 300 ms source block implied
by the negotiated source sample rate and exactly 6,615 output frames. Every Result must contain
exactly those 6,615 mono samples. Electron rejects different declarations or result sizes before
they can turn the adapter's pending-input buffer or output expansion into an unbounded queue.

The Ready frame declares both `promptSeconds` and `styleSeconds`, and Electron requires both to
match the launched profile. The acoustic mel/semantic prompt participates in every realtime
diffusion block, so it remains at the upstream-qualified 3 seconds. The CAMPPlus speaker embedding
is computed once from up to 17 seconds (`styleSecondsUsed` reports the available duration). This
lets longer clean references improve speaker identity without lengthening every conversion block.
The qualified profile computes that one-time CAMPPlus embedding on CPU (`styleDevice: "cpu"`) to
avoid a long variable-shape MPS graph compilation during cold start, then moves only the finished
embedding to MPS. Diffusion, semantic conversion, and vocoding remain on Apple MPS.

The worker resamples and downmixes inside the pinned Seed-VC implementation, applies speech/silence
handling and SOLA state, and operates with Hugging Face/Transformers offline flags after setup.
Electron verifies runtime metadata against the current model-lock hash before reporting ready. On
worker startup, before importing Torch or upstream Seed-VC code, Python resolves only the exact
locked offline snapshot paths and rechecks the byte size and SHA-256 of every model artifact. The
venv interpreter runs with Python isolated mode, user-site disabled, and Python/dynamic-loader
injection variables removed from its child environment; the pinned Seed-VC source root is inserted
explicitly only after model verification. Both installed distribution metadata and imported-module
versions must exactly match all four qualified package pins: Torch, Torchaudio, Transformers, and
Hugging Face Hub.

Local benchmark artifacts can inform development, but they are not an end-to-end p95 latency proof.
The 300 ms block, 3-second startup discard, and native output prebuffer all affect user-observed
timing and must be represented in any future benchmark.

### Local smoke observation (not an SLO)

One Apple M4 Pro run of the current development smoke on 2026-08-09 reported:

| Observation | Result |
| --- | ---: |
| Worker ready | 5.326 s |
| Model load within worker | 2.19 s |
| Warmup within worker | 1.00 s |
| Conversion mean | 155.82 ms per 300 ms block |
| Conversion p95 | 217.16 ms per 300 ms block |
| Current MPS allocation | about 1.034 GB |
| MPS driver allocation | about 1.351 GB |
| Converted smoke output | 3.0 s |

The same verification pass rehashed all seven locked model artifacts (about 1.4 GB) in 0.65 s.
These are single-host development observations. The conversion p95 covers engine requests only; it
excludes source capture, the explicit three-second discard, JavaScript scheduling/backpressure,
native output prebuffering/rebuffering, and hardware playback. It must not be quoted as product
first-audio or end-to-end p95 latency.

## Adapter invariants

Every present or future model adapter must:

- fail closed when its exact runtime/profile cannot be proven;
- never synthesize readiness with an identity or hidden fallback engine;
- keep target voice paths and model paths out of renderer control;
- enforce model, code, and voice-reference license/consent requirements;
- bound every queue, message, request, and shutdown wait;
- expose truthful format and latency capabilities rather than relying on model-name heuristics;
- pass the conformance work described in [Model adapters](MODEL_ADAPTERS.md).
