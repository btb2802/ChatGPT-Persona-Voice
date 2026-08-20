# Roadmap

This roadmap is evidence-driven and carries no delivery dates. A milestone is complete only when its
tests and artifacts exist in the repository or a reviewed release record.

## Now: make the macOS development demo honest and repeatable

- Keep architecture/protocol/platform documentation synchronized with code.
- Maintain frozen cross-platform shell tests and fail-closed capability reporting.
- Harden route engagement/disengagement, 64-slot capture overflow, bounded conversion backpressure,
  64-buffer output rebuffering, reset, and shutdown failure tests.
- Turn opt-in native/engine smokes into repeatable evidence with named host metadata.
- Define an end-to-end latency harness; stop using inference time or a 500 ms prebuffer value as a
  user-visible latency claim.
- Expand privacy/log-retention and target-voice consent review.

## Gate A: packaged Apple Silicon developer preview

- Qualify the implemented in-app install/resume/remove flow on clean machines and define safe
  migration between future engine-lock versions.
- Clean-machine setup and TCC onboarding.
- Signed nested components, Developer ID build, notarization, and stapling.
- Crash/restart/update/uninstall route-restoration matrix.
- Versioned benchmark results including first-audio, steady state, underruns, memory, and thermals.
- Clear preview support policy and known limitations.

Completion produces a narrowly labeled Apple Silicon macOS preview, not general desktop support.

## Gate B: stable engine boundary

- Extract CPVE schemas, golden vectors, fake engine, and black-box conformance suite.
- Separate the process runner from Seed-VC-specific behavior.
- Define exact capability negotiation, install manifest, provenance, and version rejection.
- Migrate Seed-VC through the generic boundary without a compatibility shim.
- Qualify a second independent adapter before publishing an SDK.

See [Engine SDK plan](ENGINE_SDK.md).

## Gate C: owned Codex realtime source

- Implement an App Server bridge that receives typed realtime PCM before hardware playback.
- Map item ids, interruption/cancellation, and reset semantics into `PipelineRuntime`.
- Prove that owned PCM is never attached to hardware before conversion.
- Keep this backend distinct from interception of an existing ChatGPT/Codex desktop WebRTC session.

Codex CLI discovery today does not satisfy this gate.

## Gate D: platform expansion

### Linux

- Own an isolated PipeWire route with deterministic graph objects.
- Handle stream recreation, device/daemon changes, crash, and uninstall atomically.
- Add bounded output and qualified engine profiles.
- Qualify named distributions, desktop sessions, and architectures.

### Windows

- Select a suppressing endpoint/driver design; process loopback alone is insufficient.
- Establish driver provenance, signing, consent, install/update/removal, and recovery.
- Add bounded capture/output and qualified engine profiles.
- Qualify supported Windows versions/hardware.

No shell artifact becomes a supported relay before its full platform gate passes.

## Later candidates

- Persona speaking-state/level event bridge after the relay contract is stable.
- Additional authorized voice catalogs and model adapters.
- Explicit log retention/export controls.
- Accessibility localization and broader keyboard/screen-reader qualification.
- Privacy-preserving diagnostics export with user review/redaction.

## Non-goals

- Hidden identity/pass-through conversion to make readiness look green.
- Keyword or OS-name routers that override adapter capability evidence.
- Silent model/profile downgrade.
- Shipping unsigned drivers or unverified model downloads.
- Claiming sub-second or p95 latency from a single inference microbenchmark.
- Bundling OpenAI proprietary branding/assets or implying official product status.
