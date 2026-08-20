"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PROJECT_ROOT = path.join(__dirname, "..");
const OUTPUT_ROOT = path.join(PROJECT_ROOT, "native", "bin", "linux");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || `${command} exited with ${result.status}`);
  }
  return result.stdout.trim();
}

function pipeWireFlags() {
  const output = run("pkg-config", ["--cflags", "--libs", "libpipewire-0.3"]);
  return output.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((value) =>
    value.replace(/^(?:"(.*)"|'(.*)')$/, "$1$2")) ?? [];
}

function buildLinuxNative(platform = process.platform) {
  if (platform !== "linux") throw new Error("Linux PipeWire helpers must be compiled on Linux");
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  const flags = pipeWireFlags();
  const builds = [
    ["native/linux/PipeWireCapture.cpp", "native/bin/linux/cpv-audio-capture"],
    ["native/linux/PipeWireOutput.cpp", "native/bin/linux/cpv-audio-output"],
  ];
  for (const [source, output] of builds) {
    run("c++", [
      "-std=c++20",
      "-O2",
      "-fPIE",
      "-fstack-protector-strong",
      "-D_FORTIFY_SOURCE=2",
      "-Wall",
      "-Wextra",
      // PipeWire's public C headers intentionally use GNU compound expressions.
      "-Wno-missing-field-initializers",
      "-Werror",
      source,
      "-pthread",
      ...flags,
      "-Wl,-z,relro,-z,now",
      "-pie",
      "-o",
      output,
    ]);
  }
  return builds.map(([, output]) => path.join(PROJECT_ROOT, output));
}

if (require.main === module) {
  try {
    for (const output of buildLinuxNative()) console.log(`Built ${output}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = { buildLinuxNative, pipeWireFlags };
