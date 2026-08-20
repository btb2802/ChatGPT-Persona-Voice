"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const UNUSED_MACOS_PLIST_KEYS = Object.freeze([
  "NSMicrophoneUsageDescription",
  "NSCameraUsageDescription",
  "NSBluetoothAlwaysUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
  "NSAppTransportSecurity",
]);

function hardenMacInfoPlist(applicationPath) {
  const infoPath = path.join(applicationPath, "Contents", "Info.plist");
  const read = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", infoPath], {
    encoding: "utf8",
  });
  if (read.error) throw read.error;
  if (read.status !== 0) throw new Error(`Unable to inspect packaged Info.plist: ${read.stderr.trim()}`);
  const info = JSON.parse(read.stdout);
  for (const key of UNUSED_MACOS_PLIST_KEYS) {
    if (!Object.hasOwn(info, key)) continue;
    const removed = spawnSync("/usr/bin/plutil", ["-remove", key, infoPath], { encoding: "utf8" });
    if (removed.error) throw removed.error;
    if (removed.status !== 0) {
      throw new Error(`Unable to remove ${key} from packaged Info.plist: ${removed.stderr.trim()}`);
    }
  }
}

async function applyElectronFuses(context) {
  const { FuseVersion, FuseV1Options, flipFuses } = await import("@electron/fuses");
  const extension = {
    darwin: ".app",
    mas: ".app",
    win32: ".exe",
    linux: "",
  }[context.electronPlatformName];
  if (extension === undefined) {
    throw new Error(`Unsupported Electron fuse platform: ${String(context.electronPlatformName)}`);
  }
  const executableName = context.electronPlatformName === "linux"
    ? context.packager.executableName
    : context.packager.appInfo.productFilename;
  const electronPath = path.join(context.appOutDir, `${executableName}${extension}`);
  if (context.electronPlatformName === "darwin" || context.electronPlatformName === "mas") {
    hardenMacInfoPlist(electronPath);
  }
  await flipFuses(electronPath, {
    version: FuseVersion.V1,
    strictlyRequireAllFuses: true,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    [FuseV1Options.WasmTrapHandlers]: true,
  });
}

module.exports = applyElectronFuses;
module.exports.hardenMacInfoPlist = hardenMacInfoPlist;
