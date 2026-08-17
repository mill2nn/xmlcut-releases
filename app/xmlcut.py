#!/usr/bin/env python3
"""
Raw-cutter - extract every cut of a Premiere Pro timeline as an individual video file.

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
import math
import os
import re
import shutil
import subprocess
import tempfile
import sys
import threading
import urllib.parse
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field, asdict, replace
from pathlib import Path
from typing import Optional, Union

VERSION = "3.25"

# The product name, for anything a person reads. Deliberately NOT applied to the
# identifiers: this file's own name, PANEL_ID, the release-channel repo, the dump's
# GENERATOR string and the panel's localStorage keys are all load-bearing, and renaming
# any of them would break every installed copy's updater, duplicate the panel in
# Premiere's Extensions menu, or silently drop saved settings.
NAME = "Raw-cutter"

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
# crf 1, NOT crf 0. This was lossless (crf 0) until a clip turned out to be unplayable on
# another Mac, and the reason is not obvious: x264's lossless mode emits the
# **High 4:4:4 Predictive** profile even when the pixel format is plain yuv420p, and
# QuickTime, Finder preview and Premiere's macOS decoders cannot read that profile at all.
# Measured on one 2-second clip:
#
#     crf 0   1000 KB   profile "High 4:4:4 Predictive"  <- will not play on a Mac
#     crf 1    712 KB   profile "High"                   <- plays everywhere
#
# So crf 1 is both smaller and playable, and visually indistinguishable. What is given up
# is the strict bit-exactness — worth knowing, but a dataset you cannot preview is worse.
# `-profile:v high` is pinned explicitly so this can never silently drift back to 4:4:4.
#
# veryfast rather than medium because the preset only changes how hard x264 works to
# compress; it never moves a frame boundary. Measured frame-exact at every preset.
X264_CRF = "1"
X264_PRESET = "veryfast"
X264_PROFILE = "high"

# Video-only output, and not merely as a default: an AAC track makes the CONTAINER
# declare a duration longer than the video stream it holds. AAC needs priming samples,
# so the audio outruns the video by ~40 ms — one frame — and an NLE reading the container
# imports every clip a frame long. Neither `-shortest` nor trimming the audio fixes the
# mp4 header; only leaving audio out does. Measured: 48 frames of 24 fps video declared
# 2.041 s with audio, 2.000 s without.
#
# Extracting audio-track clips on their own (`--tracks audio`) is a different job and
# still works; it writes .m4a files where audio is the point.

# How many clips to encode at once. Not auto-detected from the core count, and
# deliberately not the core count itself: libx264 already parallelises across every
# core inside a single encode, so extra concurrent encodes only add contention.
# Measured on 24 clips of 1080x1920 (at crf 0, as it then was), best of two runs each:
#     4 jobs 7.2s · 7 jobs 7.7s · 14 jobs 8.3s · 14 jobs w/ 2 threads 7.9s
# i.e. more jobs is SLOWER, and the whole spread is 19%. Four would win on local
# media, but sources on Google Drive File Stream block on network reads, and there
# parallelism does pay — so this sits in the middle and is capped so it stays sane on
# an 8-core laptop as well as a 14-core desktop.
JOBS = min(8, os.cpu_count() or 4)

# --------------------------------------------------------------------------
# export settings
# --------------------------------------------------------------------------
#
# These used to be pinned constants with a note saying they were "decided once rather
# than exposed as knobs". They are now adjustable, and the note still matters — the
# DEFAULTS are the measured ones, and moving off them has consequences the tool states
# rather than leaves to be discovered:
#
#   crf        1 is the default because crf 0 emits High 4:4:4 Predictive, which will
#              not play on a Mac. Raising crf costs quality and saves a lot of space.
#              Fractional values are real, not rounded away — see crf_of().
#   bitrate    an alternative to crf, not an addition. Target-rate mode makes file size
#              predictable, which is the reason to want it.
#   fps        ⚠️ CHANGING THIS BREAKS FRAME EXACTNESS. Resampling to another rate
#              drops or duplicates frames, so the file no longer holds the frames the
#              timeline used. Recorded per clip as frame_exact=false, and said out loud.

# Output bitrate relative to the SOURCE's, measured per crf on the fixture media:
#     crf  1 -> 2.77x    crf 14 -> 1.26x    crf 18 -> 0.94x
#     crf 23 -> 0.62x    crf 28 -> 0.37x
# Content-dependent — detailed footage lands higher, flat footage lower — so anything
# derived from it is presented as an estimate and never as a promise.
CRF_SIZE_RATIO = {1: 2.77, 14: 1.26, 18: 0.94, 23: 0.62, 28: 0.37}

# --------------------------------------------------------------------------
# THE SIZE MODEL — metadata only, so it costs nothing and follows a slider live.
# --------------------------------------------------------------------------
#
# CALIBRATED by encoding real clips at six crf values and measuring what came out. That
# calibration ran ONCE, offline; nothing here encodes anything. The measurements are in
# CLAUDE.md; these are the tables they produced.
#
# The unit is OUTPUT BITS PER PIXEL PER FRAME, which is the thing that clusters. Two facts
# came out of the calibration and both are load-bearing:
#
#   1. CODEC CLASS separates it. Intraframe sources in this workflow are camera or studio
#      originals and encode to roughly a third of the bits an already-compressed source of
#      the same size does, because a re-encode has to reproduce the first encoder's
#      artefacts as well as the picture. Output bpp at crf 14: h264 0.15-0.30, ProRes
#      0.068-0.087.
#
#   2. A SOURCE'S OWN BITRATE IS A CEILING, NOT A PREDICTOR. Scaling it — which is what
#      this used to do — is right in kind only for inter-frame footage at ordinary rates,
#      and was 186x wrong on a 632 Mbps ProRes. It is kept only as an upper bound for the
#      inter-frame path, where a genuinely low-bitrate source really does encode small.
#
# Accuracy, against the 40 real measurements it was fitted to: median 1.00x, 37/40 within
# 1.5x, 38/40 within 2x, worst 5.7x on a 4K clip at crf 28 where output collapses faster
# than any table follows. It is an ESTIMATE and the wording everywhere says so.
INTRAFRAME_CODECS = {
    "prores", "dnxhd", "dnxhr", "mjpeg", "cineform", "v210", "v410", "rawvideo",
    "ffv1", "huffyuv", "dvvideo", "hq_hqa", "hqx", "cfhd", "prores_ks",
}

BPP_INTER = {6: 0.759, 14: 0.290, 18: 0.144, 23: 0.066, 28: 0.032}
BPP_INTRA = {6: 0.261, 14: 0.069, 18: 0.030, 23: 0.013, 28: 0.006}
SRC_SHARE = {6: 2.806, 14: 1.074, 18: 0.598, 23: 0.288, 28: 0.144}


def _interp(table: dict, crf: float) -> float:
    keys = sorted(table)
    if crf <= keys[0]:
        return table[keys[0]]
    if crf >= keys[-1]:
        return table[keys[-1]]
    for a, b in zip(keys, keys[1:]):
        if a <= crf <= b:
            f = (crf - a) / (b - a)
            return table[a] + f * (table[b] - table[a])
    return table[keys[-1]]


# A STILL is not a rate. Almost all of its file is the one keyframe; every frame after that
# is a few bytes of "nothing changed", so its cost barely moves with duration. Modelling it
# per-second over-predicted an 18x — a 1.5s still that weighs 2859 bytes was estimated at
# 52 kB. So it is priced as this many frames' worth of picture, whatever its length.
#
# 1.5 is fitted to one file (321x241, crf 18, 2859 bytes actual -> 0.91x), so it is a rough
# number honestly labelled rather than a calibrated one. Stills are a rounding error in any
# export that also contains video, which is why it has not been measured harder.
STILL_FRAMES = 1.5


def estimate_bytes_for(cut: Cut, crf: float, pct: float, secs: float) -> float:
    """Expected output size in BYTES. Stills and video price differently, so the one
    function that callers use returns bytes rather than a rate."""
    if cut.media_kind == "still":
        w, h = scaled_dims(cut.width, cut.height, pct)
        if not w or not h:
            return 0.0
        return _interp(BPP_INTER, crf) * w * h * STILL_FRAMES / 8 + CONTAINER_FIXED
    bps = estimate_bps(cut, crf, pct)
    return (bps * secs / 8 + CONTAINER_FIXED) if bps > 0 else 0.0


def estimate_bps(cut: Cut, crf: float, pct: float) -> float:
    """Expected OUTPUT bits per second for this cut, from metadata alone.

    Needs width, height and a frame rate; without them there is nothing to scale and the
    caller falls back or shows nothing rather than inventing a figure.
    """
    w, h = scaled_dims(cut.width, cut.height, pct)
    fps = cut.source_fps or 0.0
    if not w or not h or fps <= 0:
        return 0.0
    px = w * h * fps
    intra = (cut.codec or "").lower() in INTRAFRAME_CODECS
    bpp = _interp(BPP_INTRA if intra else BPP_INTER, crf)
    if not intra and cut.bitrate:
        # The source's own bits per pixel, as a CEILING. A downscale reduces the pixels but
        # not the source's detail per pixel, so the ceiling is computed at the SOURCE's
        # dimensions and then applied to the output's.
        spx = (cut.width or 1) * (cut.height or 1) * fps
        if spx > 0:
            src_bpp = float(cut.bitrate) / spx
            bpp = min(bpp, src_bpp * _interp(SRC_SHARE, crf))
    return bpp * px


def size_ratio_for_crf(crf: float) -> float:
    """Linear interpolation between the measured points, clamped outside them."""
    keys = sorted(CRF_SIZE_RATIO)
    if crf <= keys[0]:
        return CRF_SIZE_RATIO[keys[0]]
    if crf >= keys[-1]:
        return CRF_SIZE_RATIO[keys[-1]]
    for a, b in zip(keys, keys[1:]):
        if a <= crf <= b:
            f = (crf - a) / (b - a)
            return CRF_SIZE_RATIO[a] + f * (CRF_SIZE_RATIO[b] - CRF_SIZE_RATIO[a])
    return CRF_SIZE_RATIO[keys[-1]]


def crf_of(args) -> Union[int, float]:
    """ONE reading of --crf. It is consulted by the encoder flags, the size estimate, the
    printed summary and the manifest, and four separate `int(getattr(...))` expressions
    meant four chances for the panel to show one setting while ffmpeg was given another.

    Fractional is deliberate and was measured, not assumed: x264 takes a float, and 18.5
    really does encode differently from 18 (10627 vs 10829 bytes on a one-second test
    clip). An integer-only crf gave the slider 35 positions over its whole range.

    Whole values come back as an int, which is what puts `"crf": 1` rather than
    `"crf": 1.0` in the manifest. That file gets diffed between runs, and a value
    changing shape on the day crf became a float would read as a setting that moved when
    nothing did.

    0 keeps falling back to the default, as it always has — crf 0 emits High 4:4:4
    Predictive, which will not play on a Mac.
    """
    v = float(getattr(args, "crf", None) or X264_CRF)
    return int(v) if v == int(v) else v


def crf_text(v: Union[int, float]) -> str:
    """The same value as ffmpeg is given it and as the summary prints it: 18, or 18.5."""
    f = float(v)
    return str(int(f)) if f == int(f) else str(round(f, 2))


# Output resolution, as a percentage of each source's own. 100 = untouched.
#
# ⚠️ This changes what the PIXELS are, not how many frames there are. Frame count is
# unaffected — measured: a 79-frame cut is still 79 frames at 50% — so `frame_exact`
# stays true and verify.py still grades the export. `--fps` resamples TIME and breaks
# that; this resamples SPACE and does not.
#
# For a dataset it is the largest single size lever there is, and a much bigger one than
# crf. Measured on real 1080x1920 and 2160x3840 cuts at crf 14, bytes as a percentage of
# the same clip at 100%:
#
#     scale    pixels    BR_2     K8_after   BR_1_Back_hook
#     75%      56.3%     39.6%      55.7%       56.5%
#     50%      25.0%     12.2%      27.5%       24.9%
#     33%      10.9%      3.9%      14.2%       11.4%
#
# So bytes track PIXEL COUNT — scale squared — within about a third either way, and fall
# well below it on detailed footage where downscaling averages the fine detail away.
# Scale-squared is the estimate; it is not a bound in either direction.
SCALE_DEFAULT = 100.0


def scale_of(args) -> float:
    """ONE reading of --scale, in percent. Same reason as crf_of()."""
    v = getattr(args, "scale", None)
    try:
        v = float(v)
    except (TypeError, ValueError):
        return SCALE_DEFAULT
    return SCALE_DEFAULT if v <= 0 else max(1.0, min(100.0, v))


def scaled_dims(w: Optional[int], h: Optional[int], pct: float):
    """The dimensions ffmpeg will actually produce, computed the SAME way it computes
    them, so the manifest and the panel cannot promise a size the file does not have.

    Both axes are truncated to an even number because H.264 in yuv420p subsamples chroma
    2x2 and an odd dimension is not encodable at all — the encode fails outright rather
    than rounding for you. `trunc(x/2)*2` here mirrors `trunc(iw*S/2)*2` in the filter,
    and the two were checked against each other on real clips (1080x1920 at 33% gives
    356x632 in both).
    """
    if not w or not h:
        return (None, None)
    f = pct / 100.0
    return (max(2, int(w * f / 2) * 2), max(2, int(h * f / 2) * 2))


def scale_filter(args) -> Optional[str]:
    """The scale step of the video filter chain, or None when nothing is being resized.

    build_command has three video exits — stills, retimed, plain — and each would
    otherwise grow its own copy of this. That is precisely the mistake codec_flags() was
    written to stop, and a scale applied to two of three would only show up on a timeline
    containing the third.

    `bicubic` is pinned rather than left to ffmpeg's default so that the same clip run
    through two different ffmpeg builds produces the same pixels. A dataset that changes
    when the toolchain updates is not a fixed dataset.
    """
    pct = scale_of(args)
    if pct >= 100.0:
        return None
    f = pct / 100.0
    return (f"scale=trunc(iw*{f:.6f}/2)*2:trunc(ih*{f:.6f}/2)*2:flags=bicubic")


def parse_bitrate(s: str) -> Optional[int]:
    """'8M', '8000k', '8000000' -> bits per second. None if it is not a rate."""
    if not s:
        return None
    m = re.fullmatch(r"\s*([0-9]*\.?[0-9]+)\s*([kKmM]?)\s*", str(s))
    if not m:
        return None
    v = float(m.group(1))
    return int(v * {"": 1, "k": 1e3, "K": 1e3, "m": 1e6, "M": 1e6}[m.group(2)])


def presets_path() -> Path:
    return (Path.home() / "Library" / "Application Support" / "Raw-cutter"
            / "presets.json")


def load_presets() -> dict:
    """Named export settings. Shared by the CLI, the panel and the browser GUI — a file
    rather than the panel's localStorage, so a preset can be inspected, edited and used
    from a terminal, and so the panel is not the only thing that knows about it."""
    try:
        d = json.loads(presets_path().read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


PRESET_FIELDS = ("container", "crf", "bitrate", "x264_preset", "fps", "scale")


def save_preset(name: str, settings: dict) -> None:
    p = presets_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    all_ = load_presets()
    all_[name] = {k: settings.get(k) for k in PRESET_FIELDS}
    p.write_text(json.dumps(all_, indent=2, sort_keys=True), encoding="utf-8")


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
# Released files live in a subfolder of the releases repo, not at its root. The root has to
# stay free for that repo's own README, which is the page people land on — publishing the
# project README to the root overwrote it, twice.
UPDATE_DIR = "app"
UPDATE_FILES = [
    "xmlcut.py", "xmlcut_gui.py", "README.md", "Open xmlcut GUI.command",
    # The Premiere panel rides along, so a teammate never re-downloads anything: the
    # files land under <install>/panel/ and are then copied into Adobe's extensions
    # folder by reinstall_panel(). Subpaths are why safe_rel() exists.
    "panel/CSXS/manifest.xml",
    "panel/client/index.html",
    "panel/client/main.js",
    "panel/client/style.css",
    "panel/client/CSInterface.js",
    "panel/jsx/host.jsx",
    "panel/.debug",
    "panel/Install xmlcut reader (Mac).command",
    "panel/Uninstall xmlcut reader (Mac).command",
    # The diagnostics ship too. They were not in this list, so the shareable zip had no
    # tools/ at all — which meant the installer's `if [ -d "../tools" ]` never fired and
    # a teammate could never run compare_panel.py, while the panel's Advanced pane still
    # carried a command for it. They are a few KB; shipping them is cheaper than
    # explaining that they only work on one machine.
    "tools/compare_panel.py",
    "tools/source_check.py",
    "tools/speed_check.py",
]

# Where the panel has to end up for Premiere to see it.
PANEL_ID = "com.bom.xmlcutreader"
PANEL_PARTS = ["CSXS", "client", "jsx", ".debug"]

# A released file may begin with a dot only if it is one of these. Nothing else has a
# reason to, and `.zshrc` used to pass safe_rel() — harmless, since everything is written
# under the install directory, but there is no case for allowing it.
DOT_OK = {".debug"}

# No released file is anywhere near this big. Without a cap, a wrong URL or a hostile
# repo hands urlopen an arbitrarily large body straight into memory.
MAX_UPDATE_BYTES = 8 * 1024 * 1024


def cep_extensions_dir() -> Path:
    return (Path.home() / "Library" / "Application Support" / "Adobe" / "CEP"
            / "extensions")


def is_bundled_install(here: Optional[Path] = None) -> bool:
    """True when the running xmlcut.py is the copy inside Premiere's extension folder.

    The panel ALWAYS runs that copy, which makes install_dir() the extension's lib/ —
    not the folder the user downloaded. Until this was accounted for, pressing Update in
    the panel wrote xmlcut_gui.py, README.md, a launcher and a whole second panel/ tree
    into Adobe's extensions directory, and left the user's own folder on the old version:
    two installations, one of them invisible.
    """
    here = here or install_dir()
    try:
        return cep_extensions_dir().resolve() in here.resolve().parents
    except Exception:
        return False


def safe_rel(name: str) -> Optional[str]:
    """A relative path from latest.json, or None if it is not one we will write.

    latest.json comes from a PUBLIC repo, so its filenames are untrusted input. This
    used to be `Path(f).name`, which neutralised traversal by throwing the directory
    away — fine until the panel needed `panel/client/main.js` to stay nested.

    So: forward slashes only, no absolute paths, no `..`, no hidden directories, a
    conservative character set, and a depth cap. Anything else is skipped rather than
    guessed at.
    """
    if not name or "\\" in name or name.startswith("/"):
        return None
    parts = [p for p in name.split("/") if p not in ("", ".")]
    if not parts or len(parts) > 4:
        return None
    for i, p in enumerate(parts):
        if p == ".." or not re.fullmatch(r"[A-Za-z0-9 ._()+-]+", p):
            return None
        # A leading dot is allowed only on the final component AND only for a name we
        # actually ship. Never as a directory — nothing should write into a dot-directory.
        if p.startswith(".") and (i != len(parts) - 1 or p not in DOT_OK):
            return None
    return "/".join(parts)


def reinstall_panel(here: Path, progress=None) -> tuple[bool, str]:
    """Copy <install>/panel into Adobe's extensions folder.

    An update refreshes the files in the xmlcut folder, but Premiere loads the panel
    from its own directory — so without this step a teammate's panel stays on the old
    code no matter how many times xmlcut updates itself.

    Premiere only scans extensions at launch, so the caller has to say "restart
    Premiere". Copying under a running Premiere is safe; it simply keeps using what it
    already loaded.
    """
    src = here / "panel"
    if not src.is_dir():
        return False, "no panel/ folder in this install — nothing to reinstall"
    dest = cep_extensions_dir() / PANEL_ID
    try:
        dest.mkdir(parents=True, exist_ok=True)
        # xmlcut.py goes INSIDE the installed panel, as lib/xmlcut.py.
        #
        # The panel used to hunt for it in ~/Desktop and friends, which fails outright
        # when macOS has not granted Premiere access to those folders — the file is
        # there and every stat says no. The extension directory is one Premiere already
        # reads to load the panel at all, so a copy in here is always reachable.
        #
        # Copied at install time rather than committed under panel/, so the repository
        # keeps exactly one xmlcut.py and the two can never drift.
        lib = dest / "lib"
        lib.mkdir(parents=True, exist_ok=True)

        # `here` and `lib` are the SAME DIRECTORY when the caller is the bundled copy —
        # which is every update the panel performs, since install_dir() is then the
        # extension's own lib/. Copying a directory onto itself is not a no-op here: the
        # tools branch did `rmtree(tdst)` and then globbed `tsrc`, so every panel update
        # deleted the bundled diagnostics and left an empty lib/tools. Measured, three
        # files to none. Compare resolved paths and skip rather than copy.
        def same(a: Path, b: Path) -> bool:
            try:
                return a.resolve() == b.resolve()
            except Exception:
                return False

        if not same(here / "xmlcut.py", lib / "xmlcut.py"):
            (lib / "xmlcut.py").write_bytes((here / "xmlcut.py").read_bytes())
            if progress:
                progress("panel: lib/xmlcut.py")
        # The diagnostics come too, as lib/tools/. They do
        # sys.path.insert(parent.parent), which from lib/tools/ resolves to lib/ — where
        # xmlcut.py now is — so they run from inside the panel unchanged. Without them
        # the compare command the panel prints points at a folder that does not exist.
        tsrc = here / "tools"
        tdst = lib / "tools"
        if tsrc.is_dir() and not same(tsrc, tdst):
            shutil.rmtree(tdst, ignore_errors=True)
            tdst.mkdir(parents=True, exist_ok=True)
            for t in sorted(tsrc.glob("*.py")):
                (tdst / t.name).write_bytes(t.read_bytes())
            if progress:
                progress("panel: lib/tools")
        for part in PANEL_PARTS:
            s = src / part
            if not s.exists():
                continue
            d = dest / part
            if s.is_dir():
                # Replaced rather than merged, so a file deleted upstream really goes.
                shutil.rmtree(d, ignore_errors=True)
                shutil.copytree(s, d)
            else:
                d.write_bytes(s.read_bytes())
            if progress:
                progress(f"panel: {part}")
    except Exception as e:
        return False, f"panel copied into {dest} failed: {e}"
    return True, f"panel updated in {dest} — restart Premiere to load it"
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
    # Percent-encode each segment but keep the slashes: one of the released files is
    # "Open xmlcut GUI.command", and an unencoded space makes urllib refuse the URL
    # outright ("URL can't contain control characters").
    safe = urllib.parse.quote(rel)
    return [
        f"https://api.github.com/repos/{UPDATE_OWNER}/{UPDATE_REPO}/contents/{safe}"
        f"?ref={UPDATE_BRANCH}",
        f"https://raw.githubusercontent.com/{UPDATE_OWNER}/{UPDATE_REPO}/"
        f"{UPDATE_BRANCH}/{safe}",
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
                # One byte past the cap, so an oversized body is detected rather than
                # silently truncated into a file that would then fail to parse.
                data = r.read(MAX_UPDATE_BYTES + 1)
            if len(data) > MAX_UPDATE_BYTES:
                raise RuntimeError(
                    f"{rel} is larger than {MAX_UPDATE_BYTES // (1024 * 1024)} MB")
            return data
        except Exception as e:      # noqa: BLE001 - any failure just tries the fallback
            last = e
    raise RuntimeError(f"could not read {rel}: {last}")


def version_key(v: str) -> tuple:
    return tuple(int(x) if x.isdigit() else 0 for x in str(v).split("."))


def install_dir() -> Path:
    return Path(__file__).resolve().parent


def fetch_latest() -> "tuple[Optional[dict], Optional[str]]":
    """(latest.json, None) or (None, why it could not be read). Never raises.

    Two outcomes that must NOT be conflated: "nothing newer is published" and "the
    release channel could not be reached". check_update() returned None for both, so with
    the network down `--check-update-json` printed exactly what being current prints —
    measured, byte for byte — and the panel told the user "up to date, nothing newer
    published", which it had no basis for saying.

    Also the only place that checks latest.json is a JSON *object*. It wasn't, and a
    `latest.json` holding an array raised AttributeError straight out of the CLI.
    """
    try:
        raw = _fetch("latest.json")
    except Exception as e:
        return None, f"could not reach the release channel ({e})"
    try:
        info = json.loads(raw.decode("utf-8"))
    except Exception as e:
        return None, f"latest.json is not readable JSON ({e})"
    if not isinstance(info, dict):
        return None, "latest.json is not a JSON object"
    return info, None


def newer_than_running(info: Optional[dict]) -> Optional[dict]:
    """`info` if it names a version above this one, else None."""
    if not info:
        return None
    if version_key(info.get("version", "0")) > version_key(VERSION):
        return info
    return None


def check_update() -> Optional[dict]:
    """latest.json if it names a newer version, else None. Never raises.

    Kept for callers that only care whether there is something to install. Anything that
    reports to a human should use fetch_latest() so a failed check can be said out loud.
    """
    info, _err = fetch_latest()
    return newer_than_running(info)


def apply_update(info: dict, progress=None, out: Optional[dict] = None) -> tuple[bool, str]:
    """Download the released files and swap them in, or change nothing at all.

    Every file is fetched and validated BEFORE anything on disk is touched, because a
    half-written update is worse than no update: a truncated .py leaves a tool that will
    not start. Python files are compiled to prove they parse, and the new xmlcut.py must
    report the version latest.json promised — that catches a publish where the files and
    the version number disagree.

    `progress` is called with a short human string at each step, so a caller can show what
    is happening rather than leaving a dead button. Four files over an office connection is
    long enough that silence reads as a hang.
    """
    def say(msg: str) -> None:
        if progress:
            progress(msg)

    here = install_dir()
    if (here / ".git").exists():
        return False, ("this is the source checkout, not an installed copy — "
                       "use `git pull` instead so nothing overwrites your work")

    # latest.json lists plain filenames; the remote copy of each lives under UPDATE_DIR
    # and lands back beside xmlcut.py under its own name.
    #
    # When the running copy is the one bundled inside the panel, "beside xmlcut.py" is
    # Adobe's extensions folder — so only the files the panel actually runs are fetched.
    # Everything else (the browser GUI, its launcher, the README) belongs beside a user's
    # own copy, and writing it in here built a second installation nothing launches.
    bundled = is_bundled_install(here)
    wanted = info.get("files") or UPDATE_FILES
    if bundled:
        wanted = [f for f in wanted
                  if str(f) == "xmlcut.py"
                  or str(f).startswith("panel/") or str(f).startswith("tools/")]
        say("Updating the copy inside the Premiere panel")
    files = []
    for f in wanted:
        rel = safe_rel(str(f))
        if rel is None:
            return False, (f"latest.json names a file this updater will not write "
                           f"({f!r}) — nothing was changed")
        files.append(rel)
    if not files:
        return False, "latest.json listed nothing this copy can update — nothing was changed"
    got: dict[str, bytes] = {}
    for n, rel in enumerate(files, start=1):
        say(f"Downloading {rel} ({n}/{len(files)})")
        try:
            data = _fetch(f"{UPDATE_DIR}/{rel}")
        except Exception as e:
            return False, f"download failed ({rel}): {e} — nothing was changed"
        if not data:
            return False, f"{rel} came back empty — nothing was changed"
        if rel.endswith(".py"):
            try:
                compile(data.decode("utf-8"), rel, "exec")
            except (SyntaxError, UnicodeDecodeError) as e:
                return False, f"{rel} did not parse ({e}) — nothing was changed"
            # NOTE: this catches a publish whose files and version disagree, but it
            # cannot catch one version published twice with different bytes — both
            # copies report the same number. That is why Publish Update.command bumps
            # rather than reusing a number; see the --same warning there.
            if rel == "xmlcut.py":
                m = re.search(r'VERSION\s*=\s*"([^"]+)"', data.decode("utf-8"))
                if not m or m.group(1) != info.get("version"):
                    return False, (f"the download says "
                                   f"{m.group(1) if m else 'no version'}, not "
                                   f"{info.get('version')} — nothing was changed")
        got[rel] = data

    # Which files this update actually CHANGES, as opposed to rewriting identically.
    #
    # latest.json always lists the whole set, so "panel files were in the release" is not the
    # same as "the panel changed". A release that only touches the cut logic needs no
    # Premiere restart at all — the engine is spawned fresh for every export — and saying
    # "quit and reopen" every time trains people to ignore it on the one occasion it matters.
    ext_dest = cep_extensions_dir() / PANEL_ID

    def current_bytes(rel: str) -> Optional[bytes]:
        """What is on disk now, at the place this file actually lives.

        For a BUNDLED install the installed panel is in the extension ROOT — `here/panel/`
        is only a staging directory, and it is deleted after every update. Comparing against
        it made all nine panel files look changed on every release, so an engine-only
        release still demanded a restart.
        """
        cands = [here / rel]
        if bundled and rel.startswith("panel/"):
            cands.insert(0, ext_dest / rel[len("panel/"):])
        for p in cands:
            try:
                if p.is_file():
                    return p.read_bytes()
            except OSError:
                pass
        return None

    changed = [rel for rel, data in got.items() if current_bytes(rel) != data]

    say("Backing up the current version")
    backup = here / ".backup"
    saved: list[str] = []
    # Files this update CREATES rather than replaces. A rollback restored the ones that
    # existed and left every new one in place — on a first update from a copy that predates
    # the panel, that is the whole panel/ tree surviving a failed install.
    fresh: list[str] = []
    try:
        shutil.rmtree(backup, ignore_errors=True)
        for rel in files:
            src = here / rel
            if src.exists():
                dst = backup / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                dst.write_bytes(src.read_bytes())
                saved.append(rel)
            else:
                fresh.append(rel)
    except Exception as e:
        return False, f"couldn't back up the current version ({e}) — nothing was changed"

    say(f"Installing {info['version']}")
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
        for rel in fresh:                # and leave nothing behind that wasn't there
            try:
                (here / rel).unlink()
            except Exception:
                pass
        return False, f"update failed ({e}) — rolled back, still on {VERSION}"

    # The panel lives in Adobe's extensions folder, not here, so refreshing the files
    # above is only half of it. Done last, and a failure here does not roll the update
    # back: the tool itself is already correctly updated.
    tail = ""
    if any(rel.startswith("panel/") for rel in files):
        ok, msg = reinstall_panel(here, progress)
        tail = ("\n" + ("Premiere panel: " + msg if ok
                        else "the tool updated, but the panel did not: " + msg))
        # For a bundled install, here/panel was only ever a staging area — the copy
        # Premiere loads now sits in the extension root. Leaving it behind meant a second
        # panel/ tree accumulating inside Adobe's folder on every update.
        if ok and bundled:
            shutil.rmtree(here / "panel", ignore_errors=True)

    # Reported through `out` rather than by widening the return: there are ten early
    # `return False, msg` paths in here and changing their arity would be pure risk.
    if out is not None:
        # Premiere loads the panel's manifest, HTML, JS and JSX ONCE, at launch. Only a
        # change to one of those needs a restart — not the installer scripts, and not the
        # engine, which is a subprocess started fresh for every export.
        loaded = tuple(f"panel/{p}" for p in PANEL_PARTS)
        out["changed"] = sorted(changed)
        out["restart_needed"] = any(r.startswith(loaded) for r in changed)
    return True, (f"updated {VERSION} → {info['version']}. The previous version is in "
                  f".backup if you need it." + tail)


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


MIN_USABLE_FPS = 1.0


def usable_fps(value) -> float:
    """A frame rate you can divide by, or 0.0.

    Premiere reports a frame rate around 1e-7 for nested sequences, stills, audio and
    Dynamic Link comps — 25 of 94 clips on a real timeline. That survives a `> 0` test,
    then rounds to 0 inside frames_to_tc and divides by zero, and makes
    `abs(interpreted - actual) / interpreted` astronomically large so every such clip
    gets reported as reinterpreted footage.

    Nothing below 1 fps is a real video rate. One definition, used everywhere, so the
    two call sites cannot drift apart again.
    """
    if not isinstance(value, (int, float)):
        return 0.0
    v = float(value)
    return v if v >= MIN_USABLE_FPS else 0.0


def is_retimed(speed_percent: float) -> bool:
    """True when a clip is not at 100%.

    A tolerance, not `not in (0, 100)`. A tick-derived speed need not land exactly on
    100.0, and this decides whether build_command takes the retime branch — so an
    unlucky 100.0000001 would otherwise resample a clip that needed nothing done.
    """
    return bool(speed_percent) and abs(speed_percent - 100.0) > 0.01


def consumed_frames(in_seconds: float, dur_seconds: float, fps: float) -> int:
    """How many source frames lie in [in, in+dur) at `fps`.

    Deliberately NOT round(dur * fps). Frames sit at k/fps, and a tick-derived
    in-point almost never lands on one, so the count depends on WHERE the range
    starts as well as how long it is: 1.3s at 24 fps holds 32 frames from 3.000s
    but 31 from 3.020s. Rounding the duration alone is a frame out whenever the two
    ends straddle their boundaries differently — measured on a real timeline, that
    was 5 of 16 cuts, each 42 ms wrong.

    This is the value -frames:v pins, so an error here is an error in the file.

    The epsilon is in FRAMES, matching the seek tolerance in build_command: a hair
    over a boundary must not promote to the next frame, but a genuinely mid-frame
    edge still rounds up.
    """
    if fps <= 0:
        return 0
    e = 1e-4
    n = (math.ceil((in_seconds + dur_seconds) * fps - e)
         - math.ceil(in_seconds * fps - e))
    return max(1, n)


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


def human_bytes(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if abs(n) < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit in ("B", "KB") else f"{n:.1f} {unit}"
        n /= 1024.0
    return f"{n:.1f} GB"


def fmt_secs(total: float) -> str:
    """Seconds and hundredths, zero-padded: 2.5 -> "02.50".

    The separator is a dot, not the colon you would write by hand: Finder still treats ':'
    in a filename as a path separator and displays it as '/', which would turn a tidy
    "(00.00-00.02)" into "(00/00-00/02)". A dot also keeps the hyphen free to mean one
    thing only — the gap between the two ends of the range.
    """
    whole = int(total)
    cs = int(round((total - whole) * 100))
    if cs >= 100:
        whole, cs = whole + 1, 0
    return f"{whole:02d}.{cs:02d}"


def secs_cs(frames: float, fps: float) -> str:
    """A frame position as seconds and hundredths: frame 60 at 24 fps -> "02.50".

    """
    return fmt_secs(frames / fps if fps > 0 else 0.0)


def tc_range(cut: "Cut", fps: float) -> str:
    """The clip's span **inside its source file**, for the filename: "(03.93-05.06)".

    The source range, not the timeline position — the filename already names the source
    file, so the numbers beside it should locate the range in that file. Timeline position
    is still in clips.csv and the manifest, where it belongs.

    Falls back to the timeline position for a still, which has no meaningful source range:
    its in/out are an arbitrary offset into a virtual 24-hour clip.
    """
    if cut.media_kind == "still" or cut.source_duration_seconds <= 0:
        return (f"({secs_cs(cut.timeline_in_frames, fps)}"
                f"-{secs_cs(cut.timeline_out_frames, fps)})")
    start = cut.source_in_seconds
    return f"({fmt_secs(start)}-{fmt_secs(start + cut.source_duration_seconds)})"


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
    # The ramp's actual keyframes, as [[seconds, speed_multiplier], ...]. Only a panel
    # dump can supply these; an XML export flattens the curve to one number. Recorded
    # for now — nothing follows the curve yet — but recorded exactly, so that when
    # something does, the data is already in the manifest.
    ramp_keys: list = field(default_factory=list)
    enabled: bool = True
    transition_in: str = ""
    transition_out: str = ""
    edge_in_transition: str = ""   # "head", "tail" or "both" — edge reconstructed
    estimated_bytes: int = 0       # what this cut is expected to weigh, before encoding
    output_bytes: int = 0          # what it actually weighed, once written
    # MEASURED bits per second, from a real short encode of this clip at probe_crf. The
    # only honest basis for an estimate — see size_probe() for why the source's own
    # bitrate is not one. 0 means the probe did not run or could not.
    probe_bps: float = 0.0
    probe_crf: float = 0.0
    frame_exact: bool = True       # false once --fps resamples it
    media_kind: str = "video"      # video | still | unsupported
    nested_from: str = ""          # name of the nested sequence this came out of
    nested_trimmed: str = ""       # "head", "tail" or "both" — clipped by the nest's in/out
    filters: list = field(default_factory=list)

    # technical specs (ffprobe)
    codec: str = ""
    width: Optional[int] = None
    height: Optional[int] = None
    # What this cut was actually WRITTEN at. Equal to width/height unless --scale moved
    # it. Recorded per clip rather than only as a percentage in `settings`, because a
    # timeline mixes 1080x1920 and 2160x3840 sources and one percentage does not tell a
    # dataset reader what any individual file contains.
    output_width: Optional[int] = None
    output_height: Optional[int] = None
    source_fps: float = 0.0
    # Premiere's INTERPRETED rate, only ever set from a panel dump. Recorded rather
    # than used: it is the rate the edit was built against, but ffmpeg seeks the file
    # at the file's own rate, and silently converting between the two — untested, on
    # footage I have none of — is how a half-second error gets introduced. Where the
    # two disagree the clip is flagged instead.
    interpreted_fps: float = 0.0
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
        # Why clipitems did not become cuts. Counted rather than warned one-by-one: a real
        # timeline had 31 title graphics with no media, and 31 identical warnings is a wall
        # nobody reads. Summarised at the end of _parse().
        self.skipped: dict = {}
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

        # Register every <file> in the DOCUMENT before walking the chosen sequence.
        #
        # FCP7 defines a <file> in full at its first appearance anywhere in the export and
        # refers to it by id alone after that. Registering only as the chosen sequence was
        # walked therefore lost any file whose full definition sits under a DIFFERENT
        # sequence — its clipitems resolve to no path and are dropped, silently. The
        # fixture demonstrates it: `--sequence OLD_v6_DO_NOT_USE` used to report
        # "No cuts found" for a sequence that plainly has a clip in it.
        #
        # This matters for a project-level export, which holds every sequence — which is
        # exactly what the panel falls back to when Premiere will not export a single
        # sequence, and what anyone using --sequence has.
        #
        # After sequence_fps is known, because that is the fallback for a file with no rate
        # of its own. Full definitions overwrite references, so order within the document
        # does not matter.
        for f in root.iter("file"):
            self._register_file(f)

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
                edges = self.resolve_transition_edges(track)
                for clip in track.findall("clipitem"):
                    # A clipitem holds EITHER a <file> or a nested <sequence>. Skipping
                    # the latter silently drops every cut inside the nest — real
                    # timelines here do use nests, so those clips were simply absent
                    # from the dataset with nothing to show they were missing.
                    if clip.find("sequence") is not None:
                        self.cuts.extend(
                            self._parse_nested(clip, track_type, t_idx,
                                               depth=1, edges=edges))
                        continue
                    cut = self._parse_clipitem(clip, track_type, t_idx,
                                               transitions, edges=edges)
                    if cut:
                        self.cuts.append(cut)

        # order by timeline position, video first
        # Everything that did not become a cut, said once per reason. This is what makes
        # "the export has fewer clips than the timeline" self-diagnosing instead of a
        # bug report.
        for why, e in sorted(self.skipped.items()):
            names = ", ".join(e["names"])
            more = "" if e["count"] <= len(e["names"]) else ", …"
            self.warnings.append(
                f"{e['count']} clipitem(s) were not cut — {why}"
                + (f": {names}{more}" if names else ""))

        self.cuts.sort(key=lambda c: (c.timeline_in_frames, c.track_type != "video", c.track_index))
        for i, c in enumerate(self.cuts, start=1):
            c.index = i

    @staticmethod
    def resolve_transition_edges(track: ET.Element) -> dict:
        """Timeline bounds for clipitems whose <start>/<end> is -1.

        FCP7 writes -1 for a clipitem boundary that an ADJACENT TRANSITION defines. The
        items of a track are in timeline order, so a -1 start is the preceding
        transitionitem's start and a -1 end is the following transitionitem's end:

            [20] clipitem  IMG_0283   start= 775  end=  -1   in= 217 out= 279
            [21] transitionitem       start= 807  end= 837
            [22] clipitem  scene3.2   start=  -1  end=  -1   in= 949 out=1130
            [23] transitionitem       start= 970  end= 988
            [24] clipitem  scene1-1   start=  -1  end=1063   in= 205 out= 298

        Clip 22 therefore spans 807→988 = 181 frames, exactly its out-in. Clip 24 spans
        970→1063 = 93, clip 20 spans 775→837 = 62 — all three match out-in exactly.

        Until this existed, `duration_frames = end - start` came out zero or negative for
        every such clip and the `--min-frames` filter dropped them WITHOUT A WORD. On one
        real timeline that was 46 clipitems, 3 of them cuttable video and 12 stills: the
        clips were on the timeline, in the XML, and simply absent from the output.

        Returns {id(clipitem element): (start, end)} for the ones that needed resolving.
        """
        # `num(x) or -1` would turn a legitimate ZERO into -1 — and a transition starting
        # on frame 0 is perfectly ordinary. That bug was in this function until a nested
        # sequence under a first-frame dissolve refused to resolve and the new fixture
        # caught it. Read the value, then test it; never lean on truthiness for a number
        # whose valid range includes 0.
        def frame(node, field):
            v = num(node, field, -1)
            return -1 if v is None else int(v)

        kids = [k for k in track if k.tag in ("clipitem", "transitionitem")]
        fixed: dict = {}
        for i, node in enumerate(kids):
            if node.tag != "clipitem":
                continue
            start = frame(node, "start")
            end = frame(node, "end")
            if start >= 0 and end >= 0:
                continue
            if start < 0:
                for j in range(i - 1, -1, -1):
                    if kids[j].tag == "transitionitem":
                        start = frame(kids[j], "start")
                        break
            if end < 0:
                for j in range(i + 1, len(kids)):
                    if kids[j].tag == "transitionitem":
                        end = frame(kids[j], "end")
                        break
            # Only claim a fix when BOTH ends are now real and the span is positive.
            # A -1 with no transition beside it is something else, and guessing at it
            # would be worse than reporting it.
            if start >= 0 and end > start:
                fixed[id(node)] = (start, end)
        return fixed

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

    def _parse_nested(self, clip, track_type, t_idx, depth: int,
                      edges: Optional[dict] = None) -> list[Cut]:
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
        # A NEST can sit under a transition too, and then its own start/end are -1 like any
        # other clipitem. Both -1 used to mean "skipped" — losing every clip inside it, on a
        # timeline where the nest is plainly there. Same sentinel, same resolution.
        if edges:
            fixed = edges.get(id(clip))
            if fixed:
                nest_start, nest_end = fixed
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
            edges = self.resolve_transition_edges(track)
            for inner in track.findall("clipitem"):
                if inner.find("sequence") is not None:
                    out.extend(self._parse_nested(inner, track_type, t_idx, depth + 1))
                    continue
                c = self._parse_clipitem(inner, track_type, t_idx, transitions,
                                         seq_fps=nest_fps, edges=edges)
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
                        c.source_consumed_frames = consumed_frames(
                            c.source_in_seconds, c.source_duration_seconds,
                            c.source_fps)

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

    def _skip(self, why: str, name: str = "") -> None:
        """Record a clipitem that did not become a cut.

        Every one of these used to be a bare `return None`. Individually defensible;
        collectively they meant "my export has fewer clips than my timeline" had eight
        possible causes and only two of them said anything. The -1 transition bug hid here
        for weeks.
        """
        e = self.skipped.setdefault(why, {"count": 0, "names": []})
        e["count"] += 1
        if name and len(e["names"]) < 4 and name not in e["names"]:
            e["names"].append(name)

    def _parse_clipitem(self, clip, track_type, t_idx, transitions,
                        seq_fps: Optional[float] = None,
                        edges: Optional[dict] = None) -> Optional[Cut]:
        # seq_fps overrides the sequence rate when this clipitem lives inside a nested
        # sequence — its timeline positions are counted in the NEST's rate, not the
        # parent's, and conflating the two shifts every nested cut.
        seq_fps = self.sequence_fps if seq_fps is None else seq_fps
        file_node = clip.find("file")
        if file_node is None:
            # Premiere's synthetic items — Black Video, Slug, colour mattes. There is no
            # media to cut, which is correct, but it should not happen invisibly.
            self._skip("no media behind them (synthetic items such as Black Video or Slug)",
                       txt(clip, "name"))
            return None
        fid = self._register_file(file_node)
        finfo = self.files.get(fid, {})
        if not finfo.get("path"):
            # An id-only <file> whose full definition is nowhere in the document. This is
            # the same shape as the bug fixed in 3.10, where files defined under another
            # sequence were never registered — so if it fires, say so loudly.
            self._skip("a <file> reference the XML never defines", txt(clip, "name"))
            return None

        start = num(clip, "start", 0) or 0
        end = num(clip, "end", 0) or 0
        c_in = num(clip, "in", 0) or 0
        c_out = num(clip, "out", 0) or 0

        # A -1 boundary is one the adjacent TRANSITION defines; resolve_transition_edges()
        # worked it out from the track's item order. Without this, a clip sitting between
        # two transitions has start = end = -1 and is discarded three lines below —
        # silently, on a timeline where it is plainly present.
        #
        # The RAW values are kept because they are what says "a transition defines this
        # edge". Resolving them and then testing the resolved values lost that fact, and
        # with it the `edge_in_transition` flag — which suppresses a false merge warning
        # and tells the reader the clip carries handle frames under a dissolve.
        raw_start, raw_end = start, end
        if edges:
            fixed = edges.get(id(clip))
            if fixed:
                start, end = fixed

        if start < 0 and end < 0:
            # Still unresolved: no transition beside it to take the boundary from. Guessing
            # would be worse, but vanishing without a word is worst of all — this is exactly
            # the failure that had clips missing from an export with nothing to explain it.
            self.warnings.append(
                f"{txt(clip, 'name') or 'a clip'} on {track_type} track {t_idx} has no "
                f"timeline position in the XML (start and end are both -1) and no "
                f"transition beside it to take one from — it was NOT cut")
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
            self._skip("no usable length — neither start/end nor in/out give one",
                       txt(clip, "name"))
            return None

        # Premiere writes start or end as -1 when that edge is buried under a
        # transition. Rebuild the real edge from the other side + duration,
        # otherwise the clip sorts to the top with a nonsense timecode.
        # Which edge a transition defines — read from the RAW values, so it is still known
        # after resolve_transition_edges() has filled them in.
        edge = ("both" if (raw_start < 0 and raw_end < 0)
                else "head" if raw_start < 0
                else "tail" if raw_end < 0
                else "")
        # Still unresolved (no transition beside it): fall back to sizing from out-in, as
        # before. The span is right even though the placement is inferred.
        if start < 0 and end >= 0:
            start = end - dur_frames
        elif end < 0 and start >= 0:
            end = start + dur_frames

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
        consumed = consumed_frames(src_in_sec, src_dur_sec, file_fps)

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
# Panel dump input — the same cut list, read from Premiere instead of an XML
# --------------------------------------------------------------------------

class DumpTimeline:
    """A Timeline built from the Raw-cutter panel's JSON instead of an XML.

    Deliberately duck-types `Timeline`: same attribute names, same `Cut` objects, so
    every downstream stage — naming, probing, building the ffmpeg command, the
    manifest — runs unchanged and stays covered by the same reasoning.

    What the panel gives that an XML cannot:

      * the INTERPRETED frame rate, which is what Premiere actually cut against
      * keyframed speed ramps, reported per clip rather than flattened to one number
      * real media paths, so --remap has nothing left to do

    What it cannot give: the contents of a nested sequence. Premiere hands the nest
    over as a single clip, and resolving it would mean re-deriving the nest walking
    that the XML path already does. Nests are reported and skipped, never guessed at.
    """

    # A WIRE VALUE, not a display name. host.jsx stamps it into every dump and
    # looks_like_dump() validates it, so renaming it would make every dump already on
    # disk unreadable. The product name lives in NAME.
    GENERATOR = "xmlcut reader"

    def __init__(self, dump_path: Path):
        self.xml_path = dump_path
        self.cuts: list[Cut] = []
        self.markers: list[dict] = []
        self.warnings: list[str] = []
        self.available_sequences: list[dict] = []
        self.sequence_name = ""
        self.sequence_fps = 25.0
        self.sequence_duration_frames = 0
        self._load(dump_path)

    @staticmethod
    def looks_like_dump(path: Path) -> bool:
        """Cheap sniff so the CLI can accept either input without a mode flag."""
        try:
            if path.suffix.lower() != ".json":
                return False
            with open(path, "r", encoding="utf-8") as fh:
                return DumpTimeline.GENERATOR in fh.read(400)
        except Exception:
            return False

    @staticmethod
    def _ticks(node) -> Optional[int]:
        """Ticks arrive as a STRING — the values exceed float precision."""
        if not isinstance(node, dict):
            return None
        v = node.get("ticks")
        if v in (None, ""):
            return None
        try:
            return int(str(v))
        except (TypeError, ValueError):
            return None

    def _load(self, path: Path) -> None:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise SystemExit(f"error: no such file: {path}")
        except json.JSONDecodeError as e:
            raise SystemExit(f"error: {path.name} is not readable JSON ({e})")
        if data.get("generator") != self.GENERATOR:
            raise SystemExit(
                f"error: {path.name} was not written by the Raw-cutter panel.")

        seq = data.get("sequence") or {}
        self.sequence_name = str(seq.get("name") or "Untitled Sequence")
        fps = seq.get("fps")
        if not isinstance(fps, (int, float)) or fps <= 0:
            tb = seq.get("timebase_ticks_per_frame") or 0
            fps = (PPRO_TICKS_PER_SECOND / tb) if tb else 25.0
        self.sequence_fps = float(fps)

        end_ticks = self._ticks(seq.get("end"))
        if end_ticks:
            self.sequence_duration_frames = int(
                round(end_ticks / PPRO_TICKS_PER_SECOND * self.sequence_fps))

        nests = 0
        for entry in data.get("clips") or []:
            cut = self._build(entry)
            if cut is None:
                nests += 1
                continue
            self.cuts.append(cut)

        # Order the way the XML path does, so indices and filenames line up between
        # the two inputs for the same timeline.
        self.cuts.sort(key=lambda c: (c.track_type != "video", c.timeline_in_frames,
                                      c.track_index))
        if nests:
            self.warnings.append(
                f"{nests} nested sequence(s) skipped — Premiere hands a nest over as "
                f"one clip. Export this timeline as XML to cut inside nests.")
        if not self.cuts:
            self.warnings.append("no cuttable clips found in the dump")

    def _build(self, e: dict) -> Optional[Cut]:
        pi = e.get("project_item") or {}
        if pi.get("is_sequence"):
            return None

        path = str(pi.get("media_path") or "")
        ext = Path(path).suffix.lower()
        if ext in UNSUPPORTED_EXT:
            kind = "unsupported"
        elif ext in STILL_EXT:
            kind = "still"
        else:
            kind = "video"

        start = self._ticks(e.get("start")) or 0
        end = self._ticks(e.get("end")) or 0
        t_in = int(round(start / PPRO_TICKS_PER_SECOND * self.sequence_fps))
        t_out = int(round(end / PPRO_TICKS_PER_SECOND * self.sequence_fps))
        dur_frames = max(0, t_out - t_in)

        speed_mult = e.get("speed")
        speed = (float(speed_mult) * 100.0
                 if isinstance(speed_mult, (int, float)) and speed_mult else 100.0)
        speed = abs(speed) or 100.0
        k = speed / 100.0

        src_in_t = self._ticks(e.get("in_point"))
        src_out_t = self._ticks(e.get("out_point"))
        if src_in_t is None or src_out_t is None or src_out_t <= src_in_t:
            src_in_sec = 0.0
            src_dur_sec = frames_to_seconds(dur_frames, self.sequence_fps)
            timing = "timeline"
        else:
            # MUST be scaled by speed. Premiere's TrackItem inPoint/outPoint are in
            # TIMELINE units, not source units: on a 115.126% clip their difference is
            # the 1.600s the clip occupies, not the 1.842s of source it consumes.
            # Measured across a real 39-cut timeline: out-in equalled the timeline
            # length on 16 clips and the consumed source range on none, while
            # (value x speed) reproduced the XML's in-point and duration exactly.
            #
            # This is NOT the same as pproTicksIn/Out, which do span the consumed
            # range. Taking these raw made every retimed cut short by (1 - 1/speed).
            src_in_sec = (src_in_t / PPRO_TICKS_PER_SECOND) * k
            src_dur_sec = ((src_out_t - src_in_t) / PPRO_TICKS_PER_SECOND) * k
            timing = "ticks"

        # Premiere's interpreted rate, which beats both the XML's <file><rate> and
        # ffprobe: it is the rate the edit was actually built against. apply_probe
        # would otherwise overwrite this from the file, so it is pinned below.
        # usable_fps, not `> 0`: see its docstring for why a 1e-7 rate is poison.
        src_fps = usable_fps((e.get("interpretation") or {}).get("frame_rate"))

        name = str(e.get("name") or pi.get("name") or "clip")
        ramp = bool(e.get("has_keyframed_remap"))
        span_txt = ""
        if ramp:
            vals = [k.get("value") for comp in (e.get("components") or [])
                    if comp.get("is_time_remap")
                    for p in (comp.get("params") or [])
                    for k in (p.get("keys") or [])
                    if isinstance(k.get("value"), (int, float))]
            if vals:
                span_txt = f"{min(vals) * 100:g}–{max(vals) * 100:g}%"

        cut = Cut(
            clip_name=name,
            track_type=str(e.get("track_type") or "video"),
            track_index=int(e.get("track_index") or 1),
            timeline_in_frames=t_in,
            timeline_out_frames=t_out,
            timeline_in_tc=frames_to_tc(t_in, self.sequence_fps),
            timeline_out_tc=frames_to_tc(t_out, self.sequence_fps),
            source_in_seconds=src_in_sec,
            source_duration_seconds=src_dur_sec,
            timing_source=timing,
            duration_frames=dur_frames,
            duration_seconds=round(frames_to_seconds(dur_frames, self.sequence_fps), 6),
            source_path=path,
            source_exists=bool(path) and os.path.isfile(path),
            file_id=str(pi.get("node_id") or ""),
            source_fps=round(src_fps, 6),
            interpreted_fps=round(src_fps, 6),
            speed_percent=speed,
            reversed=bool(e.get("reversed")),
            speed_varies=ramp,
            speed_span=span_txt,
            enabled=not bool(e.get("disabled")),
            media_kind=kind,
            filters=[str(c.get("displayName") or "")
                     for c in (e.get("components") or [])
                     if c.get("displayName") not in (None, "", "Opacity")],
        )
        if src_fps > 0:
            cut.source_in_frames = int(round(src_in_sec * src_fps))
            cut.source_out_frames = int(round((src_in_sec + src_dur_sec) * src_fps))
            cut.source_in_tc = frames_to_tc(cut.source_in_frames, src_fps)
            cut.source_out_tc = frames_to_tc(cut.source_out_frames, src_fps)
            cut.source_consumed_frames = consumed_frames(src_in_sec, src_dur_sec, src_fps)

        if kind == "still":
            cut.source_in_seconds = 0.0
            cut.source_duration_seconds = frames_to_seconds(dur_frames,
                                                            self.sequence_fps)
            cut.source_consumed_frames = dur_frames
            cut.timing_source = "timeline"

        if ramp:
            self.warnings.append(
                f"{name}: keyframed speed ramp ({span_txt or 'varies'}) — the extracted "
                f"range is right, a uniform retime is not")

        # The invariant that catches a wrong reading of the API before it becomes a
        # wrong file: source length / speed should equal the length on the timeline.
        # If Premiere's inPoint/outPoint ever stopped spanning the CONSUMED range,
        # this is where it would surface, loudly, instead of silently mis-cutting.
        if kind == "video" and timing == "ticks" and dur_frames > 0 and not ramp:
            want = frames_to_seconds(dur_frames, self.sequence_fps)
            got = src_dur_sec / (speed / 100.0)
            if abs(got - want) > max(0.05, want * 0.02):
                self.warnings.append(
                    f"{name}: source range {src_dur_sec:.3f}s at {speed:g}% implies "
                    f"{got:.3f}s on the timeline but it occupies {want:.3f}s "
                    f"— treat this clip's length as unverified")
        return cut


def match_dump_clip(buckets: dict, want_ticks: int, slack: float,
                    source_path: str) -> tuple:
    """Find the panel clip that is the same clip as an XML cut.

    Position alone is not an identity on a real timeline: graphics, titles and
    adjustment layers sit at the same start ticks as the footage beneath them, so a
    tick can name half a dozen clips. The media filename settles it — a cut and the
    panel clip it came from necessarily reference the same file.

    Returns (clip_or_None, how) where `how` is one of "exact", "byname", "only",
    "ambiguous" or "none", so the caller can report what it could not resolve rather
    than guessing.
    """
    cands = []
    for t, lst in buckets.items():
        if abs(t - want_ticks) <= slack:
            cands.extend(lst)
    if not cands:
        return None, "none"

    base = os.path.basename(source_path or "").lower()
    if base:
        named = [c for c in cands
                 if os.path.basename(
                     ((c.get("project_item") or {}).get("media_path") or "")
                 ).lower() == base]
        if len(named) == 1:
            return named[0], "byname"
        if named:
            # Same file used twice at the same instant on different tracks. Either is
            # as good as the other: they share the media, which is all the overlay
            # reads that is position-independent.
            return named[0], "byname"

    if len(cands) == 1:
        return cands[0], "only"
    # Several clips here and none of them is this file. Matching one anyway would
    # attach another clip's ramp keys, or repoint this cut at another clip's media.
    return None, "ambiguous"


def overlay_dump(tl, dump_path: Path) -> list[str]:
    """Overlay a panel dump onto an XML-parsed timeline. Returns notes to print.

    The two sources are not equal, and the merge reflects which is authoritative for
    what rather than preferring one wholesale:

      * The XML is the BASE. It is the path with the fixture behind it, and it is the
        only one that resolves nested sequences.
      * The panel supplies what an XML cannot express: the real keyframes of a speed
        ramp, and the media's CURRENT location.
      * Everything both of them carry — source range, speed, frame rate — is
        cross-checked, and a disagreement is reported rather than silently resolved.

    Only one thing here changes what gets cut: repairing a path the XML records at a
    stale location and the panel knows the truth of. That is a strict improvement — it
    only fires when the XML's path does not exist and the panel's does.
    """
    try:
        data = json.loads(dump_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return [f"panel dump not found: {dump_path} — cut from the XML alone"]
    except json.JSONDecodeError as e:
        return [f"panel dump is not readable JSON ({e}) — cut from the XML alone"]
    if data.get("generator") != DumpTimeline.GENERATOR:
        return [f"{dump_path.name} was not written by the Raw-cutter panel "
                f"— cut from the XML alone"]

    notes: list[str] = []
    dseq = (data.get("sequence") or {}).get("name") or ""
    if dseq and tl.sequence_name and dseq != tl.sequence_name:
        notes.append(f"the panel read {dseq!r} but the XML is {tl.sequence_name!r} "
                     f"— not the same timeline, so nothing was merged")
        return notes

    # Bucket the dump by timeline start ticks — but as a LIST per tick, not one clip.
    # A real timeline stacks graphics, titles and adjustment layers over the footage,
    # so many clips share a start tick; keeping only the first silently matched a cut
    # against whatever happened to be on top. On real timeline that mismatched most
    # of the list, and since the merge can repoint a cut's media, a wrong match could
    # have pointed a cut at the wrong file.
    buckets: dict[int, list] = {}
    for c in data.get("clips") or []:
        if c.get("track_type") != "video":
            continue
        t = DumpTimeline._ticks(c.get("start"))
        if t is not None:
            buckets.setdefault(t, []).append(c)

    slack = PPRO_TICKS_PER_SECOND / max(tl.sequence_fps, 1)   # one frame
    repaired = ramps = rate_flags = range_flags = matched = ambiguous = tc_bases = 0

    for cut in tl.cuts:
        if cut.track_type != "video":
            continue
        want = int(round(cut.timeline_in_frames * PPRO_TICKS_PER_SECOND
                         / tl.sequence_fps))
        pc, how = match_dump_clip(buckets, want, slack, cut.source_path)
        if how == "ambiguous":
            ambiguous += 1
        if pc is None:
            # Expected for anything inside a nest — the panel saw the nest as one clip
            # — and for titles, graphics and adjustment layers, which carry no media.
            continue
        matched += 1
        pi = pc.get("project_item") or {}

        # -- path repair, the one thing that changes the cut ---------------------
        live = str(pi.get("media_path") or "")
        if (live and not cut.source_exists and os.path.isfile(live)
                and cut.media_kind != "unsupported"):
            cut.source_path = live
            cut.source_exists = True
            repaired += 1

        # -- the ramp curve, which only the panel has ---------------------------
        keys = []
        for comp in pc.get("components") or []:
            if not comp.get("is_time_remap"):
                continue
            for p in comp.get("params") or []:
                for k in p.get("keys") or []:
                    secs = (k.get("time") or {}).get("seconds")
                    val = k.get("value")
                    if isinstance(secs, (int, float)) and isinstance(val, (int, float)):
                        keys.append([round(float(secs), 6), round(float(val), 6)])
        if len(keys) > 1:
            keys.sort()
            cut.ramp_keys = keys
            cut.speed_varies = True
            vals = [v for _, v in keys]
            cut.speed_span = f"{min(vals) * 100:g}–{max(vals) * 100:g}%"
            ramps += 1

        # -- cross-checks: report, never silently resolve ------------------------
        interp = usable_fps((pc.get("interpretation") or {}).get("frame_rate"))
        if interp:
            cut.interpreted_fps = round(interp, 6)

        p_in = DumpTimeline._ticks(pc.get("in_point"))
        p_out = DumpTimeline._ticks(pc.get("out_point"))
        if p_in is not None and p_out is not None and p_out > p_in:
            # Scaled by speed, for the same reason DumpTimeline._build scales: these are
            # timeline units, not source units. Comparing them raw reported every
            # retimed clip as a disagreement, which is noise that hides real ones.
            p_speed = pc.get("speed")
            k = (abs(float(p_speed)) if isinstance(p_speed, (int, float)) and p_speed
                 else 1.0) or 1.0
            p_in_sec = (p_in / PPRO_TICKS_PER_SECOND) * k

            # Stills and Dynamic Link comps report inPoint as an ABSOLUTE media
            # timecode, which starts at 01:00:00:00 on this kind of media — so a clip
            # beginning at its own frame 0 comes back as 3600s. On a real timeline every
            # single reported disagreement was this, and a warning that is always wrong
            # is a warning you learn to skip. Subtract whole hours when the value is
            # within a frame of one; nothing genuinely sits an exact hour into a still.
            tc_base = 0.0
            if p_in_sec >= 3600.0 - 1.0:
                hours = round(p_in_sec / 3600.0)
                if hours >= 1 and abs(p_in_sec - hours * 3600.0) < 1.0:
                    tc_base = hours * 3600.0
                    p_in_sec -= tc_base

            d_in = p_in_sec - cut.source_in_seconds
            d_dur = (((p_out - p_in) / PPRO_TICKS_PER_SECOND) * k
                     - cut.source_duration_seconds)
            # A transition makes the XML's range legitimately longer — it includes the
            # material under the dissolve, which the panel's clip bounds do not — so
            # those clips are not reported as disagreeing.
            if not cut.edge_in_transition and (abs(d_in) > 0.004 or abs(d_dur) > 0.004):
                range_flags += 1
                if tc_base:
                    tc_bases += 1
                # ONE short line per clip. This used to repeat the whole explanation —
                # "Premiere and the XML disagree on the source range (…). The XML's value
                # was used — it is the verified path." — for every clip. On a real run of
                # three, that was 544 characters of which 465 were the same sentence three
                # times, carrying 79 characters of actual information. The explanation is
                # said once, in the lead note below.
                # The leading "· " marks this as a DETAIL of the lead note above rather than
                # a note in its own right. The panel indents these into a table under their
                # heading; on the command line it reads as the bullet it is.
                notes.append(f"· {cut.clip_name}: in {d_in:+.3f}s, "
                             f"length {d_dur:+.3f}s")

        p_speed = pc.get("speed")
        if isinstance(p_speed, (int, float)) and p_speed:
            p_pct = abs(float(p_speed)) * 100.0
            if abs(p_pct - cut.speed_percent) > 0.5 and not cut.speed_varies:
                notes.append(f"{cut.clip_name}: speed differs — Premiere {p_pct:.2f}%, "
                             f"XML {cut.speed_percent:.2f}%")

    # Counted against VIDEO cuts only. The overlay runs before --tracks filtering, so
    # comparing against every cut would report audio clips as "missing from the dump".
    video_cuts = sum(1 for c in tl.cuts if c.track_type == "video")
    unmatched = video_cuts - matched
    lead = [f"merged the panel's read of {dseq or 'the sequence'}: {matched} of "
            f"{video_cuts} video clip(s) matched"
            + (f", {unmatched} only in the XML (nests, titles, graphics)"
               if unmatched > 0 else "")]
    if ambiguous:
        # Almost always nested content: the panel hands over the NEST, so a child clip's
        # filename is never in the bucket and no match is possible. Naming the cause
        # matters — the mechanism on its own reads like a fault when it is expected.
        nested_amb = sum(1 for c in tl.cuts
                         if c.track_type == "video" and c.nested_from)
        why = ("expected — these are inside nested sequences, which the panel sees as a "
               "single clip" if nested_amb else
               "several clips share that instant and none carries this cut's filename")
        lead.append(f"{ambiguous} cut(s) kept the XML's values rather than guessing: {why}")
    if repaired:
        lead.append(f"repaired {repaired} media path(s) from Premiere's live location")
    if ramps:
        lead.append(f"read the real keyframes of {ramps} speed ramp(s) — "
                    f"in the manifest as ramp_keys")
    if range_flags:
        # The shared explanation, said ONCE. Everything after this in `notes` is one short
        # line per clip.
        lead.append(f"{range_flags} clip(s) disagree on the source range — the XML's value "
                    f"was used, which is the verified path"
                    + (f"; a whole-hour timecode base was removed from {tc_bases} of them"
                       if tc_bases else ""))
    return lead + notes


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
        cut.source_consumed_frames = consumed_frames(
            cut.source_in_seconds, cut.source_duration_seconds, cut.source_fps)


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
    # Everything lands in 4:2:0. Preserving a 10-bit 4:2:2 source used to be the right
    # call under lossless, but any format above 8-bit 4:2:0 pushes x264 into a High 10 or
    # 4:4:4 profile, which is the exact thing that made these files unplayable. Playable
    # everywhere beats a chroma fidelity nothing downstream was reading.
    return "yuv420p"


def codec_flags(cut: Cut, args) -> list[str]:
    """The encoder settings, in ONE place.

    build_command has three exits — stills, audio, video — and each used to repeat the
    codec flags. Adding crf/bitrate to two of three would have been a silent inconsistency
    that only showed up on a timeline containing stills.
    """
    crf = crf_of(args)
    preset = getattr(args, "x264_preset", None) or X264_PRESET
    rate = parse_bitrate(getattr(args, "bitrate", None) or "")
    out = ["-c:v", args.vcodec]
    if rate:
        # Target-rate mode: the point of it is a predictable file size, so cap the peak
        # and give it a buffer rather than letting the average drift.
        out += ["-b:v", str(rate), "-maxrate", str(int(rate * 1.5)),
                "-bufsize", str(int(rate * 2))]
    else:
        out += ["-crf", crf_text(crf)]
    out += ["-preset", preset, "-profile:v", X264_PROFILE,
            "-pix_fmt", cut.pix_fmt_out]
    return out


def build_command(cut: Cut, out_path: Path, args, seq_fps: float) -> list[str]:
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]

    if cut.media_kind == "still":
        # A still has no timeline to seek into — loop it for the on-screen duration.
        # The even-rounding scale that has always been here IS scale_filter at 100%, so
        # the two are one expression rather than a special case bolted beside a general
        # one. A still with an odd dimension still cannot be encoded, scaled or not.
        cmd += ["-loop", "1", "-framerate", f"{seq_fps:.6f}", "-i", cut.source_path,
                "-t", f"{cut.source_duration_seconds:.6f}",
                *codec_flags(cut, args),
                "-movflags", "+faststart",
                "-vf", scale_filter(args) or "scale=trunc(iw/2)*2:trunc(ih/2)*2",
                "-an", str(out_path)]
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
              and (is_retimed(cut.speed_percent) or rate_mismatch))

    ss, t = cut.source_in_seconds, cut.source_duration_seconds
    fps = cut.source_fps or 0
    n_frames = 0
    if fps > 0:
        # Tolerance is expressed in FRAMES, not seconds — a hair over a frame
        # boundary must floor down, but float noise and any upstream rounding must
        # not. 1e-4 of a frame is far above the noise and far below half a frame,
        # so a genuinely mid-frame in-point still floors correctly.
        start_f = int(ss * fps + 1e-4)
        # THE SAME NUMBER THE MANIFEST REPORTS. This used to be round(t * fps) — the
        # very rule consumed_frames() was written to replace, left behind here when that
        # function was introduced. The two agree for any range covering a whole number
        # of frames, which is every clip the fixture had, so the divergence went unseen:
        # on a range of 55.26 frames the manifest said 56 and ffmpeg was told 55, and the
        # file did not match its own label. One definition, one call.
        n_frames = max(1, cut.source_consumed_frames
                       or consumed_frames(ss, t, fps))
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
        # LAST in the chain, after select/reverse/setpts. Scaling first would resize every
        # frame `reverse` buffers, including the ones `select` is about to throw away.
        sf = scale_filter(args)
        if sf:
            vf.append(sf)

        cmd += ["-ss", f"{ss:.6f}", "-t", f"{t:.6f}", "-i", cut.source_path]
        if vf:
            cmd += ["-filter:v", ",".join(vf)]
        if retime:
            cmd += ["-r", f"{seq_fps:.6f}", "-frames:v", str(max(1, cut.duration_frames))]
        else:
            cmd += ["-frames:v", str(max(1, n_frames))]

        cmd += [*codec_flags(cut, args),
                "-movflags", "+faststart", "-an"]
        cmd += [str(out_path)]
        return cmd

    cmd += ["-ss", f"{ss:.6f}", "-i", cut.source_path]
    cmd += ["-t", f"{t:.6f}"]
    # Frame count, not duration, is what must be exact — -t alone loses the last
    # frame to timestamp rounding on roughly half of real-world clips.
    if n_frames:
        cmd += ["-frames:v", str(n_frames)]

    # ⚠️ An explicit output rate RESAMPLES: ffmpeg drops or duplicates frames to hit it.
    # The file then no longer holds the frames the timeline used, which is the property
    # every check in tests/verify.py rests on. Recorded per clip as frame_exact=false.
    out_fps = getattr(args, "fps", None)
    if out_fps:
        cmd += ["-r", f"{float(out_fps):.6f}"]

    # Added only when it does something. At 100% this branch had no -filter:v at all and
    # still should not: an identity scale is a full decode-filter-encode pass that changes
    # nothing, and it would silently become the norm for every export.
    sf = scale_filter(args)
    if sf:
        cmd += ["-filter:v", sf]

    cmd += [
        # crf/bitrate/preset come from codec_flags; the PROFILE stays pinned inside it, so
        # lossless mode can never quietly reintroduce High 4:4:4 Predictive — a profile no
        # Mac decoder will open.
        *codec_flags(cut, args),
        "-movflags", "+faststart",       # so it starts playing without reading the tail
        # NO AUDIO, always — see the note on the constants. An AAC track made every
        # container declare a duration one frame longer than its own video stream.
        "-an",
    ]
    cmd += [str(out_path)]
    return cmd


PROBE_SECONDS = 1.0
PROBE_SLICES = 3
PROBE_TIMEOUT = 25

# The mp4 container's own fixed cost, MEASURED rather than guessed: encoding the same source
# for 0.2/0.5/1/2/4 seconds and fitting size against duration gives 135633 bytes per second
# plus a 458-byte intercept. So it is ~460 bytes, not the 8192 the first version subtracted —
# which was 18x too much and made every short clip under-estimate by about 7%.
#
# It matters because it does NOT scale with duration. Stripped from each probe slice, then
# added back ONCE to the estimate; multiplying it up with the content rate is what produced
# the error.
CONTAINER_FIXED = 512

# A still is probed whole rather than sampled (see size_probe). Bounded only so a
# pathologically long one cannot stall a scan; its frames after the first are nearly
# free, so this is generous rather than tight.
PROBE_STILL_MAX = 30.0


def size_probe(cut: Cut, args, seq_fps: float) -> None:
    """ENCODE one second of this clip and record what it cost per second.

    ⚠️ THE SOURCE'S OWN BITRATE IS NOT A BASIS FOR AN ESTIMATE, and the version of this
    function that used it was wrong by up to 200x on real footage. Measured on a 19-clip
    production timeline at crf 15.5, output rate as a multiple of the source's:

        h264   1080x1920, src 10-20 Mbps    0.55-1.09x    model said 1.16x   ~1.6x high
        h264   3840x2160, src 260 Mbps      0.30x         model said 1.16x   ~4x high
        prores 2000x2000, src 632-728 Mbps  0.006-0.008x  model said 1.16x   ~180x high

    An intraframe codec spends hundreds of megabits on a shot that x264 encodes in four,
    so its bitrate says nothing whatever about what H.264 will cost. Nor does resolution:
    bits per pixel at one crf ranged 0.065 to 0.308 across those same clips, a 5x spread,
    because that number IS content complexity and cannot be inferred from a container.

    So this measures. One second of the real clip, through the real build_command, at the
    real settings — the same encoder, filters and flags the export will use, which is why
    it is right rather than merely closer.

    ⚠️ SAMPLED IN SEVERAL PLACES, not just at the head. The first version took one second
    from the start and was out by 2.19x on a 9.4-second clip whose opening move is busier
    than the rest of it — a 10% sample of the least representative part. Up to three slices
    spread through the clip, so the estimate sees the quiet middle as well as the entrance.
    On the same 19 clips that took the worst case from 2.19x to within a fifth.

    Bounded on purpose: at most PROBE_SLICES short reads, each with a timeout. Media can
    live on a network share and a 728 Mbps ProRes read can stall; a probe that hangs
    would turn a scan into a wait with no explanation, so a timeout leaves probe_bps at 0
    and the caller falls back rather than blocking.
    """
    if cut.media_kind == "unsupported" or not cut.source_exists:
        return
    secs = cut.source_duration_seconds or 0.0
    if secs <= 0:
        return
    # ⚠️ pix_fmt_out is normally set by run_cut, which has not run yet — codec_flags reads
    # it and ffmpeg answers "Unknown pixel format requested: ." with exit 234. That failure
    # is SILENT by design here (a failed probe just falls back to the model), so the first
    # version of this shipped doing nothing at all while the fixture's estimates still
    # looked right, because the fixture is ordinary h264 where the model happens to work.
    # Set it the same way run_cut does, from the same function.
    if not cut.pix_fmt_out:
        cut.pix_fmt_out = pix_fmt_for(cut)
    # One slice for a short clip, up to three for a long one. A 2s clip IS its own sample;
    # a 10s clip is not.
    n = min(PROBE_SLICES, max(1, round(secs / 3.0)))
    span = min(PROBE_SECONDS, secs / n)
    # A STILL is measured in FULL, however long it is.
    #
    # Almost all of a still's file is its one keyframe; every frame after that is a few
    # bytes of "no change". So its cost is overwhelmingly FIXED, and sampling a second of
    # it and multiplying by the duration multiplies that keyframe up — a 1.5s still came out
    # 1.20x high and a 10s one would be far worse. Encoding the whole thing is affordable
    # precisely because the frames after the first are nearly free.
    if cut.media_kind == "still":
        n, span = 1, min(secs, PROBE_STILL_MAX)
    fps = cut.source_fps or seq_fps
    bits = 0.0
    sampled = 0.0
    for i in range(n):
        # Centre each slice in its own nth of the clip, so the slices are spread rather
        # than adjacent, and clamp so the last one cannot run off the end.
        at = cut.source_in_seconds + max(0.0, min(secs - span,
                                                  secs * (i + 0.5) / n - span / 2))
        stub = replace(cut, source_in_seconds=at, source_duration_seconds=span,
                       source_consumed_frames=max(1, int(span * fps)),
                       duration_frames=max(1, int(span * seq_fps)))
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / f"probe.{getattr(args, 'container', None) or 'mp4'}"
            try:
                r = subprocess.run(build_command(stub, out, args, seq_fps),
                                   capture_output=True, timeout=PROBE_TIMEOUT)
            except (subprocess.TimeoutExpired, OSError):
                return
            if r.returncode != 0 or not out.exists() or out.stat().st_size == 0:
                return
            # Strip the container's fixed cost so probe_bps is CONTENT only. It is added
            # back once, in estimate_sizes — it does not scale with duration, and treating
            # it as if it did is what made short clips under-estimate.
            size = out.stat().st_size
            bits += max(0.0, size - CONTAINER_FIXED) * 8
            sampled += span
    if sampled <= 0:
        return
    cut.probe_bps = bits / sampled
    cut.probe_crf = float(crf_of(args))


def probe_sizes(cuts: list[Cut], args, seq_fps: float) -> None:
    """Every cuttable clip, probed in parallel — the same pool width as the export."""
    todo = [c for c in cuts
            if c.media_kind != "unsupported" and c.source_exists
            and (c.source_duration_seconds or 0) > 0]
    if not todo:
        return
    with ThreadPoolExecutor(max_workers=JOBS) as ex:
        for fut in as_completed([ex.submit(size_probe, c, args, seq_fps) for c in todo]):
            fut.result()


def estimate_sizes(cuts: list[Cut], args) -> None:
    """What each cut is expected to weigh, before the whole thing is encoded.

    Uses size_probe()'s MEASURED rate when there is one — that is the accurate path and
    the only one worth trusting. The source-bitrate model below is the fallback for
    --no-size-probe and for a clip whose probe failed, and it is kept only because a wrong
    number with a warning beats no number at all when someone is deciding whether to press
    Export. It is documented as unreliable in size_probe(); do not promote it.

      target bitrate   a CEILING, not an estimate. rate x seconds is what the encoder is
                       allowed to spend, and on short clips it routinely spends less
                       because the content does not need it:
                           4M  ~17.2 MB allowed, 10.7 MB actual  (62%)
                           1M   ~4.3 MB allowed,  3.5 MB actual  (81%)
                       Reported as "at most", since the shortfall depends on the footage
                       and there is no honest constant to calibrate it with.
    """
    rate = parse_bitrate(getattr(args, "bitrate", None) or "")
    ratio = size_ratio_for_crf(crf_of(args))
    pct = scale_of(args)
    # Bytes track PIXEL COUNT, so the factor is the scale SQUARED — measured across three
    # real cuts at 75/50/33%, where it held to within about a third and undershot on
    # detailed footage. Applied to the target-rate path too: -b:v is a rate the encoder
    # aims at whatever the frame size, so a downscaled clip does NOT get smaller in that
    # mode, and multiplying there would promise a saving the mode does not give.
    area = (pct / 100.0) ** 2
    for c in cuts:
        secs = c.source_duration_seconds or 0.0
        c.output_width, c.output_height = scaled_dims(c.width, c.height, pct)
        if secs <= 0 or c.media_kind == "unsupported" or not c.source_exists:
            continue
        if rate:
            c.estimated_bytes = int(rate * secs / 8)
        elif c.probe_bps > 0:
            # MEASURED, when --size-probe asked for it. The probe ran at THESE settings,
            # resolution filter included, so the area factor is already in the number and
            # must not be applied twice. The container's fixed cost is added once, not
            # scaled — see CONTAINER_FIXED.
            c.estimated_bytes = int(c.probe_bps * secs / 8 + CONTAINER_FIXED)
        else:
            # The default: metadata only, so it costs nothing and a slider can follow it.
            modelled = estimate_bytes_for(c, crf_of(args), pct, secs)
            if modelled > 0:
                c.estimated_bytes = int(modelled)
            elif c.bitrate:
                # No dimensions to work from — the last resort, and the unreliable one.
                c.estimated_bytes = int(float(c.bitrate) * ratio * area * secs / 8)


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


_SAY_LOCK = threading.Lock()


def say(line: str) -> None:
    """Print one line atomically from a worker thread."""
    with _SAY_LOCK:
        print(line, flush=True)


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
    # Announced BEFORE the encode, not after. With JOBS clips running at once, reporting
    # only on completion means nothing is said for the entire length of the first encode —
    # and a single long clip on network media can hold that silence for minutes.
    say(f"  >> {cut.output_file}")
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
            # The real number, so the report shows what was written rather than what was
            # predicted. The estimate is for deciding; this is for checking.
            cut.output_bytes = out_path.stat().st_size
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


def pick_key(cut: Cut) -> tuple:
    """What identifies a clip for --pick.

    (track type, track index, timeline in-point in frames). Stable against filtering
    and re-indexing, and unique — two clips cannot start on the same frame of the same
    track. An index would not do: it shifts whenever anything else is filtered out.
    """
    return (cut.track_type, int(cut.track_index), int(cut.timeline_in_frames))


def read_pick_file(path: Path) -> set:
    """Selectors from a --pick file. Blank lines and # comments ignored."""
    keys = set()
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError as e:
        raise SystemExit(f"error: could not read --pick file {path} ({e})")
    for n, line in enumerate(text.splitlines(), start=1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) != 3:
            raise SystemExit(f"error: {path}:{n}: expected "
                             f"'TRACKTYPE TRACKINDEX TIMELINEIN', got {line!r}")
        try:
            keys.add((parts[0], int(parts[1]), int(parts[2])))
        except ValueError:
            raise SystemExit(f"error: {path}:{n}: track index and timeline in-point "
                             f"must be whole numbers, got {line!r}")
    if not keys:
        raise SystemExit(f"error: {path} selected no clips — nothing would be cut")
    return keys


def describe(cut: Cut) -> dict:
    """How a cut should be presented: status wording, notes, and a severity class.

    ONE definition, because there are now three front ends — the browser GUI, the
    Premiere panel and the CLI — and they had already drifted: the GUI worded
    `no_audio` as "silent source" and the panel said nothing at all. Anything that
    reads a Cut for display should come through here.

    Returns {"status", "notes", "kind", "cuttable"}. `kind` is one of "", "ok", "ramp",
    "warn", "bad" — a class name in both front ends.
    """
    cuttable = cut.source_exists and cut.media_kind != "unsupported"

    if cut.status == "pending":
        # Unsupported is checked FIRST, matching run_cut: an .aep is a Dynamic Link comp
        # whether or not it happens to be on disk, and "missing source" would send you
        # hunting for a path when the fix is to render it out.
        status = ("AE comp — render it" if cut.media_kind == "unsupported"
                  else "missing source" if not cut.source_exists
                  else "ready")
    else:
        status = {"ok": "written", "skipped_existing": "already there",
                  "no_audio": "silent source",
                  "missing_source": "missing source"}.get(cut.status, cut.status)

    notes = []
    if cut.reversed:
        notes.append("reversed")
    if cut.speed_varies:
        notes.append(f"ramp {cut.speed_span}" if cut.speed_span else "speed ramp")
    if cut.nested_from:
        notes.append(f"in {cut.nested_from}")
    if cut.nested_trimmed:
        notes.append(f"{cut.nested_trimmed} trimmed")
    if cut.edge_in_transition:
        notes.append(f"{cut.edge_in_transition} under a transition")
    if cut.track_type == "audio":
        notes.append("audio")
    if cut.pix_fmt_out and cut.pix_fmt and cut.pix_fmt_out != cut.pix_fmt:
        notes.append(f"{cut.pix_fmt} → {cut.pix_fmt_out}")

    kind = ("bad" if cut.status in ("failed", "missing_source") or not cut.source_exists
            else "warn" if cut.media_kind == "unsupported" or cut.status == "no_audio"
            else "ok" if cut.status in ("ok", "skipped_existing")
            else "ramp" if is_retimed(cut.speed_percent) or cut.reversed
            else "")

    return {"status": status, "notes": " · ".join(notes), "kind": kind,
            "cuttable": cuttable}


def readable(cut: Cut) -> dict:
    """Cut as a dict, with the seconds fields rounded for human/CSV consumption.

    Rounding happens HERE and nowhere earlier: the in-memory values feed the ffmpeg
    seek, where losing the 7th decimal loses a whole frame.
    """
    d = asdict(cut)
    for k in SECONDS_FIELDS:
        if isinstance(d.get(k), float):
            d[k] = round(d[k], 6)
    # The display wording travels IN the manifest, so a front end reading the manifest
    # gets the same status and notes as the CLI rather than reimplementing describe().
    # This is what stops the GUI and the panel drifting apart again.
    disp = describe(cut)
    d["display_status"] = disp["status"]
    d["display_notes"] = disp["notes"]
    d["display_kind"] = disp["kind"]
    d["cuttable"] = disp["cuttable"]
    return d


SHEET_COLUMNS = [
    ("file", "output_file"),
    ("clip name", "clip_name"),
    ("timeline in", "timeline_in_tc"),
    ("timeline out", "timeline_out_tc"),
    # The four columns that let a cut be checked without doing arithmetic. A cut is
    # written at the source's own speed, so it is LONGER than its timeline clip when
    # sped up and shorter when slowed. Re-speeding it by "speed %" should return it to
    # "timeline length" — near enough. It will not land on the percentage exactly,
    # because "frames" is a whole number while the range Premiere consumed is not, and
    # a ratio of two rounded integers cannot reproduce an unrounded one. On a short
    # clip that shows up as up to about 1%.
    ("speed %", "speed_percent"),
    ("cut length s", "source_duration_seconds"),
    ("frames", "source_consumed_frames"),
    ("timeline length s", "duration_seconds"),
    ("original name", None),          # basename of source_path
    ("original path", "source_path"),
]


def describe_encode(args) -> str:
    """One line naming what was actually used, for the manifest and the sheet."""
    rate = getattr(args, "bitrate", None)
    q = f"bitrate {rate}" if parse_bitrate(rate or "") else f"crf {crf_text(crf_of(args))}"
    bits = [f"libx264 {q}", f"profile {X264_PROFILE}",
            f"preset {getattr(args, 'x264_preset', None) or X264_PRESET}"]
    pct = scale_of(args)
    if pct < 100.0:
        bits.append(f"scaled to {pct:g}% of source resolution")
    if getattr(args, "fps", None):
        bits.append(f"RESAMPLED to {float(args.fps):g} fps — not frame exact")
    return ", ".join(bits)


def export_summary(tl: Timeline, args) -> dict:
    """The export-level facts: what was cut, from where, under what settings.

    ONE definition, because it now appears twice — as the manifest's top-level block and as
    the section at the top of clips.csv. A sheet and a manifest from the same run must not
    be able to describe it differently, which is the same reason describe() exists.
    """
    cut_state = ("cut list only — nothing encoded yet"
                 if all(c.status in ("pending", "dry_run") for c in tl.cuts)
                 else "cut")
    s = {
        "tool": f"{NAME} {VERSION}",
        "source_xml": str(tl.xml_path),
        "state": cut_state,
        "sequence": {
            "name": tl.sequence_name,
            "fps": round(tl.sequence_fps, 6),
            "duration_frames": tl.sequence_duration_frames,
            "duration_tc": frames_to_tc(tl.sequence_duration_frames, tl.sequence_fps),
        },
        "settings": {
            "encode": describe_encode(args),
            "crf": (None if parse_bitrate(getattr(args, "bitrate", None) or "")
                    else crf_of(args)),
            "bitrate": (getattr(args, "bitrate", None) or None),
            "x264_preset": getattr(args, "x264_preset", None) or X264_PRESET,
            # ⚠️ Present and non-null means the clips were RESAMPLED and are no longer
            # frame-exact. A dataset built from them is a different dataset.
            "output_fps": (float(args.fps) if getattr(args, "fps", None) else None),
            "frame_exact": not bool(getattr(args, "fps", None)),
            # Percent of each source's own resolution. Unlike output_fps this does NOT
            # touch frame_exact: the cuts still hold exactly the frames the timeline used,
            # at fewer pixels each. Per-clip dimensions are on the clips themselves,
            # because one percentage cannot describe a timeline of mixed sources.
            "scale_percent": scale_of(args),
            "export_preset": getattr(args, "export_preset", None),
            "estimated_bytes": sum(c.estimated_bytes for c in tl.cuts),
            # "ceiling" with a target bitrate, "estimate" with a crf — they are not the
            # same kind of number and a reader should not have to guess which.
            "estimated_bytes_kind": ("ceiling" if parse_bitrate(
                getattr(args, "bitrate", None) or "") else "estimate"),
            "jobs": JOBS,
            "speed": getattr(args, "speed", "native"),
            # Which source types were left out, so the output can be read honestly
            # later: a dataset missing every still is a different dataset, and
            # nothing else in here would say so.
            "types_kept": getattr(args, "types_kept", None),
            "types_excluded": getattr(args, "types_excluded", None),
            # A partial run has to say so. Without this the manifest describes a
            # complete cut of the timeline, and a dataset built from it silently
            # omits whatever was unticked — with nothing recording that it happened.
            "picked_from": (str(getattr(args, "pick", "") or "") or None),
            "picked_count": getattr(args, "picked", None),
        },
        "warnings": tl.warnings,
        "counts": {
            "cuts": len(tl.cuts),
            # What the timeline held before --ext and --pick. Equal to `cuts` on a complete
            # run; the pair is what makes a partial export legible.
            "cuts_on_timeline": getattr(args, "cuts_before_filters", None) or len(tl.cuts),
            "unique_sources": len({c.source_path for c in tl.cuts}),
            # missing_sources means MEDIA THAT SHOULD BE THERE AND ISN'T. It used to be
            # `not c.source_exists`, which also counted every .aep — a Dynamic Link comp
            # was never a file on disk, and the fix for it is to render it, not to repair a
            # path. Reported apart now that this tally is printed at the top of the sheet:
            # a count that disagrees with the rows below it is worse than no count.
            "missing_sources": sum(1 for c in tl.cuts
                                   if not c.source_exists
                                   and c.media_kind != "unsupported"),
            "unsupported": sum(1 for c in tl.cuts if c.media_kind == "unsupported"),
            "ok": sum(1 for c in tl.cuts if c.status == "ok"),
            "failed": sum(1 for c in tl.cuts if c.status == "failed"),
        },
    }
    # Carried IN the summary so every front end reads the same sentence. The panel's report
    # showed "25 of 27 matched" and "18 written" with nothing accounting for 25 → 18; this is
    # the line that accounts for it, and it was being computed for clips.csv only.
    s["completeness"] = completeness(s)
    return s


def completeness(s: dict) -> str:
    """Whether this export is the whole timeline, and if not, what removed the rest.

    A dataset missing every still, or missing whatever was unticked, is a different dataset,
    and a folder of clips cannot say so by itself.
    """
    n, st = s["counts"], s["settings"]
    total, kept = n["cuts_on_timeline"], n["cuts"]
    if kept >= total:
        return f"all {total} cuts on the timeline"
    why = []
    if st["types_kept"]:
        why.append("limited to source types " + ", ".join(st["types_kept"]))
    if st["picked_from"]:
        why.append("clips chosen by hand (" + Path(st["picked_from"]).name + ")")
    return (f"{kept} of {total} cuts on the timeline"
            + (" — " + "; ".join(why) if why else ""))


def sheet_header_rows(tl: Timeline, args) -> list:
    """The export-info section that opens clips.csv, as CSV rows.

    Written as `label,value` pairs and closed with a blank line, so the sheet is still a
    well-formed CSV: a human sees the context first, and a reader that wants the table can
    skip to the first row after the blank one. manifest.json stays the clean machine-
    readable copy, which is why this can afford to be shaped for a person.
    """
    s = export_summary(tl, args)
    seq, st, n = s["sequence"], s["settings"], s["counts"]

    def listed(v):
        return ", ".join(v) if isinstance(v, list) and v else "(all)"

    rows = [
        [f"# {s['tool']}"],
        ["sequence", seq["name"]],
        ["fps", f"{seq['fps']:g}"],
        ["timeline duration", seq["duration_tc"]],
        ["source", Path(s["source_xml"]).name],
        ["state", s["state"]],
        ["encode", st["encode"]],
        ["speed", st["speed"]],
        ["source types kept", listed(st["types_kept"])],
        ["cuts", n["cuts"]],
        ["unique sources", n["unique_sources"]],
        # The one row that says whether this folder is the WHOLE timeline, and if not, what
        # took the rest away. Anyone reading the dataset later needs that before they need
        # anything else in here.
        ["completeness", s["completeness"]],
        ["written", n["ok"]],
        ["failed", n["failed"]],
        ["missing source", n["missing_sources"]],
        ["not decodable media", n["unsupported"]],
    ]
    # One row per warning. These are the places a clip's own label is knowingly
    # approximate — a flattened speed ramp above all — so they belong where the labels are,
    # not only in a JSON nobody opens.
    for w in s["warnings"]:
        rows.append(["warning", w])
    rows.append([])
    return rows


def write_sheet(tl: Timeline, outdir: Path, args) -> Path:
    """A short, readable sheet: what this export is, then which file came from where.

    manifest.csv already holds all of this among 52 columns, which is the wrong shape for
    opening in Sheets and eyeballing. This is the ten columns you actually look things up
    by — and it matters more now that the filename no longer spells out the full timecode.

    The export-info section on top is here because the facts that decide whether a dataset
    is usable — which types were kept, whether a selection was applied, which clips carry a
    flattened ramp — lived only in manifest.json, and the file people actually open is this
    one.
    """
    path = outdir / "clips.csv"
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerows(sheet_header_rows(tl, args))
        w.writerow([label for label, _ in SHEET_COLUMNS])
        for c in tl.cuts:
            row = []
            for label, attr in SHEET_COLUMNS:
                if attr is None:
                    row.append(Path(c.source_path).name)
                    continue
                v = getattr(c, attr)
                # Seconds are held at full precision in memory because the ffmpeg seek
                # needs it; a sheet meant for reading does not.
                row.append(round(v, 3) if isinstance(v, float) else v)
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
    doc = export_summary(tl, args)
    doc["markers"] = tl.markers
    doc["clips"] = [readable(c) for c in tl.cuts]
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2)
    return csv_path, json_path, write_sheet(tl, outdir, args)


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
    print(f"  {NAME} — Premiere timeline into individual clips")
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
    print(f"{NAME} {VERSION} — checking for an update ...")
    latest, err = fetch_latest()
    if err:
        # Said plainly rather than folded into "you are on the newest release". A failed
        # check is not good news and should not read like it.
        print(f"  Could not check: {err}")
        print(f"  Still on {VERSION}. Nothing was changed.")
        return 1
    info = newer_than_running(latest)
    if info is None:
        print(f"  You are on the newest release ({VERSION}).")
        return 0
    print(f"\n  {info['version']} is available.")
    if info.get("notes"):
        print(f"  {info['notes']}")
    print(f"  Files: {', '.join(info.get('files') or UPDATE_FILES)}")
    if input("\nInstall it now? [Y/n]: ").strip().lower().startswith("n"):
        print("  Left alone.")
        return 0
    detail: dict = {}
    ok, msg = apply_update(info, out=detail)
    print(f"\n  {msg}")
    if ok:
        print("  Restart the tool to run the new code."
              if detail.get("restart_needed", True)
              else "  Nothing to restart — the next run uses the new code.")
    return 0 if ok else 1


def main():
    # LINE-buffer stdout. Python block-buffers into a pipe, which is exactly what the
    # Premiere panel gives this process — so every progress line sat in an 8 KB buffer and
    # arrived in one burst when the run ENDED. Measured on the fixture: the first per-clip
    # line reached the reader at 0.63s, the same instant the process exited. On a real
    # timeline that is minutes of a panel showing "Starting…" with no way to tell a slow
    # encode from a hung one, which is precisely how it was reported.
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:      # noqa: BLE001 - older interpreter, or stdout replaced
        pass

    ap = argparse.ArgumentParser(
        description="Extract every cut of a Premiere Pro timeline from its FCP7 XML export.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    ap.add_argument("xml", type=Path, nargs="?", metavar="XML_OR_DUMP",
                    help="Final Cut Pro 7 XML exported from Premiere, or a .json "
                         "written by the auto bits panel "
                         "(omit it to be walked through step by step)")
    ap.add_argument("--pick", type=Path, metavar="FILE",
                    help="cut only the clips listed in FILE, one per line as "
                         "'TRACKTYPE TRACKINDEX TIMELINEIN' (e.g. 'video 1 0'). Written "
                         "by the Premiere panel when individual clips are unticked; a "
                         "long timeline is too many clips for the command line.")
    ap.add_argument("--panel", type=Path, metavar="DUMP.json",
                    help="overlay a panel dump on the XML: adds real speed-ramp "
                         "keyframes and repairs stale media paths, and cross-checks "
                         "every value both sources carry")
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
    ap.add_argument("--container", default="mp4",
                    help="output container: mp4 (default) or mov. The video is identical "
                         "in both — H.264 High, 4:2:0, no audio; only the wrapper "
                         "changes. Avoid mkv: its muxer declares one frame more than "
                         "the file holds, and an NLE reads the container's duration.")
    # --- export settings ------------------------------------------------------------
    ap.add_argument("--crf", type=float, metavar="N",
                    help="quality, 0-51, lower is bigger and better (default 1). "
                         "Fractional works — x264 takes a float, so 18.5 is a real "
                         "setting between 18 and 19. Do NOT use 0: x264 then emits "
                         "High 4:4:4 Predictive, which will not play on a Mac.")
    ap.add_argument("--bitrate", metavar="RATE",
                    help="target an average bitrate instead of a quality (e.g. 8M, "
                         "5000k). Makes file size predictable; ignores --crf.")
    ap.add_argument("--size-probe", dest="size_probe", action="store_true",
                    help="MEASURE the size estimate instead of modelling it, by encoding "
                         "about a second of each clip at the chosen settings. Accurate to "
                         "a few percent and much slower — it encodes. Without it the "
                         "estimate comes from metadata alone: median 1.0x and usually "
                         "within 1.5x, at no cost.")
    ap.add_argument("--scale", type=float, metavar="PCT",
                    help="output resolution as a percentage of each source's own "
                         "(default 100). 50 turns 1080x1920 into 540x960. Frame count "
                         "is untouched, so the cuts stay frame exact; only the pixels "
                         "are fewer. Both dimensions round down to even — H.264 4:2:0 "
                         "cannot encode an odd one.")
    ap.add_argument("--x264-preset", dest="x264_preset", metavar="NAME",
                    help="libx264 speed/compression preset (default veryfast). Only "
                         "changes how hard it works to compress; never moves a frame.")
    ap.add_argument("--fps", type=float, metavar="N",
                    help="force an output frame rate. ⚠️ This RESAMPLES — frames are "
                         "dropped or duplicated — so the clips no longer hold the frames "
                         "the timeline used. Every affected cut is recorded with "
                         "frame_exact=false.")
    ap.add_argument("--export-preset", metavar="NAME",
                    help="load saved export settings by name (see --list-presets)")
    ap.add_argument("--save-preset", metavar="NAME",
                    help="save the settings used by this run under NAME")
    ap.add_argument("--list-presets", action="store_true",
                    help="list saved export presets and exit")
    # Machine-readable variants, for the panel. Same reason as --check-update-json: it
    # cannot import this module, so it shells out and reads JSON, which keeps ONE
    # implementation of where presets live and what they contain.
    ap.add_argument("--list-presets-json", action="store_true",
                    help="print saved export presets as JSON and exit")
    ap.add_argument("--delete-preset", metavar="NAME", help="remove a saved preset")
    ap.add_argument("--presets-only", action="store_true",
                    help="manage presets and exit, without needing an XML")
    ap.add_argument("--speed", choices=["native", "timeline"], default="native",
                    help="for speed-ramped clips: 'native' keeps the real source frames "
                         "(default, best for training data); 'timeline' retimes the clip so "
                         "it matches what played on screen")
    ap.add_argument("--min-frames", type=int, default=1, help="skip cuts shorter than N frames")
    ap.add_argument("--ext", metavar="LIST",
                    help="only cut clips whose SOURCE file has one of these extensions, "
                         "comma separated: --ext mp4,mov (default: every type present)")
    ap.add_argument("--resume", action="store_true",
                    help="skip cuts whose output file already exists and is non-empty "
                         "(pick a long run back up where it stopped)")
    ap.add_argument("--update", action="store_true",
                    help="check for a newer release and install it (asks first)")
    # Machine-readable variants, for the Premiere panel. It cannot import this module,
    # so it shells out and reads JSON — which keeps one implementation of the update
    # logic rather than a second one in JavaScript.
    ap.add_argument("--check-update-json", action="store_true",
                    help="print available-update info as JSON and exit")
    ap.add_argument("--self-update-json", action="store_true",
                    help="install the newest release, printing JSON progress, and exit")
    ap.add_argument("--no-probe", action="store_true", help="skip ffprobe technical specs")
    ap.add_argument("--manifest-only", action="store_true", help="write manifest, cut nothing")
    ap.add_argument("--dry-run", action="store_true", help="show what would happen")
    ap.add_argument("--timeout", type=int, default=1800, help="per-clip ffmpeg timeout (s)")
    args = ap.parse_args()

    if args.list_presets_json:
        print(json.dumps({"presets": load_presets(), "path": str(presets_path())}))
        return

    if args.delete_preset:
        saved = load_presets()
        removed = saved.pop(args.delete_preset, None) is not None
        if removed:
            presets_path().parent.mkdir(parents=True, exist_ok=True)
            presets_path().write_text(json.dumps(saved, indent=2, sort_keys=True),
                                      encoding="utf-8")
        if args.presets_only:
            print(json.dumps({"ok": removed, "deleted": args.delete_preset,
                              "presets": saved}))
            return
        print(("removed" if removed else "no such preset:") + f" {args.delete_preset}")

    # Saving a preset does not need a timeline. Without this, making one from the panel
    # would mean reading a sequence first, which is a strange thing to have to do to
    # record four numbers.
    if args.presets_only:
        if args.save_preset:
            save_preset(args.save_preset, {
                "container": args.container,
                "crf": (None if parse_bitrate(args.bitrate or "") else args.crf),
                "bitrate": args.bitrate or None,
                "x264_preset": args.x264_preset,
                "fps": args.fps,
                "scale": args.scale,
            })
        print(json.dumps({"ok": True, "saved": args.save_preset,
                          "presets": load_presets()}))
        return

    if args.list_presets:
        saved = load_presets()
        if not saved:
            print(f"No export presets yet. Make one with --save-preset NAME.")
            print(f"They live in {presets_path()}")
            return
        print(f"{len(saved)} export preset(s) in {presets_path()}:\n")
        for nm in sorted(saved):
            s = saved[nm]
            bits = [f"{k} {v}" for k, v in s.items() if v not in (None, "")]
            print(f"  {nm:22} {', '.join(bits) or '(defaults)'}")
        return

    # A preset supplies only what was NOT given explicitly, so a flag on the command line
    # always wins over the stored value — otherwise a preset would silently override the
    # thing you just typed.
    if args.export_preset:
        saved = load_presets()
        if args.export_preset not in saved:
            sys.exit(f"error: no export preset named {args.export_preset!r}. "
                     f"Try --list-presets.")
        for k, v in saved[args.export_preset].items():
            if v in (None, ""):
                continue
            if k == "container" and args.container != "mp4":
                continue          # an explicit --container wins
            if getattr(args, k, None) in (None, ""):
                setattr(args, k, v)
        print(f"  export preset: {args.export_preset}")

    if args.update:
        return cli_update()

    if args.check_update_json:
        latest, err = fetch_latest()
        print(json.dumps({
            "current": VERSION,
            "update": newer_than_running(latest),
            # `checked` is the field a front end must look at first. Without it, no
            # network and up-to-date were the same reply, and the panel said "nothing
            # newer published" to someone who had not reached GitHub at all.
            "checked": err is None,
            "error": err,
            "panel_dir": str(cep_extensions_dir() / PANEL_ID),
            "bundled": is_bundled_install(),
            "source_checkout": (install_dir() / ".git").exists(),
        }))
        return

    if args.self_update_json:
        latest, err = fetch_latest()
        if err:
            print(json.dumps({"ok": False, "current": VERSION, "checked": False,
                              "message": err}))
            return
        info = newer_than_running(latest)
        if not info:
            print(json.dumps({"ok": False, "current": VERSION, "checked": True,
                              "message": f"already on {VERSION}; nothing newer published"}))
            return
        steps: list[str] = []
        detail: dict = {}
        ok, msg = apply_update(info, progress=steps.append, out=detail)
        print(json.dumps({"ok": ok, "current": VERSION, "checked": True,
                          "version": info.get("version"),
                          "message": msg, "steps": steps,
                          # True only when a PANEL file actually changed. A cut-logic-only
                          # release is live for the next export with no restart at all.
                          "restart_needed": detail.get("restart_needed", True),
                          "changed": detail.get("changed", [])}))
        return

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

    merge_notes: list[str] = []

    def show_sequences(rows):
        print(f"{len(rows)} sequence(s) in {args.xml.name}:\n")
        print(f"  {'#':>3}  {'name':40s} {'fps':>7s} {'duration':>12s} {'clips':>7s}")
        for s in rows:
            print(f"  {s['index']:>3}  {s['name'][:40]:40s} {s['fps']:>7g} "
                  f"{s['duration_tc']:>12s} {s['clip_count']:>7d}")

    # A panel dump describes exactly one sequence — the one that was open — so there is
    # nothing to list and nothing to pick.
    if DumpTimeline.looks_like_dump(args.xml):
        if args.list_sequences:
            tl = DumpTimeline(args.xml)
            print(f"1 sequence in {args.xml.name} (panel dumps hold only the open one):\n")
            print(f"  {'#':>3}  {'name':40s} {'fps':>7s} {'clips':>7s}")
            print(f"  {1:>3}  {tl.sequence_name[:40]:40s} {tl.sequence_fps:>7g} "
                  f"{len(tl.cuts):>7d}")
            return
        tl = DumpTimeline(args.xml)
        if args.panel:
            sys.exit("error: --panel overlays a dump onto an XML. The input here is "
                     "already a dump, so there is nothing to overlay it onto.")
    else:
        if args.list_sequences:
            show_sequences(Timeline.list_sequences(args.xml))
            return
        try:
            tl = Timeline(args.xml, remaps, args.sequence)
        except SequenceChoice as e:
            show_sequences(e.options)
            sys.exit("\nerror: this XML holds more than one sequence — pick one with "
                     "--sequence NAME or --sequence N (refusing to guess).")
        # Merged before filtering and naming, so a repaired path counts as present when
        # the missing-media report is built. The notes are held back and printed with
        # the rest of the summary rather than ahead of the header.
        #
        # Skipped entirely for an audio-only run: the dump's video clips would all
        # "match" cuts that the --tracks filter is about to discard, and reporting
        # 18 matches on a run that cuts one audio clip describes work nobody asked for.
        if args.panel and args.tracks != "audio":
            merge_notes = overlay_dump(tl, args.panel)
        elif args.panel:
            merge_notes = ["--tracks audio: the panel overlay adds nothing to audio "
                           "cuts, so it was skipped"]

    if args.tracks != "all":
        tl.cuts = [c for c in tl.cuts if c.track_type == args.tracks]
    tl.cuts = [c for c in tl.cuts if c.duration_frames >= args.min_frames]
    # How many cuts the timeline has, before --ext and --pick take any away. Recorded so
    # the sheet can say what was LEFT OUT: `picked_count` on its own is always equal to the
    # final count, which answered nothing.
    args.cuts_before_filters = len(tl.cuts)
    if args.ext:
        # Filtered BEFORE the indices are assigned, so a run limited to one type gets a
        # clean 01..N rather than gaps where the other types used to be.
        want = {e.strip().lower().lstrip(".") for e in args.ext.split(",") if e.strip()}
        args.types_kept = sorted(want)
        before = len(tl.cuts)
        tl.cuts = [c for c in tl.cuts
                   if Path(c.source_path).suffix.lower().lstrip(".") in want]
        print(f"  --ext {','.join(sorted(want))}: kept {len(tl.cuts)} of {before} cuts")
    if args.pick:
        # Also before indices are assigned, for the same reason --ext is: a run limited
        # to a handful of clips should number them 01..N, not leave gaps.
        #
        # Selectors are read from a FILE rather than the command line because a long
        # timeline is hundreds of clips and that is a lot of argv. One per line:
        #
        #     video 1 0          track type, track index, timeline in-point in frames
        #
        # Matching on (type, track, timeline-in) rather than an index, because an index
        # depends on what else was filtered and would silently select the wrong clip.
        want_keys = read_pick_file(args.pick)
        before = len(tl.cuts)
        tl.cuts = [c for c in tl.cuts if pick_key(c) in want_keys]
        args.picked = len(tl.cuts)
        print(f"  --pick: kept {len(tl.cuts)} of {before} cuts")
        missing = len(want_keys) - len(tl.cuts)
        if missing > 0:
            print(f"  !! {missing} selection(s) in {Path(args.pick).name} matched no clip "
                  f"— the timeline may have changed since it was written")

    for i, c in enumerate(tl.cuts, start=1):
        c.index = i
        if getattr(args, "fps", None):
            c.frame_exact = False
    # Named now, while the list is final — so --manifest-only and the sheet can show the
    # filenames without a single frame being encoded.
    assign_output_names(tl.cuts, args.container, tl.sequence_fps)

    print(f"{NAME} {VERSION}")
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
    print(f"  encode   : {describe_encode(args)}")
    for w in tl.warnings:
        print(f"  !! {w}")
    if getattr(args, "fps", None):
        # Loud, and not buried among the other warnings: this is the one setting that
        # changes what the files CONTAIN rather than how big they are.
        print(f"\n  !! OUTPUT RESAMPLED to {float(args.fps):g} fps. Frames are dropped or "
              f"duplicated to hit that rate, so these clips no longer hold the frames the "
              f"timeline used. Every cut is recorded with frame_exact=false.")
    for n in merge_notes:
        print(f"  ++ {n}")

    if not tl.cuts:
        sys.exit("No cuts found. Check --tracks, or confirm the XML contains clipitems.")

    if not args.no_probe:
        cache: dict = {}
        for c in tl.cuts:
            apply_probe(c, cache)
        # OPT-IN. Encoding a second of every clip is the accurate way to size an export and
        # it is the slow way: on the fixture a scan goes 0.21s -> 0.99s, and on media behind
        # Google Drive it is far worse. The default is estimate_bps(), which reads metadata,
        # costs nothing and lets a slider update live. --size-probe buys accuracy when the
        # export is big enough to be worth a wait.
        if getattr(args, "size_probe", False):
            probe_sizes(tl.cuts, args, tl.sequence_fps)
        # After probing, because the crf estimate scales the SOURCE's own bitrate. The
        # print lives here rather than in the header block above for the same reason —
        # up there the estimate is always zero, which is how the first version shipped.
        estimate_sizes(tl.cuts, args)
        est = sum(c.estimated_bytes for c in tl.cuts)
        if est:
            capped = parse_bitrate(getattr(args, "bitrate", None) or "")
            print(f"  size     : "
                  + (f"at most ~{human_bytes(est)} total (a ceiling — short clips "
                     f"usually use less)" if capped
                     else f"~{human_bytes(est)} total (estimate — depends on the "
                          f"footage)"))

    # Only a panel dump carries Premiere's interpreted rate, and only after probing can
    # it be compared with the file's own. A disagreement means the edit was built on a
    # different rate to the one ffmpeg will read, so those clips are named rather than
    # quietly cut — see Cut.interpreted_fps for why this is a warning, not a fix.
    reinterpreted = [c for c in tl.cuts
                     if c.interpreted_fps > 0 and c.source_fps > 0
                     and abs(c.interpreted_fps - c.source_fps) / c.interpreted_fps > 0.002]
    if reinterpreted:
        print(f"\n  !! {len(reinterpreted)} cut(s) use footage Premiere has "
              f"REINTERPRETED — the edit was built at a different rate to the file's:")
        for c in reinterpreted[:8]:
            print(f"     {c.clip_name}: Premiere {c.interpreted_fps:g} fps, "
                  f"file {c.source_fps:g} fps")
        print("     Their ranges come from Premiere and are right; their lengths are "
              "unverified.")

    # An .aep isn't "missing" — it's a Dynamic Link comp that was never a file ffmpeg
    # could read, and the fix is to render it, not to remap a path. Keep them apart.
    # Everything is encoded 8-bit 4:2:0 so the files play on a Mac. When a source carries
    # more than that — 10-bit, 4:2:2, 4:4:4 — real fidelity is being dropped, and that
    # should be said out loud rather than discovered later in the manifest.
    RICHER = {"yuv422p", "yuv444p", "yuv420p10le", "yuv422p10le", "yuv444p10le",
              "yuv420p12le", "yuv422p12le", "yuv444p12le", "gbrp", "gbrp10le"}
    downgraded = sorted({c.pix_fmt for c in tl.cuts
                         if c.media_kind == "video" and c.pix_fmt in RICHER})
    for fmt in downgraded:
        print(f"  !! source is {fmt}; output is 8-bit yuv420p — chroma and/or bit depth "
              f"are reduced. Required for the files to play outside ffmpeg.")

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

    if args.save_preset:
        save_preset(args.save_preset, {
            "container": args.container,
            "crf": (None if parse_bitrate(args.bitrate or "") else args.crf),
            "bitrate": args.bitrate or None,
            "x264_preset": args.x264_preset,
            "fps": args.fps,
            "scale": args.scale,
        })
        print(f"  saved export preset {args.save_preset!r} to {presets_path()}")

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
    # sys.exit(main()), not a bare main(): cli_update() returns 1 when the check failed and
    # that was being thrown away, so `--update` reported success to a caller no matter what
    # happened. None exits 0, which is every other path.
    sys.exit(main())
