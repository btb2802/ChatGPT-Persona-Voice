"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { findExecutable, probePlatformCapabilities, versionAtLeast } = require("../electron/platform-capabilities.cjs");

test("version comparison handles macOS minor versions numerically", () => {
  assert.equal(versionAtLeast("14.2", "14.2"), true);
  assert.equal(versionAtLeast("14.10.1", "14.2"), true);
  assert.equal(versionAtLeast("14.1.9", "14.2"), false);
  assert.equal(versionAtLeast("unknown", "14.2"), false);
});

test("explicit Codex path must exist and be absolute", () => {
  const exists = (candidate) => candidate === "/opt/codex/bin/codex";
  assert.equal(findExecutable("codex", {
    platform: "darwin",
    environment: { CODEX_PERSONA_VOICE_CODEX_BIN: "/opt/codex/bin/codex", PATH: "" },
    exists,
  }), "/opt/codex/bin/codex");
  assert.throws(() => findExecutable("codex", {
    platform: "darwin",
    environment: { CODEX_PERSONA_VOICE_CODEX_BIN: "relative/codex", PATH: "" },
    exists,
  }), /must be absolute/);
});

test("macOS native capability is feasible at 14.2 and ready only with both helpers", () => {
  const missingHelpers = probePlatformCapabilities({
    platform: "darwin",
    macVersion: "14.2",
    release: "23.2.0",
    environment: { PATH: "" },
    exists: () => false,
  });
  assert.equal(missingHelpers.desktopCapture.possible, true);
  assert.equal(missingHelpers.desktopCapture.ready, false);
  assert.equal(missingHelpers.suppression.possible, true);
  assert.equal(missingHelpers.suppression.ready, false);
  assert.equal(missingHelpers.engine.ready, false);

  const installedHelpers = probePlatformCapabilities({
    platform: "darwin",
    macVersion: "15.0",
    release: "24.0.0",
    environment: { PATH: "" },
    helperPaths: { capture: "/app/capture", output: "/app/output" },
    exists: (candidate) => candidate === "/app/capture" || candidate === "/app/output",
  });
  assert.equal(installedHelpers.desktopCapture.ready, true);
  assert.equal(installedHelpers.suppression.ready, true);
  assert.equal(installedHelpers.output.ready, true);
  assert.equal(installedHelpers.engine.ready, false);
});

test("Windows loopback capture does not imply original suppression", () => {
  const capabilities = probePlatformCapabilities({
    platform: "win32",
    release: "10.0.26100",
    environment: { PATH: "", PATHEXT: ".EXE" },
    exists: () => false,
  });
  assert.equal(capabilities.desktopCapture.possible, true);
  assert.equal(capabilities.suppression.possible, false);
  assert.equal(capabilities.suppression.code, "windows_virtual_endpoint_required");
});
