<h1 align="center">ChatGPT Persona Voice</h1>

<p align="center">
  <strong>在 ChatGPT 桌面应用说话时，实时替换它的声音。</strong><br>
  在 Apple Silicon 上通过本地 Seed-VC 实现近实时播放。
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <a href="https://github.com/miuuyy/ChatGPT-Persona-Voice/actions/workflows/ci.yml"><img src="https://github.com/miuuyy/ChatGPT-Persona-Voice/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/macOS-Apple%20Silicon-black?logo=apple" alt="Apple Silicon macOS">
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
> 完整透明中继目前只为运行 macOS 14.2 或更高版本的 Apple Silicon Mac 提供实验性
> 预览。Windows 与 Linux 已有应用外壳，但原生捕获、原声抑制、转换和输出链路尚未实现。

## 为什么选择 Persona Voice

- **近实时转换。** 当前 Seed-VC 配置处理固定 300 ms 输入块，并流式返回 20 ms 输出帧。
  一次有日期记录的 M4 Pro 纯引擎测试测得 p95 推理耗时为 212 ms；这不是对所有设备的
  端到端延迟承诺。
- **替换原声，而不是叠加播放。** 仅当捕获与输出全部验证就绪后，进程级 Core Audio
  tap 才会抑制选定应用的原始音轨。
- **本地推理。** 安装完成后，锁定版本的模型运行时通过 Apple MPS 离线完成实时转换，
  不需要语音 API 密钥。
- **预设声音与私有参考音频。** 内置目录包含标注来源的 VOICEVOX 角色，以及少量社区和
  演示参考。你也可以通过本地 manifest 添加不进入 Git 仓库的私有参考。
- **故障时默认阻断。** 权限缺失、引擎异常、不安全的音频路由或队列溢出都会产生明确
  错误，而不会悄悄放出未经转换的声音。
- **可控的本地历史。** 历史记录默认关闭。启用后也只保存转换后的音频，并默认在六小时后
  自动清理，也可立即清空。

## 工作原理

```text
ChatGPT / Codex 应用
        │ 选定进程的音频
        ▼
Core Audio 进程 tap ── 抑制原始音轨
        │ 有界 PCM
        ▼
本地 Seed-VC 工作进程 ── 300 ms 输入 / 20 ms 输出帧
        │
        ├──────────────▶ 扬声器
        ├──────────────▶ 仅转换音频历史
        └──────────────▶ 可选 BlackHole 录制总线
```

Persona Voice 在待命状态下不会改变普通系统音频。只有原生观察器确认所选 ChatGPT/Codex
进程进入活跃的双向语音会话后，中继才会接管。Electron 渲染进程没有 Node.js 权限；
经过验证的 IPC、生命周期、设置、历史与故障阻断状态机都由 Electron 主进程负责。

详细内容参见[架构](docs/ARCHITECTURE.md)、[原生协议](docs/NATIVE_PROTOCOL.md)和
[引擎契约](docs/ENGINE_CONTRACT.md)。

## 演示

<p align="center">
  <video src="assets/demo.mp4" controls playsinline width="960" poster="assets/architecture-visual-v2.png"></video>
</p>

<p align="center">
  <a href="assets/demo.mp4"><strong>▶ 观看 1080p 演示</strong></a>
</p>

演示使用已注明出处的 `VOICEVOX:小夜/SAYO` 参考音频。如果你的 GitHub 客户端没有显示
内嵌播放器，请使用上方的直接视频链接。

## 快速开始

### 从源码运行

你需要：

- 运行 macOS 14.2 或更高版本的 Apple Silicon Mac；
- Xcode Command Line Tools；
- Git、Bun 1.3.11、Node.js 22.12+ 和 [`uv`](https://docs.astral.sh/uv/)；
- 当前引擎运行时约占 2.5 GiB，此外还需要依赖与构建空间。

```bash
git clone --recurse-submodules https://github.com/miuuyy/ChatGPT-Persona-Voice.git
cd ChatGPT-Persona-Voice
bun install --frozen-lockfile
bun run setup:engine
bun run dev
```

首次启动时，请明确选择 **English**、**日本語** 或 **简体中文**；Persona Voice 不会猜测
界面语言。之后的项目支持步骤完全可选，引擎既可当场设置，也可稍后设置。接着启动 ChatGPT
或 Codex，在 Persona Voice 中选择该应用，点击 **启动语音转换**，然后进入语音模式。macOS
会在首次使用时请求 Audio Capture 权限。第一次加载引擎会比后续启动更慢，因为模型和实时
推理路径需要预热。之后可在 **设置 → 应用** 中更改界面语言。

### 打包版 macOS 应用

启动器不会把大型模型运行时塞进安装包。打开 **设置 → 语音 → 安装引擎**，
即可把锁定版本的私有运行时安装到应用数据目录。安装器会验证托管 Python、依赖锁、模型
版本与 SHA-256，然后以原子方式发布引擎；安装可取消并继续。

应用内安装引擎不需要系统 Python、Homebrew、终端命令、API 密钥或 Apple 开发者证书。
应用公证属于另一条分发链路；当前构建仍是实验性产物，尚未完成生产签名与全新设备验证。

## 平台状态

| 平台 | 启动器 | 透明语音中继 | 状态 |
| --- | --- | --- | --- |
| Apple Silicon macOS 14.2+ | 已实现 | 已实现 | 实验性预览 |
| Intel macOS | 可构建渲染器 | 已阻断 | 不支持 |
| Windows | 应用外壳 + 进程发现 | 未实现 | 不支持 |
| Linux | 应用外壳 + PipeWire 发现 | 未实现 | 不支持 |

当透明中继不完整时，平台外壳会明确报告阻断原因；项目没有隐藏的原声直通或身份转换
fallback。参见[平台矩阵](docs/PLATFORM_MATRIX.md)。

## 声音参考

内置目录目前包括四国めたん、ずんだもん、春日部つむぎ、冥鳴ひまり、九州そら、
WhiteCUL、櫻歌ミコ、小夜/SAYO、ナースロボ＿タイプＴ、春歌ナナ、猫使アル、満別花丸、
琴詠ニア、社区 JARVIS 参考，以及未获官方关联的 Donald Trump 演示音色。

VOICEVOX 样本由官方展示音频构建，并保留必要署名。社区与公众人物参考继续受各自条款
约束，不得被描述为真实录音或官方背书。请只使用你有权使用的声音。详见
[声音 manifest](voices/manifest.json)与单一的
[第三方声明清单](THIRD_PARTY_NOTICES.md)。

## 安全与隐私

- 原始捕获 PCM 不会被有意保存或写入日志。
- 历史记录只接受已提交给输出会话的转换后帧。
- 待命时原始路由保持不变；只有确认进入语音会话后才会抑制原声。
- 引擎或输出故障发生后，抑制会保持到显式 Stop 能确认原始路由已恢复。
- 设置、日志、模型、参考音频和可选历史在使用期间保留在本地工作区或应用数据中。
- BlackHole 与 OBS 是独立信任边界。使用“仅转换音频”录制总线时，必须在 OBS 中静音
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
