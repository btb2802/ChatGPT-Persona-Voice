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

## Current Seed-VC profiles

The checked-in adapter has three explicit host profiles and no CPU fallback:

| Profile id | Host | Accelerator | Requirements lock | Estimated installed / minimum free |
| --- | --- | --- | --- | ---: |
| `darwin-arm64-mps` | Apple Silicon macOS 14.2+ | Apple MPS | `requirements-macos-arm64.lock.txt` | 2.5 GiB / 6 GiB |
| `windows-x64-cuda130` | Windows x64, build 20348+ for the audio route | NVIDIA CUDA 13.0 | `requirements-windows-x64-cuda.lock.txt` | 9 GiB / 15 GiB |
| `linux-x64-cuda130` | Linux x64 | NVIDIA CUDA 13.0 | `requirements-linux-x64-cuda.lock.txt` | 11 GiB / 15 GiB |

All three profiles share the fixed conversion contract:

| Property | Value |
| --- | --- |
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
The qualified profiles compute that one-time CAMPPlus embedding on CPU (`styleDevice: "cpu"`) to
avoid a long variable-shape accelerator compilation during cold start, then move only the finished
embedding to the selected MPS or CUDA device. Diffusion, semantic conversion, and vocoding remain
on that declared accelerator. A CUDA Ready frame must additionally report a non-empty device name,
two-integer compute capability, and the exact `cu130` backend.

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

## Adapter invariants

Every present or future model adapter must:

- fail closed when its exact runtime/profile cannot be proven;
- never synthesize readiness with an identity or hidden fallback engine;
- keep target voice paths and model paths out of renderer control;
- enforce model, code, and voice-reference license/consent requirements;
- bound every queue, message, request, and shutdown wait;
- expose truthful format and latency capabilities rather than relying on model-name heuristics;
- pass the conformance work described in [Model adapters](MODEL_ADAPTERS.md).
