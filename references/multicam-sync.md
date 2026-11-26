# Cameras + a separate audio recorder → one synced stack (Workflow G)

Use this for podcasts, interviews or any multicamera shoot with camera guide audio and a
separate recorder. Start offline from the actual source files. If the recorder takes have
already been positioned on a sequence, copy those positions into the manifest.

## Offline measurement

From the editing skill root, run:

```sh
python scripts/podcastsync.py path/to/session.json --out path/to/sync-report
```

Requires Python with NumPy and SciPy, FFmpeg on PATH and temporary disk space for 16 kB/s
per recorder take plus the longest camera guide. FFmpeg must be able to read the audio.
It can extract guide audio from the original camera file, including supported BRAW audio.
Alternatively use an audio export that keeps the camera's start and the selected duration.
The tool accepts UTF-8 JSON. Relative paths resolve against the manifest's directory.

```json
{
  "fps": "30000/1001",
  "takes": [
    {"id": "take-01", "file": "sound/t01-mix.wav", "timelineStartSec": 100},
    {"id": "take-02", "file": "sound/t02-mix.wav", "timelineStartSec": 1200}
  ],
  "cameras": [
    {"id": "A-001", "file": "camera-A/a001.mov"},
    {"id": "B-004", "file": "audio-exports/b004.wav", "audioStartSec": 2.0}
  ]
}
```

- `fps` is the **sequence** rate. Use the exact rational for fractional rates.
  `timelineStartSec` is the sequence position of recorder source time zero, relative to the
  sequence origin, in seconds. For a trimmed timeline item it is `timeline start − source in`.
  A missing timeline origin still permits relative sync. Include one entry per distinct recorder take.
- `audioStartSec` is the **source** time of the first decoded audio sample (default 0).
  Set it on trimmed guide exports or when the selected stream starts later than the first
  source video frame. Container start PTS and time-of-day timecode are not inferred.
  Select a zero-based audio `stream` or a zero-based `channel` within it if necessary.
  By default FFmpeg downmixes the first audio stream. Select a clean mic on phase-cancelling mixes.
- Optional camera fields `"clockGroup": "camera-A-day1", "timecodeSec": 45417.2` enable
  suggestions for unresolved clips. Supply source-start timecodes converted to seconds at
  their native timecode rate. Group only a single continuous free-running camera clock.
  Unwrap midnight within a group or start a new group after a reset. Use drop-frame conversion
  when the recording uses DF labels. The closest independently matched clip in the group
  (over 100 s, at least three agreeing windows covering 70% of those checked) supplies the
  take and anchor offset.
  The report shows the anchor, timecode delta, suggested position and any local waveform
  peaks within ±1.2 s. Suggestions retain the original acoustic status and stay out of placements.
  Check which take was recording when the estimate lands in an adjacent take or a gap.
- For each camera and every take, the tool compares energy envelopes and verifies up to
  three distinct lag peaks with band-limited waveform correlation. It samples up to 13
  spaced windows and checks that their local lags agree. A high envelope similarity alone
  cannot place a clip. The confidence evidence includes envelope NCC, agreeing/tested
  window counts, median peak-to-sidelobe ratio and maximum residual in ms. They are
  measurements, not a probability.
- Open `podcastsync.md` for the placement list and manual review. `podcastsync.json` includes
  per-take candidates, local lags, residuals and rounding. `matched` means one verified
  position across all available takes. `ambiguous` means more than one passes, including
  repeated content within one take. `unconfirmed` covers silence, weak or insufficient
  overlap. `incomplete` means a recorder file was unavailable and a unique answer could
  not be established. A camera decode failure is `unavailable`. Only a unique match with a
  known timeline origin yields a frame. Exit 0 means all cameras matched, 1 has rows to
  review, 2 means the command could not complete.
- Time mapping is `recorderSourceSec = offsetSec + cameraSourceSec * (1 + driftPpm / 1e6)`.
  A camera starting 3 seconds before its recorder has `offsetSec = -3`.
  The sequence position of camera time zero is `timelineStartSec + offsetSec`. The nearest
  frame is zero-based. `roundingMs` is rounded minus exact. Drift requires at least three
  agreeing windows spanning ten seconds and a sufficiently narrow 95% slope interval
  across pairs of windows. A null value means there is insufficient evidence
  to estimate it. `driftAcrossGuideMs` estimates the accumulated shift over the guide duration.
  Moving microphones and room acoustics can influence local lags. Inspect late and early
  dialogue before applying any time stretch.
- If a candidate is unresolved, audition the competing windows, check camera slates/timecode
  and try a cleaner microphone or a longer guide export. Distinct ISO microphones carrying
  the same take can intentionally match the same sound. To compare alternative microphones,
  rerun with a different channel or mix under the same take ID in a separate manifest.
  With many repetitions, only three coarse peaks per pair are tested. Review repeated cues,
  restarts, internal audio edits and timecode-only placements manually.

## Placing and checking the Premiere stack

The following describes an earlier job with three 25p BRAW cameras and four
recorder takes. Its manual timecode and alternate-mic steps are available when the
offline measurement leaves a clip unresolved. The historical scripts and placements are
in the local job's `gen-out/mc/`. Use a newly named clone for an authorized live assembly.

- **Scratch audio** of every camera clip, and every recorder take (Stereo Mix, Mic 1, Mic 2),
  was available for the project-specific check as 16 kHz mono WAV.
- **Each take's position** on the timeline.
- **Each clip's start timecode.** BRAW timecode is free-run time of day, so it is a good prior
  across cameras but not a sync on its own.

### Historical alignment and live verification

1. **Coarse alignment.**
   - Build a 200–4000 Hz log-energy envelope at 100 Hz and subtract a 2 s running mean.
   - Cross-correlate it against every take with at least 15 s of overlap.
   - The best peak gives the take and the lag.
2. **Timecode as a prior.**
   - Long clips (over 100 s, correlation above 0.8) anchor each camera.
   - Any clip's predicted offset is its nearest same-camera anchor's offset plus the timecode
     difference.
   - If audio and timecode agree within 0.6 s, search ±0.3 s; otherwise search ±1.2 s around
     the timecode.
3. **Fine alignment.**
   - Run band-limited GCC-PHAT on Tukey-windowed 20 s windows, one every 30 s.
   - Keep the windows whose peak-to-sidelobe ratio is above 1.5.
   - The offset is the median of the windows that agree within 4 ms.
   - Report drift (it was at most 4 ppm) but do not apply it.
4. **Short clips.** Inspect the top 3 peaks near the timecode prediction, on all three recorder
   tracks. Mark clips shot wholly before the recorder started as timecode-only placements.
5. **Place on a clone.**
   - The position is the take start plus the offset, rounded to the frame; log the rounding.
   - `sequence.overwriteClip(item, t + 0.001, n−1, n+3)` puts camera n on Vn and its scratch
     audio on A(n+4). Mute those scratch tracks.
   - The recorder stays on A2–A4. `track.overwriteClip` would tie V n to A n and collide
     with the recorder.
6. **Prove it on a throwaway clone.**
   - Render 30 s AIFFs at 5 points: the recorder alone, and each scratch track alone.
   - Each camera's lag against the recorder must equal minus its rounding error.
   - Render one JPEG per camera and look at it.
   - Record the measured residual and retain the review clone unless cleanup is requested.
     See SKILL.md «Rendering and looking».

## Cutting the synced stack afterwards

A content cut must keep the angles in sync for the later multicam pass. Cameras restart
mid-take, and on one job the host's ripple delete left a track that was empty under the range
unshifted. That was not reproduced on 2026-09-25, but a desync costs the whole multicam pass.
So:
- intersect each kept range with every clip on every track;
- `overwriteClip` the sub-ranges at absolute targets on a cleared clone;
- check that every item's `start − in` equals its source offset.

Recorder WAVs are interpreted at 29.97 fps. Set each placed audio item's `inPoint`/`outPoint`
in ticks: see SKILL.md «Times, in/out points, clones».

The episodes of a podcast were cut this way by meaning:
- a local transcript with word times, one per take;
- the pieces written as word ranges;
- edges snapped into pauses measured on the voice mics against the local floor;
- the cloud ASR run on every join, before and after the build.
