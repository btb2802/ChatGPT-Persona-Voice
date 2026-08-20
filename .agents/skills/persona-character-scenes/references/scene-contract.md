# Session-scene visual contract

Use this contract for every Persona Voice character scene. The canonical 2D reference is
`src/assets/voices/sayo-session-scene.png`.

## Shared output geometry

- File: opaque 8-bit RGB PNG; never a transparent cutout.
- Canvas: 2:1 landscape, at least 1600 × 800 and at most 4096 × 2048.
- File size: no more than 2.5 MiB before bundling.
- Left 58–64%: calm, low-detail copy space with no face, hand, high-contrast accessory, or light
  source behind UI text.
- Right 30–38%: exactly one character at a medium waist-up scale.
- Keep the full head silhouette and identity-defining ears, horns, or hair inside the frame. A hand
  near the collar or chest is welcome when anatomically clean; do not force both hands into view.
- The subject faces or looks slightly left toward the copy. The gaze must be aligned and relaxed.

The app supplies the border, corner radius, status text, controls, and state treatment. The image
must not contain a card frame, rounded rectangle, text, logo, waveform, control, badge, or status
indicator.

## Shared art direction

- Continuous matte charcoal background centered around `#222222`.
- A faint neutral burgundy-gray haze may sit behind the character; the left side stays darker.
- Use a subtle cool blue-gray rim and restrained dusty-rose fill. Avoid neon bloom, lens flare,
  glossy gacha effects, busy scenery, texture noise, and hard horizons.
- Match the authorized character design. Count accessories explicitly in the prompt. Do not let
  bows, ribbons, buttons, ears, jewelry, or costume parts duplicate onto limbs or the background.
- Headwear must read as constructed headwear, not a disc, ring, or halo. If a nonessential item
  repeatedly breaks the silhouette, omit it only when the user and character terms allow that
  interpretation.

## 2D mode

Use refined contemporary anime key art with deliberate linework, coherent fabric construction, and
controlled shading. Preserve the character's canonical proportions unless the user requests a
specific allowed reinterpretation. Do not paste or trace official pixels into the deliverable.

Vary pose only within the shared silhouette: modest head angle, shoulder angle, and one natural hand
gesture. Keep scale, lighting, copy space, and camera distance consistent across characters.

## Stylized 3D mode

Use a polished toon/PBR hybrid render rather than photorealism. Match the same 2:1 canvas, medium
waist-up framing, left copy space, palette, and lighting direction as 2D scenes. Prefer a natural
portrait perspective around a 65–85 mm equivalent; avoid wide-angle distortion, extreme depth of
field, plastic skin, collectible-figure bases, and game-selection-screen scenery.

Use an official 3D model only when its render and redistribution terms cover the contribution. If
not, generate a new stylized 3D interpretation from a permitted reference; do not extract or bundle
the upstream model.

## Prompt skeleton

Start with this shared structure and fill concrete character details. Do not leave placeholders in
the actual ImageGen request.

```text
Create a finished 2:1 wide background illustration for the Persona Voice session card.

Composition: left 60–64% empty matte charcoal copy space; exactly one medium waist-up character on
the right 32–36%; body and gaze slightly toward the left; full head silhouette visible; one natural
hand gesture near the collar if appropriate; no close-up and no full-body pose.

Identity: [hair, eyes, face, ears/horns, required outfit construction]. Required accessories:
[exact item and count]. Forbidden additions: [duplicate bows/ribbons/jewelry, halo/disc, unrelated
props, known failure modes].

Rendering: [refined 2D anime key art OR stylized toon/PBR 3D], coherent anatomy and clothing,
subtle cool rim, restrained dusty-rose fill, calm expression, matte #222222 background darkening
toward the left.

No text, logo, watermark, UI, waveform, frame, panel, checkerboard, transparency, scenery, extra
character, photorealism, or sexualization.
```

For a focused edit, name what must remain unchanged before listing corrections. Never say only
“make it better”; specify pose, crop, gaze, anatomy, accessory counts, and forbidden artifacts.

## Visual QA gate

Inspect at full size and at approximately 760 × 238 CSS pixels. Reject the scene if any answer is
no:

- Is the identity recognizable without relying on text?
- Is the left copy area genuinely quiet?
- Are both eyes aligned, focused together, and appropriate to the intended expression?
- Are visible hands anatomically plausible with five fingers and a natural wrist?
- Are ears, horns, hair, collars, and clothing joins coherent?
- Do accessory count and placement match the brief exactly?
- Is the character neither cramped against the frame nor reduced to a tiny icon?
- Is the background a real opaque scene rather than alpha or painted checkerboard?
- Does the image remain consistent with the canonical Sayo scene at card size?
