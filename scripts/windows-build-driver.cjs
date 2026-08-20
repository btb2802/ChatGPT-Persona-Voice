"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const PROJECT_ROOT = path.join(__dirname, "..");
const DRIVER_ROOT = path.join(
  PROJECT_ROOT, "native", "windows", "driver", "upstream-simpleaudiosample",
);
const SOLUTION = path.join(DRIVER_ROOT, "SimpleAudioSample.sln");
const PACKAGE_FILES = Object.freeze([
  "PersonaVoiceSink.inf",
  "cpv-audio-sink.cat",
  "cpv-audio-sink.sys",
]);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() ||
      `${command} exited with ${String(result.status)}`);
  }
  return result.stdout.trim();
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function builtFile(root, name, { architecture, buildStartedAt }) {
  const matches = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) {
        const relativeParts = path.relative(root, absolute).toLowerCase().split(path.sep);
        const modified = fs.statSync(absolute).mtimeMs;
        if (relativeParts.includes(architecture.toLowerCase()) &&
            relativeParts.includes("release") && modified >= buildStartedAt - 5_000) {
          matches.push(absolute);
        }
      }
    }
  };
  visit(root);
  if (matches.length === 0) throw new Error(`Driver build did not produce ${name}`);
  const hashes = new Map();
  for (const absolute of matches) {
    const hash = sha256(absolute);
    if (!hashes.has(hash)) hashes.set(hash, absolute);
  }
  if (hashes.size !== 1) {
    throw new Error(`Driver build produced conflicting ${name} outputs for ${architecture}|Release`);
  }
  return hashes.values().next().value;
}

function findMsBuild() {
  const programFiles = process.env["ProgramFiles(x86)"];
  if (!programFiles) throw new Error("ProgramFiles(x86) is unavailable");
  const vswhere = path.join(programFiles, "Microsoft Visual Studio", "Installer", "vswhere.exe");
  if (!fs.statSync(vswhere, { throwIfNoEntry: false })?.isFile()) {
    throw new Error("Visual Studio Installer vswhere.exe is unavailable");
  }
  const result = run(vswhere, [
    "-latest", "-products", "*", "-requires", "Microsoft.Component.MSBuild",
    "-find", "MSBuild\\**\\Bin\\MSBuild.exe",
  ]).split(/\r?\n/).filter(Boolean)[0];
  if (!result) throw new Error("MSBuild was not found");
  return result;
}

function findWindowsKitTool(name, architecture = "x64") {
  const programFiles = process.env["ProgramFiles(x86)"];
  const bin = path.join(programFiles || "", "Windows Kits", "10", "bin");
  if (!fs.statSync(bin, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("Windows 10/11 SDK tools are unavailable");
  }
  const versions = fs.readdirSync(bin, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = path.join(bin, version, architecture, name);
    if (fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
  }
  throw new Error(`${name} was not found in the Windows SDK`);
}

function driverPlatform(architecture) {
  if (architecture === "x64") return "x64";
  if (architecture === "arm64") return "ARM64";
  throw new Error(`Driver source supports x64 and arm64, received ${architecture}`);
}

function buildUnsignedDriverSubmission({ platform = process.platform, architecture = process.arch } = {}) {
  if (platform !== "win32") throw new Error("The Persona Voice Sink driver must be built on Windows");
  const msbuild = findMsBuild();
  const driverArch = driverPlatform(architecture);
  const buildStartedAt = Date.now();
  run(msbuild, [
    SOLUTION,
    "/m",
    "/t:Clean;Build",
    "/p:Configuration=Release",
    `/p:Platform=${driverArch}`,
    "/p:SignMode=Off",
    "/p:Inf2CatUseLocalTime=true",
    "/verbosity:minimal",
  ]);

  const stage = path.join(PROJECT_ROOT, "native", "windows", "driver", "build", architecture);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  for (const name of PACKAGE_FILES) {
    fs.copyFileSync(
      builtFile(DRIVER_ROOT, name, { architecture, buildStartedAt }),
      path.join(stage, name),
    );
  }
  return stage;
}

function verifyMicrosoftSignedPackage(packageDirectory, {
  platform = process.platform,
  architecture = process.arch,
} = {}) {
  if (platform !== "win32") throw new Error("Kernel-policy signature verification requires Windows");
  for (const name of PACKAGE_FILES) {
    if (!fs.statSync(path.join(packageDirectory, name), { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Signed driver package is missing ${name}`);
    }
  }
  const toolArch = architecture === "arm64" ? "arm64" : "x64";
  const signtool = findWindowsKitTool("signtool.exe", toolArch);
  const infverif = findWindowsKitTool("InfVerif.exe", toolArch);
  const catalog = path.join(packageDirectory, "cpv-audio-sink.cat");
  const driver = path.join(packageDirectory, "cpv-audio-sink.sys");
  const inf = path.join(packageDirectory, "PersonaVoiceSink.inf");
  run(signtool, ["verify", "/kp", "/v", "/c", catalog, driver]);
  run(signtool, ["verify", "/kp", "/v", "/c", catalog, inf]);
  run(infverif, ["/v", inf]);
  return true;
}

if (require.main === module) {
  try {
    const verifyIndex = process.argv.indexOf("--verify-signed-package");
    if (verifyIndex >= 0) {
      const directory = process.argv[verifyIndex + 1];
      if (!directory) throw new Error("--verify-signed-package requires a directory");
      verifyMicrosoftSignedPackage(path.resolve(directory));
      console.log(`Verified Microsoft kernel-policy signature for ${path.resolve(directory)}`);
    } else {
      const stage = buildUnsignedDriverSubmission();
      console.log(`Built unsigned Hardware Dev Center submission payload at ${stage}`);
      console.log("This payload is not an installable product artifact until Microsoft signs it.");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  PACKAGE_FILES,
  builtFile,
  buildUnsignedDriverSubmission,
  driverPlatform,
  findMsBuild,
  verifyMicrosoftSignedPackage,
};
