# Panel API notes — LLM-Chat_Pr host (`_EXT_PRM_`, v2.14.0)

Live-verified payload contracts for the PremiereBridge/ExtendScript host, captured
while running the premiere-autopilot pipeline end-to-end against a real project.
These are the shapes the **host** actually reads — several earlier SKILL.md notes
did not match, so each call silently no-op'd. Recorded here so the skill (and any
future caller) targets the real API, and as a bug report for the panel owner.

Verified against extension:
`%APPDATA%/Adobe/CEP/extensions/com.extensionsllm.chatpr/host/premiere.jsx`

## Discrepancies found (caller shape → host expectation)

1. **addSequenceMarkers** — host reads `timeSec` per row (jsx ~line 2063:
   `if (typeof m.timeSec !== 'number') continue;`). A payload keyed on `startSec`
   produces `count:0` with `ok:true` — a silent no-op, no error. Also honors
   `name`, `comment`, `color`.

2. **applyVerticalReframe** — host expects
   `{ newName, targetW, targetH, expectedSequenceName, items:[{trackIndex, clipIndex, scalePct, posX, posY}] }`.
   It CLONES the whole active sequence into a new one sized `targetW×targetH`, then
   sets Motion Scale (`scalePct`) and Position (`posX,posY` in [-5..5], 0.5=center)
   per clip. It does NOT take `nodeId`/`scalePercent`, and it does not trim — trim
   the clone afterward. `newName` must be unique; `scalePct` in (0,1000], within
   256–8192 target bounds. A 1920×1080→1080×1920 fill needs `scalePct≈178`.

3. **getVerticalReframeSources** returns per-clip `{trackIndex, clipIndex, name, mediaPath, startSec, endSec, inPointSec}` —
   **no `nodeId`**. So a reframe plan keyed on `nodeId` cannot be built from its output;
   use `trackIndex`/`clipIndex`.

4. **applyTimecodeEdits** — host reads `plan.operations` (NOT `plan.ops`), and the
   interval action string must be `ripple_delete_range` / `lift_delete_range`
   (also the `_all_tracks` variants). The legacy name `ripple_delete_interval` is
   not recognized → `opsOk:0`, silent. Each op: `{ type, startSec, endSec }`.
   Honors optional `expectedSequenceName` guard (rejects if active seq name differs).

5. **importMediaFile** reads `path` (NOT `filePath`), plus optional `binName`
   (default `AI Renders`). **importAndOverlayOnTop** reads `filePath` AND a
   REQUIRED `expectedSequenceName` (targets that named sequence, else active).
   These two sibling calls use different key names for the file path — easy to mix up.

## Correctness bug (caller-side, in ripple sequencing)

`applyTimecodeEdits` applies interval deletes in array order. A ripple delete
shifts all later content left by its length, so applying intervals low→high makes
every subsequent interval's coordinates point at already-shifted footage — the
wrong region gets cut. Observed live: a two-interval reel trim (`[0,30]` then
`[59,end]`) produced a 59s result instead of 29s because op2 ran in post-shift
coordinates.

**Fix applied in the skill (`scripts/pr.mjs`):** sort interval ops by **descending
startSec** before sending to the host, so earlier (higher) deletes never move the
coordinates of later (lower) ones. Give ORIGINAL-timeline coordinates for every
interval; never pre-compensate. (Lift deletes don't shift, so descending is a safe
no-op for them.) If the host ever sorts internally, this becomes redundant but
still correct.

## Escape hatch: arbitrary host JSX (v2.16.0)

`callBridge('evalJson', ['<ExtendScript expression>'])` runs ANY JSX inside the host
`$._EXT_PRM_` context. The expression must return `JSON.stringify(...)`. This is how to
do everything the built-in methods don't expose — **without editing the source repos**.
Helper: `scripts/_ev.mjs <file.jsx>` runs a host JSX file; `scripts/_pev.mjs <file.js>`
evals JS in the PANEL (DOM) context, used to click `#btn-transcribe` and read `#err`.

Things that REQUIRE this escape hatch (the built-ins can't do them):

- **Colored markers.** `addSequenceMarkers` ignores color. Use
  `seq.markers.createMarker(sec)` → `.name` / `.comments` / `.setColorByIndex(idx)`
  (0=green, 1=red).
- **Per-clip durations.** `importAndOverlayOnTop` places on the top track with a DEFAULT
  duration only. To control it: `track.overwriteClip(projectItem, startSec)`, then take
  `track.clips[track.clips.numItems-1]` and set `var t=clip.end; t.seconds=endSec; clip.end=t;`.
- **Adding a video track.** `seq.videoTracks.addTracks(1)` works directly (QE
  `qe.project.getActiveSequence().addTracks(...)` is the fallback). Needed because a cloned
  sequence inherits the source's track count — a 1-video-track source clones to
  `numVideo:1`, making `seq.videoTracks[1]` **null** ("null is not an object" on placement).
- **Clone to a working duplicate.** `seq.clone()` returns nothing useful — diff
  `proj.sequences[*].sequenceID` before/after to find the new one, then set `.name`.
  Prefer this over `backupActiveSequence`, which renames the CLONE as the backup and then
  REFOCUSES the original (so you'd be editing the source, violating "работай в дубликатах").
- **In/Out points.** `proj.activeSequence=seq; seq.setInPoint(0); seq.setOutPoint(endSec);`
  (seconds). Required before transcription — otherwise the panel reports
  "Задайте In и Out". Unset In/Out (sentinel `-400000`) does NOT mean "whole sequence".
  **The Out point also CAPS transcript length** — a too-small Out silently truncates the
  tail (observed: a 4742s lecture cached as 3811s because a prior run used Out=3811).
  Always compute `endSec` from the audio track's last clip end and verify the cached
  `segments[last].endSec` matches before trusting a transcript.

## Not available (don't try)

- **Frame export.** `seq.exportFramePNG` and `seq.exportFrameJPEG` do not exist on the
  Sequence object — both throw "is not a function". There is no way to get a rendered
  composite out of the host. For visual validation, reconstruct what the viewer sees from
  the SOURCE assets instead (ffmpeg crop simulation for reels; reading the slide PNG
  directly for full-frame deck overlays).

## Transcript cache

`C:/Users/<user>/.extensions_llm_chat_pr/_llm_transcript_cache.json`, keyed by `sequenceID`.
Each entry: `{ seqName, segments:[{startSec, endSec, text}, ...] }`. The entry only appears
AFTER normalization completes, so poll for it (`scripts/_poll_cache.mjs <seqId> [maxMin]
[minLastEnd]` — pass `minLastEnd` to avoid matching a STALE truncated entry from an
earlier run).

## Methods confirmed working live (v2.14.0)

`getTimelineSnapshot`, `backupActiveSequence`, `getVerticalReframeSources`,
`applyVerticalReframe`, `addSequenceMarkers`, `applyTimecodeEdits`,
`importMediaFile`, `importAndOverlayOnTop`, `activateSequenceById`,
`activateSequenceByName`. Transcript is read from the panel cache
(`transcribe` needs a one-time in-panel run per sequence).
