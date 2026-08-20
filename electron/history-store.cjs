"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const INDEX_VERSION = 1;
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const HISTORY_ID = /^[0-9a-f-]{36}$/;
const HISTORY_SEGMENT = /^([0-9a-f-]{36})\.wav$/;
const HISTORY_TEMP_SEGMENT = /^[0-9a-f-]{36}\.wav\.tmp-[0-9]+-[0-9]+-[0-9]+$/;

function emptyIndex() {
  return { version: INDEX_VERSION, entries: [] };
}

function finiteNonNegative(value, field) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be non-negative`);
  return value;
}

function normalizeEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("History entry must be an object");
  }
  if (typeof value.id !== "string" || !HISTORY_ID.test(value.id)) {
    throw new Error("History entry id is invalid");
  }
  const createdAt = new Date(value.createdAt);
  if (!Number.isFinite(createdAt.getTime())) throw new Error("History timestamp is invalid");
  const fileName = `${value.id}.wav`;
  if (value.fileName !== fileName) throw new Error("History filename does not match its id");
  for (const field of ["voiceName", "sourceName"]) {
    if (typeof value[field] !== "string" || !value[field].trim() || value[field].length > 160) {
      throw new Error(`History ${field} is invalid`);
    }
  }
  return {
    id: value.id,
    createdAt: createdAt.toISOString(),
    durationMs: finiteNonNegative(value.durationMs, "durationMs"),
    bytes: finiteNonNegative(value.bytes, "bytes"),
    voiceName: value.voiceName.trim(),
    sourceName: value.sourceName.trim(),
    fileName,
  };
}

function normalizeIndex(value) {
  if (!value || typeof value !== "object" || value.version !== INDEX_VERSION || !Array.isArray(value.entries)) {
    throw new Error("History index is invalid or unsupported");
  }
  const seen = new Set();
  const entries = value.entries.map(normalizeEntry);
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new Error(`Duplicate history id: ${entry.id}`);
    seen.add(entry.id);
  }
  return { version: INDEX_VERSION, entries };
}

function createHistoryStore(rootDirectory, { onRecovery = () => {} } = {}) {
  const indexPath = path.join(rootDirectory, "index.json");
  const segmentsDirectory = path.join(rootDirectory, "segments");

  function ensureDirectories() {
    fs.mkdirSync(segmentsDirectory, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(rootDirectory, 0o700); } catch {}
    try { fs.chmodSync(segmentsDirectory, 0o700); } catch {}
  }

  function readIndex() {
    let serialized;
    try {
      serialized = fs.readFileSync(indexPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return emptyIndex();
      throw error;
    }
    try {
      return normalizeIndex(JSON.parse(serialized));
    } catch (error) {
      ensureDirectories();
      writePrivateFileAtomic(indexPath, `${JSON.stringify(emptyIndex(), null, 2)}\n`);
      try {
        onRecovery({
          code: "history_index_reset",
          detail: error instanceof Error ? error.message : String(error),
        });
      } catch {}
      return emptyIndex();
    }
  }

  function writeIndex(index) {
    ensureDirectories();
    const normalized = normalizeIndex(index);
    writePrivateFileAtomic(indexPath, `${JSON.stringify(normalized, null, 2)}\n`);
    return normalized;
  }

  function ownedSegmentArtifacts() {
    ensureDirectories();
    return fs.readdirSync(segmentsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() &&
        (HISTORY_SEGMENT.test(entry.name) || HISTORY_TEMP_SEGMENT.test(entry.name)))
      .map((entry) => entry.name);
  }

  function reconcileSegments(index) {
    const indexed = new Set(index.entries.map((entry) => entry.fileName));
    let removed = 0;
    for (const fileName of ownedSegmentArtifacts()) {
      if (HISTORY_TEMP_SEGMENT.test(fileName) || !indexed.has(fileName)) {
        fs.rmSync(path.join(segmentsDirectory, fileName), { force: true });
        removed += 1;
      }
    }
    return removed;
  }

  function sortedEntries(index) {
    return index.entries
      .slice()
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  }

  function list() {
    const index = readIndex();
    reconcileSegments(index);
    return sortedEntries(index);
  }

  function addWav({ audio, createdAt = new Date(), durationMs, voiceName, sourceName }) {
    if (!Buffer.isBuffer(audio)) throw new Error("History audio must be a Buffer");
    if (audio.length === 0 || audio.length > MAX_AUDIO_BYTES) {
      throw new Error(`History audio must contain 1-${MAX_AUDIO_BYTES} bytes`);
    }
    if (audio.length < 12 || audio.subarray(0, 4).toString("ascii") !== "RIFF"
      || audio.subarray(8, 12).toString("ascii") !== "WAVE") {
      throw new Error("History accepts complete WAV data only");
    }
    const id = crypto.randomUUID();
    const fileName = `${id}.wav`;
    const entry = normalizeEntry({
      id,
      createdAt: new Date(createdAt).toISOString(),
      durationMs,
      bytes: audio.length,
      voiceName,
      sourceName,
      fileName,
    });
    ensureDirectories();
    const audioPath = path.join(segmentsDirectory, fileName);
    writePrivateFileAtomic(audioPath, audio);
    try {
      const index = readIndex();
      writeIndex({ ...index, entries: [...index.entries, entry] });
    } catch (error) {
      fs.rmSync(audioPath, { force: true });
      throw error;
    }
    return entry;
  }

  function audio(id) {
    if (typeof id !== "string" || !HISTORY_ID.test(id)) throw new Error("History id is invalid");
    const entry = readIndex().entries.find((candidate) => candidate.id === id);
    if (!entry) throw new Error("History entry was not found");
    return {
      entry,
      data: fs.readFileSync(path.join(segmentsDirectory, entry.fileName)),
      mimeType: "audio/wav",
    };
  }

  function cleanup({ retentionHours, now = new Date() }) {
    if (!Number.isFinite(retentionHours) || retentionHours <= 0) {
      if (retentionHours !== null) {
        throw new Error("Retention must be a positive number of hours or null");
      }
    }
    const index = readIndex();
    const orphaned = reconcileSegments(index);
    if (retentionHours === null) {
      return { removed: orphaned, entries: sortedEntries(index) };
    }
    const cutoff = now.getTime() - retentionHours * 60 * 60 * 1000;
    const expired = index.entries.filter((entry) => Date.parse(entry.createdAt) <= cutoff);
    if (expired.length === 0) return { removed: orphaned, entries: sortedEntries(index) };
    for (const entry of expired) {
      fs.rmSync(path.join(segmentsDirectory, entry.fileName), { force: true });
    }
    const expiredIds = new Set(expired.map((entry) => entry.id));
    const next = writeIndex({
      ...index,
      entries: index.entries.filter((entry) => !expiredIds.has(entry.id)),
    });
    return {
      removed: orphaned + expired.length,
      entries: sortedEntries(next),
    };
  }

  function clear() {
    readIndex();
    let removed = 0;
    for (const fileName of ownedSegmentArtifacts()) {
      fs.rmSync(path.join(segmentsDirectory, fileName), { force: true });
      if (HISTORY_SEGMENT.test(fileName)) removed += 1;
    }
    writeIndex(emptyIndex());
    return { removed, entries: [] };
  }

  return {
    addWav,
    audio,
    cleanup,
    clear,
    indexPath,
    list,
    rootDirectory,
  };
}

module.exports = {
  HISTORY_ID,
  INDEX_VERSION,
  MAX_AUDIO_BYTES,
  createHistoryStore,
  emptyIndex,
  normalizeEntry,
  normalizeIndex,
};
