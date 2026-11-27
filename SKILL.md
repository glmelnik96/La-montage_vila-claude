---
name: premiere-autopilot
description: Edit and verify video in Premiere Pro. Use for multicamera podcasts, interview selects, reels, courses and screencasts, documentary and event films, editing generated takes or gameplay captures, graphics from After Effects, review notes and Resolve round-trips. Supports offline checks of exports and profiling the edit rhythm and titles of a series.
---

# premiere-autopilot

Claude makes the editorial decisions. The helpers in `scripts/` apply them to the running
Premiere through the LLM-Chat_Pr panel («ИИ: монтаж», CDP port 8098), and check the result
offline with ffmpeg and speech recognition. Each script's header comment documents its flags.

## Choose the editorial workflow

| Starting material and deliverable | Route and editorial check |
|---|---|
| Podcast or interview recordings → episode, selects or vertical clips | G for camera/recorder sync; F for takes and pickups; A for the episode and C for reframing. Listen across joins, preserve complete thoughts, and check both speakers at angle changes. |
| Lecture, deck or screencast → course modules or product walkthrough | B/D for slide and screen changes; E for review and episodes. Match each change to what is being explained and read the UI at delivery size. |
| Documentary, event or promo → story edit and graded master | H for interviews, B-roll and archive; I for AE shots; J for a Resolve return. Check source ranges, framing, dialogue, music, transitions and retimes against the chosen edit. |
| More episodes of the same series → an edit in the established style | Build a [rhythm and titles profile](references/series-profile.md) from completed episodes. Check its ranges on a separate episode and identify which timings follow the new speaker. For a recurring graphic, pass the approved scene, replacement copy and the new edit cue to the series adaptation route in `ae-motion-live`. |
| Storyboard, generated takes or gameplay capture → cinematic, trailer or social cut | For newly generated shots, develop the board and references with `ae-motion-live` and use [the generation brief](references/prompting.md). Place the selected take and its usable interval on the edit. For gameplay, [check each delivery crop](references/gameplay-review.md). Follow the action and its result, then watch the four frame edges as the crop moves between marks. Check partial HUD, text and clipped subjects at delivery size. Use I for compositing or titles and E for re-edits. |

For a mixed piece, choose the route per sequence or scene. A course can use interview sound, captured UI and an animated explanation in the same edit. For an offline brief or check, start with the supplied files. Run the Premiere preflight when the task calls for a live timeline.

**Working from media files.** For a flat reference, use [video reference analysis](references/video-reference.md) to locate hard cuts and changes inside a selected picture region. To check two exports against the same edit, use [version review](references/version-review.md) for visual differences, the timing of a title or button, and the offset of a shared soundtrack. Use the same tools on footage from Premiere, AE, a renderer or a game engine. If there is an actual sequence snapshot and the question is about source clips or repeated footage, use the editorial map in Workflow H.

For a local animation change, pass each reading hold from the brief to `version_review.py` with `--hold START:END` (end excluded). Compare the same frame across exports to check the revision, then inspect motion within the hold and confirm the position of fixed lettering at native resolution.

After changing a storyboard or artboard, use [resize review](references/resize-review.md) to find dependent deliverables and inspect both transitions around the changed state. For a looping export, use [loop review](references/loop-review.md) to inspect the last frames followed by the first and check any joins introduced by segmented rendering.

## Before touching anything

1. **Live edit preflight.** Run `node scripts/preflight.mjs`. When the panel answers,
   `ready:true` is sufficient to edit. The optional `--gen` probes the legacy sidecar.
   For new generated assets use the provider workflow in `ae-motion-live` §6.
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
- Before paid generation, show the model, settings and expected cost and get the user's approval.
- Stop and ask before anything destructive.
- Roll back with `pr.mjs activate --by-id <backupId>`.
- Never edit the two upstream repos (LLM-Chat_Pr, Phygital). What the panel lacks goes
  through the `evalJson` escape hatch.

## Project cleanup, when explicitly requested

- Build the transitive dependency closure from the working sequences and any selects the
  user is keeping. Inspect every video/audio track, including disabled clips and reserve
  material beyond Out; unused by the current In/Out is not the same as unreferenced.
- Save a standalone `.prproj` backup outside the live project's bins. A backup sequence
  inside the project does not preserve items removed from the project. Organize with
  `ProjectItem.moveBin`; do not move physical media or AE asset folders to tidy bins.
- Before `deleteSequence`/`deleteBin`, validate the approved node-ID manifest against a
  fresh inventory and reject unexpected descendants or retained references. Afterwards,
  compare retained timelines and media node/path pairs, then inspect the Project panel.
  Bin organization was verified to preserve these identities in Premiere 26.5.2.

## Workflows

### A. Podcast or interview → episode, highlight edit, chapters or reels
1. Preflight, backup. Then clone the source and activate the clone. Run `pr.mjs snapshot`.
2. Get a transcript with `pr.mjs transcribe --seq-id <source id>`. A clone has no transcript
   of its own. If `needsTranscription:true` comes back, the user runs the panel's
   transcription once. For word times, transcribe locally (Workflow E, step 1).
3. For a full episode, keep the requested duration, conversation arc and necessary context.
   Identify pickups, repeated takes and agreed removals. For a highlight cut, select complete
   segments to the requested length (for example, five minutes) using these editorial weights:
   - story or insight ~0.35 (a complete thought);
   - emotion or energy ~0.25;
   - quotability ~0.20;
   - clarity ~0.15;
   - novelty ~0.05.
4. Write a `cut` plan of the REMOVED ranges («Payload shapes»).
   - Use `audio.mjs check --src <media> --in <t> --out <t>` to place the cut in a pause.
     For a file-based quote, pass the snapped IN/OUT pairs and timed words to
     `scripts/utterance.mjs` as described in [vertical reels, step 2](references/vertical-reels.md).
     Read the last kept words together with the next words in the source.
     Check what the first pronoun refers to and whether removing a middle passage changes
     the claim. If an unfinished clause continues after the pause, move the boundary and
     check the audio again.
   - `pr.mjs cut --file plan.json`. On a timeout it polls and never re-issues.
   - Then hear every join and look at a frame just after each kept start.
5. For requested chapters, mark topic changes with `pr.mjs markers`, then `markercolors.mjs`. The host ignores
   `color`.
6. For requested reels, use Workflow C.
7. Generative inserts are paid.
   - Write the prompts from `references/prompting.md`.
   - Use the current provider schema and approval step in `ae-motion-live` §6. Save the job ID and selected file.
   - Import the chosen take with `pr.mjs import`/`overlay`, or pass it to AE for compositing first.
   - If the take fails, mark its slot as missing in the edit plan. An existing legacy sidecar job can be recovered with `gen.mjs fetch --job`.
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
7. **Re-read every boundary in context** with `rewin.py`, ±6 s. Check the retained sentence
   across each internal join. At the final OUT, verify that the speaker has finished the
   thought, including any qualification that follows the pause.
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
   - Slides go on with `placestills.mjs`. One range out later: `ripplecut.mjs`. Gaps in
     (cards before blocks): `rippleinsert.mjs`.
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
**REQUIRED:** `references/multicam-sync.md`.
For a new batch, run `python scripts/podcastsync.py manifest.json --out sync-review` from this skill.
Review each clip's proposed recorder take, offset, drift and evidence before placing it.
The report is an offline proposal. The following procedure describes the original recorder job,
including how to investigate unresolved clips and verify their placement in Premiere.
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
**Read an existing cut offline.** From the skill root, run the picture map on a saved
`seqdump`. Select the sequence by ID or exact unique name. Use a fresh output directory.

```sh
node scripts/docmap.mjs --snapshot dump.json --sequence "Interview edit" --picture-tracks 1-2 --interview-tracks 1-2 --out review/interview-map
```

For a documentary with the interview on V1, inserts on V2–V3 and full-screen slates above:

```sh
node scripts/docmap.mjs --snapshot inventory.json --metadata seqdump.json --sequence "Portrait edit" --picture-tracks 1-3 --include-name "^SLATE_" --card-name "^SLATE_" --interview-tracks 1 --broll-tracks 2-3 --out review/portrait-map
```

- Read `report.md` to follow the camera cuts, source In/Out, repeat pairs and timed notes.
  `map.json` contains all ranges, placements inside nests, coverage flags and notes by ID.
  Edit intervals are half-open in whole sequence frames. Source edges are in seconds.
  Gaps and unresolved items retain their own timeline ranges. The map uses the saved frame
  rate and sequence In/Out. It reports any fallback to the extent of the sequence.
- Choose the picture tracks and roles from the edit. Track numbers in the command start at 1.
  Picture filters apply to the selected sequence. Nested clips follow their own track stack.
  With no filters all enabled video layers participate. Roles stay unknown until assigned.
  `--exclude-name` filters matching clip names, `--include-name` admits extra picture
  layers, and `--interview-name` can qualify interview shots by their resolved label.
  This also works for interviews with no B-roll. See `node scripts/docmap.mjs --help`.
- An older flat inventory of saved sequences may need a matching `--metadata` seqdump for
  the frame duration and In/Out. Optional `--saved-project backup.prproj` reads additional
  clip timing and disable flags from a matching local saved project with Python 3.
  Missing track state, unidentified nests, retiming curves, masks and transitions limit
  what the structural map can establish. Check affected windows on a timeline render.
- Add `--reference path/to/shots.json` for an independent comparison against a saved shot
  list and links to its numbered source JPGs. The map compares source frame centres with the
  old list and distinguishes stills and retime mismatches. The same source path can have
  multiple disjoint uses. Even a single overlapping source frame counts as an overlap.
- Sequence markers join automatically. To attach existing dialogue or editorial notes, pass
  `--notes notes.json` with `{"sequenceId":"<exact ID>","entries":[{"type":"quote","startFrame":40,"endFrame":75,"text":"<verbatim text>","source":"<transcript and cue>"}]}`.
  Use edit-frame coordinates for this sequence version. Supply `speaker` and `language` when
  documented. Use `type:"note"` for editorial comments. A point attaches to the containing
  frame, a span to every intersecting range. Keep the original attribution in `source`.
- To find unused archive, provide the source catalogue with stable media identities,
  durations/timebases, keyframes, timecoded descriptions and evidence for the event depicted.
  Subtract existing uses and inspect candidate frames before proposing a match to dialogue.

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

### J. Grading in DaVinci: the edit's video out, the graded video back in
**REQUIRED:** `references/grade-roundtrip.md`. The short version:
1. **Dump the episodes** with `seqdump.mjs`. Check that V1 carries default Motion and no
   effects: a punch-in would be baked into the grade.
2. **Build the grading timeline and its XML** with `gradexml.mjs`: V1 pieces only, no stills,
   no audio, a marker per episode.
   - `--mode visible` keeps only what no full-frame still covers. That was 0.9 of 24.7 min on
     one course.
   - `--mode all` keeps every piece.
   - A camera on several tracks, or a UHD camera in a 1080p edit: `--tracks 1,2 --media "\.braw$"
     --pack 1 --source-size --copy-markers` (`references/grade-roundtrip.md`, section 2).
   - Speed changes, reverses and ramps: every piece at 100 % over the source it shows. Add
     `--fps <camera rate>` and `--size-from`. Read ramps off a render (`--ranges`).
   - An anamorphic override comes out as Scale 133 plus Distort: run `gradexmlfix.py` on
     Premiere's export.
   - Then check the XML against the plan with `gradexmlcheck.py`.
3. **The user renders Individual clips.** File names must carry the source name and the source
   timecode in frames. If they render the grading timeline as ONE file instead, pass it as
   `--single`: its black gaps must fall on the plan's gaps.
4. **Snap the episodes to the frame grid first** with `gridfix.mjs --fix`, then run
   `gradesub.mjs`:
   - match every render by source + timecode, and check its frame count;
   - make backups;
   - place the video only (the render's own audio goes to an empty track and is removed), each
     piece on its own track;
   - copy each old item's Motion and effects onto its render (`fx`, `props`), for an edit that
     scales or crops the camera;
   - check every track against the snapshot.
   - **An edit with speed, reverse, ramps, rotation or dissolves:** match the renders by picture
     (`gradematch.py`), then `gradeplace.mjs`. Speeds stay live: QE `setSpeed`, and the user's own Time
     Remapping keys through the project file (`gradeconform.py` + `prprojremap.py`, with their OK to close the
     project). Never bake a ramp. Override a Gamma 2.2-tagged render to its camera's colour space.
     `references/grade-roundtrip.md`, section 4b.
5. **Look at the retouched spots with the shadows ×3.** Retouch remnants 1–3 % above black are
   hidden by Premiere's viewer and shown by players. Fix them in place: `references/grade-roundtrip.md`,
   section 6.
6. **Verify on code values:** `tlexport.mjs` (a Rec.709 H.264 export) and `gradeverify.py`.
   Each frame must match its own frame of the render (Y difference ≈0.3) better than both
   neighbours. Do not compare JPEG exports: they carry a Rec.709→sRGB conversion.

## Rules by topic

### Host scripting (ExtendScript)
- **ES3 only.** None of the following work:
  - arrow functions, `let`/`const`, template literals, destructuring;
  - `Array.prototype.find`/`forEach`/`map`/`filter`/`indexOf` (use `for` loops);
  - reserved words as object keys or variable names: `short`, `int`, `char`, `byte`, `long`,
    `float`, `double`, `class`, `enum`, `final`, `native`, `export`, `import`, `in`… (`var short=[]`
    killed a whole step on 2026-10-08, `{in: …}` another on 2026-10-09)
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
  - **Moves must be built in ticks too.** Before 2026-09-28, `ripplecut.mjs` moved items by a
    seconds delta, and every item after a cut landed 1 tick (≈4 ns) past the grid.
    - No DOM read shows it.
    - The frame at such an edge shows the previous item: a slide switch came one frame late.
    - When the graded video was later overwritten on the grid, 1-tick slivers of the old clips
      were left behind.
    - `ripplecut` now moves to absolute targets in ticks. `gridfix.mjs` lists such edges; with
      `--fix` it snaps them and removes the slivers. Run it after any scripted move, and before
      laying material over an edit.
- **Audio-only files are interpreted at 29.97 fps.**
  - A recorder WAV's `projectItem.setInPoint(136.92)` lands on 136.9034: up to a 29.97 frame
    (33 ms) off the cameras on a 25p timeline, with every DOM position still looking right.
  - After `overwriteClip`, set the track item's own `inPoint` and `outPoint` as whole `Time`
    objects in ticks; start and end stay put.
  - Prove it by correlating a render against the plan (0.0 ms on 26 of 26 pieces).
- **Assigning `end` does not trim a clip.** It lengthens the item and leaves `outPoint`.
  - Set `outPoint`, then `end`, and read both back.
  - Stills are trimmed through `end` (`placestills.mjs`).
- **An out point past the end of the media is accepted without a word.** A 1.1 s clip laid into a
  3 s slot read back `outPoint` 3.0 and `end` as asked; past 1.1 s the frame is empty and the track
  below shows through (2026-10-09). Check `src_in + length ≤ media duration` in the plan.
- **A 30 fps source reports its in-points on its own 1/30 s grid.** Compare with a 0.05 s
  tolerance. That lets a piece one 25p frame off pass: remove it and re-place it.
- **The in/out of a speed-changed clip are not source times** (Premiere 26.5, proved on pixels on
  2026-10-28). They run in the clip's stretched time, so `out − in` equals the timeline length:
  - the source shown is `in·speed .. out·speed` (`getSpeed()`: 0.5 for 50 %);
  - a reversed clip (`isSpeedReversed()`) is mirrored from the media's end: the first frame shown
    is `D − in·speed − 1 edit frame`, the last `D − out·speed − (1 − speed)·frame`;
  - a clip at 1 % read `in` 3560 s in a 66 s phone file: the source is 35.6 s.
- **Time Remapping is invisible to the DOM.** A speed ramp reports `getSpeed()` 1 and plain
  in/out, and its components list only Opacity and Motion. Three clips of 71 had it. The tells: a
  range past the media's end (`in` 16.72 s in a 13.92 s file), or frames that do not follow the
  formula. Read the truth off a render: match every frame to the source.
- **A display-matrix rotation is honoured by Premiere and Resolve alike, and by ffmpeg's autorotate.** A GH6 file
  flagged `rotation=90` (written during a spin) showed portrait. The editor had turned it back with Motion
  › Rotation 90 (and Scale Width 52.73). Resolve rendered it portrait too, 2160×4096. The render takes the
  clip's own Motion and needs no extra turn: a second +90 on top gave 180 (2026-10-28). For frame matching,
  decode the source with `-noautorotate` and transpose the render back.
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
  (26.3.2), leaving sound and graphics out of sync. Open gaps with `rippleinsert.mjs --at
  t:d,… --extend <music tracks>` (cards before blocks), or build the insert into the assembly.
  It moves every track in descending start order, grows stills, adjustment layers and the music
  through the gap, and moves the transitions. Details: `references/review-to-edit.md` §5b.
- **`TrackItem.move()` leaves the clip's transitions behind.** They live in `track.transitions`
  and move with their own `move(Time delta)`. A fade left behind is not harmless: a dialogue clip
  with an Enhance Speech pre-render and a Custom Fade played its source 14.88 s early after the
  move, while its DOM `inPoint` still read right (2026-10-08). `ripplecut` and `rippleinsert`
  now move transitions; any other scripted move must too. Re-writing `inPoint` did not cure it;
  moving the fade did.
- **Nested sequences are shared between sequences.** Editing a nest's content in a copy edits the
  original too: replace or move the instances instead. `sequence.overwriteClip(nest, t, v, a)`
  put the nest's own (silent) audio on a NEW audio track, not on track `a`: remove it.
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
  - **The channel can change from clip to clip within one shoot.** Measure every clip and give
    each piece the Fill of its own channel; one `--from` for the whole shoot silences half of it.
  - QE serves a cached track item list, so «does this clip have the effect yet» reads stale.
    Drive such loops by an index window.
  - A mono downmix (`-ac 1`) hides the problem and costs 6 dB. `mixdown.mjs` takes a `ch`
    per clip.
- **Prove the sound by rendering it** («Rendering and looking»). Both channels at the same
  RMS prove a one-sided fix; the speech median proves a gain match.
- **Matching voices from different phones:** measure each piece's speech level in a render (the
  50 ms frames within 25 dB of its loudest) and set clip gain to one target (−22 dB worked),
  capped so the piece's peak stays under −1 dBFS. Where a source peak is already at 0 dBFS (a clipped
  plosive), QE `addAudioEffect('Hard Limiter')` with its defaults plus the full gain gave a
  −0.1 dBFS peak in the render (2026-10-16). Its parameters read back normalized (Input Boost 0.667),
  so leave them alone.
- **After a ripple, compare the render with the original in EVERY window.** Map each 2 s window
  of the old render through the plan's shift and correlate. A check that skipped the windows
  next to the edits missed every fade left behind; one solo-track render (clone, mute the rest)
  then shows which clip plays what.
- **Remix music can be lengthened by script.** `outPoint` + `end` on a Remix piece continues the
  remix: the old part stayed bit-identical and the new tail was the remix's own continuation
  (2026-10-08). The Remix data lives in `<RemixClip>` of the prproj; its in/out are remix time.
- **A voice chain by script.** QE `addAudioEffect` appends to the end of the clip's chain; the DOM
  reads the parameters normalized 0–1. Calibrated on renders (2026-10-27):
  - Amplify › Gain: dB = 144·v − 96 (0.667 is 0 dB). It goes past +15 dB, which Volume cannot.
  - Highpass › Cutoff ≈ 32000·v² Hz. **Its default 0.25 is about 2 kHz**: always set it (0.053 ≈ 90 Hz).
  - Hard Limiter › Maximum Amplitude: dB = 100·(v − 1). Single-band Compressor › Gain: dB = 60·(v − 0.5);
    Threshold v = 1 + dB/60; Ratio 0.069 compressed speech frames about 2–2.5:1.
  - To put a stage before a limiter that is already there, bypass it (`properties[0]` = true) and
    append the stage and a new limiter.
  - A mono clip (a lav WAV) on a stereo track plays 3 dB down per channel. Its levels and its
    limiter ceiling before the panner sit 3 dB higher than a stereo clip's.
  - Each clip under its own limiter can still clip in the sum: no script reaches the master
    track. Find the overs in a render (samples above 0.95) and fix the clips that meet there.
- **A chain copied from another clip carries that clip's Amplify.** Amplify is per take (target − the
  take's speech level), so it is not part of the chain. A studio clip's +24.1 dB, pasted onto the
  open-space pieces, left them 3–4 dB under the studio (2026-10-27). After a paste, set Amplify per
  piece by the rule, then measure the render.
- **Measure a short piece on its speech only.** Take the momentary loudness of the frames inside its
  speech intervals. «Within 15 dB of the loudest» read a 1.8 s piece holding 0.5 s of speech 4 dB low.
- **Lift soft words with keys, not the whole piece.** Raising the piece raises its room tone, which then
  steps at every cut. Amplify keys on the words alone (60 ms in, 80 ms out) lifted a spoken list by
  3 dB with no step.
- **Check lip sync wherever a camera's own sound is under its picture.** The two in-points of one file
  must agree at the same timeline time. A camera piece placed by hand came in one frame late (40 ms).
- **Ducking music under the voice.**
  - **Look at a ducking that is already there before keeping it.** Compare its keys with the starts on
    A1 and on the effects tracks. A user's auto-ducking dipped the music under every SFX plate and
    stayed up under speech: the voice clips were not the type it ducked against (2026-10-27).
  - **Find speech in the sources of the A1 pieces, not at clip edges.** Pieces hold pauses, and lapses
    hold none. Use 10 ms frames above the piece's floor + 9 dB (or its loudest − 30 dB) and merge
    gaps under 0.35 s.
  - What worked on a course:
    - the bed under speech ~23 dB under the voice (median);
    - +9 dB in pauses of 2.5 s and more, +5 dB in pauses of 1.6–2.5 s;
    - up over 0.6 s, from 0.2 s after a phrase; down over 0.45 s, ending 0.1 s before the next one;
    - a sting under a title kept at full level, down to the bed before the first word, and up again
      after the last word for the logo.
  - **Amplify has a slider per channel:** Left, Right and 31 unnamed (`properties[3…35]`). A mono voice
    uses Left. On music, key every slider: the auto-ducking had keyed them all.
  - Amplify keys interpolate in dB. Volume › Level keys interpolate the amplitude.
  - The music's own momentary loudness plus its clip keys predicted the render within 0.1 dB
    (median) wherever only music played. Check the plan this way before rendering.

### Transcription and cut points
- **A read-back of a whole piece hides restarts and fillers.** It merged a false start
  («Для того чтобы Дора могла работать… Для того чтобы Дора могла работать с…») into one
  sentence, and it dropped «да-да-да» at the head of a take (2026-10-27, both caught by the
  user). Read every piece back island by island (split at pauses over 0.35 s, each island
  alone), and look hardest at the first island of each piece.
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
  - a restart, leaving a gap inside an apparently continuous phrase;
  - a stumble inside a mega-segment over 8 s.
  Where the level map shows speech that no word covers, read that island alone.
- **Whisper invents text on music and on short noises:** «Субтитры сделал DimaTorzok»,
  «Продолжение следует…», «Спасибо.», «Драм-ролл». Treat such a line as no speech.
- **Read a planned cut back piece by piece.** Read each piece's audio ALONE, with silence around
  it. Reading the whole planned track and hanging the words on pieces by time moved a word across
  almost every blade: a piece looked clipped while the word sat in its neighbour, and a clipped
  piece looked whole.
  - Read without an initial prompt. A prompted name can be hallucinated near a breath. Compare
    the isolated piece with the waveform when the full-track transcript invents a phrase at a cut.
- **Two people in one clip: who says what.** Per word, the median pitch splits a man (90–145 Hz)
  from a woman (180–280 Hz). For two men, compare the frame difference inside each mouth box per
  phrase: the speaker's mouth moves 3–4×, the listener's under 1.
- **Listen to both sides of every edited dialogue boundary.** Before cutting, hear the
  source in context and identify the intended take, including the first and last words
  of the complete thought. After cutting, listen across each join in the actual sequence
  or its audio export. Check that every intended word is intact and that discarded takes,
  stray replies, and repeats are gone. Use `rewin.py` (±6 s) and the waveform to locate the
  edge. If you hear an incomplete or unwanted line, adjust the cut and listen again before
  delivery.

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
    - **A deliverable MP4:** `4E49434B_48323634/01 - Match Source - High bitrate.epr` (H.264,
      the sequence's size and rate, ~19 Mbit/s). The «H264 Match Source - High bitrate» under
      `3F3F3F3F_4D6F6F56/` is QuickTime and writes a .mov.
  - The bridge may give up while the render runs: wait for the file to stop growing.
  - Put In/Out and mute changes on a throwaway clone and `deleteSequence` it afterwards.
- **A frame.**
  - At any time: a one-frame In/Out (1/fps long) rendered with the JPEG preset.
  - QE `exportFramePNG(tc, new File(p).fsName)` is quicker. Past one hour it returns a frame
    from the head of the sequence; it appends `.png`. Keep it to a few frames per call: 18 frames
    of 50p H.264 in one call outlasted the bridge, and Premiere then crashed mid-write, leaving a
    truncated PNG (2026-10-09). Save the project before a long frame or render run.
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
- **A rendered graphics clip (end card, title) for Premiere:**
  - ffmpeg converts RGB→YUV with BT.601 by default. Pass `-vf scale=out_color_matrix=bt709:out_range=tv`
    and tag the stream bt709, or Premiere shifts the colours.
  - Add about one level of grain to a soft gradient: 8-bit H.264 bands without it.
  - Render it longer than the slot, with a hold and no outro, so the editor can stretch it.
  - Wipe reveals («шторки») are per-column masks: a feathered moving edge, motion blur by averaging
    6 sub-frame samples. Ask whether the user wants visible bars or only the moving edge.
- **A JPEG export is not the timeline's code values.** Premiere converts Rec.709 to sRGB for
  it: against the file's own decode, shadows and mids come out darker (7→3, 42→33, 111→105),
  and highlights stay put. To compare the timeline with a video file, export Rec.709 video
  (`tlexport.mjs`, «H264 Match Source - High bitrate» in `3F3F3F3F_4D6F6F56/`) and compare the
  Y planes.

### Canvas quality
- **Motion scales a MOGRT about the frame's centre**, so a plate that hugs a corner drifts away from
  it as it grows. To grow it in place, keep the corner fixed:
  `Position = corner − s·(corner − centre)` (frame pixels, then normalised).
  - On 2026-10-27 a user set one plate to 126 % and moved its Position x so the left edge went from
    52 to 96 px. The rest went to 125 % by the same rule.
  - The exceptions: plates inside a split layout's speaker window grew from their own lower left
    corner, so they stayed in the window (the rule would have hung them 60–80 px below it). The
    lower third grew from its own corner, or it would have reached y 1035.
  - Measure each plate's box on a frame before and after: the brand green is 38/208/124.
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
- **Audit a finished cut for repeated pictures** before adding material. Take the topmost picture
  of every frame and resolve nests to their inner clips; a nest's name hides its source. Flag shots that share a source range,
  and shots whose middle frames correlate above 0.8 at 64×36 grey. List the talking-head stretches
  over 10 s with their words: that is where unused material goes, matched to what is said.
- **Phone clips from editing apps end on an outro.** A CapCut clip ended on 2 s of black and a
  logo; a mosaic tile taken from the clip's last seconds showed it. Run `blackdetect` on every
  clip's tail before using its end. Check for letterboxing too (`cropdetect`): one 720×1280 clip held
  a 720×892 picture, so its «fill» scale is 215 %, not 150 %.
- **Several recordings into one message.** Cut on meaning and remove repeated points.
  Keep one sign-off, or use a shared ending when the speakers' words fit together. Check that
  a mosaic keeps every intended face in view (Crop + Motion per tile, `panel-api-notes.md`).

- **Subtitles are native captions, never rendered cards.** The user edits them in Premiere.
  - Build the SRT with `subcues.mjs`.
  - Import it, then `seq.createCaptionTrack(item, 0, Sequence.CAPTION_FORMAT_SUBTITLE)`.
  - `captionTracks` is not exposed; QE frames show the captions.
  - Font and plate are set in Track Style.
  - To match a user-corrected film, inspect a current rendered frame and its live Properties,
    not an old export or the first font string in the project XML. For bulk native-caption
    styling through Windows UI, see `references/native-caption-style.md`.
  - **When the user has turned them into Graphic clips** (Essential Graphics text), their text is
    FlatBuffers inside the prproj: not scriptable. Rebuild them as one .mogrt per cue with
    `mogrtcard.py --fill … --bg …` (text colour, plate) at the old clips' times, place with
    `importMGT`, bottom-align by Text › Position per line count, then set the old clips'
    `disabled = true` instead of deleting them.
  - Rounded plate corners cannot go into the .mogrt: the legacy text JSON has no such key (only
    `mBackFill…` Visible/Color/Opacity/Size). Premiere keeps them in its newer binary text format, as
    an extra float on every graphic. After regenerating a
    cue, the user (or a copy from a neighbour) puts the rounding back.

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
- [ ] requested episode or highlight cut delivered to the agreed scope; every dialogue join heard
- [ ] requested chapters checked on the timeline
- [ ] requested reels checked for framing (`checkreframe.mjs`) and complete sentences at the boundaries
- [ ] generated assets only after the user's yes
- [ ] rollback verified: activating `backupId` restores the original
- [ ] intermediates still present and reported, not deleted on your own initiative
