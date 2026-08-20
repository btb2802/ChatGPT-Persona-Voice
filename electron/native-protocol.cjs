"use strict";

const MAGIC = 0x31565043;
const VERSION = 1;
const HEADER_BYTES = 12;
const AUDIO_METADATA_BYTES = 16;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const FRAME_TYPES = Object.freeze({ ready: 1, audio: 2, error: 3, status: 4 });
const SAMPLE_FORMATS = Object.freeze({ f32le: 1 });

function integer(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function encodeFrame(type, payload) {
  const typeId = FRAME_TYPES[type];
  if (!typeId) throw new Error(`Unknown native frame type: ${String(type)}`);
  if (!Buffer.isBuffer(payload)) throw new Error("Native frame payload must be a Buffer");
  if (payload.length > MAX_PAYLOAD_BYTES) throw new Error("Native frame payload exceeds the protocol limit");
  const frame = Buffer.allocUnsafe(HEADER_BYTES + payload.length);
  frame.writeUInt32LE(MAGIC, 0);
  frame.writeUInt16LE(VERSION, 4);
  frame.writeUInt16LE(typeId, 6);
  frame.writeUInt32LE(payload.length, 8);
  payload.copy(frame, HEADER_BYTES);
  return frame;
}

function encodeAudioFrame(frame) {
  if (!frame || typeof frame !== "object") throw new Error("Audio frame is required");
  const sequence = integer(frame.sequence, "sequence", 0, 0xffff_ffff);
  const sampleRate = integer(frame.sampleRate, "sampleRate", 8_000, 192_000);
  const channels = integer(frame.channels, "channels", 1, 2);
  const samplesPerChannel = integer(frame.samplesPerChannel, "samplesPerChannel", 1, 0xffff_ffff);
  const sampleFormat = frame.sampleFormat ?? "f32le";
  if (sampleFormat !== "f32le") throw new Error("Only f32le native audio frames are supported");
  const pcm = Buffer.isBuffer(frame.pcm) ? frame.pcm : Buffer.from(frame.pcm ?? []);
  const expectedBytes = samplesPerChannel * channels * Float32Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(expectedBytes) || pcm.length !== expectedBytes) {
    throw new Error(`PCM byte length must be ${expectedBytes}, received ${pcm.length}`);
  }
  const payload = Buffer.allocUnsafe(AUDIO_METADATA_BYTES + pcm.length);
  payload.writeUInt32LE(sequence, 0);
  payload.writeUInt32LE(sampleRate, 4);
  payload.writeUInt16LE(channels, 8);
  payload.writeUInt16LE(SAMPLE_FORMATS[sampleFormat], 10);
  payload.writeUInt32LE(samplesPerChannel, 12);
  pcm.copy(payload, AUDIO_METADATA_BYTES);
  return encodeFrame("audio", payload);
}

function decodeJSON(type, payload) {
  let value;
  try { value = JSON.parse(payload.toString("utf8")); }
  catch { throw new Error(`Native ${type} frame contains invalid JSON`); }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.type !== type) {
    throw new Error(`Native ${type} payload is invalid`);
  }
  return value;
}

function decodeAudio(payload) {
  if (payload.length < AUDIO_METADATA_BYTES) throw new Error("Native audio metadata is truncated");
  const sequence = payload.readUInt32LE(0);
  const sampleRate = payload.readUInt32LE(4);
  const channels = payload.readUInt16LE(8);
  const sampleFormatId = payload.readUInt16LE(10);
  const samplesPerChannel = payload.readUInt32LE(12);
  if (sampleRate < 8_000 || sampleRate > 192_000 || channels < 1 || channels > 2) {
    throw new Error("Native audio format is outside supported bounds");
  }
  if (sampleFormatId !== SAMPLE_FORMATS.f32le) throw new Error("Native audio sample format is unsupported");
  if (samplesPerChannel === 0) throw new Error("Native audio frame must contain at least one sample");
  const expectedBytes = samplesPerChannel * channels * Float32Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(expectedBytes) || payload.length !== AUDIO_METADATA_BYTES + expectedBytes) {
    throw new Error("Native audio payload length does not match its metadata");
  }
  return {
    type: "audio",
    sequence,
    sampleRate,
    channels,
    sampleFormat: "f32le",
    samplesPerChannel,
    pcm: payload.subarray(AUDIO_METADATA_BYTES),
  };
}

class NativeFrameParser {
  constructor(onMessage) {
    if (typeof onMessage !== "function") throw new Error("Native frame callback is required");
    this.onMessage = onMessage;
    this.pending = Buffer.alloc(0);
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    if (chunk.length === 0) return;
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    let offset = 0;
    while (this.pending.length - offset >= HEADER_BYTES) {
      const magic = this.pending.readUInt32LE(offset);
      const version = this.pending.readUInt16LE(offset + 4);
      const type = this.pending.readUInt16LE(offset + 6);
      const payloadBytes = this.pending.readUInt32LE(offset + 8);
      if (magic !== MAGIC) throw new Error("Native stream magic does not match CPV1");
      if (version !== VERSION) throw new Error(`Unsupported native protocol version: ${version}`);
      if (payloadBytes > MAX_PAYLOAD_BYTES) throw new Error("Native frame exceeds the protocol limit");
      const frameBytes = HEADER_BYTES + payloadBytes;
      if (this.pending.length - offset < frameBytes) break;
      const payload = this.pending.subarray(offset + HEADER_BYTES, offset + frameBytes);
      if (type === FRAME_TYPES.ready) this.onMessage(decodeJSON("ready", payload));
      else if (type === FRAME_TYPES.error) this.onMessage(decodeJSON("error", payload));
      else if (type === FRAME_TYPES.status) this.onMessage(decodeJSON("status", payload));
      else if (type === FRAME_TYPES.audio) this.onMessage(decodeAudio(payload));
      else throw new Error(`Unknown native frame type id: ${type}`);
      offset += frameBytes;
    }
    if (offset > 0) this.pending = this.pending.subarray(offset);
    if (this.pending.length > MAX_PAYLOAD_BYTES + HEADER_BYTES) {
      throw new Error("Native parser buffer exceeded its protocol bound");
    }
  }

  finish() {
    if (this.pending.length !== 0) throw new Error("Native stream ended with a truncated frame");
  }
}

function writeFrame(stream, frame) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      stream.off("error", onError);
      reject(error);
    };
    stream.once("error", onError);
    try {
      const accepted = stream.write(frame, (error) => {
        stream.off("error", onError);
        if (error) reject(error);
        else resolve();
      });
      if (!accepted) {
        // The write callback still resolves only after the bounded native pipe accepts the frame.
      }
    } catch (error) {
      stream.off("error", onError);
      reject(error);
    }
  });
}

module.exports = {
  AUDIO_METADATA_BYTES,
  FRAME_TYPES,
  HEADER_BYTES,
  MAGIC,
  MAX_PAYLOAD_BYTES,
  NativeFrameParser,
  SAMPLE_FORMATS,
  VERSION,
  decodeAudio,
  encodeAudioFrame,
  encodeFrame,
  writeFrame,
};
