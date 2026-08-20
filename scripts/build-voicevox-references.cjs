"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const outputRoot = path.join(root, "voices", "references");
const sourceBase = "https://voicevox.hiroshiba.jp";

const references = [
  ["voicevox-shikoku-metan-normal.wav", [
    "/_astro/shikoku_metan-normal-001.D9FQX0-3.wav",
    "/_astro/shikoku_metan-normal-002.B7UuYf3e.wav",
    "/_astro/shikoku_metan-normal-003.BJPS0TKT.wav",
  ]],
  ["voicevox-zundamon-normal.wav", [
    "/_astro/zundamon-normal-001.DlxPrwB-.wav",
    "/_astro/zundamon-normal-002.kPSKU_VH.wav",
    "/_astro/zundamon-normal-003.BKjvVfSJ.wav",
  ]],
  ["voicevox-kasukabe-tsumugi-normal.wav", [
    "/_astro/kasukabe_tsumugi-normal-001.BwyhSI7J.wav",
    "/_astro/kasukabe_tsumugi-normal-002.BVavXUVF.wav",
    "/_astro/kasukabe_tsumugi-normal-003.DYL_VA8c.wav",
  ]],
  ["voicevox-meimei-himari-normal.wav", [
    "/_astro/meimei_himari-normal-001.D5oqbi3_.wav",
    "/_astro/meimei_himari-normal-002.D2FN91p9.wav",
    "/_astro/meimei_himari-normal-003.DnWtslWg.wav",
  ]],
  ["voicevox-kyushu-sora-normal.wav", [
    "/_astro/kyushu_sora-normal-001.Bon0IOOx.wav",
    "/_astro/kyushu_sora-normal-002.Bg2lfvwi.wav",
    "/_astro/kyushu_sora-normal-003.CGzGNW4z.wav",
  ]],
  ["voicevox-whitecul-normal.wav", [
    "/_astro/white_cul-normal-001.9MPrFlt_.wav",
    "/_astro/white_cul-normal-002.D5IU_rJT.wav",
    "/_astro/white_cul-normal-003.Drtrlgky.wav",
  ]],
  ["voicevox-ouka-miko-normal.wav", [
    "/_astro/ouka_miko-normal-001.oXjhcDJ0.wav",
    "/_astro/ouka_miko-normal-002.BJQ5IY2o.wav",
    "/_astro/ouka_miko-normal-003.CAA7YVAd.wav",
  ]],
  ["voicevox-sayo-normal.wav", [
    "/_astro/sayo-normal-001.CuUywNuw.wav",
    "/_astro/sayo-normal-002.tG60IxRK.wav",
    "/_astro/sayo-normal-003.Bka85fEl.wav",
  ]],
  ["voicevox-nurse-robo-type-t-normal.wav", [
    "/_astro/nurserobo_typet-normal-001.CXxGLTvZ.wav",
    "/_astro/nurserobo_typet-normal-002.CYzPGBqy.wav",
    "/_astro/nurserobo_typet-normal-003.C-tPKx2I.wav",
  ]],
  ["voicevox-haruka-nana-normal.wav", [
    "/_astro/haruka_nana-normal-001.Djz35eHj.wav",
    "/_astro/haruka_nana-normal-002.BX5gkL57.wav",
    "/_astro/haruka_nana-normal-003.ROg1yyuJ.wav",
  ]],
  ["voicevox-nekotsuka-aru-normal.wav", [
    "/_astro/nekotsuka_aru-normal-001.ChdMH455.wav",
    "/_astro/nekotsuka_aru-normal-002.CTAfp-W1.wav",
    "/_astro/nekotsuka_aru-normal-003.B8ap1iRq.wav",
  ]],
  ["voicevox-manbetsu-hanamaru-normal.wav", [
    "/_astro/manbetsu_hanamaru-normal-001.DMP8RS9N.wav",
    "/_astro/manbetsu_hanamaru-normal-002.DffM8nIa.wav",
    "/_astro/manbetsu_hanamaru-normal-003.BKALQEeL.wav",
  ]],
  ["voicevox-kotoyomi-nia-normal.wav", [
    "/_astro/kotoyomi_nia-normal-001.WUPMD6gE.wav",
    "/_astro/kotoyomi_nia-normal-002.CsjzAEth.wav",
    "/_astro/kotoyomi_nia-normal-003.DMtxOPMA.wav",
  ]],
];

function run(executable, args) {
  const result = spawnSync(executable, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `${executable} failed`);
  return result.stdout.trim();
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 44 || bytes.subarray(0, 4).toString("ascii") !== "RIFF" ||
      bytes.subarray(8, 12).toString("ascii") !== "WAVE") {
    throw new Error(`${url} did not return a bounded WAV file`);
  }
  if (bytes.length > 16 * 1024 * 1024) throw new Error(`${url} exceeds the 16 MiB source limit`);
  fs.writeFileSync(destination, bytes, { flag: "wx" });
}

async function main() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cpv-voicevox-"));
  const stagedRoot = path.join(temporaryRoot, "staged");
  fs.mkdirSync(stagedRoot);
  try {
    const results = [];
    for (const [filename, urls] of references) {
      const sources = [];
      for (const [index, relativeUrl] of urls.entries()) {
        const sourcePath = path.join(temporaryRoot, `${path.parse(filename).name}-${index + 1}.wav`);
        await download(`${sourceBase}${relativeUrl}`, sourcePath);
        sources.push(sourcePath);
      }
      const stagedPath = path.join(stagedRoot, filename);
      const inputArgs = sources.flatMap((sourcePath) => ["-i", sourcePath]);
      run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        ...inputArgs,
        "-filter_complex", "[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]",
        "-map", "[out]", "-ar", "22050", "-ac", "1", "-c:a", "pcm_s16le", stagedPath,
      ]);
      const durationSeconds = Number(run("ffprobe", [
        "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", stagedPath,
      ]));
      if (!Number.isFinite(durationSeconds) || durationSeconds < 5 || durationSeconds > 30) {
        throw new Error(`${filename} has an invalid ${durationSeconds}-second duration`);
      }
      results.push({
        filename,
        durationSeconds: Number(durationSeconds.toFixed(3)),
        sha256: crypto.createHash("sha256").update(fs.readFileSync(stagedPath)).digest("hex"),
        sources: urls.map((relativeUrl) => `${sourceBase}${relativeUrl}`),
      });
    }
    fs.mkdirSync(outputRoot, { recursive: true });
    for (const { filename } of results) {
      fs.copyFileSync(path.join(stagedRoot, filename), path.join(outputRoot, filename));
    }
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
