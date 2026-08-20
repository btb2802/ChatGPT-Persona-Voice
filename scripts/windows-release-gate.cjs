"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  PACKAGE_FILES,
  verifyMicrosoftSignedPackage,
} = require("./windows-build-driver.cjs");

const WINDOWS_HELPER_FILES = Object.freeze([
  "cpv-audio-capture.exe",
  "cpv-audio-output.exe",
  "cpv-audio-route.exe",
  "cpv-driver-manager.exe",
]);

function requireRegularFile(file, label) {
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Windows release payload is missing ${label}`);
  }
}

function assertWindowsReleasePayload(nativeRoot, {
  platform = process.platform,
  architecture = process.arch,
} = {}) {
  if (platform !== "win32") {
    throw new Error("Windows release signature gating must run on the Windows packaging runner");
  }
  const resolvedRoot = path.resolve(nativeRoot);
  for (const name of WINDOWS_HELPER_FILES) {
    requireRegularFile(path.join(resolvedRoot, name), name);
  }
  const driverRoot = path.join(resolvedRoot, "driver");
  for (const name of PACKAGE_FILES) {
    requireRegularFile(path.join(driverRoot, name), `driver/${name}`);
  }
  verifyMicrosoftSignedPackage(driverRoot, { platform, architecture });
  return {
    ready: true,
    nativeRoot: resolvedRoot,
    driverRoot,
    microsoftKernelPolicyVerified: true,
  };
}

if (require.main === module) {
  try {
    const nativeRoot = process.argv[2];
    if (!nativeRoot || process.argv.length !== 3) {
      throw new Error("Use: node scripts/windows-release-gate.cjs <fixed-native-win32-root>");
    }
    const result = assertWindowsReleasePayload(nativeRoot);
    console.log(`Windows release payload verified at ${result.nativeRoot}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = { WINDOWS_HELPER_FILES, assertWindowsReleasePayload };
