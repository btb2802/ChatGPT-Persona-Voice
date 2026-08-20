"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const { LinuxAudioOutput } = require("../electron/linux-audio-output.cjs");
const { NativeFrameParser, encodeFrame } = require("../electron/native-protocol.cjs");

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.stdin.on("finish", () => {
    child.exitCode = 0;
    queueMicrotask(() => child.emit("exit", 0, null));
  });
  child.kill = (signal = "SIGTERM") => {
    child.signalCode = signal;
    queueMicrotask(() => child.emit("exit", null, signal));
    return true;
  };
  return child;
}

function readiness({ sampleRate = 24_000, channels = 1, targetObject = "@DEFAULT_AUDIO_SINK@", usesDefaultDevice = true } = {}) {
  return encodeFrame("ready", Buffer.from(JSON.stringify({
    type: "ready",
    helper: "output",
    protocolVersion: 1,
    sampleRate,
    channels,
    sampleFormat: "f32le",
    maximumFrameDurationMs: 40,
    queueCapacityFrames: 64,
    supportsJitterBuffer: true,
    startsWhenQueueFull: true,
    startupPrebufferMs: 500,
    supportsNativePipeWire: true,
    targetObject,
    usesDefaultDevice,
  })));
}

function fixture(child = fakeChild()) {
  const spawns = [];
  const output = new LinuxAudioOutput({
    helperPath: "/helpers/output",
    platform: "linux",
    exists: () => true,
    probeHelper: async (_path, _helper, options) => ({
      supportsNativePipeWire: true,
      supportsJitterBuffer: true,
      startsWhenQueueFull: true,
      startupPrebufferMs: 500,
      queueCapacityFrames: 64,
      targetObject: options?.args?.includes("sink.serial") ? "sink.serial" : "@DEFAULT_AUDIO_SINK@",
      usesDefaultDevice: !options?.args?.includes("sink.serial"),
    }),
    spawnProcess: (executable, args) => {
      spawns.push({ executable, args });
      return child;
    },
  });
  return { child, output, spawns };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("Linux output writes CPV1 PCM only after exact PipeWire readiness", async () => {
  const { child, output, spawns } = fixture();
  const preparing = output.prepare({}, { sampleRate: 24_000, channels: 1, sampleFormat: "f32le" }, () => {});
  await nextTurn();
  child.stdout.emit("data", readiness());
  const session = await preparing;
  assert.deepEqual(spawns[0].args, ["--sample-rate", "24000", "--channels", "1"]);
  const chunks = [];
  child.stdin.on("data", (chunk) => chunks.push(chunk));
  const pcm = Buffer.alloc(240 * 4);
  await session.write({
    sequence: 0, sampleRate: 24_000, channels: 1, sampleFormat: "f32le", samplesPerChannel: 240, pcm,
  });
  const messages = [];
  const parser = new NativeFrameParser((message) => messages.push(message));
  parser.push(Buffer.concat(chunks));
  parser.finish();
  assert.equal(messages.length, 1);
  assert.deepEqual(Buffer.from(messages[0].pcm), pcm);
  await session.close();
});

test("Linux output binds an explicit PipeWire target by stable object serial or name", async () => {
  const { child, output, spawns } = fixture();
  const preparing = output.prepare(
    { outputDeviceUid: "sink.serial" },
    { sampleRate: 24_000, channels: 1, sampleFormat: "f32le" },
    () => {},
  );
  await nextTurn();
  child.stdout.emit("data", readiness({ targetObject: "sink.serial", usesDefaultDevice: false }));
  const session = await preparing;
  assert.deepEqual(spawns[0].args, [
    "--sample-rate", "24000", "--channels", "1", "--target-object", "sink.serial",
  ]);
  assert.equal(session.targetObject, "sink.serial");
  assert.equal(session.usesDefaultDevice, false);
  await session.close();
});

test("Linux output rejects format drift before it reaches the bounded native queue", async () => {
  const { child, output } = fixture();
  const preparing = output.prepare({}, { sampleRate: 24_000, channels: 1, sampleFormat: "f32le" }, () => {});
  await nextTurn();
  child.stdout.emit("data", readiness());
  const session = await preparing;
  await assert.rejects(() => session.write({
    sequence: 0, sampleRate: 48_000, channels: 1, samplesPerChannel: 240, pcm: Buffer.alloc(960),
  }), /does not match/);
  await session.close();
});

test("Linux output reports malformed native jitter state as an output fault", async () => {
  const { child, output } = fixture();
  const errors = [];
  const preparing = output.prepare({}, { sampleRate: 24_000, channels: 1, sampleFormat: "f32le" }, (error) => errors.push(error));
  await nextTurn();
  child.stdout.emit("data", readiness());
  const session = await preparing;
  child.stdout.emit("data", encodeFrame("status", Buffer.from(JSON.stringify({
    type: "status", helper: "output", state: "running", underruns: -1,
  }))));
  assert.equal(errors.length, 1);
  await assert.rejects(() => session.write({
    sequence: 0, sampleRate: 24_000, channels: 1, samplesPerChannel: 240, pcm: Buffer.alloc(960),
  }), /closed/);
  await session.close();
});
