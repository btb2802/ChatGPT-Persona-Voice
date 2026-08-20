"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const { installPolicy, removePolicy } = require("./linux-audio-policy.cjs");

if (!parentPort) throw new Error("Linux audio policy worker requires a parent port");

function run(action) {
  if (action === "install") return installPolicy({ reload: true });
  if (action === "remove") return removePolicy({ reload: true });
  throw new Error(`Unknown Linux audio policy worker action: ${String(action)}`);
}

try {
  parentPort.postMessage({ ok: true, value: run(workerData?.action) });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: {
      code: typeof error?.code === "string" ? error.code : null,
      message: error instanceof Error ? error.message : String(error),
    },
  });
}
