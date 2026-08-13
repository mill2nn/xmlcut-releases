#!/usr/bin/env python3
"""Diagnose the speed round-trip on a REAL timeline.

    python3 tools/speed_check.py "MY_TIMELINE.xml" [--sequence 1] [--clips ./clips]

For every retimed clip it prints, side by side:

  * what Premiere says     — the speed %, and how long the clip is on the timeline
  * what xmlcut derived    — the source range, where it came from (ticks or frame math)
  * what should come out   — the frame count a `--speed native` cut must contain
  * what actually came out — if you point --clips at the output folder

and then the round trip: cut length / speed should equal the timeline length. Any row
where that fails is the bug, and the columns say which number is wrong.

Nothing is encoded and nothing is written. Safe to run on anything.
"""
import argparse
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import xmlcut  # noqa: E402


def probe(path: str, stream: str, keys: str) -> list[str]:
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", stream,
                        "-show_entries", f"stream={keys}", "-of", "default=nw=1:nk=1",
                        path], capture_output=True, text=True)
    return r.stdout.split()


def real_frames(path: str) -> int:
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                        "-count_frames", "-show_entries", "stream=nb_read_frames",
                        "-of", "csv=p=0", path], capture_output=True, text=True)
    return int(r.stdout.strip() or 0)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("xml", type=Path)
    ap.add_argument("--sequence", help="which sequence (name or 1-based number)")
    ap.add_argument("--clips", type=Path, help="output folder, to check the real files too")
    ap.add_argument("--all", action="store_true", help="include 100%% clips as well")
    args = ap.parse_args()

    try:
        tl = xmlcut.Timeline(args.xml, [], args.sequence)
    except xmlcut.SequenceChoice as e:
        print("This XML holds several sequences — pick one with --sequence:\n")
        for s in e.options:
            print(f"  {s['index']}. {s['name']}  {s['fps']:g} fps, {s['clip_count']} clips")
        return 1

    tl.cuts = [c for c in tl.cuts if c.track_type == "video"]
    for i, c in enumerate(tl.cuts, start=1):
        c.index = i
    xmlcut.assign_output_names(tl.cuts, "mp4", tl.sequence_fps)
    cache: dict = {}
    for c in tl.cuts:
        xmlcut.apply_probe(c, cache)

    print(f"sequence: {tl.sequence_name} @ {tl.sequence_fps:g} fps · "
          f"{len(tl.cuts)} video cuts\n")
    for w in tl.warnings:
        print(f"  !! {w}")
    if tl.warnings:
        print()

    hdr = (f"{'clip':16s} {'PR%':>8s} {'timing':7s} {'src fps':>7s} "
           f"{'PR len':>8s} {'src range':>10s} {'want f':>7s}")
    if args.clips:
        hdr += f" {'got f':>6s} {'got dur':>8s}"
    hdr += "  round trip"
    print(hdr)
    print("-" * (len(hdr) + 4))

    problems = []
    for c in tl.cuts:
        if not args.all and c.speed_percent in (0, 100):
            continue
        if c.media_kind != "video":
            continue
        k = (c.speed_percent / 100.0) or 1.0
        pr_len = c.duration_seconds                      # its length on the timeline
        src_len = c.source_duration_seconds              # what the cut should contain
        want_f = c.source_consumed_frames
        row = (f"{c.clip_name[:16]:16s} {c.speed_percent:>7.4g}% {c.timing_source:7s} "
               f"{c.source_fps:>7.3f} {pr_len:>7.3f}s {src_len:>9.3f}s {want_f:>7d}")

        note = ""
        if args.clips:
            p = args.clips / c.output_file
            if p.exists():
                got_f = real_frames(str(p))
                d = probe(str(p), "v:0", "duration")
                got_d = float(d[0]) if d else 0.0
                row += f" {got_f:>6d} {got_d:>7.3f}s"
                if got_f != want_f:
                    note = f"file has {got_f} frames, expected {want_f}"
            else:
                row += f" {'--':>6s} {'--':>8s}"
                note = "no output file"

        # the invariant: source length / speed == timeline length
        trip = src_len / k
        off = trip - pr_len
        verdict = "ok" if abs(off) < 0.02 else f"OFF by {off:+.3f}s"
        if abs(off) >= 0.02 or note:
            problems.append((c.clip_name, verdict, note))
        print(f"{row}  {verdict}{'  <- ' + note if note else ''}")

    print("-" * (len(hdr) + 4))
    if problems:
        print(f"\n{len(problems)} clip(s) do not round-trip:\n")
        for name, verdict, note in problems:
            print(f"  {name}: {verdict}{' — ' + note if note else ''}")
        print("\nSend this table back — the columns say which number is wrong:")
        print("  'src range' too short   -> the tick range is being read wrong")
        print("  'timing' says frames    -> no pproTicks; the fallback maths is in play")
        print("  'src fps' looks odd     -> variable frame rate, or ffprobe disagrees "
              "with the XML")
        print("  'got f' != 'want f'     -> the extraction, not the maths")
    else:
        print("\nEvery retimed clip round-trips: source length / speed == timeline length.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
