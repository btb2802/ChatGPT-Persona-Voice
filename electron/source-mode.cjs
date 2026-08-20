"use strict";

const SOURCE_MODES = Object.freeze(["desktop-application", "codex-app-server"]);

function sourceModeCapability(mode, capabilities) {
  if (!SOURCE_MODES.includes(mode)) {
    throw new Error(`Unknown audio source mode: ${String(mode)}`);
  }
  if (mode === "codex-app-server") return capabilities?.ownedSession;
  const capture = capabilities?.desktopCapture;
  const suppression = capabilities?.suppression;
  if (capture?.ready === true && suppression?.ready === true) {
    return { ready: true, code: "ready", detail: "Desktop capture and original suppression are ready" };
  }
  const blocker = capture?.ready === true ? suppression : capture;
  return {
    ready: false,
    code: blocker?.code || "desktop_route_unavailable",
    detail: blocker?.detail || "The desktop audio route is unavailable",
  };
}

function requireSourceMode(mode, capabilities) {
  const capability = sourceModeCapability(mode, capabilities);
  if (capability?.ready !== true) {
    const error = new Error(`[source_mode_unavailable] ${capability?.detail || "The selected source mode is unavailable"}`);
    error.code = "source_mode_unavailable";
    throw error;
  }
  return mode;
}

module.exports = { SOURCE_MODES, requireSourceMode, sourceModeCapability };
