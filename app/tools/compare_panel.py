#!/usr/bin/env python3
"""Compare what Premiere says about a sequence against what its XML export says.

    python3 tools/compare_panel.py "MY_TIMELINE.xml" [--dump path] [--sequence N] [--all]

Read the sequence with the **xmlcut** panel first — it writes a timestamped `.json`/`.xml`
pair to `<project folder>/xmlcut/<Sequence Name>/` — then point this at the `.xml`. The
matching `.json` is found automatically; `--dump` overrides it.

The XML is a flattened snapshot; the panel asks Premiere directly. Where they agree,
the XML is good enough and the panel buys only convenience. Where they disagree, the
XML is losing something and that difference is worth knowing about:

  * source ticks     the range xmlcut extracts. These SHOULD match exactly.
  * speed            one number in the XML; possibly a whole curve in Premiere.
  * keyframed ramps  the XML cannot express them at all — it flattens to one speed.
  * frame rate       Premiere's INTERPRETED rate vs what the XML recorded.
  * media path       Premiere's real path vs the XML's pathurl after remapping.

Nothing is written and nothing is encoded.
"""
# The stock macOS Python here is 3.9, where `int | None` in an annotation is a
# TypeError at import time. Deferring annotations makes the modern spelling safe.
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import xmlcut  # noqa: E402

LEGACY_DUMP_DIR = Path.home() / "Desktop" / "xmlcut-dumps"
TICKS = xmlcut.PPRO_TICKS_PER_SECOND


def is_dump(p: Path) -> bool:
    try:
        with open(p, "r", encoding="utf-8") as fh:
            return "xmlcut reader" in fh.read(400)
    except Exception:
        return False


def find_dump(xml: Path) -> Optional[Path]:
    """Locate the panel dump that goes with this XML.

    The panel writes both halves of a read as one timestamped pair —
    `<stamp>.json` and `<stamp>.xml` — in a folder per sequence beside the project.
    So the sibling with the same stamp is the right dump, and picking it beats
    guessing at the newest one: a folder can hold reads from several days.

    Failing that, fall back to the newest panel-written JSON anywhere under the old
    fixed Desktop location, for XMLs exported by hand.
    """
    sibling = xml.with_suffix(".json")
    if sibling.is_file() and is_dump(sibling):
        return sibling

    same_folder = sorted((p for p in xml.parent.glob("*.json") if is_dump(p)),
                         key=lambda p: p.stat().st_mtime, reverse=True)
    if same_folder:
        return same_folder[0]

    if LEGACY_DUMP_DIR.is_dir():
        found = sorted((p for p in LEGACY_DUMP_DIR.rglob("*.json") if is_dump(p)),
                       key=lambda p: p.stat().st_mtime, reverse=True)
        if found:
            return found[0]
    return None


def load_dump(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SystemExit(
            f"No dump at {path}\n\n"
            "Open the 'xmlcut' panel in Premiere (Window > Extensions), open the\n"
            "timeline you want, and click 'Read timeline & export XML'.")
    except json.JSONDecodeError as e:
        raise SystemExit(f"{path} is not readable JSON ({e}).")
    if data.get("generator") != "xmlcut reader":
        raise SystemExit(f"{path} was not written by the xmlcut reader panel.")
    return data


def ticks_of(t) -> int | None:
    """A Time's ticks arrive as a STRING, because the values exceed float precision."""
    if not isinstance(t, dict):
        return None
    v = t.get("ticks")
    if v in (None, ""):
        return None
    try:
        return int(str(v))
    except ValueError:
        return None


def remap_curve(clip: dict) -> list[tuple[float, float]]:
    """(seconds, value) for every time-remap keyframe on this clip."""
    pts = []
    for comp in clip.get("components") or []:
        if not comp.get("is_time_remap"):
            continue
        for p in comp.get("params") or []:
            for k in p.get("keys") or []:
                secs = (k.get("time") or {}).get("seconds")
                val = k.get("value")
                if isinstance(secs, (int, float)) and isinstance(val, (int, float)):
                    pts.append((float(secs), float(val)))
    pts.sort()
    return pts


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("xml", type=Path)
    ap.add_argument("--dump", type=Path,
                    help="panel output (default: the .json beside the XML, which the "
                         "panel writes as its matching half)")
    ap.add_argument("--sequence", help="which sequence in the XML (name or number)")
    ap.add_argument("--all", action="store_true", help="list matching clips too")
    args = ap.parse_args()

    dump_path = args.dump
    if dump_path is None:
        dump_path = find_dump(args.xml)
        if dump_path is None:
            raise SystemExit(
                "Could not find a panel dump for this XML.\n\n"
                "The panel writes both halves of a read as a timestamped pair in\n"
                "  <project folder>/xmlcut/<sequence name>/\n"
                "so point --dump at the .json whose name matches your .xml.")
        print(f"dump  : {dump_path}")
    dump = load_dump(dump_path)
    dseq = dump.get("sequence") or {}
    dclips = [c for c in dump.get("clips") or [] if c.get("track_type") == "video"]

    # Default to the sequence the panel read, so the two sides describe the same
    # timeline without the user having to work out its number.
    select = args.sequence
    if select is None and dseq.get("name"):
        names = [s["name"] for s in xmlcut.Timeline.list_sequences(args.xml)]
        if dseq["name"] in names:
            select = dseq["name"]

    try:
        tl = xmlcut.Timeline(args.xml, [], select)
    except xmlcut.SequenceChoice as e:
        print("The XML holds several sequences and none matched the panel's "
              f"({dseq.get('name')!r}). Pick one with --sequence:\n")
        for s in e.options:
            print(f"  {s['index']}. {s['name']}  {s['fps']:g} fps, "
                  f"{s['clip_count']} clips")
        return 1

    xcuts = [c for c in tl.cuts if c.track_type == "video"]
    cache: dict = {}
    for c in xcuts:
        xmlcut.apply_probe(c, cache)

    print(f"panel : {dseq.get('name')!r} @ {dseq.get('fps', 0):g} fps · "
          f"{len(dclips)} video clips · Premiere {dump.get('premiere_version')}")
    print(f"xml   : {tl.sequence_name!r} @ {tl.sequence_fps:g} fps · "
          f"{len(xcuts)} video cuts")
    if dseq.get("name") != tl.sequence_name:
        print("  !! different sequence names — are these the same timeline?")
    print()

    # Bucketed as a LIST per start tick, because a real timeline stacks graphics and
    # adjustment layers over the footage at the same instant. Keeping one clip per tick
    # matched cuts against whatever was on top — on a real sequence that mismatched
    # most of the list. xmlcut.match_dump_clip settles it on the media filename.
    buckets: dict[int, list] = {}
    for c in dclips:
        t = ticks_of(c.get("start"))
        if t is not None:
            buckets.setdefault(t, []).append(c)

    hdr = (f"{'clip':20s} {'src ticks':>11s} {'speed':>14s} {'fps':>13s}  notes")
    print(hdr)
    print("-" * 88)

    diffs = []
    unmatched = 0
    ambiguous = 0
    ramps = []
    for c in xcuts:
        xstart = int(round(c.timeline_in_frames * TICKS / tl.sequence_fps))
        # Allow a frame of slack: the XML gives whole frames, the panel gives ticks.
        slack = TICKS / tl.sequence_fps
        pc, how = xmlcut.match_dump_clip(buckets, xstart, slack, c.source_path)
        if how == "ambiguous":
            ambiguous += 1
        if pc is None:
            unmatched += 1
            if args.all:
                why = ("clips stacked here, none with this filename"
                       if how == "ambiguous" else "nothing at this position in the dump")
                print(f"{c.clip_name[:20]:20s} {'—':>11s} {'—':>14s} {'—':>13s}  {why}")
            continue

        notes = []

        # -- source range, the number that decides what gets extracted ----------
        p_in, p_out = ticks_of(pc.get("in_point")), ticks_of(pc.get("out_point"))
        tick_note = "same"
        if p_in is None or p_out is None:
            tick_note = "panel n/a"
        else:
            # Premiere's inPoint/outPoint are TIMELINE units — their difference is the
            # length the clip occupies, not the source it consumes — so multiply by
            # speed before comparing. Measured on a real 39-cut timeline: out-in
            # equalled the timeline length on 16 clips and the source range on none.
            ps = pc.get("speed")
            k = (abs(float(ps)) if isinstance(ps, (int, float)) and ps else 1.0) or 1.0
            d_in = (p_in / TICKS) * k - c.source_in_seconds
            d_dur = ((p_out - p_in) / TICKS) * k - c.source_duration_seconds
            # A transition makes the XML's range legitimately longer: it covers the
            # material under the dissolve, which the panel's clip bounds do not.
            tol = 0.004
            if c.edge_in_transition:
                tick_note = "transition"
            elif abs(d_in) > tol or abs(d_dur) > tol:
                tick_note = f"in{d_in:+.3f} len{d_dur:+.3f}"
                notes.append(f"source range differs: in {d_in:+.4f}s, "
                             f"length {d_dur:+.4f}s")

        # -- speed --------------------------------------------------------------
        p_speed = pc.get("speed")
        speed_note = "n/a"
        if isinstance(p_speed, (int, float)):
            p_pct = float(p_speed) * 100.0
            speed_note = f"{p_pct:.2f} / {c.speed_percent:.2f}"
            if abs(p_pct - c.speed_percent) > 0.5:
                notes.append(f"speed differs: Premiere {p_pct:.2f}%, "
                             f"XML {c.speed_percent:.2f}%")

        # -- keyframed ramp, the thing an XML cannot carry -----------------------
        curve = remap_curve(pc)
        if pc.get("has_keyframed_remap") or len(curve) > 1:
            vals = [v for _, v in curve]
            ramps.append((c.clip_name, len(curve),
                          min(vals) if vals else 0, max(vals) if vals else 0))
            notes.append(f"KEYFRAMED RAMP: {len(curve)} keyframes — the XML flattens "
                         f"this to {c.speed_percent:.2f}%")

        # -- frame rate: interpreted vs what the XML recorded --------------------
        interp = (pc.get("interpretation") or {}).get("frame_rate")
        fps_note = "n/a"
        if isinstance(interp, (int, float)) and interp > 0:
            fps_note = f"{interp:.3f}/{c.source_fps:.3f}"
            if c.source_fps > 0 and abs(interp - c.source_fps) / interp > 0.002:
                notes.append(f"INTERPRETED RATE: Premiere cuts against "
                             f"{interp:.4f} fps, xmlcut uses {c.source_fps:.4f} fps "
                             f"from the file")

        # -- media path ---------------------------------------------------------
        p_path = (pc.get("project_item") or {}).get("media_path") or ""
        if p_path and c.source_path and p_path != c.source_path:
            notes.append(f"path differs:\n        panel {p_path}\n"
                         f"        xml   {c.source_path}")

        if notes:
            diffs.append((c.clip_name, notes))
        if args.all or notes:
            print(f"{c.clip_name[:20]:20s} {tick_note:>11s} {speed_note:>14s} "
                  f"{fps_note:>13s}  {'; '.join(n.split(chr(10))[0] for n in notes) if notes else 'ok'}")

    print("-" * 88)
    if unmatched:
        print(f"\n{unmatched} XML cut(s) could not be paired with a panel clip. Nested "
              "sequences look like this,\nsince the panel sees a nest as one clip while "
              "xmlcut resolves what is inside it.")
    if ambiguous:
        print(f"{ambiguous} of those had several clips stacked at the same instant and "
              "none carrying that\nfilename — reported rather than matched to a guess.")

    if ramps:
        print(f"\n{len(ramps)} clip(s) carry a KEYFRAMED speed ramp. This is the one "
              "thing\nan XML export genuinely cannot express:\n")
        for name, n, lo, hi in ramps:
            print(f"  {name}: {n} keyframes, values {lo:g}–{hi:g}")

    if not diffs:
        print("\nPremiere and the XML agree on every clip: source ranges, speeds, "
              "\nframe rates and paths. For this timeline the XML loses nothing, so a "
              "\npanel would buy convenience only — not accuracy.")
        return 0

    print(f"\n{len(diffs)} clip(s) differ:\n")
    for name, notes in diffs:
        print(f"  {name}")
        for n in notes:
            print(f"    - {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
