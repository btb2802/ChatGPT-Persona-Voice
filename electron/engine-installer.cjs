"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { terminateChild } = require("./native-helper.cjs");
const { inspectSeedVcRuntime } = require("./seed-vc-engine.cjs");

const UV_VERSION = "0.11.14";
const MAX_RUNTIME_BYTES = 15 * 1024 ** 3;
const MIN_INSTALL_FREE_BYTES = 6 * 1024 ** 3;
const ESTIMATED_INSTALLED_BYTES = 2.5 * 1024 ** 3;
const PHASES = Object.freeze({
  preparing: { progress: 0.04, detail: "Preparing the private engine staging area" },
  python: { progress: 0.12, detail: "Installing managed Python 3.11" },
  packages: { progress: 0.28, detail: "Installing the locked Seed-VC runtime packages" },
  models: { progress: 0.58, detail: "Downloading pinned model files" },
  verifying: { progress: 0.9, detail: "Verifying packages and model SHA-256 hashes" },
  publishing: { progress: 0.98, detail: "Publishing the verified engine package" },
});

function executableOnPath(name, environment = process.env) {
  const explicit = environment.CODEX_PERSONA_VOICE_UV_BIN?.trim();
  if (explicit) return path.isAbsolute(explicit) && fs.existsSync(explicit) ? explicit : null;
  for (const directory of String(environment.PATH || "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveEngineInstallerPaths({
  isPackaged = false,
  resourcesPath = process.resourcesPath,
  projectRoot = path.join(__dirname, ".."),
  runtimeRoot = path.join(projectRoot, "runtime", "seed-vc"),
  environment = process.env,
} = {}) {
  const engineRoot = isPackaged
    ? path.join(resourcesPath, "engine", "seed-vc")
    : path.join(projectRoot, "engine", "seed-vc");
  const storageRoot = path.dirname(runtimeRoot);
  return {
    packaged: isPackaged,
    uvPath: isPackaged
      ? path.join(resourcesPath, "engine-installer", "uv")
      : executableOnPath("uv", environment),
    runtimeRoot,
    stagingRoot: `${runtimeRoot}.installing`,
    backupRoot: `${runtimeRoot}.backup`,
    pythonRoot: path.join(storageRoot, "python"),
    cacheRoot: path.join(storageRoot, "cache", "uv"),
    requirementsPath: path.join(engineRoot, "requirements-macos-arm64.lock.txt"),
    modelLockPath: path.join(engineRoot, "model-lock.json"),
    prefetchPath: path.join(engineRoot, "prefetch.py"),
    verifierPath: path.join(engineRoot, "verify.py"),
    workerPath: path.join(engineRoot, "worker.py"),
    seedRoot: isPackaged
      ? path.join(resourcesPath, "engine", "vendor", "seed-vc")
      : path.join(projectRoot, "engine", "vendor", "seed-vc"),
  };
}

function runtimePaths(paths, runtimeRoot = paths.runtimeRoot) {
  return {
    packaged: paths.packaged,
    runtimeRoot,
    pythonPath: path.join(runtimeRoot, ".venv", "bin", "python"),
    workerPath: paths.workerPath,
    seedRoot: paths.seedRoot,
    modelLockPath: paths.modelLockPath,
    installManifestPath: path.join(runtimeRoot, "install-manifest.json"),
  };
}

function buildInstallerEnvironment(paths, environment = process.env) {
  const value = {};
  for (const key of ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
    if (typeof environment[key] === "string" && environment[key]) value[key] = environment[key];
  }
  return {
    ...value,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C",
    LC_ALL: "C",
    PYTHONNOUSERSITE: "1",
    PYTHONUNBUFFERED: "1",
    PIP_CONFIG_FILE: "/dev/null",
    UV_NO_CONFIG: "1",
    UV_MANAGED_PYTHON: "1",
    UV_LINK_MODE: "copy",
    UV_DEFAULT_INDEX: "https://pypi.org/simple",
    UV_INDEX_STRATEGY: "first-index",
    UV_KEYRING_PROVIDER: "disabled",
    UV_REQUIRE_HASHES: "1",
    UV_CACHE_DIR: paths.cacheRoot,
    UV_PYTHON_INSTALL_DIR: paths.pythonRoot,
    HF_HUB_DISABLE_TELEMETRY: "1",
    HF_HUB_DISABLE_IMPLICIT_TOKEN: "1",
  };
}

function directorySize(directory) {
  if (!fs.existsSync(directory)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const value = path.join(directory, entry.name);
    if (entry.isDirectory()) total += directorySize(value);
    else if (entry.isFile()) total += fs.statSync(value).size;
  }
  return total;
}

function availableBytes(directory) {
  const stats = fs.statfsSync(directory);
  return Number(stats.bavail) * Number(stats.bsize);
}

function cancelledError() {
  const error = new Error("Engine installation was cancelled; Retry resumes the partial download");
  error.code = "engine_install_cancelled";
  return error;
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw cancelledError();
}

function executeCommand({
  executable,
  args,
  cwd,
  environment,
  signal,
  spawnProcess = spawn,
  terminateProcess = terminateChild,
  onOutput = () => {},
}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelledError());
      return;
    }
    const child = spawnProcess(executable, args, {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let settled = false;
    let aborting = false;
    let stderr = "";
    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const consume = (chunk, isError) => {
      const text = chunk.toString("utf8");
      if (isError) stderr = (stderr + text).slice(-32_000);
      for (const line of text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
        onOutput(line.slice(0, 2_000));
      }
    };
    const onAbort = () => {
      if (aborting || settled) return;
      aborting = true;
      Promise.resolve(terminateProcess(child)).then(
        () => finish(cancelledError()),
        (error) => finish(new Error(
          `Engine installation cancellation could not terminate its child process: ${error.message}`,
        )),
      );
    };
    child.stdout?.on("data", (chunk) => consume(chunk, false));
    child.stderr?.on("data", (chunk) => consume(chunk, true));
    child.once("error", (error) => finish(error));
    child.once("exit", (code, childSignal) => {
      if (aborting) return;
      if (code === 0) finish();
      else finish(new Error(
        stderr.trim() ||
        `${path.basename(executable)} failed (code=${String(code)}, signal=${String(childSignal)})`,
      ));
    });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

class EngineInstaller {
  constructor({
    paths,
    platform = process.platform,
    arch = process.arch,
    environment = process.env,
    execute = executeCommand,
    freeBytes = availableBytes,
    size = directorySize,
    publish = () => {},
    logger = null,
  }) {
    this.paths = paths;
    this.platform = platform;
    this.arch = arch;
    this.environment = environment;
    this.execute = execute;
    this.freeBytes = freeBytes;
    this.size = size;
    this.publish = publish;
    this.logger = logger;
    this.operation = null;
    this.abortController = null;
    this.recoveryError = null;
    try { this.recoverInterruptedPublish(); }
    catch (error) { this.recoveryError = error; }
    this.state = this.initialState();
  }

  recoverInterruptedPublish() {
    if (!fs.existsSync(this.paths.backupRoot)) return;
    const installed = inspectSeedVcRuntime(runtimePaths(this.paths));
    if (installed.ready) {
      fs.rmSync(this.paths.backupRoot, { recursive: true, force: true });
      this.logger?.warn?.("engine.install_recovered_published_runtime");
      return;
    }
    const backup = inspectSeedVcRuntime(runtimePaths(this.paths, this.paths.backupRoot));
    if (!backup.ready) {
      throw new Error(
        `An interrupted engine update could not be recovered: ${backup.detail}`,
      );
    }
    if (fs.existsSync(this.paths.runtimeRoot)) {
      fs.rmSync(this.paths.runtimeRoot, { recursive: true, force: true });
    }
    fs.renameSync(this.paths.backupRoot, this.paths.runtimeRoot);
    this.logger?.warn?.("engine.install_restored_previous_runtime");
  }

  supported() {
    return this.platform === "darwin" && this.arch === "arm64" &&
      typeof this.paths.uvPath === "string" && fs.existsSync(this.paths.uvPath);
  }

  initialState() {
    if (this.platform !== "darwin" || this.arch !== "arm64") {
      return {
        status: "unavailable",
        detail: "The current engine package supports Apple Silicon macOS only",
        estimatedInstalledBytes: ESTIMATED_INSTALLED_BYTES,
        minimumFreeBytes: MIN_INSTALL_FREE_BYTES,
      };
    }
    if (typeof this.paths.uvPath !== "string" || !fs.existsSync(this.paths.uvPath)) {
      return {
        status: "unavailable",
        detail: "The verified engine installer bootstrap is missing",
        estimatedInstalledBytes: ESTIMATED_INSTALLED_BYTES,
        minimumFreeBytes: MIN_INSTALL_FREE_BYTES,
      };
    }
    if (this.recoveryError) {
      return {
        status: "error",
        detail: this.recoveryError instanceof Error
          ? this.recoveryError.message
          : String(this.recoveryError),
        resumable: fs.existsSync(this.paths.stagingRoot),
        estimatedInstalledBytes: ESTIMATED_INSTALLED_BYTES,
        minimumFreeBytes: MIN_INSTALL_FREE_BYTES,
      };
    }
    const runtime = inspectSeedVcRuntime(runtimePaths(this.paths));
    if (runtime.ready) {
      return {
        status: "ready",
        detail: runtime.detail,
        installedBytes: this.size(this.paths.runtimeRoot),
        estimatedInstalledBytes: ESTIMATED_INSTALLED_BYTES,
        minimumFreeBytes: MIN_INSTALL_FREE_BYTES,
      };
    }
    return {
      status: "idle",
      detail: fs.existsSync(this.paths.stagingRoot)
        ? "A partial engine package is ready to resume"
        : "The separate Seed-VC engine package is not installed",
      resumable: fs.existsSync(this.paths.stagingRoot),
      estimatedInstalledBytes: ESTIMATED_INSTALLED_BYTES,
      minimumFreeBytes: MIN_INSTALL_FREE_BYTES,
    };
  }

  getState() {
    return this.state;
  }

  transition(next) {
    this.state = {
      ...next,
      estimatedInstalledBytes: ESTIMATED_INSTALLED_BYTES,
      minimumFreeBytes: MIN_INSTALL_FREE_BYTES,
    };
    this.publish(this.state);
    return this.state;
  }

  phase(phase, output = null) {
    const descriptor = PHASES[phase];
    return this.transition({
      status: "installing",
      phase,
      progress: descriptor.progress,
      detail: output || descriptor.detail,
      cancellable: phase !== "publishing",
    });
  }

  async command(executable, args, signal, phase) {
    await this.execute({
      executable,
      args,
      cwd: this.paths.seedRoot,
      environment: buildInstallerEnvironment(this.paths, this.environment),
      signal,
      onOutput: (line) => {
        this.logger?.debug?.("engine.install_output", { phase, message: line });
      },
    });
  }

  install() {
    if (this.operation) throw new Error("An engine package operation is already active");
    if (!this.supported()) throw new Error(this.initialState().detail);
    const controller = new AbortController();
    this.abortController = controller;
    const operation = this.installPackage(controller.signal);
    this.operation = operation;
    return operation.finally(() => {
      if (this.operation === operation) this.operation = null;
      if (this.abortController === controller) this.abortController = null;
    });
  }

  async installPackage(signal) {
    try {
      if (this.recoveryError) throw this.recoveryError;
      const parent = path.dirname(this.paths.runtimeRoot);
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      try { fs.chmodSync(parent, 0o700); } catch {}
      if (this.freeBytes(parent) < MIN_INSTALL_FREE_BYTES) {
        throw new Error("Seed-VC installation requires at least 6 GiB of free disk space");
      }
      const lock = JSON.parse(fs.readFileSync(this.paths.modelLockPath, "utf8"));
      if (lock.schemaVersion !== 1 || typeof lock.python !== "string") {
        throw new Error("The bundled Seed-VC model lock is invalid");
      }
      fs.mkdirSync(this.paths.stagingRoot, { recursive: true, mode: 0o700 });
      const stagingPython = path.join(this.paths.stagingRoot, ".venv", "bin", "python");
      throwIfCancelled(signal);
      this.phase("preparing");
      await this.command(this.paths.uvPath, ["--version"], signal, "preparing");
      throwIfCancelled(signal);
      this.phase("python");
      await this.command(this.paths.uvPath, [
        "venv", "--managed-python", "--relocatable", "--allow-existing",
        "--python", lock.python, path.join(this.paths.stagingRoot, ".venv"),
      ], signal, "python");
      throwIfCancelled(signal);
      this.phase("packages");
      await this.command(this.paths.uvPath, [
        "pip", "sync", "--managed-python", "--strict", "--require-hashes",
        "--only-binary", ":all:",
        "--no-binary", "antlr4-python3-runtime",
        "--no-binary", "argbind",
        "--no-binary", "randomname",
        "--build-constraint", this.paths.requirementsPath,
        "--link-mode", "copy",
        "--default-index", "https://pypi.org/simple",
        "--python", stagingPython, this.paths.requirementsPath,
      ], signal, "packages");
      throwIfCancelled(signal);
      this.phase("models");
      await this.command(stagingPython, [
        "-I", "-u", this.paths.prefetchPath,
        "--runtime-root", this.paths.stagingRoot,
        "--lock", this.paths.modelLockPath,
      ], signal, "models");
      throwIfCancelled(signal);
      const bytes = this.size(this.paths.stagingRoot);
      if (bytes > MAX_RUNTIME_BYTES) {
        throw new Error(
          `Installed engine is ${(bytes / 1024 ** 3).toFixed(2)} GiB, above the 15 GiB product limit`,
        );
      }
      this.phase("verifying");
      await this.command(stagingPython, [
        "-I", "-u", this.paths.verifierPath,
        "--runtime-root", this.paths.stagingRoot,
        "--lock", this.paths.modelLockPath,
        "--worker", this.paths.workerPath,
      ], signal, "verifying");
      throwIfCancelled(signal);
      const staged = inspectSeedVcRuntime(runtimePaths(this.paths, this.paths.stagingRoot));
      if (!staged.ready) throw new Error(staged.detail);
      this.phase("publishing");
      throwIfCancelled(signal);
      const hadRuntime = fs.existsSync(this.paths.runtimeRoot);
      if (fs.existsSync(this.paths.backupRoot)) {
        throw new Error("A previous engine publication backup is still present");
      }
      if (hadRuntime) fs.renameSync(this.paths.runtimeRoot, this.paths.backupRoot);
      try {
        fs.renameSync(this.paths.stagingRoot, this.paths.runtimeRoot);
        const installed = inspectSeedVcRuntime(runtimePaths(this.paths));
        if (!installed.ready) throw new Error(installed.detail);
      } catch (error) {
        let rollbackError = null;
        try {
          if (fs.existsSync(this.paths.runtimeRoot) && !fs.existsSync(this.paths.stagingRoot)) {
            fs.renameSync(this.paths.runtimeRoot, this.paths.stagingRoot);
          }
          if (hadRuntime && fs.existsSync(this.paths.backupRoot) &&
              !fs.existsSync(this.paths.runtimeRoot)) {
            fs.renameSync(this.paths.backupRoot, this.paths.runtimeRoot);
          }
        } catch (rollbackFailure) {
          rollbackError = rollbackFailure;
        }
        if (rollbackError) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}; ` +
            `restoring the previous engine also failed: ${rollbackError.message}`,
          );
        }
        throw error;
      }
      if (hadRuntime) {
        try { fs.rmSync(this.paths.backupRoot, { recursive: true, force: true }); }
        catch (error) {
          this.logger?.warn?.("engine.install_backup_cleanup_failed", { message: error.message });
        }
      }
      try { fs.rmSync(this.paths.cacheRoot, { recursive: true, force: true }); } catch {}
      const installed = inspectSeedVcRuntime(runtimePaths(this.paths));
      this.logger?.info?.("engine.install_completed", { bytes });
      return this.transition({
        status: "ready",
        detail: installed.detail,
        installedBytes: bytes,
      });
    } catch (error) {
      if (error?.code === "engine_install_cancelled") {
        this.logger?.info?.("engine.install_cancelled");
        this.transition({
          status: "idle",
          detail: "Installation paused; Retry resumes the partial engine package",
          resumable: true,
        });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.logger?.error?.("engine.install_failed", { message });
        this.transition({
          status: "error",
          detail: message,
          resumable: fs.existsSync(this.paths.stagingRoot),
        });
      }
      throw error;
    }
  }

  async cancel() {
    if (!this.operation || !this.abortController) return false;
    this.abortController.abort();
    await this.operation.catch(() => {});
    return true;
  }

  async remove() {
    if (this.operation) throw new Error("An engine package operation is already active");
    const operation = (async () => {
      this.transition({ status: "removing", detail: "Removing the local engine package" });
      try {
        for (const target of [
          this.paths.runtimeRoot,
          this.paths.stagingRoot,
          this.paths.backupRoot,
          this.paths.pythonRoot,
          this.paths.cacheRoot,
        ]) {
          fs.rmSync(target, { recursive: true, force: true });
        }
        this.recoveryError = null;
        return this.transition({
          status: "idle",
          detail: "The separate Seed-VC engine package is not installed",
          resumable: false,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.transition({ status: "error", detail: message, resumable: false });
        throw error;
      }
    })();
    this.operation = operation;
    try { return await operation; }
    finally { if (this.operation === operation) this.operation = null; }
  }

  async shutdown() {
    await this.cancel();
  }
}

module.exports = {
  ESTIMATED_INSTALLED_BYTES,
  EngineInstaller,
  MAX_RUNTIME_BYTES,
  MIN_INSTALL_FREE_BYTES,
  UV_VERSION,
  buildInstallerEnvironment,
  executeCommand,
  resolveEngineInstallerPaths,
  runtimePaths,
  throwIfCancelled,
};
