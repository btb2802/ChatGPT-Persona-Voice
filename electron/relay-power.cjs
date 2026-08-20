"use strict";

function createRelayPowerController(powerSaveBlocker) {
  if (!powerSaveBlocker || typeof powerSaveBlocker.start !== "function" ||
      typeof powerSaveBlocker.stop !== "function" || typeof powerSaveBlocker.isStarted !== "function") {
    throw new Error("Electron powerSaveBlocker is unavailable");
  }
  let blockerId = null;
  return {
    start() {
      if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) return blockerId;
      blockerId = powerSaveBlocker.start("prevent-app-suspension");
      if (!Number.isInteger(blockerId) || !powerSaveBlocker.isStarted(blockerId)) {
        const failedId = blockerId;
        blockerId = null;
        if (Number.isInteger(failedId)) powerSaveBlocker.stop(failedId);
        throw new Error("Could not prevent voice relay suspension");
      }
      return blockerId;
    },
    stop() {
      if (blockerId === null) return false;
      const activeId = blockerId;
      blockerId = null;
      return powerSaveBlocker.stop(activeId);
    },
    get active() {
      return blockerId !== null && powerSaveBlocker.isStarted(blockerId);
    },
  };
}

module.exports = { createRelayPowerController };
