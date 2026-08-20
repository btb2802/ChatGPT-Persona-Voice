"use strict";

const WAV_HEADER_BYTES = 44;

function encodePcm16Wav({ chunks, sampleRate, channels, samplesPerChannel }) {
  if (!Array.isArray(chunks) || chunks.some((chunk) => !Buffer.isBuffer(chunk))) {
    throw new Error("WAV chunks must be Buffers");
  }
  if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000 ||
      !Number.isInteger(channels) || channels < 1 || channels > 2 ||
      !Number.isInteger(samplesPerChannel) || samplesPerChannel <= 0) {
    throw new Error("WAV format metadata is invalid");
  }
  const totalFloatBytes = samplesPerChannel * channels * Float32Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(totalFloatBytes) || chunks.reduce((sum, chunk) => sum + chunk.length, 0) !== totalFloatBytes) {
    throw new Error("WAV chunks do not match their sample count");
  }
  for (const chunk of chunks) {
    if (chunk.length % Float32Array.BYTES_PER_ELEMENT !== 0) {
      throw new Error("f32le WAV chunks must align to complete samples");
    }
  }
  const sampleCount = samplesPerChannel * channels;
  const dataBytes = sampleCount * Int16Array.BYTES_PER_ELEMENT;
  if (dataBytes > 0xffff_ffff - 36) throw new Error("WAV data exceeds the RIFF size limit");
  const wav = Buffer.allocUnsafe(WAV_HEADER_BYTES + dataBytes);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * Int16Array.BYTES_PER_ELEMENT, 28);
  wav.writeUInt16LE(channels * Int16Array.BYTES_PER_ELEMENT, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataBytes, 40);

  let outputOffset = WAV_HEADER_BYTES;
  for (const chunk of chunks) {
    for (let inputOffset = 0; inputOffset < chunk.length; inputOffset += 4) {
      const value = chunk.readFloatLE(inputOffset);
      const finite = Number.isFinite(value) ? value : 0;
      const clamped = Math.max(-1, Math.min(1, finite));
      const pcm16 = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
      wav.writeInt16LE(pcm16, outputOffset);
      outputOffset += 2;
    }
  }
  return wav;
}

module.exports = { WAV_HEADER_BYTES, encodePcm16Wav };
