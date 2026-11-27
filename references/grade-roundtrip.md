# Grading in DaVinci: the edit's video out, the graded video back in (Workflow J)

Use this when the edit is finished in Premiere, and the user wants to grade the camera footage in
DaVinci Resolve and have the graded video put back into the sequences. Stills (slides, cards),
audio and screen recordings stay in Premiere.


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
- **The camera on several tracks, in an edit smaller than the camera** (2026-10-27: a speaker window
  on V2 over a screen on V1, a UHD camera in a 1920×1080 edit):
  - `--tracks 1,2 --media "\.braw$"` takes the camera pieces of both tracks and skips the screen
    recordings and stills that share them.
  - `--pack 1` lays them one after another in the edit's order, with 1 s between them. The user
    asked for exactly this: one V1, in sequence. Without `--pack`, `all` keeps the edit's times,
    and pieces of two tracks must then not overlap.
  - `--source-size` builds the grading sequence from the first piece's own media, so it is
    3840×2160. A clone of the 1080p edit would bring the renders back at 1080p.
  - `--copy-markers` puts each block's marker on its first piece.
  - The pieces keep their own Motion in the edit: 50–68 % on V1, and 45 % plus a Crop for the
    speaker window on V2. The substitution must put each render on its piece's own track, with that
    piece's Motion and effects: `gradesub.mjs` does that (section 4).
- **An edit with speed changes, reverses and anamorphic files** (2026-10-28: 71 GH6/FX3/GoPro clips
  in a 25p edit, most at 50 %). The user's rules for such an XML: each clip at its file's natural
  size, speed 100 %, no effects and no transitions; they render 10-frame handles.
  - **Every piece covers the source range the edit shows, at 100 %.** In/out of a sped clip are in
    its stretched time (SKILL.md, «Times»). `gradexml.mjs` reads speed and reverse from `seqdump`
    and works out the range. A reversed clip is mirrored from the media end. A dissolve at a cut
    adds the frames it borrows. The pieces no longer fit their places, so `--pack 1`.
  - **Grade at the cameras' rate (`--fps 50`).** A 50 % clip of a 50p file shows every source
    frame. A 25p grading timeline renders every other one, and the slow motion would stutter after
    the substitution.
  - **The DOM does not show Time Remapping.** 3 of 71 clips had it and read plain speed 1. Render
    the edit and match every timeline frame to its source frame: the clip's picture is cut by its
    Motion and PAR and shrunk to 128×72 grey, then correlated. 64 clips confirmed the formula to
    the frame. Pass the true ranges of the others with `--ranges` (0.5 s margin).
  - **A source of another rate** (a 29.97 GoPro in a 50p timeline) lands on its own frame, then
    on the grid: pad it by one of its frames.
  - **Pick the sequence's source with `--size-from`**: a square-pixel camera clip at the grading
    rate.
- **Premiere writes a PAR override as sizing.** An anamorphic file that is square in itself, set
  to 1.333 in Interpret Footage, came out as Basic Motion Scale 133.333 plus a Distort filter
  (Aspect −33.33), with pixelaspectratio «HD-(1440x1080)». Resolve would apply it.
  - `scripts/gradexmlfix.py` drops the Distort and sets Scale 100. It puts back the file's own
    PAR (`pproOriginalPAR`).
  - It also collapses `D%3a//` in `pathurl`: Premiere keeps some paths as `D:\\…`.
  - Keep Premiere's raw export next to the plan; give the user the fixed one.
- **`exportAsFinalCutProXML` wants an absolute path.** A relative one returned `false` and wrote
  nothing.
- **`sequence.exportAsFinalCutProXML(path, 1)`** writes the XML. Premiere also leaves a «FCP
  Translation Results» txt next to it. «Effect <Blackmagic RAW> / <BRAW Studio Source Settings>
  … not translated» is expected: the RAW decode is set anew in Resolve.
- **Check the XML itself** with `scripts/gradexmlcheck.py` (`--media` for non-BRAW sources):
  - every clipitem start/end/in/out in frames matches the plan;
  - the sources are all .braw (or whatever the camera media is);
  - there are no audio clipitems and no transitions;
  - no filter but a default Basic Motion (Scale 100, centred) and Opacity 100, and no Time Remap;
  - it reports every file's pixel aspect, resolution and timecode.
- **Check that each piece holds every frame the edit shows.** Compare the frame map with the XML's
  in/out.
- **Flag a display-matrix rotation.** A GH6 file flagged 90° plays landscape in Premiere. Ask the
  colourist to make sure Resolve does not turn it.

## 3. What to ask of the render

- Individual clips, video only if possible, at the timeline resolution.
- **File names must carry the source name and the source timecode in frames.** The user's
  Resolve preset writes `clip_Atrue00001234.mp4`: the source, «true», then
  1644875 = 18:16:35:00 at 25 fps, the fragment's first frame. `gradesub.mjs --name-re` takes
  another pattern.
- **Or one file of the whole grading timeline.** The user rendered it so on 2026-10-27: ProRes
  422, 3840×2160, 8333 frames from 00:00:00:00, with an AAC track. `gradesub.mjs --single <file>`
  cuts it by the plan.
  - Its frame count must be the timeline's.
  - The 1 s gaps of a packed timeline must come back black, and the pieces not. That proves it is
    in step: 1075 black frames, exactly the 43 planned gaps.
  - Black gaps prove the timing only. Also compare a frame of each of ~20 pieces with frames j−1, j
    and j+1 of the BRAW grading timeline (`exportFramePNG` at UHD). Use gradient correlation, since
    the grade moves every level; j was the best in all 20. That proves Resolve conformed the right
    source frames.
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
  - **Each row goes on its own track** (`tr` in a `gradexml.mjs --tracks` plan). With `--single`, the
    file's in/out marks are set to the row's range of it for the overwrite, then cleared.
- **`snapshot`** also saves every component of each item about to be replaced: Motion, Opacity and
  its effects, keys included. It refuses once the items are gone, so a second run cannot overwrite
  the «before».
- **`fx`** adds the old item's video effects (a speaker window's Crop) through QE, one window of
  rows per call.
- **`props`** sets the snapshot's values on the new item and moves key times with the in-point. A
  1080p edit of a UHD camera scales every piece its own way (50–68 % on V1, 45 % plus a Crop on V2),
  and the render is UHD like the camera, so the same values fit.
- **`check`** goes track by track and item by item, so V1 may hold screens and stills that are not
  rows:
  - V1 is the renders at the planned ranges, in-point 0;
  - A1–An, V2+, the markers, the end and the In/Out equal the snapshot;
  - there are no slivers (`gridfix.mjs`) and the track order is right (`trackorder.mjs`).

## 4b. An edit with speed, reverse, ramps, rotation and dissolves: `scripts/gradeplace.mjs`

Verified on 2026-10-28: 71 clips of GH6/FX3/GoPro in a 25p edit, most at 50 %, 4 reversed, one at 200 %, three at 1 %,
three with Time Remapping, one rotated, 16 anamorphic, Lumetri on one, three dissolves. Every frame came back as the
edit showed it, graded.

- **The user's rule: speed settings stay live.** Constant speed and reverse go back through QE `setSpeed`. Time
  Remapping goes back as the original keyframes. Never bake a ramp into a file: they tweak speeds after the grade.
- **Match renders by picture: `scripts/gradematch.py`.** Resolve names Individual clips `<timeline name><source TC in
  frames>`, with no source name. Phone and GoPro files all start at 00:00:00:00. The matcher compares gradients
  (128×72 grey, zero-mean) over every render frame, ±30 frames around the expected start, and writes `j0` for each:
  render frame k = source frame j0 + k.
  - Pick source frames by their timestamps (`-ss` 1 s early, `-copyts`, `select=gte(t,…)`). An input seek alone
    landed one frame early on long-GOP H.264 and read as a +1 offset everywhere.
- **Read the conform errors off the map.**
  - **FX3, 15 and 14 frames early.** Premiere wrote the Sony sidecar timecode (25 fps frames, `halfStep`) into a
    50p `<timecode>`. `gradexmlfix.py` now puts each file's own timecode back.
  - **GoPro 29.97 in a 50p timeline, 1–3 frames.** Pad such sources by one of their frames (`gradexml.mjs`).
  - **A render Resolve rotated by a source's rotation flag** (2160×4096). Premiere honours the flag too, and the
    edit's own Motion (Rotation 90) had undone it there. Copy that Motion as it is and add no turn of your own.
- **`snapshot` checks every row before anything moves.** The render must hold every frame the edit shows there,
  including a dissolve's borrowed head. Two FX3 rows missed their last 2 frames. The user chose a slip over a
  re-render: `fit` moves the source by the fewest frames, keeping place and length.
- **`import` checks the colour space.** Resolve's «Rec.709 Gamma 2.2» output is tagged transfer 4. Premiere reads
  it as «1-4-1» and lifted the graded code values by 5–7 levels. With the camera source's colour space as an override
  (`setOverrideColorSpace`), Y/U/V came back within 0.0/0.1/0.1. It also compares the PAR: Resolve tags anamorphic
  renders SAR 4:3, and Premiere took 1.333 from that.
- **`place`, one row per call.**
  1. DOM `remove(0,0)` on the original video. Its linked audio stays, and so do the other items.
  2. `overwriteClip` the render at 100 % for as long as it holds (render in = in'·speed).
  3. QE `setSpeed(speed, '', reversed, false, false)`. It keeps the length and the media in-point. It was exact at
     0.5, 1, 2, 0.01 and reversed (vs ×6 on screen recordings, `panel-api-notes.md`).
  4. Set `inPoint`, `outPoint` and `end` in ticks: in' = in − j0/(fps·speed); reversed,
     in' = in + (n + j0 − D)/(fps·speed).
- **`fx` and `props`.**
  - Effects come back through QE `addVideoEffect`. Only the values that differ from the fresh item's are set.
  - Lumetri: 6 of its 130 properties differed (5 keyed + Saturation 55). Its 64-bit selector swatches
    (0xFF00000000000000) do not survive a double. Leave them alone, they are the defaults.
- **`trans`: removing a clip removes its transitions.** QE
  `addTransition(t, atStart, "HH:MM:SS:FF", "00:00:00:00", alignment, singleSided, true)` put all three back to the
  frame:
  - alignment 1 = end at cut, 0 = start at cut;
  - single-sided where no clip meets the cut.
- **`check`:** every row's render at its place with in/out, speed, reverse and values; everything else as the snapshot.
- **Time Remapping is not in the DOM or QE.** A remapped clip reports speed 1 and only Opacity and Motion. The
  keyframes live in the project file, as source media times. So:
  1. `gradeconform.py` lays the render back onto the source's own time: same length, rate and timecode; graded frames
     at j0…, black elsewhere.
  2. Import it and save.
  3. `prreopen.mjs` (with the user's OK: their project closes) runs `prprojremap.py`. That points the clip at the
     new file, gives it the original in/out (remapped clip time) and adds a copy of the original
     TimeRemapping/TimeComponentParam with new ObjectIDs.
  4. The ramp is the user's own, live.
  - ObjectIDs repeat across classes in a .prproj: every lookup names the class. A file imported twice has several
    Media objects.
  - The panel closes with the project. Reopen through the file association: a second Premiere process starts,
    hands the file to the running one and exits.
- **Prove it on pixels.**
  - Render the sequence before and after.
  - `framemap`: which source frame every visible timeline frame showed before.
  - After the substitution the timeline shows the render itself. Grey-pixel distance picks the shown render frame
    (2–4 levels of compression against tens for a wrong frame).
  - A static shot cannot tell neighbouring frames apart (equal distances): that is not an error.

## 5. Prove it on code values

**When the edit scales the pieces (a 1080p edit):** frames of the edit no longer line up with the
render pixel for pixel. Compare the edit after the substitution with the `_OLD_` backup before it.
- Export one frame of every piece from the edit, and frames j−1, j and j+1 from the backup
  (`exportFramePNG` at 1080p).
- Crop each to the piece's visible region (the speaker window for V2), and correlate the gradients.
- j must be the best match. All 44 pieces passed on 2026-10-27.
- The mean grey difference shows that the grade is in: it moved 12–30 levels.

**When the pieces are full frame:**

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

## 6. Retouch remnants hide in near-black

On 2026-10-27 a user's retouch in Resolve left dark green specks where objects had been removed: a
mixing desk, a chair, a rope at the frame's edge. They sat 1–3 % above black. Premiere's viewer did
not show them, because of its darker display gamma and its playback resolution. A player did, and so
did the MP4.
- **Before substituting, look at the retouched spots of the render with the shadows ×3.**
- **The fix without a trip back to Resolve, on a locked-off camera:**
  - **Build the mask.** Flag pixels that are dark (10-bit Y < 110), lifted (Y > 66) and green
    (Cb and Cr < 506) on ~2 frames of every take. Keep the pixels flagged in ≥ 20 % of the frames,
    close the gaps (9×9), and drop clusters under 1500 px (noise on the shelves). Dilate by 24 px and
    blur it (σ 14).
  - **Crush inside it.** Pull near-black to video black (Y 64, Cb = Cr = 512), fully up to Y 112 and
    not at all from Y 150. Bright things inside the mask (a table, a plate) stay as they are.
  - **Write a new ProRes 422 HQ of the whole grading timeline**, with only the studio frames changed:
    decode to `yuv422p10le` on a pipe, fix in numpy, encode with `prores_ks`. 8333 UHD frames took
    27 min.
  - **Match the colour tags** by putting `-color_primaries bt709 -colorspace bt709` on the RAW INPUT
    as well. As output options alone, the primaries came out `unknown`.
  - **Relink**: `projectItem.changeMediaPath(new, false)` on the graded item. All 44 pieces followed,
    with their in/out, Motion and effects.
- **Check the new render against the old one, piece by piece.**
  - The pieces outside the fix differed by encode noise only: mean 0.2–1.7 levels, 99th percentile
    ≤ 6.
  - The wide studio shots changed in ~2 % of their pixels, exactly the specks.
