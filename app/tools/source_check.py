#!/usr/bin/env python3
"""Check the XML's claims about each source file against the media itself.

    python3 tools/source_check.py "MY_TIMELINE.xml" [--sequence 1] [--all] [--deep]

An FCP7 XML records what Premiere *believed* about a source file, not what is in it.
Every number xmlcut derives — the seek time, the frame count it pins — rests on one
value, the source's frame rate, plus an unstated assumption: that the file runs at
that rate, evenly, from time zero. When either is untrue the cut comes out the wrong
length and nothing in the XML says so, because the XML is not where the truth lives.

So this asks the media directly. Per source file:

  * is the rate CONSTANT?       r_frame_rate against the real packet timestamps. A
                                variable-rate file (screen capture, phone video, a
                                transcode that dropped frames) holds fewer frames in a
                                span than rate x duration predicts — so the frame count
                                xmlcut pins stops describing the span it meant.
  * does it start at ZERO?      a non-zero start_time shifts what `-ss` means
  * does the HEADER tell truth? declared duration and frame count vs the measured ones
  * does the XML agree?         the rate Premiere recorded vs the file's own
  * does the RANGE EXIST?       asking for material past the end returns a short clip,
                                silently, with a normal-looking exit code

Then, per cut, the number that actually decides the length: how many frames xmlcut
will pin, against how many frames really live in that stretch of the file.

Timestamps come from packets, not decoded frames — same count, same values, ~10x
cheaper (verified). `--deep` adds a full decode count, which is the only way to catch
a container whose header lies about its own frame count.

Nothing is encoded and nothing is written. Safe to run on anything.
"""
import argparse
import bisect
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import xmlcut  # noqa: E402


# --------------------------------------------------------------------------
# measuring the media
# --------------------------------------------------------------------------

def probe_header(path: str) -> dict:
    """What the container claims about itself. Cheap, and not to be trusted."""
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-print_format", "json",
             "-show_streams", "-show_format", path],
            capture_output=True, text=True, timeout=60)
        return json.loads(r.stdout) if r.returncode == 0 else {}
    except Exception:
        return {}


def packet_times(path: str) -> list[float]:
    """Every video packet's presentation time, sorted.

    This is the ground truth for "which frames exist when". Packets rather than
    frames because ffprobe decodes for `frame=` entries and does not for `packet=`,
    while for a video stream the count and the pts values come out identical.

    Sorted because B-frames arrive out of presentation order.
    """
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "packet=pts_time", "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=600)
    except Exception:
        return []
    out = []
    for line in r.stdout.splitlines():
        v = line.strip().rstrip(",")
        if v and v != "N/A":
            try:
                out.append(float(v))
            except ValueError:
                pass
    out.sort()
    return out


def decoded_count(path: str) -> int:
    """Frames that actually decode. Slow — the only check for a lying header."""
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames",
             "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=1800)
        return int((r.stdout.strip().rstrip(",") or "0"))
    except Exception:
        return -1


def frames_in(ts: list[float], lo: float, hi: float) -> int:
    """How many real frames fall in [lo, hi).

    The 1e-6 slack is for float noise only — a frame whose pts is a hair under `lo`
    because 1/3 is not representable should still count as being at `lo`.
    """
    if not ts:
        return 0
    return bisect.bisect_left(ts, hi - 1e-6) - bisect.bisect_left(ts, lo - 1e-6)


def rate_profile(ts: list[float]) -> dict:
    """Is this file constant-rate? Answered from the gaps between timestamps.

    A constant-rate file has one gap repeated. Anything else — a phone that varies
    with light, a screen capture that only writes on change, a transcode that dropped
    frames — shows up as gaps that differ, and every `duration x rate` calculation
    downstream is then wrong by however much they differ.
    """
    if len(ts) < 3:
        return {}
    gaps = sorted(b - a for a, b in zip(ts, ts[1:]) if b > a)
    if not gaps:
        return {}
    med = gaps[len(gaps) // 2]
    if med <= 0:
        return {}

    # Two different faults look alike in a gap histogram, and they are not the same
    # problem. A gap that is an exact multiple of the frame interval is a DROPPED
    # frame: the file still runs at one rate, it is just missing material. A gap that
    # is not a multiple means the file has no single rate at all. The first costs you
    # exactly the missing frames; the second breaks every duration x rate sum on it.
    dropped = 0
    irregular = 0
    for g in gaps:
        if abs(g - med) <= med * 0.02:
            continue
        mult = g / med
        if mult > 1.5 and abs(mult - round(mult)) <= 0.05:
            dropped += int(round(mult)) - 1
        else:
            irregular += 1

    span = ts[-1] - ts[0] + med
    return {
        "n": len(ts),
        "min_gap": gaps[0],
        "max_gap": gaps[-1],
        "med_gap": med,
        "dropped": dropped,
        "irregular": irregular,
        "measured_fps": len(ts) / span if span > 0 else 0.0,
        "span": span,
        # One stray gap is a container quirk at the tail. Several, not on the grid,
        # means the file genuinely does not run at a single rate.
        "vfr": irregular > max(1, len(gaps) // 200),
    }


# --------------------------------------------------------------------------
# reporting
# --------------------------------------------------------------------------

def audit_files(cuts, deep: bool, xml_fps: dict) -> dict:
    """Probe each unique source once; return everything measured about it."""
    info: dict[str, dict] = {}
    paths = []
    for c in cuts:
        if c.source_exists and c.source_path not in info:
            info[c.source_path] = {}
            paths.append(c.source_path)

    tty = sys.stdout.isatty()          # \r is literal in a pipe or a log file
    for i, p in enumerate(paths, start=1):
        if tty:
            print(f"  probing {i}/{len(paths)}: {Path(p).name}"[:76].ljust(76),
                  end="\r", flush=True)
        hdr = probe_header(p)
        vs = next((s for s in hdr.get("streams", [])
                   if s.get("codec_type") == "video"), {})
        ts = packet_times(p)
        prof = rate_profile(ts)

        def frac(key):
            try:
                n, d = str(vs.get(key, "0/1")).split("/")
                return float(n) / float(d) if float(d) else 0.0
            except Exception:
                return 0.0

        info[p] = {
            "codec": vs.get("codec_name", ""),
            "r_fps": frac("r_frame_rate"),
            "avg_fps": frac("avg_frame_rate"),
            "hdr_frames": int(vs.get("nb_frames") or 0),
            "stream_dur": float(vs.get("duration") or 0.0),
            "fmt_dur": float(hdr.get("format", {}).get("duration") or 0.0),
            "start": float(vs.get("start_time") or 0.0),
            "ts": ts,
            "prof": prof,
            "decoded": decoded_count(p) if deep else None,
            "xml_fps": xml_fps.get(p, 0.0),
        }
    if paths and tty:
        print(" " * 76, end="\r")
    return info


def file_flags(d: dict) -> list[str]:
    """Only things that change a cut. No cosmetic noise."""
    prof = d.get("prof") or {}
    r, ts = d["r_fps"], d["ts"]

    # A still has one frame and no rate of its own — ffprobe invents 25 fps for a PNG.
    # Every rate and duration check below is meaningless on it, and flagging them all
    # buries the real findings on the video files.
    if len(ts) <= 1 or d["codec"] in ("png", "mjpeg", "bmp", "tiff", "gif", "webp"):
        return []

    flags = []

    # The consequence is stated on its own, never gated behind which label the gap
    # histogram earns. A bimodal file is called "variable" or "dropped" depending on
    # which gap happens to be the median — but either way `duration x rate` no longer
    # counts its frames, and that is the part that must always be said.
    measured = prof.get("measured_fps") or 0.0
    if prof and r > 0 and measured > 0 and abs(measured - r) / r > 0.002:
        flags.append(
            f"COUNT UNRELIABLE — file measures {measured:.4f} fps but declares "
            f"{r:.4f} ({abs(measured - r) / r * 100:.2f}% apart), so any frame count "
            f"taken as duration x rate is wrong on this file")

    if prof.get("vfr"):
        flags.append(
            f"    variable rate: {prof['irregular']} of {prof['n'] - 1} gaps sit off the "
            f"grid, {prof['min_gap'] * 1000:.1f}–{prof['max_gap'] * 1000:.1f} ms")
    if prof.get("dropped"):
        flags.append(
            f"    missing material: {prof['dropped']} frame(s) absent at gaps that are "
            f"exact multiples of {prof['med_gap'] * 1000:.1f} ms")

    if abs(d["start"]) > 0.001:
        flags.append(
            f"START OFFSET — first frame sits at {d['start']:+.3f}s, not 0, so a seek "
            f"of X lands at X{d['start']:+.3f}s of material "
            f"({abs(d['start']) * max(r, 1):.1f} frames)")

    if d["hdr_frames"] and ts and d["hdr_frames"] != len(ts):
        flags.append(f"HEADER FRAME COUNT — claims {d['hdr_frames']}, "
                     f"stream holds {len(ts)}")

    if d["decoded"] is not None and d["decoded"] >= 0 and ts \
            and d["decoded"] != len(ts):
        flags.append(f"UNDECODABLE PACKETS — {len(ts)} packets, "
                     f"{d['decoded']} decode")

    if d["stream_dur"] and d["fmt_dur"] \
            and abs(d["stream_dur"] - d["fmt_dur"]) > 0.04:
        flags.append(f"DURATION SPLIT — video stream {d['stream_dur']:.3f}s, "
                     f"container {d['fmt_dur']:.3f}s")

    xf = d.get("xml_fps") or 0.0
    if xf > 0 and r > 0 and abs(xf - r) / r > 0.002:
        flags.append(f"XML DISAGREES — Premiere recorded {xf:.4f} fps, "
                     f"file is {r:.4f} fps")

    return flags


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("xml", type=Path)
    ap.add_argument("--sequence", help="which sequence (name or 1-based number)")
    ap.add_argument("--all", action="store_true",
                    help="list every cut, not only the ones that disagree")
    ap.add_argument("--deep", action="store_true",
                    help="also decode each source in full (slow; catches a lying header)")
    args = ap.parse_args()

    try:
        tl = xmlcut.Timeline(args.xml, [], args.sequence)
    except xmlcut.SequenceChoice as e:
        print("This XML holds several sequences — pick one with --sequence:\n")
        for s in e.options:
            print(f"  {s['index']}. {s['name']}  {s['fps']:g} fps, "
                  f"{s['clip_count']} clips")
        return 1

    tl.cuts = [c for c in tl.cuts if c.track_type == "video"]
    for i, c in enumerate(tl.cuts, start=1):
        c.index = i
    cache: dict = {}
    for c in tl.cuts:
        xmlcut.apply_probe(c, cache)

    # The rate Premiere wrote into <file><rate>, which is not necessarily the file's.
    xml_fps = {}
    for c in tl.cuts:
        f = tl.files.get(c.file_id) or {}
        if c.source_path and f.get("fps"):
            xml_fps.setdefault(c.source_path, float(f["fps"]))

    print(f"sequence: {tl.sequence_name} @ {tl.sequence_fps:g} fps · "
          f"{len(tl.cuts)} video cuts")
    missing = [c for c in tl.cuts if not c.source_exists]
    if missing:
        print(f"  !! {len(missing)} cut(s) have no readable source file — skipped")
    if args.deep:
        print("  --deep: decoding every source in full, this takes a while")
    print()

    info = audit_files(tl.cuts, args.deep, xml_fps)

    # ---- per file -------------------------------------------------------
    print("SOURCE FILES")
    print("-" * 78)
    suspect_files = 0
    for p, d in info.items():
        prof = d.get("prof") or {}
        still = len(d["ts"]) <= 1
        print(f"{Path(p).name}")
        if still:
            print(f"    {d['codec'] or '?'} · still image — no frame rate to check")
        else:
            print(f"    {d['codec'] or '?'} · declared {d['r_fps']:.4f} fps · "
                  f"measured {prof.get('measured_fps', 0):.4f} fps · "
                  f"{len(d['ts'])} frames · {d['fmt_dur']:.3f}s")
        flags = file_flags(d)
        if flags:
            suspect_files += 1
            for f in flags:
                # Detail lines arrive pre-indented; they explain the finding above them
                # rather than being findings of their own.
                print(f"       {f.strip()}" if f.startswith("    ") else f"    !! {f}")
        elif not still:
            print("    ok — constant rate, starts at zero, header agrees")
        print()

    # ---- per cut --------------------------------------------------------
    print("CUTS — frames xmlcut pins vs frames that exist in that range")
    print("-" * 78)
    hdr = (f"{'clip':18s} {'src in':>9s} {'src dur':>9s} {'pin':>6s} {'real':>6s} "
           f"{'d':>5s} {'off':>8s}  verdict")
    print(hdr)
    problems = []
    checked = 0
    for c in tl.cuts:
        if not c.source_exists or c.media_kind != "video":
            continue
        d = info.get(c.source_path) or {}
        ts = d.get("ts") or []
        if not ts:
            continue
        checked += 1
        lo = c.source_in_seconds
        hi = lo + c.source_duration_seconds
        pin = c.source_consumed_frames
        real = frames_in(ts, lo, hi)
        delta = pin - real
        fps = c.source_fps or d.get("r_fps") or 0.0
        off = delta / fps if fps > 0 else 0.0

        # The end of the last frame, not its start — a cut may legitimately run to
        # the final frame's out-point.
        med = (d.get("prof") or {}).get("med_gap") or (1.0 / fps if fps else 0.0)
        file_end = ts[-1] + med

        verdict = "ok"
        if hi > file_end + 1e-3:
            verdict = f"PAST END by {hi - file_end:.3f}s — ffmpeg returns a short clip"
        elif delta:
            verdict = (f"{'pins ' + str(delta) + ' too many' if delta > 0 else 'pins ' + str(-delta) + ' too few'}"
                       f" ({off:+.3f}s)")

        if verdict != "ok":
            problems.append((c.clip_name, verdict))
        if args.all or verdict != "ok":
            print(f"{c.clip_name[:18]:18s} {lo:>8.3f}s {c.source_duration_seconds:>8.3f}s "
                  f"{pin:>6d} {real:>6d} {delta:>5d} {off:>+7.3f}s  {verdict}")

    if not args.all and not problems:
        print(f"{'all ' + str(checked) + ' match':18s} — every cut's frame count equals "
              f"the frames really in its range")
    print("-" * 78)

    # ---- what to conclude ----------------------------------------------
    if not problems and not suspect_files:
        print("\nEvery source file runs at a constant rate from zero, and every cut's "
              "\nframe count matches the frames really in that range. The media is not "
              "\nwhere the error is.")
        return 0

    print(f"\n{len(problems)} cut(s) disagree with their source; "
          f"{suspect_files} file(s) carry a flag.\n")
    for name, verdict in problems[:40]:
        print(f"  {name}: {verdict}")
    if len(problems) > 40:
        print(f"  … and {len(problems) - 40} more")

    print("\nReading it:")
    print("  COUNT UNRELIABLE   duration x rate does not count this file's frames —")
    print("                     variable rate or missing material. On a long clip this")
    print("                     is the flag that costs you a second or more.")
    print("  START OFFSET       every seek into this file is shifted by that much")
    print("  XML DISAGREES      Premiere conformed the file; in/out are in ITS rate")
    print("  DURATION SPLIT     stream and container disagree; an NLE reads the container")
    print("  HEADER FRAME COUNT the container's own count is wrong — rerun with --deep")
    print("  PAST END           the XML asks for material the file does not contain")
    print("  pins too many/few  the range is right but the count derived from it is not")
    return 0


if __name__ == "__main__":
    sys.exit(main())
