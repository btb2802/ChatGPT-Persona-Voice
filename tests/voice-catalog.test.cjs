"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { VoiceCatalog } = require("../electron/voice-catalog.cjs");

const bundledManifestPath = path.join(__dirname, "..", "voices", "manifest.json");
const bundledVoiceIds = [
  "voicevox-shikoku-metan-normal",
  "voicevox-zundamon-normal",
  "voicevox-kasukabe-tsumugi-normal",
  "voicevox-meimei-himari-normal",
  "voicevox-kyushu-sora-normal",
  "voicevox-whitecul-normal",
  "voicevox-ouka-miko-normal",
  "voicevox-sayo-normal",
  "voicevox-nurse-robo-type-t-normal",
  "voicevox-haruka-nana-normal",
  "voicevox-nekotsuka-aru-normal",
  "voicevox-manbetsu-hanamaru-normal",
  "voicevox-kotoyomi-nia-normal",
  "jarvis-community-high",
  "seed-vc-donald-trump-example",
];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cpv-catalog-"));
  const reference = path.join(root, "voice.wav");
  fs.writeFileSync(reference, Buffer.from("voice-reference"));
  const hash = crypto.createHash("sha256").update(fs.readFileSync(reference)).digest("hex");
  const manifest = {
    schemaVersion: 1,
    voices: [{
      id: "licensed-voice",
      name: "Licensed Voice",
      nativeName: "Licensed Voice",
      description: "Test voice",
      locale: "en-US",
      reference: "voice.wav",
      referenceSha256: hash,
      requiredCredit: "Required credit",
      termsUrl: "https://example.com/terms",
    }],
  };
  const manifestPath = path.join(root, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return { root, manifest, manifestPath, reference };
}

test("bundled catalog contains integrity-checked VOICEVOX, JARVIS, and Trump identities", () => {
  const catalog = new VoiceCatalog({ manifestPath: bundledManifestPath });
  assert.deepEqual(catalog.list().map((voice) => voice.id), bundledVoiceIds);
  assert.equal(new Set(catalog.list().map((voice) => voice.requiredCredit)).size, 15);
  assert.equal(catalog.resolve("jarvis-community-high").locale, "en-GB");
  assert.equal(catalog.resolve("seed-vc-donald-trump-example").locale, "en-US");
});

test("voice catalog verifies reference integrity and hides local paths from renderer data", (context) => {
  const value = fixture();
  context.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const catalog = new VoiceCatalog({ manifestPath: value.manifestPath });
  assert.equal(catalog.defaultVoice().id, "licensed-voice");
  assert.equal(catalog.resolve("licensed-voice").referencePath, value.reference);
  assert.equal("referencePath" in catalog.list()[0], false);
  assert.equal(catalog.sample("licensed-voice").data.toString(), "voice-reference");
  assert.equal(catalog.sample("licensed-voice").mimeType, "audio/wav");
  assert.throws(() => catalog.resolve("missing"), /Select an installed/);
});

test("voice catalog rejects changed samples and path traversal", (context) => {
  const value = fixture();
  context.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  fs.appendFileSync(value.reference, "tampered");
  assert.throws(() => new VoiceCatalog({ manifestPath: value.manifestPath }), /integrity/);
  value.manifest.voices[0].reference = "../outside.wav";
  fs.writeFileSync(value.manifestPath, JSON.stringify(value.manifest));
  assert.throws(
    () => new VoiceCatalog({
      manifestPath: value.manifestPath,
      exists: () => true,
      hashFile: () => value.manifest.voices[0].referenceSha256,
    }),
    /escapes/,
  );
});

test("voice catalog exposes only HTTPS terms and immutable bounded WAV samples", (context) => {
  const value = fixture();
  context.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  value.manifest.voices[0].termsUrl = "http://example.com/terms";
  fs.writeFileSync(value.manifestPath, JSON.stringify(value.manifest));
  assert.throws(() => new VoiceCatalog({ manifestPath: value.manifestPath }), /HTTPS URL/);

  value.manifest.voices[0].termsUrl = "https://example.com/terms";
  fs.writeFileSync(value.manifestPath, JSON.stringify(value.manifest));
  const catalog = new VoiceCatalog({ manifestPath: value.manifestPath });
  fs.appendFileSync(value.reference, "changed");
  assert.throws(() => catalog.sample("licensed-voice"), /changed after catalog validation/);
});

test("voice catalog rehashes same-size reference mutations before every use", (context) => {
  const value = fixture();
  context.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const catalog = new VoiceCatalog({ manifestPath: value.manifestPath });
  fs.writeFileSync(value.reference, Buffer.from("tampered-voice!"));
  assert.equal(fs.statSync(value.reference).size, Buffer.byteLength("voice-reference"));
  assert.throws(() => catalog.resolve("licensed-voice"), /changed after catalog validation/);
  assert.throws(() => catalog.sample("licensed-voice"), /changed after catalog validation/);
});

test("voice catalog merges an integrity-checked local overlay without weakening bundled voices", (context) => {
  const bundled = fixture();
  const local = fixture();
  context.after(() => fs.rmSync(bundled.root, { recursive: true, force: true }));
  context.after(() => fs.rmSync(local.root, { recursive: true, force: true }));
  local.manifest.voices[0].id = "local-demo-voice";
  local.manifest.voices[0].name = "Local demo voice";
  fs.writeFileSync(local.manifestPath, JSON.stringify(local.manifest));

  const catalog = new VoiceCatalog({
    manifestPath: bundled.manifestPath,
    additionalManifestPaths: [local.manifestPath],
  });
  assert.deepEqual(catalog.list().map((voice) => voice.id), ["licensed-voice", "local-demo-voice"]);
  assert.equal(catalog.resolve("local-demo-voice").referencePath, local.reference);
});
