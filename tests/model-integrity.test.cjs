"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.join(__dirname, "..");
const worker = path.join(root, "engine", "seed-vc", "worker.py");
const revision = "a".repeat(40);
const payload = Buffer.from("exact-model-bytes");
const pythonExecutable = process.env.CPV_TEST_PYTHON || (process.platform === "win32" ? "python" : "python3");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createRuntime({ manifestBytes = payload.length, artifact = payload } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cpv-model-integrity-"));
  const runtimeRoot = path.join(directory, "runtime");
  const lockPath = path.join(directory, "model-lock.json");
  const lock = {
    schemaVersion: 1,
    seedVcCommit: "b".repeat(40),
    python: "3.11",
    repositories: {
      "example/model": {
        revision,
        cache: "checkpoints",
        files: { "weights.bin": sha256(payload) },
      },
    },
  };
  const lockText = `${JSON.stringify(lock)}\n`;
  fs.writeFileSync(lockPath, lockText);
  const snapshot = path.join(
    runtimeRoot,
    "models",
    "checkpoints",
    "models--example--model",
    "snapshots",
    revision,
  );
  fs.mkdirSync(snapshot, { recursive: true });
  fs.writeFileSync(path.join(snapshot, "weights.bin"), artifact);
  fs.writeFileSync(path.join(runtimeRoot, "install-manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    modelLockSha256: sha256(lockText),
    seedVcCommit: lock.seedVcCommit,
    python: lock.python,
    files: [{
      repo: "example/model",
      revision,
      file: "weights.bin",
      sha256: sha256(payload),
      bytes: manifestBytes,
    }],
  })}\n`);
  return { directory, runtimeRoot, lockPath };
}

function verify({ runtimeRoot, lockPath }) {
  const result = spawnSync(pythonExecutable, ["-c", [
    "import importlib.util, sys",
    "spec = importlib.util.spec_from_file_location('worker', sys.argv[1])",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "module.verify_model_artifacts(module.Path(sys.argv[2]), module.Path(sys.argv[3]))",
  ].join("; "), worker, runtimeRoot, lockPath], { encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

function validatePackages(expected, installed) {
  const result = spawnSync(pythonExecutable, ["-c", [
    "import importlib.util, json, sys",
    "spec = importlib.util.spec_from_file_location('worker', sys.argv[1])",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "module.validate_runtime_packages(json.loads(sys.argv[2]), json.loads(sys.argv[3]))",
  ].join("; "), worker, JSON.stringify(expected), JSON.stringify(installed)], { encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

test("model verifier accepts only the exact locked offline snapshot", (t) => {
  const fixture = createRuntime();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const result = verify(fixture);
  assert.equal(result.status, 0, result.stderr);
});

test("model verifier rejects a same-size cache artifact with a different SHA-256", (t) => {
  const fixture = createRuntime({ artifact: Buffer.alloc(payload.length, 0x78) });
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const result = verify(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /offline cache SHA-256 mismatch/);
  assert.match(result.stderr, /documented engine setup flow/);
});

test("model verifier rejects installation-manifest byte metadata that does not match the cache", (t) => {
  const fixture = createRuntime({ manifestBytes: payload.length + 1 });
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const result = verify(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /offline cache byte size mismatch/);
});

test("runtime package verifier requires all four exact qualified versions", () => {
  const requirements = fs.readFileSync(
    path.join(root, "engine", "seed-vc", "requirements-macos-arm64.lock.txt"),
    "utf8",
  );
  const entries = requirements.split(/\n(?=[A-Za-z0-9_.-]+==)/u).filter(Boolean);
  assert.ok(entries.length > 50, "the complete transitive runtime must be locked");
  for (const entry of entries) {
    assert.match(entry, /^[A-Za-z0-9_.-]+==[^\s\\]+\s+\\/u);
    assert.match(entry, /--hash=sha256:[a-f0-9]{64}/u);
  }

  const expected = {
    torch: "2.13.0",
    torchaudio: "2.11.0",
    transformers: "4.46.3",
    "huggingface-hub": "0.28.1",
  };
  assert.equal(validatePackages(expected, { ...expected }).status, 0);

  const wrongTransformers = validatePackages(expected, {
    ...expected,
    transformers: "4.47.0",
  });
  assert.notEqual(wrongTransformers.status, 0);
  assert.match(wrongTransformers.stderr, /transformers 4\.46\.3 is required, found 4\.47\.0/);

  const incomplete = { ...expected };
  delete incomplete["huggingface-hub"];
  const missingHub = validatePackages(expected, incomplete);
  assert.notEqual(missingHub.status, 0);
  assert.match(missingHub.stderr, /package inventory is incomplete/);
});
