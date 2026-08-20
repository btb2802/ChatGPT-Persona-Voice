"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { requireSourceMode, sourceModeCapability } = require("../electron/source-mode.cjs");

function capabilities({ desktop = true, suppression = true, owned = false } = {}) {
  return {
    desktopCapture: { ready: desktop, code: desktop ? "ready" : "capture_missing", detail: desktop ? "ready" : "capture missing" },
    suppression: { ready: suppression, code: suppression ? "ready" : "suppression_missing", detail: suppression ? "ready" : "suppression missing" },
    ownedSession: { ready: owned, code: owned ? "ready" : "bridge_missing", detail: owned ? "ready" : "bridge missing" },
  };
}

test("source modes require their real capture, suppression, and owned-session capabilities", () => {
  assert.equal(sourceModeCapability("desktop-application", capabilities()).ready, true);
  assert.equal(sourceModeCapability("desktop-application", capabilities({ suppression: false })).code, "suppression_missing");
  assert.throws(
    () => requireSourceMode("desktop-application", capabilities({ desktop: false })),
    (error) => error.code === "source_mode_unavailable" && /capture missing/.test(error.message),
  );
  assert.throws(
    () => requireSourceMode("codex-app-server", capabilities()),
    (error) => error.code === "source_mode_unavailable" && /bridge missing/.test(error.message),
  );
  assert.equal(requireSourceMode("codex-app-server", capabilities({ owned: true })), "codex-app-server");
  assert.throws(() => sourceModeCapability("identity-fallback", capabilities()), /Unknown audio source mode/);
});
