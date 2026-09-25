# Reviewer notes → corrected edit → episodes (Workflow E)

Use when a long single-take recording already has a first draft, a reviewer has
annotated that draft (a VideoBoard bundle: `review.json`, `notes.csv`, marker
XML), and the next version must: apply the cuts, lay slides on V2 where the notes
ask for the presentation, mark intros/outros/name plates, move a section, and
split the result into separate episodes. The draft stays untouched; all work
happens in a clone.

## 1. What the notes are, and what they are not

- Times are in the timeline of the **render the reviewer watched**. Check that
  `project.duration_sec` equals the sequence length and the render's length; an
  export trimmed by In/Out shifts every note and the bundle cannot show it.
- Reviewer times are coarse — whole seconds, drawn on a proxy. They say WHAT to do.
  Every edge is placed by you, in a measured pause, and heard (sections 3–4).
- Notes can be literally wrong and still clear in intent. On this job: "cut
  3237.2–3240.4" would have removed «Можно» and broken a FAQ question; the slide on
  screen at that moment has the exact wording («Можно вынести копии или DR в другой
  контур?»), which settled where the blade goes.
- **Getting the bundle.** On the board, «Экспорт → Архив для агента» gives the zip. Downloaded in the app's own browser, it sits in Downloads as a `.tmp` that is already the full zip. The user then saves it under its real name, and the two are identical.
- **"Нужно поискать кусок"** means material the draft left out. Transcribe every take that is not in the draft sequence and search the transcripts by content. The first candidates are the takes recorded between the two used takes that surround the gap. On one job, the platform overview and the «поговорим про преимущества» lead-in sat in C017, recorded between the intro (C015) and the next used take (C020). A take the speaker rejected on the recording («…что-то говорю») is not a candidate.
- **The long-file transcript hides restarts.** Whisper drops a repeated phrase: «все системы ERP, 1С, … все системы ERP, 1С, SAP» came out as one list with a 4 s hole. Where a cut note sits, compare the level map with the text: speech islands that no word covers are the retake. Read each island alone with the cloud ASR and keep the clean second take.
- Slide numbers counted **hidden slides** (the reviewer referenced slides 38–40 of
  a deck with only 35 visible). Match slide text against the speech to be sure,
  and export hidden slides too (section 6).

## 2. Transcript without the panel

The panel's cloud Whisper may be down; a local model is better anyway because it
gives every word a time.

```bash
node scripts/mixdown.mjs --clips clips.json --out mix.wav     # every audio clip at its timeline position
python scripts/transcribe_local.py mix.wav out/tr --seq-id <id> --seq-name <name>
```

- faster-whisper `large-v3` on the GPU: 63 min in under 5 min (RTX 5060 Ti).
  On Windows the CUDA 12 DLLs from pip live in `site-packages/nvidia/*/bin` and
  must be added to the DLL path — the script does it.
- **Do not pass `--hotwords` on long recordings.** It halved the output with no
  error (2725 words instead of 8105). Always compare words-per-minute with any
  older transcript of the same material; a quiet deficit is the only symptom.
- `.omc.json` is the panel's transcript format, for importing into the panel.

## 3. Pause map: the threshold is local

```bash
node scripts/scan.mjs --src mix.wav --thresh -50 --min 0.12 --json sil.json
```

- Pick the threshold from the level histogram, not from habit. Here speech sat at
  −40…−30 dB, so the usual −40 dB marked quiet syllables as pauses; the valley
  between floor and speech was −55…−50.
- **Where two microphones carry the same voice** (camera + a screen recording's
  own mic, both left on the timeline), the floor rises from −80 to −60 dB. The
  closure of a stop consonant inside a word then reads as a −55 dB "pause". A cut
  placed in that dip clipped «возни|кнут» — and passed every level check. Measure
  the floor around each edge; in doubled-audio stretches use a lower threshold or
  listen (section 4).
- Whisper word starts after a pause are routinely EARLY (a word stamped inside a
  measured 3 s silence). The envelope decides where speech is.

## 4. Every edge twice: level, then hearing

1. `audio.mjs check --in <t> --out <t> --thresh -50` — the edge is in silence.
2. `scripts/splicecheck.py <mix> --cuts '[[a, b, "label"], ...]'` — transcribes the
   audio **as it will sound after the join** and prints the words either side.
   A word flagged as straddling the join is usually Whisper padding an intact word
   into silence; the real alarm is a word that is **missing** from the text.
3. After the build, rebuild the mixdown from the new sequence's clip list and run
   `splicecheck.py --windows` over ±5 s of every join. This is the pass that found
   the clipped «возникнут»; nothing before it could.

Keep ≥ 0.08 s between a blade and the nearest speech on both sides.

**Hear each piece alone before trusting a mixdown.** When an edit has empty windows
between scenes (room for B-roll), a transcript of the whole mixdown drags words
across the digital silence: the next piece's first word lands at the previous
piece's end and looks like a leak, and the piece itself looks clipped. On one
28-piece canvas that produced nine false alarms. Transcribing each piece's source
range on its own (padded with 0.4 s of silence) separated the five real problems
from the noise.

**Where the blade goes, when whisper's stamps are off.** Word starts after a pause
are stamped early, ends are stamped late, and the first-pass transcript can shift a
whole phrase: a countdown «three, two, one» at a file's head came out as «I came», and
an «okay» sat 0.7 s late on top of the «if» that followed it. Choose the pause from
the envelope: the quiet stretch next to the word, scored by its room minus its
distance from the stamped boundary and never searched further than 0.8 s away —
a wider window finds breaths and laughter seconds off. Then hear every edge in a
3-second window with word times (a fresh transcription of just that window is far
more precise than the long-file pass) and pin the blades that are still wrong.
No repo tool scores pauses this way. `audio.mjs snap` and `snapplan.mjs` take the LONGEST
pause within ±6 s. List the candidates with `audio.mjs pauses --src <mix> --at <t>
--span 1` and choose by hand.

## 5. Rebuild with absolute targets — `scripts/rearrange.mjs`

> **If the new order differs from the old one, clone the result afterwards, or use
> `scripts/assemble.mjs`.** On Premiere 26.3 `move()` leaves the track's item list in
> its original order: a canvas built by park-and-place passed every DOM check while the
> timeline showed it empty and the renderer dropped the video of whole pieces
> (`sequence.end` pointed at the formerly-last clip). On a lecture with one section
> moved, the same state rendered perfect frames — only the panel (V1/A1 empty after the
> moved demo) and `sequence.end` gave it away, and the user saw it before any check did
> («после 41 минуты только слайды»). `scripts/trackorder.mjs` finds it;
> `sequence.clone()` repairs it and keeps every clip's effects. `assemble.mjs` builds
> fresh clips from the project items, so it drops the source clips' effects (there: a
> five-effect audio chain on every A1 clip).

Ripple deletes and insert edits are the wrong tool when a second video track has
content downstream. The host's ripple delete removes the pieces under the range track by
track. On that job a track with nothing under the range was not shifted, so the screen
recording on V2 drifted out of sync with the camera. On 2026-09-25, with host 2.17.0,
`pr.mjs cut` did shift empty V2/V3, and the conditions of the first case are unknown: check
every track after any ripple. `rearrange.mjs` instead razors every track, lifts, and moves
every piece to an absolute target:

- `plan.json`: `razor` times, `lift` ranges, `map` of `{a, b, ns}` (a piece starting
  in `[a, b)` goes to `ns + start − a`). A 3 s gap is an offset in `ns`; moving a
  section is the order of the map.
- Two passes (park past the end, then place) so no move collides; every step is
  idempotent, so a bridge timeout is answered by re-running it. `lift` is batched
  too: removing ~200 pieces in one call ran past the bridge's 30 s cap (the removal
  still finished inside Premiere — confirm with a clip count before re-running).
- `--step test-move` first. **`TrackItem.move(Time)` does NOT drag the linked
  partner on this build** (the panel's own comment claims it does); every audio
  piece is moved explicitly.
- Verify with an expected-vs-actual comparison (every original clip cut at the
  map boundaries and moved with its source range). Exact match or stop.
- **Lengthening a clip:** assigning `trackItem.end` lengthens the timeline item but
  leaves `outPoint` unchanged — an inconsistent clip (67.92 s long, 67.16 s of
  source). Set `outPoint` (a whole `Time` object) explicitly, then `end`.

## 6. Slides on V2 — `scripts/placestills.mjs`

- Deck → PNG: LibreOffice headless → PDF with `ExportHiddenSlides`, then PyMuPDF at
  width 3840. Use `soffice.com`, not `soffice.exe` (the latter never returns in a
  shell) and a throwaway `-env:UserInstallation`. Check one slide at full size for
  fonts before trusting the batch.
- Store the PNGs next to the project, never in a temp folder — they become media.
- `overwriteClip` places a still at the default length; the script trims each by
  assigning a `Time` to `end`, in time order, so a default length only ever runs
  into empty track. A 3840×2160 still on a 3840×2160 sequence lands at Motion 100.
- Snap switch points to a pause after a sentence end. Put the switch exactly on a
  cut where one exists: the slide change hides the jump cut underneath.
- **Replacing the deck in a finished edit.**
  - Map old → new slides by text (python-pptx + difflib), then look at old|new pairs side by side. Numbers shift: a final deck drops hidden slides and whole topics (41 → 32 on one job).
  - Review lists keep counting in the deck the reviewer watched. «Слайд 18» there was a hidden slide that the final deck no longer had.
  - Import the new PNGs into their own bin. Strip only stills whose media path is in the old folder (a screen recording on V2 stays), then place the new set. The `_OLD_` backups keep the old slides.
  - Each slide missing from the new deck is a decision for the user. Mark it, never drop or keep it silently.
- **Removing or shortening a slide exposes the cuts under it.** A full-frame slide hides every jump cut on V1 beneath it. Deleting two slides from one episode turned two hidden cuts into visible jumps on the speaker. List the V1 cuts in every range that loses its slide, and mark them.
- Full-frame slides hide the speaker by design when the notes say "split screen"
  and the instruction is "just put the slide on V2" — say so in the report. But
  look at the timeline before explaining "only slides, no video" away with it: the
  one time a user said that, V1/A1 really were drawn empty (section 5).

## 7. Markers

- Intros/outros, name plates: one marker per event, two events at the same moment
  one frame apart.
- The host cannot create span markers on this build: a plate's duration goes into
  the comment.
- The host lands every marker green whatever `color` says: colour them with
  `scripts/markercolors.mjs` (or by name in JSX) and read the colours back.
- Moving markers in JSX: seconds, not `Time`; assigning `start` moves the whole marker.

## 8. Split into episodes

Clone the verified full edit once per episode, then `rearrange.mjs` with `lift`
outside the episode and `map: [{a, b, ns: 0}]`; set that sequence's in/out and
recreate its markers (a clone carries all of them at the old times).

**An episode edge is a join too — hear it.** Ролик 1 was set to end where slide 8
switched, and that switch fell into the 0.2 s gap between «это» and «DR.»: the
episode ended on «…это» and the next one opened with «DR.». Both edges sat in
silence, so no level check could catch it. Transcribe a few seconds on each side of
every edge on its own (which words are present is reliable even when their stamps
are half a second off) and put the edge in the pause after the sentence's last word.
Then compare every episode with its range of the full edit, item for item.

## 9. Look at the result

- QE `exportFramePNG(timecode, path)` needs a **native** path — build it in JSX
  with `new File('C:/…/name').fsName`; a forward-slash path throws "Unknown error
  exception". Premiere appends `.png`.
- **QE frames at ≥ 1 hour come back from the head of the sequence** (both the
  `01;01;40;00` string and the CTI's own timecode). For a late frame, render a one-frame
  In/Out with the JPEG preset (SKILL.md «Rendering and looking»), or look in the
  per-episode sequences, which are all shorter than an hour.
- The first export after a big rearrange may render a BRAW layer black; export via
  the playhead (`setPlayerPosition`, then `qe…CTI.timecode`) and compare.
- A frame taken after a ripple must be pixel-identical to the frame from before it at
  the old time — compare decoded pixels (`ffmpeg -f rawvideo … | md5sum`): the PNG
  bytes differ even when the image does not.
- Look at the timeline panel as well: `scripts/prwindow.ps1` captures the Premiere window.
- `sequence.end` short of the last clip's end is the broken-track symptom of section 5,
  not a quirk of slides on V2 (that is what it looked like at first) — run
  `scripts/trackorder.mjs`. Compute the last clip end over all tracks before setting
  an out point.

## Appendix: finding retakes in the raw take, before any draft exists

`scripts/scan.mjs` (every pause, one pass) and `scripts/retakes.mjs` (re-recorded
fragments) cover the step before a draft: marking restarts and long pauses in a
single long take.

- **Verbatim restarts:** `findRetakes` seeds on exact n-grams (6 by default) and extends each seed
  along its diagonal, so a restarted paragraph shows up as one long run repeated
  seconds to minutes later. A lecture repeats its own terms all the time; only long
  runs count.
- **Reworded restarts:** `fuzzyRetakes` tests every long pause: does what follows
  restate what was said shortly before? It scores containment of content words,
  not Jaccard, because the second take is usually the shorter one. It is exported
  for import only; the command line runs `findRetakes`.
- **Re-transcribe every Whisper mega-segment (> 8 s) first.** The panel's transcript
  folded a stumble-and-restart into one clean sentence; the retake was invisible
  until that window was transcribed again.
- **Off-mic talk with the director separates by level:** the speaker's lav sat
  around −39 dB, the director at −55 dB and below. Cluster the quiet segments into
  blocks and read them before calling them chatter.
