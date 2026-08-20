"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const VOICE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_REFERENCE_BYTES = 16 * 1024 * 1024;

function requiredString(value, field, maxLength = 500) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`${field} must be a non-empty string up to ${maxLength} characters`);
  }
  return value.trim();
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function requiredHttpsUrl(value, field) {
  const input = requiredString(value, field, 500);
  let parsed;
  try { parsed = new URL(input); }
  catch { throw new Error(`${field} must be a valid HTTPS URL`); }
  if (parsed.protocol !== "https:") throw new Error(`${field} must be a valid HTTPS URL`);
  return parsed.href;
}

function publicVoice(voice) {
  const { referencePath: _referencePath, ...value } = voice;
  return { ...value };
}

class VoiceCatalog {
  constructor({ manifestPath, additionalManifestPaths = [], exists = fs.existsSync, hashFile = sha256 } = {}) {
    this.manifestPath = manifestPath;
    this.additionalManifestPaths = additionalManifestPaths;
    this.exists = exists;
    this.hashFile = hashFile;
    this.voices = [];
    this.byId = new Map();
    this.load();
  }

  load() {
    const manifestPaths = [
      this.manifestPath,
      ...this.additionalManifestPaths.filter((manifestPath) => this.exists(manifestPath)),
    ];
    const voices = [];
    const ids = new Set();
    for (const manifestPath of manifestPaths) {
      let manifest;
      try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); }
      catch (error) {
        throw new Error(`Voice catalog could not be read: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.voices) || manifest.voices.length === 0) {
        throw new Error("Voice catalog schema is unsupported or empty");
      }
      const root = path.dirname(manifestPath);
      for (const [index, value] of manifest.voices.entries()) {
      const owner = `${path.basename(manifestPath)} voices[${index}]`;
      const id = requiredString(value?.id, `${owner}.id`, 120);
      if (!VOICE_ID.test(id) || ids.has(id)) throw new Error(`${owner}.id is invalid or duplicated`);
      ids.add(id);
      const relativeReference = requiredString(value.reference, `${owner}.reference`, 240);
      const referencePath = path.resolve(root, relativeReference);
      const relativeResolved = path.relative(root, referencePath);
      if (relativeResolved.startsWith("..") || path.isAbsolute(relativeResolved)) {
        throw new Error(`${owner}.reference escapes the voice catalog`);
      }
      if (!this.exists(referencePath)) throw new Error(`${owner}.reference is missing`);
      if (path.extname(referencePath).toLowerCase() !== ".wav") {
        throw new Error(`${owner}.reference must be a WAV file`);
      }
      const referenceBytes = fs.statSync(referencePath).size;
      if (referenceBytes <= 0 || referenceBytes > MAX_REFERENCE_BYTES) {
        throw new Error(`${owner}.reference must be between 1 byte and ${MAX_REFERENCE_BYTES} bytes`);
      }
      const expectedHash = requiredString(value.referenceSha256, `${owner}.referenceSha256`, 64).toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(expectedHash) || this.hashFile(referencePath) !== expectedHash) {
        throw new Error(`${owner}.reference failed its SHA-256 integrity check`);
      }
      voices.push(Object.freeze({
        id,
        name: requiredString(value.name, `${owner}.name`, 160),
        nativeName: requiredString(value.nativeName, `${owner}.nativeName`, 160),
        description: requiredString(value.description, `${owner}.description`, 240),
        locale: requiredString(value.locale, `${owner}.locale`, 40),
        requiredCredit: requiredString(value.requiredCredit, `${owner}.requiredCredit`, 240),
        termsUrl: requiredHttpsUrl(value.termsUrl, `${owner}.termsUrl`),
        referencePath,
        referenceBytes,
        referenceSha256: expectedHash,
      }));
      }
    }
    this.voices = voices;
    this.byId = new Map(voices.map((voice) => [voice.id, voice]));
  }

  list() {
    return this.voices.map(publicVoice);
  }

  defaultVoice() {
    return this.voices[0];
  }

  resolve(id) {
    const voice = this.byId.get(id);
    if (!voice) throw new Error("Select an installed target voice");
    let referenceBytes;
    try {
      referenceBytes = fs.statSync(voice.referencePath).size;
    } catch {
      throw new Error("The selected voice reference is no longer installed");
    }
    if (
      referenceBytes !== voice.referenceBytes ||
      referenceBytes <= 0 ||
      referenceBytes > MAX_REFERENCE_BYTES ||
      this.hashFile(voice.referencePath) !== voice.referenceSha256
    ) {
      throw new Error("The selected voice reference changed after catalog validation");
    }
    return voice;
  }

  sample(id) {
    const voice = this.resolve(id);
    const data = fs.readFileSync(voice.referencePath);
    const dataHash = crypto.createHash("sha256").update(data).digest("hex");
    if (
      data.length !== voice.referenceBytes ||
      data.length > MAX_REFERENCE_BYTES ||
      dataHash !== voice.referenceSha256
    ) {
      throw new Error("The selected voice sample changed after catalog validation");
    }
    return { voice: publicVoice(voice), data, mimeType: "audio/wav" };
  }
}

module.exports = { MAX_REFERENCE_BYTES, VoiceCatalog, sha256 };
