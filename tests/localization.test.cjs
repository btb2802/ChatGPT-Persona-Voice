"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const localeDirectory = path.join(root, "src", "locales");
const locales = Object.fromEntries(
  ["en", "ja", "zh-CN"].map((locale) => [
    locale,
    JSON.parse(fs.readFileSync(path.join(localeDirectory, `${locale}.json`), "utf8")),
  ]),
);

function flatten(value, prefix = "") {
  const result = new Map();
  for (const [key, child] of Object.entries(value)) {
    const pathKey = prefix ? `${prefix}.${key}` : key;
    if (typeof child === "string") result.set(pathKey, child);
    else {
      assert.equal(child !== null && typeof child === "object" && !Array.isArray(child), true);
      for (const [nestedKey, nestedValue] of flatten(child, pathKey)) {
        result.set(nestedKey, nestedValue);
      }
    }
  }
  return result;
}

function placeholders(value) {
  return [...value.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)]
    .map((match) => match[1])
    .sort();
}

test("English, Japanese, and Simplified Chinese expose one complete message keyset", () => {
  const flattened = Object.fromEntries(
    Object.entries(locales).map(([locale, catalog]) => [locale, flatten(catalog)]),
  );
  const expectedKeys = [...flattened.en.keys()].sort();
  assert.ok(expectedKeys.length > 150);

  for (const locale of ["ja", "zh-CN"]) {
    assert.deepEqual([...flattened[locale].keys()].sort(), expectedKeys);
  }
  for (const key of expectedKeys) {
    const expectedPlaceholders = placeholders(flattened.en.get(key));
    for (const locale of ["en", "ja", "zh-CN"]) {
      const value = flattened[locale].get(key);
      assert.equal(value.trim().length > 0, true, `${locale}:${key} is empty`);
      assert.deepEqual(
        placeholders(value),
        expectedPlaceholders,
        `${locale}:${key} has a different placeholder contract`,
      );
    }
  }
});

test("locale selection is explicit, starts in English, and message lookup has no fallback", () => {
  const i18n = fs.readFileSync(path.join(root, "src", "i18n.tsx"), "utf8");
  const app = fs.readFileSync(path.join(root, "src", "App.tsx"), "utf8");
  const settings = fs.readFileSync(
    path.join(root, "src", "pages", "settings", "SettingsSections.tsx"),
    "utf8",
  );
  const index = fs.readFileSync(path.join(root, "index.html"), "utf8");

  assert.match(i18n, /UI_LOCALES = \["en", "ja", "zh-CN"\] as const/);
  assert.match(i18n, /return catalogs\[locale\];/);
  assert.doesNotMatch(i18n, /catalogs\[locale\]\s*(?:\?\?|\|\|)/);
  assert.doesNotMatch(`${i18n}\n${app}`, /navigator\.languages?|resolvedOptions\(\)\.locale/);
  assert.match(index, /<html lang="en">/);
  assert.match(app, /snapshot\.settings\.uiLocale === null \|\| !snapshot\.onboarding\.complete/);
  assert.match(settings, /onSetting\("uiLocale", event\.target\.value\)/);
});
