const { spawn } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const vitePackage = require.resolve("vite/package.json", { paths: [root] });
const viteBin = path.join(path.dirname(vitePackage), "bin", "vite.js");
const electronBin = require("electron");

const vite = spawn(process.execPath, [viteBin], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

let electron = null;
let stopped = false;

function stop() {
  if (stopped) return;
  stopped = true;
  electron?.kill("SIGTERM");
  vite.kill("SIGTERM");
}

async function waitForVite() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:4178");
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Vite did not become ready on 127.0.0.1:4178");
}

void waitForVite().then(() => {
  electron = spawn(electronBin, [root], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: "http://127.0.0.1:4178",
    },
  });
  electron.once("exit", (code) => {
    stop();
    process.exitCode = code ?? 0;
  });
  electron.once("error", (error) => {
    console.error(`Electron failed to start: ${error.message}`);
    stop();
    process.exitCode = 1;
  });
}).catch((error) => {
  console.error(error);
  stop();
  process.exitCode = 1;
});

vite.once("exit", (code) => {
  if (!stopped && code !== 0) {
    console.error(`Vite exited with code ${code}`);
    stop();
    process.exitCode = code ?? 1;
  }
});

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
