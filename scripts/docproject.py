"""Read video placement and timing evidence from a saved, gzip/XML Premiere project.

    python -I -S scripts/docproject.py project.prproj

Only reads the project itself. Output times are seconds, track indices are zero-based.
"""
import argparse
from collections import defaultdict
import gzip
import json
import math
import sys
import xml.etree.ElementTree as ET


TICKS_PER_SECOND = 254016000000


def ticks(element, path, default=None):
    value = element.findtext(path)
    return default if value is None else int(value) / TICKS_PER_SECOND


def read_project(path):
    with gzip.open(path, "rb") as handle:
        root = ET.parse(handle).getroot()
    if root.tag != "PremiereData":
        raise ValueError("Expected a PremiereData project")
    objects = defaultdict(list)
    for element in root:
        key = element.get("ObjectUID") or element.get("ObjectID")
        if key is not None:
            objects[key].append(element)

    def follow(link, *tags):
        if link is None:
            return None
        key = link.get("ObjectURef") or link.get("ObjectRef")
        # Object IDs may be shared by unrelated classes in a Premiere project.
        matches = [item for item in objects.get(key, ()) if item.tag in tags]
        return matches[0] if len(matches) == 1 else None

    def placement(item, track):
        sub = follow(item.find("./ClipTrackItem/SubClip"), "SubClip")
        if sub is None:
            return None
        video = follow(sub.find("Clip"), "VideoClip")
        if video is None or video.find("Clip") is None:
            return None
        clip = video.find("Clip")
        raw_speed = clip.findtext("PlaybackSpeed")
        speed = None if raw_speed is None else float(raw_speed)
        if speed is not None and not math.isfinite(speed):
            raise ValueError("Non-finite PlaybackSpeed")
        flags = [item.findtext("./ClipTrackItem/" + tag) for tag in ("IsMuted", "IsDisabled", "Disabled")]
        disabled = True if "true" in flags else False if "false" in flags else None
        src = follow(clip.find("Source"), "VideoSequenceSource", "VideoMediaSource")
        media_path, nested_id = None, None
        if src is not None:
            media = follow(src.find("./MediaSource/Media"), "Media")
            if media is not None:
                media_path = media.findtext("ActualMediaFilePath") or media.findtext("FilePath")
            nest = src.find("./SequenceSource/Sequence")
            if nest is not None:
                nested_id = nest.get("ObjectURef")
        return {
            "track": track, "name": sub.findtext("Name"),
            # A track item starting at sequence zero can omit its Start tag.
            "start": ticks(item, "./ClipTrackItem/TrackItem/Start", 0),
            "end": ticks(item, "./ClipTrackItem/TrackItem/End"),
            "sourceIn": ticks(clip, "InPoint"), "sourceOut": ticks(clip, "OutPoint"),
            "path": media_path, "nest": nested_id, "speed": speed,
            "reverse": None, "disabled": disabled,
            "hasRetime": True if clip.find("TimeRemapping") is not None else None,
        }

    sequences = {}
    for seq in root.findall("Sequence"):
        seq_id = seq.get("ObjectUID")
        if seq_id is None:
            continue
        clips = []
        frame_durations = set()
        for group_link in seq.findall("./TrackGroups/TrackGroup/Second"):
            group = follow(group_link, "VideoTrackGroup")
            if group is None:
                continue
            frame_durations.add(ticks(group, "./TrackGroup/FrameRate"))
            for track_link in group.findall("./TrackGroup/Tracks/Track"):
                track = follow(track_link, "VideoClipTrack")
                if track is None:
                    continue
                track_index = int(track_link.attrib["Index"])
                for link in track.findall("./ClipTrack/ClipItems/TrackItems/TrackItem"):
                    item = follow(link, "VideoClipTrackItem")
                    if item is not None:
                        entry = placement(item, track_index)
                        if entry is not None:
                            clips.append(entry)
        fd = frame_durations.pop() if len(frame_durations) == 1 else None
        sequences[seq_id] = {"name": seq.findtext("Name"), "fd": fd if fd and fd > 0 else None, "clips": clips}
    if not sequences:
        raise ValueError("No Premiere sequences found")
    return {"sequences": sequences}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project")
    args = parser.parse_args()
    try:
        data = read_project(args.project)
    except (ET.ParseError, OSError, EOFError, ValueError, KeyError) as error:
        parser.exit(1, f"Could not read Premiere project: {error}\n")
    sys.stdout.reconfigure(encoding="utf-8")
    json.dump(data, sys.stdout, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
