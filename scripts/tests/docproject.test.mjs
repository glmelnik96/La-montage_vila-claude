import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

test('saved project reader resolves typed references and preserves explicit timing and clip mute', t => {
  const folder = mkdtempSync(join(tmpdir(), 'docproject-'));
  const project = join(folder, 'cut.prproj');
  const script = fileURLToPath(new URL('../docproject.py', import.meta.url));
  const xml = `<PremiereData>
    <Sequence ObjectUID="seq"><Name>Портрет</Name><TrackGroups><TrackGroup><Second ObjectRef="1"/></TrackGroup></TrackGroups></Sequence>
    <VideoTrackGroup ObjectID="1"><TrackGroup><FrameRate>10160640000</FrameRate><Tracks><Track Index="2" ObjectURef="v3"/></Tracks></TrackGroup></VideoTrackGroup>
    <VideoClipTrack ObjectUID="v3"><ClipTrack><ClipItems><TrackItems><TrackItem Index="0" ObjectRef="2"/></TrackItems></ClipItems></ClipTrack></VideoClipTrack>
    <OtherClass ObjectID="2"/>
    <VideoClipTrackItem ObjectID="2"><ClipTrackItem><TrackItem><End>508032000000</End></TrackItem>
      <IsMuted>true</IsMuted><SubClip ObjectRef="3"/></ClipTrackItem></VideoClipTrackItem>
    <SubClip ObjectID="3"><Name>Кадр</Name><Clip ObjectRef="4"/></SubClip>
    <VideoClip ObjectID="4"><Clip><Source ObjectRef="5"/><InPoint>254016000000</InPoint><OutPoint>508032000000</OutPoint>
      <PlaybackSpeed>0.5</PlaybackSpeed><TimeRemapping ObjectRef="7"/></Clip></VideoClip>
    <VideoMediaSource ObjectID="5"><MediaSource><Media ObjectURef="media"/></MediaSource></VideoMediaSource>
    <Media ObjectUID="media"><ActualMediaFilePath>площадь.mov</ActualMediaFilePath></Media>
    <TimeRemapping ObjectID="7"/>
  </PremiereData>`;
  writeFileSync(project, gzipSync(Buffer.from(xml)));
  t.after(() => { unlinkSync(project); rmdirSync(folder); });
  const output = execFileSync(process.env.PYTHON || 'python', ['-I', '-S', script, project], { encoding: 'utf8' });
  const { seq } = JSON.parse(output).sequences;
  assert.equal(seq.name, 'Портрет');
  assert.equal(seq.fd, 0.04);
  assert.deepEqual(seq.clips, [{
    track: 2, name: 'Кадр', start: 0, end: 2, sourceIn: 1, sourceOut: 2,
    path: 'площадь.mov', nest: null, speed: 0.5, reverse: null, disabled: true, hasRetime: true,
  }]);
});
