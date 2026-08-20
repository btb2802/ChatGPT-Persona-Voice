---
name: persona-character-scenes
description: Generate, review, and integrate consistent 2D or stylized 3D character background scenes for Codex Persona Voice session cards. Use when adding or replacing artwork tied to a voice catalog entry; do not use for voice/audio generation, app icons, README banners, or generic thumbnails.
---

# Persona character scenes

Create one finished, opaque card scene for one authorized voice identity. The scene is part of the
session-card background, not a portrait thumbnail or a transparent character cutout.

## Establish the task

Before generation, resolve:

- the exact `voices/manifest.json` voice ID;
- whether this is a new scene or a replacement;
- 2D or stylized 3D mode; default to 2D unless the source identity is natively 3D or the user asks
  for 3D;
- the official or otherwise authorized visual reference and character-art terms;
- whether the user wants a draft for approval or an end-to-end integrated contribution.

A voice-reference license does not grant character-art rights. If artwork rights or attribution are
unclear, stop with that concrete blocker. Do not substitute scraped art, a celebrity likeness, or a
generic lookalike.

## Read the relevant contracts

Always read:

- [scene contract](references/scene-contract.md) for composition, prompts, 2D/3D consistency, and
  visual QA;
- [integration contract](references/integration.md) before writing the final asset or code.

Also inspect the current canonical scene at `src/assets/voices/sayo-session-scene.png`, the voice
entry in `voices/manifest.json`, and the current mapping in `src/pages/HomePage.tsx`. Treat the
current source as authoritative when paths or UI structure differ from this skill.

## Generate the scene

1. Inspect the permitted character reference before prompting. Keep downloaded reference sheets in
   a temporary directory; never commit them unless their redistribution terms explicitly allow it.
2. Write a short character brief listing mandatory identity features, exact accessory counts, and
   forbidden hallucinations. Describe the pose independently from the outfit.
3. Use the available ImageGen/image-generation capability with the reference image. Generate the
   complete 2:1 opaque scene, including its matte charcoal background.
4. Inspect the actual output. Reject wrong anatomy, gaze, scale, duplicated accessories, stray
   symbols, fake transparency, checkerboards, text, logos, frames, or insufficient empty copy space.
5. Regenerate or make a focused generative edit until the scene passes. Do not remove backgrounds
   with chroma key, flood fill, hand masks, or other post-generation cutout work. If the model cannot
   produce the contract, report the failure instead of shipping a patched composite.
6. If the user requested approval before integration, present exactly one passing candidate and
   pause. Otherwise continue through integration and verification.

## Integrate and verify

- Save the approved PNG under `src/assets/voices/<character-slug>-session-scene.png`.
- Run the deterministic validator:

  ```bash
  node .agents/skills/persona-character-scenes/scripts/validate-scene.cjs \
    src/assets/voices/<character-slug>-session-scene.png
  ```

- Follow [integration contract](references/integration.md) for the ID mapping, terms, notices, and
  checks. Do not add per-character layout CSS; the shared session-card treatment owns placement,
  active color, inactive grayscale, and transition behavior.
- Verify the live renderer when available, but do not click Start/Stop or mutate the audio route for
  visual QA.

## Handoff

Report the voice ID, 2D/3D mode, saved path, permitted reference and terms URL, a concise prompt
summary, validation output, build/test commands, and any remaining visual or licensing limitation.
