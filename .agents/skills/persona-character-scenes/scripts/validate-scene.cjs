#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const [scenePath] = process.argv.slice(2);
const failures = [];

if (!scenePath) {
  console.error("Usage: validate-scene.cjs <character-session-scene.png>");
  process.exit(2);
}

if (!scenePath.endsWith("-session-scene.png")) {
  failures.push("filename must end with -session-scene.png");
}

let bytes;
try {
  bytes = fs.readFileSync(scenePath);
} catch (error) {
  console.error(`Cannot read ${scenePath}: ${error.message}`);
  process.exit(2);
}

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
if (bytes.length < 29 || !bytes.subarray(0, 8).equals(pngSignature)) {
  failures.push("asset must be a valid PNG with an IHDR header");
}

let width = 0;
let height = 0;
let bitDepth = 0;
let colorType = -1;
let interlace = -1;

if (failures.length === 0) {
  const chunkType = bytes.toString("ascii", 12, 16);
  if (chunkType !== "IHDR") failures.push("first PNG chunk must be IHDR");
  width = bytes.readUInt32BE(16);
  height = bytes.readUInt32BE(20);
  bitDepth = bytes[24];
  colorType = bytes[25];
  interlace = bytes[28];

  const ratio = width / height;
  if (width < 1600 || height < 800)
    failures.push("canvas must be at least 1600x800");
  if (width > 4096 || height > 2048)
    failures.push("canvas must not exceed 4096x2048");
  if (ratio < 1.95 || ratio > 2.05)
    failures.push(`aspect ratio must be 2:1, received ${ratio.toFixed(4)}:1`);
  if (bitDepth !== 8 || colorType !== 2)
    failures.push("PNG must be opaque 8-bit RGB (no alpha or indexed transparency)");
  if (interlace !== 0) failures.push("PNG must be non-interlaced");
}

const maximumBytes = 2.5 * 1024 * 1024;
if (bytes.length > maximumBytes) {
  failures.push(
    `file must be <= 2.5 MiB, received ${(bytes.length / 1024 / 1024).toFixed(2)} MiB`,
  );
}

if (failures.length > 0) {
  console.error(`Scene validation failed for ${scenePath}:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      file: path.normalize(scenePath),
      width,
      height,
      aspectRatio: Number((width / height).toFixed(4)),
      bytes: bytes.length,
      format: "opaque-rgb-png",
    },
    null,
    2,
  ),
);
