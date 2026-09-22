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

## Read this before touching anything

**`gen-out/` is per-session scratch and is gitignored.** Leftover JSON plans,
transcript dumps and one-off scripts in there belong to whatever project ran last.
They are evidence, never method. Do not build a plan on top of them and do not
assume a file you find there will exist next time.

**Confirm which project is focused before any mutating call.** `app.project` is
whichever project Premiere has focused, not the one you were working in a minute
ago. Read `app.project.name` and the active sequence first; if more than one
project is open, ask the user to close the others rather than guessing.

**Numbers are not verification.** The panel host cannot return a rendered frame
(`getFrameSources` returns clip metadata; `exportFramePNG`/`exportFrameJPEG` do not
exist). Every visual claim has to be re-derived from the source media with ffmpeg
and actually looked at. Duration, `W×H` and `opsOk` are necessary and never sufficient.

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
   NOT kept). **Pick boundaries from the waveform, not from the transcript.** Use the
   transcript to choose which sentences to keep, then measure each boundary with
   `node scripts/audio.mjs check --src <media> --in <t> --out <t>` and aim the blade at the
   MIDDLE of a pause. Whisper's segment timings drift by tenths of a second — cutting on
   one routinely slices a syllable.
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

## Workflow C (multicam master → vertical reels)

Use when the source is a **flattened multicam export** — one rendered file on the
timeline, already cut between angles, so every clip boundary is a camera switch.

**REQUIRED READING:** `references/vertical-reels.md` has the full technique. The
short version, and the ways it goes wrong:

1. **Survey the angles by looking** — `node scripts/shots.mjs --src <media>` renders one
   frame per clip. Read the sheet; derive each angle's face position `u` (fraction of
   SOURCE width) and confirm it with `shots.mjs probe`. Never port a camera classifier
   or a `u` table from another project — lighting and seating change every shoot.
2. **Pick boundaries from the waveform, not the transcript** —
   `node scripts/audio.mjs check --src <media> --in <t> --out <t>`. Aim at the middle
   of a pause. Trust `fineDb` (5 ms), not `coarseDb` (50 ms).
3. **Build in a duplicate**, ripple-delete outside `[start,end]`, then assert the
   surviving source range matches before applying any Motion.
4. **Compute the reframe with `scripts/vframe.mjs`** — never by hand.
   `scalePct` is NOT the visible fraction: at `scalePct 88.889` a 3840-wide source
   shows `1080/(3840·0.88889)` = **31.6 %** of its width. Position moves the image and
   so is inverted, and legally exceeds `0..1`.
5. **Frame wide/two-shots on the NEAREST close-up neighbour**, not on the reel's
   dominant angle — `vframe.mjs plan` does this. The dominant-angle version passes
   every numeric check and silently frames half the cutaways on a silent face.
6. **Verify on pixels** — `node scripts/checkreframe.mjs --src <media> --seq "<name>"`
   inverts the Motion values Premiere stored back into a crop. Read the image.
7. **Re-read every boundary in context before calling it done** — re-transcribe ±6 s
   around each cut with `scripts/rewin.py` and print the words on either side. A reel
   must open on a sentence start and close on a sentence end. On one nine-reel job this
   pass ran after a structural audit that came back completely clean and still found two
   reels opening mid-thought, because the full-file transcript had drifted 3 s.
8. **Leave the `_wip` sequences alone when you finish.** They are cheap, they are the
   only record of what each reel was cut from, and re-deriving one costs another
   multi-minute ripple delete. Report that they exist and let the user decide. Tidying
   up unprompted is a destructive act on someone else's project.

## Workflow D (screen-shared lecture + PDF deck → one sequence per slide)

Use when the lecturer **screen-shares a PDF deck** and the deliverable is one
sequence per presentation block — junk (open Q&A, waiting to start, failed demos)
removed, each sequence named after its slide.

**REQUIRED READING:** `references/slide-blocks.md`. The short version:

1. **Track the deck on screen** — `slidetrack.py calibrate` then `track`. A screen
   share is never full-frame and the page is usually clipped by the viewer's toolbar
   and a "Screen: …" banner; a view must exclude every overlay or every geometry
   scores ≈0.5 and picks the wrong page.
2. **If the deck is in a scrolling viewer, sweep the offset** — `scrollviews.py`.
   Continuous scroll leaves the page at a different Y after every page turn; one view
   matches 11 % of the module, twenty views match 40–50 % at correlation 0.94.
3. **Read slides + deck text + transcript together** — `slidealign.py`, then
   `trwin.py` for the stretches where no slide is on screen. The deck gives structure,
   the transcript gives the boundary the speaker actually crossed.
4. **Write a block plan** (blocks / dropped / pinned). Divider slides merge into their
   neighbour; Q&A about the slide on screen stays; every boundary taken from the
   transcript rather than the pixels gets a `СПОРНО:` marker naming the sentence.
5. **Verify the plan on pixels before cutting** — `planverify.py` puts the frame at
   each block start next to the page it claims. Read it in row-sized crops.
6. **Snap to pauses** — `snapplan.mjs`, then review every move over ~2 s. It regularly
   lands past the sentence that OPENS the block; pin those and record why.
7. **Cut into clones** — `blockcut.mjs --dry-run`, then for real. Never cut the source
   sequence: it is the only copy of the scene-detect edit.
8. **Verify** collapsed source ranges and markers per created sequence, and that every
   source sequence still has its original duration.
9. **Verify the edit, not the mechanics** — a range match only proves the ripple
   delete obeyed. Three separate checks: `planverify.py` (does the block open on the
   slide it is named after), `edgecheck.mjs` (does any blade land inside a word),
   `edgetext.mjs` (does the block open and close on a complete thought). The third
   catches what the other two cannot: a boundary in a clean pause that is still the
   middle of a sentence, which is what a slide-track boundary becomes whenever the
   lecturer advances mid-sentence.

## Workflow E (reviewer notes → corrected edit → episodes)

Use when a first draft of a long recording has come back with review notes
(VideoBoard bundle) and the next version must apply cuts, lay slides on V2, mark
intros/outros/name plates, move a section, and be split into separate episodes.

**REQUIRED READING:** `references/review-to-edit.md`. The short version:

1. **Transcribe locally** — `scripts/mixdown.mjs` + `scripts/transcribe_local.py`
   (GPU, word times). Never pass `--hotwords` on a long recording.
2. **Treat the notes' times as intent only.** Snap every edge into a measured pause
   (`scripts/scan.mjs`, threshold from the level histogram) and **hear it** with
   `scripts/splicecheck.py` before cutting.
3. **Build so that every track's item list ends up in time order.** A new order:
   `scripts/rearrange.mjs`, then `sequence.clone()` of the result (keeps clip effects),
   or `scripts/assemble.mjs` when the source clips carry no effects. Then
   `scripts/trackorder.mjs`, expected-vs-actual, a rendered frame from late in the
   source, and `scripts/placestills.mjs` for slides. One range out later:
   `scripts/ripplecut.mjs`.
4. **Hear every join again** on a mixdown of the finished sequence — and every episode
   edge. An episode that ended on a slide switch stopped between «это» and «DR.»: a
   short word's timestamp drifts by half a second either way, so transcribe the audio
   on each side of the edge (which words are present is reliable when their times are
   not) and measure the level on the kept side of every edge. Then look at exported
   frames and at the timeline panel itself (`scripts/prwindow.ps1`).
5. **Split into episodes** by cloning the verified edit and cutting each down.

## Workflow F (raw interview day → one selects sequence per speaker, a question card before each answer)

Use when a sequence holds hours of raw interview takes of several people (start/stop per
question, retakes, crew talk) and the deliverable is one sequence per speaker: an editable
title card with the question, then the chosen answer, junk and failed takes removed.

1. **Who is where: look.** Build a throwaway sequence with 1 s from the middle of every clip
   (`assemble.mjs` rows of 1 s) and export QE frames from it — the RAW is hours long and QE
   frames past one hour come back from the head. BRAW: ffmpeg reads its audio (pcm_s24le) but
   not its video, so frames only come out of Premiere. Speakers sit in contiguous clip runs.
2. **Transcribe in the cloud, per phrase: `scripts/cloudtr.mjs`.** The panel's cloud
   transcription (Cloud.ru `whisper-large-v3`) silently drops whole 30 s windows of a long
   clip — 7 of 171 clips lost an answer's first half, an introduction, or everything but the
   question — and the endpoint answers `words: null`, so there are no word times. `cloudtr`
   cuts each clip at its own pauses into 3–15 s phrase groups and sends each alone: nothing
   is dropped and every chunk edge is a pause a blade can use. Extract the audio once
   (`ffmpeg -map 0:a:0 -ac 1 -ar 16000`), then `--wav-dir`. Chunks can still start or end
   without their first/last word in the TEXT (the audio is there) — read both transcripts.
3. **Read every speaker end to end and write a plan** (`{q, src, pieces:[[firstChunk,
   lastChunk, {start|end anchors}]], note}`): the best complete take per question (usually the
   last one the crew accepted), answers assembled from pickups where the speaker re-said a
   sentence, explicit on-set decisions honoured («Концовку убираем», «это можно вырезать»),
   the question itself cut out. Card text = the question as the interviewer asked it (they
   read from a newer list than the document); the document's wording only when the question
   is not on the recording. Record alternatives and cuts in the marker note.
4. **Cuts inside a phrase group: `scripts/cloudsplit.mjs`** — tries the quiet dips nearest to
   the word and keeps the one whose PREFIX transcript ends with the word before the cut. The
   last word must match (a looser match put cuts after «…работодателя. А»); short words need
   an exact match; Latin/Cyrillic («Atlas»/«атлас») never match — pass `after`. When the model
   will not hear the anchor, measure the gap on a 5–10 ms level map and pin `t`.
5. **Read every edge back: `scripts/cloudedges.mjs`**, then every join rendered from the
   plan (4 s either side). This found: the interviewer's «угу»/«да» carried at chunk edges, a
   next question glued to an answer's end, «Для»/«Совет» of the next sentence left on a
   tail, a word's first syllable cut off. Trim edges to SUSTAINED speech (8 of 10 frames over
   the threshold), not to the first loud frame — a click is loud.
6. **Cards: `scripts/mogrtcard.py`, one .mogrt per card.** ExtendScript cannot set a graphic's
   text (`Source Text` reads back as one garbage character, a Premiere-authored .mogrt has no
   MGT parameters), so the text goes into the template before import: .mogrt → *.prgraphic →
   *.prproj (gzip XML) → base64 of an 8-byte length + UTF-16 JSON with `mText`. Fresh
   `capsuleID` per card. After `sequence.importMGT(path, ticks, 0, 0)` set `end` and centre
   the block: Text › Position y = 0.5165 − (lines−1)·0.0356 at 34 characters a line.
7. **Build per speaker**: clone an EMPTY template (a clone of the RAW, emptied) → cards first →
   pieces with `assemble.mjs` → markers (name = question, comment = note + sources, colour =
   source). Then verify against the plan: position, in-point, end, the A1 partner, no holes,
   list order, marker count. **`importMGT` loses a card now and then (4 of 107)** — re-import
   the missing ones, then re-run `assemble.mjs --step place`: the card's 4.92 s default ate the
   head of the next answer. Look at a frame of every card and every piece.
8. **Transcripts of the finished pieces** (one document per speaker): `cloudtr.mjs --pieces`
   with a names-and-terms prompt per speaker — the prompt turns «Семдиби» into CMDB and gets
   every surname right — but read each phrase twice, with and without the prompt: on a quiet
   phrase the context invents text («будут в следующем году» for «останутся
   фундаментальными»). The tool keeps the better reading, prefers a punctuated one, and never
   uses an unpunctuated phrase as context (that style spreads down a whole answer). A phrase of
   20 s with no pause can come back empty in both readings — re-read it in 7 s windows. Word
   files: `docx` (npm) — question as heading, answer in paragraphs broken only where a sentence
   ends, each with the sequence timecode and the source clip.
9. **Clones inherit the source's In/Out.** Twelve speaker sequences cloned from a RAW with
   In/Out over four hours would each export four hours of black «In to Out» — set each to
   `[0, end]`.

## Hard-won constraints

**Seconds → ticks rounds DOWN.** `projectItem.setInPoint(261.08)` landed on 261.04: the
piece came out one frame long and ate the first frame — once a whole title card — of the clip
after it. `assemble.mjs` now aims a millisecond into the frame; do the same in any new JSX
that turns seconds into a `Time`. Its done-check allows 0.05 s for 30 fps sources, so a piece
one 25p frame off passes it: remove such a piece and re-place it.

**A bridge timeout is not a failure.** `applyTimecodeEdits` gives up at 120 s and
`evalJson` at 30 s, but the edit keeps running inside Premiere. Ripple-deleting
~1200 clips takes minutes. Re-issuing the call applies the edit TWICE. Correct
response: catch the timeout, then poll a cheap read until the host answers again,
and confirm the resulting state before continuing. The 30 s cap holds whatever
`timeoutMs` you pass, and the panel reports it in Russian («ExtendScript не ответил
за 30с») — a `/timeout/` regex alone misses it. Batch every mutating loop so one call
stays well under 30 s: removing ~200 pieces in one `lift` call did not.

**Subtitles are native captions, never rendered cards.** The user wants them editable in
Premiere. Import an SRT and `seq.createCaptionTrack(item, 0, Sequence.CAPTION_FORMAT_SUBTITLE)`
(returns true; `seq.captionTracks` is not exposed to scripts, but QE-exported frames do show
the captions — check there). Font and plate have no scripting API: leave them to Track Style.
`scripts/subcues.mjs` builds the SRT from corrected text timed on ASR words.

**Watch the cut before you build it.** A plan that verifies against itself still has to
work as a film. `python scripts/planpreview.py --layout layout.json --plan expected.json
[--cards cards.json --srt subs.srt] --out preview.mp4` renders the plan itself — V1, the
B-roll layer above it, the graphics, the speaking audio, burnt-in subtitles — in minutes and
without Premiere. Watch it, then spend the half hour on the sequence. It is also what the user
watches to approve the cut, and it shows where the film goes silent. It is a model of the
timeline: a still that does not fill the frame is letterboxed there while Premiere shows the
track underneath, so check anything that matters on a real exported frame.

**A still placed on a busy track eats the clip after it.** `placestills.mjs` overwrites at the
preference default length (5 s) and only then trims the still back, so whatever sat within
those 5 s loses its head — silently, and the DOM check you ran BEFORE placing the stills
still says the edit is perfect. Place the stills, then re-run `assemble.mjs --step place`:
it notices the damaged clip and puts it back.

**Cloud transcription in the panel TRANSLATES.** «Транскрибировать In–Out» returns fluent
Russian for English and Hindi speech, with segment times. That is a good way to read the
finished film's story end to end (and to answer "is it understandable"), and useless for
deciding where a blade goes — for that, transcribe the piece's own audio with
`large-v3` (`KASHIF_WHISPER=small,cpu` or `large-v3` on CPU when the GPU belongs to
something else, e.g. ComfyUI holding all the VRAM).

**A filler word can hide inside its neighbour's timestamp.** The user asked to drop an «okay»
at the head of an answer; the word list had no «okay» — whisper had folded it into the
following «and» (stamped 1661.56, 0.8 s long). The level profile showed the truth: speech at
1661.46–1661.74, quiet to 1662.05, the sentence from 1662.06. When a word the user hears is
not in the transcript, profile the levels at 10 ms and listen to the piece's own head.

**One-sided sound has TWO causes — check the sequence master first.** A sequence built from
camera clips with multichannel audio gets a **Multichannel master**, and its audio tracks are
named «Output 1…4»: each one is wired to a single output channel, so the whole film plays out
of one speaker no matter what is on the clips. Read it with `sequence.getSettings()` —
`audioChannelType` 3 with `audioChannelCount` 4 is that case (1/2 is stereo) — and fix it in
place: take the settings object, set `audioChannelType = 1` and `audioChannelCount = 2`, and
`sequence.setSettings(...)`. The tracks rename themselves to «Audio 1…4» and route to L/R;
nothing else in the sequence moves. Every clone of that sequence inherits the master, so fix
the source too or every new cut starts wrong.

**Check the audio CHANNELS as well.** A shoot where the lav went into one
input leaves the voice on a single channel: `ffmpeg -i clip -af astats -f null -` prints about
−65 dB on the silent one against −20 dB on the other. The timeline then plays out of one
speaker, and nothing in the plan, the DOM or a rendered frame says so — the user hears it.
Fix it per clip with the host's own effect, `node scripts/fillmono.mjs --seq "<name>"
--from right --match .MOV` (QE's `getAudioEffectList()` names them «Fill Left with Right» /
«Fill Right with Left»; there is no API to REMOVE an effect, so apply it carefully once).
Two traps: QE serves a cached track item list, so "does this clip already have the effect"
reads stale and the same clip collects three copies — drive the batches by an index window;
and a mixdown that downmixes to mono (`-ac 1`) averages the silent channel in, hides the
problem and costs 6 dB — `scripts/mixdown.mjs` takes a `ch` per clip and `planpreview.py`
detects it.

**Prove the sound, do not reason about it.** `sequence.exportAsMediaDirect(dest, preset, app.encoder.ENCODE_IN_TO_OUT)`
with an audio preset (`…/MediaIO/systempresets/3F3F3F3F_41494646/AIFF 48kHz.epr`) renders the
timeline's own audio for a short In/Out range — then `astats` says what each channel really
carries. The bridge's 30 s cap fires while the export keeps running; wait for the file to stop
growing. Both channels at the same RMS is the proof that a one-sided source is fixed.

**"Each clip once" does not make B-roll varied.** The eye counts PLACES and SUBJECTS, not clip
ids. A layer where every clip was used exactly once still read as repetition to the user: four
shots of the same entrance, three of the same desk, three of the same statue, six from one
vlog's workshop, five of the same plaza — each a different clip, in a row. Group the material
by place/subject, lay each stretch so neighbours never come from the same group (at most two
of a group per stretch), and alternate wide / detail / people. Check it by LOOKING: one frame
per B-roll shot, in order, labelled with time and clip, tiled into contact sheets — repetition
is obvious there and invisible in every numeric check. When only the B-roll changes and the
canvas timing does not, clear that track and re-run `assemble.mjs --step place`: the markers,
the captions and V1 stay as they are.

**Read the finished canvas for repeats before handing it over.** Interview answers overlap:
the same thought comes back in another take or under another question. Print every piece's
words in canvas order, read them, and list the 4-word phrases two pieces share. On one film
this found two closing lines from two takes back to back (the user called it a double
ending), the self-introduction again as a vlog greeting, two answers on adaptation in a row,
a trip told in the travel scene and again as a memory, a lead-in that re-asked the previous
answer's question, and a vlog insert whose last sentence repeated its second. Keep one of
each; the rest goes to the alternate takes, where nothing is lost.

**Mixed-language interviews: transcribe with `scripts/transcribe_mixed.py`.** When the
subject answers in one language and the crew talks in another between takes, a
single-language pass forced to English translates the crew's Russian into fluent
English that reads like the subject's answer. The script picks the language per
voice chunk and transcribes each run in its own language.

**ExtendScript is ES3.** Anything newer silently is not there:
- no arrow functions, no `let`/`const`, no template literals, no destructuring;
- no `Array.prototype` `find` / `indexOf` on objects / `forEach` / `map` — write `for` loops;
- no `JSON.parse` in some hosts (building strings by hand is safest);
- reserved words — `short`, `int`, `char`, `class`, `enum`, `final`, `native`, `float`,
  `double` — cannot be used even as object-literal keys.

All of these fail at PARSE time, so an in-script `try/catch` cannot catch them and the
only symptom is an opaque `raw=EvalScript error` with no line number. If a script that
reads as valid JavaScript fails repeatedly, you are looking at a syntax-level ES3
violation, not a logic bug. Write host scripts in plain ES3 from the start.

**Confirm before removing anything.** Deleting intermediate `_wip` sequences, restoring
a backup over current work, or clearing a bin are all destructive and none of them are
implied by "make me some reels". Leave intermediates in place and ask.

**Deleting a sequence: `projectItem.deleteBin()` is a silent no-op.** It returns without
throwing and the sequence is still there, so a delete loop reports success on every item
and changes nothing. Use `app.project.deleteSequence(seq)`. Either way, `numSequences`
is stale for the rest of that script execution — re-read the list in a FRESH call before
believing anything was removed.

**Rename, do not delete, when re-cutting a reel.** Move the old version to an `_OLD_`
prefix, rebuild under the real name, verify the rebuild, and only then delete. A rebuild
costs a multi-minute ripple delete; a rename costs nothing and keeps the fallback alive
across the window where you have neither version verified.

**Whisper timecodes drift by tenths of a second.** Use the transcript to decide
WHAT to keep and the audio envelope to decide WHERE to cut. Every boundary gets
measured against the waveform.

**The transcript cache is keyed by sequenceID, not by sequence name.** A lookup by
name silently reports "never transcribed" for a sequence whose full transcript is
sitting in the file, and the natural next move — re-running transcription — costs an
hour. Look up `snapshot.sequenceId` first, and keep the name lookup only as a fallback.

**`TrackItem.move()` does not drag the linked partner.** On this build it moves only the
item it is called on; audio stays behind. Move every item explicitly (`rearrange.mjs`
does) and test on the live sequence first (`--step test-move`).

**Moving clips past each other with `move()` breaks the track (Premiere 26.3).** After
`rearrange.mjs` parked 338 pieces and placed them back, every DOM read was perfect —
positions, in-points, audio partners — yet the timeline panel drew the canvas empty,
the renderer returned frames with no video for whole stretches, and `sequence.end`
reported the new end of the clip that used to be LAST. The track keeps its items in
the original order and `move()` does not re-sort it. The renderer is not always hit: on
a one-hour lecture with one section moved, QE frames were perfect and only the panel
(V1/A1 drawn empty after the moved section) and `sequence.end` were wrong. So check the
order itself — `node scripts/trackorder.mjs` flags every sequence whose `track.clips`
run out of time order or whose `sequence.end` is not its last clip's end.
**Repair with `sequence.clone()`:** a clone rebuilds every track's list in time order and
keeps each clip's effects. Compare the clone with the original, then rename the broken one
`_OLD_…` and the clone to the real name. To build a reordered edit, run `rearrange.mjs`
and clone the result, or use `scripts/assemble.mjs` (clone the source, empty it,
`overwriteClip` each piece at its target in ascending time). **`assemble.mjs` places
fresh clips from the project item, so effects on the source's clips — an audio chain, a
grade — do not come along;** list the clips' `components` before choosing it. Moves that
never change the clips' order (a ripple: `scripts/ripplecut.mjs`) are safe.

**Assembling on V2 and from phone footage (`assemble.mjs` rows with `tr`/`sc`).**
`videoTracks[1].overwriteClip` puts the clip's audio on A2 by itself — the interview on A1
is untouched; mute A2 (`audioTracks[1].setMute(1)`) for a draft B-roll layer. `overwriteClip`
places a fresh clip at Motion defaults, so `assemble.mjs` copies the source clip's framing
(Motion Position, Scale, Rotation, Anchor) onto it — photos and phone footage scaled to the
frame on the source sequence otherwise land cropped or small. There is no
`TrackItem.setScaleToFrameSize()` on 26.3; `sc` sets Motion > Scale (`properties[1]`, 150 for
1280×720 on 1080p) explicitly. A 30 fps source reports its in-point on its own 1/30 s grid —
compare in-points with 0.05 s, or a placed piece never counts as done and gets overwritten on
every pass. A draft B-roll layer uses every clip once, a vlog once per moment and never under
one of its own inserts: a pool that loops brings the same shot back minutes later, and the
viewer sees it. Run the shots end to end (a gap flashes the face); when a list runs out, let
the face show.

**Ripple deletes desync tracks that are empty under the range.** The host removes the
pieces under a range track by track; a track with nothing there is not shifted, so later
V2 content (a screen recording, slides) drifts. Rebuild with absolute targets instead, or
remove one range with `node scripts/ripplecut.mjs --seq "<name>" --cut a,b`: it razors
clips across the edges (a slide over the cut is trimmed, not split), removes what lies
inside, shifts everything after b in ascending order, and moves markers and the out point.

**Assigning `end` does not trim a video/audio clip.** It lengthens the timeline item and
leaves `outPoint` where it was. Set `outPoint` (a whole `Time` object), then `end`, and
read both back. `clip.start.seconds = x` is a silent no-op; assign whole `Time` objects.

**`sequence.end` short of the last clip's end means a broken track, not a quirk.** It is
the end of the item that is last in a track's LIST (see `move()` above). The sequence that
once seemed to "return the last slide's end" had a V1 reordered by `move()`; its clone
reported the right end. Compute the last clip end over all tracks, and when the two
differ, run `scripts/trackorder.mjs`.

**JSX source must not contain backslashes.** They are mangled on the way into the host:
a Windows path literal breaks the parse ("EvalScript error"). Use forward slashes, or
`new File('C:/…').fsName` where a native path is required (`exportFramePNG`).

**QE `exportFramePNG` is unreliable past one hour** — it returns a frame from the head
of the sequence. Check late material in shorter sequences.

**A level check does not prove a word is intact.** Where two microphones overlap the
floor rises to −60 dB and a consonant inside a word reads as a pause. Hear every join
(`scripts/splicecheck.py`). A dip inside a word also looks like the pause after it: «music»
had 0.1 s at −55 dB between «mu» and «sic», and a blade pinned there made whisper hear
«movies». After pinning a blade, transcribe the piece's last seconds on their own.

## Payload shapes
These are the `pr.mjs` CLI contracts (verified against the live panel host `_EXT_PRM_`, v2.16.1).
- `cut` plan: `{ "ops": [ { "startSec":N, "endSec":N, "mode":"ripple" }, ... ] }`. `mode` is
  optional and defaults to `ripple` (closes the gap); pass `"lift"` to leave a gap. `pr.mjs`
  translates this into the host's `applyTimecodeEdits` schema (`{ operations:[{ type:"ripple_delete_range",
  startSec, endSec }], expectedSequenceName }`) and applies intervals in **descending startSec order**
  so earlier ripple deletes don't shift the coordinates of later ones. Give ORIGINAL-timeline
  coordinates for every interval; do not pre-compensate for shifts.
- `markers`: `[ { "timeSec":N, "name":"...", "comment":"...", "color":1 }, ... ]` — the host key is
  `timeSec` (NOT `startSec`); rows without a numeric `timeSec` are silently skipped. The host
  ignores `color` (host 2.17.0: all 83 markers of one job landed green) — colour them afterwards
  with `node scripts/markercolors.mjs --file <markers.json> --seq "<name>"`, which reads each back.
  Moving a marker from JSX: `marker.start` / `marker.end` take plain seconds (a `Time` object is
  an "Illegal Parameter type"), and assigning `start` moves the whole marker, length and all —
  set `start` first, then `end`, or a zero-length marker comes out stretched.
- `reframe` plan: `{ "newName":"Reel …", "targetW":1080, "targetH":1920, "expectedSequenceName":"<src seq>",
  "items": [ { "trackIndex":N, "clipIndex":N, "scalePct":N, "posX":0.5, "posY":0.5 }, ... ] }`. It
  CLONES the whole active sequence into a vertical one and applies Motion Scale/Position per clip.
  Get `trackIndex`/`clipIndex` from `reframe-sources` (it returns those, NOT a `nodeId`).
  `scalePct` fills the frame HEIGHT at `1920/srcH·100` — 178 for a 1080-tall source, 88.889 for
  2160-tall — and `posX/posY = 0.5` is centered. **Build the items with `scripts/vframe.mjs`**,
  which prints the visible fraction and handles the inverted position math.
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
- [ ] intermediates still present and reported — NOT deleted on your own initiative
