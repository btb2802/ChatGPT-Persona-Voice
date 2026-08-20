"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVES = 3;

function serializeError(error) {
  if (!(error instanceof Error)) return String(error);
  return { name: error.name, message: error.message, stack: error.stack };
}

function rotate(filePath, maxArchives) {
  if (maxArchives === 0) {
    fs.rmSync(filePath, { force: true });
    return;
  }
  fs.rmSync(`${filePath}.${maxArchives}`, { force: true });
  for (let index = maxArchives - 1; index >= 1; index -= 1) {
    const source = `${filePath}.${index}`;
    if (fs.existsSync(source)) fs.renameSync(source, `${filePath}.${index + 1}`);
  }
  if (fs.existsSync(filePath)) fs.renameSync(filePath, `${filePath}.1`);
}

function appendBoundedLine(filePath, line, { maxBytes, maxArchives }) {
  if (typeof line !== "string" || line.length === 0) throw new Error("Log line must be a non-empty string");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("maxBytes must be a positive integer");
  if (!Number.isSafeInteger(maxArchives) || maxArchives < 0 || maxArchives > 20) {
    throw new Error("maxArchives must be an integer between 0 and 20");
  }
  const lineBytes = Buffer.byteLength(line);
  if (lineBytes > maxBytes) throw new Error("Log line exceeds the configured file bound");
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(filePath), 0o700); } catch {}
  const existingBytes = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  if (existingBytes > 0 && existingBytes + lineBytes > maxBytes) rotate(filePath, maxArchives);
  fs.appendFileSync(filePath, line, { mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

function createLogger(
  filePath,
  publish = () => {},
  { maxBytes = DEFAULT_MAX_BYTES, maxArchives = DEFAULT_MAX_ARCHIVES } = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("maxBytes must be a positive integer");
  if (!Number.isSafeInteger(maxArchives) || maxArchives < 0 || maxArchives > 20) {
    throw new Error("maxArchives must be an integer between 0 and 20");
  }
  const write = (level, event, data = {}) => {
    const record = {
      at: new Date().toISOString(),
      level,
      event,
      ...data,
    };
    const line = `${JSON.stringify(record)}\n`;
    try { appendBoundedLine(filePath, line, { maxBytes, maxArchives }); }
    catch (error) { console.error("Could not write launcher log", serializeError(error)); }
    publish(record);
    return record;
  };
  return {
    filePath,
    debug: (event, data) => write("debug", event, data),
    info: (event, data) => write("info", event, data),
    warn: (event, data) => write("warn", event, data),
    error: (event, data) => write("error", event, data),
  };
}

module.exports = {
  DEFAULT_MAX_ARCHIVES,
  DEFAULT_MAX_BYTES,
  appendBoundedLine,
  createLogger,
  serializeError,
};
