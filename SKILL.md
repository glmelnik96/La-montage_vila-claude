---
name: premiere-autopilot
description: Use when editing in a live, already-open Adobe Premiere Pro — podcast or interview cuts and vertical reels, syncing cameras to a separate audio recorder, applying reviewer notes and splitting an edit into episodes, laying or replacing a slide deck, interview selects with title cards, a documentary canvas with B-roll and subtitles, After Effects graphics over an edit — or when checking the sound, frames or joins of such an edit.
---

# premiere-autopilot

Claude makes the editorial decisions. The helpers in `scripts/` apply them to the running
Premiere through the LLM-Chat_Pr panel («ИИ: монтаж», CDP port 8098), and check the result
offline with ffmpeg and speech recognition. Each script's header comment documents its flags.

## Before touching anything

1. **Preflight.** Run `node scripts/preflight.mjs`. It reports `ready:true` when the panel
   answers, and that is all an edit needs. The Phygital sidecar and its login matter only for
   paid generation: `preflight.mjs --gen` checks them and reports `genReady`. An expired login
   is renewed by the user (`python -m scripts.cli auth login` in Phygital-Adobe-Studio/sidecar).
2. **Know which project is focused.** Every host helper acts on `app.project`: whichever
   project Premiere has focused, not the one you used a minute ago. `activeSequence` is
   app-wide, while `app.project.sequences` belongs to one project. Another project is focused
   when:
   - an active sequence is missing from the list, or
   - `pr.mjs activate` answers «секвенция не найдена».
   Read `app.project.name` and the active sequence first. If several projects are open, ask
   the user to close the others. Do not work around it in a script.
3. **Know which sequence is active.** A click in Premiere changes it. Pin the target
   (`pr.mjs activate --by-id`) and re-check it right before every long operation. Ask the user
   not to click sequences during a run.
4. **Work in duplicates. Never edit the source sequence.**
   - Run `pr.mjs backup` before the first mutating call and record the `backupId`.
   - `backupActiveSequence` names the *clone* as the backup and refocuses the original. To
     work in a copy, clone it yourself: `seq.clone()`, find the new one by diffing
     `sequenceID`s, rename it, activate it.
5. **A bridge timeout is not a failure.** The edit keeps running inside Premiere, and
   re-issuing a raw call applies it twice. The step scripts (`assemble`, `rearrange`,
   `ripplecut`, `placestills`, `fillmono`) check what is already done, so re-running one
   after the host answers again is safe. See «Host scripting».
6. **Confirm before removing anything.** That covers deleting `_wip`/`_OLD_` sequences,
   restoring a backup over current work, and clearing a bin. None of it is implied by a
   request for an edit. Leave intermediates in place and report them.
7. **Scratch and project notes.**
   - `gen-out/` is gitignored scratch. What you find there comes from other projects: use it
     as evidence, never as method. The one exception is the plan of the project you are
     continuing, which its note in `projects/` points to. Check that it still exists.
   - `projects/` is gitignored and may be absent. It holds one local note per client project.
     Read `projects/INDEX.md`, then only the note of the project in front of you.
8. **Verify on pixels and by ear.** Duration, W×H, `opsOk` and DOM positions are necessary,
   never sufficient. Look at rendered frames, source crops and the timeline panel. Render the
   audio and read it back through speech recognition. See «Rendering and looking».

## Approval
- Take one backup at the start, then run autonomously.
- Stop and ask before paid generation: run `gen.mjs … --dry-run` first and wait for the
  user's yes.
- Stop and ask before anything destructive.
- Roll back with `pr.mjs activate --by-id <backupId>`.
- Never edit the two upstream repos (LLM-Chat_Pr, Phygital). What the panel lacks goes
  through the `evalJson` escape hatch.

## Workflows

### A. Podcast or interview → highlight edit, chapters, reels
1. Preflight, backup. Then clone the source and activate the clone. Run `pr.mjs snapshot`.
2. Get a transcript with `pr.mjs transcribe --seq-id <source id>`. A clone has no transcript
   of its own. If `needsTranscription:true` comes back, the user runs the panel's
   transcription once. For word times, transcribe locally (Workflow E, step 1).
3. Choose the segments of a ~5 min cut:
   - story or insight ~0.35 (a complete thought);
   - emotion or energy ~0.25;
   - quotability ~0.20;
   - clarity ~0.15;
   - novelty ~0.05.
4. Write a `cut` plan of the REMOVED ranges («Payload shapes»).
   - The transcript decides what to keep; the waveform decides where: `audio.mjs check --src
     <media> --in <t> --out <t>`, blade in the middle of a pause.
   - `pr.mjs cut --file plan.json`. On a timeout it polls and never re-issues.
   - Then hear every join and look at a frame just after each kept start.
5. Chapters: 5–10 markers with `pr.mjs markers`, then `markercolors.mjs`. The host ignores
   `color`.
6. Reels: Workflow C.
7. Generative inserts are paid.
   - Write the prompts from `references/prompting.md`.
   - Run `gen.mjs <kind> … --dry-run` and wait for the user's yes.
   - Generate, then insert with `pr.mjs import`/`overlay`.
   - The job id is printed first. An interrupted run is collected with `gen.mjs fetch --job`.
   - A failed generation is reported and skipped.
8. Report the duration, the chapters, the reels, the assets and the `backupId`.

### B. Lecture + its deck → working copy with slides on V2 and review markers
1. Clone the sequence, rename it `<name> [РАБОЧАЯ монтаж]`, and activate it.
2. Get a full transcript.
   - The panel needs In/Out («Задайте In и Out»), and the Out point caps the transcript.
   - Set them over the whole sequence, with `endSec` = the last audio clip's end.
   - Poll with `_poll_cache.mjs <seqId> <maxMin> <minLastEnd>`.
   - Check that `segments[last].endSec` ≈ `endSec`.
3. Map slides to the narration by CONTENT: where the speaker starts each slide's topic. Slide
   N runs to slide N+1's start. Never spread slides evenly. Look at a few slides of every deck
   before trusting its filenames: in one deck of three the filenames named other slides.
4. Markers:
   - GREEN (index 0): section dividers, exactly on the divider slide;
   - RED (1): delete candidates: false starts («заново»), coughs, dead air, repeated
     sentences, self-corrections, «это можно не включать».
5. A clone keeps the source's track count. If V2 is missing, add a track. On 26.3.2
   `seq.videoTracks.addTracks` is undefined; only QE
   `qe.project.getActiveSequence().addTracks(…)` exists. Place on the first empty upper track.
6. Place the slides with `placestills.mjs --bin <deck bin>`. It takes items by exact name
   from that top-level bin. Keep one deck per bin, so slides from other lessons cannot
   collide.
7. Verify:
   - no gaps or overlaps over 0.05 s, the first slide at 0, the last at the end;
   - every section slide sits on its green marker;
   - the frames show the slide that matches what is said.

### C. Flattened multicam master → vertical reels
**REQUIRED:** `references/vertical-reels.md`. The short version:
1. **Find the angles by looking.** `shots.mjs --src <media>` gives one frame per clip.
   Derive each angle's face position `u` as a fraction of SOURCE width, and confirm it with
   `shots.mjs probe`. Never port a classifier or a `u` table from another shoot.
2. **Boundaries come from the waveform.** Use `audio.mjs check`, the middle of a pause, and
   trust `fineDb` (5 ms).
3. **Build in a duplicate** `_wip <reel>`. Ripple-delete outside `[start, end]`, then check
   the surviving source range before any Motion. On a 1200-clip master the delete outlasts
   the bridge: poll.
4. **Compute the reframe with `vframe.mjs`**, never by hand.
   - `scalePct` is not the visible fraction: 88.889 on a 3840-wide source shows 31.6 %.
   - Position is inverted, and values outside 0..1 are legal.
5. **Frame each wide shot on its nearest close-up neighbour** (`vframe.mjs plan`), not on the
   reel's dominant angle.
6. **Verify on pixels:** `checkreframe.mjs --src <media> --seq "<name>"`. Read the image.
7. **Re-read every boundary in context** with `rewin.py`, ±6 s. A reel opens on a sentence
   start and closes on a sentence end.
8. Leave the `_wip` sequences in place and report them.

### D. Screen-shared lecture + PDF deck → one sequence per slide
**REQUIRED:** `references/slide-blocks.md`. The short version:
1. **Track the deck** with `slidetrack.py calibrate`, then `track`. A view must exclude every
   overlay (menu bar, viewer toolbar, «Screen: …» banner), or every geometry scores ≈0.5.
2. **Sweep the scroll offset** with `scrollviews.py` when the viewer scrolls continuously.
3. **Read slides, deck text and transcript together** with `slidealign.py`. Use `trwin.py`
   where no slide is on screen.
4. **Write a block plan**: blocks, dropped ranges, pinned boundaries.
   - Divider slides merge into a neighbour.
   - Q&A about the slide on screen stays.
   - A boundary taken from the transcript gets a `СПОРНО:` marker.
5. **Verify the plan on pixels** with `planverify.py` before cutting.
6. **Snap to pauses** with `snapplan.mjs --thresh <from the level histogram>`.
   - Review every move over ~2 s.
   - A CONFLICT means two edges snapped onto one pause: pin them by hand.
7. **Cut into clones**: `blockcut.mjs --dry-run`, then for real. It skips blocks whose
   sequence exists. Colour the markers with `markercolors.mjs`.
8. **Verify each created sequence:**
   - the collapsed source ranges, the markers, In/Out = `[0, end]`;
   - the sources still have their original duration;
   - `planverify.py`, then `edgecheck.mjs` (a blade inside a word), then `edgetext.mjs` (a
     block opening and closing on a complete thought).

### E. Reviewer notes → corrected edit → episodes
**REQUIRED:** `references/review-to-edit.md`. The short version:
1. **Transcribe locally** with `mixdown.mjs` + `transcribe_local.py` (word times). Never pass
   `--hotwords` on a long recording.
2. **The notes' times are intent only.** Snap every edge into a measured pause (`scan.mjs`,
   threshold from the level histogram) and hear it (`splicecheck.py`) before cutting.
3. **Material the draft left out** («нужно поискать кусок»).
   - Transcribe the unused takes and search them by content, starting with the takes
     recorded next to the gap.
   - An inserted take needs its neighbours' gain and effects («Sound»).
   - Where the long transcript hides a restart, read each speech island alone.
4. **Every track's item list must end up in time order.**
   - A new order: `rearrange.mjs`, then `sequence.clone()` of the result (it keeps effects),
     or `assemble.mjs` when the clips carry no effects.
   - Then `trackorder.mjs`, expected vs actual, and a rendered frame from late in the source.
   - Slides go on with `placestills.mjs`. One range out later: `ripplecut.mjs`.
   - A replaced deck: map old to new slides by text and strip only the old folder's stills.
     Removing a slide exposes the jump cuts under it.
5. **Hear every join again** on the finished sequence, and every episode edge. Transcribe a
   few seconds on each side (which words are present is reliable when their times are not).
   Then look at frames and at the timeline panel.
6. **Episodes:** clone the verified edit per episode and cut each clone down. Set its In/Out,
   recreate its markers, and compare it item for item with its range of the full edit.

### F. Raw interview day → selects per speaker, a question card before each answer
**REQUIRED:** `references/interview-selects.md`. The short version:
1. **Find who is where by looking.** Render frames from a 1 s-per-clip throwaway sequence.
   ffmpeg cannot read BRAW's picture.
2. **Transcribe in the cloud, by phrase,** with `cloudtr.mjs`. The panel's long-file run
   drops whole 30 s windows and has no word times.
3. **Read every speaker end to end and write a plan.**
   - The best complete take per question; pickups where a sentence was re-said.
   - Honour decisions made on set.
   - The card carries the question as it was asked on camera.
4. **Cut inside a phrase** with `cloudsplit.mjs` (the last word must match).
5. **Read every edge back** with `cloudedges.mjs`, plus every rendered join.
6. **Cards** come from `mogrtcard.py`: one .mogrt per card, the text written in before
   `importMGT`.
7. **Build per speaker** from an emptied clone: cards first, then `assemble.mjs`.
   - `importMGT` drops cards now and then: count them, re-import, and re-run
     `assemble.mjs --step place`.
   - Set In/Out to `[0, end]`.
8. **Transcripts of the pieces:** `cloudtr.mjs --pieces` with a names-and-terms prompt,
   every phrase read twice.

### G. Cameras + a separate audio recorder → one synced stack
**REQUIRED:** `references/multicam-sync.md`. The short version:
1. **Extract audio** from every camera clip (scratch) and every recorder take, 16 kHz mono.
2. **Coarse:** a speech-band envelope cross-correlation against every take picks the take and
   the lag.
3. **Timecode prior:** BRAW timecode is time of day. Long, well-correlated clips anchor each
   camera, and short clips are searched only near their predicted offset.
4. **Fine:** GCC-PHAT over 20 s windows, median of the agreeing windows. Report drift; do not
   apply it.
5. **Place on a clone** at frame-rounded absolute positions with `sequence.overwriteClip(item,
   t, vIdx, aIdx)`: camera n on Vn, its scratch audio muted below the recorder tracks.
6. **Prove it by render:** recorder vs each scratch track at several points, lag = the
   rounding. Look at a frame per camera.
7. Content cuts on the synced stack are made at absolute targets on every track («Timeline
   structure»).

### H. Documentary canvas: interview pieces + B-roll + graphics + subtitles
1. **Check the sound before building**, because every clone inherits it: the source clips'
   channels (`astats`) and the sequence master («Sound»).
2. **Plan in code, then watch the plan.** `planpreview.py` renders V1, the B-roll layer, the
   graphics, the audio and burnt-in subtitles in minutes, without Premiere. It is what the
   user approves. Read it for repeats first («Canvas quality»).
3. **Build.**
   - Clone the source and empty it.
   - `assemble.mjs` places the pieces on V1 and the B-roll rows (`tr`) on V2, with A2 muted.
   - `placestills.mjs` places the graphics.
   - Then run `assemble.mjs --step place` again: a still eats the head of the clip after it.
4. **Subtitles** are native captions from `subcues.mjs` («Canvas quality»).
5. **Check:**
   - a contact sheet of every B-roll shot in order;
   - the canvas text for repeated phrases;
   - every piece heard on its own;
   - both channels in a render.
   When only the B-roll changes, clear V2 and re-place it; V1, the markers and the captions
   stay.

### I. After Effects graphics over an edit (with ae-motion-live, returned through Dynamic Link)
**REQUIRED:** `references/gfx-plan.md` has the files, the plan, the placement rules and the
commands. `references/after-effects-link.md` has the Dynamic Link traps. The AE half is
ae-motion-live §5e. The short version:
1. **Open** the project with `node scripts/propen.mjs --project <path.prproj>`. It needs no
   clicks from the user, and it brings Premiere to the front. `gfx-build.js` starts AE itself.
   Work in the edited copy of the sequence.
2. **Hand the edit over:** `gfxexport.mjs --seq-id <id> --dir <project folder>/<sequence>_gfx`
   writes the plate (the edit without graphics), `edit.json` and `words.json`. On a first run it
   also starts `gfx-plan.json`. One folder per sequence: the name rule is in gfx-plan.md.
3. **Plan:** fill in the slots of `gfx-plan.json` by the rules in gfx-plan.md, with an anchor on
   every slot. `gfxplan.mjs validate` must pass. If the sequence already has a pass, change that
   plan; do not start a second one.
4. **Get approval.** This is the default; skip it only when the task says «без согласования».
   Send the chat the table (`gfxplan.mjs table`), plus the sheet and the video from
   `gfxpreview.py`. Wait for «ок» or corrections.
5. **Build in AE:** ae-motion-live `node scripts/gfx-build.js --plan …`. Read `qa/sheet.png` as
   an art director, fix, and run again. It rebuilds in place. When a text overflows, shorten it
   in the plan.
6. **Place and check:**
   - Run `gfxplace.mjs`. It also strips any audio of the .aep's clips.
   - Then run `gfxcheck.mjs`. Every slot must be ok, with the level under each overlay equal to
     the plate's. Read `check_sheet.png`.
   - After a re-edit, run `gfxresync.mjs --dry-run`. If it reports errors, fix
     `gfx-plan.resync.json`. Then run `--apply`, then `gfx-build.js --refresh-plate --no-capture`,
     then this step again.
7. **Write down every error on the way.** Record it in the traps doc of the skill it belongs
   to, give it a guard or a test, and fix the step that misled you. This is the user's
   standing order.

## Rules by topic

### Host scripting (ExtendScript)
- **ES3 only.** None of the following work:
  - arrow functions, `let`/`const`, template literals, destructuring;
  - `Array.prototype.find`/`forEach`/`map`/`filter`/`indexOf` (use `for` loops);
  - reserved words as object keys: `short`, `int`, `char`, `byte`, `long`, `float`,
    `double`, `class`, `enum`, `final`, `native`, `export`, `import`…
  These fail at PARSE time as an opaque `EvalScript error` with no line number, which
  `try/catch` cannot catch. So does a negative number pasted after a minus sign (`x-${v}`
  with v = −400000 gives the decrement `x--400000`). Wrap interpolated numbers in
  parentheses.
- **No backslashes in JSX source.** A Windows path like `'C:\users\…'` breaks the parse (`\u`
  starts a unicode escape). Use forward slashes, and `new File('C:/…').fsName` where a native
  path is required.
- **Timeouts.**
  - `callBridge('evalJson', …)` passes the panel `{mutating:true, timeoutMs}` (default
    120 s). A mutating script that answers `undefined` or `EvalScript error.` is therefore
    never re-run. Before 2026-09-25 the options never reached the panel: the cap was a fixed
    30 s, and such a script ran up to 3 times (verified live).
  - The edit keeps running after a timeout. The panel says «ExtendScript не ответил за …», so
    match `/timeout|не ответил/`.
  - Poll a cheap read until the host answers; ExtendScript is single-threaded, so the edit
    has finished by then. Confirm the state. Never re-issue a raw call. The step scripts
    skip what is done and may be re-run.
  - Keep batches of mutating work small: ~200 removals in one call did not fit in 30 s.
- **Assign whole `Time` objects.** `clip.start.seconds = x` is a silent no-op.
  - Markers are the exception: `marker.start`/`end` take plain seconds (a `Time` is an
    "Illegal Parameter type").
  - Assigning `start` moves the whole marker, so set `start` first, then `end`.
  - The host cannot create span markers; put a duration in the comment.
- **Deleting a sequence.** `projectItem.deleteBin()` is a silent no-op; use
  `app.project.deleteSequence(seq)`. `numSequences` stays stale for the rest of that call, so
  re-read it in a fresh call.
- **The transcript cache is keyed by `sequenceID`**, not by name.
- **Escape hatch.** `callBridge('evalJson', ['<expr returning JSON.stringify(...)>'])` runs any
  JSX in the host; `scripts/_ev.mjs <file>` does it from a file. `scripts/_pev.mjs` runs JS in
  the panel. Details: `references/panel-api-notes.md`.

### Times, in/out points, clones
- **Put every time on the frame grid before any app sees it.**
  - Seconds → ticks rounds DOWN: `setInPoint(261.08)` landed on 261.04, and the piece ate the
    next clip's first frame.
  - An off-grid placement rounds UP: `overwriteClip(item, 6.5)` at 25 fps landed on 6.52.
  - Aim a millisecond into the frame (`assemble.mjs` does, for in, out, end and the
    placement), or give ticks: 254016000000 per second, 10160640000 per 25p frame.
- **Audio-only files are interpreted at 29.97 fps.**
  - A recorder WAV's `projectItem.setInPoint(136.92)` lands on 136.9034: up to a 29.97 frame
    (33 ms) off the cameras on a 25p timeline, with every DOM position still looking right.
  - After `overwriteClip`, set the track item's own `inPoint` and `outPoint` as whole `Time`
    objects in ticks; start and end stay put.
  - Prove it by correlating a render against the plan (0.0 ms on 26 of 26 pieces).
- **Assigning `end` does not trim a clip.** It lengthens the item and leaves `outPoint`.
  - Set `outPoint`, then `end`, and read both back.
  - Stills are trimmed through `end` (`placestills.mjs`).
- **A 30 fps source reports its in-points on its own 1/30 s grid.** Compare with a 0.05 s
  tolerance. That lets a piece one 25p frame off pass: remove it and re-place it.
- **Clones inherit the source's In/Out**, sometimes the unset sentinel −400000. Set every new
  sequence to `[0, end]`, or its export runs hours of black.
- **Rename, do not delete, when re-cutting.** `_OLD_…`, rebuild, verify, then ask before
  deleting.

### Timeline structure
- **`TrackItem.move()` breaks tracks (Premiere 26.3).**
  - It moves only that item, not its linked partner.
  - It does not re-sort the track's item list. After clips move past each other, every DOM
    read is still perfect, but:
    - the panel draws stretches empty;
    - the renderer may drop video;
    - `sequence.end` reports the formerly-last item's end.
  - Detect it with `trackorder.mjs`. Repair it with `sequence.clone()`, which rebuilds the
    lists in time order and keeps effects; rename the broken one `_OLD_…`.
  - Build a reordered edit with `rearrange.mjs`, then clone the result. Or use
    `assemble.mjs`: it places fresh clips and drops effects, so list the clips'
    `components` first.
- **Ripples: check every track afterwards.**
  - Removing a range: on one job the host's ripple delete left tracks that were empty under
    the range unshifted, so later V2 content drifted. On 2026-09-25 (host 2.17.0) `pr.mjs cut`
    shifted empty V2/V3 correctly; the conditions of the first case are unknown (sync lock?).
  - `ripplecut.mjs --seq … --cut a,b` shifts every track itself. It razors every track, trims
    a still spanning the cut, shifts everything after in ascending order, and moves the
    markers and the In/Out.
- **Inserting ripples one track only.** `track.insertClip(item, t)` and
  `sequence.insertClip(item, t, v, a)` moved V1 and the markers, but A1, V2 and V3 stayed
  (26.3.2), leaving sound and graphics out of sync. Push the edit by shifting every track
  yourself, in descending start order, or build the insert into the assembly.
- **A synced multicam stack is cut at absolute targets.** Cameras restart mid-take.
  - Intersect each kept range with every clip on every track.
  - `overwriteClip` the sub-ranges at their new positions.
  - `sequence.overwriteClip(item, t, vIdx, aIdx)` puts picture and scratch audio on any pair
    of tracks; `track.overwriteClip` ties V n to A n.
  - Check that every item's `start − in` equals its source offset.
- **A still placed on a busy track eats the clip after it.** It arrives at the default 5 s
  and is trimmed only afterwards. Place stills, then re-run `assemble.mjs --step place`.
- **Assembling on V2, and phone footage** (`assemble.mjs` rows with `tr`/`sc`/`na`):
  - `videoTracks[1].overwriteClip` puts the audio on A2. Mute A2 for a draft B-roll layer;
    `na` drops the placed clip's audio.
  - Fresh clips arrive at Motion defaults; `assemble` copies the source clip's framing.
  - There is no `setScaleToFrameSize()` on 26.3: `sc` sets Motion › Scale (150 for 1280×720
    on 1080p).
  - `assemble` refuses `--seq` equal to `--src`, and exits 1 when `place` left notes.

### Sound
- **An inserted take must carry its neighbours' clip gain and effects.**
  - Audio Gain lives on the track item. QE `trackItem.staticClipGain` reads it in dB;
    assigning it does nothing.
  - A take placed from the bin came in ~30 dB below neighbours at +30 dB, and no DOM value
    showed it.
  - Read the neighbours' `staticClipGain` and `components`, and copy the effects: QE
    `addAudioEffect`, then the same values.
  - Make up the gain with Volume › Level and Channel Volume › Left/Right: value =
    10^((dB − 15)/20). 1.0 is +15 dB, the maximum, and 0 dB is 0.17782794. The two together
    give +30 dB. Set them with `component.properties[k].setValue(v, true)` and read them back.
  - Compare the insert's speech median with its neighbours' in a render.
- **One-sided sound, cause 1: a Multichannel master.**
  - `getSettings()` shows `audioChannelType` 3 and `audioChannelCount` 4, and the tracks are
    named «Output 1…4».
  - Set type 1 and count 2 via `setSettings()`. The tracks become «Audio 1…4»; nothing else
    moves.
  - Clones inherit it. Fix the source too, with the user's OK if it is theirs.
- **Cause 2: the voice on one channel.**
  - `ffmpeg -i clip -af astats -f null -` shows ≈ −65 dB against −20 dB on the other channel.
  - Fix it with `fillmono.mjs --seq … --from right --match .MOV`. No API removes the effect;
    a double copy is harmless.
  - QE serves a cached track item list, so «does this clip have the effect yet» reads stale.
    Drive such loops by an index window.
  - A mono downmix (`-ac 1`) hides the problem and costs 6 dB. `mixdown.mjs` takes a `ch`
    per clip.
- **Prove the sound by rendering it** («Rendering and looking»). Both channels at the same
  RMS prove a one-sided fix; the speech median proves a gain match.

### Transcription and cut points
- **Transcript = WHAT; waveform = WHERE.** Whisper times drift up to ~1 s: word starts after
  a pause come early, word ends come late.
  - Put the blade in the middle of a measured pause, at least 0.08 s from speech on both
    sides.
  - `audio.mjs check` decides on `fineDb` (5 ms). `audio.mjs snap` and `snapplan` prefer the
    LONGEST pause within ±6 s, which near a sentence end is often the wrong one: review every
    move.
- **A level check does not prove a word is intact.** With two mics the floor rises to −60 dB
  and a stop consonant reads as a pause («возни|кнут»). A dip inside «mu|sic» made whisper
  hear «movies». So:
  - hear every join with `splicecheck.py` before cutting, and again on a mixdown of the built
    sequence;
  - where the edit has empty windows, transcribe each piece alone.
- **Which transcriber:**
  - `transcribe_local.py`: faster-whisper `large-v3` with word times. `--device cpu` when
    another program holds the GPU. Never `--hotwords` on a long file.
  - `cloudtr.mjs`: Cloud.ru Whisper by phrase. No word times; the chunk edges are measured
    pauses. Failures are loud: `error` and exit 1, never empty text.
  - The panel's cloud transcription TRANSLATES English and Hindi into fluent Russian. Good
    for reading a film's story, useless for blades.
  - Mixed-language interviews: `transcribe_mixed.py` picks the language per voice chunk.
  - `rewin.py` re-reads a window on the CPU (Russian, `medium` by default; model as 4th
    argument).
- **Whisper folds things away:**
  - a filler inside the next word's time («okay» inside «and»);
  - a restart («ERP, 1С, … ERP, 1С, SAP» came out as one list with a 4 s hole);
  - a stumble inside a mega-segment over 8 s.
  Where the level map shows speech that no word covers, read that island alone.
- **Re-read every boundary in context** (`rewin.py`, ±6 s). Open on a sentence start, close
  on a sentence end. A blade in a clean pause can still be in the wrong pause.

### Rendering and looking
- **Rendering from a script:** `sequence.exportAsMediaDirect(dest, preset, range)`.
  - It works only on the ACTIVE sequence with native paths (`new File(p).fsName`); otherwise
    it returns "Unknown Error". Success returns "No Error".
  - `app.encoder.ENCODE_ENTIRE` renders the whole sequence without touching its In/Out;
    `ENCODE_IN_TO_OUT` renders the In/Out range.
  - Presets are under `C:/Program Files/Adobe/Adobe Premiere Pro 2026/MediaIO/systempresets/`:
    - `3F3F3F3F_41494646/AIFF 48kHz.epr` for audio (then `astats`);
    - `3F3F3F3F_4A504547/JPEG Sequence (Match Source).epr` for frames. It appends a `0` to
      the name.
  - The bridge may give up while the render runs: wait for the file to stop growing.
  - Put In/Out and mute changes on a throwaway clone and `deleteSequence` it afterwards.
- **A frame.**
  - At any time: a one-frame In/Out (1/fps long) rendered with the JPEG preset.
  - QE `exportFramePNG(tc, new File(p).fsName)` is quicker. Past one hour it returns a frame
    from the head of the sequence; it appends `.png`.
  - The DOM `Sequence` has no `exportFramePNG`/`exportFrameJPEG`.
  - **A clone hides a broken track:** it rebuilds the item lists. Checking a rearranged
    sequence starts with `trackorder.mjs` on the original.
- **Watch the plan before building it.** `planpreview.py --layout … --plan … [--cards …
  --srt …] --out preview.mp4` works without Premiere. It letterboxes a still that does not
  fill the frame, where Premiere shows the track underneath: check such moments on a real
  frame.
- **The timeline panel is evidence too.** `prwindow.ps1` captures the Premiere window. When
  the user describes the timeline, capture it and run `trackorder.mjs` before explaining.
- **After a big rearrange** the first export may render a BRAW layer black. Render the frame
  again and compare decoded pixels.
- **Compare frames by decoded pixels** (`ffmpeg -f rawvideo … | md5sum`), not by PNG bytes.

### Canvas quality
- **B-roll variety is about places and subjects, not clip ids.**
  - A layer that used every clip once still read as repetition: four shots of one entrance,
    three of one desk.
  - Group the material by place or subject. Neighbours never come from the same group, and a
    stretch holds at most two of a group. Alternate wide, detail and people.
  - Check a contact sheet: one labelled frame per shot, in order.
  - Use each clip once, and a vlog once per moment, never under one of its own inserts.
  - A gap flashes the face. When a list runs out, let the face show.
- **Read the canvas for repeats before handing it over.** Print every piece's words in order
  and list the 4-word phrases that two pieces share. Keep one ending, one self-introduction,
  and one telling of each story.
- **Subtitles are native captions, never rendered cards.** The user edits them in Premiere.
  - Build the SRT with `subcues.mjs`.
  - Import it, then `seq.createCaptionTrack(item, 0, Sequence.CAPTION_FORMAT_SUBTITLE)`.
  - `captionTracks` is not exposed; QE frames show the captions.
  - Font and plate are set in Track Style.

## Payload shapes (`pr.mjs`, host `_EXT_PRM_` 2.16–2.17)
Payloads go in with `--file <payload.json>` or `--json '<payload>'`.
- `cut`: `{ "ops": [ { "startSec", "endSec", "mode": "ripple" | "lift" } ] }` in ORIGINAL
  coordinates.
  - It is sent as `ripple_delete_range`/`lift_delete_range` in descending `startSec`.
  - It refuses overlapping, out-of-bounds or negative ranges, and a plan that keeps less than
    `--min-keep-sec` (2 s). `--force` overrides.
  - A high `removedRatio` is normal for a highlight cut; check the resulting duration instead.
- `markers`: `[ { "timeSec", "name", "comment", "color" } ]`.
  - The key is `timeSec`; a row without it is skipped silently.
  - `color` is ignored: run `markercolors.mjs --file … --seq …`.
- `reframe`: `{ "newName", "targetW":1080, "targetH":1920, "expectedSequenceName", "items":
  [ { "trackIndex", "clipIndex", "scalePct", "posX", "posY" } ] }`.
  - It CLONES the active sequence into a vertical one.
  - `scalePct` 100 is native size; filling the height is `1920/srcH·100`.
  - `posX`/`posY` 0.5 is centred, and inverted.
  - Take the indices from `reframe-sources`, build the items with `vframe.mjs`, and trim with
    `cut` afterwards.
- `import`: `{ "path", "binName" }`.
- `overlay`: `{ "filePath", "expectedSequenceName", "startSec" }`. The first two are
  required.

## Workflow A checklist
- [ ] preflight `ready:true`; backup `backupId` recorded; working in a clone
- [ ] highlight cut applied, duration ≈ target, every join heard
- [ ] chapters on the timeline, in colour
- [ ] 3–5 reels; crops checked on pixels (`checkreframe.mjs`); boundaries re-read in context
- [ ] generated assets only after the user's yes
- [ ] rollback verified: activating `backupId` restores the original
- [ ] intermediates still present and reported, not deleted on your own initiative
