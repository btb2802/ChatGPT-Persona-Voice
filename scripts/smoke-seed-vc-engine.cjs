"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  BLOCK_MS,
  STARTUP_DISCARD_MS,
  SeedVcEngine,
  resolveSeedVcPaths,
} = require("../electron/seed-vc-engine.cjs");
const { VoiceCatalog } = require("../electron/voice-catalog.cjs");
const { encodePcm16Wav } = require("../electron/wav.cjs");

const root = path.join(__dirname, "..");
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const targetVoiceId = option("--voice", "voicevox-shikoku-metan-normal");
const referencePathOption = option("--reference", null);
const benchmarkReference = referencePathOption ? {
  id: "benchmark-reference",
  name: "Benchmark reference",
  referencePath: path.resolve(referencePathOption),
} : null;
const sourcePath = path.resolve(option(
  "--source",
  path.join(root, "voices", "references", "voicevox-zundamon-normal.wav"),
));
const outputPath = path.resolve(option(
  "--output",
  path.join(root, "artifacts", `smoke-${targetVoiceId}.wav`),
));
const runtimeRootOption = option("--runtime-root", null);
const runtimeRoot = runtimeRootOption ? path.resolve(runtimeRootOption) : undefined;
const promptSeconds = Number(option("--prompt-seconds", "3"));
const styleSeconds = Number(option("--style-seconds", "17"));
const minimumInferenceBlocks = Number(option("--blocks", "2"));
const traceBlocks = process.argv.includes("--trace-blocks");
const realtimePacing = process.argv.includes("--realtime");
if (!Number.isInteger(minimumInferenceBlocks) || minimumInferenceBlocks < 2 || minimumInferenceBlocks > 100) {
  throw new Error("--blocks must be an integer between 2 and 100");
}
const sourceFormat = { sampleRate: 48_000, channels: 2, sampleFormat: "f32le" };
const sourceFrameSamples = 960;

function decodeSource() {
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-i", sourcePath,
    "-f", "f32le", "-ar", String(sourceFormat.sampleRate),
    "-ac", String(sourceFormat.channels), "pipe:1",
  ], { encoding: null, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.toString("utf8") || "ffmpeg source decode failed");
  if (result.stdout.length === 0) throw new Error("ffmpeg decoded an empty smoke-test source");
  const bytesPerMillisecond = sourceFormat.sampleRate * sourceFormat.channels * 4 / 1_000;
  const minimumBytes = Math.ceil(
    (STARTUP_DISCARD_MS + BLOCK_MS * minimumInferenceBlocks) * bytesPerMillisecond,
  );
  const copies = Math.max(1, Math.ceil(minimumBytes / result.stdout.length));
  return Buffer.concat(Array.from({ length: copies }, () => result.stdout));
}

function rms(buffer) {
  let sum = 0;
  const samples = buffer.length / 4;
  for (let offset = 0; offset < buffer.length; offset += 4) {
    const value = buffer.readFloatLE(offset);
    sum += value * value;
  }
  return Math.sqrt(sum / samples);
}

async function main() {
  const catalog = benchmarkReference ? {
    resolve: (id) => {
      if (id !== benchmarkReference.id) throw new Error("Benchmark reference is not selected");
      return benchmarkReference;
    },
  } : new VoiceCatalog({ manifestPath: path.join(root, "voices", "manifest.json") });
  const engine = new SeedVcEngine({
    paths: resolveSeedVcPaths({ projectRoot: root, ...(runtimeRoot ? { runtimeRoot } : {}) }),
    voiceCatalog: catalog,
    promptSeconds,
    styleSeconds,
    logger: {
      info: (event, value) => console.log(event, value),
      debug: () => {},
    },
  });
  const targetVoice = catalog.resolve(benchmarkReference?.id || targetVoiceId);
  const settings = {
    selectedVoiceId: targetVoice.id,
    selectedVoiceName: targetVoice.name,
  };
  const readiness = await engine.probe(settings);
  if (!readiness.ready) throw new Error(readiness.detail);
  const started = Date.now();
  const session = await engine.prepare(settings, sourceFormat);
  const readyMs = Date.now() - started;
  const primed = await session.prime();
  const source = decodeSource();
  const sourceFrameBytes = sourceFrameSamples * sourceFormat.channels * 4;
  const output = [];
  const inferenceTimesMs = [];
  const conversionStarted = performance.now();
  let sequence = 0;
  for (let offset = 0; offset + sourceFrameBytes <= source.length; offset += sourceFrameBytes) {
    if (realtimePacing) {
      const targetMs = conversionStarted + sequence * sourceFrameSamples / sourceFormat.sampleRate * 1_000;
      const waitMs = targetMs - performance.now();
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    const converted = await session.convert({
      sequence,
      sampleRate: sourceFormat.sampleRate,
      channels: sourceFormat.channels,
      sampleFormat: sourceFormat.sampleFormat,
      samplesPerChannel: sourceFrameSamples,
      pcm: source.subarray(offset, offset + sourceFrameBytes),
    });
    output.push(...converted.map((frame) => frame.pcm));
    if (converted.length > 0 && Number.isFinite(engine.lastInferenceMs)) {
      inferenceTimesMs.push(engine.lastInferenceMs);
      if (traceBlocks) {
        console.log(JSON.stringify({
          inferenceBlock: inferenceTimesMs.length,
          elapsedMs: engine.lastInferenceMs,
          ...engine.lastMetrics,
        }));
      }
    }
    sequence = (sequence + 1) >>> 0;
  }
  const conversionWallMs = performance.now() - conversionStarted;
  await session.reset();
  await session.close();
  await engine.shutdown();
  if (output.length === 0) throw new Error("Seed-VC smoke test produced no output frames");
  const pcm = Buffer.concat(output);
  const outputRms = rms(pcm);
  if (!Number.isFinite(outputRms) || outputRms < 0.005) {
    throw new Error(`Seed-VC smoke output RMS is invalid: ${outputRms}`);
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, encodePcm16Wav({
    sampleRate: 22_050,
    channels: 1,
    samplesPerChannel: pcm.length / 4,
    chunks: [pcm],
  }));
  const sortedInferenceMs = [...inferenceTimesMs].sort((left, right) => left - right);
  const percentile = (fraction) => sortedInferenceMs.length === 0
    ? null
    : sortedInferenceMs[Math.min(
      sortedInferenceMs.length - 1,
      Math.ceil(sortedInferenceMs.length * fraction) - 1,
    )];
  const meanInferenceMs = inferenceTimesMs.length === 0
    ? null
    : inferenceTimesMs.reduce((sum, value) => sum + value, 0) / inferenceTimesMs.length;
  console.log(JSON.stringify({
    readyMs,
    primeMs: primed.elapsedMs,
    promptSeconds,
    styleSeconds,
    inferenceBlocks: inferenceTimesMs.length,
    inferenceMeanMs: meanInferenceMs === null ? null : Number(meanInferenceMs.toFixed(2)),
    inferenceP50Ms: percentile(0.5),
    inferenceP95Ms: percentile(0.95),
    inferenceMaxMs: percentile(1),
    realtimeFactor: meanInferenceMs === null ? null : Number((meanInferenceMs / 300).toFixed(3)),
    conversionWallMs: Math.round(conversionWallMs),
    frames: output.length,
    durationMs: Math.round(pcm.length / 4 / 22_050 * 1000),
    rms: Number(outputRms.toFixed(5)),
    lastInferenceMs: engine.lastInferenceMs,
    mps: engine.lastMetrics,
    outputPath,
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
