# Screen-shared lecture → one sequence per slide

For a recorded lecture where the lecturer **screen-shares a PDF deck** and the
deliverable is one sequence per presentation block, junk removed, named after the
slide. Verified end-to-end on four ~2 h modules (37, 45, 25 and 28 blocks).

The whole method rests on one division of labour:

| source | answers | tool |
|---|---|---|
| the deck on screen (pixels) | **what** block this is, and its rough extent | `slidetrack.py` |
| the transcript (semantics) | **where** the speaker actually crossed a boundary, and what is junk | `slidealign.py`, `trwin.py` |
| the waveform | **which frame** the blade lands on | `audio.mjs`, `snapplan.mjs` |

None of the three is sufficient alone, and each fails in a way the other two catch.

## Why not the obvious shortcuts

**Do not infer boundaries from the sequence's scene-detect cuts.** Scene detection
fires on animation and camera moves and misses visually similar consecutive
slides — neither sound nor complete. The hypothesis "a scene cut ≈ a slide change"
is right often enough to be dangerous.

**Do not trust the deck alone.** A lecturer talks over a slide long after advancing
it, advances two at once, skips the divider, or codes in a notebook for twenty
minutes with no slide on screen at all. In module 7 the slide track was silent for
19 of the 25 blocks' worth of the middle hour.

**Do not trust Whisper's timings.** They drift by seconds and its paragraph
boundaries are merged blobs. Use it for MEANING only.

## 1. Track which slide is on screen

    python scripts/slidetrack.py calibrate --deck D.pdf --src V.mp4
    python scripts/slidetrack.py track --deck D.pdf --src V.mp4 --out m7.json --views "<views>"

A VIEW says "this rectangle of the video frame shows that rectangle of the deck
page": `fw:fh:fx:fy@pw:ph:px:py`, page coordinates in a 960×540 space.

**A screen share is never full-frame, and the page is often CLIPPED.** Correlating
the whole 1920×1080 frame against the whole page matched 0 % here. That is why a
view carries a page rectangle too.

**The overlay bars are the trap.** These recordings have a macOS menu bar at
y 0–27, the PDF viewer's toolbar at 27–56, and a black "Screen: <name>" banner
starting at y≈1053. `calibrate` only clips views at the FRAME edge (1080), never at
1053, so every candidate geometry correlated a page against a crop containing that
banner. Result: every geometry scored ≈0.50 and picked the wrong page. Clipping the
visible band to [56, 1053] took the same frames from 0.30 to **0.97**.

So when calibrate's best score is ~0.5 across the board, do not accept it — grab a
frame, look at it, measure where the page actually sits, and search a band that
excludes every overlay.

## 2. Sweep the scroll offset

macOS Preview in **continuous-scroll** mode does not put a page turn back in the
same place: after every turn the page sits a few dozen pixels higher or lower.
A single view built from one calibration frame matches only the slides that happen
to share that offset — modules 7 and 8 scored 11 % and 22 % that way.

    python scripts/scrollviews.py --w 1850 --x 35 --top 56 --bottom 1053

The page is always the same width at the same left edge; only its top edge Y moves.
`scrollviews.py` sweeps Y and emits one view per distinct geometry. Offsets that
keep the page over the whole visible band share ONE frame rectangle, and
`slidetrack track` groups views by frame rectangle so each distinct crop is decoded
once — twenty views cost nine decodes, not twenty. Modules 7 and 8 went to 40 % and
51 % matched at median correlation 0.94/0.93, and the "no slide" stretches that
remain are genuinely notebook work.

**Downsample by AREA, never by picking pixels.** Nearest-neighbour decimation of
1780 px-wide slides to 256 px destroys the text strokes the match depends on and
silently halves every score. `Image.BOX` / ffmpeg's `scale` do the right thing.

## 3. Read slides, deck text and transcript together

    python scripts/slidealign.py --track m7.json --deck-json decks.json --module 7 \
        --tr tr7.json --out m7_align.md --min-run 8

Runs shorter than `--min-run` are folded into the neighbour: a one-second blip is a
page turn caught mid-animation, not a block. The output is markdown, meant to be
READ, not parsed.

Where the align doc says НЕТ СЛАЙДА for twenty minutes, the boundary exists only in
what is being SAID. Dump the window and find the sentence:

    python scripts/trwin.py --tr tr7.json --from 6800 --to 7260
    python scripts/trwin.py --tr tr7.json --grep "идем"

The transitions that actually mark a block boundary are of the form
"идемте дальше", "переходим к части N", "давайте откроем ноутбук". Beware: the same
words occur constantly WITHIN a notebook ("давайте пойдем дальше, это пропустим")
and mean nothing there. Read enough context to tell the two apart.

## 4. Build the plan

```json
{
  "module": "7",
  "sequenceId": "…", "sequenceName": "Модуль 7", "sequenceEndSec": 7755,
  "src": "…/Модуль 7.mp4", "deck": "…/module_7_embeddings_presentation.pdf",
  "pinned": [7406.8], "pinnedWhy": { "7406.8": "…" },
  "dropped": [ { "keep": [[0, 719.4]], "why": "приветствия, техчат" } ],
  "blocks": [
    { "n": 1, "title": "…", "pages": [1,2,3], "keep": [[719.4, 935.0]],
      "merged": "p1 8 с — заставка, склеена вперёд",
      "marker": { "at": 1789.5, "name": "СПОРНО: …", "comment": "…" } }
  ]
}
```

Rules that came out of doing this four times:

* **Divider and title slides are not blocks.** A "Часть 3" screen held for 8 seconds
  merges into the block that follows it; a "Спасибо за внимание" held for 20 s merges
  backwards. Record which, and why, in `merged` — that note is the only trace left
  once the sequence exists.
* **Q&A inside a block stays.** Questions from the room about the thing on screen are
  part of the block. Only the head (waiting to start, mic checks, unrelated chat) and
  the tail (open Q&A after "Есть ли вопросы?") get dropped.
* **Every boundary that came from the transcript rather than the pixels gets a
  `СПОРНО:` marker** saying so, with the sentence it was taken from. Same for a block
  whose slide the tracker never matched. This is what the user reviews.
* A block may have several `keep` intervals — that is how a mid-block junk stretch
  (a demo that fell over, a tangent about the pace of the course) is removed.

## 5. Verify the plan on pixels BEFORE cutting

    python scripts/planverify.py --plan m7_plan.json --out m7_plan_check.png --cols 5

One cell per block: the video frame a few seconds after the boundary on the left,
the deck page the block claims on the right. They must be the same slide.

This catches what correlation cannot. In module 8 it showed that the slide the
tracker never matched (p15 HyDE, p29 "не серебряная пуля", p36 homework) really WAS
on screen — confirming those transcript-derived boundaries — and that one boundary
sat in the middle of a scroll, with the previous page's tail still above the fold.

Read the sheet in row-sized crops; 25 cells at once is unreadable.

## 6. Snap every boundary to a pause

    node scripts/snapplan.mjs --plan m7_plan.json

Adjacent blocks SHARE a boundary, so each distinct time is snapped once and written
back everywhere it appears — otherwise a snapped end and an unsnapped start open a
gap or an overlap.

**Review every move larger than ~2 s against the transcript.** The snapper prefers
the LONGEST nearby pause, which is regularly the wrong one:

* it lands 4 s early, inside the tail of the previous sentence;
* it lands 5 s late, past the very sentence that OPENS the block
  ("Переходим в наш ноутбук…", "Давайте я быстренько пробегусь по гибридному
  поиску…", "Итак, первый сценарий — Single Rewrite");
* at the end of a lecture the longest gap sits before the closing sentence, not
  after it.

When it is wrong, find the real pause with
`node scripts/audio.mjs pauses --src <media> --at <t> --span 6`, put the number in
`pinned`, and write the reasoning into `pinnedWhy`. Ten of the ~110 boundaries
across four modules needed this.

Note that a Whisper paragraph is a merged blob: it will happily report continuous
speech across a 3 s silence. Where the waveform and the transcript disagree about
where speech ends, the waveform is right.

## 7. Cut

    node scripts/blockcut.mjs --plan m7_plan.snapped.json --dry-run
    node scripts/blockcut.mjs --plan m7_plan.snapped.json

Each block becomes a CLONE of the source sequence with everything outside its keep
intervals ripple-deleted, named `<module>_<nn>_<title>`. Cloning rather than cutting
the original is the whole point: the source sequences are the only copy of the
scene-detect edit and a ripple delete cannot be undone programmatically. Take a
`pr.mjs backup` of the source anyway before the first run.

Two things that will bite if changed: ripple deletes are applied HIGHEST-FIRST, and
marker times are given in SOURCE time in the plan but must be written in the clone's
time (source time minus everything removed before them).

A ~2 h module takes a few minutes per block; the bridge times out at 120 s while the
edit keeps running, so `blockcut` re-reads the sequence length to find out what
actually happened. Run it in the background and check the log.

## 8. Verify the result

Read back, per created sequence: clip count, the COLLAPSED source ranges (merge
adjacent clips whose in/out touch), and the markers. Assert the collapsed ranges
equal the plan's `keep`, and that every source sequence still has its original
duration. A length match alone will not catch a block cut from the wrong place.

**Also reset each clone's in/out.** A clone inherits the SOURCE sequence's in and
out points, so a 40 s block still carries `out = 8811 s` — and some sources carry
the unset sentinel `in = -400000`. Nothing in the timeline looks wrong and the
collapsed-range check passes, but every export and every work-area operation then
runs over two hours of nothing. Per block sequence: `setInPoint(0)` and
`setOutPoint(Number(seq.end) / 254016000000)`. Batch it by module — `evalJson`
gives up at 30 s.

That proves the ripple delete removed what it was told to. It says nothing about
whether what it was told to remove was right. Three more checks, cheapest first,
and none of them subsumes the others:

    python scripts/planverify.py --plan m7_plan.snapped.json --out m7_check.png
    node scripts/edgecheck.mjs --plan m7_plan.snapped.json
    node scripts/edgetext.mjs --plan m7_plan.snapped.json --tr tr7.json

**Pixels** — does each block open on the slide it is named after. **Waveform**
(`edgecheck`) — does any blade land inside a word. **Wording** (`edgetext`) — does
each block open and close on a complete thought.

`edgecheck` reports, for every DISTINCT boundary, how far the nearest speech is on
each side, and only on the side that survives into a sequence: at a module's last
boundary the speech starting 0 ms later is the Q&A being dropped, and flagging that
would be flagging the edit for working. Two details keep it honest:

* Speech is FOUR consecutive windows above threshold, not one. These recordings
  carry isolated 20 ms transients — a mouse click, a chair — sitting 60 dB above the
  room tone. One loud window counted as speech reported a blade "cutting speech" in
  the dead centre of a 1.3 s pause.
* A boundary sitting in a long pause is never wrong *here*. It can still be wrong
  semantically, which is what `edgetext` is for.

`edgetext` prints the tail of what the previous block keeps and the head of what the
next one opens with. It is meant to be READ, not parsed — Whisper's timings drift by
up to a second and its segments overlap, so a segment is included whenever it touches
the window at all. The point is the wording, not the timing. This is the only check
that catches a boundary landing in a clean 100 ms gap that is nonetheless the middle
of a sentence: one block ending on "но прежде чем", the next opening on "перейти к
синтаксису". Boundaries taken from the slide track are the usual culprits — a
lecturer who advances mid-sentence puts the page change there, not at the thought
change.

When `edgecheck` flags a boundary, dump the envelope at 10 ms before believing a
proposed replacement: a dip to −40 dB between two words looks like a gap at 20 ms
resolution and is not one. And accept that some flags are real and unavoidable — a
speaker who rushes can leave a 50 ms inter-sentence gap as the widest one available.
Record that in `pinnedWhy` and leave the flag standing rather than loosening the
threshold.
