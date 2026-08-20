"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { EngineMessageParser, encodeEngineMessage } = require("./engine-protocol.cjs");
const { terminateChild, waitForExit } = require("./native-helper.cjs");
const { writeFrame } = require("./native-protocol.cjs");

const OUTPUT_FORMAT = Object.freeze({ sampleRate: 22_050, channels: 1, sampleFormat: "f32le" });
const ENGINE_STEPS = 10;
const BLOCK_MS = 300;
const PROMPT_SECONDS = 3;
const MIN_PROMPT_SECONDS = 1;
const MAX_PROMPT_SECONDS = 15;
const STYLE_SECONDS = 17;
const MIN_STYLE_SECONDS = 3;
const MAX_STYLE_SECONDS = 30;
const STYLE_DEVICE = "cpu";
const OUTPUT_FRAME_MS = 20;
const OUTPUT_BLOCK_FRAMES = Math.round(OUTPUT_FORMAT.sampleRate * BLOCK_MS / 1_000);
const STARTUP_DISCARD_MS = 3_000;
const STARTUP_TIMEOUT_MS = 60_000;
const CONVERT_TIMEOUT_MS = 8_000;
const CONTROL_TIMEOUT_MS = 5_000;
const RESPONSE_TYPES = Object.freeze({
  convert: "result",
  prime: "prime",
  reset: "reset",
  shutdown: "shutdown",
});

const SEED_VC_RUNTIME_PROFILES = Object.freeze({
  "darwin-arm64": Object.freeze({
    id: "darwin-arm64-mps",
    platform: "darwin",
    arch: "arm64",
    device: "mps",
    deviceLabel: "Apple MPS",
    backend: "mps",
    requirementsFile: "requirements-macos-arm64.lock.txt",
    torchBackend: null,
    estimatedInstalledBytes: 2.5 * 1024 ** 3,
    minimumFreeBytes: 6 * 1024 ** 3,
  }),
  "win32-x64": Object.freeze({
    id: "windows-x64-cuda130",
    platform: "win32",
    arch: "x64",
    device: "cuda",
    deviceLabel: "NVIDIA CUDA",
    backend: "cu130",
    requirementsFile: "requirements-windows-x64-cuda.lock.txt",
    torchBackend: "cu130",
    estimatedInstalledBytes: 9 * 1024 ** 3,
    minimumFreeBytes: 15 * 1024 ** 3,
  }),
  "linux-x64": Object.freeze({
    id: "linux-x64-cuda130",
    platform: "linux",
    arch: "x64",
    device: "cuda",
    deviceLabel: "NVIDIA CUDA",
    backend: "cu130",
    requirementsFile: "requirements-linux-x64-cuda.lock.txt",
    torchBackend: "cu130",
    estimatedInstalledBytes: 11 * 1024 ** 3,
    minimumFreeBytes: 15 * 1024 ** 3,
  }),
});

function resolveSeedVcRuntimeProfile(platform = process.platform, arch = process.arch) {
  return SEED_VC_RUNTIME_PROFILES[`${platform}-${arch}`] || null;
}

function pythonPathForRuntime(runtimeRoot, platform = process.platform) {
  const pathApi = platform === "win32" ? path.win32 : path;
  return platform === "win32"
    ? pathApi.join(runtimeRoot, ".venv", "Scripts", "python.exe")
    : pathApi.join(runtimeRoot, ".venv", "bin", "python");
}

function resolveSeedVcPaths({
  isPackaged = false,
  resourcesPath = process.resourcesPath,
  projectRoot = path.join(__dirname, ".."),
  runtimeRoot = path.join(projectRoot, "runtime", "seed-vc"),
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const profile = resolveSeedVcRuntimeProfile(platform, arch);
  const assetsRoot = isPackaged ? resourcesPath : projectRoot;
  const engineRoot = path.join(assetsRoot, "engine", "seed-vc");
  const seedRoot = path.join(assetsRoot, "engine", "vendor", "seed-vc");
  return {
    packaged: isPackaged,
    profile,
    engineRoot,
    seedRoot,
    runtimeRoot,
    pythonPath: pythonPathForRuntime(runtimeRoot, platform),
    workerPath: path.join(engineRoot, "worker.py"),
    modelLockPath: path.join(engineRoot, "model-lock.json"),
    requirementsPath: profile
      ? path.join(engineRoot, profile.requirementsFile)
      : null,
    installManifestPath: path.join(runtimeRoot, "install-manifest.json"),
  };
}

function integer(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function finiteNumber(value, field, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be a finite number between ${minimum} and ${maximum}`);
  }
  return value;
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function abortReason(signal, fallback = "Seed-VC startup was cancelled") {
  return signal?.reason instanceof Error ? signal.reason : new Error(fallback);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

function isolatedSystemPath(platform, environment) {
  if (platform !== "win32") return "/usr/bin:/bin:/usr/sbin:/sbin";
  const systemRoot = environment.SYSTEMROOT || environment.WINDIR;
  if (!systemRoot) return "";
  return [
    path.win32.join(systemRoot, "System32"),
    systemRoot,
    path.win32.join(systemRoot, "System32", "Wbem"),
  ].join(";");
}

function buildWorkerEnvironment(
  environment = process.env,
  runtimeRoot = null,
  platform = process.platform,
) {
  const value = {
    PATH: isolatedSystemPath(platform, environment),
    LANG: "C",
    LC_ALL: "C",
    PYTHONUNBUFFERED: "1",
    PYTHONNOUSERSITE: "1",
    TQDM_DISABLE: "1",
    HF_HUB_DISABLE_TELEMETRY: "1",
    HF_HUB_DISABLE_IMPLICIT_TOKEN: "1",
  };
  if (platform === "win32") {
    for (const key of ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
      if (typeof environment[key] === "string" && environment[key]) value[key] = environment[key];
    }
  }
  if (typeof runtimeRoot === "string" && path.isAbsolute(runtimeRoot)) {
    value.HOME = runtimeRoot;
    value.XDG_CACHE_HOME = path.join(runtimeRoot, ".cache");
  }
  return value;
}

function inspectSeedVcRuntime(paths, {
  exists = fs.existsSync,
  readFile = fs.readFileSync,
} = {}) {
  if (!paths.profile || !paths.requirementsPath) {
    return {
      ready: false,
      code: "seed_vc_platform_unavailable",
      detail: "No qualified realtime Seed-VC profile exists for this platform",
    };
  }
  const required = [
    [paths.pythonPath, "Python runtime"],
    [paths.workerPath, "Seed-VC worker"],
    [path.join(paths.seedRoot, "real-time-gui.py"), "Seed-VC source"],
    [paths.modelLockPath, "Model lock"],
    [paths.requirementsPath, "Runtime requirements lock"],
    [paths.installManifestPath, "Model installation manifest"],
  ];
  const missing = required.find(([filePath]) => !exists(filePath));
  if (missing) {
    return {
      ready: false,
      code: "seed_vc_runtime_missing",
      detail: `${missing[1]} is missing`,
    };
  }
  try {
    const lock = JSON.parse(readFile(paths.modelLockPath, "utf8"));
    const installed = JSON.parse(readFile(paths.installManifestPath, "utf8"));
    const repositories = lock.repositories;
    const expectedModelFiles = repositories && typeof repositories === "object"
      ? Object.values(repositories).reduce((total, repository) =>
        total + (repository?.files && typeof repository.files === "object"
          ? Object.keys(repository.files).length
          : 0), 0)
      : 0;
    const lockSha256 = crypto.createHash("sha256")
      .update(readFile(paths.modelLockPath))
      .digest("hex");
    const requirementsSha256 = crypto.createHash("sha256")
      .update(readFile(paths.requirementsPath))
      .digest("hex");
    if (lock.schemaVersion !== 1 || installed.schemaVersion !== 2 ||
        installed.seedVcCommit !== lock.seedVcCommit || installed.python !== lock.python ||
        installed.runtimeProfile !== paths.profile.id ||
        installed.requirementsSha256 !== requirementsSha256 ||
        expectedModelFiles < 1 || !Array.isArray(installed.files) ||
        installed.files.length !== expectedModelFiles ||
        installed.modelLockSha256 !== lockSha256) {
      throw new Error("installation manifest does not match the model lock");
    }
  } catch (error) {
    return {
      ready: false,
      code: "seed_vc_runtime_invalid",
      detail: `Seed-VC runtime is invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return {
    ready: true,
    code: "ready",
    detail: `The locked Seed-VC ${paths.profile.deviceLabel} engine package is installed`,
  };
}

class SeedVcEngine {
  constructor({
    paths,
    voiceCatalog,
    platform = process.platform,
    arch = process.arch,
    exists = fs.existsSync,
    readFile = fs.readFileSync,
    spawnProcess = spawn,
    terminateProcess = terminateChild,
    waitForProcessExit = waitForExit,
    logger = null,
    onDiagnostics = () => {},
    startupTimeoutMs = STARTUP_TIMEOUT_MS,
    convertTimeoutMs = CONVERT_TIMEOUT_MS,
    controlTimeoutMs = CONTROL_TIMEOUT_MS,
    promptSeconds = PROMPT_SECONDS,
    styleSeconds = STYLE_SECONDS,
  }) {
    this.paths = paths;
    this.voiceCatalog = voiceCatalog;
    this.platform = platform;
    this.arch = arch;
    this.exists = exists;
    this.readFile = readFile;
    this.spawnProcess = spawnProcess;
    this.terminateProcess = terminateProcess;
    this.waitForProcessExit = waitForProcessExit;
    this.logger = logger;
    this.onDiagnostics = onDiagnostics;
    this.startupTimeoutMs = startupTimeoutMs;
    this.convertTimeoutMs = convertTimeoutMs;
    this.controlTimeoutMs = controlTimeoutMs;
    this.promptSeconds = finiteNumber(
      promptSeconds,
      "Seed-VC prompt seconds",
      MIN_PROMPT_SECONDS,
      MAX_PROMPT_SECONDS,
    );
    this.styleSeconds = finiteNumber(
      styleSeconds,
      "Seed-VC style seconds",
      MIN_STYLE_SECONDS,
      MAX_STYLE_SECONDS,
    );
    this.worker = null;
    this.startInFlight = null;
    this.startAbortController = null;
    this.prepareInFlight = null;
    this.shutdownInFlight = null;
    this.shutdownRequested = false;
    this.nextRequestId = 1;
    this.activeSession = null;
    this.lastInferenceMs = null;
    this.lastMetrics = null;
  }

  diagnostics() {
    const workerReady = this.worker?.ready && !this.worker.failure && !this.worker.closing
      ? this.worker.ready
      : null;
    const finite = (value) => Number.isFinite(value) ? value : null;
    const runtimeProfile = resolveSeedVcRuntimeProfile(this.platform, this.arch);
    return {
      profile: "seed-vc-tiny-realtime",
      runtimeProfile: runtimeProfile?.id || null,
      device: workerReady?.device === runtimeProfile?.device ? workerReady.device : null,
      backend: workerReady?.backend === runtimeProfile?.backend ? workerReady.backend : null,
      workerState: workerReady ? "ready" : this.startInFlight ? "loading" : "stopped",
      active: this.activeSession?.active === true,
      voiceId: workerReady ? this.worker.voice.id : null,
      steps: ENGINE_STEPS,
      blockMs: BLOCK_MS,
      promptSeconds: this.promptSeconds,
      styleSeconds: this.styleSeconds,
      styleSecondsUsed: finite(workerReady?.styleSecondsUsed),
      styleDevice: workerReady?.styleDevice === STYLE_DEVICE ? STYLE_DEVICE : null,
      startupDiscardMs: STARTUP_DISCARD_MS,
      convertedBlocks: this.activeSession?.convertedBlocks || 0,
      loadSeconds: finite(workerReady?.loadSeconds),
      warmupSeconds: finite(workerReady?.warmupSeconds),
      torch: typeof workerReady?.torch === "string" ? workerReady.torch : null,
      lastInferenceMs: finite(this.lastInferenceMs),
      mpsCurrentAllocatedBytes: finite(this.lastMetrics?.mpsCurrentAllocatedBytes),
      mpsDriverAllocatedBytes: finite(this.lastMetrics?.mpsDriverAllocatedBytes),
      mpsRecommendedMaxBytes: finite(this.lastMetrics?.mpsRecommendedMaxBytes),
      cudaAllocatedBytes: finite(this.lastMetrics?.cudaAllocatedBytes),
      cudaReservedBytes: finite(this.lastMetrics?.cudaReservedBytes),
      cudaDeviceName: typeof workerReady?.cudaDeviceName === "string"
        ? workerReady.cudaDeviceName
        : null,
    };
  }

  publishDiagnostics() {
    try { this.onDiagnostics(this.diagnostics()); }
    catch (error) {
      this.logger?.warn?.("engine.diagnostics_publish_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  installationReadiness(settings) {
    const profile = resolveSeedVcRuntimeProfile(this.platform, this.arch);
    if (!profile) {
      return {
        ready: false,
        code: "seed_vc_platform_unavailable",
        detail: "Realtime Seed-VC requires Apple Silicon or x64 Windows/Linux with NVIDIA CUDA; CPU inference is not a qualified realtime profile",
      };
    }
    if (this.paths.profile?.id !== profile.id ||
        typeof this.paths.requirementsPath !== "string" ||
        path.basename(this.paths.requirementsPath) !== profile.requirementsFile) {
      return {
        ready: false,
        code: "seed_vc_runtime_invalid",
        detail: `The bundled Seed-VC ${profile.deviceLabel} profile is inconsistent`,
      };
    }
    let voice;
    try { voice = this.voiceCatalog.resolve(settings?.selectedVoiceId); }
    catch (error) {
      return {
        ready: false,
        code: "target_voice_required",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (settings?.selectedVoiceName !== voice.name) {
      return {
        ready: false,
        code: "target_voice_state_invalid",
        detail: "Selected voice metadata does not match the installed catalog",
      };
    }
    const runtime = inspectSeedVcRuntime({ ...this.paths, profile }, {
      exists: this.exists,
      readFile: this.readFile,
    });
    if (!runtime.ready) {
      const instruction = this.paths.packaged
        ? "install the separate engine package from Voice settings"
        : "run bun run setup:engine";
      return { ...runtime, detail: `${runtime.detail}; ${instruction}` };
    }
    return {
      ready: true,
      code: "ready",
      detail: `${voice.name} · Seed-VC tiny · ${ENGINE_STEPS} steps · ${profile.deviceLabel}`,
    };
  }

  async probe(settings) {
    return { label: "Voice engine", ...this.installationReadiness(settings) };
  }

  workerKey(voice, sourceFormat) {
    const profile = resolveSeedVcRuntimeProfile(this.platform, this.arch);
    return [
      profile?.id || "unsupported",
      voice.id,
      sourceFormat.sampleRate,
      sourceFormat.channels,
      ENGINE_STEPS,
      BLOCK_MS,
      this.promptSeconds,
      this.styleSeconds,
    ].join(":");
  }

  handleWorkerMessage(worker, message) {
    const { header, body } = message;
    if (header.type === "status") {
      this.logger?.info("engine.seed_vc_status", {
        stage: header.stage,
        detail: header.detail,
      });
      return;
    }
    if (header.type === "ready") {
      if (worker.ready) throw new Error("Seed-VC worker emitted readiness twice");
      const expectedSourceBlockFrames = Math.round(
        worker.sourceFormat.sampleRate * BLOCK_MS / 1_000,
      );
      const profile = resolveSeedVcRuntimeProfile(this.platform, this.arch);
      if (header.protocolVersion !== 1 || header.engine !== "seed-vc-tiny-realtime" ||
          header.sampleRate !== OUTPUT_FORMAT.sampleRate || header.channels !== OUTPUT_FORMAT.channels ||
          header.sampleFormat !== OUTPUT_FORMAT.sampleFormat || header.steps !== ENGINE_STEPS ||
          header.promptSeconds !== this.promptSeconds ||
          header.styleSeconds !== this.styleSeconds || !Number.isFinite(header.styleSecondsUsed) ||
          header.styleSecondsUsed <= 0 || header.styleSecondsUsed > this.styleSeconds ||
          header.styleDevice !== STYLE_DEVICE ||
          header.runtimeProfile !== profile?.id || header.device !== profile?.device ||
          header.backend !== profile?.backend ||
          (profile?.device === "cuda" && (
            typeof header.cudaDeviceName !== "string" || !header.cudaDeviceName ||
            !Array.isArray(header.cudaCapability) || header.cudaCapability.length !== 2 ||
            !header.cudaCapability.every(Number.isInteger)
          )) ||
          header.sourceBlockFrames !== expectedSourceBlockFrames ||
          header.outputBlockFrames !== OUTPUT_BLOCK_FRAMES) {
        throw new Error("Seed-VC worker readiness does not match the prepared engine profile");
      }
      worker.ready = header;
      worker.resolveReady(header);
      this.publishDiagnostics();
      this.logger?.info("engine.seed_vc_ready", {
        voiceId: worker.voice.id,
        loadSeconds: header.loadSeconds,
        warmupSeconds: header.warmupSeconds,
        torch: header.torch,
      });
      return;
    }
    if (header.type === "error") {
      const error = new Error(header.message || "Seed-VC worker failed");
      error.code = "seed_vc_worker_failed";
      const pending = Number.isInteger(header.id) ? worker.pending.get(header.id) : null;
      if (pending) {
        clearTimeout(pending.timer);
        worker.pending.delete(header.id);
        pending.reject(error);
      }
      if (header.fatal === true) this.failWorker(worker, error);
      return;
    }
    if (!["result", "prime", "reset", "shutdown"].includes(header.type) || !Number.isInteger(header.id)) {
      throw new Error(`Seed-VC worker emitted an unexpected ${String(header.type)} message`);
    }
    const pending = worker.pending.get(header.id);
    if (!pending) throw new Error(`Seed-VC worker replied to unknown request ${header.id}`);
    const expectedType = RESPONSE_TYPES[pending.type];
    if (header.type !== expectedType) {
      throw new Error(
        `Seed-VC worker replied with ${header.type} to ${pending.type} request ${header.id}; expected ${expectedType}`,
      );
    }
    if (pending.type !== "convert" && body.length !== 0) {
      throw new Error(`Seed-VC ${header.type} acknowledgement must not contain a body`);
    }
    clearTimeout(pending.timer);
    worker.pending.delete(header.id);
    pending.resolve({ header, body });
  }

  failWorker(worker, error) {
    if (worker.failure) return;
    worker.failure = error instanceof Error ? error : new Error(String(error));
    if (!worker.ready) worker.rejectReady(worker.failure);
    for (const pending of worker.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(worker.failure);
    }
    worker.pending.clear();
    if (worker.child.exitCode === null && worker.child.signalCode === null) {
      worker.child.kill("SIGTERM");
    }
    this.publishDiagnostics();
  }

  async spawnWorker(voice, sourceFormat, { signal } = {}) {
    throwIfAborted(signal);
    this.lastInferenceMs = null;
    this.lastMetrics = null;
    this.publishDiagnostics();
    const profile = resolveSeedVcRuntimeProfile(this.platform, this.arch);
    if (!profile || this.paths.profile?.id !== profile.id ||
        typeof this.paths.requirementsPath !== "string" ||
        path.basename(this.paths.requirementsPath) !== profile.requirementsFile) {
      throw new Error("No qualified realtime Seed-VC profile exists for this platform");
    }
    const key = this.workerKey(voice, sourceFormat);
    const child = this.spawnProcess(this.paths.pythonPath, [
      "-I", "-u", this.paths.workerPath,
      "--seed-root", this.paths.seedRoot,
      "--runtime-root", this.paths.runtimeRoot,
      "--runtime-profile", profile.id,
      "--requirements-lock", this.paths.requirementsPath,
      "--device", profile.device,
      "--voice", voice.referencePath,
      "--voice-sha256", voice.referenceSha256,
      "--source-rate", String(sourceFormat.sampleRate),
      "--source-channels", String(sourceFormat.channels),
      "--steps", String(ENGINE_STEPS),
      "--block-ms", String(BLOCK_MS),
      "--prompt-seconds", String(this.promptSeconds),
      "--style-seconds", String(this.styleSeconds),
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: buildWorkerEnvironment(process.env, this.paths.runtimeRoot, this.platform),
    });
    let resolveReady;
    let rejectReady;
    const readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const worker = {
      child,
      key,
      voice,
      sourceFormat: { ...sourceFormat },
      pending: new Map(),
      ready: null,
      readyPromise,
      resolveReady,
      rejectReady,
      failure: null,
      closing: false,
      expectedExit: false,
      stderr: "",
    };
    this.worker = worker;
    const parser = new EngineMessageParser((message) => {
      try { this.handleWorkerMessage(worker, message); }
      catch (error) { this.failWorker(worker, error); }
    });
    child.stdout.on("data", (chunk) => {
      try { parser.push(chunk); }
      catch (error) { this.failWorker(worker, error); }
    });
    child.stderr.on("data", (chunk) => {
      const value = chunk.toString("utf8");
      worker.stderr = (worker.stderr + value).slice(-32_000);
      const line = value.trim();
      if (line) this.logger?.debug("engine.seed_vc_stderr", { message: line.slice(0, 2_000) });
    });
    child.stdin.on("error", (error) => {
      if (!worker.closing) this.failWorker(worker, error);
    });
    child.once("error", (error) => this.failWorker(worker, error));
    child.once("exit", (code, signal) => {
      try { parser.finish(); }
      catch (error) { if (!worker.closing) this.failWorker(worker, error); }
      if (!worker.closing && !worker.expectedExit) {
        this.failWorker(worker, new Error(
          worker.stderr.trim() ||
          `Seed-VC worker exited unexpectedly (code=${String(code)}, signal=${String(signal)})`,
        ));
      }
      if (this.worker === worker) this.worker = null;
      this.publishDiagnostics();
    });
    let abortStartup;
    const aborted = new Promise((_, reject) => {
      abortStartup = () => reject(abortReason(signal));
      signal?.addEventListener("abort", abortStartup, { once: true });
    });
    try {
      await withTimeout(
        signal ? Promise.race([readyPromise, aborted]) : readyPromise,
        this.startupTimeoutMs,
        `Seed-VC did not finish loading and warmup within ${this.startupTimeoutMs} ms`,
      );
      throwIfAborted(signal);
      return worker;
    } catch (error) {
      worker.closing = true;
      try {
        await this.terminateProcess(child);
      } catch (terminationError) {
        this.publishDiagnostics();
        throw new Error(
          `Seed-VC startup failed (${error instanceof Error ? error.message : String(error)}) and ` +
          `the worker could not be terminated: ${terminationError instanceof Error ? terminationError.message : String(terminationError)}`,
        );
      }
      if (this.worker === worker) this.worker = null;
      this.publishDiagnostics();
      throw error;
    } finally {
      if (abortStartup) signal?.removeEventListener("abort", abortStartup);
    }
  }

  async ensureWorker(voice, sourceFormat, { signal } = {}) {
    throwIfAborted(signal);
    const key = this.workerKey(voice, sourceFormat);
    if (this.worker?.ready && !this.worker.failure && !this.worker.closing &&
        this.worker.child.exitCode === null && this.worker.child.signalCode === null &&
        this.worker.key === key) return this.worker;
    if (this.startInFlight) {
      const worker = await this.startInFlight;
      if (worker.key !== key) throw new Error("A different voice engine profile is already loading");
      return worker;
    }
    const startController = new AbortController();
    const forwardAbort = () => startController.abort(abortReason(signal));
    signal?.addEventListener("abort", forwardAbort, { once: true });
    if (signal?.aborted) forwardAbort();
    this.startAbortController = startController;
    const startInFlight = (async () => {
      if (this.worker) await this.stopWorker();
      return this.spawnWorker(voice, sourceFormat, { signal: startController.signal });
    })();
    this.startInFlight = startInFlight;
    this.publishDiagnostics();
    try { return await startInFlight; }
    finally {
      signal?.removeEventListener("abort", forwardAbort);
      if (this.startAbortController === startController) this.startAbortController = null;
      if (this.startInFlight === startInFlight) this.startInFlight = null;
      this.publishDiagnostics();
    }
  }

  request(worker, type, body = Buffer.alloc(0), timeoutMs = this.controlTimeoutMs) {
    if (worker !== this.worker || worker.failure || !worker.ready || worker.closing ||
        worker.child.exitCode !== null || worker.child.signalCode !== null) {
      return Promise.reject(new Error("Seed-VC worker is not available"));
    }
    const id = this.nextRequestId;
    this.nextRequestId = this.nextRequestId >= 0xffff_ffff ? 1 : this.nextRequestId + 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.pending.delete(id);
        const error = new Error(`Seed-VC ${type} request ${id} timed out after ${timeoutMs} ms`);
        reject(error);
        this.failWorker(worker, error);
      }, timeoutMs);
      timer.unref?.();
      worker.pending.set(id, { resolve, reject, timer, type });
      void writeFrame(worker.child.stdin, encodeEngineMessage({ type, id }, body)).catch((error) => {
        const pending = worker.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        worker.pending.delete(id);
        pending.reject(error);
        this.failWorker(worker, error);
      });
    });
  }

  async prepare(settings, sourceFormat, { signal } = {}) {
    if (this.shutdownRequested) throw new Error("Seed-VC is shutting down");
    if (this.prepareInFlight) throw new Error("A Seed-VC prepare operation is already active");
    const prepareInFlight = this.prepareSession(settings, sourceFormat, { signal });
    this.prepareInFlight = prepareInFlight;
    try {
      return await prepareInFlight;
    } finally {
      if (this.prepareInFlight === prepareInFlight) this.prepareInFlight = null;
    }
  }

  async prepareSession(settings, sourceFormat, { signal } = {}) {
    throwIfAborted(signal);
    if (this.shutdownRequested) throw new Error("Seed-VC is shutting down");
    const readiness = this.installationReadiness(settings);
    if (!readiness.ready) throw new Error(readiness.detail);
    if (this.activeSession) throw new Error("A Seed-VC engine session is already active");
    const voice = this.voiceCatalog.resolve(settings.selectedVoiceId);
    const normalizedSource = {
      sampleRate: integer(sourceFormat?.sampleRate, "source sample rate", 8_000, 192_000),
      channels: integer(sourceFormat?.channels, "source channels", 1, 2),
      sampleFormat: sourceFormat?.sampleFormat,
    };
    if (normalizedSource.sampleFormat !== "f32le") throw new Error("Seed-VC requires an f32le audio source");
    const worker = await this.ensureWorker(voice, normalizedSource, { signal });
    throwIfAborted(signal);
    if (this.shutdownRequested) throw new Error("Seed-VC is shutting down");
    await this.request(worker, "reset");
    throwIfAborted(signal);
    if (this.shutdownRequested) throw new Error("Seed-VC is shutting down");
    const sourceBlockFrames = worker.ready.sourceBlockFrames;
    integer(sourceBlockFrames, "Seed-VC source block size", 1, 0xffff_ffff);
    const session = {
      active: true,
      worker,
      sourceChannels: normalizedSource.channels,
      pendingInput: Buffer.alloc(0),
      blockBytes: sourceBlockFrames * normalizedSource.channels * 4,
      outputBlockFrames: worker.ready.outputBlockFrames,
      startupDiscardSamples: Math.round(normalizedSource.sampleRate * STARTUP_DISCARD_MS / 1_000),
      startupDiscardSamplesRemaining: Math.round(
        normalizedSource.sampleRate * STARTUP_DISCARD_MS / 1_000,
      ),
      outputSequence: 0,
      convertedBlocks: 0,
      epoch: 0,
      resetDone: true,
    };
    this.activeSession = session;
    this.publishDiagnostics();
    const engine = this;
    return {
      outputFormat: { ...OUTPUT_FORMAT },
      prime: () => engine.primeSession(session),
      convert: (frame) => engine.convert(session, frame),
      reset: () => engine.resetSession(session),
      close: () => engine.closeSession(session),
    };
  }

  async primeSession(session) {
    if (!session.active || session !== this.activeSession || session.worker !== this.worker) {
      throw new Error("Seed-VC engine session is closed");
    }
    if (session.pendingInput.length !== 0) {
      throw new Error("Seed-VC cannot prime after source audio has entered the session");
    }
    const result = await this.request(session.worker, "prime", Buffer.alloc(0), this.controlTimeoutMs);
    const elapsedMs = Number.isFinite(result.header.elapsedMs) ? result.header.elapsedMs : null;
    this.logger?.info("engine.seed_vc_primed", { elapsedMs });
    return { elapsedMs };
  }

  async convert(session, frame) {
    if (!session.active || session !== this.activeSession || session.worker !== this.worker) {
      throw new Error("Seed-VC engine session is closed");
    }
    if (!Buffer.isBuffer(frame?.pcm)) throw new Error("Seed-VC input frame must contain PCM bytes");
    let pcm = frame.pcm;
    if (session.startupDiscardSamplesRemaining > 0) {
      const bytesPerSampleFrame = session.sourceChannels * Float32Array.BYTES_PER_ELEMENT;
      const availableSamples = pcm.length / bytesPerSampleFrame;
      if (!Number.isInteger(availableSamples)) {
        throw new Error("Seed-VC input PCM is not aligned to its source channels");
      }
      const discardedSamples = Math.min(session.startupDiscardSamplesRemaining, availableSamples);
      session.startupDiscardSamplesRemaining -= discardedSamples;
      pcm = pcm.subarray(discardedSamples * bytesPerSampleFrame);
      if (session.startupDiscardSamplesRemaining === 0) {
        this.logger?.info("engine.seed_vc_startup_discard_complete", {
          discardedMs: STARTUP_DISCARD_MS,
        });
      }
      if (pcm.length === 0) return [];
    }
    session.resetDone = false;
    session.pendingInput = session.pendingInput.length === 0
      ? Buffer.from(pcm)
      : Buffer.concat([session.pendingInput, pcm]);
    const output = [];
    while (session.pendingInput.length >= session.blockBytes) {
      const epoch = session.epoch;
      const block = Buffer.from(session.pendingInput.subarray(0, session.blockBytes));
      session.pendingInput = session.pendingInput.subarray(session.blockBytes);
      const result = await this.request(session.worker, "convert", block, this.convertTimeoutMs);
      if (!session.active || session.epoch !== epoch) return [];
      const metadata = result.header;
      if (metadata.type !== "result" || metadata.sampleRate !== OUTPUT_FORMAT.sampleRate ||
          metadata.channels !== OUTPUT_FORMAT.channels || metadata.sampleFormat !== OUTPUT_FORMAT.sampleFormat ||
          metadata.samplesPerChannel !== session.outputBlockFrames ||
          result.body.length !== metadata.samplesPerChannel * 4) {
        throw new Error("Seed-VC worker returned an invalid PCM result");
      }
      this.lastInferenceMs = Number.isFinite(metadata.elapsedMs) ? metadata.elapsedMs : null;
      this.lastMetrics = {
        inputRms: metadata.inputRms,
        silent: metadata.silent,
        mpsCurrentAllocatedBytes: metadata.mpsCurrentAllocatedBytes ?? null,
        mpsDriverAllocatedBytes: metadata.mpsDriverAllocatedBytes ?? null,
        mpsRecommendedMaxBytes: metadata.mpsRecommendedMaxBytes ?? null,
        cudaAllocatedBytes: metadata.cudaAllocatedBytes ?? null,
        cudaReservedBytes: metadata.cudaReservedBytes ?? null,
      };
      this.publishDiagnostics();
      session.convertedBlocks += 1;
      if (session.convertedBlocks === 1 || session.convertedBlocks % 100 === 0) {
        this.logger?.info("engine.seed_vc_block", {
          block: session.convertedBlocks,
          inputRms: metadata.inputRms,
          silent: metadata.silent,
          elapsedMs: metadata.elapsedMs,
        });
      }
      const frameSamples = Math.round(OUTPUT_FORMAT.sampleRate * OUTPUT_FRAME_MS / 1000);
      if (metadata.samplesPerChannel % frameSamples !== 0) {
        throw new Error("Seed-VC output block cannot be divided into bounded playback frames");
      }
      for (let sampleOffset = 0; sampleOffset < metadata.samplesPerChannel; sampleOffset += frameSamples) {
        const byteOffset = sampleOffset * 4;
        output.push({
          sequence: session.outputSequence,
          itemId: frame.itemId ?? null,
          sampleRate: OUTPUT_FORMAT.sampleRate,
          channels: OUTPUT_FORMAT.channels,
          sampleFormat: OUTPUT_FORMAT.sampleFormat,
          samplesPerChannel: frameSamples,
          pcm: Buffer.from(result.body.subarray(byteOffset, byteOffset + frameSamples * 4)),
        });
        session.outputSequence = (session.outputSequence + 1) >>> 0;
      }
    }
    return output;
  }

  async resetSession(session) {
    if (!session.active) return;
    session.epoch += 1;
    session.pendingInput = Buffer.alloc(0);
    session.startupDiscardSamplesRemaining = session.startupDiscardSamples;
    if (session.resetDone) return;
    const worker = session.worker;
    try {
      await this.request(worker, "reset", Buffer.alloc(0), this.controlTimeoutMs);
    } catch (error) {
      try { await this.terminateProcess(worker.child); }
      catch (terminationError) {
        throw new Error(
          `Seed-VC reset failed (${error instanceof Error ? error.message : String(error)}) and the worker could not be terminated: ` +
          `${terminationError instanceof Error ? terminationError.message : String(terminationError)}`,
        );
      }
      if (this.worker === worker) this.worker = null;
      session.resetDone = true;
      session.active = false;
      session.pendingInput = Buffer.alloc(0);
      if (this.activeSession === session) this.activeSession = null;
      this.publishDiagnostics();
      throw new Error(
        `Seed-VC reset failed and the worker was terminated; the engine session is closed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    session.resetDone = true;
  }

  async closeSession(session) {
    if (!session.active) return;
    if (!session.resetDone) await this.resetSession(session);
    session.active = false;
    session.pendingInput = Buffer.alloc(0);
    if (this.activeSession === session) this.activeSession = null;
    this.publishDiagnostics();
  }

  async stopWorker() {
    const worker = this.worker;
    if (!worker) return;
    if (this.activeSession?.worker === worker) throw new Error("Cannot stop Seed-VC while its relay session is active");
    let stopped = false;
    try {
      if (worker.ready && !worker.failure && worker.child.exitCode === null && worker.child.signalCode === null) {
        worker.expectedExit = true;
        try { await this.request(worker, "shutdown"); }
        catch {}
      }
      worker.closing = true;
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.stdin.end();
      try { await this.waitForProcessExit(worker.child, 2_000); }
      catch { await this.terminateProcess(worker.child); }
      if (worker.child.exitCode === null && worker.child.signalCode === null) {
        throw new Error("Seed-VC worker termination could not be proven");
      }
      stopped = true;
    } finally {
      if (stopped) {
        if (this.worker === worker) this.worker = null;
        this.lastInferenceMs = null;
        this.lastMetrics = null;
      }
      this.publishDiagnostics();
    }
  }

  shutdown() {
    if (this.shutdownInFlight) return this.shutdownInFlight;
    this.shutdownRequested = true;
    this.startAbortController?.abort(new Error("Seed-VC shutdown cancelled engine startup"));
    const operation = (async () => {
      if (this.prepareInFlight) await this.prepareInFlight.catch(() => {});
      if (this.activeSession) await this.closeSession(this.activeSession);
      await this.stopWorker();
    })();
    const tracked = operation.finally(() => {
      if (this.shutdownInFlight === tracked) this.shutdownInFlight = null;
      this.shutdownRequested = false;
      this.publishDiagnostics();
    });
    this.shutdownInFlight = tracked;
    return tracked;
  }
}

module.exports = {
  BLOCK_MS,
  CONVERT_TIMEOUT_MS,
  CONTROL_TIMEOUT_MS,
  ENGINE_STEPS,
  OUTPUT_FORMAT,
  OUTPUT_BLOCK_FRAMES,
  OUTPUT_FRAME_MS,
  PROMPT_SECONDS,
  SEED_VC_RUNTIME_PROFILES,
  STYLE_SECONDS,
  STYLE_DEVICE,
  STARTUP_DISCARD_MS,
  STARTUP_TIMEOUT_MS,
  SeedVcEngine,
  buildWorkerEnvironment,
  inspectSeedVcRuntime,
  pythonPathForRuntime,
  resolveSeedVcPaths,
  resolveSeedVcRuntimeProfile,
  withTimeout,
};
