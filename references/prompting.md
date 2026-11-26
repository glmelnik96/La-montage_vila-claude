# Prompting reference (gen.mjs)

For a staged AI film, game cinematic or hybrid edit, start with the
[shot and take sheet](staged-shots.md). It covers the script beat, timed board,
reference roles, versioned takes, local media check, adjacent frames and edit handoff.
An existing board, CSV or edit list can supply those fields directly.

The templates below also serve existing Workflow A callers of `gen.mjs`.
Its numeric node IDs, flags and sidecar credit preview belong to that wrapper.
For new production use the official channels and model-specific inputs described
in `ae-motion-live`, §6 and `reference/generation-recipes.md`. The local shot
check runs independently of the sidecar. For a prompt, fill the relevant slots,
drop empty ones and describe what the viewer can see.

## Node map (defaults in `gen.mjs`)
- **image** → node `94` (Nano Banana / text-to-image)
- **video** → node `74` (Kling, default) or `100` (Seedance); pick with `--node`
- **voice** → node `89` (TTS; `--voice <id>`, default `rv5jQF81clh7R2mBDAEQ`)
- **upscale** → node `87` (`--scale X2|X4`, needs `--in <video>`)

For an existing sidecar job, `--dry-run` requests a cost preview before approval.

## IMAGE prompt template (node 94)
Order matters — lead with the subject, end with style.

```
[subject + defining detail], [action/pose], [setting/background],
[composition/framing], [lighting], [color/mood], [art style/medium]
```

Example (podcast cover b-roll):
> a single vintage broadcast microphone on a dark wooden desk, slight tilt,
> blurred home-studio background with warm bokeh, centered close-up,
> soft key light from the left, moody amber and teal palette, photorealistic, 35mm

Tips:
- One clear subject. Multiple subjects → describe their spatial relation.
- Put aspect intent in words ("vertical composition", "wide cinematic frame") — the
  slot templates don't set canvas size.
- Prefer nouns over "high quality / 4k / masterpiece" filler; it rarely helps here.

## VIDEO prompt template (nodes 74 / 100)
Specify the **camera behaviour** (locked frame or one deliberate move) and the
**temporal action**, including the moment the editor can cut on.

```
[subject + detail], [what it DOES over the shot], [setting],
[camera movement], [lighting], [style/mood], [pacing]
```

Example (t2v establishing shot):
> steam rising from a coffee cup beside an open notebook, steam curling slowly
> upward, cozy desk by a rain-streaked window, slow push-in dolly, soft morning
> light, calm cinematic tone, gentle slow motion

Per-model branching:
- **Kling (74):** strong at smooth realistic motion and camera moves. Give ONE
  clear camera instruction (push-in, orbit, pan-left). Over-specifying multiple
  moves causes jitter. Good default for talking-b-roll and product motion.
- **Seedance (100):** stronger stylized / dynamic action and faster cuts. Lean
  into energetic verbs and style words; still keep a single dominant motion.

Scenario slot (`--scenario`, gen.mjs default `t2v`):
- `t2v` — text-only. Fill all slots; the prompt is the only signal.
- `i2v` — pass a start frame with `--in <image>`. Then the prompt should describe
  MOTION and camera only (the image already fixes subject/setting); don't
  re-describe what's already visible.

## Negative-prompt defaults
If the model/node accepts a negative prompt, start from these and add
context-specific exclusions:

```
blurry, low resolution, distorted, deformed, extra limbs, extra fingers,
watermark, text, logo, jpeg artifacts, oversaturated, flickering, warped face
```

For video also exclude: `stuttering motion, morphing, duplicated subject, camera shake`.

## Voice (node 89)
- Keep `--text` punctuated and in the target language; punctuation drives pacing.
- Write numbers/dates as words if you want them read a specific way.
- Keep a single take under a few sentences; stitch longer VO from multiple clips.

## Checklist before spending credits
- [ ] Subject is a concrete noun, not only adjectives.
- [ ] Video prompt specifies camera behaviour and an observable action.
- [ ] Aspect/framing stated in words if it matters.
- [ ] Where supported, the negative prompt addresses a specific visible defect.
- [ ] Model, settings, output count and estimated cost shown and approved. Existing sidecar users obtain their estimate with `--dry-run`.

## Staged films and game cinematics

Start with the script beat and timed storyboard. Copy the [shot and take sheet](staged-shots.md)
for each planned cut, including missing shots. It contains the take-selection check and a
command to extract both neighbouring frames and the current action for editorial review.
