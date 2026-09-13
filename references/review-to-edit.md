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

## 5. Rebuild with absolute targets — `scripts/rearrange.mjs`

> **If the new order differs from the old one, use `scripts/assemble.mjs`, not this.**
> On Premiere 26.3 `move()` leaves the track's item list in its original order: a
> canvas built by park-and-place passed every DOM check while the timeline showed it
> empty and the renderer dropped the video of whole pieces (seen only on an exported
> frame; `sequence.end` pointed at the formerly-last clip). Inserting the pieces in
> ascending time into an emptied clone of the source sequence builds a clean track.
> Check a rendered frame inside a piece that came from late in the source.

Ripple deletes and insert edits are the wrong tool when a second video track has
content downstream: the host's ripple delete removes the pieces under the range
track by track, so a track with nothing under the range is not shifted and the
screen recording on V2 drifts out of sync with the camera. `rearrange.mjs` instead
razors every track, lifts, and moves every piece to an absolute target:

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
- Full-frame slides hide the speaker by design when the notes say "split screen"
  and the instruction is "just put the slide on V2" — say so in the report, or
  the user reads "only slides, no video" as a broken timeline.

## 7. Markers

- Intros/outros, name plates: one marker per event, two events at the same moment
  one frame apart.
- The host cannot create span markers on this build: a plate's duration goes into
  the comment.

## 8. Split into episodes

Clone the verified full edit once per episode, then `rearrange.mjs` with `lift`
outside the episode and `map: [{a, b, ns: 0}]`; set that sequence's in/out and
recreate its markers (a clone carries all of them at the old times).

## 9. Look at the result

- QE `exportFramePNG(timecode, path)` needs a **native** path — build it in JSX
  with `new File('C:/…/name').fsName`; a forward-slash path throws "Unknown error
  exception". Premiere appends `.png`.
- **Frames at ≥ 1 hour come back from the head of the sequence** (both the
  `01;01;40;00` string and the CTI's own timecode). Verify late frames in the
  per-episode sequences, which are all shorter than an hour.
- The first export after a big rearrange may render a BRAW layer black; export via
  the playhead (`setPlayerPosition`, then `qe…CTI.timecode`) and compare.
- `sequence.end` reported the end of the **topmost occupied video track** (the last
  slide), not of the sequence. Compute the last clip end over all tracks before
  setting an out point.

## Appendix: finding retakes in the raw take, before any draft exists

`scripts/scan.mjs` (every pause, one pass) and `scripts/retakes.mjs` (re-recorded
fragments) cover the step before a draft: marking restarts and long pauses in a
single long take.

- **Verbatim restarts:** `findRetakes` seeds on exact 5-grams and extends each seed
  along its diagonal, so a restarted paragraph shows up as one long run repeated
  seconds to minutes later. A lecture repeats its own terms all the time; only long
  runs count.
- **Reworded restarts:** `fuzzyRetakes` tests every long pause — does what follows
  restate what was said shortly before? It scores containment of content words,
  not Jaccard, because the second take is usually the shorter one.
- **Re-transcribe every Whisper mega-segment (> 8 s) first.** The panel's transcript
  folded a stumble-and-restart into one clean sentence; the retake was invisible
  until that window was transcribed again.
- **Off-mic talk with the director separates by level:** the speaker's lav sat
  around −39 dB, the director at −55 dB and below. Cluster the quiet segments into
  blocks and read them before calling them chatter.
