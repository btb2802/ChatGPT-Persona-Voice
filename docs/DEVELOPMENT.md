# Development

This guide describes the repository's current development workflow. The complete audio path is
available only on Apple Silicon macOS 14.2 or newer, from either a prepared source checkout or the
experimental packaged preview.

## Prerequisites

### All shell/renderer contributors

- Git
- Bun 1.3.11 (the exact updater-worker runtime pinned by `packageManager`)
- Node.js 22.12 or newer

### End-to-end macOS contributors

- Apple Silicon Mac running macOS 14.2 or newer
- Xcode Command Line Tools (`xcode-select --install`)
- [`uv`](https://docs.astral.sh/uv/)
- network access for the first Bun/Python/model install
- at least 3 GiB free for the current engine runtime, plus dependency and build space

The engine lock requests Python 3.11 through `uv`. Do not replace the locked Python packages or
model revisions with globally installed alternatives.

## Checkout and install

```bash
git clone --recurse-submodules https://github.com/miuuyy/ChatGPT-Persona-Voice.git
cd ChatGPT-Persona-Voice
bun install --frozen-lockfile
```

If the repository was cloned without submodules:

```bash
git submodule update --init --recursive
```

The Seed-VC submodule commit must match `engine/seed-vc/model-lock.json`; setup fails instead of
silently using another revision.

## Engine setup

```bash
bun run setup:engine
```

This command is intentionally restricted to Apple Silicon macOS. It:

1. verifies `uv` and the pinned Seed-VC submodule;
2. creates `runtime/seed-vc/.venv` with Python 3.11;
3. synchronizes the full Python lock;
4. downloads model files at pinned revisions;
5. verifies every recorded SHA-256;
6. writes `runtime/seed-vc/install-manifest.json`;
7. fails if the installed runtime exceeds 15 GiB.

The verified development workspace currently uses about 2.5 GiB. The directory is ignored by Git.
Setup uses the network; inference later forces the model libraries into offline mode.

This command is the source-workspace flow. A packaged app instead exposes **Settings → Voice →
Install engine**, uses its embedded pinned `uv`, and publishes the verified runtime beneath
Electron's user-data directory. See [Release engineering](RELEASE.md).

## Run the app

```bash
bun run dev
```

`dev` builds and self-tests the native helpers before starting Vite and Electron. Start ChatGPT or
Codex first so source discovery has a live process tree. The first real capture should trigger the
macOS Audio Capture permission flow.

To isolate development data from a normal install, set an absolute directory:

```bash
CODEX_PERSONA_VOICE_DATA_DIR=/absolute/path/to/dev-data bun run dev
```

`CODEX_PERSONA_VOICE_CODEX_BIN` may point to an absolute Codex CLI executable for capability
detection. The App Server audio bridge is still unimplemented; detecting the CLI does not enable
that source mode.

## Verification ladder

Run the smallest relevant check while iterating, then the full non-permissioned suite before a PR.

```bash
bun run test
bun run typecheck
bun run build:renderer
bun run check
```

`bun run check` runs the Node tests followed by typecheck and renderer build. CI performs the three
steps explicitly on macOS, Windows, and Linux with `bun install --frozen-lockfile`; the macOS job
also compiles both native helpers with warnings treated as errors.

macOS native checks:

```bash
bun run build:native
bun run test:native
```

The native test command exercises protocol/helper self-tests without selecting a live application
route. It is safe for normal CI only when a macOS runner and toolchain are deliberately provided;
the repository's CI compiles native code but leaves device-dependent helper execution to a named
macOS qualification host.

## Opt-in smoke tests

Engine conversion using a bundled licensed reference/source sample:

```bash
bun run smoke:engine
```

The output is written beneath ignored `artifacts/`. This validates the current CPVE worker path but
does not measure capture-to-speaker p95 latency.

Permissioned live capture:

```bash
bun run smoke:capture:mac
```

Core Audio jitter/rebuffer behavior:

```bash
bun run smoke:output:jitter:mac
```

These smokes affect local audio/TCC state. Run them interactively, stop them cleanly, and include
host/OS/hardware details when reporting results.

## Repository map

| Path | Purpose |
| --- | --- |
| `src/` | React renderer and original Persona Voice design system implementation |
| `src/locales/` | Complete English, Japanese, and Simplified Chinese renderer catalogs |
| `electron/` | Main process, adapters, IPC, persistence, and binary protocol parsers |
| `native/macos/` | Objective-C++ Core Audio capture and output helpers |
| `native/shared/` | CPV1 native protocol layout |
| `engine/seed-vc/` | CPVE worker, model lock, verification, and runtime setup inputs |
| `engine/vendor/seed-vc/` | Pinned GPL-3.0 Seed-VC source submodule |
| `voices/` | Target-voice manifest plus short, integrity-checked WAV references |
| `assets/` | Repository-facing icon, architecture banner, and README demo |
| `src/assets/` | Renderer-bundled character scenes and other UI media |
| `scripts/` | Build, engine download/setup, packaging, and opt-in smoke entry points |
| `tests/` | Node contract/state tests |
| `docs/` | Architecture, protocols, privacy, platform, and release truth |

Model weights, Python environments, caches, native build products, artifacts, history, and logs are
generated into ignored paths. They never belong under `assets/`, `voices/`, or source control.

## Change rules

- Keep changes surgical and preserve fail-closed behavior. Do not add pass-through, identity, or
  best-effort compatibility fallbacks.
- Keep all three locale catalogs on the same complete key and placeholder contract; renderer copy
  must not silently fall back to English.
- Treat source capture, suppression, engine, and output as one transaction. A local convenience may
  not weaken their ordering.
- Add or update tests when changing a protocol field, queue bound, lifecycle state, timeout,
  persistence schema, or capability code.
- Update the matching contract document in the same PR. Protocol docs are part of the change.
- Do not commit model caches, virtual environments, build output, smoke WAVs, logs, or user data.
- Do not add a target voice without authorization evidence, immutable hashes, terms URL, required
  credit, and a privacy/license review.
- Keep third-party code and generated/native assets attributable in `THIRD_PARTY_NOTICES.md`.

## Packaging during development

The package scripts are host-targeted and create local experimental artifacts:

```bash
bun run package:mac
bun run package:win
bun run package:linux
```

Do not call these artifacts supported installers. Windows/Linux lack the audio relay, and macOS
still lacks production signing/notarization, clean-machine qualification, and end-to-end p95
latency proof. The macOS artifact embeds the small installer bootstrap and acquires the 2.5 GiB
engine separately through product UX. Normal CI verifies source contracts only. A matching `v*`
tag invokes the separate release workflow, which builds on each target host, regenerates one
canonical `SHA256SUMS`, and publishes GitHub Release assets for the updater channel.

## Pull requests

Before opening a PR:

1. run `bun install --frozen-lockfile` from a clean dependency state when the lock changed;
2. run `bun run check`;
3. run native/engine checks when their code or contracts changed;
4. confirm the platform matrix still distinguishes implemented, possible, and blocked;
5. review privacy, licensing, and recovery implications;
6. complete the pull request template with exact commands and results.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for issue/PR expectations.
