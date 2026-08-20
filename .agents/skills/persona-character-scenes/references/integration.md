# Scene integration contract

## Rights and source record

Resolve the exact voice entry in `voices/manifest.json`. Follow its `termsUrl`, then locate the
official character-art or secondary-creation terms when they are separate from audio terms.

Record enough evidence for a reviewer to distinguish:

- voice/audio authorization;
- visual-reference permission;
- derivative-art publication and redistribution permission;
- required character and project credit.

Do not assume that open-source voice software makes a character design open source. Do not commit
an upstream reference sheet merely because it was safe to inspect during generation.

## Repository wiring

1. Save the final asset as `src/assets/voices/<character-slug>-session-scene.png`.
2. Add the exact voice ID and asset URL to `SESSION_ART_BY_VOICE_ID` in
   `src/pages/HomePage.tsx`. Keep the mapping one-to-one and use the manifest ID verbatim.
3. Reuse `.session-character-art` and the shared `has-character-art` state. Do not add absolute
   offsets, filters, or transitions for one character.
4. Update the character-material section in `THIRD_PARTY_NOTICES.md`. State whether the checked-in
   scene is official art or a project-specific derivative; never imply endorsement.
5. Extend the existing design contract test when the mapping or asset convention changes. Avoid a
   test that only matches marketing wording.

If a voice has no authorized visual identity, leave it without a scene. The UI must continue to
work without artwork; do not generate a misleading mascot merely to fill the card.

## Verification

Run from the repository root:

```bash
node .agents/skills/persona-character-scenes/scripts/validate-scene.cjs \
  src/assets/voices/<character-slug>-session-scene.png
node --test tests/design-contract.test.cjs
bun run typecheck
bun run build:renderer
git diff --check
```

When a dev window already exists, visually confirm the rendered card after the source update. Check
that the character reaches the card's bottom edge, text remains readable, and the scene uses full
color for active runtime states and the shared darker grayscale for inactive/faulted states. Do not
toggle the audio relay solely to obtain this screenshot.

The PR description should name the host used for visual verification and include the exact command
results. A generated image or successful build alone is not proof that the live card composition is
correct.
