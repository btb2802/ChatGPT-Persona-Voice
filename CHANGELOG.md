# Changelog

Notable project changes are documented here. The project has not published a supported production
release; the package version alone does not imply one.

This changelog follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) structure where
practical. Versioning policy remains experimental until public protocols and installers stabilize.

## [Unreleased]

### Added

- Mature repository documentation for development, design, model adapters, the planned engine SDK,
  privacy, troubleshooting, release engineering, and the evidence-driven roadmap.
- MIT license scope for original launcher code plus explicit separation from Seed-VC GPL-3.0 and
  other third-party terms.
- Contribution, conduct, and security policies.
- Cross-platform CI for frozen dependency installation, Node tests, typecheck, and renderer build.
- Structured bug/feature issue forms and pull request checklist.
- One-time GitHub/X support onboarding with fixed, allowlisted external destinations.
- A detached GitHub Releases updater adapted from Codex Web GPT, with exact asset-path binding,
  Ed25519-signed canonical `SHA256SUMS` verification, a pinned Bun worker runtime, and atomic macOS
  application-directory exchange.
- Tag-driven macOS ARM64, Windows x64, and Linux x64 GitHub Release packaging.
- Ten additional VOICEVOX character identities, bringing the catalog to thirteen distinct voices.
- English, Japanese, and Simplified Chinese UI catalogs with an English-first language picker on
  first launch and an in-app language setting.
- Twelve rights-reviewed, project-specific VOICEVOX character scenes that share one validated
  session-card composition; Nurse Robo Type T intentionally retains the generic card because its
  character terms prohibit image-generation AI.
- A credited community JARVIS reference and the pinned Seed-VC Donald Trump example, bringing the
  complete bundled catalog to fifteen voices.

### Changed

- Re-prime the prepared Seed-VC worker at voice-session engagement and allow a bounded 1,000 ms
  conversion backlog so a single cold MPS spike cannot fault an otherwise realtime stream.
- Architecture, CPV1, CPVE, and platform documentation now reflect the current 64-slot capture ring,
  1,000 ms JavaScript queue, 64-buffer output pool, 500 ms output prebuffer target, and CPV1 Status
  frame type 4.
- Latency language now distinguishes configuration/local inference observations from missing
  end-to-end p95 evidence.
- Platform language now labels only the Apple Silicon macOS source checkout as an end-to-end
  development demo and keeps Windows/Linux transparent relays blocked.
- Voice selection now renders an explicit checkmark inside the selected card control.
- Packaged Apple Silicon macOS builds expose a resumable, hash-locked Seed-VC install/remove flow;
  clean-machine qualification and future lock-to-lock migration policy remain open release gates.

### Known limitations

- Packaged engine setup is not yet qualified across clean machines or future lock migrations.
- No production signing or notarization.
- No qualified end-to-end p95 latency result.
- No Windows/Linux transparent audio relay.
- No stable external engine SDK or owned Codex App Server realtime source.

## Historical development milestones

The Git history before this changelog records the initial launcher, fail-closed macOS audio data
plane, and realtime Seed-VC integration. They were development milestones, not supported releases.
