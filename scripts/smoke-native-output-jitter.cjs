"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");
const { NativeFrameParser, encodeAudioFrame, writeFrame } = require("../electron/native-protocol.cjs");
const { terminateChild, waitForExit } = require("../electron/native-helper.cjs");

const PROJECT_ROOT = path.join(__dirname, "..");
const SAMPLE_RATE = 24_000;
const FRAME_SAMPLES = 480;
const FRAMES_PER_BLOCK = 15;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function runScenario({ helperPath, intervals, minimumUnderruns, maximumUnderruns }) {
  const child = spawn(helperPath, ["--sample-rate", String(SAMPLE_RATE), "--channels", "1"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages = [];
  let parseError = null;
  let stderr = "";
  let resolveReady;
  let rejectReady;
  const readyPromise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const parser = new NativeFrameParser((message) => {
    messages.push(message);
    if (message.type === "ready") resolveReady(message);
    else if (message.type === "error") rejectReady(new Error(message.message || "Output failed"));
  });
  child.stdout.on("data", (chunk) => {
    try { parser.push(chunk); }
    catch (error) { parseError = error; rejectReady(error); }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  child.once("error", rejectReady);

  let sequence = 0;
  const sendBlock = async () => {
    for (let index = 0; index < FRAMES_PER_BLOCK; index += 1) {
      await writeFrame(child.stdin, encodeAudioFrame({
        sequence,
        sampleRate: SAMPLE_RATE,
        channels: 1,
        sampleFormat: "f32le",
        samplesPerChannel: FRAME_SAMPLES,
        pcm: Buffer.alloc(FRAME_SAMPLES * Float32Array.BYTES_PER_ELEMENT),
      }));
      sequence = (sequence + 1) >>> 0;
    }
  };

  try {
    const ready = await Promise.race([
      readyPromise,
      delay(5_000).then(() => { throw new Error("Output readiness timed out"); }),
    ]);
    if (ready.supportsJitterBuffer !== true || ready.startsWhenQueueFull !== true ||
        ready.startupPrebufferMs !== 500 || !Array.isArray(ready.memberDeviceUids) ||
        ready.memberDeviceUidsVerified !== true ||
        typeof ready.isAggregateDevice !== "boolean" ||
        ready.queueCapacityFrames < 45) {
      throw new Error("Output did not declare the expected bounded jitter buffer");
    }
    await sendBlock();
    for (const interval of intervals) {
      await delay(interval);
      await sendBlock();
    }
    child.stdin.end();
    await waitForExit(child, 8_000);
    parser.finish();
    if (parseError) throw parseError;
    if (child.exitCode !== 0) throw new Error(stderr.trim() || `Output exited with ${child.exitCode}`);
    const underruns = messages
      .filter((message) => message.type === "status" && message.state === "rebuffering")
      .length;
    const recovered = messages.some((message) =>
      message.type === "status" && message.reason === "jitter_buffer_recovered");
    if (underruns < minimumUnderruns || underruns > maximumUnderruns ||
        (minimumUnderruns > 0 && !recovered)) {
      throw new Error(
        `Unexpected jitter-buffer lifecycle (underruns=${underruns}, recovered=${recovered}, ` +
        `statuses=${JSON.stringify(messages.filter((message) => message.type === "status"))})`,
      );
    }
    return { underruns, recovered };
  } finally {
    child.stdin.destroy();
    await terminateChild(child).catch(() => {});
  }
}

async function smokeNativeOutputJitter({
  helperPath = path.join(PROJECT_ROOT, "native/bin/darwin/cpv-audio-output"),
} = {}) {
  if (process.platform !== "darwin") throw new Error("Native output jitter smoke test requires macOS");
  const stable = await runScenario({
    helperPath,
    intervals: [315, 340, 280, 370, 250],
    minimumUnderruns: 0,
    maximumUnderruns: 0,
  });
  const recovery = await runScenario({
    helperPath,
    intervals: [300, 2_000],
    minimumUnderruns: 1,
    maximumUnderruns: 1,
  });
  return { stable, recovery };
}

if (require.main === module) {
  smokeNativeOutputJitter().then((result) => {
    console.log(
      `Core Audio jitter buffer passed (stable underruns=${result.stable.underruns}, ` +
      `forced recovery underruns=${result.recovery.underruns}).`,
    );
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = { runScenario, smokeNativeOutputJitter };
