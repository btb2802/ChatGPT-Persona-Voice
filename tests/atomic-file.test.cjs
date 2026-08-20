const test = require("node:test");
const assert = require("node:assert/strict");
const {
  WINDOWS_RENAME_RETRY_DELAYS_MS,
  renameAtomicFile,
} = require("../electron/atomic-file.cjs");

test("atomic replacement retries only bounded transient Windows file locks", () => {
  const waits = [];
  let attempts = 0;
  renameAtomicFile("source", "destination", {
    platform: "win32",
    rename() {
      attempts += 1;
      if (attempts < 4) {
        const error = new Error("temporarily locked");
        error.code = attempts === 1 ? "EPERM" : attempts === 2 ? "EACCES" : "EBUSY";
        throw error;
      }
    },
    wait(milliseconds) {
      waits.push(milliseconds);
    },
  });

  assert.equal(attempts, 4);
  assert.deepEqual(waits, WINDOWS_RENAME_RETRY_DELAYS_MS.slice(0, 3));
  const exhaustedWaits = [];
  let exhaustedAttempts = 0;
  assert.throws(() => renameAtomicFile("source", "destination", {
    platform: "win32",
    rename() {
      exhaustedAttempts += 1;
      const error = new Error("still locked");
      error.code = "EPERM";
      throw error;
    },
    wait(milliseconds) {
      exhaustedWaits.push(milliseconds);
    },
  }), /still locked/);

  assert.equal(exhaustedAttempts, WINDOWS_RENAME_RETRY_DELAYS_MS.length + 1);
  assert.deepEqual(exhaustedWaits, WINDOWS_RENAME_RETRY_DELAYS_MS);

  let structuralAttempts = 0;
  assert.throws(() => renameAtomicFile("source", "destination", {
    platform: "win32",
    rename() {
      structuralAttempts += 1;
      const error = new Error("missing parent");
      error.code = "ENOENT";
      throw error;
    },
    wait() {
      assert.fail("structural errors must not be retried");
    },
  }), /missing parent/);
  assert.equal(structuralAttempts, 1);
});
