"use strict";

const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { NativeFrameParser } = require("./native-protocol.cjs");
const { waitForExit } = require("./native-helper.cjs");

const DRIVER_MANAGER_TIMEOUT_MS = 60_000;

class WindowsDriverManager {
  constructor({
    helperPath,
    platform = process.platform,
    exists = fs.existsSync,
    spawnProcess = spawn,
    waitForChildExit = waitForExit,
    timeoutMs = DRIVER_MANAGER_TIMEOUT_MS,
  }) {
    this.helperPath = helperPath;
    this.platform = platform;
    this.exists = exists;
    this.spawnProcess = spawnProcess;
    this.waitForChildExit = waitForChildExit;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Windows driver manager timeout must be a positive integer");
    }
    this.timeoutMs = timeoutMs;
  }

  readiness() {
    if (this.platform !== "win32") {
      return { ready: false, code: "windows_only", detail: "The driver manager is available only on Windows" };
    }
    if (!this.helperPath || !this.exists(this.helperPath)) {
      return { ready: false, code: "windows_driver_manager_missing", detail: "The Windows driver manager is not built" };
    }
    return {
      ready: true,
      code: "ready",
      detail: "The fixed-resource Windows driver manager is available",
      requiresElevation: true,
      invocation: "requireAdministrator-manifest",
    };
  }

  verify() {
    return this.run("self-test");
  }

  install() {
    return this.run("install");
  }

  async ensureInstalled() {
    return this.run("ensure-installed");
  }

  uninstall() {
    return this.run("uninstall");
  }

  async run(action) {
    const readiness = this.readiness();
    if (!readiness.ready) throw Object.assign(new Error(readiness.detail), { code: readiness.code });
    if (!["self-test", "ensure-installed", "install", "uninstall"].includes(action)) {
      throw new Error(`Unknown Windows driver action: ${String(action)}`);
    }
    const args = [`--${action}`];
    const child = this.spawnProcess(this.helperPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let message = null;
    let stderr = "";
    let settled = false;
    const operation = {
      action,
      cancellable: false,
      cancellationReason: "Windows SetupAPI driver mutations cannot be safely interrupted mid-transaction",
      get running() {
        return Number.isInteger(child.pid) && child.exitCode === null && child.signalCode === null;
      },
      waitForExit: () => this.waitForChildExit(child, 5 * 60_000),
    };
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        const error = new Error(
          `Windows driver ${action} did not finish within ${this.timeoutMs} ms; ` +
          "the elevated operation remains owned and must be allowed to reach a terminal result",
        );
        error.code = "windows_driver_operation_timeout";
        error.operationStillRunning = operation.running;
        error.driverOperation = operation;
        reject(error);
      }, this.timeoutMs);
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) {
          if (operation.running && !error.driverOperation) {
            error.code ||= "windows_driver_operation_cleanup_unproven";
            error.operationStillRunning = true;
            error.driverOperation = operation;
          }
          reject(error);
        }
        else resolve(value);
      };
      const parser = new NativeFrameParser((candidate) => {
        if (message) {
          finish(new Error("Windows driver manager emitted more than one terminal frame"));
          return;
        }
        if (candidate.type === "error") {
          const error = new Error(candidate.message || `Windows driver ${action} failed`);
          error.code = candidate.code || "windows_driver_manager_failed";
          message = error;
        } else if (candidate.type === "ready") {
          message = candidate;
        } else {
          finish(new Error("Windows driver manager emitted an unexpected CPV1 frame"));
        }
      });
      child.stdout.on("data", (chunk) => {
        try { parser.push(chunk); }
        catch (error) { finish(error); }
      });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
      child.once("error", (error) => {
        if (error?.code === "EACCES" || error?.win32Code === 740 ||
            /(?:error\s*740|elevation)/i.test(error?.message || "")) {
          const elevation = new Error(
            "The signed Persona Voice driver operation must run through the elevated installer boundary",
          );
          elevation.code = "elevation_required";
          finish(elevation);
        } else {
          finish(error);
        }
      });
      child.once("exit", (code, signal) => {
        try { parser.finish(); }
        catch (error) { finish(error); return; }
        if (message instanceof Error) {
          finish(message);
          return;
        }
        if (code !== 0 || signal !== null || !message ||
            message.helper !== "driver-manager" || message.protocolVersion !== 1 ||
            message.backend !== "windows-setupapi" || message.action !== action ||
            message.fixedResourcePackage !== true || message.requiresElevation !== true ||
            message.elevationManifestVerified !== true) {
          finish(new Error(stderr.trim() ||
            `Windows driver ${action} failed (code=${String(code)}, signal=${String(signal)})`));
          return;
        }
        finish(null, message);
      });
    });

    if (action === "install" &&
        (result.installed !== true || result.catalogVerifiedForAction !== true)) {
      throw new Error("Windows driver installation did not prove a trusted installed package");
    }
    if (action === "ensure-installed" &&
        (result.installed !== true || result.catalogVerifiedForAction !== true ||
         typeof result.installationChanged !== "boolean")) {
      throw new Error("Windows driver ensure did not prove one complete trusted installation");
    }
    if (action === "self-test" && result.catalogVerifiedForAction !== true) {
      throw new Error("Windows driver self-test did not prove the package catalog");
    }
    if (action === "uninstall" && result.installed !== false) {
      throw new Error("Windows driver removal did not prove device absence");
    }
    return result;
  }
}

module.exports = { DRIVER_MANAGER_TIMEOUT_MS, WindowsDriverManager };
