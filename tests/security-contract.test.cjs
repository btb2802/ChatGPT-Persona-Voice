"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const main = fs.readFileSync(path.join(root, "electron", "main.cjs"), "utf8");
const preload = fs.readFileSync(path.join(root, "electron", "preload.cjs"), "utf8");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
const viteConfig = fs.readFileSync(path.join(root, "vite.config.ts"), "utf8");
const updater = fs.readFileSync(path.join(root, "electron", "update.cjs"), "utf8");

test("production renderer and updater receive no ambient authority", () => {
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /devTools:\s*isDev/);
  assert.match(main, /setPermissionCheckHandler\(\(\) => false\)/);
  assert.match(main, /setDevicePermissionHandler\(\(\) => false\)/);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  assert.match(main, /devServerUrl = !app\.isPackaged && requestedDevServerUrl === EXPECTED_DEV_SERVER_URL/);
  assert.match(main, /EXPECTED_DEV_SERVER_URL = "http:\/\/127\.0\.0\.1:4178"/);
  assert.doesNotMatch(main, /const isDev = Boolean\(process\.env\.VITE_DEV_SERVER_URL\)/);
  assert.doesNotMatch(updater, /GH_TOKEN|Authorization:\s*[`'"]/);
  assert.match(main, /CODEX_PERSONA_VOICE_DATA_DIR must be an absolute path/);
});

test("packaged CSP cannot connect to local or remote network services", () => {
  assert.match(main, /"connect-src 'none'"/);
  assert.doesNotMatch(index, /https?:\/\/|wss?:\/\//);
  assert.match(index, /__PERSONA_CSP__/);
  assert.match(viteConfig, /development[\s\S]+"connect-src 'none'"/);
  assert.match(viteConfig, /ws:\/\/127\.0\.0\.1:4178/);
});

test("preload exposes a named bridge instead of raw IPC", () => {
  assert.match(preload, /contextBridge\.exposeInMainWorld/);
  assert.doesNotMatch(preload, /ipcRenderer\s*:/);
  assert.doesNotMatch(preload, /send:\s*ipcRenderer\.send/);
  assert.doesNotMatch(preload, /invoke:\s*ipcRenderer\.invoke/);
});

test("quit seals IPC before runtime and engine drains begin", () => {
  assert.match(main, /quitRequested = true;[\s\S]*await stoppedMutationGate\?\.waitForIdle\(\)/);
  assert.match(main, /if \(quitRequested && !allowedDuringQuit\.has\(channel\)\)/);
  assert.match(main, /allowedDuringQuit = new Set\(\["voice:snapshot", "voice:window-state"\]\)/);
});
