---
name: premiere-autopilot
description: Use when the user wants to montage in a live Adobe Premiere Pro — cut a podcast/interview highlight edit, make vertical reels, add chapters, generate/insert AI b-roll/voice, or lay a slide deck over a recorded lecture with section/cut markers. Drives the live Premiere via the LLM-Chat_Pr panel and generates assets via the Phygital sidecar.
---

# premiere-autopilot

Drive a **live** Adobe Premiere Pro to produce a turnkey montage. Claude makes the
editorial decisions; the skill's CLI helpers execute them against the running app.

## Prerequisites (the user handles these once)
- Premiere open with the **"ИИ: монтаж"** panel (LLM-Chat_Pr) — gives CDP port 8098.
- Phygital login done once via recon: `python -m scripts.cli auth login`.

## Approval model (B — semi-auto)
- One backup at the start; then run the pipeline autonomously.
- **Only stop for confirmation before paid generations** (`gen.mjs` image/video/voice/upscale).
- Roll back anytime via `pr.mjs activate --by-id <backupId>` (the `backupId` returned by `pr.mjs backup`).

## Workflow A (podcast/interview → highlight edit + reels)

1. **Preflight** — `node scripts/preflight.mjs`. Do not proceed unless `ready:true`.
   If panel MISSING → ask the user to open it. If auth NOT AUTHED → ask the user to run recon.
2. **Backup** — `node scripts/pr.mjs backup`. It returns `{ backupId, backupName }`; record `backupId` for rollback.
3. **Snapshot** — `node scripts/pr.mjs snapshot`. Understand clips/fps/duration.
4. **Transcript** — `node scripts/pr.mjs transcribe`. If `needsTranscription:true`,
   ask the user to run transcription once in the panel, then retry.
5. **Decide highlights (Claude)** — read the transcript; choose the segments that make
   a ~5 min horizontal cut. Score candidate segments and keep the highest — rough rubric:
   - **Story/insight (weight ~0.35):** a complete thought, answer, or turning point (not mid-sentence).
   - **Emotion/energy (~0.25):** laughter, strong opinion, surprise, vulnerability.
   - **Quotability (~0.20):** a self-contained line that stands alone out of context.
   - **Clarity (~0.15):** clean audio, no long filler/cross-talk.
   - **Novelty (~0.05):** avoid repeating a point already kept.
   Build a `cut` plan of `ripple_delete_interval` ops for the REMOVED ranges (everything
   NOT kept). **Snap every cut boundary to speech, not to your target timecode:** use the
   transcript's word/segment timings — start a KEEP at the first word of a sentence and end
   it after the last word, then pad by ~300 ms of silence on each side so you never clip a
   syllable or leave an orphaned half-word. Prefer cutting inside silences/pauses.
   Write the plan to a temp JSON file and apply: `node scripts/pr.mjs cut --file <plan.json>`.
6. **Chapters (Claude)** — derive 5–10 chapter points from the transcript. Write a
   markers array and apply: `node scripts/pr.mjs markers --file <markers.json>`.
7. **Reels (Claude)** — pick 3–5 punchy 30–60s moments. For each: duplicate/activate a
   vertical sequence, cut to the moment, then `pr.mjs reframe-sources` + build and apply
   a `reframe` plan (`node scripts/pr.mjs reframe --file <plan.json>`).
8. **Visually validate (Claude — do NOT skip)** — numbers (duration, W×H, `opsOk`) are
   necessary but NOT sufficient. The panel host cannot hand you a rendered composite
   (`getFrameSources` returns only clip metadata), so simulate each reel's crop from the
   SOURCE media with ffmpeg and LOOK at it:
   - A centered 9:16 fill of a 1920×1080 source shows only the center `1080/(1080·scalePct/100)`
     ≈ **31.6%** of the width (at `scalePct 178`). Extract 2–3 frames across each kept reel
     range and crop that visible band:
     `ffmpeg -y -ss <t> -i <src.mp4> -frames:v 1 -vf "crop=in_w*0.316:in_h:(in_w-in_w*0.316)/2:0,scale=1080:1920" out.png`
   - Read each PNG. Confirm faces/subjects survive the crop and nothing important is cut.
     For a two-shot, verify BOTH speakers stay in frame; if a subject is clipped, shift
     `posX` (0=left … 1=right) or lower `scalePct`, rebuild the reel, and re-validate.
   - Also eyeball the highlight cut boundaries (a frame just after each KEEP start) to
     confirm you didn't clip a word or land mid-gesture.
   Only proceed once the crop reads correctly. Clean up the temp PNGs afterward.
9. **Generative inserts (STOP — confirm, costs credits)** — for b-roll/covers/voiceover:
   write strong prompts using `references/prompting.md` (image/video slot templates,
   negative-prompt defaults, per-model branching). Preview cost first
   (`gen.mjs <kind> ... --dry-run`), confirm with the user, then generate
   (`gen.mjs image|video|voice --out <path>`), and insert
   (`pr.mjs import --file <p>` or `pr.mjs overlay --file <p>`). If a generation fails,
   report it and continue without that asset.
10. **Report** — summarize: highlight duration, chapters added, reels created, assets inserted,
   and the backup `backupId` for rollback.

## Workflow B (lecture/talk + slide deck → sectioned edit with slide overlay)

Use this when the source is a **recorded lecture/talk that has a matching slide deck**
(one deck per lesson, already imported into a project bin). The deliverable is a working
duplicate with the deck laid over the speaker on V2 plus colored review markers. Verified
end-to-end on three ~50–80 min lectures.

1. **Work in a DUPLICATE, never the source sequence.** `seq.clone()`, find the new sequence
   by diffing `sequenceID`s before/after, rename it `"<name> [РАБОЧАЯ монтаж]"`, activate it.
   (`backupActiveSequence` refocuses the ORIGINAL — see Panel API notes — so clone yourself.)
2. **Get a FULL transcript.** Transcription requires In/Out set on the sequence:
   `seq.setInPoint(0); seq.setOutPoint(endSec)` then click `#btn-transcribe`. **The Out point
   caps the transcript** — if Out < true end the tail is silently dropped. Always derive
   `endSec` from the audio track's last clip end, and after polling verify
   `segments[last].endSec` ≈ that value before trusting the transcript.
3. **Map slides to the narration by CONTENT, not by filename or even spacing.** Read the whole
   transcript and find where the speaker actually starts each slide's topic ("дальше про звук",
   "три схемы света", "первый тезис…"). Slide N runs from its own start until slide N+1's start;
   the last slide runs to sequence end. Never distribute slides evenly — the durations are wildly
   uneven and that's correct.
4. **Derive markers from the same pass.** GREEN (`setColorByIndex(0)`) = section dividers; the
   deck's own "Раздел: …" slides tell you where these belong, and each green marker should land
   on exactly the same timecode as its divider slide. RED (`setColorByIndex(1)`) = delete
   candidates found in the transcript: false starts and retakes ("заново", "сейчас будет заново"),
   coughs, dead air, repeated sentences, self-corrections, fillers, and any explicit
   "это можно не включать".
5. **Check the track layout before placing.** A clone inherits the source's track count — some
   sequences have only V1, so `seq.videoTracks[1]` is `null` and placement dies with
   "null is not an object". Probe `videoTracks.numTracks` + each track's `clips.numItems`, add a
   track with `seq.videoTracks.addTracks(1)` if needed, and place on the first EMPTY upper track.
6. **Place slides with explicit durations.** Match project items by filename prefix (`/^S(\d\d)\b/`)
   AND `getMediaPath()` folder, so decks from other lessons can't collide. Then per slide:
   `track.overwriteClip(item, startSec)`, take the just-added clip, and set its out point —
   `var t=clip.end; t.seconds=endSec; clip.end=t;`.
7. **Verify contiguity** — sort the placed clips by start and assert zero gaps and zero overlaps
   (>0.05s), first starts at 0, last ends at sequence end.
8. **Visually validate (do NOT skip).** Premiere has no frame export (`exportFramePNG`/`exportFrameJPEG`
   don't exist). Since deck slides are full-frame PNGs covering V1, the rendered frame IS the slide:
   `Read` a few slide PNGs via `getMediaPath()` and confirm the on-slide text matches what the
   speaker is saying at that timecode. Also confirm every section-header slide sits on its green marker.

**Caveat — filenames can lie.** In one of three decks several PNG filenames did not match the
slide's actual content (files named after one topic rendered a different one, and one named
slide had no matching content at all), while the other two decks were accurate. On-slide content
still ran in correct sequential order in every case. So: `Read` a few slides from each deck before
trusting its filenames, and map by what you SEE.

## Payload shapes
These are the `pr.mjs` CLI contracts (verified against the live panel host `_EXT_PRM_`, v2.14.0).
- `cut` plan: `{ "ops": [ { "startSec":N, "endSec":N, "mode":"ripple" }, ... ] }`. `mode` is
  optional and defaults to `ripple` (closes the gap); pass `"lift"` to leave a gap. `pr.mjs`
  translates this into the host's `applyTimecodeEdits` schema (`{ operations:[{ type:"ripple_delete_range",
  startSec, endSec }], expectedSequenceName }`) and applies intervals in **descending startSec order**
  so earlier ripple deletes don't shift the coordinates of later ones. Give ORIGINAL-timeline
  coordinates for every interval; do not pre-compensate for shifts.
- `markers`: `[ { "timeSec":N, "name":"...", "comment":"...", "color":1 }, ... ]` — the host key is
  `timeSec` (NOT `startSec`); rows without a numeric `timeSec` are silently skipped.
- `reframe` plan: `{ "newName":"Reel …", "targetW":1080, "targetH":1920, "expectedSequenceName":"<src seq>",
  "items": [ { "trackIndex":N, "clipIndex":N, "scalePct":N, "posX":0.5, "posY":0.5 }, ... ] }`. It
  CLONES the whole active sequence into a vertical one and applies Motion Scale/Position per clip.
  Get `trackIndex`/`clipIndex` from `reframe-sources` (it returns those, NOT a `nodeId`). To fill a
  9:16 frame from a 1920×1080 source use `scalePct ≈ 178` (=1920/1080), `posX/posY = 0.5` = centered.
  Trim the resulting clone to the moment by activating it and running `cut` afterward.
- `import` (add media to a project bin, non-destructive): `{ "path":"C:/.../asset.jpg", "binName":"AI Renders" }`
  — the host key is `path` (NOT `filePath`); defaults to bin `AI Renders`.
- `overlay` (place a clip on a new top track of a sequence): `{ "filePath":"C:/.../asset.mp4",
  "expectedSequenceName":"<target seq>", "startSec":N }` — `filePath` and `expectedSequenceName` are
  BOTH required (the host targets the named sequence, falling back to the active one).

## Safety
- Never run `cut` without a backup taken in step 2.
- Validate cut intervals against the snapshot duration before applying (no interval past end; no overlaps).
- `pr.mjs cut` runs its own guard: it fetches the snapshot, rejects overlapping/out-of-bounds/negative
  intervals, and refuses a plan that would leave less than `--min-keep-sec` (default 2s) of footage.
  It reports `removedRatio` in its output — a highlight edit legitimately removes most of a long
  podcast (e.g. keep 5 min of 60 → ~0.92 removed), so a HIGH ratio is expected; sanity-check that the
  resulting duration ≈ your target, not that the ratio is small. Pass `--force` only to override the guard.
- Never smoke-test paid generations; always `--dry-run` + user confirmation first.
- Do not edit the two source repos.

## E2E checklist (real podcast project)
- [ ] preflight ready:true
- [ ] backup created, backupId recorded
- [ ] transcript loaded (or user triggered it)
- [ ] highlight cut applied, duration ≈ target
- [ ] chapters visible on timeline
- [ ] 3–5 vertical reels produced
- [ ] reel crops visually validated (ffmpeg frame simulation read; subjects survive the crop)
- [ ] at least one generated asset inserted (after confirmation)
- [ ] rollback verified: activate backup backupId restores original
