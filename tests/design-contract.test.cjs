"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

test("selected voice cards render a visible check inside their selection circle", () => {
  const primitives = fs.readFileSync(
    path.join(root, "src", "pages", "settings", "SettingsPrimitives.tsx"),
    "utf8",
  );
  const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");
  assert.match(primitives, /aria-pressed=\{selected\}/);
  assert.match(primitives, /className="radio-dot">\s*\{selected \? <Icon name="check" \/> : null\}/);
  assert.match(styles, /\.voice-choice\.is-active \.radio-dot\s*\{/);
  assert.match(styles, /\.voice-choice \.radio-dot svg\s*\{/);
  assert.doesNotMatch(styles, /\.is-active > \.radio-dot/);
});

test("authorized VOICEVOX characters render as integrated session-card scenes", () => {
  const home = fs.readFileSync(path.join(root, "src", "pages", "HomePage.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");
  const scenes = {
    "voicevox-shikoku-metan-normal": "shikoku-metan-session-scene.png",
    "voicevox-zundamon-normal": "zundamon-session-scene.png",
    "voicevox-kasukabe-tsumugi-normal": "kasukabe-tsumugi-session-scene.png",
    "voicevox-meimei-himari-normal": "meimei-himari-session-scene.png",
    "voicevox-kyushu-sora-normal": "kyushu-sora-session-scene.png",
    "voicevox-whitecul-normal": "whitecul-session-scene.png",
    "voicevox-ouka-miko-normal": "ouka-miko-session-scene.png",
    "voicevox-sayo-normal": "sayo-session-scene.png",
    "voicevox-haruka-nana-normal": "haruka-nana-session-scene.png",
    "voicevox-nekotsuka-aru-normal": "nekotsuka-aru-session-scene.png",
    "voicevox-manbetsu-hanamaru-normal": "manbetsu-hanamaru-session-scene.png",
    "voicevox-kotoyomi-nia-normal": "kotoyomi-nia-session-scene.png",
  };

  for (const [voiceId, filename] of Object.entries(scenes)) {
    assert.equal(
      fs.existsSync(path.join(root, "src", "assets", "voices", filename)),
      true,
      `${filename} is missing`,
    );
    assert.match(home, new RegExp(`"${voiceId}": new URL\\(`));
    assert.match(home, new RegExp(filename.replaceAll(".", "\\.")));
  }
  assert.doesNotMatch(home, /"voicevox-nurse-robo-type-t-normal": new URL\(/);
  assert.match(home, /className="session-character-art"/);
  assert.match(home, /sessionArt \? ` has-character-art/);
  assert.match(styles, /\.session-character-art\s*\{/);
  assert.match(styles, /\.session-card\.has-character-art::before\s*\{/);
  assert.match(styles, /height: 100%/);
  assert.match(styles, /filter: grayscale\(1\) brightness\(0\.58\)/);
  assert.match(styles, /transition: filter 1000ms/);
  assert.match(home, /className="session-facts"/);
  assert.doesNotMatch(home, /VoiceOrb/);
  assert.doesNotMatch(styles, /\.voice-orb/);
  assert.doesNotMatch(styles, /\.session-meta/);
  assert.doesNotMatch(home, /session-character-thumbnail/);
});

test("first run requires an explicit locale before optional support and engine setup", () => {
  const onboarding = fs.readFileSync(path.join(root, "src", "components", "Onboarding.tsx"), "utf8");
  assert.match(onboarding, /type OnboardingStep = "language" \| "support" \| "engine"/);
  assert.match(onboarding, /bridge\.setSetting\("uiLocale", nextLocale\)/);
  assert.match(onboarding, /localeOptions\.map/);
  assert.match(onboarding, /role="group"/);
  assert.match(onboarding, /messages!\.onboarding\.starGithub/);
  assert.match(onboarding, /messages!\.onboarding\.followX/);
  assert.match(onboarding, /messages!\.onboarding\.supportOptional/);
  assert.match(onboarding, /messages!\.common\.continue/);
  assert.doesNotMatch(onboarding, /disabled=\{!ready/);
  assert.match(onboarding, /messages!\.onboarding\.socialPrivacy/);
  assert.match(onboarding, /messages!\.onboarding\.engineTitle/);
  assert.match(onboarding, /bridge\.installEngine\(\)/);
  assert.match(onboarding, /role="progressbar"/);
  assert.match(onboarding, /messages!\.onboarding\.setUpLater/);
});

test("available releases surface as a dedicated sidebar action", () => {
  const shell = fs.readFileSync(path.join(root, "src", "components", "AppShell.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");
  assert.match(shell, /\["available", "downloading", "installing"\]/);
  assert.match(shell, /className="sidebar-item is-update"/);
  assert.match(shell, /messages\.sidebar\.updateTo/);
  assert.match(styles, /\.sidebar-item\.is-update/);
});

test("a failed engine package can be retried or reset without filesystem work", () => {
  const settings = fs.readFileSync(
    path.join(root, "src", "pages", "settings", "SettingsSections.tsx"),
    "utf8",
  );
  assert.match(settings, /engineInstallation\.status === "error"/);
  assert.match(settings, /messages\.settings\.voice\.resume/);
  assert.match(settings, /messages\.settings\.voice\.retry/);
  assert.match(settings, /messages\.settings\.voice\.reset/);
  assert.match(settings, /onClick=\{onRemoveEngine\}/);
});
