"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function executableExtensions(platform, environment) {
  if (platform !== "win32") return [""];
  return (environment.PATHEXT || ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter(Boolean)
    .map((extension) => extension.toLowerCase());
}

function findExecutable(command, {
  platform = process.platform,
  environment = process.env,
  exists = fs.existsSync,
} = {}) {
  const explicit = command === "codex" ? environment.CODEX_PERSONA_VOICE_CODEX_BIN?.trim() : null;
  if (explicit) {
    if (!path.isAbsolute(explicit)) throw new Error("CODEX_PERSONA_VOICE_CODEX_BIN must be absolute");
    return exists(explicit) ? explicit : null;
  }
  const pathValue = environment.PATH || "";
  const extensions = executableExtensions(platform, environment);
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, platform === "win32" ? `${command}${extension}` : command);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

function parseVersion(value) {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(value).trim());
  return match ? [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)] : null;
}

function versionAtLeast(value, minimum) {
  const actualParts = parseVersion(value);
  const minimumParts = parseVersion(minimum);
  if (!actualParts || !minimumParts) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actualParts[index] > minimumParts[index]) return true;
    if (actualParts[index] < minimumParts[index]) return false;
  }
  return true;
}

function macProductVersion() {
  try {
    return execFileSync("/usr/bin/sw_vers", ["-productVersion"], {
      encoding: "utf8",
      timeout: 1_500,
    }).trim();
  } catch {
    return null;
  }
}

function probePlatformCapabilities({
  platform = process.platform,
  environment = process.env,
  release = os.release(),
  macVersion = platform === "darwin" ? macProductVersion() : null,
  exists = fs.existsSync,
  helperPaths = {},
} = {}) {
  const codexPath = findExecutable("codex", { platform, environment, exists });
  const base = {
    platform,
    release,
    codex: {
      detected: Boolean(codexPath),
      executable: codexPath,
      detail: codexPath ? `Codex CLI found at ${codexPath}` : "Codex CLI is not present on the launcher PATH",
    },
    ownedSession: {
      possible: true,
      ready: false,
      code: "codex_app_server_bridge_missing",
      detail: "The App Server realtime bridge is specified but not bundled in this milestone",
    },
    desktopCapture: {
      possible: false,
      ready: false,
      code: "desktop_capture_unsupported",
      detail: "Process audio capture is not available on this platform",
    },
    suppression: {
      possible: false,
      ready: false,
      code: "source_suppression_unsupported",
      detail: "No verified route can suppress the original application audio",
    },
    engine: {
      ready: false,
      code: "engine_not_installed",
      detail: "No local voice conversion engine is configured",
    },
    output: {
      ready: false,
      code: "output_adapter_missing",
      detail: "The converted-audio output adapter is not bundled in this milestone",
    },
  };

  if (platform === "darwin") {
    const supported = macVersion ? versionAtLeast(macVersion, "14.2") : false;
    const captureBuilt = supported && typeof helperPaths.capture === "string" && exists(helperPaths.capture);
    const outputBuilt = supported && typeof helperPaths.output === "string" && exists(helperPaths.output);
    base.macVersion = macVersion;
    base.desktopCapture = {
      possible: supported,
      ready: captureBuilt,
      code: captureBuilt ? "ready" : supported ? "macos_process_tap_helper_missing" : "macos_14_2_required",
      detail: captureBuilt
        ? "Native Core Audio PCM capture helper is built"
        : supported
          ? "Core Audio process taps are available; the PCM helper is not built"
        : "Transparent process capture requires macOS 14.2 or newer",
    };
    base.suppression = {
      possible: supported,
      ready: captureBuilt,
      code: captureBuilt ? "ready" : supported ? "macos_muted_tap_helper_missing" : "macos_14_2_required",
      detail: captureBuilt
        ? "Capture helper uses CATapMutedWhenTapped to suppress original playback"
        : supported
          ? "Muted process taps can enforce suppression; the native helper is not built"
        : "Muted Core Audio process taps require macOS 14.2 or newer",
    };
    base.output = {
      ready: outputBuilt,
      code: outputBuilt ? "ready" : "macos_output_helper_missing",
      detail: outputBuilt
        ? "Native bounded Core Audio output helper is built"
        : "The native converted-audio output helper is not built",
    };
  } else if (platform === "linux") {
    const requiredTools = ["pw-dump", "pw-cli", "pw-link"];
    const tools = Object.fromEntries(requiredTools.map((tool) => [
      tool,
      findExecutable(tool, { platform, environment, exists }),
    ]));
    const pipeWireReady = Object.values(tools).every(Boolean);
    base.pipeWireTools = tools;
    base.desktopCapture = {
      possible: pipeWireReady,
      ready: false,
      code: pipeWireReady ? "pipewire_capture_adapter_missing" : "pipewire_tools_missing",
      detail: pipeWireReady
        ? "PipeWire is discoverable; the PCM capture adapter is not bundled"
        : "pw-dump, pw-cli, and pw-link must all be installed",
    };
    base.suppression = {
      possible: pipeWireReady,
      ready: false,
      code: pipeWireReady ? "pipewire_isolated_route_missing" : "pipewire_tools_missing",
      detail: pipeWireReady
        ? "PipeWire can host an isolated route; route ownership is not implemented"
        : "An isolated route requires the PipeWire command-line tools",
    };
  } else if (platform === "win32") {
    base.desktopCapture = {
      possible: true,
      ready: false,
      code: "wasapi_capture_helper_missing",
      detail: "WASAPI process loopback is feasible; the PCM helper is not bundled",
    };
    base.suppression = {
      possible: false,
      ready: false,
      code: "windows_virtual_endpoint_required",
      detail: "WASAPI loopback cannot mute the original route; a verified virtual endpoint is required",
    };
  }

  return base;
}

module.exports = {
  findExecutable,
  parseVersion,
  probePlatformCapabilities,
  versionAtLeast,
};
