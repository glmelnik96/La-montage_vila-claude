# Cameras + a separate audio recorder → one synced stack (Workflow G)

Use this when several cameras recorded with only scratch audio, and a separate recorder (a
RØDECaster, a Zoom) holds the real microphones. The recorder takes are already on the timeline
and in place. If they are not, place them first, and ask the user where each take belongs: the
takes are the reference everything is synced to. The cameras still have to be synced to them,
because a sync plugin failed or the timecodes disagree.

It was verified on three BMPCC cameras (BRAW, 25p) against four recorder takes. Every clip was
proven by a render to within ±20 ms, which is the frame rounding. The job's scripts were
one-offs in gen-out; no repo tool exists yet, so write it per job from this method.

## Inputs

- **Scratch audio** of every camera clip, and every recorder take (Stereo Mix, Mic 1, Mic 2),
  as 16 kHz mono WAV.
- **Each take's position** on the timeline.
- **Each clip's start timecode.** BRAW timecode is free-run time of day, so it is a good prior
  across cameras but not a sync on its own.

## Method

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
4. **Short clips.** Take the top 3 peaks near the timecode prediction, on all three recorder
   tracks. Clips shot before the recorder started are placed by timecode alone.
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
   - Then delete the clone. See SKILL.md «Rendering and looking».

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
