"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { buildInstallerEnvironment } = require("../electron/engine-installer.cjs");

const root = path.join(__dirname, "..");
const engineRoot = path.join(root, "engine", "seed-vc");
const seedRoot = path.join(root, "engine", "vendor", "seed-vc");
const lockPath = path.join(engineRoot, "model-lock.json");
const requirementsPath = path.join(engineRoot, "requirements-macos-arm64.lock.txt");
const requestedRootIndex = process.argv.indexOf("--runtime-root");
const runtimeRoot = requestedRootIndex >= 0
  ? path.resolve(process.argv[requestedRootIndex + 1] || "")
  : path.join(root, "runtime", "seed-vc");
const pythonPath = path.join(runtimeRoot, ".venv", "bin", "python");
const MAX_RUNTIME_BYTES = 15 * 1024 ** 3;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    encoding: "utf8",
    env: options.env,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? (result.stderr || result.stdout || "").trim() : "";
    throw new Error(`${command} failed with exit code ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  return options.capture ? result.stdout.trim() : "";
}

function executableOnPath(name, environment = process.env) {
  for (const directory of String(environment.PATH || "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
  }
  return null;
}

function directorySize(directory) {
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const value = path.join(directory, entry.name);
    if (entry.isDirectory()) total += directorySize(value);
    else if (entry.isFile()) total += fs.statSync(value).size;
  }
  return total;
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The current install profile supports Apple Silicon macOS only");
}
if (requestedRootIndex >= 0 && !process.argv[requestedRootIndex + 1]) {
  throw new Error("--runtime-root requires a path");
}
const uvPath = executableOnPath("uv");
if (!uvPath) throw new Error("The pinned uv engine installer is not available on PATH");
const setupEnvironment = buildInstallerEnvironment({
  cacheRoot: path.join(runtimeRoot, ".cache", "uv"),
  pythonRoot: path.join(runtimeRoot, "python"),
});
run(uvPath, ["--version"], { capture: true, env: setupEnvironment });
if (!fs.existsSync(path.join(seedRoot, "real-time-gui.py"))) {
  throw new Error("Seed-VC submodule is missing; run git submodule update --init --recursive");
}
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const seedCommit = run("/usr/bin/git", ["rev-parse", "HEAD"], {
  cwd: seedRoot,
  capture: true,
  env: setupEnvironment,
});
if (seedCommit !== lock.seedVcCommit) {
  throw new Error(`Seed-VC submodule must be at ${lock.seedVcCommit}, found ${seedCommit}`);
}

fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
if (!fs.existsSync(pythonPath)) {
  run(uvPath, [
    "venv", "--managed-python", "--relocatable", "--python", lock.python,
    path.join(runtimeRoot, ".venv"),
  ], { env: setupEnvironment });
}
run(uvPath, [
  "pip", "sync", "--managed-python", "--strict", "--require-hashes",
  "--only-binary", ":all:",
  "--no-binary", "antlr4-python3-runtime",
  "--no-binary", "argbind",
  "--no-binary", "randomname",
  "--build-constraint", requirementsPath,
  "--link-mode", "copy",
  "--default-index", "https://pypi.org/simple",
  "--python", pythonPath, requirementsPath,
], { env: setupEnvironment });
run(pythonPath, [
  "-I", "-u", path.join(engineRoot, "prefetch.py"),
  "--runtime-root", runtimeRoot,
  "--lock", lockPath,
], { env: setupEnvironment });

const bytes = directorySize(runtimeRoot);
if (bytes > MAX_RUNTIME_BYTES) {
  throw new Error(`Installed runtime is ${(bytes / 1024 ** 3).toFixed(2)} GiB, above the 15 GiB product limit`);
}
console.log(`Seed-VC runtime ready at ${runtimeRoot}`);
console.log(`Installed size: ${(bytes / 1024 ** 3).toFixed(2)} GiB`);
