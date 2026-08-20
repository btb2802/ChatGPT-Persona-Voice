<h1 align="center">ChatGPT Persona Voice</h1>

<p align="center">
  <strong>ChatGPT デスクトップアプリが話している最中に、その声を変える。</strong><br>
  ローカルファーストの Seed-VC による、ほぼリアルタイムの再生。
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <a href="https://github.com/miuuyy/ChatGPT-Persona-Voice/actions/workflows/ci.yml"><img src="https://github.com/miuuyy/ChatGPT-Persona-Voice/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/app-desktop-black?logo=electron" alt="デスクトップアプリ">
  <img src="https://img.shields.io/badge/inference-local-10a37f" alt="Local inference">
  <img src="https://img.shields.io/badge/engine-Seed--VC-7c5cff" alt="Seed-VC engine">
</p>

<p align="center">
  <img src="assets/architecture-visual-v2.png" alt="ChatGPT の音声がローカル Seed-VC レイヤーを経由してスピーカーへ流れる構成" width="1200">
</p>

Codex Persona Voice は、ChatGPT と Codex の音声モード向けに作られた、独立した
ローカルファーストのデスクトップ音声リレーです。選択したアプリの音声を取得し、
経路全体の準備が確認できたときだけ元の声を抑制します。その後、バージョン固定された
ローカル Seed-VC ワーカーで声を変換し、変換済みストリームをスピーカーへ送ります。

会話と発話そのものは元のアプリが担い、Persona Voice は声質だけをローカルで変換します。
音声変換をクラウド API へ送信する必要はありません。品質とタイミングは、端末、入力音声、
選択した参照音声によって変わります。

> [!IMPORTANT]
> 現在の音声変換は、日本語と中国語の入力音声で最も良い結果が得られます。英語やその他の
> 言語も動作しますが、発音や声質の一貫性には差が出ることがあります。多言語品質、参照音声
> の準備、エンジンプロファイルを改善するコントリビューションを特に歓迎します。

## Persona Voice を使う理由

- **ほぼリアルタイムの変換。** 現在の Seed-VC プロファイルは固定 300 ms ブロックを
  処理し、20 ms の出力フレームをストリーミングします。日付付きの M4 Pro エンジン単体
  スモークでは p95 推論時間 212 ms を計測しましたが、全環境のエンドツーエンド遅延を
  保証する値ではありません。
- **元の声へ重ねず、置き換える。** プロセス単位のネイティブ音声経路は、取得と出力の
  準備が確認できた後にのみ、選択アプリの元音声を抑制します。
- **ローカル推論。** インストール後、固定済みモデルランタイムは選択されたハードウェア上で
  オフライン変換を行います。音声 API キーは不要です。
- **プリセットとローカル参照音声。** クレジット付き VOICEVOX キャラクターと、少数の
  コミュニティ／デモ参照音声を収録しています。Git に追加せず、ローカル manifest から
  非公開の参照音声を追加することもできます。
- **パーソナライゼーション。** 収録済みの声を選ぶほか、権利を持つ非公開の参照音声を追加し、
  変換パイプラインを変えずに各ボイスへ専用キャラクターシーンを組み合わせられます。
- **ローカル履歴を管理可能。** 履歴は既定で無効です。有効にした場合も保存対象は変換済み
  音声だけで、既定では 6 時間後に自動削除され、すぐに全消去できます。

## 仕組み

```text
ChatGPT / Codex アプリ
        │ 選択プロセスの音声
        ▼
ネイティブのプロセス音声経路
Core Audio · PipeWire/WirePlumber · WASAPI + 専用シンク
        │ 検証後に元の経路を抑制
        │ 有界 PCM
        ▼
ローカル Seed-VC ワーカー ── 300 ms 入力 / 20 ms 出力フレーム
        │
        ├──────────────▶ 各 OS のネイティブ出力
        ├──────────────▶ 変換済み音声のみの履歴
        └──────────────▶ macOS の任意 BlackHole 録音バス
```

待機中の通常再生は各 OS で維持されます。macOS はタップを切り離したままにし、Linux は
所有するバイパスストリームを使い、現在の Windows 経路はユーザーがアプリを Persona Voice
Sink に割り当てた後も物理出力への有界パススルーを維持します。各プラットフォームの
アダプターが取得と経路所有を証明した場合だけ変換が始まります。Electron レンダラーには
Node.js アクセスがなく、検証済み IPC、ライフサイクル、設定、履歴は Electron main が
所有します。

詳しくは[アーキテクチャ](docs/ARCHITECTURE.md)、[ネイティブプロトコル](docs/NATIVE_PROTOCOL.md)、
[エンジン契約](docs/ENGINE_CONTRACT.md)を参照してください。

## デモ

https://github.com/user-attachments/assets/f43f9f90-a76f-4984-b061-145aa7db5467

デモは実際の H.264 MP4 で、クレジット表記された `VOICEVOX:小夜/SAYO` の参照音声を
使用しています。

## クイックスタート

### ソースから実行

必要なもの：

- Git、Bun 1.3.14、Node.js 22.12+、[`uv`](https://docs.astral.sh/uv/)
- 対象となるホストプロファイルのいずれか：MPS を搭載した Apple Silicon macOS 14.2+、
  対応 NVIDIA CUDA ドライバーを備えた x64 Linux、または Windows build 20348+ x64
  と対応 NVIDIA CUDA ドライバー
- 各 OS のネイティブツールチェーン：macOS の Xcode Command Line Tools、Linux の
  C++20 コンパイラーと `pkg-config`／PipeWire 開発ヘッダー、または Windows の
  MSVC／CMake／Windows SDK
- エンジン容量：macOS はインストール約 2.5 GiB・空き 6 GiB、Windows は約 9 GiB・
  空き 15 GiB、Linux は約 11 GiB・空き 15 GiB

```bash
git clone --recurse-submodules https://github.com/miuuyy/ChatGPT-Persona-Voice.git
cd ChatGPT-Persona-Voice
bun install --frozen-lockfile
bun run setup:engine
bun run dev
```

Linux では PipeWire と WirePlumber も必要です。初回のシステム音声セットアップ画面から、
所有する ChatGPT/Codex 用ユーザーポリシーをインストールし、ユーザー音声サービスを
一度再起動できます。再生は短時間中断しますが、Persona Voice 自体は開いたままです。
コントリビューターは同じ処理を直接確認・実行できます。

```bash
node scripts/linux-audio-policy.cjs install --reload
```

この経路は Ubuntu 24.04 / WirePlumber 0.4、および Fedora 42 / PipeWire 1.4.11 /
WirePlumber 0.5.14 で実動確認済みです。

Windows には Microsoft 署名済みの `Persona Voice Sink` ドライバーパッケージが必要です。
昇格したアプリインストーラーだけが固定された署名済みパッケージをインストール／削除します。
リポジトリからドライバーソースとユーザーモードヘルパーをビルドできますが、ローカルで
作った未署名ドライバーはクリーンインストール可能な製品ではありません。初回のシステム
音声ステップが実動経路の検証を案内します。経路ベリファイアーはアプリ別ポリシーを暗黙に
変更しません。現在の手順では ChatGPT/Codex を開いて実際の音声を開始し、**設定 →
システム → サウンド → 音量ミキサー** で出力先を **Persona Voice Sink** に設定してから、
Persona Voice に戻って検証し、保護されたスタンバイを開始します。出力先を **既定** または
物理リスニングデバイスへ戻して確認するまで終了はブロックされ、昇格アンインストーラーも
ドライバー削除前に同じ復元を求めます。クラッシュや強制終了では Windows の永続的な
アプリ別設定がシンクを指したまま残る可能性があるため、手動確認が必要です。

初回起動時に **English**、**日本語**、**简体中文** のいずれかを明示的に選びます。
Persona Voice が表示言語を推測することはありません。続くプロジェクト応援ステップは
任意で、エンジンはその場で設定するか、後から設定できます。Linux／Windows では上記の
システム音声ステップも表示されます。その後、ChatGPT または Codex を起動し、Persona
Voice で対象を選択して **開始** を押し、音声モードを開始します。
macOS は初回に Audio Capture 権限を要求し、Linux はインストール済み
PipeWire/WirePlumber ポリシーを、Windows は署名済みシンクと現在のアプリ割り当てを
検証します。モデルとリアルタイム推論経路を準備するため、エンジンの初回起動は以降より
時間がかかります。表示言語は後から **設定 → アプリケーション** で変更できます。

### パッケージ版とエンジンのインストール

`v0.1.0` リリースでは macOS と Linux のビルド済みパッケージを公開します。Windows は、
専用仮想シンクドライバーが Microsoft のカーネルポリシー署名を取得するまでソースのみです。

モデルランタイムを別配布にすることで、ランチャー本体を小さく保っています。
**設定 → 声 → エンジンをインストール** を開くと、固定済みの非公開ランタイムをアプリ
データへインストールできます。インストーラーは管理対象 Python、パッケージロック、
モデルリビジョン、SHA-256 を検証してから、エンジンをアトミックに公開します。
インストールは中断・再開できます。

アプリ内エンジンインストールには、システム Python、ターミナル操作、音声 API キーは
不要です。一般配布は別のゲートです。macOS には本番署名／公証とクリーンマシン検証、
Linux のパッケージ版ポリシーのインストール／削除／再読み込み UX は実装済みですが、
クリーンマシン回復検証と、より広いディストリビューションでの適格性確認が残っています。Windows の
パッケージ処理は、`CODEX_PERSONA_VOICE_SIGNED_DRIVER_DIR` が
Microsoft のカーネルポリシー署名済みドライバーパッケージを指さない限り拒否されます。
この外部署名ゲートはまだ完了していません。

## プラットフォーム状況

| プラットフォーム | ローカルエンジン | ネイティブ透過リレー | 現在の証拠／ブロッカー |
| --- | --- | --- | --- |
| Apple Silicon macOS 14.2+ | MPS プロファイル実装済み | Core Audio 取得／抑制／出力を実装済み | 実動経路を手動受け入れ済み。リリース署名とクリーンマシン検証は未完了 |
| Linux x64 + NVIDIA | CUDA 13.0 プロファイル実装済み | PipeWire/WirePlumber アプリ別ポリシー、アプリ内セットアップ、取得、抑制、出力を実装済み | Ubuntu 24.04 / WirePlumber 0.4 と Fedora 42 / PipeWire 1.4.11 / WirePlumber 0.5.14 で実動証明済み。クリーンなパッケージ回復と広範なディストリビューションは要検証 |
| Windows x64 + NVIDIA、build 20348+ | CUDA 13.0 プロファイル実装済み | WASAPI プロセス取得／出力と専用仮想シンクのソース／契約を実装済み | Microsoft 署名ドライバーなしではクリーンバイナリ不可。実機 E2E と明示的な音量ミキサー復元は未適格 |
| その他のホスト | 適格なリアルタイムプロファイルなし | 未適格 | 非対応 |

実装済みのソース経路は、サポート対象リリースを意味しません。詳細は
[プラットフォームマトリクス](docs/PLATFORM_MATRIX.md)と
[リリースゲート](docs/RELEASE.md)を参照してください。

## 参照音声

同梱カタログには現在、四国めたん、ずんだもん、春日部つむぎ、冥鳴ひまり、九州そら、
WhiteCUL、櫻歌ミコ、小夜/SAYO、春歌ナナ、猫使アル、満別花丸、
琴詠ニア、コミュニティ版 JARVIS 参照音声、および非公式の Donald Trump デモ音声が
含まれています。

VOICEVOX サンプルは公式ショーケース音声から作成され、必要なクレジットを保持します。
コミュニティおよび著名人の参照音声にはそれぞれの条件が適用され、実在の発言や公式な
推薦として示してはいけません。使用権限のある声だけを利用してください。詳しくは
[voice manifest](voices/manifest.json) と単一の
[third-party notice inventory](THIRD_PARTY_NOTICES.md)を参照してください。

## 安全性とプライバシー

- 取得した生 PCM は意図的に保存・記録されません。
- 履歴が受け取るのは、出力セッションへ渡された変換済みフレームだけです。
- 待機中の再生は、OS ごとの切り離しタップ、所有バイパス、または有界スタンバイ経路で
  維持されます。変換は OS 固有の経路証明後にだけ始まります。
- エンジン／出力障害時は、OS 固有の Stop と復元処理が完了するまで、経路所有または
  不確実状態を明示的に保持します。
- 設定、ログ、モデル、参照音声、任意の履歴は、使用中ローカルのワークスペースまたは
  アプリデータ内に留まります。
- macOS では BlackHole と OBS は別の信頼境界です。変換済み音声のみの録音バスを使う場合、OBS の
  macOS Screen Capture 音声をミュートしてください。そうしないと元のシステム音声も
  同時に録音されます。

機密性の高い音声で試す前に、[プライバシー](docs/PRIVACY.md)、[セキュリティ](SECURITY.md)、
[トラブルシューティング](docs/TROUBLESHOOTING.md)を確認してください。

## 開発

```bash
bun run test
bun run typecheck
bun run build:renderer
bun run check
bun run smoke:engine
```

- [開発ガイド](docs/DEVELOPMENT.md)
- [アーキテクチャ](docs/ARCHITECTURE.md)
- [プラットフォームマトリクス](docs/PLATFORM_MATRIX.md)
- [ネイティブプロトコル](docs/NATIVE_PROTOCOL.md)
- [エンジン契約](docs/ENGINE_CONTRACT.md)
- [モデルアダプター](docs/MODEL_ADAPTERS.md)
- [リリースエンジニアリング](docs/RELEASE.md)

## コントリビューションとライセンス

現在の実験的スコープに沿ったコントリビューションを歓迎します。
[CONTRIBUTING.md](CONTRIBUTING.md) と [行動規範](CODE_OF_CONDUCT.md)をお読みください。

ランチャーのオリジナルコードは [MIT License](LICENSE) で提供されます。Seed-VC は
GPL-3.0 のままであり、モデル、参照音声、依存関係には各自のライセンスと条件が適用
されます。[Third-party notices](THIRD_PARTY_NOTICES.md)も参照してください。

## 免責事項

Codex Persona Voice は独立したソフトウェアであり、OpenAI との提携や承認関係は
ありません。ChatGPT、Codex、OpenAI の商標は OpenAI に帰属します。本プロジェクトは、
認証、サブスクリプション、権限、アクセス制御を回避するものではありません。
