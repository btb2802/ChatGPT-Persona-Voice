"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { linuxDesktopEntry } = require("../electron/autostart.cjs");

test("Linux autostart launches the stable AppImage invisibly and escapes desktop-entry fields", () => {
  const entry = linuxDesktopEntry(
    { getPath: () => "/tmp/transient-electron" },
    "/home/example/Applications/Codex Persona Voice.AppImage",
  );
  assert.match(entry, /^Name=Codex Persona Voice$/m);
  assert.match(
    entry,
    /^Exec=\/usr\/bin\/env APPIMAGE_EXTRACT_AND_RUN=1 CODEX_PERSONA_VOICE_APPIMAGE="\/home\/example\/Applications\/Codex Persona Voice\.AppImage" "\/home\/example\/Applications\/Codex Persona Voice\.AppImage" --hidden$/m,
  );
  assert.match(entry, /^Terminal=false$/m);
  assert.match(entry, /^X-GNOME-Autostart-enabled=true$/m);
  const escapedEntry = linuxDesktopEntry(
    { getPath: () => "/tmp/transient-electron" },
    "/home/example/100% `$ ready/Voice.AppImage",
  );
  assert.match(escapedEntry, /100%% \\`\\\$ ready/);
  assert.doesNotMatch(escapedEntry, /100% `\$/);
});
