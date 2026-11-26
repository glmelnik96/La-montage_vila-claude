# Vertical reels from a flattened multicam master

How to turn a long multi-camera interview export into a set of self-contained
vertical reels, without clipping words and without framing anyone off-screen.

## The shape of the source

A "flattened multicam master" is one rendered file on the timeline, already cut
between angles. **Every clip boundary on that timeline is a real camera switch** —
that is the single most useful fact about this footage. You never have to detect
cuts; the sequence already tells you where they are, and each clip is by
definition one angle held for its whole duration.

Check whether timeline time equals source time before relying on either:

```bash
node scripts/shots.mjs --src <media>   # prints tl vs src per clip
```

If they are 1:1 you can use one set of numbers throughout. If they are not, keep
the two coordinate systems apart in your head — the panel's cut operations take
TIMELINE seconds, while ffmpeg takes SOURCE seconds.

## Step 1 — find the angles by looking

`shots.mjs` renders one frame per clip into a numbered contact sheet. **Read it.**
Do not port a classifier from another project: the lighting, seating, number of
angles and which side each person sits on change with every shoot.

What you are extracting from that sheet:
- how many distinct angles exist, and a label for each (`A`, `B`, `W`, …);
- for each angle, `u` — the horizontal centre of the face as a **fraction of the
  source width**, and `v` if the face is not vertically centred.

Estimate `u` off the sheet, then confirm it by rendering the actual crop:

```bash
node scripts/shots.mjs probe --src <media> --at 4500 --u 0.61 --scale 88.889
```

Adjust `u` until the face sits where you want it. Two or three iterations is
normal. This is cheap and it is the only way to get `u` right.

Labelling an angle "host" or "guest" from clothing is a guess. Confirm it against
the edit: in a flattened master the camera follows the speaker, so find a
question/answer handover in the transcript and check that the angle changes on
it. Confirm the speaker identity against the same source window before labeling angles.

Once you know what each angle looks like you can classify the remaining clips
however you like (sampling pixels for a distinctive lamp, a colour, a luma
imbalance) — but **spot-check the classifier against the contact sheet**, and
treat any per-project thresholds as disposable, not as part of this skill.

## Step 2 — choose reel boundaries from the waveform

Read the transcript to decide **what** a reel is about. Never use it to decide
**where** to cut. Whisper's segment timings drift by tenths of a second, which is
several frames, which is a sliced syllable.

```bash
node scripts/audio.mjs pauses --src <media> --at 2524 --span 8
node scripts/audio.mjs check  --src <media> --in 2524.52 --out 2557.16
```

Aim the blade at the **middle of a pause**, which leaves the most margin on both
sides. `check` reports the level at the cut and how far to move to centre it.

**Measure at 5 ms, not 50 ms.** A 50 ms window that starts at the cut averages
50 ms of what comes *after* it, so a clean cut placed just before a loud syllable
reads as loud itself. This produced a confident "−18.3 dB, cutting into a word"
alarm on a boundary that was actually sitting in a 70 ms gate. `audio.mjs check`
reports both resolutions and decides on the fine one; trust `fineDb`.

### Check the whole utterance after snapping

Before rendering an interview select, review every IN and OUT and both sides of
each internal deletion. Use word-level ASR of the original with at least one
sentence of context on each side. For an excerpt pass the source second of its
first sample as `--origin`; a full-master transcript starts at zero. Pass the
source seconds from the acoustic check, in increasing IN,OUT pairs.

```bash
node scripts/utterance.mjs --src master.mp4 --words excerpt.words.json --origin 150 --cuts 154.52,162.88,165.40,176.12 --out review.json
```

Read each edge's timed `before` and `after` words, and the `retainedTail`,
`omitted` and `retainedHead` at each join. Confirm who is speaking, what each
pronoun refers to, and whether the retained answer completes the question or
claim. Review short codas after the first full stop. A quiet cut can still follow
an unfinished conditional or drop a qualification. Punctuation comes from ASR.
The tool flags possible cuts inside words and open clauses, and proposes nearby
punctuated alternatives with a measured pause on the source clock. Missing
surrounding words produce `unknown`; obtain wider context or verify the source
by ear. Choose the boundary that conveys the intended point. Quantize to real
source frames, recheck audio and play across the edited join. Record the first
estimate, any changed boundary and the reason in the edit notes.

### When Whisper collapses 30 seconds into one segment

Sometimes a segment arrives with a single start/end spanning half a minute of
speech. A boundary inside it cannot be checked against the transcript at all —
several sentences, often a speaker change, hidden behind two numbers. Find these
before trusting any boundary, then reopen each one:

```bash
node -e "…segments.filter(s => s.endSec - s.startSec > 8)"   # then, per window:
python scripts/rewin.py <media> 374 394
```

A mislabeled pause can trim a reaction, cut off a premise or include a part of the adjacent
question. Re-read the words with `rewin.py` and use `audio.mjs` to place the boundary.

### Re-read every boundary in context before you call a reel finished

Hunting mega-segments is not enough, because the full-file pass drifts on
*ordinary* segments too. Sweep all boundaries at the end, re-transcribing a
±6 s window around each and printing the words that fall either side of the
blade:

```python
ws = words(t - 6.5, t + 6.5)
before = ' '.join(w for w in ws if w.end <= t)     # what the reel throws away
after  = ' '.join(w for w in ws if w.start >= t)   # what it opens on
```

Read the two strings. A reel must open on a sentence start and end on a sentence
end; anything else is a defect no numeric check can see.

Read every segment from the perspective of a new viewer. Check for a missing premise and shared boundaries that leave half a sentence in each reel.

Judgement call at the head of a reel: a soft consonant onset (a nasal, a fricative)
at around −30 dB is usually worth keeping rather than moving the cut a frame
earlier, because one frame earlier often belongs to the *previous camera* and a
single frame of the wrong angle is more noticeable than 20 ms of soft attack.

## Step 3 — build each reel in a duplicate

Clone the master, ripple-delete everything outside `[start, end]`, then reframe.
The master is never edited.

Ripple-deleting the head and tail of a 1200-clip sequence takes several minutes
and **will exceed the bridge timeout**. See «Host scripting» in SKILL.md — poll,
never re-issue. After the cut, assert the surviving source range matches your
intended `[start, end]` before applying Motion to anything.

Name the intermediate `_wip <reel name>`. **Do not delete these when you are done.**
Finishing a task is not authorisation to tidy up: they are the only record of what each
reel was cut from, rebuilding one costs another multi-minute ripple delete, and they cost
nothing to keep. Report that they exist and let the user decide.

## Step 4 — the reframe arithmetic

Use `scripts/vframe.mjs`; do not do this in your head.

```bash
node scripts/vframe.mjs --src <media> --scale 88.889 --u 0.61
# source 3840x2160  frame 1080x1920
# scalePct 88.889 -> drawn 3413x1920
# visible  31.6% of source width, 100.0% of source height
# posX 0.1523  posY 0.5
```

Two facts that are easy to get backwards:

- **`scalePct` is not the visible fraction.** Scale 100 draws the source at native
  pixel size; the frame is a window onto it. At `scalePct 88.889` a 3840-wide
  source is drawn 3413 px wide and the 1080-wide frame shows `1080/3413` = **31.6 %**
  of the width. Read `visible` from the tool rather than reasoning from `scalePct`.
- **Position moves the image, so it is inverted** relative to the point you want to
  see, and it is scaled by how much larger than the frame the image is drawn:

  ```
  posX = 0.5 − (u − 0.5) · (srcW · scalePct/100) / 1080
  posY = 0.5 − (v − 0.5) · (srcH · scalePct/100) / 1920
  ```

  Values outside `0..1` are normal and legal (the property accepts `-5..5`).
  Framing a face near the edge of a pushed-in wide shot genuinely needs `posX ≈ 2`.

Starting points: for a landscape source, `scalePct = 1920/srcH · 100` fills the
frame height and crops the sides — 88.889 for 2160-tall, 177.8 for 1080-tall.
A wide two-shot usually needs pushing in past that (e.g. 133 on 4K, a 1.5× push)
so the chosen face is not a speck; that crops the height too, so give it a `v`.

## Step 5 — frame wide shots by their neighbours

A wide two-shot in this kind of edit is a **brief cutaway while somebody keeps
talking**. It must be framed on the person the surrounding close-ups are on.

Picking one "dominant" camera per reel is wrong, and fails silently: in a reel
whose angles tallied 6:6, the tie-break put four wides on the guest while the host
was mid-sentence. `vframe.mjs plan` implements the correct rule — walk outward
from each wide clip to the nearest non-wide neighbour and use that speaker's `u`.

```bash
node scripts/vframe.mjs plan --src <media> \
  --clips gen-out/tmp/clips.json --map gen-out/tmp/map.json \
  --name "Reel 1" --from "_wip Reel 1"
```

`map.json` keys the framing per angle, with `W_A` / `W_B` for the wide resolved
against each neighbour:

```json
{
  "A":   { "u": 0.61 },
  "B":   { "u": 0.41 },
  "W_A": { "u": 0.771, "v": 0.4832, "scale": 133 },
  "W_B": { "u": 0.177, "v": 0.4832, "scale": 133 }
}
```

## Step 6 — verify on pixels

```bash
node scripts/checkreframe.mjs --src <media> --seq "Reel 1"
```

This reads the Motion values Premiere **stored**, inverts them into a source
rectangle, crops that rectangle from the media and tiles one frame per clip.
Read the image.

Matching numbers prove only that the numbers matched. The wide-framing bug above
passed every numeric check — it was visible immediately on the contact sheet and
invisible everywhere else.

## Auditing a finished reel

Worth checking on every reel, cheaply, in one pass over the sequences:

- video and audio clip counts equal, and identical source ranges (a drifted audio
  track means a ripple delete hit one track only);
- zero gaps between consecutive clips;
- surviving source range is contiguous and its head/tail equal the planned
  `[start, end]` exactly;
- frame size, and `in = 0` / `out = own end` (clones inherit the master's);
- Motion present on every clip, at one of the scales in your map;
- clips shorter than ~3 frames.

This whole list is structural. Passing it says nothing about whether the reels
make sense — see "Re-read every boundary in context" above, and run that too.

On short clips: **not every short clip is a defect.** A 2-frame clip at the head
of a reel is usually a flash frame of the previous angle and should go. A 7-frame
clip at the tail may be the master's own cut to a wide with the last word still
running underneath it — removing it costs you the word, and you cannot extend its
neighbour, because in a flattened master the cuts are already baked into the file.
Check the audio under the clip before deleting it.
