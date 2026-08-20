"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { appendBoundedLine, createLogger } = require("../electron/logging.cjs");

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cpv-log-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("logger rotates bounded private JSONL archives", (t) => {
  const directory = temporaryDirectory(t);
  const filePath = path.join(directory, "launcher.jsonl");
  const published = [];
  const logger = createLogger(filePath, (record) => published.push(record), {
    maxBytes: 180,
    maxArchives: 2,
  });

  for (let index = 0; index < 12; index += 1) logger.info("test.record", { index, value: "x".repeat(48) });

  assert.equal(published.length, 12);
  assert.equal(fs.existsSync(filePath), true);
  assert.equal(fs.existsSync(`${filePath}.1`), true);
  assert.equal(fs.existsSync(`${filePath}.2`), true);
  assert.equal(fs.existsSync(`${filePath}.3`), false);
  for (const candidate of [filePath, `${filePath}.1`, `${filePath}.2`]) {
    const records = fs.readFileSync(candidate, "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(records.every((record) => record.level === "info" && record.event === "test.record"));
    if (process.platform !== "win32") assert.equal(fs.statSync(candidate).mode & 0o077, 0);
  }
});

test("logger rejects unbounded rotation options and records", (t) => {
  const filePath = path.join(temporaryDirectory(t), "launcher.jsonl");
  assert.throws(() => createLogger(filePath, undefined, { maxBytes: 0 }), /positive integer/);
  assert.throws(() => createLogger(filePath, undefined, { maxArchives: 21 }), /between 0 and 20/);
  assert.throws(
    () => appendBoundedLine(filePath, "oversized\n", { maxBytes: 4, maxArchives: 1 }),
    /exceeds the configured file bound/,
  );
  assert.equal(fs.existsSync(filePath), false);
});
