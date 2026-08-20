"use strict";

const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { probeNativeHelper, terminateChild, waitForExit } = require("./native-helper.cjs");
const { NativeFrameParser, encodeAudioFrame, writeFrame } = require("./native-protocol.cjs");

const PROBE_CACHE_MS = 5_000;

class LinuxAudioOutput {
  constructor({
    helperPath,
    platform = process.platform,
    exists = fs.existsSync,
    spawnProcess = spawn,
    probeHelper = probeNativeHelper,
    terminateProcess = terminateChild,
    waitForChildExit = waitForExit,
    logger = null,
    clock = () => Date.now(),
  }) {
    this.helperPath = helperPath;
    this.platform = platform;
    this.exists = exists;
    this.spawnProcess = spawnProcess;
    this.probeHelper = probeHelper;
    this.terminateProcess = terminateProcess;
    this.waitForChildExit = waitForChildExit;
    this.logger = logger;
    this.clock = clock;
    this.cachedProbes = new Map();
    this.probesInFlight = new Map();
  }

  async probe(targetObject = null) {
    if (this.platform !== "linux") {
      return { ready: false, code: "linux_only", detail: "The native PipeWire output is available only on Linux" };
    }
    if (!this.helperPath || !this.exists(this.helperPath)) {
      return { ready: false, code: "linux_output_helper_missing", detail: "The Linux PipeWire output helper is not built" };
    }
    if (targetObject !== null && (typeof targetObject !== "string" || !targetObject.trim() || targetObject.length > 4_096)) {
      return { ready: false, code: "linux_output_target_invalid", detail: "The PipeWire target object is invalid" };
    }
    const key = targetObject || "default";
    const now = this.clock();
    const cached = this.cachedProbes.get(key);
    if (cached && now - cached.at < PROBE_CACHE_MS) return cached.value;
    if (this.probesInFlight.has(key)) return this.probesInFlight.get(key);
    const operation = (async () => {
      try {
        const result = await this.probeHelper(this.helperPath, "output", {
          args: targetObject ? ["--self-test", "--target-object", targetObject] : ["--self-test"],
        });
        if (result.supportsNativePipeWire !== true || result.supportsJitterBuffer !== true ||
            result.startsWhenQueueFull !== true || result.startupPrebufferMs !== 500 ||
            result.queueCapacityFrames !== 64 || typeof result.targetObject !== "string" ||
            !result.targetObject || typeof result.usesDefaultDevice !== "boolean" ||
            (targetObject && (result.targetObject !== targetObject || result.usesDefaultDevice !== false))) {
          throw new Error("Output self-test did not prove its native PipeWire target and bounded jitter buffer");
        }
        return {
          ready: true,
          code: "ready",
          detail: targetObject
            ? `${targetObject} passed the native PipeWire output self-test`
            : "The default PipeWire output passed native self-test",
          targetObject: result.targetObject,
          usesDefaultDevice: result.usesDefaultDevice,
        };
      } catch (error) {
        return {
          ready: false,
          code: "linux_output_helper_failed",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    })();
    this.probesInFlight.set(key, operation);
    try {
      const result = await operation;
      this.cachedProbes.set(key, { at: this.clock(), value: result });
      return result;
    } finally {
      if (this.probesInFlight.get(key) === operation) this.probesInFlight.delete(key);
    }
  }

  async prepare(config, format, onError) {
    const targetObject = config?.outputDeviceUid ?? config?.targetObject ?? null;
    const readiness = await this.probe(targetObject);
    if (!readiness.ready) throw new Error(readiness.detail);
    if (!format || format.sampleFormat !== "f32le" ||
        !Number.isInteger(format.sampleRate) || format.sampleRate < 8_000 || format.sampleRate > 192_000 ||
        !Number.isInteger(format.channels) || format.channels < 1 || format.channels > 2) {
      throw new Error("The voice engine must declare an f32le PipeWire output format with one or two channels");
    }
    if (typeof onError !== "function") throw new Error("Output error handler is required");
    const args = [
      "--sample-rate", String(format.sampleRate),
      "--channels", String(format.channels),
      ...(targetObject ? ["--target-object", targetObject] : []),
    ];
    const child = this.spawnProcess(this.helperPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let ready = false;
    let readyMessage = null;
    let closing = false;
    let closed = false;
    let closeInFlight = null;
    let faulted = false;
    let reported = false;
    let stderr = "";
    const report = (error) => {
      if (closing || reported) return;
      reported = true;
      faulted = true;
      onError(error instanceof Error ? error : new Error(String(error)));
    };
    const close = async () => {
      if (closed) return;
      if (closeInFlight) return closeInFlight;
      closing = true;
      closeInFlight = (async () => {
        if (child.exitCode === null && child.signalCode === null && !child.stdin.destroyed) child.stdin.end();
        try { await this.waitForChildExit(child, 6_000); }
        catch {
          child.stdin.destroy();
          await this.terminateProcess(child);
        }
        closed = true;
      })();
      try { return await closeInFlight; }
      finally { closeInFlight = null; }
    };
    const session = {
      format: { ...format },
      get targetObject() { return readyMessage?.targetObject ?? null; },
      get usesDefaultDevice() { return readyMessage?.usesDefaultDevice === true; },
      write: async (frame) => {
        if (!ready || faulted || closing || child.exitCode !== null || child.signalCode !== null) {
          throw new Error("PipeWire output is closed");
        }
        if (frame.sampleRate !== format.sampleRate || frame.channels !== format.channels ||
            (frame.sampleFormat ?? "f32le") !== format.sampleFormat) {
          throw new Error("Converted frame does not match the prepared PipeWire output format");
        }
        await writeFrame(child.stdin, encodeAudioFrame(frame));
      },
      close,
    };

    await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => finish(new Error("PipeWire output did not become ready")), 5_000);
      timeout.unref?.();
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(value);
      };
      const parser = new NativeFrameParser((message) => {
        if (message.type === "ready") {
          if (ready || message.helper !== "output" || message.protocolVersion !== 1 ||
              message.sampleRate !== format.sampleRate || message.channels !== format.channels ||
              message.sampleFormat !== "f32le" || message.maximumFrameDurationMs !== 40 ||
              message.queueCapacityFrames !== 64 || message.supportsJitterBuffer !== true ||
              message.startsWhenQueueFull !== true || message.startupPrebufferMs !== 500 ||
              message.supportsNativePipeWire !== true || typeof message.targetObject !== "string" ||
              !message.targetObject || typeof message.usesDefaultDevice !== "boolean" ||
              (targetObject && (message.targetObject !== targetObject || message.usesDefaultDevice !== false))) {
            finish(new Error("PipeWire output readiness does not match the prepared engine format"));
            return;
          }
          ready = true;
          readyMessage = message;
          finish(null, message);
        } else if (message.type === "status") {
          if (!ready || message.helper !== "output" || !["running", "rebuffering"].includes(message.state) ||
              !Number.isInteger(message.underruns) || message.underruns < 0) {
            const error = new Error("PipeWire output emitted an invalid jitter-buffer status");
            if (!settled) finish(error);
            else report(error);
          }
        } else if (message.type === "error") {
          const error = new Error(message.message || "Native PipeWire output failed");
          error.code = message.code || "linux_output_failed";
          if (!settled) finish(error);
          else report(error);
        } else {
          const error = new Error("PipeWire output emitted an unexpected audio frame");
          if (!settled) finish(error);
          else report(error);
        }
      });
      child.stdout.on("data", (chunk) => {
        try { parser.push(chunk); }
        catch (error) {
          if (!settled) finish(error);
          else report(error);
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
        this.logger?.debug?.("native.pipewire_output_stderr", { message: chunk.toString("utf8").trim() });
      });
      child.stdin.on("error", (error) => {
        if (!settled) finish(error);
        else report(error);
      });
      child.once("error", (error) => {
        if (!settled) finish(error);
        else report(error);
      });
      child.once("exit", (code, childSignal) => {
        if (!settled) {
          finish(new Error(stderr.trim() || `PipeWire output exited before readiness (code=${String(code)}, signal=${String(childSignal)})`));
        } else if (!closing && ready) {
          report(new Error(`PipeWire output exited unexpectedly (code=${String(code)}, signal=${String(childSignal)})`));
        }
      });
    }).catch(async (error) => {
      closing = true;
      child.stdin.destroy();
      try {
        await this.terminateProcess(child);
        closed = true;
      } catch (cleanupError) {
        const failure = new Error(`PipeWire output startup failed (${error.message}) and helper termination was not proven: ${cleanupError.message}`);
        failure.outputSession = session;
        throw failure;
      }
      throw error;
    });
    return session;
  }
}

module.exports = { LinuxAudioOutput, PROBE_CACHE_MS };
