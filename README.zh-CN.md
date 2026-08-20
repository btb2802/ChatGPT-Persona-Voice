<h1 align="center">ChatGPT Persona Voice</h1>

<p align="center">
  <strong>在 ChatGPT 桌面应用说话时，实时替换它的声音。</strong><br>
  通过本地优先的 Seed-VC 实现近实时播放。
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <a href="https://github.com/miuuyy/ChatGPT-Persona-Voice/actions/workflows/ci.yml"><img src="https://github.com/miuuyy/ChatGPT-Persona-Voice/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/app-desktop-black?logo=electron" alt="桌面应用">
  <img src="https://img.shields.io/badge/inference-local-10a37f" alt="Local inference">
  <img src="https://img.shields.io/badge/engine-Seed--VC-7c5cff" alt="Seed-VC engine">
</p>

<p align="center">
  <img src="assets/architecture-visual-v2.png" alt="ChatGPT 音频经过本地 Seed-VC 层后输出到扬声器" width="1200">
</p>

Codex Persona Voice 是一个独立、本地优先的 ChatGPT 与 Codex 语音模式桌面中继器。
它捕获选定应用的音频，只有在整条处理链确认就绪后才抑制原始声音，再通过锁定版本的
本地 Seed-VC 工作进程转换语音，并把转换后的音频发送到扬声器。

对话与发声仍由原应用负责；Persona Voice 只在本地转换目标音色，无需把语音转换发送到
云端 API。输出质量与时序会随设备、输入音频和所选参考而变化。

> [!IMPORTANT]
> 当前语音转换在日语和中文输入上效果最佳。英语及其他语言也可以工作，但发音和音色一致性
> 可能有所波动。我们尤其欢迎帮助改进多语言质量、参考音频处理与引擎配置的贡献。

## 为什么选择 Persona Voice

- **近实时转换。** 当前 Seed-VC 配置处理固定 300 ms 输入块，并流式返回 20 ms 输出帧。
  一次有日期记录的 M4 Pro 纯引擎测试测得 p95 推理耗时为 212 ms；这不是对所有设备的
  端到端延迟承诺。
- **替换原声，而不是叠加播放。** 仅当捕获与输出全部验证就绪后，进程级原生音频路由
  才会抑制选定应用的原始音轨。
- **本地推理。** 安装完成后，锁定版本的模型运行时通过所选硬件配置离线完成实时转换，
  不需要语音 API 密钥。
- **预设声音与私有参考音频。** 内置目录包含标注来源的 VOICEVOX 角色，以及少量社区和
  演示参考。你也可以通过本地 manifest 添加不进入 Git 仓库的私有参考。
- **个性化。** 选择内置音色、添加你有权使用的私有参考音频，并为每个声音搭配独立角色场景，
  无需修改转换流水线。
- **可控的本地历史。** 历史记录默认关闭。启用后也只保存转换后的音频，并默认在六小时后
  自动清理，也可立即清空。

## 工作原理

```text
ChatGPT / Codex 应用
        │ 选定进程的音频
        ▼
原生进程音频路由
Core Audio · PipeWire/WirePlumber · WASAPI + 专用接收端
        │ 验证后抑制原始音轨
        │ 有界 PCM
        ▼
本地 Seed-VC 工作进程 ── 300 ms 输入 / 20 ms 输出帧
        │
        ├──────────────▶ 各平台原生输出
        ├──────────────▶ 仅转换音频历史
        └──────────────▶ macOS 可选 BlackHole 录制总线
```

Persona Voice 待命时，各平台都会维持正常播放：macOS 保持音频 tap 分离，Linux 使用自有
旁路流；在用户把应用分配到 Persona Voice Sink 后，当前 Windows 路由会通过有界直通继续
输出到物理设备。只有平台适配器验证了捕获和路由所有权后才会开始转换。Electron 渲染进程
没有 Node.js 权限；经过验证的 IPC、生命周期、设置与历史都由 Electron 主进程负责。

详细内容参见[架构](docs/ARCHITECTURE.md)、[原生协议](docs/NATIVE_PROTOCOL.md)和
[引擎契约](docs/ENGINE_CONTRACT.md)。

## 演示

<p align="center">
  <a href="assets/demo.mp4"><img src="assets/architecture-visual-v2.png" alt="打开真实的 1080p MP4 Persona Voice 演示" width="960"></a>
</p>

<p align="center">
  <a href="assets/demo.mp4"><strong>▶ 观看 1080p 演示</strong></a>
</p>

演示是实际的 H.264 MP4，并使用已注明出处的 `VOICEVOX:小夜/SAYO` 参考音频。GitHub
不会渲染仓库内的 `<video>` 元素，因此在提供 GitHub user-attachments URL 之前保留上方
直接链接。

## 快速开始

### 从源码运行

你需要：

- Git、Bun 1.3.14、Node.js 22.12+ 和 [`uv`](https://docs.astral.sh/uv/)；
- 以下任一合格主机配置：带 MPS 的 Apple Silicon macOS 14.2+、带受支持 NVIDIA CUDA
  驱动的 x64 Linux，或 Windows build 20348+ x64 与受支持 NVIDIA CUDA 驱动；
- 平台原生工具链：macOS 上的 Xcode Command Line Tools，Linux 上的 C++20 编译器与
  `pkg-config`/PipeWire 开发头文件，或 Windows 上的 MSVC/CMake/Windows SDK；
- 引擎空间：macOS 安装约 2.5 GiB且至少空闲 6 GiB；Windows 安装约 9 GiB且至少空闲
  15 GiB；Linux 安装约 11 GiB且至少空闲 15 GiB。

```bash
git clone --recurse-submodules https://github.com/miuuyy/ChatGPT-Persona-Voice.git
cd ChatGPT-Persona-Voice
bun install --frozen-lockfile
bun run setup:engine
bun run dev
```

Linux 还需要 PipeWire 与 WirePlumber。首次启动的系统音频步骤可以安装自有 ChatGPT/Codex
用户级路由策略，并重启一次用户音频服务。播放会短暂停顿，但 Persona Voice 本身保持打开。
贡献者也可以直接检查或执行同一操作：

```bash
node scripts/linux-audio-policy.cjs install --reload
```

该路径已在 Ubuntu 24.04 / WirePlumber 0.4，以及 Fedora 42 / PipeWire 1.4.11 /
WirePlumber 0.5.14 上完成真实运行验证。

Windows 需要 Microsoft 签名的 `Persona Voice Sink` 驱动包。只有提升权限的应用安装程序
会安装／删除这组固定签名文件。仓库可以构建驱动源码和用户态辅助程序，但本地构建的未签名
驱动不是可在全新系统安装的产品。首次系统音频步骤随后会引导真实路由验证。当前路由验证器
不会静默修改每应用策略。当前流程要求先打开 ChatGPT/Codex 并开始实际音频，再在 **设置 →
系统 → 声音 → 音量混合器** 中把输出设为 **Persona Voice Sink**，然后返回 Persona Voice
验证并启动受保护待命。把输出恢复为 **默认** 或物理播放设备并确认之前，退出会被阻止；提升
权限的卸载程序也会在删除驱动前要求同样的恢复操作。崩溃或强制结束仍可能让 Windows 的
持久每应用首选项指向该接收端，因此必须手动检查恢复状态。

首次启动时，请明确选择 **English**、**日本語** 或 **简体中文**；Persona Voice 不会猜测
界面语言。之后的项目支持步骤完全可选，引擎既可当场设置，也可稍后设置。接着启动 ChatGPT
或 Codex；Linux／Windows 还会显示上述平台音频步骤。在 Persona Voice 中选择该应用，点击
**启动语音转换**，然后进入语音模式。macOS
会在首次使用时请求 Audio Capture 权限；Linux 会验证已安装的 PipeWire/WirePlumber 策略；
Windows 会验证签名接收端与当前应用分配。第一次加载引擎会比后续启动更慢，因为模型和实时
推理路径需要预热。之后可在 **设置 → 应用** 中更改界面语言。

### 打包构建与引擎安装

`v0.1.0` 发布预构建的 macOS 和 Linux 软件包。Windows 在专用虚拟接收端驱动获得
Microsoft 内核策略签名之前仅提供源码。

启动器不会把大型模型运行时塞进安装包。打开 **设置 → 语音 → 安装引擎**，
即可把锁定版本的私有运行时安装到应用数据目录。安装器会验证托管 Python、依赖锁、模型
版本与 SHA-256，然后以原子方式发布引擎；安装可取消并继续。

应用内安装引擎不需要系统 Python、终端命令或语音 API 密钥。公开分发属于另一道门槛：
macOS 仍需生产签名/公证与全新设备验证；Linux 已实现打包版策略安装／删除／重载界面，但仍
需全新设备恢复验证与更广泛发行版覆盖；Windows 打包则会拒绝继续，除非
`CODEX_PERSONA_VOICE_SIGNED_DRIVER_DIR` 指向
通过 Microsoft 内核策略签名的驱动包。这项外部驱动签名门槛尚未完成。

## 平台状态

| 平台 | 本地引擎 | 原生透明中继 | 当前证据／阻断项 |
| --- | --- | --- | --- |
| Apple Silicon macOS 14.2+ | 已实现 MPS 配置 | 已实现 Core Audio 捕获／抑制／输出 | 已手动验收真实路径；仍需发布签名与全新设备验证 |
| Linux x64 + NVIDIA | 已实现 CUDA 13.0 配置 | 已实现 PipeWire/WirePlumber 每应用策略、应用内设置、捕获、抑制与输出 | 已在 Ubuntu 24.04 / WirePlumber 0.4 和 Fedora 42 / PipeWire 1.4.11 / WirePlumber 0.5.14 真实验证；全新打包恢复与更广泛发行版仍待验证 |
| Windows x64 + NVIDIA，build 20348+ | 已实现 CUDA 13.0 配置 | 已实现 WASAPI 进程捕获／输出及专用虚拟接收端源码／契约 | Microsoft 签名驱动完成前没有全新系统可用二进制；真实 Windows E2E 与显式音量混合器恢复尚未验证 |
| 其他主机 | 无合格实时配置 | 未验证 | 不支持 |

源码路径已经实现，不等于已有受支持发行版。详见[平台矩阵](docs/PLATFORM_MATRIX.md)与
[发布门槛](docs/RELEASE.md)。

## 声音参考

内置目录目前包括四国めたん、ずんだもん、春日部つむぎ、冥鳴ひまり、九州そら、
WhiteCUL、櫻歌ミコ、小夜/SAYO、春歌ナナ、猫使アル、満別花丸、
琴詠ニア、社区 JARVIS 参考，以及未获官方关联的 Donald Trump 演示音色。

VOICEVOX 样本由官方展示音频构建，并保留必要署名。社区与公众人物参考继续受各自条款
约束，不得被描述为真实录音或官方背书。请只使用你有权使用的声音。详见
[声音 manifest](voices/manifest.json)与单一的
[第三方声明清单](THIRD_PARTY_NOTICES.md)。

## 安全与隐私

- 原始捕获 PCM 不会被有意保存或写入日志。
- 历史记录只接受已提交给输出会话的转换后帧。
- 待命播放由平台的分离 tap、自有旁路或有界待命路径维持；只有完成平台特定路由验证后
  才开始转换。
- 引擎或输出故障发生后，会明确保持路由所有权或不确定状态，直到完成平台特定的 Stop 与
  恢复流程。
- 设置、日志、模型、参考音频和可选历史在使用期间保留在本地工作区或应用数据中。
- 在 macOS 上，BlackHole 与 OBS 是独立信任边界。使用“仅转换音频”录制总线时，必须在 OBS 中静音
  macOS Screen Capture 的音频，否则 OBS 也会录下原始系统音轨。

处理敏感音频前，请阅读[隐私](docs/PRIVACY.md)、[安全](SECURITY.md)和
[故障排除](docs/TROUBLESHOOTING.md)。

## 开发

```bash
bun run test
bun run typecheck
bun run build:renderer
bun run check
bun run smoke:engine
```

- [开发指南](docs/DEVELOPMENT.md)
- [架构](docs/ARCHITECTURE.md)
- [平台矩阵](docs/PLATFORM_MATRIX.md)
- [原生协议](docs/NATIVE_PROTOCOL.md)
- [引擎契约](docs/ENGINE_CONTRACT.md)
- [模型适配器](docs/MODEL_ADAPTERS.md)
- [发布工程](docs/RELEASE.md)

## 贡献与许可证

欢迎在当前实验性范围内贡献。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和
[行为准则](CODE_OF_CONDUCT.md)。

启动器原创代码采用 [MIT License](LICENSE)。Seed-VC 继续采用 GPL-3.0；模型文件、声音
参考与依赖保留各自许可证和条款。参见[第三方声明](THIRD_PARTY_NOTICES.md)。

## 免责声明

Codex Persona Voice 是独立软件，与 OpenAI 无隶属或背书关系。ChatGPT、Codex 与 OpenAI
标志属于 OpenAI。本项目不会绕过身份验证、订阅、权限或访问控制。
