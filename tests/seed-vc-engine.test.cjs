"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const { EngineMessageParser, encodeEngineMessage } = require("../electron/engine-protocol.cjs");
const {
  STARTUP_DISCARD_MS,
  SeedVcEngine,
  buildWorkerEnvironment,
  resolveSeedVcPaths,
} = require("../electron/seed-vc-engine.cjs");

class FakeWorker extends EventEmitter {
  constructor({
    resetResponses = Infinity,
    emitReady = true,
    sourceBlockFrames = 14_400,
    outputBlockFrames = 6_615,
    resultSamplesPerChannel = 6_615,
    promptSeconds = 3,
    styleSeconds = 17,
    styleSecondsUsed = 8,
    styleDevice = "cpu",
    resetResponseType = "reset",
    resetResponseBody = Buffer.alloc(0),
    afterReady = null,
  } = {}) {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.convertBodies = [];
    this.primeRequests = 0;
    this.resetRequests = 0;
    const parser = new EngineMessageParser(({ header, body }) => {
      if (header.type === "convert") {
        this.convertBodies.push(Buffer.from(body));
        const output = Buffer.alloc(resultSamplesPerChannel * 4);
        for (let offset = 0; offset < output.length; offset += 4) output.writeFloatLE(0.25, offset);
        this.stdout.write(encodeEngineMessage({
          type: "result",
          id: header.id,
          sampleRate: 22_050,
          channels: 1,
          sampleFormat: "f32le",
          samplesPerChannel: resultSamplesPerChannel,
          elapsedMs: 123.4,
          mpsCurrentAllocatedBytes: 1_024,
          mpsDriverAllocatedBytes: 2_048,
          mpsRecommendedMaxBytes: 4_096,
        }, output));
      } else if (header.type === "prime") {
        this.primeRequests += 1;
        this.stdout.write(encodeEngineMessage({
          type: "prime",
          id: header.id,
          elapsedMs: 87.5,
        }));
      } else if (header.type === "reset") {
        this.resetRequests += 1;
        if (this.resetRequests <= resetResponses) {
          this.stdout.write(encodeEngineMessage({
            type: resetResponseType,
            id: header.id,
          }, resetResponseBody));
        }
      } else if (header.type === "shutdown") {
        this.stdout.write(encodeEngineMessage({ type: "shutdown", id: header.id }));
        setImmediate(() => {
          this.exitCode = 0;
          this.emit("exit", 0, null);
        });
      }
    });
    this.stdin.on("data", (chunk) => parser.push(chunk));
    if (emitReady) setImmediate(() => {
      this.stdout.write(encodeEngineMessage({
        type: "ready",
        protocolVersion: 1,
        engine: "seed-vc-tiny-realtime",
        sampleRate: 22_050,
        channels: 1,
        sampleFormat: "f32le",
        sourceBlockFrames,
        outputBlockFrames,
        steps: 10,
        promptSeconds,
        styleSeconds,
        styleSecondsUsed,
        styleDevice,
        loadSeconds: 1,
        warmupSeconds: 2,
        torch: "2.13.0",
      }));
      afterReady?.();
    });
  }

  kill(signal) {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    setImmediate(() => {
      this.signalCode = signal;
      this.emit("exit", null, signal);
    });
    return true;
  }
}

function fixture({
  workerOptions,
  controlTimeoutMs,
  terminateProcess,
  waitForProcessExit,
  promptSeconds,
  styleSeconds,
} = {}) {
  let worker = null;
  const spawns = [];
  const diagnostics = [];
  const voice = {
    id: "licensed-voice",
    name: "Licensed Voice",
    referencePath: "/voices/licensed.wav",
    referenceSha256: "a".repeat(64),
  };
  const lockText = JSON.stringify({
    schemaVersion: 1,
    seedVcCommit: "pinned",
    repositories: {
      "fixture/model": {
        files: Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`model-${index}`, "hash"])),
      },
    },
  });
  const lockSha256 = crypto.createHash("sha256").update(lockText).digest("hex");
  const engine = new SeedVcEngine({
    paths: {
      pythonPath: "/runtime/python",
      workerPath: "/engine/worker.py",
      seedRoot: "/engine/seed-vc",
      runtimeRoot: "/runtime",
      modelLockPath: "/engine/model-lock.json",
      installManifestPath: "/runtime/install-manifest.json",
    },
    voiceCatalog: {
      resolve: (id) => {
        if (id !== voice.id) throw new Error("Select an installed target voice");
        return voice;
      },
    },
    platform: "darwin",
    arch: "arm64",
    exists: () => true,
    readFile: (filePath) => filePath.endsWith("model-lock.json")
      ? lockText
      : JSON.stringify({
        schemaVersion: 1,
        seedVcCommit: "pinned",
        modelLockSha256: lockSha256,
        files: Array(7).fill({}),
      }),
    spawnProcess: (executable, args, options) => {
      spawns.push({ executable, args, options });
      worker = new FakeWorker(workerOptions);
      return worker;
    },
    onDiagnostics: (value) => diagnostics.push(value),
    ...(controlTimeoutMs ? { controlTimeoutMs } : {}),
    ...(terminateProcess ? { terminateProcess } : {}),
    ...(waitForProcessExit ? { waitForProcessExit } : {}),
    ...(promptSeconds === undefined ? {} : { promptSeconds }),
    ...(styleSeconds === undefined ? {} : { styleSeconds }),
  });
  return { diagnostics, engine, spawns, get worker() { return worker; } };
}

function sourceFrame(sequence) {
  return {
    sequence,
    sampleRate: 48_000,
    channels: 2,
    sampleFormat: "f32le",
    samplesPerChannel: 960,
    pcm: Buffer.alloc(960 * 2 * 4),
  };
}

test("Seed-VC discards the first three seconds, then emits bounded 20 ms output frames", async () => {
  const value = fixture();
  const settings = { selectedVoiceId: "licensed-voice", selectedVoiceName: "Licensed Voice" };
  assert.equal((await value.engine.probe(settings)).ready, true);
  const session = await value.engine.prepare(settings, {
    sampleRate: 48_000,
    channels: 2,
    sampleFormat: "f32le",
  });
  assert.deepEqual(await session.prime(), { elapsedMs: 87.5 });
  assert.equal(value.worker.primeRequests, 1);
  assert.equal(STARTUP_DISCARD_MS, 3_000);
  for (let sequence = 0; sequence < 164; sequence += 1) {
    assert.deepEqual(await session.convert(sourceFrame(sequence)), []);
  }
  assert.equal(value.worker.convertBodies.length, 0);
  const output = await session.convert(sourceFrame(164));
  assert.equal(value.worker.convertBodies.length, 1);
  assert.equal(value.worker.convertBodies[0].length, 14_400 * 2 * 4);
  assert.equal(output.length, 15);
  assert.equal(output.every((frame) => frame.samplesPerChannel === 441), true);
  assert.equal(output.every((frame) => frame.pcm.length === 441 * 4), true);
  assert.deepEqual(output.map((frame) => frame.sequence), Array.from({ length: 15 }, (_, index) => index));
  assert.equal(value.engine.lastInferenceMs, 123.4);
  assert.deepEqual(value.engine.diagnostics(), {
    profile: "seed-vc-tiny-realtime",
    workerState: "ready",
    active: true,
    voiceId: "licensed-voice",
    steps: 10,
    blockMs: 300,
    promptSeconds: 3,
    styleSeconds: 17,
    styleSecondsUsed: 8,
    styleDevice: "cpu",
    startupDiscardMs: 3_000,
    convertedBlocks: 1,
    loadSeconds: 1,
    warmupSeconds: 2,
    torch: "2.13.0",
    lastInferenceMs: 123.4,
    mpsCurrentAllocatedBytes: 1_024,
    mpsDriverAllocatedBytes: 2_048,
    mpsRecommendedMaxBytes: 4_096,
  });
  assert.ok(value.diagnostics.length >= 3);
  await session.reset();
  for (let sequence = 0; sequence < 150; sequence += 1) {
    assert.deepEqual(await session.convert(sourceFrame(sequence)), []);
  }
  assert.equal(value.worker.convertBodies.length, 1);
  await session.close();
  await value.engine.shutdown();
  assert.equal(value.engine.worker, null);
});

test("Seed-VC probe blocks unsupported hosts and missing voice selection", async () => {
  const value = fixture();
  value.engine.platform = "linux";
  assert.equal((await value.engine.probe({ selectedVoiceId: "licensed-voice" })).code, "seed_vc_platform_unavailable");
  value.engine.platform = "darwin";
  assert.equal((await value.engine.probe({ selectedVoiceId: null })).code, "target_voice_required");
  assert.equal((await value.engine.probe({
    selectedVoiceId: "licensed-voice",
    selectedVoiceName: "Tampered name",
  })).code, "target_voice_state_invalid");
});

test("packaged shell directs missing runtimes to the in-app engine package", async () => {
  const value = fixture();
  value.engine.paths.packaged = true;
  value.engine.exists = () => false;
  const readiness = await value.engine.probe({
    selectedVoiceId: "licensed-voice",
    selectedVoiceName: "Licensed Voice",
  });
  assert.equal(readiness.code, "seed_vc_runtime_missing");
  assert.match(readiness.detail, /install the separate engine package from Voice settings/);
  assert.doesNotMatch(readiness.detail, /bun run/);
  assert.equal(resolveSeedVcPaths({
    isPackaged: true,
    resourcesPath: "/App/Contents/Resources",
    runtimeRoot: "/user-data/engine/seed-vc",
  }).packaged, true);
});

test("Seed-VC worker starts in isolated Python with injection variables removed", async () => {
  const sanitized = buildWorkerEnvironment({
    PATH: "/usr/bin",
    PYTHONPATH: "/tmp/attacker",
    PYTHONHOME: "/tmp/python-home",
    PYTORCH_ENABLE_MPS_FALLBACK: "1",
    DYLD_INSERT_LIBRARIES: "/tmp/injected.dylib",
    LD_PRELOAD: "/tmp/injected.so",
    OPENAI_API_KEY: "secret",
    HF_TOKEN: "secret",
    AWS_SECRET_ACCESS_KEY: "secret",
  }, "/private/runtime");
  assert.equal(sanitized.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
  assert.equal(sanitized.PYTHONUNBUFFERED, "1");
  assert.equal(sanitized.PYTHONNOUSERSITE, "1");
  assert.equal(sanitized.TQDM_DISABLE, "1");
  assert.equal(sanitized.HOME, "/private/runtime");
  assert.equal(sanitized.XDG_CACHE_HOME, path.join("/private/runtime", ".cache"));
  assert.equal(sanitized.HF_HUB_DISABLE_IMPLICIT_TOKEN, "1");
  for (const key of [
    "PYTHONPATH", "PYTHONHOME", "PYTORCH_ENABLE_MPS_FALLBACK",
    "DYLD_INSERT_LIBRARIES", "LD_PRELOAD", "OPENAI_API_KEY", "HF_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
  ]) assert.equal(key in sanitized, false);

  const value = fixture();
  const session = await value.engine.prepare(
    { selectedVoiceId: "licensed-voice", selectedVoiceName: "Licensed Voice" },
    { sampleRate: 48_000, channels: 2, sampleFormat: "f32le" },
  );
  assert.deepEqual(value.spawns[0].args.slice(0, 2), ["-I", "-u"]);
  const voiceHashIndex = value.spawns[0].args.indexOf("--voice-sha256");
  assert.notEqual(voiceHashIndex, -1);
  assert.equal(value.spawns[0].args[voiceHashIndex + 1], "a".repeat(64));
  const promptIndex = value.spawns[0].args.indexOf("--prompt-seconds");
  assert.notEqual(promptIndex, -1);
  assert.equal(value.spawns[0].args[promptIndex + 1], "3");
  const styleIndex = value.spawns[0].args.indexOf("--style-seconds");
  assert.notEqual(styleIndex, -1);
  assert.equal(value.spawns[0].args[styleIndex + 1], "17");
  assert.equal(value.spawns[0].options.env.PYTHONNOUSERSITE, "1");
  await session.close();
  await value.engine.shutdown();
});

test("Seed-VC prompt duration is explicit and worker readiness must match it", async () => {
  const value = fixture({ promptSeconds: 6, workerOptions: { promptSeconds: 3 } });
  await assert.rejects(() => value.engine.prepare(
    { selectedVoiceId: "licensed-voice", selectedVoiceName: "Licensed Voice" },
    { sampleRate: 48_000, channels: 2, sampleFormat: "f32le" },
  ), /readiness does not match/);
  const promptIndex = value.spawns[0].args.indexOf("--prompt-seconds");
  assert.equal(value.spawns[0].args[promptIndex + 1], "6");
  assert.equal(value.engine.worker, null);
  assert.throws(() => fixture({ promptSeconds: 16 }), /prompt seconds must be a finite number/);
  assert.throws(() => fixture({ styleSeconds: 31 }), /style seconds must be a finite number/);
});

test("Seed-VC rejects mismatched long-reference worker profiles", async () => {
  for (const options of [
    { styleSeconds: 10, workerOptions: { styleSeconds: 15 } },
    { workerOptions: { styleDevice: "mps" } },
  ]) {
    const value = fixture(options);
    await assert.rejects(() => value.engine.prepare(
      { selectedVoiceId: "licensed-voice", selectedVoiceName: "Licensed Voice" },
      { sampleRate: 48_000, channels: 2, sampleFormat: "f32le" },
    ), /readiness does not match/);
    assert.equal(value.engine.worker, null);
  }
});

test("a failed reset terminates the worker, closes the session, and remains an explicit failure", async () => {
  const value = fixture({ workerOptions: { resetResponses: 1 }, controlTimeoutMs: 5 });
  const settings = { selectedVoiceId: "licensed-voice", selectedVoiceName: "Licensed Voice" };
  const session = await value.engine.prepare(settings, {
    sampleRate: 48_000,
    channels: 2,
    sampleFormat: "f32le",
  });
  for (let sequence = 0; sequence < 165; sequence += 1) await session.convert(sourceFrame(sequence));

  const keepAlive = setInterval(() => {}, 100);
  try {
    await assert.rejects(
      () => session.reset(),
      /reset failed and the worker was terminated.*session is closed/,
    );
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(value.engine.worker, null);
  assert.equal(value.engine.diagnostics().workerState, "stopped");
  assert.equal(value.engine.diagnostics().active, false);
  await assert.rejects(() => session.convert(sourceFrame(200)), /session is closed/);
  await session.close();
});

test("Seed-VC rejects invalid reset acknowledgements", async () => {
  for (const { workerOptions, message } of [
    {
      workerOptions: { resetResponseType: "result" },
      message: /replied with result to reset request.*expected reset/,
    },
    {
      workerOptions: { resetResponseBody: Buffer.alloc(4) },
      message: /reset acknowledgement must not contain a body/,
    },
  ]) {
    const value = fixture({ workerOptions });
    await assert.rejects(() => value.engine.prepare(
      { selectedVoiceId: "licensed-voice", selectedVoiceName: "Licensed Voice" },
      { sampleRate: 48_000, channels: 2, sampleFormat: "f32le" },
    ), message);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(value.engine.worker, null);
  }
});

test("an aborted engine startup terminates the loading worker immediately", async () => {
  const value = fixture({ workerOptions: { emitReady: false } });
  const controller = new AbortController();
  const preparing = value.engine.prepare(
    { selectedVoiceId: "licensed-voice", selectedVoiceName: "Licensed Voice" },
    { sampleRate: 48_000, channels: 2, sampleFormat: "f32le" },
    { signal: controller.signal },
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error("cancelled by Stop"));
  await assert.rejects(preparing, /cancelled by Stop/);
  assert.equal(value.engine.worker, null);
  assert.equal(value.engine.diagnostics().workerState, "stopped");
});

test("a later prepare retires a ready worker retained after unproven abort cleanup", async () => {
  const controller = new AbortController();
  let terminationAttempts = 0;
  const value = fixture({
    workerOptions: {
      afterReady: () => controller.abort(new Error("cancelled after worker readiness")),
    },
    terminateProcess: async (child) => {
      terminationAttempts += 1;
      if (terminationAttempts === 1) throw new Error("termination not proven");
      child.exitCode = 0;
      child.emit("exit", 0, null);
    },
    waitForProcessExit: async () => { throw new Error("worker still alive"); },
  });
  const settings = { selectedVoiceId: "licensed-voice", selectedVoiceName: "Licensed Voice" };
  const format = { sampleRate: 48_000, channels: 2, sampleFormat: "f32le" };

  await assert.rejects(
    () => value.engine.prepare(settings, format, { signal: controller.signal }),
    /worker could not be terminated.*termination not proven/,
  );
  const retainedWorker = value.engine.worker;
  assert.equal(retainedWorker.closing, true);
  assert.equal(retainedWorker.child.exitCode, null);
  assert.equal(value.engine.diagnostics().workerState, "stopped");

  const session = await value.engine.prepare(settings, format);
  assert.equal(terminationAttempts, 2);
  assert.notEqual(value.engine.worker, retainedWorker);
  await session.close();
  await value.engine.shutdown();
});

test("shutdown seals and drains a concurrent replacement-worker prepare", async () => {
  const value = fixture();
  const settings = { selectedVoiceId: "licensed-voice", selectedVoiceName: "Licensed Voice" };
  const first = await value.engine.prepare(settings, {
    sampleRate: 48_000,
    channels: 2,
    sampleFormat: "f32le",
  });
  await first.close();

  const replacement = value.engine.prepare(settings, {
    sampleRate: 44_100,
    channels: 2,
    sampleFormat: "f32le",
  });
  const shutdown = value.engine.shutdown();
  const rejectedDuringShutdown = assert.rejects(value.engine.prepare(settings, {
    sampleRate: 48_000,
    channels: 2,
    sampleFormat: "f32le",
  }), /shutting down/);
  await Promise.all([
    assert.rejects(replacement, /shutdown cancelled engine startup|shutting down/),
    rejectedDuringShutdown,
  ]);
  await shutdown;

  assert.equal(value.engine.worker, null);
  assert.equal(value.engine.startInFlight, null);
  assert.equal(value.engine.prepareInFlight, null);
  assert.equal(value.engine.diagnostics().workerState, "stopped");
});

test("Seed-VC rejects a worker that advertises an unbounded source block", async () => {
  const value = fixture({ workerOptions: { sourceBlockFrames: 0xffff_ffff } });
  await assert.rejects(() => value.engine.prepare(
    { selectedVoiceId: "licensed-voice", selectedVoiceName: "Licensed Voice" },
    { sampleRate: 48_000, channels: 2, sampleFormat: "f32le" },
  ), /readiness does not match/);
  assert.equal(value.engine.worker, null);
});

test("Seed-VC rejects result amplification beyond the fixed 300 ms output block", async () => {
  const value = fixture({ workerOptions: { resultSamplesPerChannel: 13_230 } });
  const session = await value.engine.prepare(
    { selectedVoiceId: "licensed-voice", selectedVoiceName: "Licensed Voice" },
    { sampleRate: 48_000, channels: 2, sampleFormat: "f32le" },
  );
  for (let sequence = 0; sequence < 164; sequence += 1) await session.convert(sourceFrame(sequence));
  await assert.rejects(() => session.convert(sourceFrame(164)), /invalid PCM result/);
  await session.reset();
  await session.close();
  await value.engine.shutdown();
});
