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
  - Premiere settles this at a comp's first import, in both directions. Turning the guide audio ON for a comp
    first imported silent, then saving and re-importing it, gave no audio clip and no `.cfa`. A duplicate of
    that comp under a new name, with the guide audio on, got an A2 clip and a `.cfa` at once.
  - `gfxcheck.mjs` caught that duplicate: +6.02 dB under its slot, and +2.06 dB under the full-length logo
    slot above it. `gfxplace.mjs` strips the audio of every clip from the pass's .aep, planned slot or not.
- **Deleting a project item takes a detour.** Move it into a fresh bin with `item.moveBin(tmp)`, then call
  `tmp.deleteBin()`. That removed two duplicate linked items along with the bin; a listing of the parent
  bin confirmed it. For a sequence use `app.project.deleteSequence(seq)` (SKILL.md).
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
- **A cut through a linked clip splits it.** `pr.mjs cut` 0.2–0.6 s ran through the lower third (0.4–4.0 s) and
  the full-length logo. The lower third lost its first 5 frames: the piece left started 5 frames into the
  comp, so the entrance was gone. The logo became two clips, 0–5 and 5–440. `gfxresync.mjs` re-anchored the
  lower third on its marker and re-joined the logo over its pieces. `gfxplace.mjs` then put each back as one
  whole clip. Live, 2026-09-25: every slot moved as predicted, and `gfxcheck.mjs` found every graphic over
  the same source frame as before the cut.
- **After Effects holds the plate open.** The re-render after that cut could not replace `plate.mov`: moving
  it aside gave `EBUSY`. The Windows Restart Manager named the AE window with the graphics project open;
  the headless Dynamic Link AE did not hold it. `prexport.freePath` renders to `plate.b.mov` then, and
  `gfx-build.js` switches the AE item to the file the plan names. After the switch AE held only the new
  file (ae-motion-live quirk 188).

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

`scripts/propen.mjs` puts this together. Live, 2026-09-25:

- **With the panel up it is one call.** `app.openDocument(path, true, true, true)` opened a copy of the
  template project with no "Convert Project" dialog and no `_1` copy. `open` then listed two projects.
  `Project.closeDocument(false, false)` on the second one returned `true`, and focus went back to the first.
- **Closing the last project takes the panel with it.** The bridge call broke off with a closed socket
  (`WS error`), and the Home screen came up.
- **On 26.3 the Home screen is its own window.** It is an untitled top-level window over an empty main
  window. Its class, `DroverLord - Window Class`, is the one Premiere's dialogs have too. propen tells it
  apart by size: at least 90% of the main window's width and 80% of its height.
- **UI Automation does not see the "Open Project" button**, so the click goes by offset: (83, 238) from
  the main window's top-left. Measured on a 2560×1440 screen at 100% scaling, with Premiere maximized.
- **A click lands on whatever is on top of that point.** With Premiere in the background behind another
  app, three offset clicks went into that app instead. Nothing opened, and the other app changed what it
  showed.
  - `uiclick.ps1` now brings Premiere's own window at the point to the front first, with an ALT tap and
    `SetForegroundWindow`.
  - It clicks only if the window under the point then belongs to Premiere. Otherwise it clicks nothing
    and exits 4.
  - `-DryRun` does everything except the click.
- **Timings.**
  - From the Home screen to the panel with the project focused: 16.5 s.
  - With the panel already up: 1 s.
  - From a closed Premiere, which had quit over the bridge after a save (`app.quit()` answers before
    it exits): 17.1 s, `via: launched, Home screen (offset)`. On the way a 300×140
    `DroverLord - Overlay Window` popped up in the corner; propen's filter lets overlays through.
