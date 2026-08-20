"use strict";

const OBS_RECORDING_DEVICE_UID = "BlackHole2ch_UID";

function includesOutputDevice(output, deviceUid) {
  return output?.deviceUid === deviceUid || output?.memberDeviceUids?.includes(deviceUid) === true;
}

function combineOutputSessions(sessions, format) {
  const owned = [...new Set(sessions.filter(Boolean))];
  return {
    format: { ...format },
    write: async (frame) => {
      await Promise.all(owned.map((session) => session.write(frame)));
    },
    close: async () => {
      const results = await Promise.allSettled(owned.map((session) => session.close()));
      const errors = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
      if (errors.length > 0) throw new Error(errors.join("; "));
    },
  };
}

function methodNotAvailable(name) {
  return async () => {
    throw new Error(`${name} is not available in this milestone`);
  };
}

function createRuntimeAdapters(capabilities, getSettings, {
  processRoute = null,
  audioOutput = null,
  recordingBusDeviceUid = null,
  voiceEngine = null,
  getPlatformAudioSetup = null,
} = {}) {
  return {
    source: {
      probe: async () => {
        const settings = getSettings();
        if (settings.sourceMode === "codex-app-server") {
          return { label: "Audio source", ...capabilities.ownedSession };
        }
        if (processRoute) {
          return { label: "Audio source", ...await processRoute.probe(settings) };
        }
        return { label: "Audio source", ...capabilities.desktopCapture };
      },
      open: async (config, onFrame, onError) => {
        if (getSettings().sourceMode === "desktop-application" && processRoute) {
          return processRoute.open(config, onFrame, onError);
        }
        throw new Error("The selected audio source adapter is not implemented");
      },
      describe: async (config) => {
        if (getSettings().sourceMode === "desktop-application" && processRoute) {
          return processRoute.describe(config);
        }
        throw new Error("The selected audio source cannot describe its PCM format");
      },
    },
    suppression: {
      probe: async () => {
        const settings = getSettings();
        if (settings.sourceMode === "codex-app-server") {
          return {
            label: "Original suppression",
            ready: true,
            code: "owned_stream_unbound",
            detail: "Owned App Server audio is not attached to hardware before conversion",
          };
        }
        const platformSetup = getPlatformAudioSetup?.();
        if (platformSetup && platformSetup.status !== "ready") {
          return {
            label: "Original suppression",
            ready: false,
            code: platformSetup.code,
            detail: platformSetup.detail,
          };
        }
        if (processRoute) {
          const result = await processRoute.probe(settings);
          return {
            label: "Original suppression",
            ...result,
            ...(result.ready ? {
              detail: "Process-scoped suppression is ready and remains detached until duplex voice is active",
            } : {}),
          };
        }
        return { label: "Original suppression", ...capabilities.suppression };
      },
      acquire: async (config, onRouteError, onRouteStatus, options) => {
        if (getSettings().sourceMode === "desktop-application" && processRoute) {
          return processRoute.acquire(config, onRouteError, onRouteStatus, options);
        }
        throw new Error("The selected original-audio suppression adapter is not implemented");
      },
    },
    engine: {
      probe: async () => voiceEngine
        ? voiceEngine.probe(getSettings())
        : { label: "Voice engine", ...capabilities.engine },
      prepare: async (config, sourceFormat, options) => {
        if (voiceEngine) return voiceEngine.prepare(config, sourceFormat, options);
        return methodNotAvailable("Voice conversion engine")();
      },
    },
    output: {
      probe: async () => {
        if (!audioOutput) return { label: "Converted output", ...capabilities.output };
        const primary = await audioOutput.probe();
        if (!primary.ready || !getSettings().recordingBusEnabled) {
          return { label: "Converted output", ...primary };
        }
        if (!recordingBusDeviceUid) {
          return {
            label: "Converted output",
            ready: false,
            code: "recording_bus_unsupported",
            detail: "The converted-only recording bus is not available on this platform",
          };
        }
        if (primary.isAggregateDevice === true) {
          return {
            label: "Converted output",
            ready: false,
            code: "recording_bus_requires_physical_default",
            detail: "Choose a non-aggregate listening device as the macOS default before enabling the converted-only recording bus",
          };
        }
        if (primary.memberDeviceUidsVerified !== true) {
          return {
            label: "Converted output",
            ready: false,
            code: "default_output_membership_unverified",
            detail: "Core Audio could not verify every member of the default output; the converted-only recording bus is blocked",
          };
        }
        const recording = await audioOutput.probe(recordingBusDeviceUid);
        if (recording.ready && includesOutputDevice(primary, recording.deviceUid)) {
          return {
            label: "Converted output",
            ready: false,
            code: "recording_bus_matches_default_output",
            detail: "The default output already routes system audio to BlackHole 2ch; choose a listening device that excludes BlackHole before enabling the converted-only recording bus",
          };
        }
        return recording.ready
          ? {
              label: "Converted output",
              ready: true,
              code: "ready",
              detail: "Default Core Audio output and BlackHole 2ch recording bus passed self-test",
            }
          : { label: "Converted output", ...recording };
      },
      prepare: async (config, format, onError) => {
        if (!audioOutput) {
          throw new Error("The converted-audio output adapter is not implemented on this platform");
        }
        if (config.recordingBusEnabled && !recordingBusDeviceUid) {
          throw new Error("The converted-only recording bus is not available on this platform");
        }
        const primary = await audioOutput.prepare(
          { ...config, outputDeviceUid: null }, format, onError,
        );
        if (!config.recordingBusEnabled) return primary;
        if (primary.isAggregateDevice === true) {
          const aggregateError = new Error(
            "The default output is an aggregate device; refusing a recording route whose membership can change during capture",
          );
          try {
            await primary.close();
          } catch (cleanupError) {
            const failure = new Error(
              `${aggregateError.message}; the primary output could not be closed: ` +
              `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
            );
            failure.outputSession = primary;
            throw failure;
          }
          throw aggregateError;
        }
        if (primary.memberDeviceUidsVerified !== true) {
          const membershipError = new Error(
            "Core Audio could not verify every member of the default output; refusing to open the converted-only recording bus",
          );
          try {
            await primary.close();
          } catch (cleanupError) {
            const failure = new Error(
              `${membershipError.message}; the primary output could not be closed: ` +
              `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
            );
            failure.outputSession = primary;
            throw failure;
          }
          throw membershipError;
        }
        if (includesOutputDevice(primary, recordingBusDeviceUid)) {
          const conflict = new Error(
            "The default output already includes BlackHole 2ch; refusing to expose unrelated system audio or duplicate converted audio on the recording bus",
          );
          try {
            await primary.close();
          } catch (cleanupError) {
            const failure = new Error(
              `${conflict.message}; the primary output could not be closed: ` +
              `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
            );
            failure.outputSession = primary;
            throw failure;
          }
          throw conflict;
        }
        let recording;
        try {
          recording = await audioOutput.prepare(
            { ...config, outputDeviceUid: recordingBusDeviceUid }, format, onError,
          );
        } catch (error) {
          try {
            await primary.close();
          } catch (cleanupError) {
            const failure = new Error(
              `Recording-bus startup failed (${error instanceof Error ? error.message : String(error)}) and ` +
              `the primary output could not be closed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
            );
            failure.outputSession = error?.outputSession
              ? combineOutputSessions([error.outputSession, primary], format)
              : primary;
            throw failure;
          }
          throw error;
        }
        return combineOutputSessions([primary, recording], format);
      },
    },
  };
}

module.exports = { OBS_RECORDING_DEVICE_UID, combineOutputSessions, createRuntimeAdapters };
