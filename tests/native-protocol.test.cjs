"use strict";

const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const {
  NativeFrameParser,
  encodeAudioFrame,
  encodeFrame,
  writeFrame,
} = require("../electron/native-protocol.cjs");

test("native framing preserves split JSON lifecycle frames and exact PCM", () => {
  {
    const messages = [];
    const parser = new NativeFrameParser((message) => messages.push(message));
    const ready = encodeFrame(
      "ready",
      Buffer.from(JSON.stringify({ type: "ready", helper: "capture" })),
    );
    const error = encodeFrame(
      "error",
      Buffer.from(JSON.stringify({ type: "error", message: "no route" })),
    );
    parser.push(ready.subarray(0, 5));
    parser.push(Buffer.concat([ready.subarray(5), error]));
    parser.finish();
    assert.deepEqual(messages, [
      { type: "ready", helper: "capture" },
      { type: "error", message: "no route" },
    ]);
  }

  {
    const messages = [];
    const parser = new NativeFrameParser((message) => messages.push(message));
    parser.push(
      encodeFrame(
        "status",
        Buffer.from(
          JSON.stringify({
            type: "status",
            state: "engaged",
            originalSuppressed: true,
            tapActive: true,
          }),
        ),
      ),
    );
    parser.finish();
    assert.deepEqual(messages, [
      {
        type: "status",
        state: "engaged",
        originalSuppressed: true,
        tapActive: true,
      },
    ]);
  }

  {
    const pcm = Buffer.alloc(4 * 2 * 4);
    for (let index = 0; index < 8; index += 1)
      pcm.writeFloatLE(index / 8, index * 4);
    const messages = [];
    const parser = new NativeFrameParser((message) => messages.push(message));
    parser.push(
      encodeAudioFrame({
        sequence: 7,
        sampleRate: 24_000,
        channels: 2,
        samplesPerChannel: 4,
        sampleFormat: "f32le",
        pcm,
      }),
    );
    parser.finish();
    assert.equal(messages.length, 1);
    assert.deepEqual(
      { ...messages[0], pcm: Buffer.from(messages[0].pcm) },
      {
        type: "audio",
        sequence: 7,
        sampleRate: 24_000,
        channels: 2,
        samplesPerChannel: 4,
        sampleFormat: "f32le",
        pcm,
      },
    );
  }
});

test("audio protocol rejects mismatched byte lengths and truncated streams", () => {
  assert.throws(
    () =>
      encodeAudioFrame({
        sequence: 0,
        sampleRate: 24_000,
        channels: 1,
        samplesPerChannel: 10,
        pcm: Buffer.alloc(4),
      }),
    /PCM byte length/,
  );
  const parser = new NativeFrameParser(() => {});
  parser.push(encodeFrame("ready", Buffer.from("{}")).subarray(0, 6));
  assert.throws(() => parser.finish(), /truncated/);

  const emptyAudio = Buffer.alloc(16);
  emptyAudio.writeUInt32LE(24_000, 4);
  emptyAudio.writeUInt16LE(1, 8);
  emptyAudio.writeUInt16LE(1, 10);
  assert.throws(() => {
    new NativeFrameParser(() => {}).push(encodeFrame("audio", emptyAudio));
  }, /at least one sample/);
});

test("native writes resolve after stream acceptance", async () => {
  const stream = new PassThrough();
  const chunks = [];
  stream.on("data", (chunk) => chunks.push(chunk));
  const frame = encodeFrame(
    "ready",
    Buffer.from(JSON.stringify({ type: "ready" })),
  );
  await writeFrame(stream, frame);
  assert.deepEqual(Buffer.concat(chunks), frame);
});
