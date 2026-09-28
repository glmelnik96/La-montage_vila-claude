# Grading in DaVinci: the edit's video out, the graded video back in (Workflow J)

Use this when the edit is finished in Premiere, and the user wants to grade the camera footage in
DaVinci Resolve and have the graded video put back into the sequences. Stills (slides, cards),
audio and screen recordings stay in Premiere.

Verified end to end on 2026-09-28, on two courses (12 episodes, 90 fragments, BRAW 3840×2160 25p).
Every fragment came back frame-exact.

## 1. Look at V1 before exporting anything

- Run `scripts/seqdump.mjs`. The dump is the plan's source and the "before" for every check.
- **V1 must carry default Motion and no video effects.** A punch-in or a crop would be baked into
  the grade, then applied again in Premiere. List each V1 clip's components (the Motion values and
  anything besides Opacity/Motion) before building the timeline.
- **Snap the episodes to the frame grid** with `scripts/gridfix.mjs`. Scripted moves can leave
  items 1 tick off the grid (see SKILL.md «Times»), and a graded clip laid over such an item
  leaves a 1-tick sliver of the old one.

## 2. The grading timeline and its XML: `scripts/gradexml.mjs`

- **One sequence per project.**
  - It is a clone of the first episode, emptied, so the frame size and rate are the episodes'.
  - It holds V1 pieces only: no stills, no audio, no screen recordings.
  - Each episode starts with a marker «Ролик N».
- **Two modes:**
  - `visible` keeps only the parts of V1 not under a full-frame still. Full-frame slides hide the
    speaker completely. On one course that was 0.9 of 24.7 min; on another, 12 of 62. In 4K
    ProRes that is hundreds of GB of render saved.
  - `all` keeps every piece, a reserve for slides the client may remove later.
  - Offer both; the user picks. They rendered «все куски».
- **A screen recording is not a full-frame cover.** One was 3456×2234 on a 3840×2160 frame, so
  the studio showed at its sides. Count V1 under it as visible.
- **`sequence.exportAsFinalCutProXML(path, 1)`** writes the XML. Premiere also leaves a «FCP
  Translation Results» txt next to it. «Effect <Blackmagic RAW> / <BRAW Studio Source Settings>
  … not translated» is expected: the RAW decode is set anew in Resolve.
- **Check the XML itself** with `scripts/gradexmlcheck.py`:
  - every clipitem start/end/in/out in frames matches the plan;
  - the sources are all .braw (or whatever the camera media is);
  - there are no audio clipitems;
  - the resolution and the file timecodes are right.

## 3. What to ask of the render

- Individual clips, video only if possible, at the timeline resolution.
- **File names must carry the source name and the source timecode in frames.** The user's
  Resolve preset writes `A059_10121816_C015true01644875.mp4`: the source, «true», then
  1644875 = 18:16:35:00 at 25 fps, the fragment's first frame. `gradesub.mjs --name-re` takes
  another pattern.
- Handles are optional. Without them each render is exactly its fragment, which is all the
  substitution needs.
- **Their renders came as H.264 MP4 (4:2:0, 8-bit, ~121 Mbit/s) with an AAC track.**
  - The transfer tag was `unknown`. Premiere read it as Rec.709: the code values passed through
    unchanged (section 5).
  - The audio is why the placement never targets A1.

## 4. Substitution: `scripts/gradesub.mjs`

The steps are `match`, `backup`, `snapshot`, `import`, `place` and `check`.

- **`match`.** A render belongs to the plan row whose source it names and whose source timecode
  equals the XML's file timecode + the row's in-point. Its frame count must equal the fragment's.
  90 of 90 matched on the first try, with no render left over.
- **`place`:** `Sequence.overwriteClip(item, a + 0.001 s, 0, lastAudioTrack)`, one call per
  fragment.
  - The whole render lands on V1 exactly over its fragment. The original item is cut or removed
    by the overwrite.
  - A1 is not targeted, so the camera audio and its gain and effects stay.
  - The render's own audio lands on the (empty) last audio track and is removed at once.
  - Test it once on a throwaway clone first. On 26.3.2 it did exactly this.
- **`check`:**
  - V1 is the renders at the planned ranges, in-point 0;
  - A1–An, V2+, the markers, the end and the In/Out equal the snapshot;
  - there are no slivers (`gridfix.mjs`) and the track order is right (`trackorder.mjs`).

## 5. Prove it on code values

- **`scripts/tlexport.mjs`** exports a few frames of the episode as Rec.709 H.264 from a throwaway
  clone. **`scripts/gradeverify.py`** compares each frame's Y plane with frames j−1, j and j+1 of
  its render.
- Frame j must be the closest by a margin: 0.2–0.4 against 0.7–1.0 for its neighbours. That
  proves the grade is in and in step, including across a cut (the last frame of one render, then
  frame 0 of the next).
- Against the pre-grade backup the difference was ~15 levels.
- **Do not judge this with a JPEG export.**
  - Premiere converts Rec.709 to sRGB for JPEG: 7→3, 42→33, 111→105, 239→240 against the file's
    own decode.
  - That looked like a darker, contrastier grade in Premiere, and it was only the export.
  - The Rec.709 export matched the render level for level (23.7→23.8, 57.6→57.6, 127.3→127.3).
