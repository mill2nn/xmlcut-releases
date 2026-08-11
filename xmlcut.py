#!/usr/bin/env python3
"""
xmlcut - extract every cut of a Premiere Pro timeline as an individual video file.

Reads a Final Cut Pro 7 XML export (Premiere: File > Export > Final Cut Pro XML),
resolves each clipitem back to its source media, and uses ffmpeg to cut the exact
frame range the editor used. Emits a CSV + JSON manifest describing every clip.

Every cut is re-encoded, deliberately: it is the only path that is frame exact. Stream
copy can start only on a keyframe, so on long-GOP H.264 it overran measured cut lengths
by 22-147%, contaminating clips with the neighbouring shot. There is no flag to turn
that back on.

Usage:
    python3 xmlcut.py timeline.xml -o ./clips
    python3 xmlcut.py timeline.xml -o ./clips --dry-run
    python3 xmlcut.py timeline.xml -o ./clips --remap "/Volumes/OldDrive=/Volumes/NewDrive"
    python3 xmlcut.py timeline.xml --manifest-only

Requires: ffmpeg + ffprobe on PATH. No third-party Python packages.
"""

from __future__ import annotations

import argparse
import collections
import csv
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.parse
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional

VERSION = "1.9"

# Stills sit on the timeline for N frames but have no playable duration —
# they need -loop instead of -ss/-t.
STILL_EXT = {".png", ".jpg", ".jpeg", ".psd", ".tif", ".tiff", ".bmp",
             ".tga", ".gif", ".exr", ".dpx", ".webp", ".ai", ".eps"}

# Project/comp files that ffmpeg cannot decode (dynamic-link, not media).
UNSUPPORTED_EXT = {".aep", ".prproj", ".psb", ".c4d", ".aet", ".ppj", ".fcpxml"}

# Premiere's native time unit. <pproTicksIn>/<pproTicksOut> give the source range in
# absolute seconds — immune to frame-rate conforming AND already correct for speed
# ramps, unlike <in>/<out>, which on a retimed clip describe the pre-remap range.
PPRO_TICKS_PER_SECOND = 254016000000

# Nested sequences are resolved recursively; the cap is a runaway guard, not a limit
# anyone should hit deliberately.
MAX_NEST_DEPTH = 4

# The encoder settings, decided once rather than exposed as knobs.
#
# crf 0 is x264's lossless mode, and it is lossless in the strict sense: verified
# bit-exact against the decoded source, so a clip carries the same samples the editor
# saw. It costs roughly 3x the file size of crf 16. For a training dataset that is the
# right trade — an artefact introduced here is indistinguishable from one the model is
# supposed to learn from.
#
# veryfast rather than medium because the preset only changes how hard x264 works to
# compress; it never moves a frame boundary. Measured frame-exact at every preset, and
# ~30% faster than medium.
X264_CRF = "0"
X264_PRESET = "veryfast"

# How many clips to encode at once. Not auto-detected from the core count, and
# deliberately not the core count itself: libx264 already parallelises across every
# core inside a single encode, so extra concurrent encodes only add contention.
# Measured on 24 clips of 1080x1920 lossless, best of two runs each:
#     4 jobs 7.2s · 7 jobs 7.7s · 14 jobs 8.3s · 14 jobs w/ 2 threads 7.9s
# i.e. more jobs is SLOWER, and the whole spread is 19%. Four would win on local
# media, but sources on Google Drive File Stream block on network reads, and there
# parallelism does pay — so this sits in the middle and is capped so it stays sane on
# an 8-core laptop as well as a 14-core desktop.
JOBS = min(8, os.cpu_count() or 4)

# What libx264 can encode directly. Anything outside this has to be converted, which is
# a real loss, so it gets recorded rather than done quietly.
X264_PIX_FMTS = {
    "yuv420p", "yuvj420p", "yuv422p", "yuvj422p", "yuv444p", "yuvj444p",
    "nv12", "nv16", "nv21", "yuv420p10le", "yuv422p10le", "yuv444p10le",
    "nv20le", "gray", "gray10le",
}


# --------------------------------------------------------------------------
# self update
# --------------------------------------------------------------------------
#
# Teammates get fixes by clicking Update, not by being sent a new zip. The version
# lives in latest.json in a small PUBLIC repo — public because a private one would need
# an access token inside the tool, i.e. a credential handed to everyone who installs it.
#
# ⚠️ Trust model, stated plainly: anyone able to push to that repo can run code on every
# machine running xmlcut. It is the same bargain as any auto-updater, and the reason the
# owner/repo/branch below are pinned constants rather than anything configurable.

UPDATE_OWNER = "mill2nn"
UPDATE_REPO = "xmlcut-releases"
UPDATE_BRANCH = "main"
UPDATE_FILES = ["xmlcut.py", "xmlcut_gui.py", "README.md", "Open xmlcut GUI.command"]
UPDATE_TIMEOUT = 15


def _update_urls(rel: str) -> list[str]:
    """Where to read a released file from, API first — and why not raw first.

    raw.githubusercontent sits behind a CDN with max-age=300. Publish a release and the
    check keeps reading the OLD version for up to five minutes: equal to what is
    installed, so no update is offered and nothing reports an error anywhere. The
    contents API answers from the repository itself and is correct immediately;
    `Accept: application/vnd.github.raw` returns the bytes rather than base64.

    raw stays as the fallback for when the API refuses — unauthenticated calls are capped
    at 60 an hour per address, and a shared office connection can reach that. A late
    update is worth more than no update.
    """
    return [
        f"https://api.github.com/repos/{UPDATE_OWNER}/{UPDATE_REPO}/contents/{rel}"
        f"?ref={UPDATE_BRANCH}",
        f"https://raw.githubusercontent.com/{UPDATE_OWNER}/{UPDATE_REPO}/"
        f"{UPDATE_BRANCH}/{rel}",
    ]


def _fetch(rel: str) -> bytes:
    import urllib.request
    last = None
    for i, url in enumerate(_update_urls(rel)):
        req = urllib.request.Request(url, headers={
            "User-Agent": f"xmlcut/{VERSION}",
            **({"Accept": "application/vnd.github.raw"} if i == 0 else {}),
        })
        try:
            with urllib.request.urlopen(req, timeout=UPDATE_TIMEOUT) as r:
                return r.read()
        except Exception as e:      # noqa: BLE001 - any failure just tries the fallback
            last = e
    raise RuntimeError(f"could not read {rel}: {last}")


def version_key(v: str) -> tuple:
    return tuple(int(x) if x.isdigit() else 0 for x in str(v).split("."))


def install_dir() -> Path:
    return Path(__file__).resolve().parent


def check_update() -> Optional[dict]:
    """latest.json if it names a newer version, else None. Never raises."""
    try:
        info = json.loads(_fetch("latest.json").decode("utf-8"))
    except Exception:
        return None
    if version_key(info.get("version", "0")) > version_key(VERSION):
        return info
    return None


def apply_update(info: dict) -> tuple[bool, str]:
    """Download the released files and swap them in, or change nothing at all.

    Every file is fetched and validated BEFORE anything on disk is touched, because a
    half-written update is worse than no update: a truncated .py leaves a tool that will
    not start. Python files are compiled to prove they parse, and the new xmlcut.py must
    report the version latest.json promised — that catches a publish where the files and
    the version number disagree.
    """
    here = install_dir()
    if (here / ".git").exists():
        return False, ("this is the source checkout, not an installed copy — "
                       "use `git pull` instead so nothing overwrites your work")

    files = info.get("files") or UPDATE_FILES
    got: dict[str, bytes] = {}
    for rel in files:
        try:
            data = _fetch(rel)
        except Exception as e:
            return False, f"download failed ({rel}): {e} — nothing was changed"
        if not data:
            return False, f"{rel} came back empty — nothing was changed"
        if rel.endswith(".py"):
            try:
                compile(data.decode("utf-8"), rel, "exec")
            except (SyntaxError, UnicodeDecodeError) as e:
                return False, f"{rel} did not parse ({e}) — nothing was changed"
            if rel == "xmlcut.py":
                m = re.search(r'VERSION\s*=\s*"([^"]+)"', data.decode("utf-8"))
                if not m or m.group(1) != info.get("version"):
                    return False, (f"the download says "
                                   f"{m.group(1) if m else 'no version'}, not "
                                   f"{info.get('version')} — nothing was changed")
        got[rel] = data

    backup = here / ".backup"
    saved: list[str] = []
    try:
        shutil.rmtree(backup, ignore_errors=True)
        for rel in files:
            src = here / rel
            if src.exists():
                dst = backup / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                dst.write_bytes(src.read_bytes())
                saved.append(rel)
    except Exception as e:
        return False, f"couldn't back up the current version ({e}) — nothing was changed"

    try:
        for rel, data in got.items():
            target = here / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            if target.suffix == ".command":
                target.chmod(0o755)      # a downloaded launcher must stay double-clickable
    except Exception as e:
        for rel in saved:                # put it back exactly as it was
            try:
                (here / rel).write_bytes((backup / rel).read_bytes())
            except Exception:
                pass
        return False, f"update failed ({e}) — rolled back, still on {VERSION}"

    return True, (f"updated {VERSION} → {info['version']}. The previous version is in "
                  f".backup if you need it. Quit and reopen to run the new code.")


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------

def txt(node: Optional[ET.Element], path: str, default: str = "") -> str:
    if node is None:
        return default
    found = node.find(path)
    if found is None or found.text is None:
        return default
    return found.text.strip()


def num(node: Optional[ET.Element], path: str, default: Optional[float] = None) -> Optional[float]:
    raw = txt(node, path)
    if raw == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def parse_rate(rate_node: Optional[ET.Element], fallback: float = 25.0) -> float:
    """FCP7 <rate><timebase>N</timebase><ntsc>TRUE|FALSE</ntsc></rate>."""
    if rate_node is None:
        return fallback
    timebase = num(rate_node, "timebase")
    if timebase is None:
        return fallback
    ntsc = txt(rate_node, "ntsc").upper() == "TRUE"
    return timebase * 1000.0 / 1001.0 if ntsc else float(timebase)


def pathurl_to_path(pathurl: str) -> str:
    """file://localhost/Volumes/Media/A%20Clip.mp4 -> /Volumes/Media/A Clip.mp4"""
    if not pathurl:
        return ""
    p = urllib.parse.unquote(pathurl.strip())
    for prefix in ("file://localhost", "file://", "file:"):
        if p.startswith(prefix):
            p = p[len(prefix):]
            break
    # Windows exports look like /C:/Footage/...
    if re.match(r"^/[A-Za-z]:", p):
        p = p[1:]
    return p


def frames_to_tc(frames: float, fps: float) -> str:
    """Non-drop timecode HH:MM:SS:FF."""
    if fps <= 0:
        return "00:00:00:00"
    f = int(round(frames))
    fps_i = int(round(fps))
    h, rem = divmod(f, fps_i * 3600)
    m, rem = divmod(rem, fps_i * 60)
    s, ff = divmod(rem, fps_i)
    return f"{h:02d}:{m:02d}:{s:02d}:{ff:02d}"


def frames_to_seconds(frames: float, fps: float) -> float:
    return frames / fps if fps > 0 else 0.0


def read_timeremap(clip: ET.Element) -> tuple[float, bool, bool, str, list]:
    """Pull speed / reverse / ramp info out of a clipitem's filters.

    Returns (speed_percent, reversed, varies, span, other_filter_names).

    Premiere records a reverse in two ways depending on version — a negative speed,
    or a `reverse` parameter set to TRUE — so both are accepted and normalised to a
    positive speed plus a reversed flag. A KEYFRAMED ramp is detected but not
    followed: only one representative speed is returned, with `varies` set so the
    caller can say so out loud rather than quietly pretending it was constant.
    """
    speed = 100.0
    reverse = False
    kf_values: list[float] = []
    others: list = []

    for filt in clip.findall("filter"):
        eid = txt(filt, "effect/effectid")
        ename = txt(filt, "effect/name")
        if eid == "timeremap":
            for p in filt.findall("effect/parameter"):
                pid = txt(p, "parameterid")
                if pid == "speed":
                    v = num(p, "value", None)
                    if v is not None:
                        speed = v
                    for kf in p.findall("keyframe"):
                        kv = num(kf, "value", None)
                        if kv is not None:
                            kf_values.append(kv)
                elif pid == "reverse":
                    reverse = txt(p, "value").upper() == "TRUE"
        elif ename or eid:
            others.append(ename or eid)

    if kf_values and speed == 100.0:
        speed = kf_values[0]           # no flat <value>; take the ramp's first key
    if speed < 0:
        reverse, speed = True, abs(speed)

    distinct = sorted({round(abs(v), 3) for v in kf_values})
    varies = len(distinct) > 1
    span = f"{distinct[0]:g}–{distinct[-1]:g}%" if varies else ""
    return (speed or 100.0), reverse, varies, span, others


def secs_cs(frames: float, fps: float) -> str:
    """One timeline position as seconds and hundredths: 2.5 s -> "02.50".

    The separator is a dot, not the colon you would write by hand: Finder still treats ':'
    in a filename as a path separator and displays it as '/', which would turn a tidy
    "(00:00-00:02)" into "(00/00-00/02)". A dot also keeps the hyphen free to mean one
    thing only — the gap between the two ends of the range.
    """
    total = frames / fps if fps > 0 else 0.0
    whole = int(total)
    cs = int(round((total - whole) * 100))
    if cs >= 100:
        whole, cs = whole + 1, 0
    return f"{whole:02d}.{cs:02d}"


def tc_range(cut: "Cut", fps: float) -> str:
    """The clip's span on the timeline, for the filename: "(00.00-02.00)".

    A range rather than just the in-point, so a filename says how long the clip is and
    where it ends without opening anything or cross-referencing the sheet.
    """
    return f"({secs_cs(cut.timeline_in_frames, fps)}-{secs_cs(cut.timeline_out_frames, fps)})"


def sanitize(name: str, maxlen: int = 60) -> str:
    name = re.sub(r"[^\w\-. ]+", "_", name).strip().replace(" ", "_")
    name = re.sub(r"_+", "_", name)
    return name[:maxlen] or "clip"


# --------------------------------------------------------------------------
# data model
# --------------------------------------------------------------------------

@dataclass
class Cut:
    index: int = 0
    clip_name: str = ""
    track_type: str = "video"
    track_index: int = 1

    # timeline position (sequence frame rate)
    timeline_in_frames: int = 0
    timeline_out_frames: int = 0
    timeline_in_tc: str = ""
    timeline_out_tc: str = ""

    # source range (source frame rate)
    source_in_frames: int = 0
    source_out_frames: int = 0
    source_in_tc: str = ""
    source_out_tc: str = ""
    source_in_seconds: float = 0.0
    source_duration_seconds: float = 0.0
    timing_source: str = "frames"     # "ticks" (exact) or "frames" (derived)

    duration_frames: int = 0          # length on the timeline
    duration_seconds: float = 0.0
    source_consumed_frames: int = 0   # source material used (differs when speed != 100)

    # source media
    source_path: str = ""
    source_exists: bool = False
    file_id: str = ""

    # edit metadata
    speed_percent: float = 100.0   # always positive; a reverse shows in `reversed`
    reversed: bool = False         # played backwards on the timeline
    speed_varies: bool = False     # keyframed ramp — speed_percent is an approximation
    speed_span: str = ""           # "min–max %" when the ramp is keyframed
    enabled: bool = True
    transition_in: str = ""
    transition_out: str = ""
    edge_in_transition: str = ""   # "head", "tail" or "both" — edge reconstructed
    media_kind: str = "video"      # video | still | unsupported
    nested_from: str = ""          # name of the nested sequence this came out of
    nested_trimmed: str = ""       # "head", "tail" or "both" — clipped by the nest's in/out
    filters: list = field(default_factory=list)

    # technical specs (ffprobe)
    codec: str = ""
    width: Optional[int] = None
    height: Optional[int] = None
    source_fps: float = 0.0
    pix_fmt: str = ""
    bitrate: Optional[int] = None
    audio_codec: str = ""
    audio_channels: Optional[int] = None
    audio_sample_rate: Optional[int] = None

    # output
    output_file: str = ""
    pix_fmt_out: str = ""          # what was encoded; differs from pix_fmt = a conversion
    status: str = "pending"
    error: str = ""


# --------------------------------------------------------------------------
# XML parsing
# --------------------------------------------------------------------------

class SequenceChoice(Exception):
    """Raised when the XML holds several sequences and none was chosen."""
    def __init__(self, options):
        self.options = options


class Timeline:
    def __init__(self, xml_path: Path, remaps: list[tuple[str, str]], select: Optional[str] = None):
        self.xml_path = xml_path
        self.remaps = remaps
        self.select = select
        self.files: dict[str, dict] = {}
        self.cuts: list[Cut] = []
        self.markers: list[dict] = []
        # Things the caller must be told rather than left to discover: keyframed ramps
        # flattened, nests that resolved to nothing, nesting too deep to follow.
        self.warnings: list[str] = []
        self.sequence_name = ""
        self.sequence_fps = 25.0
        self.sequence_duration_frames = 0
        self.available_sequences: list[dict] = []
        self._parse()

    @staticmethod
    def top_level_sequences(root: ET.Element) -> list[ET.Element]:
        """Project sequences only — not the ones living inside a nested clipitem.

        `.//sequence` also returns every nested sequence, which then shows up in the
        picker as though it were a timeline you might have meant to cut. On a real
        project that is an invitation to cut the wrong thing.
        """
        nested = {id(s) for s in root.findall(".//clipitem/sequence")}
        return [s for s in root.findall(".//sequence") if id(s) not in nested]

    @staticmethod
    def list_sequences(xml_path: Path) -> list[dict]:
        root = ET.parse(xml_path).getroot()
        out = []
        for i, seq in enumerate(Timeline.top_level_sequences(root), start=1):
            fps = parse_rate(seq.find("rate"), 25.0)
            dur = int(num(seq, "duration", 0) or 0)
            out.append({
                "index": i,
                "name": txt(seq, "name", f"Sequence {i}"),
                "fps": round(fps, 3),
                "duration_frames": dur,
                "duration_tc": frames_to_tc(dur, fps),
                "clip_count": len(seq.findall(".//clipitem")),
            })
        return out

    def _pick_sequence(self, root: ET.Element) -> ET.Element:
        seqs = self.top_level_sequences(root)
        if not seqs:
            raise SystemExit("No <sequence> found — is this a Final Cut Pro 7 XML export?")

        self.available_sequences = self.list_sequences(self.xml_path)

        if len(seqs) == 1:
            return seqs[0]

        if self.select is None:
            # Premiere exports the WHOLE project, so multi-sequence XML is common.
            # Guessing here would silently cut the wrong timeline.
            raise SequenceChoice(self.available_sequences)

        if self.select.isdigit():
            i = int(self.select)
            if 1 <= i <= len(seqs):
                return seqs[i - 1]
            raise SystemExit(f"error: --sequence {i} out of range (1..{len(seqs)})")

        target = self.select.lower()
        exact = [s for s in seqs if txt(s, "name").lower() == target]
        if exact:
            return exact[0]
        partial = [s for s in seqs if target in txt(s, "name").lower()]
        if len(partial) == 1:
            return partial[0]
        if len(partial) > 1:
            names = ", ".join(txt(s, "name") for s in partial)
            raise SystemExit(f"error: --sequence {self.select!r} is ambiguous: {names}")
        raise SystemExit(f"error: no sequence named {self.select!r}. Use --list-sequences.")

    # -- path resolution --------------------------------------------------
    def _resolve(self, path: str) -> str:
        for old, new in self.remaps:
            if path.startswith(old):
                path = new + path[len(old):]
        return path

    # -- file table -------------------------------------------------------
    def _register_file(self, file_node: ET.Element) -> str:
        """FCP7 defines a <file> fully once; later clipitems reference it by id only."""
        fid = file_node.get("id", "")
        if not fid:
            fid = txt(file_node, "name") or f"anon-{len(self.files)}"
        has_body = file_node.find("pathurl") is not None or file_node.find("name") is not None
        if fid in self.files and not has_body:
            return fid
        if not has_body:
            return fid

        raw = txt(file_node, "pathurl")
        path = self._resolve(pathurl_to_path(raw))
        fps = parse_rate(file_node.find("rate"), self.sequence_fps)

        entry = self.files.get(fid, {})
        entry.update({
            "id": fid,
            "name": txt(file_node, "name"),
            "pathurl": raw,
            "path": path,
            "fps": fps,
            "duration": num(file_node, "duration", 0.0),
        })
        self.files[fid] = entry
        return fid

    # -- main parse -------------------------------------------------------
    def _parse(self):
        root = ET.parse(self.xml_path).getroot()
        seq = self._pick_sequence(root)

        self.sequence_name = txt(seq, "name", "Untitled Sequence")
        self.sequence_fps = parse_rate(seq.find("rate"), 25.0)
        self.sequence_duration_frames = int(num(seq, "duration", 0) or 0)

        for m in seq.findall("marker"):
            self.markers.append({
                "name": txt(m, "name"),
                "comment": txt(m, "comment"),
                "in_frames": int(num(m, "in", -1) or -1),
                "out_frames": int(num(m, "out", -1) or -1),
                "in_tc": frames_to_tc(num(m, "in", 0) or 0, self.sequence_fps),
            })

        media = seq.find("media")
        if media is None:
            raise SystemExit("Sequence has no <media> section.")

        for track_type in ("video", "audio"):
            section = media.find(track_type)
            if section is None:
                continue
            for t_idx, track in enumerate(section.findall("track"), start=1):
                transitions = self._collect_transitions(track)
                for clip in track.findall("clipitem"):
                    # A clipitem holds EITHER a <file> or a nested <sequence>. Skipping
                    # the latter silently drops every cut inside the nest — real
                    # timelines here do use nests, so those clips were simply absent
                    # from the dataset with nothing to show they were missing.
                    if clip.find("sequence") is not None:
                        self.cuts.extend(
                            self._parse_nested(clip, track_type, t_idx, depth=1))
                        continue
                    cut = self._parse_clipitem(clip, track_type, t_idx, transitions)
                    if cut:
                        self.cuts.append(cut)

        # order by timeline position, video first
        self.cuts.sort(key=lambda c: (c.timeline_in_frames, c.track_type != "video", c.track_index))
        for i, c in enumerate(self.cuts, start=1):
            c.index = i

    def _collect_transitions(self, track: ET.Element) -> list[dict]:
        out = []
        for tr in track.findall("transitionitem"):
            out.append({
                "start": int(num(tr, "start", 0) or 0),
                "end": int(num(tr, "end", 0) or 0),
                "alignment": txt(tr, "alignment"),
                "name": txt(tr, "effect/name") or txt(tr, "effect/effectid") or "transition",
            })
        return out

    def _parse_nested(self, clip, track_type, t_idx, depth: int) -> list[Cut]:
        """Resolve a clipitem that contains a <sequence> instead of a <file>.

        The cuts are inside the nest; what the parent timeline contributes is a window
        (<in>/<out>), a position (<start>/<end>), and possibly its own speed. So each
        inner cut is kept only if it is visible through that window, trimmed to it, and
        re-expressed in parent time.

        ASSUMPTION, stated because it is the one that could be wrong: a nest's
        <in>/<out> are read in the CLIPITEM's rate, exactly as a file clipitem's are —
        Premiere conforms both to the parent sequence rate. Inner clipitems' own
        <start>/<end> are read in the NESTED sequence's rate. That is self-consistent
        and verified against the fixture, but it has not been checked against a real
        Premiere export of a nested timeline. Compare the cut count with Premiere the
        first time you run this on one.
        """
        seq = clip.find("sequence")
        name = txt(clip, "name") or txt(seq, "name") or "Nested Sequence"
        if depth > MAX_NEST_DEPTH:
            self.warnings.append(f"{name}: nested deeper than {MAX_NEST_DEPTH} levels "
                                 f"— those cuts are not extracted")
            return []

        nest_fps = parse_rate(seq.find("rate"), self.sequence_fps)
        clip_fps = parse_rate(clip.find("rate"), self.sequence_fps)
        nest_start = num(clip, "start", 0) or 0
        nest_end = num(clip, "end", 0) or 0
        nest_in = num(clip, "in", 0) or 0
        nest_out = num(clip, "out", 0) or 0
        if nest_out <= nest_in:
            self.warnings.append(f"{name}: nest has no visible range — skipped")
            return []

        span = nest_out - nest_in
        if nest_start < 0 and nest_end >= 0:      # edge under a transition
            nest_start = nest_end - span
        elif nest_end < 0 and nest_start >= 0:
            nest_end = nest_start + span
        if nest_start < 0:
            self.warnings.append(f"{name}: nest has no usable timeline position — skipped")
            return []

        nest_speed, nest_rev, nest_varies, nest_span, _ = read_timeremap(clip)
        if nest_varies:
            self.warnings.append(f"{name}: the NEST itself has a keyframed ramp "
                                 f"({nest_span}) — treated as constant {nest_speed:g}%")
        k_nest = (nest_speed / 100.0) or 1.0

        media = seq.find("media")
        section = media.find(track_type) if media is not None else None
        if section is None:
            return []

        # The visible window inside the nested timeline, in seconds
        win_lo = nest_in / clip_fps
        win_hi = nest_out / clip_fps
        parent_lo_s = nest_start / self.sequence_fps

        out: list[Cut] = []
        for track in section.findall("track"):
            transitions = self._collect_transitions(track)
            for inner in track.findall("clipitem"):
                if inner.find("sequence") is not None:
                    out.extend(self._parse_nested(inner, track_type, t_idx, depth + 1))
                    continue
                c = self._parse_clipitem(inner, track_type, t_idx, transitions,
                                         seq_fps=nest_fps)
                if c is None:
                    continue

                a = c.timeline_in_frames / nest_fps      # inner extent, nest seconds
                b = c.timeline_out_frames / nest_fps
                lo, hi = max(a, win_lo), min(b, win_hi)
                if hi - lo <= 1e-9:
                    continue                             # scrolled out of the window

                head = lo - a
                tail = b - hi
                if head > 1e-9 or tail > 1e-9:
                    c.nested_trimmed = ("both" if head > 1e-9 and tail > 1e-9
                                        else "head" if head > 1e-9 else "tail")
                    # Trim the source range by the same amount of material, scaled by
                    # the inner clip's own speed. A reversed clip is consumed from the
                    # far end, so its head trim comes off the tail of the source range.
                    k_in = (c.speed_percent / 100.0) or 1.0
                    if c.reversed:
                        c.source_duration_seconds -= (head + tail) * k_in
                    else:
                        c.source_in_seconds += head * k_in
                        c.source_duration_seconds -= (head + tail) * k_in
                    if c.source_duration_seconds <= 0:
                        continue
                    if c.source_fps > 0:
                        c.source_consumed_frames = max(
                            1, int(round(c.source_duration_seconds * c.source_fps)))

                # re-express in parent time
                vis = (hi - lo) / k_nest
                p_in = parent_lo_s + (lo - win_lo) / k_nest
                c.timeline_in_frames = int(round(p_in * self.sequence_fps))
                c.timeline_out_frames = int(round((p_in + vis) * self.sequence_fps))
                c.duration_frames = max(1, c.timeline_out_frames - c.timeline_in_frames)
                c.timeline_in_tc = frames_to_tc(c.timeline_in_frames, self.sequence_fps)
                c.timeline_out_tc = frames_to_tc(c.timeline_out_frames, self.sequence_fps)
                c.duration_seconds = round(vis, 6)

                # the nest's own retime compounds with the clip's
                c.speed_percent = round(c.speed_percent * nest_speed / 100.0, 6)
                c.reversed = bool(c.reversed) != bool(nest_rev)   # both = forwards again
                c.speed_varies = c.speed_varies or nest_varies
                c.nested_from = name
                out.append(c)

        if not out:
            self.warnings.append(f"{name}: nested sequence resolved to no visible cuts")
        return out

    def _parse_clipitem(self, clip, track_type, t_idx, transitions,
                        seq_fps: Optional[float] = None) -> Optional[Cut]:
        # seq_fps overrides the sequence rate when this clipitem lives inside a nested
        # sequence — its timeline positions are counted in the NEST's rate, not the
        # parent's, and conflating the two shifts every nested cut.
        seq_fps = self.sequence_fps if seq_fps is None else seq_fps
        file_node = clip.find("file")
        if file_node is None:
            return None
        fid = self._register_file(file_node)
        finfo = self.files.get(fid, {})
        if not finfo.get("path"):
            return None

        start = num(clip, "start", 0) or 0
        end = num(clip, "end", 0) or 0
        c_in = num(clip, "in", 0) or 0
        c_out = num(clip, "out", 0) or 0

        if start < 0 and end < 0:
            return None

        # CRITICAL: <in>/<out> are expressed in the CLIPITEM's rate — which Premiere
        # conforms to the sequence rate — NOT the source file's native rate. A 24 fps
        # file in a 30 fps timeline has in/out counted in 30ths of a second. Using the
        # file's 24 fps here stretches every seek and duration by 30/24 = 1.25x.
        clip_fps = parse_rate(clip.find("rate"), seq_fps)
        file_fps = finfo.get("fps") or clip_fps

        # Timeline length is end-start; on a retimed clip that differs from out-in.
        dur_frames = int(round(end - start)) if (start >= 0 and end >= 0) else 0
        if dur_frames <= 0:
            dur_frames = int(round(c_out - c_in))
        if dur_frames <= 0:
            return None

        # Premiere writes start or end as -1 when that edge is buried under a
        # transition. Rebuild the real edge from the other side + duration,
        # otherwise the clip sorts to the top with a nonsense timecode.
        edge = ""
        if start < 0 and end >= 0:
            start, edge = end - dur_frames, "head"
        elif end < 0 and start >= 0:
            end, edge = start + dur_frames, "tail"

        ext = Path(finfo["path"]).suffix.lower()
        if ext in UNSUPPORTED_EXT:
            kind = "unsupported"
        elif ext in STILL_EXT:
            kind = "still"
        else:
            kind = "video"

        # speed / reverse / ramp — needed before we can size the source range
        speed, reverse, varies, span_txt, filters = read_timeremap(clip)

        # Prefer Premiere's tick values: they are the source range in absolute
        # seconds, already correct for speed ramps. <in>/<out> on a retimed clip
        # describe the range BEFORE the remap, so trusting them pulls the wrong
        # footage — by over a second on a heavily sped-up shot.
        ticks_in = num(clip, "pproTicksIn", None)
        ticks_out = num(clip, "pproTicksOut", None)
        if ticks_in is not None and ticks_out is not None and ticks_out > ticks_in:
            src_in_sec = ticks_in / PPRO_TICKS_PER_SECOND
            src_dur_sec = (ticks_out - ticks_in) / PPRO_TICKS_PER_SECOND
            timing = "ticks"
        else:
            # A sped-up clip consumes more source than it occupies on the timeline:
            # 300% speed over 40 timeline frames eats 120 frames of source.
            span = int(round(dur_frames * (speed / 100.0))) if speed > 0 else dur_frames
            src_in_sec = frames_to_seconds(c_in, clip_fps)
            src_dur_sec = frames_to_seconds(span, clip_fps)
            timing = "frames"
        # Count consumed material in the SOURCE's native rate, not the sequence's.
        # This column means "how many source frames this clip ate", and it is also
        # what -frames:v pins on output. Using clip_fps here inflated every 24 fps
        # clip in a 30 fps timeline by 30/24 = 1.25x — the clips were correct while
        # the manifest describing them was not. Refined again after ffprobe, which
        # knows the real rate better than the XML does.
        consumed = int(round(src_dur_sec * file_fps)) if file_fps > 0 else 0

        cut = Cut(
            clip_name=txt(clip, "name") or finfo.get("name", "clip"),
            track_type=track_type,
            track_index=t_idx,
            timeline_in_frames=int(start),
            timeline_out_frames=int(end),
            timeline_in_tc=frames_to_tc(start, seq_fps),
            timeline_out_tc=frames_to_tc(end, seq_fps),
            source_in_frames=int(c_in),
            source_out_frames=int(c_out),
            source_in_tc=frames_to_tc(c_in, clip_fps),
            source_out_tc=frames_to_tc(c_out, clip_fps),
            # FULL PRECISION on purpose — these two drive the ffmpeg seek. Rounding
            # them to 6dp here cost a whole frame: 137/24 stored as 5.708333 comes
            # back as frame 136.999992, which floors to 136 and starts the cut one
            # frame early. Rounding happens at manifest-write time instead.
            source_in_seconds=src_in_sec,
            source_duration_seconds=src_dur_sec,
            timing_source=timing,
            duration_frames=dur_frames,
            duration_seconds=round(frames_to_seconds(dur_frames, seq_fps), 6),
            source_consumed_frames=consumed,
            source_path=finfo["path"],
            source_exists=os.path.isfile(finfo["path"]),
            file_id=fid,
            source_fps=round(file_fps, 6),
            speed_percent=speed,
            reversed=reverse,
            speed_varies=varies,
            speed_span=span_txt,
            filters=filters,
            enabled=txt(clip, "enabled", "TRUE").upper() != "FALSE",
            edge_in_transition=edge,
            media_kind=kind,
        )
        if varies:
            self.warnings.append(
                f"{cut.clip_name}: keyframed speed ramp ({span_txt}) treated as a "
                f"constant {speed:g}% — the extracted range is right, the retime is not")

        # A still's <in>/<out> are an arbitrary offset into a virtual 24h clip;
        # only the timeline duration is meaningful.
        if kind == "still":
            cut.source_in_seconds = 0.0
            cut.source_duration_seconds = frames_to_seconds(dur_frames, seq_fps)
            cut.source_consumed_frames = dur_frames
            cut.timing_source = "timeline"

        # adjacent transitions
        for tr in transitions:
            if abs(tr["end"] - cut.timeline_in_frames) <= 1 or (
                tr["start"] <= cut.timeline_in_frames <= tr["end"]
            ):
                cut.transition_in = tr["name"]
            if abs(tr["start"] - cut.timeline_out_frames) <= 1 or (
                tr["start"] <= cut.timeline_out_frames <= tr["end"]
            ):
                cut.transition_out = tr["name"]

        return cut


# --------------------------------------------------------------------------
# ffprobe / ffmpeg
# --------------------------------------------------------------------------

def probe(path: str) -> dict:
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-print_format", "json",
             "-show_streams", "-show_format", path],
            capture_output=True, text=True, timeout=60,
        )
        if r.returncode != 0:
            return {}
        return json.loads(r.stdout)
    except Exception:
        return {}


def apply_probe(cut: Cut, cache: dict) -> None:
    if not cut.source_exists:
        return
    if cut.source_path not in cache:
        cache[cut.source_path] = probe(cut.source_path)
    data = cache[cut.source_path]
    for s in data.get("streams", []):
        if s.get("codec_type") == "video" and not cut.codec:
            cut.codec = s.get("codec_name", "")
            cut.width = s.get("width")
            cut.height = s.get("height")
            cut.pix_fmt = s.get("pix_fmt", "")
            rfr = s.get("r_frame_rate", "0/1")
            try:
                n, d = rfr.split("/")
                if float(d):
                    cut.source_fps = round(float(n) / float(d), 6)
            except Exception:
                pass
        elif s.get("codec_type") == "audio" and not cut.audio_codec:
            cut.audio_codec = s.get("codec_name", "")
            cut.audio_channels = s.get("channels")
            sr = s.get("sample_rate")
            cut.audio_sample_rate = int(sr) if sr else None
    br = data.get("format", {}).get("bit_rate")
    cut.bitrate = int(br) if br else None

    # ffprobe is more authoritative about the native rate than the XML's <file><rate>,
    # so recompute the consumed-frame count against it. This keeps the manifest column
    # identical to the -frames:v value build_command pins, by construction.
    if cut.media_kind != "still" and cut.source_fps > 0:
        cut.source_consumed_frames = max(
            1, int(round(cut.source_duration_seconds * cut.source_fps)))


def pix_fmt_for(cut: Cut) -> str:
    """The pixel format to encode in, preserving the source's wherever x264 can.

    "Lossless" has to actually mean it. Forcing yuv420p on a 10-bit 4:2:2 ProRes source
    discards half the chroma and two bits per sample *before* the encoder sees them, and
    no crf value gets that back. So keep the source format when it is supported, and
    record what was used either way.

    Stills are the exception: they arrive as rgb24/rgba, which x264 cannot take, and they
    are usually graphics or a logo where 4:2:0 chroma subsampling is the most visible loss
    there is. 4:4:4 costs almost nothing across a handful of frames.
    """
    if cut.media_kind == "still":
        return "yuv444p"
    return cut.pix_fmt if cut.pix_fmt in X264_PIX_FMTS else "yuv420p"


def build_command(cut: Cut, out_path: Path, args, seq_fps: float) -> list[str]:
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]

    if cut.media_kind == "still":
        # A still has no timeline to seek into — loop it for the on-screen duration.
        cmd += ["-loop", "1", "-framerate", f"{seq_fps:.6f}", "-i", cut.source_path,
                "-t", f"{cut.source_duration_seconds:.6f}",
                "-c:v", args.vcodec, "-crf", X264_CRF, "-preset", X264_PRESET,
                "-pix_fmt", cut.pix_fmt_out,
                "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-an", str(out_path)]
        return cmd

    # ffmpeg's -ss takes the first frame whose PTS is >= the seek time, so aim HALF
    # A FRAME EARLY to land squarely on the wanted frame. Without this, a source at
    # a different rate to the timeline (24 fps media in a 30 fps sequence) computes
    # a time a hair past the frame boundary and ffmpeg starts one frame late.
    # --speed timeline means "the clip as it played on screen", which requires
    # resampling to the sequence rate. A speed ramp is the obvious case, but a
    # 100%-speed 24 fps clip in a 30 fps timeline needs it just as much: without
    # it the clip is pinned to its 48 native frames instead of the 60 sequence
    # frames it occupies, and comes out 20% short.
    rate_mismatch = cut.source_fps > 0 and abs(cut.source_fps - seq_fps) > 0.01
    retime = (getattr(args, "speed", "native") == "timeline"
              and (cut.speed_percent not in (0, 100) or rate_mismatch))

    ss, t = cut.source_in_seconds, cut.source_duration_seconds
    fps = cut.source_fps or 0
    n_frames = 0
    if fps > 0:
        # Tolerance is expressed in FRAMES, not seconds — a hair over a frame
        # boundary must floor down, but float noise and any upstream rounding must
        # not. 1e-4 of a frame is far above the noise and far below half a frame,
        # so a genuinely mid-frame in-point still floors correctly.
        start_f = int(ss * fps + 1e-4)
        n_frames = max(1, int(round(t * fps)))
        # ffmpeg's -ss takes the first frame whose PTS is >= the seek time, so aim
        # HALF A FRAME EARLY to land squarely on the wanted frame. Without this, a
        # source at a different rate to the timeline (24 fps media in a 30 fps
        # sequence) computes a time a hair past the boundary and starts one late.
        ss = max(0.0, (start_f - 0.5) / fps)
        t = (n_frames + 1) / fps     # generous bound; the exact count is pinned below

    if cut.track_type == "audio":
        # An audio-track clipitem must produce audio, not a video file with a soundtrack.
        # The old path fell through to the video branch and pinned -frames:v, which on an
        # audio-only source produced nothing at all.
        chain = ["areverse"] if cut.reversed else []
        if retime:
            rem = (cut.speed_percent / 100.0) or 1.0
            while rem > 2.0:                # atempo is valid only in [0.5, 2.0]
                chain.append("atempo=2.0"); rem /= 2.0
            while rem < 0.5:
                chain.append("atempo=0.5"); rem /= 0.5
            chain.append(f"atempo={rem:.6f}")
        cmd += ["-ss", f"{ss:.6f}", "-t", f"{cut.source_duration_seconds:.6f}",
                "-i", cut.source_path, "-vn"]
        if chain:
            cmd += ["-filter:a", ",".join(chain)]
        cmd += ["-c:a", "aac", "-b:a", "192k", str(out_path)]
        return cmd

    if retime or cut.reversed:
        # Trim on the INPUT side here: ffmpeg's default CFR sync re-times frames back
        # to the input rate on output, silently undoing setpts. Reading the exact
        # source range first, then resampling to the sequence rate with -r, is what
        # actually makes the clip play at the edited speed.
        k = (cut.speed_percent / 100.0) or 1.0
        vf: list[str] = []
        if cut.reversed:
            # `reverse` buffers everything that reaches it and emits it backwards, so
            # the FIRST output frame is the LAST input frame. The generous -t bound
            # above deliberately reads one frame more than wanted, which here would
            # land that spare frame at the very front of the clip — the one frame a
            # reversed cut can least afford to get wrong. So pin the exact set with
            # `select` before reversing, not with -frames:v after it.
            vf.append(f"select='lt(n\\,{max(1, n_frames)})'")
            vf.append("reverse")
        if retime:
            vf.append(f"setpts=PTS/{k:.6f}")
        elif cut.reversed:
            # reverse hands on the buffered timestamps; restamp for a clean CFR mux
            vf.append("setpts=N/FRAME_RATE/TB")

        cmd += ["-ss", f"{ss:.6f}", "-t", f"{t:.6f}", "-i", cut.source_path]
        if vf:
            cmd += ["-filter:v", ",".join(vf)]
        if retime:
            cmd += ["-r", f"{seq_fps:.6f}", "-frames:v", str(max(1, cut.duration_frames))]
        else:
            cmd += ["-frames:v", str(max(1, n_frames))]

        if not args.no_audio:
            chain = ["areverse"] if cut.reversed else []
            if retime:
                rem = k
                while rem > 2.0:        # atempo is valid only in [0.5, 2.0]
                    chain.append("atempo=2.0"); rem /= 2.0
                while rem < 0.5:
                    chain.append("atempo=0.5"); rem /= 0.5
                chain.append(f"atempo={rem:.6f}")
            if chain:
                cmd += ["-filter:a", ",".join(chain)]
        cmd += ["-c:v", args.vcodec, "-crf", X264_CRF, "-preset", X264_PRESET,
                "-pix_fmt", cut.pix_fmt_out]
        cmd += ["-an"] if args.no_audio else ["-c:a", "aac", "-b:a", "192k"]
        cmd += [str(out_path)]
        return cmd

    cmd += ["-ss", f"{ss:.6f}", "-i", cut.source_path]
    cmd += ["-t", f"{t:.6f}"]
    # Frame count, not duration, is what must be exact — -t alone loses the last
    # frame to timestamp rounding on roughly half of real-world clips.
    if n_frames:
        cmd += ["-frames:v", str(n_frames)]

    cmd += [
        "-c:v", args.vcodec,
        "-crf", X264_CRF,
        "-preset", X264_PRESET,
        "-pix_fmt", cut.pix_fmt_out,
    ]
    if args.no_audio:
        cmd += ["-an"]
    else:
        cmd += ["-c:a", "aac", "-b:a", "192k"]
    cmd += [str(out_path)]
    return cmd


def assign_output_names(cuts: list[Cut], container: str, seq_fps: float) -> None:
    """Name every clip before anything is cut.

    Done here rather than inside run_cut for two reasons: a scan can then show and export
    the filenames without encoding anything (output_file used to be blank until a cut ran),
    and the index width can be chosen from the total, so 100+ clips still sort correctly
    instead of "100" landing before "99".

    Shape: index _ (start-end) _ the SOURCE file's name. The source name rather than the
    clip name because that is what you go looking for when you want the original.
    """
    pad = max(2, len(str(len(cuts))))
    for c in cuts:
        ext = ".m4a" if c.track_type == "audio" else f".{container}"
        stem = Path(c.source_path).stem or c.clip_name or "clip"
        c.output_file = (f"{c.index:0{pad}d}_{tc_range(c, seq_fps)}"
                         f"_{sanitize(stem, 40)}{ext}")


def run_cut(cut: Cut, outdir: Path, args, seq_fps: float = 25.0) -> Cut:
    if cut.media_kind == "unsupported":
        cut.status = "unsupported"
        cut.error = (f"{Path(cut.source_path).suffix} is a project/comp file "
                     f"(Dynamic Link), not decodable media — render it out first")
        return cut
    if not cut.source_exists:
        cut.status = "missing_source"
        cut.error = f"Source not found: {cut.source_path}"
        return cut
    if (cut.track_type == "audio" and not cut.audio_codec
            and not getattr(args, "no_probe", False)):
        # Premiere happily puts a clip on an audio track whose source has no audio —
        # a muted camera file, an AI-generated shot. ffmpeg's own error for that is
        # "Output file does not contain any stream", which explains nothing.
        cut.status = "no_audio"
        cut.error = "source has no audio stream — nothing to extract on an audio track"
        return cut

    cut.pix_fmt_out = pix_fmt_for(cut)
    if not cut.output_file:          # assign_output_names normally did this already
        assign_output_names([cut], args.container, seq_fps)
    out_path = outdir / cut.output_file

    if args.dry_run:
        cut.status = "dry_run"
        return cut

    # --resume: a long run that died halfway shouldn't re-encode what it already wrote.
    # Only a non-empty file counts; a truncated 0-byte leftover gets redone.
    if getattr(args, "resume", False) and out_path.exists() and out_path.stat().st_size > 0:
        cut.status = "skipped_existing"
        return cut

    cmd = build_command(cut, out_path, args, seq_fps)
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=args.timeout)
        if r.returncode != 0:
            cut.status = "failed"
            cut.error = (r.stderr or "").strip()[:400]
        elif not out_path.exists() or out_path.stat().st_size == 0:
            cut.status = "failed"
            cut.error = "ffmpeg produced an empty file"
        else:
            cut.status = "ok"
    except subprocess.TimeoutExpired:
        cut.status = "failed"
        cut.error = f"ffmpeg timed out after {args.timeout}s"
    except Exception as e:
        cut.status = "failed"
        cut.error = str(e)[:400]
    return cut


# --------------------------------------------------------------------------
# manifest
# --------------------------------------------------------------------------

SECONDS_FIELDS = ("source_in_seconds", "source_duration_seconds", "duration_seconds")


def readable(cut: Cut) -> dict:
    """Cut as a dict, with the seconds fields rounded for human/CSV consumption.

    Rounding happens HERE and nowhere earlier: the in-memory values feed the ffmpeg
    seek, where losing the 7th decimal loses a whole frame.
    """
    d = asdict(cut)
    for k in SECONDS_FIELDS:
        if isinstance(d.get(k), float):
            d[k] = round(d[k], 6)
    return d


SHEET_COLUMNS = [
    ("file", "output_file"),
    ("clip name", "clip_name"),
    ("timeline in", "timeline_in_tc"),
    ("timeline out", "timeline_out_tc"),
    ("original name", None),          # basename of source_path
    ("original path", "source_path"),
]


def write_sheet(tl: Timeline, outdir: Path) -> Path:
    """A short, readable sheet: which file came from where.

    manifest.csv already holds all of this among 46 columns, which is the wrong shape for
    opening in Sheets and eyeballing. This is the six columns you actually look things up
    by — and it matters more now that the filename no longer spells out the full timecode.
    """
    path = outdir / "clips.csv"
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow([label for label, _ in SHEET_COLUMNS])
        for c in tl.cuts:
            row = []
            for label, attr in SHEET_COLUMNS:
                if attr is None:
                    row.append(Path(c.source_path).name)
                else:
                    row.append(getattr(c, attr))
            w.writerow(row)
    return path


def write_manifest(tl: Timeline, outdir: Path, args) -> tuple[Path, Path, Path]:
    outdir.mkdir(parents=True, exist_ok=True)
    rows = [readable(c) for c in tl.cuts]
    for r in rows:
        r["filters"] = "; ".join(r["filters"])

    csv_path = outdir / "manifest.csv"
    if rows:
        with open(csv_path, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)

    json_path = outdir / "manifest.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump({
            "tool": f"xmlcut {VERSION}",
            "source_xml": str(tl.xml_path),
            "sequence": {
                "name": tl.sequence_name,
                "fps": round(tl.sequence_fps, 6),
                "duration_frames": tl.sequence_duration_frames,
                "duration_tc": frames_to_tc(tl.sequence_duration_frames, tl.sequence_fps),
            },
            "settings": {
                "encode": f"libx264 crf {X264_CRF} (lossless), preset {X264_PRESET}",
                "jobs": JOBS,
                "speed": getattr(args, "speed", "native"),
            },
            "warnings": tl.warnings,
            "counts": {
                "cuts": len(tl.cuts),
                "unique_sources": len({c.source_path for c in tl.cuts}),
                "missing_sources": sum(1 for c in tl.cuts if not c.source_exists),
                "ok": sum(1 for c in tl.cuts if c.status == "ok"),
                "failed": sum(1 for c in tl.cuts if c.status == "failed"),
            },
            "markers": tl.markers,
            "clips": [readable(c) for c in tl.cuts],
        }, f, indent=2)
    return csv_path, json_path, write_sheet(tl, outdir)


# --------------------------------------------------------------------------
# cli
# --------------------------------------------------------------------------

def clean_dropped_path(raw: str) -> str:
    """Finder drag-and-drop adds quotes and backslash-escapes spaces."""
    p = raw.strip()
    if len(p) >= 2 and p[0] == p[-1] and p[0] in "\"'":
        p = p[1:-1]
    p = re.sub(r"\\(.)", r"\1", p)          # unescape \  \( etc.
    return os.path.expanduser(p.strip())


def interactive_setup(args) -> None:
    """Walk the user through it when xmlcut is run with no arguments."""
    print("=" * 62)
    print("  xmlcut — Premiere timeline into individual clips")
    print("=" * 62)
    print("\nIn Premiere: File > Export > Final Cut Pro XML...")
    print("Then drag that XML file into this window and press return.\n")

    while True:
        raw = input("XML file: ").strip()
        if not raw:
            sys.exit("Nothing entered — stopping.")
        path = Path(clean_dropped_path(raw))
        if path.is_file():
            args.xml = path
            break
        print(f"  Can't find that file. Try dragging it in again.\n")

    seqs = Timeline.list_sequences(args.xml)
    if len(seqs) > 1:
        print(f"\n{len(seqs)} sequences in this file:\n")
        print(f"  {'#':>3}  {'name':40s} {'fps':>6s} {'duration':>12s} {'clips':>7s}")
        for s in seqs:
            print(f"  {s['index']:>3}  {s['name'][:40]:40s} {s['fps']:>6g} "
                  f"{s['duration_tc']:>12s} {s['clip_count']:>7d}")
        while True:
            pick = input(f"\nWhich sequence? [1-{len(seqs)}, default 1]: ").strip() or "1"
            if pick.isdigit() and 1 <= int(pick) <= len(seqs):
                args.sequence = pick
                break
            print("  Enter one of the numbers above.")

    default_out = args.xml.parent / "clips"
    raw = input(f"\nWhere should the clips go? [{default_out}]: ").strip()
    args.out = Path(clean_dropped_path(raw)) if raw else default_out

    print("\nChecking the timeline before cutting anything...\n")
    args.manifest_only = True
    args.interactive = True


def cli_update() -> int:
    print(f"xmlcut {VERSION} — checking for an update ...")
    info = check_update()
    if info is None:
        print("  You are on the newest release (or the check could not reach GitHub).")
        return 0
    print(f"\n  {info['version']} is available.")
    if info.get("notes"):
        print(f"  {info['notes']}")
    print(f"  Files: {', '.join(info.get('files') or UPDATE_FILES)}")
    if input("\nInstall it now? [Y/n]: ").strip().lower().startswith("n"):
        print("  Left alone.")
        return 0
    ok, msg = apply_update(info)
    print(f"\n  {msg}")
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser(
        description="Extract every cut of a Premiere Pro timeline from its FCP7 XML export.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    ap.add_argument("xml", type=Path, nargs="?",
                    help="Final Cut Pro 7 XML exported from Premiere "
                         "(omit it to be walked through step by step)")
    ap.add_argument("-o", "--out", type=Path, default=Path("./clips"), help="output directory")
    ap.add_argument("--tracks", choices=["video", "audio", "all"], default="video",
                    help="which tracks to extract (default: video)")
    ap.add_argument("--remap", action="append", default=[], metavar="OLD=NEW",
                    help="rewrite source paths, e.g. /Volumes/Old=/Volumes/New (repeatable)")
    ap.add_argument("--sequence", metavar="NAME|N",
                    help="which sequence to cut, by name or 1-based index (Premiere exports "
                         "every sequence in the project into one XML)")
    ap.add_argument("--list-sequences", action="store_true",
                    help="list the sequences in the XML and exit")
    ap.add_argument("--vcodec", default="libx264", help="video encoder (default libx264)")
    ap.add_argument("--container", default="mp4", help="output container (default mp4)")
    ap.add_argument("--no-audio", action="store_true", help="drop audio from output clips")
    ap.add_argument("--speed", choices=["native", "timeline"], default="native",
                    help="for speed-ramped clips: 'native' keeps the real source frames "
                         "(default, best for training data); 'timeline' retimes the clip so "
                         "it matches what played on screen")
    ap.add_argument("--min-frames", type=int, default=1, help="skip cuts shorter than N frames")
    ap.add_argument("--resume", action="store_true",
                    help="skip cuts whose output file already exists and is non-empty "
                         "(pick a long run back up where it stopped)")
    ap.add_argument("--update", action="store_true",
                    help="check for a newer release and install it (asks first)")
    ap.add_argument("--no-probe", action="store_true", help="skip ffprobe technical specs")
    ap.add_argument("--manifest-only", action="store_true", help="write manifest, cut nothing")
    ap.add_argument("--dry-run", action="store_true", help="show what would happen")
    ap.add_argument("--timeout", type=int, default=1800, help="per-clip ffmpeg timeout (s)")
    args = ap.parse_args()

    if args.update:
        return cli_update()

    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            sys.exit(f"error: {tool} not found on PATH. Install it (macOS: brew install ffmpeg).")

    if args.xml is None:
        interactive_setup(args)
    if not args.xml.is_file():
        sys.exit(f"error: {args.xml} not found")

    remaps = []
    for r in args.remap:
        if "=" not in r:
            sys.exit(f"error: --remap needs OLD=NEW, got {r!r}")
        old, new = r.split("=", 1)
        remaps.append((old, new))

    def show_sequences(rows):
        print(f"{len(rows)} sequence(s) in {args.xml.name}:\n")
        print(f"  {'#':>3}  {'name':40s} {'fps':>7s} {'duration':>12s} {'clips':>7s}")
        for s in rows:
            print(f"  {s['index']:>3}  {s['name'][:40]:40s} {s['fps']:>7g} "
                  f"{s['duration_tc']:>12s} {s['clip_count']:>7d}")

    if args.list_sequences:
        show_sequences(Timeline.list_sequences(args.xml))
        return

    try:
        tl = Timeline(args.xml, remaps, args.sequence)
    except SequenceChoice as e:
        show_sequences(e.options)
        sys.exit("\nerror: this XML holds more than one sequence — pick one with "
                 "--sequence NAME or --sequence N (refusing to guess).")

    if args.tracks != "all":
        tl.cuts = [c for c in tl.cuts if c.track_type == args.tracks]
    tl.cuts = [c for c in tl.cuts if c.duration_frames >= args.min_frames]
    for i, c in enumerate(tl.cuts, start=1):
        c.index = i
    # Named now, while the list is final — so --manifest-only and the sheet can show the
    # filenames without a single frame being encoded.
    assign_output_names(tl.cuts, args.container, tl.sequence_fps)

    print(f"xmlcut {VERSION}")
    print(f"  sequence : {tl.sequence_name}  @ {tl.sequence_fps:g} fps")
    print(f"  duration : {frames_to_tc(tl.sequence_duration_frames, tl.sequence_fps)}")
    print(f"  cuts     : {len(tl.cuts)}  across {len({c.source_path for c in tl.cuts})} source files")
    nested = sum(1 for c in tl.cuts if c.nested_from)
    if nested:
        names = sorted({c.nested_from for c in tl.cuts if c.nested_from})
        print(f"  nested   : {nested} cut(s) resolved out of {len(names)} nested "
              f"sequence(s): {', '.join(names)}")
    reversed_n = sum(1 for c in tl.cuts if c.reversed)
    if reversed_n:
        print(f"  reversed : {reversed_n} cut(s) play backwards")
    if tl.markers:
        print(f"  markers  : {len(tl.markers)}")
    for w in tl.warnings:
        print(f"  !! {w}")

    if not tl.cuts:
        sys.exit("No cuts found. Check --tracks, or confirm the XML contains clipitems.")

    if not args.no_probe:
        cache: dict = {}
        for c in tl.cuts:
            apply_probe(c, cache)

    # An .aep isn't "missing" — it's a Dynamic Link comp that was never a file ffmpeg
    # could read, and the fix is to render it, not to remap a path. Keep them apart.
    # A pixel-format conversion is a real loss, and this tool encodes losslessly, so say
    # so rather than letting it happen quietly.
    converted = sorted({(c.pix_fmt, pix_fmt_for(c)) for c in tl.cuts
                        if c.pix_fmt and c.media_kind == "video"
                        and c.pix_fmt not in X264_PIX_FMTS})
    for src_fmt, dst_fmt in converted:
        print(f"  !! {src_fmt} can't be encoded by x264 — those clips convert to "
              f"{dst_fmt}, which is NOT lossless. Recorded as pix_fmt_out.")

    missing = [c for c in tl.cuts if not c.source_exists and c.media_kind != "unsupported"]
    if missing:
        print(f"\n  !! {len(missing)} cut(s) reference media that isn't at the recorded path:")
        for p in sorted({c.source_path for c in missing})[:8]:
            print(f"     {p}")
        print("     Use --remap OLD=NEW to point at the current location.")
    unsupported = [c for c in tl.cuts if c.media_kind == "unsupported"]
    if unsupported:
        print(f"\n  !! {len(unsupported)} cut(s) are project/comp files (Dynamic Link), "
              f"not decodable media — render them out first:")
        for p in sorted({c.source_path for c in unsupported})[:8]:
            print(f"     {p}")
    if missing or unsupported:
        print()

    args.out.mkdir(parents=True, exist_ok=True)

    if args.manifest_only:
        csv_p, json_p, sheet_p = write_manifest(tl, args.out, args)
        print(f"\nCut list written:\n  {csv_p}\n  {json_p}\n  {sheet_p}")
        if not getattr(args, "interactive", False):
            return
        extractable = sum(1 for c in tl.cuts
                          if c.source_exists and c.media_kind != "unsupported")
        print(f"\n{extractable} of {len(tl.cuts)} clips can be extracted.")
        if extractable == 0:
            print("Nothing to cut — fix the missing media first.")
            return
        if input("\nCut them now? [Y/n]: ").strip().lower().startswith("n"):
            print("Stopped. The cut list above is still yours to use.")
            return
        args.manifest_only = False
        print()

    print(f"\nCutting with {JOBS} parallel job(s) ...")
    done = 0
    with ThreadPoolExecutor(max_workers=JOBS) as ex:
        futures = {ex.submit(run_cut, c, args.out, args, tl.sequence_fps): c
                   for c in tl.cuts}
        for fut in as_completed(futures):
            c = fut.result()
            done += 1
            flag = {"ok": "OK ", "dry_run": "DRY", "missing_source": "MISS",
                    "skipped_existing": "HAVE", "no_audio": "SLNT",
                    "failed": "FAIL", "unsupported": "SKIP"}.get(c.status, "?")
            print(f"  [{done}/{len(tl.cuts)}] {flag} {c.output_file}")
            if c.error:
                print(f"        {c.error.splitlines()[0][:160]}")

    csv_p, json_p, sheet_p = write_manifest(tl, args.out, args)
    tally = collections.Counter(c.status for c in tl.cuts)
    extra = "".join(
        f", {tally[k]} {label}" for k, label in
        (("skipped_existing", "already there"), ("no_audio", "silent source"))
        if tally[k])
    print(f"\nDone: {tally['ok']} written, {tally['failed']} failed, "
          f"{tally['missing_source']} missing source, "
          f"{tally['unsupported']} unsupported{extra}.")
    print(f"Manifest: {csv_p}\nSheet   : {sheet_p}")


if __name__ == "__main__":
    main()
