"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { WindowsDriverManager } = require("../electron/windows-driver-manager.cjs");
const { encodeFrame } = require("../electron/native-protocol.cjs");

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 1234;
  return child;
}

function ready(action, values = {}) {
  return encodeFrame("ready", Buffer.from(JSON.stringify({
    type: "ready",
    helper: "driver-manager",
    protocolVersion: 1,
    backend: "windows-setupapi",
    action,
    installed: action !== "uninstall",
    rebootRequired: false,
    catalogVerifiedForAction: action !== "uninstall",
    fixedResourcePackage: true,
    requiresElevation: true,
    elevationManifestVerified: true,
    hardwareId: "ROOT\\CPVAudioSink",
    ...(action === "ensure-installed" ? { installationChanged: true } : {}),
    ...values,
  })));
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("Windows driver adapter exposes only the fixed-resource elevated install contract", async () => {
  const child = fakeChild();
  const spawns = [];
  const manager = new WindowsDriverManager({
    helperPath: "C:\\helpers\\cpv-driver-manager.exe",
    platform: "win32",
    exists: () => true,
    spawnProcess: (executable, args) => {
      spawns.push({ executable, args });
      return child;
    },
  });
  const installing = manager.install();
  await nextTurn();
  child.stdout.emit("data", ready("install"));
  child.exitCode = 0;
  child.emit("exit", 0, null);
  const result = await installing;
  assert.equal(result.installed, true);
  assert.deepEqual(spawns[0].args, ["--install"]);
});

test("Windows driver adapter preserves native elevation/signature errors", async () => {
  const child = fakeChild();
  const manager = new WindowsDriverManager({
    helperPath: "C:\\helpers\\cpv-driver-manager.exe",
    platform: "win32",
    exists: () => true,
    spawnProcess: () => child,
  });
  const installing = manager.install();
  await nextTurn();
  child.stdout.emit("data", encodeFrame("error", Buffer.from(JSON.stringify({
    type: "error",
    code: "elevation_required",
    message: "Driver installation requires an elevated process",
  }))));
  child.exitCode = 1;
  child.emit("exit", 1, null);
  await assert.rejects(installing, (error) => error.code === "elevation_required");
});

test("Windows driver adapter requires proven device absence on uninstall", async () => {
  const child = fakeChild();
  const manager = new WindowsDriverManager({
    helperPath: "C:\\helpers\\cpv-driver-manager.exe",
    platform: "win32",
    exists: () => true,
    spawnProcess: () => child,
  });
  const uninstalling = manager.uninstall();
  await nextTurn();
  child.stdout.emit("data", ready("uninstall", {
    installed: false,
    catalogVerifiedForAction: false,
  }));
  child.exitCode = 0;
  child.emit("exit", 0, null);
  assert.equal((await uninstalling).installed, false);
});

test("Windows driver ensure is one atomic NSIS-compatible native action", async () => {
  const child = fakeChild();
  const spawns = [];
  const manager = new WindowsDriverManager({
    helperPath: "C:\\helpers\\cpv-driver-manager.exe",
    platform: "win32",
    exists: () => true,
    spawnProcess: (_executable, args) => {
      spawns.push(args);
      return child;
    },
  });
  const ensuring = manager.ensureInstalled();
  await nextTurn();
  child.stdout.emit("data", ready("ensure-installed", {
    installed: true,
    installationChanged: false,
  }));
  child.exitCode = 0;
  child.emit("exit", 0, null);
  const result = await ensuring;
  assert.equal(result.action, "ensure-installed");
  assert.equal(result.installationChanged, false);
  assert.deepEqual(spawns, [["--ensure-installed"]]);
});

test("Windows driver timeout retains ownership of the live elevated operation", async () => {
  const child = fakeChild();
  const manager = new WindowsDriverManager({
    helperPath: "C:\\helpers\\cpv-driver-manager.exe",
    platform: "win32",
    exists: () => true,
    spawnProcess: () => child,
    timeoutMs: 5,
    waitForChildExit: async () => ({ code: 0, signal: null }),
  });
  await assert.rejects(manager.install(), (error) => {
    assert.equal(error.code, "windows_driver_operation_timeout");
    assert.equal(error.operationStillRunning, true);
    assert.equal(error.driverOperation.running, true);
    assert.equal(error.driverOperation.cancellable, false);
    assert.match(error.driverOperation.cancellationReason, /cannot be safely interrupted/i);
    return true;
  });
});
