"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createHistoryStore } = require("../electron/history-store.cjs");

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cpv-history-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function minimalWav(marker = 0) {
  const value = Buffer.alloc(46);
  value.write("RIFF", 0, "ascii");
  value.writeUInt32LE(38, 4);
  value.write("WAVEfmt ", 8, "ascii");
  value.writeUInt32LE(16, 16);
  value.writeUInt16LE(1, 20);
  value.writeUInt16LE(1, 22);
  value.writeUInt32LE(24_000, 24);
  value.writeUInt32LE(48_000, 28);
  value.writeUInt16LE(2, 32);
  value.writeUInt16LE(16, 34);
  value.write("data", 36, "ascii");
  value.writeUInt32LE(2, 40);
  value.writeInt16LE(marker, 44);
  return value;
}

test("history stores only internally named WAV files and reads them by opaque id", (t) => {
  const store = createHistoryStore(temporaryDirectory(t));
  const entry = store.addWav({
    audio: minimalWav(123),
    createdAt: "2026-08-08T08:00:00.000Z",
    durationMs: 250,
    voiceName: "Demo voice",
    sourceName: "Codex",
  });
  assert.equal(store.list().length, 1);
  assert.equal(entry.fileName, `${entry.id}.wav`);
  assert.deepEqual(store.audio(entry.id).data, minimalWav(123));
  assert.throws(() => store.audio("../../secret"), /id is invalid/);
  assert.throws(() => store.addWav({ audio: Buffer.from("pcm"), durationMs: 1, voiceName: "x", sourceName: "y" }), /WAV/);
});

test("history cleanup enforces timed and never-retention semantics", (t) => {
  const root = temporaryDirectory(t);
  const store = createHistoryStore(root);
  const oldEntry = store.addWav({
    audio: minimalWav(1),
    createdAt: "2026-08-08T01:59:59.000Z",
    durationMs: 100,
    voiceName: "Old",
    sourceName: "Codex",
  });
  const newEntry = store.addWav({
    audio: minimalWav(2),
    createdAt: "2026-08-08T02:00:01.000Z",
    durationMs: 100,
    voiceName: "New",
    sourceName: "Codex",
  });
  const result = store.cleanup({ retentionHours: 6, now: new Date("2026-08-08T08:00:00.000Z") });
  assert.equal(result.removed, 1);
  assert.deepEqual(result.entries.map((entry) => entry.id), [newEntry.id]);
  assert.throws(() => store.audio(oldEntry.id), /not found/);
  assert.deepEqual(store.audio(newEntry.id).data, minimalWav(2));
  const neverStore = createHistoryStore(temporaryDirectory(t));
  const neverEntry = neverStore.addWav({
    audio: minimalWav(),
    createdAt: "2020-01-01T00:00:00.000Z",
    durationMs: 1,
    voiceName: "Voice",
    sourceName: "Source",
  });
  assert.equal(neverStore.cleanup({ retentionHours: null, now: new Date("2030-01-01") }).removed, 0);
  assert.equal(neverStore.clear().removed, 1);
  assert.equal(neverStore.list().length, 0);
  assert.throws(() => neverStore.audio(neverEntry.id), /not found/);
});

test("orphan cleanup survives startup, never retention, and a corrupt index", (t) => {
  const root = temporaryDirectory(t);
  const segments = path.join(root, "segments");
  fs.mkdirSync(segments, { recursive: true });
  const orphan = "33333333-3333-4333-8333-333333333333.wav";
  const temporary = `${orphan}.tmp-123-456-1`;
  fs.writeFileSync(path.join(segments, orphan), minimalWav(3));
  fs.writeFileSync(path.join(segments, temporary), minimalWav(4));
  const store = createHistoryStore(root);
  assert.deepEqual(store.list(), []);
  assert.equal(fs.existsSync(path.join(segments, orphan)), false);
  assert.equal(fs.existsSync(path.join(segments, temporary)), false);

  fs.writeFileSync(path.join(segments, orphan), minimalWav(5));
  const result = store.cleanup({ retentionHours: null, now: new Date("2030-01-01") });
  assert.equal(result.removed, 1);
  assert.equal(fs.existsSync(path.join(segments, orphan)), false);
  const corruptRoot = temporaryDirectory(t);
  const corruptSegments = path.join(corruptRoot, "segments");
  fs.mkdirSync(corruptSegments, { recursive: true });
  const corruptOrphan = "44444444-4444-4444-8444-444444444444.wav";
  fs.writeFileSync(path.join(corruptSegments, corruptOrphan), minimalWav(6));
  fs.writeFileSync(path.join(corruptRoot, "index.json"), "{ corrupt index");
  const recoveries = [];
  const corruptStore = createHistoryStore(corruptRoot, { onRecovery: (event) => recoveries.push(event) });
  assert.deepEqual(corruptStore.clear(), { removed: 1, entries: [] });
  assert.equal(fs.existsSync(path.join(corruptSegments, corruptOrphan)), false);
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].code, "history_index_reset");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(corruptRoot, "index.json"), "utf8")), {
    version: 1,
    entries: [],
  });
});
