# Persona Voice Sink for Windows

This directory contains the production source boundary for the Windows suppression endpoint. The endpoint is a render-only WaveRT null sink: ChatGPT or Codex is assigned to it in Windows Volume Mixer, the relay captures the selected process tree through the documented process-loopback API, and converted audio is rendered to a physical endpoint. The output helper rejects this sink as a playback destination.

## Build and release gate

The user-mode helpers require Windows 10 build 20348 or newer and are built with:

```text
node scripts/windows-build-native.cjs
```

The kernel driver additionally requires Visual Studio 2022, the Windows SDK, and the matching WDK (`WindowsKernelModeDriver10.0`). Build the unsigned Hardware Dev Center submission payload with:

```text
node scripts/windows-build-driver.cjs
```

That output is deliberately **not** a product artifact. Windows 10 and newer require a Microsoft-signed kernel driver package. A release owner must enroll in the Microsoft Hardware Developer Program with the required EV identity, run the applicable HLK/driver validation, submit the package through Hardware Dev Center, download Microsoft's signed result, and then run:

```text
node scripts/windows-build-driver.cjs --verify-signed-package <signed-package-directory>
```

The Windows application/package pipeline must remain fail-closed until that verification passes. Development test certificates, test-signing mode, and unsigned end-user installation are not supported product paths.

## Elevated install/uninstall contract

The native manager is built as `native/bin/win32/cpv-driver-manager.exe` with an embedded `requireAdministrator` manifest. The release installer must place the three Microsoft-signed payload files in the fixed sibling `driver` directory and invoke exactly one of:

```text
native/win32/cpv-driver-manager.exe --self-test
native/win32/cpv-driver-manager.exe --ensure-installed --installer-mode
native/win32/cpv-driver-manager.exe --install
native/win32/cpv-driver-manager.exe --uninstall --installer-mode
```

The manager accepts no package path and no arbitrary elevated command. It resolves only `driver/PersonaVoiceSink.inf`, `driver/cpv-audio-sink.cat`, and `driver/cpv-audio-sink.sys` beside its own executable. It verifies the catalog trust chain and proves that both INF and SYS are catalog members before mutation, stages the INF, creates exactly one `ROOT\CPVAudioSink` device, applies the driver, and requires the marker-backed `Persona Voice Sink` endpoint. `--ensure-installed` is the atomic installer action: one complete existing installation succeeds unchanged, exact absence runs the install transaction, and partial or duplicate state fails closed. `--installer-mode` is restricted to atomic ensure/uninstall and reports only the process exit code so NSIS does not depend on inherited stdout; omitting it keeps the CPV1 JS/IPC contract. A clean-install failure removes the created device and any newly staged INF; an unproven rollback is a distinct fatal error. Uninstall removes every matching device and its discovered OEM INF from Driver Store, reporting a reboot requirement when Windows requests one.

The normal launcher must never silently continue after elevation is declined, signature validation fails, the endpoint count is not exactly one, or rollback is unproven.

## Suppression proof boundary

`cpv-audio-route.exe --suppression-endpoint-id <MMDevice-id> --root-pid <pid>` validates the marker-backed sink, subscribes to every active render endpoint with `IAudioSessionNotification`, tracks session state with `IAudioSessionEvents`, and reaches `engaged` only when every currently active target-tree session is on the sink. Any off-sink target session, incomplete enumeration, device-topology change, or helper failure faults the relay.

Microsoft does not document `OnSessionCreated` as occurring before the first audible sample. Therefore the guard truthfully reports `notificationGuaranteesPreAudio: false`: manual/persisted assignment to the owned sink is the boundary that prevents the original route, while notifications detect drift. Public Windows support must not claim a stronger first-sample guarantee without hardware end-to-end evidence or a documented stronger routing primitive.

The manual Volume Mixer assignment is persistent. The launcher must persist its own conservative `manualRouteConfigured` flag and pass it into `WindowsRouteLifecycle`; after setup it calls `markManualRouteConfigured()`. While Persona Voice is running but conversion is stopped, the lifecycle keeps a low-latency process-loopback-to-physical-output passthrough alive. Start hands the already guarded stream to conversion; Stop returns it to passthrough without releasing the native route. Quit and uninstall are blocked until the UI asks the user to restore the ChatGPT/Codex output device. Cancel calls `cancelManualRestore()` and leaves passthrough live. A currently active off-sink session can be observed, but no documented public API proves that the persistent per-app preference was reset; the result contract keeps `persistentRoutingResetProven: false`.

See [PROVENANCE.md](PROVENANCE.md) and [MS-PL-LICENSE](MS-PL-LICENSE) before redistributing source or binaries.
