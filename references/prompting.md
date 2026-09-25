# Prompting reference (gen.mjs)

Guidance for writing prompts for the Phygital sidecar generators. Load this in
Workflow A step 7 before any paid generation. Fill the **slots**, drop empty ones,
and keep prompts concrete — name what is in frame, not adjectives about quality.

## Node map (defaults in `gen.mjs`)
- **image** → node `94` (Nano Banana / text-to-image)
- **video** → node `74` (Kling, default) or `100` (Seedance); pick with `--node`
- **voice** → node `89` (TTS; `--voice <id>`, default `rv5jQF81clh7R2mBDAEQ`)
- **upscale** → node `87` (`--scale X2|X4`, needs `--in <video>`)

Always `--dry-run` first to preview credits, confirm with the user, then generate.

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
Video needs an explicit **camera move** and **temporal action**, or the model
produces a near-still image.

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
- [ ] Video prompt has an explicit camera move + a verb of action.
- [ ] Aspect/framing stated in words if it matters.
- [ ] Negative prompt covers the usual artifacts.
- [ ] `--dry-run` cost previewed and user confirmed.
