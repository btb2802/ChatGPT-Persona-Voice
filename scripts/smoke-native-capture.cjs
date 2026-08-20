"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { NativeFrameParser } = require("../electron/native-protocol.cjs");
const { terminateChild } = require("../electron/native-helper.cjs");
const { encodePcm16Wav } = require("../electron/wav.cjs");

const PROJECT_ROOT = path.join(__dirname, "..");

function quietTone({ sampleRate = 48_000, seconds = 4, frequency = 440 } = {}) {
  const samplesPerChannel = sampleRate * seconds;
  const pcm = Buffer.allocUnsafe(samplesPerChannel * 4);
  for (let sample = 0; sample < samplesPerChannel; sample += 1) {
    pcm.writeFloatLE(Math.sin(2 * Math.PI * frequency * sample / sampleRate) * 0.015, sample * 4);
  }
  return encodePcm16Wav({ chunks: [pcm], sampleRate, channels: 1, samplesPerChannel });
}

function rms(pcm) {
  let sum = 0;
  for (let offset = 0; offset < pcm.length; offset += 4) {
    const sample = pcm.readFloatLE(offset);
    sum += sample * sample;
  }
  return Math.sqrt(sum / (pcm.length / 4));
}

async function smokeCapture({
  helperPath = path.join(PROJECT_ROOT, "native/bin/darwin/cpv-audio-capture"),
  timeoutMs = 8_000,
} = {}) {
  if (process.platform !== "darwin") throw new Error("Live armed capture smoke test requires macOS");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cpv-capture-smoke-"));
  const tonePath = path.join(directory, "quiet-tone.wav");
  fs.writeFileSync(tonePath, quietTone());
  const player = spawn("/usr/bin/afplay", [tonePath], { stdio: "ignore" });
  let capture = null;
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    capture = spawn(helperPath, ["--root-pid", String(player.pid)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let ready = null;
    let audioFrames = 0;
    let maximumRms = 0;
    let lifecycleEvents = 0;
    let nativeError = null;
    let stderr = "";
    const parser = new NativeFrameParser((message) => {
      if (message.type === "ready") ready = message;
      else if (message.type === "audio") {
        audioFrames += 1;
        maximumRms = Math.max(maximumRms, rms(message.pcm));
      } else if (message.type === "status") lifecycleEvents += 1;
      else if (message.type === "error") nativeError = new Error(message.message || "Capture failed");
    });
    capture.stdout.on("data", (chunk) => {
      try { parser.push(chunk); }
      catch (error) { nativeError = error; }
    });
    capture.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !nativeError && !ready) {
      if (capture.exitCode !== null || capture.signalCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (nativeError) throw nativeError;
    if (ready?.armed !== true || ready?.originalSuppressed !== false ||
        ready?.supportsArming !== true || ready?.supportsDeferredTap !== true ||
        ready?.supportsCaptureProof !== true ||
        ready?.tapActive !== false || ready?.activationSignal !== "duplex_process_io") {
      throw new Error(stderr.trim() || "Capture helper did not prove tap-free observer readiness");
    }
    if (audioFrames !== 0 || lifecycleEvents !== 0) {
      throw new Error(
        `Playback-only source activated the voice route unexpectedly (audio=${audioFrames}, status=${lifecycleEvents})`,
      );
    }
    return { audioFrames, lifecycleEvents, maximumRms, ready };
  } finally {
    await terminateChild(capture).catch(() => {});
    await terminateChild(player).catch(() => {});
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  smokeCapture().then((result) => {
    console.log(
      `Deferred Core Audio observer passed (${result.audioFrames} routed frames before duplex activation).`,
    );
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = { quietTone, rms, smokeCapture };
