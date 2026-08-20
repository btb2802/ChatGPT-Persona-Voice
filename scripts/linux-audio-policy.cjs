"use strict";

const policy = require("../electron/linux-audio-policy.cjs");

function parseCli(argv) {
  const command = argv[0] || "inspect";
  const reload = argv.includes("--reload");
  if (!["inspect", "install", "remove"].includes(command)) {
    throw new Error(`Unknown Linux audio policy command: ${command}`);
  }
  return { command, reload };
}

if (require.main === module) {
  try {
    const { command, reload } = parseCli(process.argv.slice(2));
    const result = command === "install" ? policy.installPolicy({ reload })
      : command === "remove" ? policy.removePolicy({ reload })
      : policy.inspectPolicy();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { ...policy, parseCli };
