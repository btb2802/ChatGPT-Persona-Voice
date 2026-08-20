"use strict";

const { WindowsAudioOutput } = require("./windows-audio-output.cjs");
const { WindowsDriverManager } = require("./windows-driver-manager.cjs");
const { WindowsProcessRoute } = require("./windows-process-route.cjs");
const { WindowsRouteLifecycle } = require("./windows-route-lifecycle.cjs");

const WINDOWS_PACKAGED_NATIVE_FILES = Object.freeze([
  "native/win32/cpv-audio-capture.exe",
  "native/win32/cpv-audio-output.exe",
  "native/win32/cpv-audio-route.exe",
  "native/win32/cpv-driver-manager.exe",
  "native/win32/driver/PersonaVoiceSink.inf",
  "native/win32/driver/cpv-audio-sink.cat",
  "native/win32/driver/cpv-audio-sink.sys",
]);

function createWindowsIntegration({
  captureHelperPath,
  outputHelperPath,
  routeHelperPath,
  driverManagerHelperPath,
  logger = null,
  processRouteOptions = {},
  outputOptions = {},
  driverManagerOptions = {},
  lifecycleOptions = {},
} = {}) {
  const rawProcessRoute = new WindowsProcessRoute({
    captureHelperPath,
    routeHelperPath,
    logger,
    ...processRouteOptions,
  });
  const audioOutput = new WindowsAudioOutput({
    helperPath: outputHelperPath,
    logger,
    ...outputOptions,
  });
  const routeLifecycle = new WindowsRouteLifecycle({
    ...lifecycleOptions,
    processRoute: rawProcessRoute,
    audioOutput,
    logger,
  });
  const driverManager = new WindowsDriverManager({
    helperPath: driverManagerHelperPath,
    ...driverManagerOptions,
  });
  return {
    processRoute: routeLifecycle,
    audioOutput,
    routeLifecycle,
    rawProcessRoute,
    driverManager,
  };
}

module.exports = { WINDOWS_PACKAGED_NATIVE_FILES, createWindowsIntegration };
