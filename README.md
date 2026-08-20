<h1 align="center">ChatGPT Persona Voice</h1>

<p align="center">
  <strong>Real-time voice changing for ChatGPT (Codex).</strong><br>
  Local-first Seed-VC conversion with near-real-time playback.
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <a href="https://github.com/miuuyy/ChatGPT-Persona-Voice/actions/workflows/ci.yml"><img src="https://github.com/miuuyy/ChatGPT-Persona-Voice/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/app-desktop-black?logo=electron" alt="Desktop app">
  <img src="https://img.shields.io/badge/inference-local-10a37f" alt="Local inference">
  <img src="https://img.shields.io/badge/engine-Seed--VC-7c5cff" alt="Seed-VC engine">
</p>

<p align="center">
  <img src="assets/architecture-visual-v2.png" alt="ChatGPT audio flowing through a local Seed-VC layer to the speaker" width="1200">
</p>

Codex Persona Voice is an independent, local-first desktop relay for ChatGPT and Codex voice
mode. It captures the selected app, suppresses the original voice only after the complete route is
ready, converts speech through a pinned local Seed-VC worker, and sends the converted stream to
your speakers.

The source application still owns the conversation and speech delivery; Persona Voice changes the
target timbre locally without sending voice conversion to a cloud API. Output quality and timing
vary with the machine, source audio, and selected reference.

> [!IMPORTANT]
> Voice conversion currently performs best with Japanese and Chinese source speech. English and
> other languages work, but pronunciation and timbre consistency can vary. Contributions that
> improve multilingual quality, reference preparation, and engine profiles are especially welcome.

## Why Persona Voice

- **Near-real-time conversion.** The current Seed-VC profile processes fixed 300 ms blocks and
  streams 20 ms output frames. A dated M4 Pro engine-only smoke measured 212 ms p95 inference;
  this is not a universal end-to-end latency guarantee.
- **The original voice is replaced, not layered.** A process-scoped native route suppresses the
  selected app only after capture and output are proven ready.
- **Local inference.** Once installed, the locked model runtime performs active conversion
  offline on the selected hardware profile. No voice API key is required.
- **Voice presets and local references.** The included catalog contains credited VOICEVOX
  identities and a small set of community/demo references. Local manifests can add private
  references without committing them to the repository.
- **Personalisation.** Pick a bundled identity, add an authorized private reference, and pair each
  voice with its own character scene without changing the conversion pipeline.
- **Private history controls.** History is off by default. If enabled, only converted output can be
  stored, with six-hour cleanup by default and an immediate clear action.

## How it works

```text
ChatGPT / Codex app
        │ selected process audio
        ▼
Native process-audio route
Core Audio · PipeWire/WirePlumber · WASAPI + owned sink
        │ suppress original route after proof
        │  bounded PCM
        ▼
Local Seed-VC worker ── 300 ms input / 20 ms output frames
        │
        ├──────────────▶ native platform output
        ├──────────────▶ converted-only history
        └──────────────▶ optional macOS BlackHole recording bus
```

Each platform keeps ordinary playback audible while Persona Voice is idle: macOS leaves its tap
detached, Linux uses an owned bypass stream, and the current Windows route keeps bounded passthrough
to the physical output after the user assigns the app to Persona Voice Sink. Conversion engages
only after the platform adapter proves capture and route ownership. The Electron renderer has no
Node.js access; Electron main owns validated IPC, lifecycle, settings, and history.

Read the full [architecture](docs/ARCHITECTURE.md), [native protocol](docs/NATIVE_PROTOCOL.md),
and [engine contract](docs/ENGINE_CONTRACT.md).

## Demo

https://github.com/user-attachments/assets/f43f9f90-a76f-4984-b061-145aa7db5467

The demo is a real 1080p H.264 recording and uses the credited `VOICEVOX:小夜/SAYO` reference.

## Quick start

### Run from source

Requirements:

- Git, Bun 1.3.14, Node.js 22.12+, and [`uv`](https://docs.astral.sh/uv/);
- one qualified host profile: Apple Silicon macOS 14.2+ with MPS, x64 Linux with a supported
  NVIDIA CUDA driver, or x64 Windows build 20348+ with a supported NVIDIA CUDA driver;
- the platform native toolchain: Xcode Command Line Tools on macOS, a C++20 compiler plus
  `pkg-config`/PipeWire development headers on Linux, or MSVC/CMake/Windows SDK on Windows;
- engine space: approximately 2.5 GiB installed and 6 GiB free on macOS, 9 GiB installed and
  15 GiB free on Windows, or 11 GiB installed and 15 GiB free on Linux.

```bash
git clone --recurse-submodules https://github.com/miuuyy/ChatGPT-Persona-Voice.git
cd ChatGPT-Persona-Voice
bun install --frozen-lockfile
bun run setup:engine
bun run dev
```

Linux also needs PipeWire and WirePlumber. The first-run system-audio step can install the owned
per-user ChatGPT/Codex routing policy and restart the user audio services once. Playback pauses
briefly, but Persona Voice stays open. Contributors can inspect or perform the same operation
directly:

```bash
node scripts/linux-audio-policy.cjs install --reload
```

That path is live-proven on Ubuntu 24.04 with WirePlumber 0.4 and on Fedora 42 with PipeWire
1.4.11 / WirePlumber 0.5.14.

Windows requires a Microsoft-signed `Persona Voice Sink` driver package. The elevated app installer
installs/removes only that fixed signed package; repository builds can produce the driver source and
user-mode helpers, but an unsigned local driver is not a clean installable product. The first-run
system-audio step then guides live-route verification. Because the verifier does not silently change
per-app policy, the current flow asks you to open ChatGPT/Codex and start live audio, select
**Persona Voice Sink** under **Settings → System → Sound → Volume mixer**, then return to Persona
Voice to verify and start guarded standby. Quit remains blocked until you restore that app to
**Default** or the physical listening device and confirm restoration; the elevated uninstaller asks
the same before removing the driver. A crash or force-kill can still leave Windows' persisted
per-app preference pointing at the sink, so restoration must be checked manually.

On first launch, choose **English**, **日本語**, or **简体中文** explicitly; Persona Voice never
guesses the interface language. The following support step is optional, and the engine step can be
completed immediately or later from Settings. Linux/Windows also show the platform-audio step
described above. Then start ChatGPT or Codex, select it in Persona
Voice, press **Start**, and enter voice mode. macOS requests Audio Capture permission on first use;
Linux verifies the installed PipeWire/WirePlumber policy; Windows verifies the signed sink and the
current app assignment. The first engine load is slower than later starts because models and the
realtime inference path must be prepared. The interface language can be changed later under
**Settings → Application**.

### Packaged builds and engine installation

The `v0.1.0` release publishes prebuilt macOS and Linux packages. Windows remains source-only until
the owned virtual-sink driver has a Microsoft kernel-policy signature.

The launcher package stays small by keeping the model runtime separate. Open
**Settings → Voice → Install engine** to install the pinned private runtime into application data.
The installer verifies the managed Python runtime, package lock, model revisions, and SHA-256
hashes before publishing the engine atomically. Installation can be cancelled and resumed.

No system Python, terminal command, or voice API key is required for in-app engine installation.
Public distribution remains a separate gate. macOS still needs production signing/notarization and
clean-machine qualification. Linux's packaged policy install/remove/reload UX is implemented but
still needs clean-machine recovery qualification and broader distribution coverage. Windows
packaging refuses to proceed unless
`CODEX_PERSONA_VOICE_SIGNED_DRIVER_DIR` points to a Microsoft kernel-policy-signed driver package;
that external driver-signing gate is not complete.

## Platform status

| Platform | Local engine | Native transparent relay | Current evidence / blocker |
| --- | --- | --- | --- |
| Apple Silicon macOS 14.2+ | MPS profile implemented | Core Audio capture/suppression/output implemented | Live path manually accepted; release signing and clean-machine qualification remain |
| Linux x64 + NVIDIA | CUDA 13.0 profile implemented | PipeWire/WirePlumber per-app policy, in-app setup, capture, suppression, and output implemented | Live Ubuntu 24.04 / WirePlumber 0.4 and Fedora 42 / PipeWire 1.4.11 / WirePlumber 0.5.14 proof; clean packaged recovery and broader distributions remain to qualify |
| Windows x64 + NVIDIA, build 20348+ | CUDA 13.0 profile implemented | WASAPI process capture/output and owned virtual-sink source/contracts implemented | No clean binary until Microsoft signs the driver; physical Windows E2E and explicit Volume Mixer restore remain unqualified |
| Other hosts | No qualified realtime profile | Not qualified | Unsupported |

Implemented source paths are not the same as supported releases. See the detailed
[platform matrix](docs/PLATFORM_MATRIX.md) and [release gates](docs/RELEASE.md).

## Voice references

The bundled catalog currently includes Shikoku Metan, Zundamon, Kasukabe Tsumugi, Meimei Himari,
Kyushu Sora, WhiteCUL, Ouka Miko, Sayo, Haruka Nana, Nekotsuka Aru, Manbetsu
Hanamaru, Kotoyomi Nia, a community JARVIS reference, and an unaffiliated Donald Trump demo
likeness.

VOICEVOX samples are assembled from official showcase audio and retain their required credit.
Community and public-figure references retain their own terms and must never be presented as
authentic speech or endorsement. Use only voices you are authorized to use. See the
[voice manifest](voices/manifest.json) and the single
[third-party notice inventory](THIRD_PARTY_NOTICES.md).

## Safety and privacy

- Raw captured PCM is not intentionally persisted or logged.
- History accepts only converted frames submitted to the output session.
- Idle playback is preserved through the platform's detached tap, owned bypass, or bounded standby
  path; conversion begins only after platform-specific route proof.
- Engine or output faults retain explicit route ownership/uncertainty until the platform-specific
  Stop and restoration flow completes.
- Settings, logs, models, references, and optional history remain in local workspace/application
  storage during use.
- On macOS, BlackHole and OBS are separate trust boundaries. When using the converted-only recording bus,
  mute audio from OBS macOS Screen Capture or it will record the original system stream as well.

Read [Privacy](docs/PRIVACY.md), [Security](SECURITY.md), and
[Troubleshooting](docs/TROUBLESHOOTING.md) before using sensitive audio.

## Development

```bash
bun run test
bun run typecheck
bun run build:renderer
bun run check
bun run smoke:engine
```

| Document | Contents |
| --- | --- |
| [Development](docs/DEVELOPMENT.md) | Setup, checks, native smokes, and contribution workflow |
| [Architecture](docs/ARCHITECTURE.md) | Process boundaries, lifecycle, queues, and persistence |
| [Platform matrix](docs/PLATFORM_MATRIX.md) | Implemented paths and remaining release gates |
| [Native protocol](docs/NATIVE_PROTOCOL.md) | CPV1 framing and bounded audio transport |
| [Engine contract](docs/ENGINE_CONTRACT.md) | CPVE lifecycle and Seed-VC profile |
| [Model adapters](docs/MODEL_ADAPTERS.md) | Rules for integrating another conversion backend |
| [Release engineering](docs/RELEASE.md) | Artifact policy, signing, and publication gates |

## Contributing and license

Contributions are welcome within the current experimental scope. Start with
[CONTRIBUTING.md](CONTRIBUTING.md) and follow the [Code of Conduct](CODE_OF_CONDUCT.md).

Original launcher code is available under the [MIT License](LICENSE). Seed-VC remains GPL-3.0,
and model files, voice references, and dependencies retain their own licenses and terms. See
[Third-party notices](THIRD_PARTY_NOTICES.md).

## Disclaimer

Codex Persona Voice is independent software and is not affiliated with or endorsed by OpenAI.
ChatGPT, Codex, and the OpenAI mark belong to OpenAI. This project does not bypass authentication,
subscriptions, permissions, or access controls.
