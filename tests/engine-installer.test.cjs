"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  EngineInstaller,
  MIN_INSTALL_FREE_BYTES,
  buildInstallerEnvironment,
} = require("../electron/engine-installer.cjs");

function fixture(t, { execute } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cpv-engine-installer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resources = path.join(root, "resources");
  const runtimeRoot = path.join(root, "engine", "seed-vc");
  const stagingRoot = `${runtimeRoot}.installing`;
  const paths = {
    packaged: true,
    uvPath: path.join(resources, "engine-installer", "uv"),
    runtimeRoot,
    stagingRoot,
    backupRoot: `${runtimeRoot}.backup`,
    pythonRoot: path.join(root, "engine", "python"),
    cacheRoot: path.join(root, "engine", "cache", "uv"),
    requirementsPath: path.join(resources, "engine", "seed-vc", "requirements.lock.txt"),
    modelLockPath: path.join(resources, "engine", "seed-vc", "model-lock.json"),
    prefetchPath: path.join(resources, "engine", "seed-vc", "prefetch.py"),
    verifierPath: path.join(resources, "engine", "seed-vc", "verify.py"),
    workerPath: path.join(resources, "engine", "seed-vc", "worker.py"),
    seedRoot: path.join(resources, "engine", "vendor", "seed-vc"),
  };
  for (const file of [
    paths.uvPath,
    paths.requirementsPath,
    paths.prefetchPath,
    paths.verifierPath,
    paths.workerPath,
    path.join(paths.seedRoot, "real-time-gui.py"),
  ]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "fixture");
  }
  fs.chmodSync(paths.uvPath, 0o755);
  const lockText = `${JSON.stringify({
    schemaVersion: 1,
    seedVcCommit: "a".repeat(40),
    python: "3.11",
    repositories: {
      "fixture/model": {
        files: Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`model-${index}`, "hash"])),
      },
    },
  })}\n`;
  fs.writeFileSync(paths.modelLockPath, lockText);
  const commands = [];
  const defaultExecute = async (command) => {
    commands.push(command);
    if (command.args[0] === "venv") {
      const python = path.join(stagingRoot, ".venv", "bin", "python");
      fs.mkdirSync(path.dirname(python), { recursive: true });
      fs.writeFileSync(python, "python");
    }
    if (command.args.includes(paths.prefetchPath)) {
      fs.writeFileSync(path.join(stagingRoot, "install-manifest.json"), `${JSON.stringify({
        schemaVersion: 1,
        modelLockSha256: crypto.createHash("sha256").update(lockText).digest("hex"),
        seedVcCommit: "a".repeat(40),
        python: "3.11",
        files: Array.from({ length: 7 }, (_, index) => ({ index })),
      })}\n`);
    }
  };
  const states = [];
  const installer = new EngineInstaller({
    paths,
    platform: "darwin",
    arch: "arm64",
    execute: execute || defaultExecute,
    freeBytes: () => MIN_INSTALL_FREE_BYTES + 1,
    size: () => 2_500_000_000,
    publish: (state) => states.push(state),
  });
  return { commands, installer, paths, root, stagingRoot, states, defaultExecute };
}

test("engine package installs in staging and publishes only after verification", async (t) => {
  const value = fixture(t);
  fs.mkdirSync(value.paths.runtimeRoot, { recursive: true });
  fs.writeFileSync(path.join(value.paths.runtimeRoot, "old-runtime"), "keep until publish");
  const result = await value.installer.install();
  assert.equal(result.status, "ready");
  assert.equal(fs.existsSync(path.join(value.paths.runtimeRoot, "old-runtime")), false);
  assert.equal(fs.existsSync(path.join(value.paths.runtimeRoot, ".venv", "bin", "python")), true);
  assert.equal(fs.existsSync(path.join(value.paths.runtimeRoot, "install-manifest.json")), true);
  assert.deepEqual(value.states.filter((state) => state.status === "installing").map((state) => state.phase), [
    "preparing", "python", "packages", "models", "verifying", "publishing",
  ]);
  assert.equal(value.commands[0].executable, value.paths.uvPath);
  assert.deepEqual(value.commands[0].args, ["--version"]);
  const packageCommand = value.commands.find((command) => command.args[0] === "pip");
  assert.ok(packageCommand);
  assert.equal(packageCommand.args.includes("--managed-python"), true);
  assert.equal(packageCommand.args.includes("--strict"), true);
  assert.equal(packageCommand.args.includes("--require-hashes"), true);
  assert.equal(packageCommand.args.at(packageCommand.args.indexOf("--only-binary") + 1), ":all:");
  assert.deepEqual(packageCommand.args.flatMap((argument, index) =>
    argument === "--no-binary" ? [packageCommand.args[index + 1]] : []), [
    "antlr4-python3-runtime",
    "argbind",
    "randomname",
  ]);
  assert.equal(
    packageCommand.args.at(packageCommand.args.indexOf("--build-constraint") + 1),
    value.paths.requirementsPath,
  );
  assert.equal(packageCommand.args.at(packageCommand.args.indexOf("--default-index") + 1), "https://pypi.org/simple");
  assert.equal(value.commands.some((command) => command.args.includes(value.paths.verifierPath)), true);
});

test("cancelled engine installation keeps resumable staging and never replaces runtime", async (t) => {
  let packagesStarted;
  const atPackages = new Promise((resolve) => { packagesStarted = resolve; });
  let value;
  value = fixture(t, {
    execute: async (command) => {
      if (command.args[0] === "venv") {
        const python = path.join(value.stagingRoot, ".venv", "bin", "python");
        fs.mkdirSync(path.dirname(python), { recursive: true });
        fs.writeFileSync(python, "python");
        return;
      }
      if (command.args[0] !== "pip") return;
      packagesStarted();
      await new Promise((resolve, reject) => {
        const fail = () => {
          const error = new Error("Engine installation was cancelled; Retry resumes the partial download");
          error.code = "engine_install_cancelled";
          reject(error);
        };
        command.signal.addEventListener("abort", fail, { once: true });
      });
    },
  });
  fs.mkdirSync(value.paths.runtimeRoot, { recursive: true });
  fs.writeFileSync(path.join(value.paths.runtimeRoot, "old-runtime"), "old");
  const pending = value.installer.install();
  await atPackages;
  assert.equal(await value.installer.cancel(), true);
  await assert.rejects(pending, (error) => error.code === "engine_install_cancelled");
  assert.equal(fs.readFileSync(path.join(value.paths.runtimeRoot, "old-runtime"), "utf8"), "old");
  assert.equal(fs.existsSync(value.stagingRoot), true);
  assert.equal(value.installer.getState().status, "idle");
  assert.equal(value.installer.getState().resumable, true);
});

test("cancellation at the publication boundary leaves the previous runtime intact", async (t) => {
  const value = fixture(t);
  fs.mkdirSync(value.paths.runtimeRoot, { recursive: true });
  fs.writeFileSync(path.join(value.paths.runtimeRoot, "old-runtime"), "old");
  value.installer.publish = (state) => {
    value.states.push(state);
    if (state.status === "installing" && state.phase === "publishing") {
      value.installer.abortController.abort();
    }
  };
  await assert.rejects(
    value.installer.install(),
    (error) => error.code === "engine_install_cancelled",
  );
  assert.equal(fs.readFileSync(path.join(value.paths.runtimeRoot, "old-runtime"), "utf8"), "old");
  assert.equal(fs.existsSync(value.paths.backupRoot), false);
  assert.equal(fs.existsSync(value.stagingRoot), true);
});

test("an interrupted publication restores its previous verified runtime on next launch", async (t) => {
  const value = fixture(t);
  await value.installer.install();
  fs.renameSync(value.paths.runtimeRoot, value.paths.backupRoot);
  assert.equal(fs.existsSync(value.paths.runtimeRoot), false);

  const recovered = new EngineInstaller({
    paths: value.paths,
    platform: "darwin",
    arch: "arm64",
    execute: value.defaultExecute,
    freeBytes: () => MIN_INSTALL_FREE_BYTES + 1,
    size: () => 2_500_000_000,
  });
  assert.equal(recovered.getState().status, "ready");
  assert.equal(fs.existsSync(value.paths.runtimeRoot), true);
  assert.equal(fs.existsSync(value.paths.backupRoot), false);
});

test("a disk-space failure is explicit and is not presented as resumable", async (t) => {
  const value = fixture(t);
  value.installer.freeBytes = () => MIN_INSTALL_FREE_BYTES - 1;
  await assert.rejects(value.installer.install(), /at least 6 GiB/);
  assert.equal(value.installer.getState().status, "error");
  assert.equal(value.installer.getState().resumable, false);
});

test("engine package removal deletes runtime, partial downloads, managed Python, and cache", async (t) => {
  const value = fixture(t);
  for (const target of [
    value.paths.runtimeRoot,
    value.paths.stagingRoot,
    value.paths.backupRoot,
    value.paths.pythonRoot,
    value.paths.cacheRoot,
  ]) {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "payload"), "x");
  }
  const result = await value.installer.remove();
  assert.equal(result.status, "idle");
  for (const target of [
    value.paths.runtimeRoot,
    value.paths.stagingRoot,
    value.paths.backupRoot,
    value.paths.pythonRoot,
    value.paths.cacheRoot,
  ]) assert.equal(fs.existsSync(target), false);
});

test("installer environment rejects Python, package-index, uv, loader, and Hugging Face injection", () => {
  const environment = buildInstallerEnvironment({
    cacheRoot: "/private/cache",
    pythonRoot: "/private/python",
  }, {
    PATH: "/usr/bin",
    PYTHONPATH: "/tmp/injected",
    PIP_INDEX_URL: "https://attacker.invalid/simple",
    UV_DEFAULT_INDEX: "https://attacker.invalid/simple",
    UV_INDEX_URL: "https://attacker.invalid/simple",
    UV_CONSTRAINT: "/tmp/attacker-constraints.txt",
    UV_NO_VERIFY_HASHES: "1",
    UV_PYTHON_INSTALL_DIR: "/tmp/python",
    HF_ENDPOINT: "https://attacker.invalid",
    HF_TOKEN: "secret",
    SSL_CERT_FILE: "/tmp/attacker-ca.pem",
    HTTPS_PROXY: "https://attacker.invalid",
    OPENAI_API_KEY: "secret",
    DYLD_INSERT_LIBRARIES: "/tmp/injected.dylib",
  });
  assert.equal(environment.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
  assert.equal(environment.PYTHONPATH, undefined);
  assert.equal(environment.PIP_INDEX_URL, undefined);
  assert.equal(environment.UV_INDEX_URL, undefined);
  assert.equal(environment.UV_CONSTRAINT, undefined);
  assert.equal(environment.UV_NO_VERIFY_HASHES, undefined);
  assert.equal(environment.HF_ENDPOINT, undefined);
  assert.equal(environment.HF_TOKEN, undefined);
  assert.equal(environment.SSL_CERT_FILE, undefined);
  assert.equal(environment.HTTPS_PROXY, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.DYLD_INSERT_LIBRARIES, undefined);
  assert.equal(environment.UV_NO_CONFIG, "1");
  assert.equal(environment.UV_MANAGED_PYTHON, "1");
  assert.equal(environment.UV_DEFAULT_INDEX, "https://pypi.org/simple");
  assert.equal(environment.UV_INDEX_STRATEGY, "first-index");
  assert.equal(environment.UV_KEYRING_PROVIDER, "disabled");
  assert.equal(environment.UV_REQUIRE_HASHES, "1");
  assert.equal(environment.UV_CACHE_DIR, "/private/cache");
  assert.equal(environment.UV_PYTHON_INSTALL_DIR, "/private/python");
  assert.equal(environment.HF_HUB_DISABLE_TELEMETRY, "1");
  assert.equal(environment.HF_HUB_DISABLE_IMPLICIT_TOKEN, "1");
});
