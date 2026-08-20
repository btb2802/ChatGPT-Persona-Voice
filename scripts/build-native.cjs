"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PROJECT_ROOT = path.join(__dirname, "..");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
}

function macosCompilerArguments(source, output, frameworks) {
  return [
    "--sdk",
    "macosx",
    "clang++",
    "-std=c++20",
    "-fobjc-arc",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-mmacosx-version-min=14.2",
    source,
    ...frameworks.flatMap((framework) => ["-framework", framework]),
    "-o",
    output,
  ];
}

function buildNative(platform = process.platform) {
  if (platform !== "darwin") {
    console.log(`No native helpers are built on ${platform}; platform adapters remain fail-closed.`);
    return [];
  }
  const outputDirectory = path.join(PROJECT_ROOT, "native", "bin", "darwin");
  fs.mkdirSync(outputDirectory, { recursive: true });
  const builds = [
    {
      source: "native/macos/VoiceCapture.mm",
      output: "native/bin/darwin/cpv-audio-capture",
      frameworks: ["Foundation", "CoreAudio"],
    },
    {
      source: "native/macos/VoiceOutput.mm",
      output: "native/bin/darwin/cpv-audio-output",
      frameworks: ["Foundation", "CoreAudio", "AudioToolbox"],
    },
    {
      source: "native/macos/AtomicSwap.mm",
      output: "native/bin/darwin/cpv-atomic-swap",
      frameworks: ["Foundation"],
    },
  ];
  for (const build of builds) {
    run("xcrun", macosCompilerArguments(build.source, build.output, build.frameworks));
  }
  return builds.map((build) => path.join(PROJECT_ROOT, build.output));
}

if (require.main === module) {
  try {
    for (const output of buildNative()) console.log(`Built ${output}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = { buildNative, macosCompilerArguments };
