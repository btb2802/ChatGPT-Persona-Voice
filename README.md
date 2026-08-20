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
Native process-audio route ── suppress original route
        │  bounded PCM
        ▼
Local Seed-VC worker ── 300 ms input / 20 ms output frames
        │
        ├──────────────▶ speakers
        ├──────────────▶ converted-only history
        └──────────────▶ optional BlackHole recording bus
```

Persona Voice remains armed without touching normal system audio. It engages only when the native
observer proves that the selected ChatGPT/Codex process is in an active duplex voice session. The
Electron renderer has no Node.js access; Electron main owns validated IPC, lifecycle, settings,
history, and fail-closed state transitions.

Read the full [architecture](docs/ARCHITECTURE.md), [native protocol](docs/NATIVE_PROTOCOL.md),
and [engine contract](docs/ENGINE_CONTRACT.md).

## Demo

<p align="center">
  <video src="assets/demo.mp4" controls playsinline width="960" poster="assets/architecture-visual-v2.png"></video>
</p>

<p align="center">
  <a href="assets/demo.mp4"><strong>▶ Watch the 1080p demo</strong></a>
</p>

The demo uses the credited `VOICEVOX:小夜/SAYO` reference. If GitHub does not render the inline
player in your client, use the direct video link above.

<!--
For the most reliable inline GitHub player after publication, upload the final H.264 MP4 through
the GitHub README editor and replace the video source with the generated user-attachments URL.
-->

## Quick start

### Run from source

Requirements:

- Apple Silicon Mac with macOS 14.2 or newer;
- Xcode Command Line Tools;
- Git, Bun 1.3.11, Node.js 22.12+, and [`uv`](https://docs.astral.sh/uv/);
- roughly 2.5 GiB for the current engine runtime, plus dependency and build space.

```bash
git clone --recurse-submodules https://github.com/miuuyy/ChatGPT-Persona-Voice.git
cd ChatGPT-Persona-Voice
bun install --frozen-lockfile
bun run setup:engine
bun run dev
```

On first launch, choose **English**, **日本語**, or **简体中文** explicitly; Persona Voice never
guesses the interface language. The following support step is optional, and the engine step can be
completed immediately or later from Settings. Then start ChatGPT or Codex, select it in Persona
Voice, press **Start**, and enter voice mode. macOS will request Audio Capture permission on first
use. The first engine load is slower than later starts because models and the realtime inference
path must be prepared. The interface language can be changed later under **Settings → Application**.

### Packaged macOS build

The launcher package stays small by keeping the model runtime separate. Open
**Settings → Voice → Install engine** to install the pinned private runtime into application data.
The installer verifies the managed Python runtime, package lock, model revisions, and SHA-256
hashes before publishing the engine atomically. Installation can be cancelled and resumed.

No system Python, Homebrew, terminal command, API key, or Apple developer certificate is required
for the in-app engine installation. App notarization is a separate distribution concern; current
artifacts are experimental and not yet production-signed or clean-machine qualified.

## Platform status

| Platform | Launcher | Transparent voice relay | Status |
| --- | --- | --- | --- |
| Apple Silicon macOS 14.2+ | Implemented | Implemented | Experimental preview |
| Intel macOS | Renderer builds | Blocked | Unsupported |
| Windows | Shell + process discovery | Not implemented | Unsupported |
| Linux | Shell + PipeWire discovery | Not implemented | Unsupported |

Platform shells deliberately report blockers where the transparent relay is incomplete. There is
no hidden passthrough or identity-converter fallback. See the [platform matrix](docs/PLATFORM_MATRIX.md).

## Voice references

The bundled catalog currently includes Shikoku Metan, Zundamon, Kasukabe Tsumugi, Meimei Himari,
Kyushu Sora, WhiteCUL, Ouka Miko, Sayo, Nurse Robo Type T, Haruka Nana, Nekotsuka Aru, Manbetsu
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
- The original route remains unchanged while armed and is suppressed only after engagement proof.
- Engine or output faults keep suppression held until an explicit Stop can prove restoration.
- Settings, logs, models, references, and optional history remain in local workspace/application
  storage during use.
- BlackHole and OBS are separate trust boundaries. When using the converted-only recording bus,
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
