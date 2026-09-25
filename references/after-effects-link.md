# After Effects graphics in a Premiere edit: Dynamic Link from a script

LIVE-VERIFIED 2026-09-25 on Premiere Pro 26.3.2 with After Effects 26.3, both driven over their
panels: this skill on port 8098, `ae-motion-live` on port 8092. The spike: three labelled test clips
(a letter, burnt-in source time and frame number, a tone per clip) cut into an 18 s sequence, with four
graphics comps linked back. The AE half of the round trip is in ae-motion-live `reference/ae-quirks.md`
#185–#187.

This covers the mechanics only. How a graphics pass fits into a workflow is not designed yet.

## The round trip that works

1. **Render the edit as a plate for AE.** Use `seq.exportAsMediaDirect(out, preset, app.encoder.ENCODE_ENTIRE)`
   with `MediaIO/systempresets/3F3F3F3F_4D6F6F56/H264 Match Source - High bitrate.epr`. That preset
   sits in the QuickTime folder and writes a `.mov` with H.264 and PCM audio. It is synchronous: an 18 s
   sequence rendered in 1.9 s. The plate was frame-exact at both cuts: the last and first frames around
   each cut carried the burnt-in source time the edit called for.
2. **In AE, build one comp per graphic, then save the .aep.** Each comp has the sequence size and fps and
   lasts as long as its slot. The plate goes in as a guide layer with its audio off; see the AE quirks.
3. **Import the comps:** `app.project.importAEComps(new File(aep).fsName, ['GFX_LT_01', ...], bin)`.
   - It returned `true` in 845 ms for four comps.
   - The items are named `<comp>/<aep file name>` (for example `GFX_LT_01/spike.aep`), `getMediaPath()`
     returns the .aep, and `getFootageInterpretation().frameRate` is the comp's fps.
   - An .aep with a Cyrillic file name imported fine, in 12 ms.
   - `importAllAEComps` exists as well; it was not run.
4. **Place them:** `track.overwriteClip(item, sec)` on V2 and up. The clip runs the comp's duration and its
   alpha composites over V1.
5. **Export as usual.** `exportAsMediaDirect` renders the linked comps through AE. The 18 s sequence with
   11 s of graphics took 13.7 s, against 1.9 s without them. A re-export with unchanged comps took
   3–4.5 s: Premiere caches linked frames and re-renders only what changed.

## Traps

- **Off-grid times round up.** `overwriteClip(item, 6.5)` at 25 fps (frame 162.5) landed on 6.52 (frame 163).
  AE keeps a layer's `startTime = 6.5` exactly, so the two apps drift half a frame apart. Convert every slot
  to whole frames before either app sees it: `ticks = frames × (254016000000 / fps)`.
- **A comp with audio gets an audio clip, and that audio sticks.** `overwriteClip` on V2 put the comp's audio
  on A2. The audio came from a guide layer, and guide audio is NOT muted by Dynamic Link. The export measured
  +6 dB under the graphic: the dialogue played twice.
  - Premiere conforms linked audio to `<aep name> <comp>.aep 48000.cfa/.pek` next to the .aep and never
    refreshes it. Disabling the audio in AE changed nothing, with or without a save.
  - The fix that worked: remove the audio part only with `audioTrackItem.remove(false, false)`; the V2 clip
    stays. Better: build comps without audio.
- **Re-import duplicates the item.** A second `importAEComps` of the same comp adds another project item with
  a new `nodeId`. Nothing is updated in place.
- **`getOutPoint()` goes stale on linked items.** After the comp was lengthened from 4 to 5 s and saved, both the
  old item and a fresh re-import still reported 4 s, and `refreshMedia()` (returns true) did not change that.
  The media had grown all the same: a newly placed clip ran 5 s, and the old track item extended to 5 s
  (`outPoint` as a whole `Time`, then `end`). Measure a linked item by placing it, not by `getOutPoint()`.
- **What Premiere sees of the AE project:**
  - A comp from the .aep that is open in the AE GUI renders its unsaved state: a text change nobody saved
    was in the next export.
  - A comp from any other .aep renders from the saved file. For that, Dynamic Link started a second,
    headless `AfterFX.exe` (~3.2 GB) and left it running.
- **Inserting does not ripple the other tracks.** `track.insertClip(item, 0)` and
  `sequence.insertClip(item, 0, 0, 0)` shifted V1 and the markers only. A1, V2 and V3 stayed put, leaving
  sound and graphics 3 s out of sync with the picture.
  - A full-screen intro that pushes the edit therefore has to move every track itself: shift items
    in descending start order, the reverse of `ripplecut.mjs`. Or build the intro into the assembly.
  - A full-screen graphic that only COVERS the picture (on V3, audio running underneath) needs none of this.
- **Removing a range did carry the graphics along.** `pr.mjs cut` (host 2.17.0, `ripple_delete_range`
  0.2–0.6 s) shifted V1, the linked clips on V2/V3 and the markers by 0.4 s, even though V2/V3 were empty
  under the range. The older "Ripple deletes desync tracks that are empty under the range" note in
  SKILL.md did not reproduce here. All tracks were at their default sync lock; it is unknown whether that
  explains the difference. `ripplecut.mjs` moved the clips correctly too, then failed on the markers
  (below).
- **`ripplecut.mjs` bug: a sequence with no In/Out.** With In/Out unset, the saved state holds `-400000`. The
  marker step generates `parseFloat(s.getOutPoint())--400000`, a parse error that reaches the bridge as
  `EvalScript error` after the clips were already shifted, so markers and In/Out stay behind. Fixed on
  2026-09-25: the values are wrapped in parentheses, and an unset In/Out is left unset. Re-running the same
  command finishes an interrupted cut. The state file is picked up, the razor and the shift are not repeated,
  and only the markers move.
- **`seq.videoTracks.addTracks` is `undefined` on 26.3.2**, contrary to `panel-api-notes.md`. The QE fallback
  `qe.project.getActiveSequence().addTracks` exists.

## Getting Premiere to a project with no clicks from the user

The panel only loads once a project is open, and Premiere starts on its Home screen.

- **A project path on the command line fails.** At cold start, `"Adobe Premiere Pro.exe" "<path>.prproj"`
  raised a modal "This file path does not exist on disk at this location", although the file existed and AE
  could read it. Passing the same path to the running instance was silently ignored.
- **The Home screen ignores Ctrl+O.** It is a web view. Its "Open Project" button opens a standard Win32
  file dialog.
- **Typing into that dialog lost characters.** SendKeys left a modifier down: `C` arrived as Ctrl+C and
  Backspace as Ctrl+Backspace. UI Automation shows the file-name box as a bare Pane with no ValuePattern.
- **What worked:** send `WM_SETTEXT` to the Edit with AutomationId `1148` and class `Edit`, then post
  `WM_COMMAND IDOK` to the dialog. UIA finds the Edit even where it cannot set it: take its
  `NativeWindowHandle`. The dialog is owned by Premiere's main window, one level below the desktop root.
- **To see what Premiere is showing, capture every visible window of the process.** Use `EnumWindows` plus
  `PrintWindow` with `PW_RENDERFULLCONTENT`. The main window alone misses the modal dialogs, and those are
  exactly what blocks the bridge.
- **A copy of `TemplateProjects/en_US/Standard Template Project.prproj` makes a clean empty project.** It
  opens with "Convert Project" and saves as `<name>_1.prproj` in the same folder. After OK, the panel was up
  on 8098 within ~4 s.
- **The AE panel needs no clicks.** "Extensions LLM Chat" (8092) came back by itself with the workspace, and
  AE started with an untitled project.
