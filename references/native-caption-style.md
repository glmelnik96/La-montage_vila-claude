# Native caption styling and documentary timing

Live-verified in Premiere Pro 2026, 2026-11-12. Read when matching native captions to
an existing user-corrected film. These are UI techniques, not a prescribed visual style.

## Match the current reference

- Inspect a real cue in the current working film. Record font family/style/size, fill,
  stroke enable state, background colour/opacity/size/radius, shadow, alignment and position.
  An old project XML can contain several obsolete font/style objects.
- Render one-line and two-line cues over bright and dark footage. Compare the actual bottom
  margin; native captions and Essential Graphics text can differ despite equal font size.
- Native captions remain editable on C1; `createCaptionTrack` imports SRT. The ExtendScript
  DOM does not expose individual native cues. Do not substitute rendered subtitle cards.

## Bulk selection without touching picture or sound

1. Focus the intended sequence and click a caption clip. Ctrl+A may select **all** timeline
   clips, including video/audio. Explicitly deselect each AV TrackItem using
   `clip.setSelected(false, true)`, guarded by the intended sequence ID.
2. Check Properties shows multiple selected captions and font/background controls before edits.
3. Native HotText controls share accessibility indexes in the closed state. Double-click
   the numeric value, fetch fresh AX state, and target the **child editable field with ID 1**
   underneath `OS_EditText`; the outer OS_EditText can reject `setValue`.
4. Set the child field and commit with Tab. Read the resulting value and render a frame.
   A successful click/type is not proof of application. Return can leave the field and start
   playback; avoid numeric batches without checking each result.
5. Negative vertical offset is supported: -14 moved this 1080p caption upward 14 px.
   This is a measured example, not a universal margin. Multi-selection '-' means mixed values.

## Timing and voice checks

- Treat word spans lasting several seconds as suspect. Whole-file ASR collapsed a failed
  phrase, director intervention and good restart into one clean sentence. Re-recognizing a
  short source window with context exposed all three. Use the good take, then regenerate
  mapped caption timings. Never derive editorial cuts from ASR timestamps alone.
- Physical voice channel can change between source files from the same shoot. Measure each
  source, apply the appropriate Fill direction per clip, then export actual Premiere audio.
  Comparing a source-rebuilt mix is useful only when its assumptions about clip gains and
  effects are explicit; it does not replace a host render.
- Quantize source and timeline edges to the destination frame grid before placing clips.
  A half-frame plan position can round differently in Premiere and break exact clip lookup.
- If any words remain uncertain, put specific review markers in the working sequence and
  report them as unresolved. A second ASR pass is not a claim of manual listening.

## Verified pitfalls — 2026-11-13

- With the current desktop controller, activating Premiere before an input can dismiss an
  open font menu or HotText editor. If the value does not survive a fresh read, stop repeating
  blind input; inspect the resulting caption before trying another route.
- A variable-font UI label and the stored font name can differ: the live reference showed
  Onest Regular while its native payload contained Onest-Bold. Preserve the rendered reference,
  not a guessed replacement font name. Essential Graphics Source Text can return an opaque
  binary string rather than JSON; inspect its representation before parsing.
- A narrowly scoped offline style transfer was verified for native captions in this Premiere
  build: back up and close the project, identify the new sequence's independent caption Blocks,
  copy the reference FormattedTextData structure and replace only its text. This is an
  undocumented format, not a general API: inspect its FlatBuffer tables/string pointer and
  lengths instead of reusing fixed offsets. Preserve timing objects and require an XML-object
  diff showing that only the intended new caption Blocks changed. Reopen and render both
  one-line and two-line cues over footage and graphics before accepting the result.
- AV ripple edits did not retime the native caption track in this job. Rebuild caption timings
  through the same piecewise cut map; preserve the old track hidden in the working duplicate.
- Check short audio exports from the actual edited sequence around each speech cut. A clipped
  last word was already missing in the source edit. Source handles restored it by advancing the
  following clip's in-point through a filler, without moving later content. Validate both sides
  of such a repair; clean source ASR alone does not verify a timeline join.
- Audio Remix clips may have a null projectItem. Guard dump code and inspect the actual mix;
  null metadata does not establish missing music.
