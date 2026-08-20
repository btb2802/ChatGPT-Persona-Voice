"use strict";

const MAGIC = Buffer.from("CPVE", "ascii");
const PREFIX_BYTES = 12;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function encodeEngineMessage(header, body = Buffer.alloc(0)) {
  if (!header || typeof header !== "object" || Array.isArray(header) || typeof header.type !== "string") {
    throw new Error("Engine protocol header must be an object with a type");
  }
  if (!Buffer.isBuffer(body)) body = Buffer.from(body);
  const encodedHeader = Buffer.from(JSON.stringify(header), "utf8");
  if (encodedHeader.length === 0 || encodedHeader.length > MAX_HEADER_BYTES) {
    throw new Error("Engine protocol header exceeds its size bound");
  }
  if (body.length > MAX_BODY_BYTES) throw new Error("Engine protocol body exceeds its size bound");
  const value = Buffer.allocUnsafe(PREFIX_BYTES + encodedHeader.length + body.length);
  MAGIC.copy(value, 0);
  value.writeUInt32LE(encodedHeader.length, 4);
  value.writeUInt32LE(body.length, 8);
  encodedHeader.copy(value, PREFIX_BYTES);
  body.copy(value, PREFIX_BYTES + encodedHeader.length);
  return value;
}

class EngineMessageParser {
  constructor(onMessage) {
    if (typeof onMessage !== "function") throw new Error("Engine protocol callback is required");
    this.onMessage = onMessage;
    this.pending = Buffer.alloc(0);
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    if (chunk.length === 0) return;
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    let offset = 0;
    while (this.pending.length - offset >= PREFIX_BYTES) {
      if (!this.pending.subarray(offset, offset + MAGIC.length).equals(MAGIC)) {
        throw new Error("Engine stream magic does not match CPVE");
      }
      const headerBytes = this.pending.readUInt32LE(offset + 4);
      const bodyBytes = this.pending.readUInt32LE(offset + 8);
      if (headerBytes === 0 || headerBytes > MAX_HEADER_BYTES || bodyBytes > MAX_BODY_BYTES) {
        throw new Error("Engine frame length is outside protocol bounds");
      }
      const messageBytes = PREFIX_BYTES + headerBytes + bodyBytes;
      if (this.pending.length - offset < messageBytes) break;
      let header;
      try {
        header = JSON.parse(
          this.pending.subarray(offset + PREFIX_BYTES, offset + PREFIX_BYTES + headerBytes).toString("utf8"),
        );
      } catch {
        throw new Error("Engine frame contains invalid JSON");
      }
      if (!header || typeof header !== "object" || Array.isArray(header) || typeof header.type !== "string") {
        throw new Error("Engine frame header is invalid");
      }
      const body = this.pending.subarray(
        offset + PREFIX_BYTES + headerBytes,
        offset + messageBytes,
      );
      this.onMessage({ header, body });
      offset += messageBytes;
    }
    if (offset > 0) this.pending = this.pending.subarray(offset);
    if (this.pending.length > PREFIX_BYTES + MAX_HEADER_BYTES + MAX_BODY_BYTES) {
      throw new Error("Engine parser buffer exceeded its protocol bound");
    }
  }

  finish() {
    if (this.pending.length !== 0) throw new Error("Engine stream ended with a truncated frame");
  }
}

module.exports = {
  EngineMessageParser,
  MAGIC,
  MAX_BODY_BYTES,
  MAX_HEADER_BYTES,
  PREFIX_BYTES,
  encodeEngineMessage,
};
