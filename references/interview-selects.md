# Raw interview day → selects per speaker, a question card before each answer (Workflow F)

Use this when a sequence holds hours of raw interview takes of several people. The takes
start and stop per question, and include retakes and crew talk. The deliverable is one
sequence per speaker: an editable title card with the question, then the chosen answer, with
junk and failed takes removed. It was verified on a four-hour day: 171 BRAW clips, 12
speakers, 107 cards, 155 answer pieces.

## 1. Who is where: look

- Build a throwaway sequence with 1 s from the middle of every clip (`assemble.mjs` rows of
  1 s), then render frames from it.
  - QE frames past one hour come back from the head of the sequence, so use the JPEG route
    in SKILL.md «Rendering and looking».
- BRAW: ffmpeg reads the audio (pcm_s24le) but not the picture, so frames come only out of
  Premiere.
- Speakers sit in contiguous runs of clips. Check the name spellings against the document,
  not against the ASR.

## 2. Transcribe in the cloud, by phrase: `scripts/cloudtr.mjs`

The panel's cloud transcription (Cloud.ru `whisper-large-v3`) silently drops whole 30 s
windows of a long clip. On 7 of 171 clips it lost the first half of an answer, an
introduction, or everything but the question. The endpoint also answers `words: null`, so
there are no word times.

`cloudtr` cuts each clip at its own pauses into phrase groups and sends each group alone.
The groups are usually 3–15 s. Speech with no pause is split near every 20 s, so a group can
reach 25 s. Nothing is dropped, and every chunk edge is a pause a blade can use.

- Extract the audio once, 16-bit mono: `ffmpeg -i <clip> -map 0:a:0 -ac 1 -ar 16000 C001.wav`.
  Other formats are refused. Then pass `--wav-dir`. Only files named `C<digits>.wav` are
  read.
- A chunk's TEXT can miss its first or last word while the audio has it: read both
  neighbours.
- A failed request never becomes empty text. The clip gets no file and the run exits 1; a
  re-run picks it up.

## 3. Read every speaker end to end and write a plan

The plan: `{q, src, pieces:[[firstChunk, lastChunk, {start|end anchors}]], note}`.

- Take the best complete take per question, usually the last one the crew accepted.
- Assemble answers from pickups where the speaker re-said a sentence.
- Honour decisions made on set: «Концовку убираем», «это можно вырезать», «Давай выкинем
  вопрос».
- Cut the question itself out.
- Card text is the question as the interviewer asked it on camera; the interviewer reads
  from a newer list than the document. Use the document's wording only when the question is
  not on the recording.
- Record the alternatives and the cuts in the marker note.

## 4. Cuts inside a phrase group: `scripts/cloudsplit.mjs`

It tries the quiet dips nearest to the word and keeps the one whose PREFIX transcript ends
with the given word.

- The LAST word must match. A match on the second-to-last word comes back `ok:false,
  loose:true`: that cut is one word late (a cut after «…работодателя. А»). Decide it by hand.
- Short words need an exact match.
- Latin never matches Cyrillic («Atlas»/«атлас»). Pass `after` the way the model spells it.
- A chunk's `text` puts the first guess where the word should be.
- When the model does not hear the anchor, measure the gap on a 5–10 ms level map and pin
  `t`.

## 5. Read every edge back: `scripts/cloudedges.mjs`

Then check every join, rendered from the plan with 4 s either side. This pass found:
- the interviewer's «угу»/«да» at chunk edges;
- a next question glued to the end of an answer;
- «Для»/«Совет» of the next sentence left on a tail;
- a word's first syllable cut off.

Trim edges by hand to SUSTAINED speech: 8 of 10 frames over the threshold, not the first loud
frame. A click is loud too. A failed request is reported as `error` on the piece, never as a
clean-looking empty edge.

## 6. Cards: `scripts/mogrtcard.py`, one .mogrt per card

ExtendScript cannot set a graphic's text: `Source Text` reads back as one garbage character,
and a Premiere-authored .mogrt has no MGT parameters. So the text goes into the template
before import. The script header documents where it lives inside the .mogrt.

- Every card gets a fresh `capsuleID`.
- `--template` points at another Premiere version's `Basic Title.mogrt`.
- After `sequence.importMGT(path, ticks, 0, 0)`, set `end`.
- Centre the block: Text › Position y = 0.5165 − (lines−1)·0.0356, at 34 characters a line.

## 7. Build per speaker

1. Clone an EMPTY template: a clone of the RAW, emptied.
2. Place the cards first, then the pieces with `assemble.mjs`.
3. Markers:
   - name: the question;
   - comment: the note and the sources;
   - colour: the source. Green means asked on camera, orange means worded from the
     document, blue marks an introduction.
4. Verify against the plan:
   - position, in-point and end;
   - the A1 partner;
   - no holes;
   - list order and marker count.
5. `importMGT` drops a card now and then (4 of 107).
   - Re-import the missing cards.
   - Then re-run `assemble.mjs --step place`: the card's 4.92 s default length ate the head
     of the next answer.
6. Look at a frame of every card and every piece.
7. Set every sequence's In/Out to `[0, end]`. Twelve clones of a RAW with In/Out over four
   hours would each export four hours of black.

## 8. Transcripts of the finished pieces (one document per speaker)

Run `cloudtr.mjs --pieces` with a names-and-terms prompt per speaker. The prompt turns
«Семдиби» into CMDB and gets every surname right.

- **Each phrase is read twice**, with and without the prompt. On a quiet phrase the context
  invents text: «будут в следующем году» for «останутся фундаментальными». The tool keeps the
  reading with the better duration-weighted log-probability; the prompted one wins a near
  tie.
- **A punctuated reading beats an unpunctuated one** of similar length.
- **A long unpunctuated phrase never becomes context.** That style spreads down a whole
  answer: 10 % of phrases on one job.
- **Phrases the tool flags `sparse` came back nearly empty in both readings.** It happens to
  a 20 s phrase with no pause. Re-read them in ~7 s windows: a `--pieces` run over
  sub-ranges.
- **The result file is rewritten after every piece.** `--resume` skips the keys it already
  holds; a failed piece carries `error` and the run exits 1.
- **Word files: `docx` (npm).**
  - The question is the heading; the answer is in paragraphs broken only where a sentence
    ends.
  - Each paragraph carries the sequence timecode and the source clip.
  - Run the builder from a folder with `npm install docx`; the repo itself has no
    dependencies.
