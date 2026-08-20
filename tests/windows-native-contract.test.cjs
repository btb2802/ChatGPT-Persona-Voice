"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const capture = read("native/windows/ProcessLoopbackCapture.cpp");
const output = read("native/windows/WasapiOutput.cpp");
const route = read("native/windows/AudioPolicyRoute.cpp");
const manager = read("native/windows/DriverManager.cpp");
const managerManifest = read("native/windows/DriverManager.manifest");
const cmake = read("native/windows/CMakeLists.txt");
const inf = read("native/windows/driver/upstream-simpleaudiosample/Source/Main/PersonaVoiceSink.inx");
const miniports = read("native/windows/driver/upstream-simpleaudiosample/Source/Filters/minipairs.h");
const driverBuild = read("scripts/windows-build-driver.cjs");
const releaseGate = read("scripts/windows-release-gate.cjs");
const nativeBuild = read("scripts/windows-build-native.cjs");
const installer = read("installer/windows/installer.nsh");
const packageJson = JSON.parse(read("package.json"));

test("Windows capture uses the documented endpoint-independent process-loopback API", () => {
  assert.match(capture, /ActivateAudioInterfaceAsync\(/);
  assert.match(capture, /VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK/);
  assert.match(capture, /PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE/);
  assert.match(capture, /kMinimumWindowsBuild = 20'348/);
  assert.match(capture, /Microsoft::WRL::FtmBase/);
  assert.match(capture, /supportsSuppression/);
  assert.match(capture, /owned-virtual-endpoint-required/);
});

test("Windows route maintains official session notifications without private policy mutation", () => {
  assert.match(route, /RegisterSessionNotification\(/);
  assert.match(route, /RegisterAudioSessionNotification\(/);
  assert.match(route, /RegisterEndpointNotificationCallback\(/);
  assert.match(route, /supportsCurrentSessionMembershipProof/);
  assert.match(route, /notificationGuaranteesPreAudio/);
  assert.match(route, /restoreRequired.*true/);
  assert.match(route, /standbyPassthroughRequired.*true/);
  assert.match(route, /cpv-persona-voice-sink-v1/);
  assert.doesNotMatch(route, /IAudioPolicyConfig|SetPersistedDefaultAudioEndpoint|RoGetActivationFactory/);
  assert.doesNotMatch(route, /ISimpleAudioVolume|SetMute\(/);
});

test("Windows output is bounded and rejects the suppression endpoint", () => {
  assert.match(output, /kConvertedStartupPrebufferMs = 500/);
  assert.match(output, /kConvertedQueueCapacityMs = 1'500/);
  assert.match(output, /kPassthroughStartupPrebufferMs = 40/);
  assert.match(output, /kPassthroughQueueCapacityMs = 250/);
  assert.match(output, /mode == OutputMode::Passthrough/);
  assert.match(output, /AUDCLNT_BUFFERFLAGS_SILENT/);
  assert.match(output, /output_device_is_suppression_sink/);
  assert.match(output, /isPersonaVoiceSink/);
});

test("Persona Voice driver source exposes one branded render-only sink", () => {
  assert.match(inf, /ROOT\\CPVAudioSink/);
  assert.match(inf, /cpv-audio-sink\.sys/);
  assert.match(inf, /cpv-audio-sink\.cat/);
  assert.match(inf, /PKEY_PersonaVoiceSink_Identity/);
  assert.match(inf, /Persona Voice Sink/);
  assert.doesNotMatch(inf, /KSCATEGORY_CAPTURE/);
  assert.match(miniports, /#define g_cCaptureEndpoints 0/);
});

test("Windows clean-install manager verifies trust and owns device plus INF rollback", () => {
  assert.match(manager, /WinVerifyTrust\(/);
  assert.match(manager, /CryptCATAdminCalcHashFromFileHandle2\(/);
  assert.match(manager, /CryptCATGetMemberInfo\(/);
  assert.match(manager, /SetupCopyOEMInfW\(/);
  assert.match(manager, /UpdateDriverForPlugAndPlayDevicesW\(/);
  assert.match(manager, /SetupDiCallClassInstaller\(DIF_REMOVE/);
  assert.match(manager, /SetupUninstallOEMInfW\(/);
  assert.match(manager, /driver_install_rollback_failed/);
  assert.match(manager, /owned\.size\(\) != 1/);
  assert.match(manager, /--ensure-installed/);
  assert.match(manager, /--installer-mode/);
  assert.match(manager, /emitReady\("ensure-installed"/);
  assert.match(manager, /executableRoot \/ kDriverDirectory/);
  assert.match(manager, /FindResourceW\(/);
  assert.match(manager, /requireAdministrator/);
  assert.doesNotMatch(manager, /--package-dir/);
  assert.match(managerManifest, /level="requireAdministrator"/);
  assert.match(cmake, /\/MANIFESTINPUT:/);
  assert.equal(packageJson.build.nsis.perMachine, true);
  assert.equal(packageJson.build.nsis.allowElevation, true);
  assert.equal(packageJson.build.nsis.include, "installer/windows/installer.nsh");
  assert.match(installer, /--ensure-installed/);
  assert.match(installer, /--uninstall/);
  assert.equal((installer.match(/--installer-mode/g) || []).length, 2);
  assert.match(installer, /Abort/);
});

test("Windows build emits exact runtime names and keeps unsigned driver output out of releases", () => {
  for (const name of [
    "cpv-audio-capture.exe", "cpv-audio-output.exe", "cpv-audio-route.exe", "cpv-driver-manager.exe",
  ]) assert.match(nativeBuild, new RegExp(name.replaceAll(".", "\\.")));
  assert.match(driverBuild, /SignMode=Off/);
  assert.match(driverBuild, /\/t:Clean;Build/);
  assert.match(driverBuild, /conflicting.*outputs/);
  assert.doesNotMatch(driverBuild, /latestFile/);
  assert.match(driverBuild, /--verify-signed-package/);
  assert.match(driverBuild, /"\/kp"/);
  assert.doesNotMatch(driverBuild, /testsigning|bcdedit/i);
  assert.match(releaseGate, /verifyMicrosoftSignedPackage/);
  assert.match(releaseGate, /platform !== "win32"/);
  assert.doesNotMatch(releaseGate, /buildUnsignedDriverSubmission/);
});

test("Windows user-mode native helpers compile with MSVC", {
  skip: process.platform !== "win32",
  timeout: 180_000,
}, () => {
  execFileSync(process.execPath, [path.join(root, "scripts/windows-build-native.cjs")], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
});
