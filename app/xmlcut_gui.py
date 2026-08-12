#!/usr/bin/env python3
"""xmlcut_gui - a local browser front end for xmlcut.

    python3 xmlcut_gui.py

Serves a single page on 127.0.0.1 and opens it in your browser. Nothing to install:
`http.server` and `webbrowser` are standard library, and the page has no external
assets. Closing the tab leaves the server running; Ctrl-C in the terminal, or the
Quit button on the page, stops it.

WHY A BROWSER AND NOT A REAL WINDOW: the first version of this was tkinter, which is
the obvious choice — until you run it on a Mac with only Apple's system Python. That
ships Tk 8.5.9, deprecated since 2010, and on current macOS it opens a correctly
sized window and then draws nothing at all. Window chrome comes from Cocoa, so the
title bar looks fine and the contents never appear. The fix would have been to
install Tk 8.6 via Homebrew, i.e. a ~200 MB dependency for a tool whose whole point
is that it has none. A local page renders identically everywhere and costs nothing.

File and folder pickers still use the real macOS dialogs — a browser can give you a
file's contents but never its path, and xmlcut needs paths. The page asks the server,
the server asks `osascript`, the native dialog appears. There is a plain text field
as a fallback wherever that isn't available.

Like the tkinter version, this imports xmlcut and calls Timeline / run_cut /
write_manifest directly. It holds no timing logic of its own and never shells out to
the CLI, so the two cannot drift apart.
"""

from __future__ import annotations

import argparse
import collections
import http.server
import json
import os
import secrets
import shutil
import socketserver
import subprocess
import sys
import threading
import traceback
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xmlcut  # noqa: E402  (path set above so the GUI works from any cwd)

TOKEN = secrets.token_urlsafe(16)   # every /api call must carry it; keeps other local
                                    # processes from driving ffmpeg on your behalf


def default_args(**over) -> argparse.Namespace:
    """The attribute bag xmlcut's run_cut / build_command / write_manifest expect.

    One place, so a new CLI flag is one line here rather than a hunt.
    """
    a = argparse.Namespace(
        tracks="video", vcodec="libx264", container="mp4",
        speed="native", min_frames=1, no_probe=False, manifest_only=False,
        dry_run=False, timeout=1800, resume=False,
    )
    for k, v in over.items():
        setattr(a, k, v)
    return a


# --------------------------------------------------------------------------
# job state — one scan/cut at a time, which is all a single user needs
# --------------------------------------------------------------------------

class Job:
    def __init__(self):
        self.lock = threading.Lock()
        self.timeline: xmlcut.Timeline | None = None
        self.args = default_args()
        self.outdir: Path | None = None
        self.log: list[str] = []
        self.progress = 0
        self.total = 0
        self.running = False
        self.finished = False
        self.cancel = threading.Event()
        self.manifest: str = ""
        # Source extensions the user has switched OFF. Held here rather than in the
        # browser so the table, the summary and the cut cannot disagree about what is
        # being cut — one source of truth, checked in exactly one place.
        self.excluded: set[str] = set()
        # Every cut the XML yielded, before the type filter. Kept so switching a type back
        # on can rebuild the list without re-reading and re-probing the whole timeline.
        self.all_cuts: list = []

    def say(self, msg: str):
        with self.lock:
            self.log.append(msg)

    def snapshot(self) -> dict:
        with self.lock:
            cuts = self.timeline.cuts if self.timeline else []
            return {
                # Grouped for the panel only: ready first, then whatever cannot be cut.
                # Sorted here rather than in the browser so the CLI, the manifest and the
                # filenames all keep pure timeline order — a clip's number must not change
                # because some other clip happens to be offline.
                "rows": sorted((row_for(c, self.args.speed) for c in cuts),
                               key=lambda r: (r["group"], r["index"])),
                # Counted from the full parse, not the filtered list — otherwise a type
                # disappears from the panel the instant you switch it off, and there is no
                # way to switch it back on.
                "types": type_counts(self.all_cuts, self.excluded),
                "log": list(self.log),
                "progress": self.progress,
                "total": self.total,
                "running": self.running,
                "finished": self.finished,
                "manifest": self.manifest,
                "update": UPDATE["info"],
                "update_applied": UPDATE["applied"],
                "update_busy": UPDATE["busy"],
                "update_stage": UPDATE["stage"],
                "update_ok": UPDATE["ok"],
                "summary": summarize(cuts, self.args.speed, self.excluded) if cuts else "",
            }


JOB = Job()

# Checked once per server start, off the request path so a slow or absent network never
# delays the page. None = not checked yet or nothing newer.
UPDATE: dict = {"info": None, "checked": False, "applied": "",
                "busy": False, "stage": "", "ok": None}


def start_update_check() -> None:
    def work():
        try:
            UPDATE["info"] = xmlcut.check_update()
        except Exception:
            UPDATE["info"] = None
        finally:
            UPDATE["checked"] = True
    threading.Thread(target=work, daemon=True).start()


def ext_of(c: xmlcut.Cut) -> str:
    return Path(c.source_path).suffix.lower().lstrip(".") or "(none)"


def row_for(c: xmlcut.Cut, speed: str) -> dict:
    frames = c.source_consumed_frames if speed == "native" else c.duration_frames
    # What makes this clip interesting, said in the table rather than buried in the log.
    notes = []
    if c.reversed:
        notes.append("reversed")
    if c.speed_varies:
        notes.append(f"ramp {c.speed_span}")
    if c.nested_from:
        notes.append(f"in {c.nested_from}")
    if c.nested_trimmed:
        notes.append(f"{c.nested_trimmed} trimmed")
    if c.track_type == "audio":
        notes.append("audio")
    ext = ext_of(c)
    cuttable = c.source_exists and c.media_kind != "unsupported"
    # Before a cut runs, every clip's status is still "pending". Showing that as "ready"
    # was a lie for the ones that can never be cut — and doubly confusing once they sit
    # under a divider saying they aren't. Say why here, from what the scan already knows.
    if c.status == "pending":
        # Unsupported is checked FIRST, matching run_cut: an .aep is a Dynamic Link comp
        # whether or not it happens to be on disk, and "missing source" would send you
        # hunting for a path when the fix is to render it out.
        status = ("AE comp — render it" if c.media_kind == "unsupported"
                  else "missing source" if not c.source_exists
                  else "ready")
    else:
        status = {"ok": "written", "skipped_existing": "already there",
                  "no_audio": "silent source"}.get(c.status, c.status)
    return {
        # 0 ready · 1 cannot be cut at all. A type switched off no longer appears here at
        # all — the filter runs at scan time now, so those cuts are not in the list.
        "group": 0 if cuttable else 1,
        "ext": ext,
        "index": c.index,
        "tc": c.timeline_in_tc,
        "clip": c.clip_name,
        "speed": f"{c.speed_percent:g}%" + (" ⏪" if c.reversed else ""),
        "timing": c.timing_source,
        "frames": frames,
        "status": status,
        "kind": ("bad" if c.status in ("failed", "missing_source") or not c.source_exists
                 else "warn" if c.media_kind == "unsupported" or c.status == "no_audio"
                 else "ok" if c.status in ("ok", "skipped_existing")
                 else "ramp" if c.speed_percent not in (0, 100) or c.reversed
                 else ""),
        "notes": " · ".join(notes),
        "error": c.error,
        "source": c.source_path,
    }


def apply_type_filter() -> None:
    """Rebuild the working cut list from the full parse, honouring the type selection.

    The filter belongs to the SCAN, not the cut: dropping a type has to re-index and
    re-name what remains, so the output is a clean 01..N instead of a run with gaps where
    the skipped clips used to be. Same as `--ext` on the CLI, which filters before the
    indices are handed out.
    """
    tl = JOB.timeline
    if tl is None:
        return
    tl.cuts = [c for c in JOB.all_cuts if ext_of(c) not in JOB.excluded]
    for i, c in enumerate(tl.cuts, start=1):
        c.index = i
    xmlcut.assign_output_names(tl.cuts, JOB.args.container, tl.sequence_fps)
    JOB.total = len(tl.cuts)


def type_counts(cuts, excluded: set[str]) -> list[dict]:
    """Every source type present, with how many cuts use it — built from the timeline
    rather than a fixed list, so it can only ever offer types you actually have."""
    tally = collections.Counter(ext_of(c) for c in cuts)
    return [{"ext": e, "count": n, "on": e not in excluded}
            for e, n in sorted(tally.items(), key=lambda kv: (-kv[1], kv[0]))]


def summarize(cuts, speed: str, excluded: set[str] = frozenset()) -> str:
    off = 0
    missing = sum(1 for c in cuts if not c.source_exists
                  and c.media_kind != "unsupported")
    unsupported = sum(1 for c in cuts if c.media_kind == "unsupported")
    ramped = sum(1 for c in cuts if c.speed_percent not in (0, 100))
    reversed_n = sum(1 for c in cuts if c.reversed)
    nested_n = sum(1 for c in cuts if c.nested_from)
    tally = collections.Counter(c.status for c in cuts)
    extra = (f" · {reversed_n} reversed" if reversed_n else "") + \
            (f" · {nested_n} nested" if nested_n else "")

    # Once anything has actually been cut, report the result rather than the
    # readiness — leaving "9 ready" up after a finished run reads as "nothing
    # happened".
    if tally["ok"] or tally["failed"] or tally["skipped_existing"]:
        done = (f"{tally['ok']} written" +
                (f" · {tally['skipped_existing']} already there"
                 if tally["skipped_existing"] else ""))
        return (f"{done} · {tally['failed']} failed · {missing} missing · "
                f"{unsupported} unsupported · {ramped} retimed{extra}")
    ready = sum(1 for c in cuts if c.source_exists and c.media_kind != "unsupported")
    return (f"{len(cuts)} cuts · {ready} ready · "
            + (f"{off} type-skipped · " if off else "")
            + f"{missing} missing · {unsupported} unsupported · {ramped} retimed{extra}")


# --------------------------------------------------------------------------
# native pickers via osascript — a browser cannot hand over a filesystem path
# --------------------------------------------------------------------------

def osa(script: str) -> str:
    if sys.platform != "darwin" or not shutil.which("osascript"):
        raise RuntimeError("Native dialogs need macOS — type the path in instead.")
    r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True,
                       timeout=300)
    out = (r.stdout or "").strip()
    if r.returncode != 0:
        err = (r.stderr or "").strip()
        if "User canceled" in err or "-128" in err:
            return ""                      # cancelled: not an error
        raise RuntimeError(err or "osascript failed")
    return out


def pick_file() -> str:
    return osa('POSIX path of (choose file with prompt '
               '"Choose the Final Cut Pro XML exported from Premiere")')


def pick_folder() -> str:
    return osa('POSIX path of (choose folder with prompt "Where should the clips go?")')


# --------------------------------------------------------------------------
# drag and drop
# --------------------------------------------------------------------------

MAX_DROP_BYTES = 64 * 1024 * 1024
_drop_dir: Path | None = None


def save_dropped(name: str, content: str) -> Path:
    """Persist a dragged-in XML and return its path on disk.

    A browser hands over a dropped file's CONTENTS but never its path — that is a
    deliberate privacy boundary, not something to work around — while xmlcut needs a
    path. So the page uploads the text and we write it to a temp file. That costs
    nothing in correctness: FCP7 XML records its media as absolute file:// URLs, so a
    timeline parses identically from any location. The original filename is kept so
    the manifest's source_xml still names the right export.
    """
    global _drop_dir
    if len(content.encode("utf-8", "ignore")) > MAX_DROP_BYTES:
        raise ValueError("That XML is over 64 MB — use Browse… instead.")
    safe = Path(name or "dropped.xml").name           # basename only: no traversal
    safe = "".join(ch for ch in safe if ch.isalnum() or ch in "._- ()") or "dropped.xml"
    if not safe.lower().endswith(".xml"):
        raise ValueError("That isn't an .xml file. Export with "
                         "File → Export → Final Cut Pro XML.")
    if _drop_dir is None:
        import tempfile
        _drop_dir = Path(tempfile.mkdtemp(prefix="xmlcut-drop-"))
    dest = _drop_dir / safe
    dest.write_text(content, encoding="utf-8")
    return dest


# --------------------------------------------------------------------------
# work
# --------------------------------------------------------------------------

def do_scan(payload: dict) -> dict:
    xml = Path(payload["xml"]).expanduser()
    if not xml.is_file():
        raise ValueError(f"Not a file: {xml}")

    args = default_args(
        speed=payload.get("speed", "native"),
        min_frames=max(1, int(payload.get("min_frames") or 1)),
        tracks=payload.get("tracks") or "video",
        resume=bool(payload.get("resume")),
    )
    remaps = []
    raw = (payload.get("remap") or "").strip()
    if raw and "=" in raw:
        old, new = raw.split("=", 1)
        remaps.append((old.strip(), new.strip()))

    JOB.__init__()                            # fresh state for a fresh scan, selection included
    JOB.args = args
    JOB.outdir = Path(payload["out"]).expanduser() if payload.get("out") else None
    JOB.say(f"Reading {xml.name} …")

    tl = xmlcut.Timeline(xml, remaps, payload.get("sequence") or None)
    tl.cuts = [c for c in tl.cuts if c.track_type == args.tracks]
    tl.cuts = [c for c in tl.cuts if c.duration_frames >= args.min_frames]
    for i, c in enumerate(tl.cuts, start=1):
        c.index = i
    xmlcut.assign_output_names(tl.cuts, args.container, tl.sequence_fps)

    JOB.say(f"  sequence : {tl.sequence_name} @ {tl.sequence_fps:g} fps")
    JOB.say(f"  cuts     : {len(tl.cuts)} across "
            f"{len({c.source_path for c in tl.cuts})} source files")
    nests = sorted({c.nested_from for c in tl.cuts if c.nested_from})
    if nests:
        n = sum(1 for c in tl.cuts if c.nested_from)
        JOB.say(f"  nested   : {n} cut(s) recovered from {', '.join(nests)}")
    rev = sum(1 for c in tl.cuts if c.reversed)
    if rev:
        JOB.say(f"  reversed : {rev} cut(s) play backwards")
    if tl.markers:
        JOB.say(f"  markers  : {len(tl.markers)}")
    for w in tl.warnings:
        JOB.say(f"!! {w}")

    cache: dict = {}
    for c in tl.cuts:
        xmlcut.apply_probe(c, cache)

    # An .aep was never a file ffmpeg could read; the fix is to render it, not to remap
    # a path, so it does not belong in the missing-media list.
    missing = sorted({c.source_path for c in tl.cuts
                      if not c.source_exists and c.media_kind != "unsupported"})
    if missing:
        JOB.say(f"!! {len(missing)} source path(s) not found:")
        for p in missing[:8]:
            JOB.say(f"     {p}")
        JOB.say("   Put OLD=NEW in Remap path and scan again.")
    unsupported = sum(1 for c in tl.cuts if c.media_kind == "unsupported")
    if unsupported:
        JOB.say(f"   {unsupported} cut(s) are After Effects / project files — "
                f"render them to real media first.")

    ready = sum(1 for c in tl.cuts if c.source_exists and c.media_kind != "unsupported")
    JOB.say(f"Scan done. {ready} clip(s) can be cut."
            if ready else "Nothing cuttable — fix the media paths first.")

    JOB.timeline = tl
    JOB.all_cuts = list(tl.cuts)
    JOB.total = len(tl.cuts)
    return JOB.snapshot()


def do_cut(payload: dict) -> dict:
    tl = JOB.timeline
    if not tl or not tl.cuts:
        raise ValueError("Scan the timeline first.")
    if JOB.running:
        raise ValueError("A cut is already running.")
    outdir = Path(payload.get("out") or (JOB.outdir or "")).expanduser()
    if not str(outdir):
        raise ValueError("Choose where the clips should go.")

    ready = [c for c in tl.cuts if c.source_exists and c.media_kind != "unsupported"]
    if not ready:
        raise ValueError("Nothing to cut — every clip is missing, unsupported, or "
                         "switched off in File types.")

    args = JOB.args
    JOB.outdir = outdir
    JOB.running, JOB.finished, JOB.progress = True, False, 0
    JOB.cancel.clear()

    def work():
        try:
            outdir.mkdir(parents=True, exist_ok=True)
            if JOB.excluded:
                JOB.say(f"  skipping types: {', '.join('.' + e for e in sorted(JOB.excluded))}")
            JOB.say(f"Cutting {len(ready)} clip(s), {xmlcut.JOBS} parallel job(s), "
                    f"speed={args.speed} …")
            with ThreadPoolExecutor(max_workers=xmlcut.JOBS) as ex:
                futures = []
                for c in tl.cuts:
                    if JOB.cancel.is_set():
                        break
                    futures.append(ex.submit(xmlcut.run_cut, c, outdir,
                                             args, tl.sequence_fps))
                for fut in futures:
                    c = fut.result()
                    with JOB.lock:
                        JOB.progress += 1
                    if c.error:
                        JOB.say(f"  {c.status.upper()} {c.clip_name}: "
                                f"{c.error.splitlines()[0][:150]}")
            args.types_excluded = sorted(JOB.excluded) or None
            csv_p, _, sheet_p = xmlcut.write_manifest(tl, outdir, args)
            tally = collections.Counter(c.status for c in tl.cuts)
            if JOB.cancel.is_set():
                JOB.say("Cancelled. The manifest describes what was written.")
            extra = "".join(
                f", {tally[k]} {label}" for k, label in
                (("skipped_existing", "already there"), ("no_audio", "silent source"))
                if tally[k])
            JOB.say(f"Done: {tally['ok']} written, {tally['failed']} failed, "
                    f"{tally['missing_source']} missing source, "
                    f"{tally['unsupported']} unsupported{extra}.")
            JOB.say(f"Manifest: {csv_p}")
            JOB.say(f"Sheet   : {sheet_p}  (file, clip name, timecode, original path)")
            with JOB.lock:
                JOB.manifest = str(csv_p)
        except Exception:
            JOB.say("!! " + traceback.format_exc(limit=3))
        finally:
            with JOB.lock:
                JOB.running, JOB.finished = False, True

    threading.Thread(target=work, daemon=True).start()
    return {"started": True}


# --------------------------------------------------------------------------
# http
# --------------------------------------------------------------------------

def sequences_payload(xml: Path, default_out: Path, dropped: str = "") -> dict:
    return {
        "xml": str(xml),
        "dropped": dropped,
        "sequences": xmlcut.Timeline.list_sequences(xml),
        "default_out": str(default_out),
    }


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = f"xmlcut/{xmlcut.VERSION}"

    def log_message(self, *a):            # keep the terminal for xmlcut's own output
        pass

    # -- helpers --
    def _send(self, code: int, body: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj).encode(), "application/json; charset=utf-8")

    def _authed(self) -> bool:
        from urllib.parse import urlparse, parse_qs
        q = parse_qs(urlparse(self.path).query)
        return q.get("t", [""])[0] == TOKEN

    # -- routes --
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            return self._send(200, PAGE.replace("__TOKEN__", TOKEN).encode(),
                              "text/html; charset=utf-8")
        if path == "/api/state":
            if not self._authed():
                return self._json({"error": "bad token"}, 403)
            return self._json(JOB.snapshot())
        self._json({"error": "not found"}, 404)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if not self._authed():
            return self._json({"error": "bad token"}, 403)
        length = int(self.headers.get("Content-Length") or 0)
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return self._json({"error": "bad JSON"}, 400)

        try:
            if path == "/api/pick-file":
                return self._json({"path": pick_file()})
            if path == "/api/pick-folder":
                return self._json({"path": pick_folder()})
            if path == "/api/sequences":
                xml = Path(payload.get("xml", "")).expanduser()
                if not xml.is_file():
                    return self._json({"error": f"Not a file: {xml}"}, 400)
                return self._json(sequences_payload(xml, xml.parent / "clips"))
            if path == "/api/dropped":
                xml = save_dropped(payload.get("name", ""), payload.get("content", ""))
                # The temp folder is no place to write a dataset, so default the output
                # next to something the user can find.
                out = Path.home() / "Desktop" / f"{xml.stem}_clips"
                return self._json(sequences_payload(xml, out, dropped=xml.name))
            if path == "/api/scan":
                return self._json(do_scan(payload))
            if path == "/api/cut":
                return self._json(do_cut(payload))
            if path == "/api/types":
                if JOB.running:
                    return self._json({"error": "a cut is running — cancel it first"}, 400)
                JOB.excluded = {str(e).lower().lstrip(".")
                                for e in (payload.get("excluded") or [])}
                apply_type_filter()
                return self._json(JOB.snapshot())
            if path == "/api/cancel":
                JOB.cancel.set()
                JOB.say("Cancelling — running ffmpeg jobs will finish, no new ones start.")
                return self._json({"ok": True})
            if path == "/api/reveal":
                p = payload.get("path") or str(JOB.outdir or "")
                if p and Path(p).exists() and sys.platform == "darwin":
                    subprocess.run(["open", p])
                return self._json({"ok": True})
            if path == "/api/update":
                info = UPDATE["info"]
                if not info:
                    return self._json({"error": "no update available"}, 400)
                if UPDATE["busy"]:
                    return self._json({"error": "already updating"}, 400)

                # Run it off the request thread and report through UPDATE["stage"], so the
                # page can show which file is downloading rather than hanging on one POST
                # for however long four files take on a slow connection.
                def work():
                    UPDATE["busy"], UPDATE["stage"] = True, "Starting"
                    try:
                        ok, msg = xmlcut.apply_update(
                            info, progress=lambda m: UPDATE.__setitem__("stage", m))
                        UPDATE["ok"], UPDATE["applied"] = ok, msg
                        if ok:
                            UPDATE["info"] = None
                    except Exception as e:
                        UPDATE["ok"], UPDATE["applied"] = False, f"update failed: {e}"
                    finally:
                        UPDATE["busy"], UPDATE["stage"] = False, ""
                threading.Thread(target=work, daemon=True).start()
                return self._json({"started": True})
            if path == "/api/quit":
                threading.Timer(0.3, lambda: os._exit(0)).start()
                return self._json({"ok": True})
        except SystemExit as e:
            # xmlcut raises SystemExit for user-facing errors (bad sequence, no
            # <sequence> node). It is not an Exception subclass, so catch it first.
            return self._json({"error": str(e) or "xmlcut stopped."}, 400)
        except (ValueError, RuntimeError) as e:
            return self._json({"error": str(e)}, 400)
        except xmlcut.SequenceChoice as e:
            return self._json({"error": "This XML holds several sequences — pick one.",
                               "sequences": e.options}, 400)
        except Exception:
            return self._json({"error": traceback.format_exc(limit=3)}, 500)

        self._json({"error": "not found"}, 404)


PAGE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>xmlcut</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{
    --bg:#fbfbfc; --panel:#fff; --line:#e3e4e8; --text:#1a1c20; --dim:#6b7280;
    --accent:#2563eb; --ok:#0a6b2a; --bad:#b00020; --warn:#a05a00; --ramp:#0b5cad;
    --row:#f6f7f9;
  }
  @media (prefers-color-scheme:dark){
    :root{ --bg:#16181d; --panel:#1d2027; --line:#2c3039; --text:#e6e8ec; --dim:#9aa1ad;
           --accent:#5b8cff; --ok:#4ec97b; --bad:#ff6b7f; --warn:#e0a33c; --ramp:#79b0ff;
           --row:#22262e; }
  }
  *{box-sizing:border-box}
  body{margin:0;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
       background:var(--bg);color:var(--text)}
  header{display:flex;align-items:baseline;gap:12px;padding:14px 18px;
         border-bottom:1px solid var(--line)}
  header h1{font-size:15px;margin:0;font-weight:650}
  header .v{color:var(--dim);font-size:12px}
  header .sp{flex:1}
  main{padding:16px 18px 24px;max-width:1180px}
  fieldset{border:1px solid var(--line);border-radius:10px;background:var(--panel);
           margin:0 0 14px;padding:12px 14px}
  legend{padding:0 6px;color:var(--dim);font-size:12px;font-weight:600;
         text-transform:uppercase;letter-spacing:.04em}
  .grid{display:grid;grid-template-columns:104px 1fr auto;gap:8px 10px;align-items:center}
  label{color:var(--dim);font-size:13px}
  input[type=text],select,input[type=number]{
    padding:7px 9px;border:1px solid var(--line);border-radius:7px;
    background:var(--bg);color:var(--text);font:inherit}
  /* width:100% belongs to the full-width Timeline fields only. Applied globally it
     stretched every Options control and wrapped that row onto three lines. */
  .grid input[type=text],.grid select{width:100%}
  input:focus,select:focus{outline:2px solid var(--accent);outline-offset:-1px}
  .opts{display:flex;flex-wrap:wrap;gap:12px;align-items:end}
  .opt{display:flex;flex-direction:column;gap:4px}
  .opt select{width:116px}
  .opt.narrow input,.opt.narrow select{width:76px}
  .opt.chk{flex-direction:row;align-items:center;gap:6px;padding-bottom:7px}
  .hint{color:var(--dim);font-size:12px;margin-top:10px}
  /* Narrow window: the 104px label column leaves the path fields too little room, so let
     the label take its own line and the field + Browse share the next one. */
  @media (max-width:620px){
    .grid{grid-template-columns:1fr auto}
    .grid>label{grid-column:1 / -1;margin-top:2px}
  }
  button{font:inherit;padding:7px 13px;border-radius:7px;border:1px solid var(--line);
         background:var(--panel);color:var(--text);cursor:pointer}
  button:hover:not(:disabled){border-color:var(--accent)}
  button:disabled{opacity:.45;cursor:default}
  button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
  .bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 10px}
  .bar button{white-space:nowrap}
  #summary{color:var(--dim);font-size:13px;margin:8px 0 12px}
  progress{width:100%;height:6px;appearance:none;border:0;background:var(--row);
           border-radius:3px;overflow:hidden;display:none}
  progress.on{display:block}
  progress::-webkit-progress-bar{background:var(--row)}
  progress::-webkit-progress-value{background:var(--accent)}
  .tablewrap{max-height:44vh;overflow:auto;border:1px solid var(--line);border-radius:10px}
  table{border-collapse:collapse;width:100%;font-size:13px}
  th{position:sticky;top:0;background:var(--panel);text-align:left;font-weight:600;
     color:var(--dim);padding:8px 10px;border-bottom:1px solid var(--line);font-size:12px}
  td{padding:6px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
  tr:nth-child(even) td{background:var(--row)}
  tr.divider td{background:var(--panel);color:var(--warn);font-size:12px;font-weight:600;
       white-space:normal;border-top:2px solid var(--line);padding:7px 10px}
  td.clip{white-space:normal;word-break:break-word}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .k-bad{color:var(--bad)} .k-warn{color:var(--warn)} .k-ok{color:var(--ok)}
  .k-ramp{color:var(--ramp)}
  pre#log{margin:12px 0 0;padding:10px 12px;background:var(--panel);
          border:1px solid var(--line);border-radius:10px;max-height:24vh;overflow:auto;
          font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap}
  .err{color:var(--bad)}

  /* Tooltips. The bubble lives on <body> and is position:fixed, deliberately: as an
     ::after on the trigger it was clipped away entirely inside .tablewrap's overflow,
     which silently killed all five table-header tooltips. Fixed positioning escapes every
     ancestor's overflow, and letting JS place it removes the guesswork of hand-tagging
     which tips need to open leftwards. */
  .tip{display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;
       border:1px solid var(--line);border-radius:50%;color:var(--dim);font-size:10px;
       font-weight:700;cursor:help;flex:none;user-select:none;
       vertical-align:middle;margin-left:5px}
  .tip:hover{border-color:var(--accent);color:var(--accent)}
  #tipbubble{position:fixed;left:0;top:0;max-width:320px;padding:9px 11px;border-radius:8px;
       background:#0f1116;color:#f2f4f7;font:400 12px/1.45 -apple-system,BlinkMacSystemFont,
       sans-serif;text-align:left;box-shadow:0 8px 28px rgba(0,0,0,.45);opacity:0;
       visibility:hidden;transition:opacity .1s;z-index:200;pointer-events:none;
       white-space:normal;text-transform:none;letter-spacing:0}
  #tipbubble.on{opacity:1;visibility:visible}
  /* Keyboard users need to see where they are; :focus-visible keeps it off mouse clicks. */
  button:focus-visible,.tip:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

  /* drag and drop target */
  #drop{position:relative;transition:border-color .12s,background .12s}
  #drop.over{border-color:var(--accent);background:var(--row)}
  #drop.over::after{content:"Drop the XML to load it";position:absolute;inset:0;
       display:flex;align-items:center;justify-content:center;border-radius:10px;
       background:var(--panel);color:var(--accent);font-weight:650;
       border:2px dashed var(--accent);z-index:5}
  .drophint{color:var(--dim);font-size:12px;margin-top:10px}
  .types{display:flex;flex-wrap:wrap;gap:8px 18px}
  .types label{display:flex;align-items:center;gap:6px;color:var(--text);font-size:13px;
       cursor:pointer}
  .types .n{color:var(--dim);font-variant-numeric:tabular-nums}
  .types label.off{color:var(--dim)}
  #updbar{display:flex;align-items:center;gap:12px;margin:0 0 14px;padding:10px 12px;
       border:1px solid var(--accent);border-radius:10px;background:var(--panel);
       font-size:13px}
  /* An author `display` beats the browser's [hidden]{display:none}, so setting
     display:flex above silently defeated the hidden attribute: the bar sat on screen
     empty, with an Update button that could only ever answer "no update available".
     Any element styled with display AND toggled by [hidden] needs this line. */
  #updbar[hidden]{display:none}
  #updbar span{flex:1}
  #updbar.done{border-color:var(--ok)}
  #updbar.bad{border-color:var(--bad)}
</style></head><body>
<header>
  <h1>xmlcut</h1><span class="v" id="ver"></span><span class="sp"></span>
  <button id="quit">Quit server</button>
</header>
<main>
  <div id="updbar" hidden><span id="updtext"></span>
    <button id="updbtn" class="primary">Update</button></div>
  <fieldset id="drop"><legend>Timeline</legend>
    <div class="grid">
      <label for="xml">FCP7 XML<span class="tip" data-tip="The file Premiere
        writes with File → Export → Final Cut Pro XML. Drag it anywhere onto this page, or
        use Browse. Premiere puts EVERY sequence in the project into this one file, which is
        why you pick one below."></span></label>
      <input type="text" id="xml" placeholder="drag an XML here, or Browse…">
      <button id="bxml">Browse…</button>

      <label for="seq">Sequence<span class="tip" data-tip="Which timeline to cut.
        Premiere exported them all, so check this is the one you meant — cutting the wrong
        sequence produces a full set of plausible, wrong clips with no error."></span></label>
      <select id="seq"><option value="">— load an XML first —</option></select>
      <span></span>

      <label for="out">Clips out<span class="tip" data-tip="Where the clip files
        and manifest.csv / manifest.json go. Created if missing. A clip with the same name is
        overwritten. Folders can't be dragged in — a browser never gets a folder's path — so
        use Browse or paste one (⌘⌥C copies a path in Finder)."></span></label>
      <input type="text" id="out" placeholder="…/clips">
      <button id="bout">Browse…</button>

      <label for="remap">Remap path<span class="tip" data-tip="Only needed if
        the footage moved since the export. Rewrites the start of every source path:
        /Volumes/OldDrive=/Volumes/SSD_2024. Scan again after setting it — the Status column
        will stop saying missing_source."></span></label>
      <input type="text" id="remap" placeholder="/Volumes/OldDrive=/Volumes/SSD">
      <span class="hint" style="margin:0">OLD=NEW</span>
    </div>
    <div class="drophint">Tip: drag the XML straight from Finder onto this page.</div>
  </fieldset>

  <fieldset><legend>Options</legend>
    <div class="opts">
      <div class="opt"><label for="speed">Speed<span class="tip" data-tip="How to
        treat clips you sped up or slowed down. native = keep every real source frame the clip
        used, so a 300% clip filling 30 timeline frames gives you 90 frames of genuine motion
        (best for training data). timeline = retime it to match what played on screen, so you
        get the 30."></span></label>
        <select id="speed"><option>native</option><option>timeline</option></select></div>
      <div class="opt narrow"><label for="minf">Min frames<span class="tip"
        data-tip="Skip any cut shorter than this many frames. Handy for dropping 1–2 frame flash
        cuts and stray trims you don't want in a dataset. 1 keeps everything."></span></label>
        <input type="number" id="minf" value="1" min="1"></div>
      <div class="opt"><label for="tracks">Tracks<span class="tip" data-tip="video
        is what you almost always want. audio extracts the audio-track clips as .m4a files
        instead. all does both — but Premiere mirrors linked audio onto its own track, so expect
        a duplicate of most video clips."></span></label>
        <select id="tracks"><option>video</option><option>audio</option>
        <option>all</option></select></div>
      <div class="opt chk"><input type="checkbox" id="resume">
        <label for="resume">Resume<span class="tip" data-tip="Skip any clip
        whose file is already in the output folder and non-empty. Use it to pick a long run back
        up after a cancel or a crash instead of re-encoding everything."></span></label></div>
    </div>
    <div class="hint">Hover any <b>?</b> for what it does. Encoding is fixed and not a
      choice: <b>x264 crf 0</b>, verified bit-exact against the decoded source, at the
      <b>veryfast</b> preset. Stream copy was removed because it can only start on a keyframe,
      which overran measured cut lengths by 22–147%.</div>
  </fieldset>

  <fieldset id="typesbox" hidden><legend>File types<span class="tip" data-tip="Every source
    type your timeline actually uses, with how many cuts come from each. Switch one off and
    those clips drop out of the cut — the count, the table and the Cut button all follow
    immediately. Built from the timeline, so it never offers a type you do not have."></span>
    </legend>
    <div id="types" class="types"></div>
  </fieldset>

  <div class="bar">
    <button class="primary" id="scan" data-tip="Reads the XML and probes every source file,
      then shows the cut list below. Writes nothing and encodes nothing — always safe to
      press.">Scan timeline</button>
    <button id="cut" disabled data-tip="Runs ffmpeg over the list above and writes the clips
      plus the manifest. Enabled once a scan has found something cuttable.">Cut clips</button>
    <button id="cancel" disabled data-tip="Stops starting new clips. ffmpeg jobs already
      running finish, and the manifest still describes exactly what got written.">Cancel</button>
    <button id="reveal" disabled data-tip="Reveals the output folder in Finder.">Open output
      folder</button>
  </div>
  <progress id="prog" value="0" max="1"></progress>
  <div id="summary">No timeline loaded.</div>

  <div class="tablewrap"><table>
    <thead><tr><th>#</th><th>Timeline in</th><th>Clip</th>
      <th>Speed<span class="tip" data-tip="Premiere's speed percentage for this clip.
        100% is untouched; above is sped up, below is slowed down."></span></th>
      <th>Timing<span class="tip" data-tip="Where the source range came from.
        ticks = Premiere's own pproTicks values, exact even on a retimed clip. frames = derived
        from in/out as a fallback when the XML has no ticks. ticks is what you want to see."></span></th>
      <th class="num">Frames<span class="tip" data-tip="How many frames this clip
        will contain. In native speed mode that's the source frames it consumed; in timeline mode
        it's the frames it occupies on the timeline."></span></th>
      <th>Status<span class="tip" data-tip="ready = not cut yet · written = done ·
        already there = skipped by Resume · missing_source = the media isn't at the recorded path,
        fix with Remap · unsupported = an After Effects comp, render it out first · silent source =
        an audio-track clip whose media has no audio · failed = ffmpeg errored, see the log."></span></th>
      <th>Notes<span class="tip" data-tip="Anything unusual about this clip:
        reversed, a keyframed ramp (whose retime is approximated), which nested sequence it came
        out of, and whether the nest's edges trimmed it."></span></th>
      </tr></thead>
    <tbody id="rows"><tr><td colspan="8" style="color:var(--dim)">
      Pick an XML export, then Scan. Nothing is encoded until you press Cut.
    </td></tr></tbody>
  </table></div>
  <pre id="log"></pre>
</main>
<script>
const T = "__TOKEN__";
const $ = id => document.getElementById(id);
let polling = null;

// ---- tooltips -----------------------------------------------------------------
// One bubble, appended to <body>, positioned by hand. Two reasons it is done this way
// rather than with a CSS ::after: an ::after inside .tablewrap gets clipped by that
// element's overflow and never appears at all, and placing it in JS means it flips away
// from the viewport edges automatically instead of needing a hand-applied class.
const bubble = document.createElement("div");
bubble.id = "tipbubble";
document.body.appendChild(bubble);
let tipFor = null;

function showTip(el){
  const text = el && el.dataset && el.dataset.tip;
  if(!text) return;
  bubble.textContent = text.replace(/\s+/g, " ").trim();
  bubble.classList.remove("on");
  bubble.style.left = "0px"; bubble.style.top = "0px";
  const r = el.getBoundingClientRect();
  const b = bubble.getBoundingClientRect();
  const M = 8;
  let left = r.left + r.width / 2 - b.width / 2;
  left = Math.max(M, Math.min(left, innerWidth - b.width - M));
  let top = r.bottom + M;
  if(top + b.height > innerHeight - M) top = r.top - b.height - M;   // flip above
  bubble.style.left = left + "px";
  bubble.style.top = Math.max(M, top) + "px";
  bubble.classList.add("on");
  tipFor = el;
}
function hideTip(){ bubble.classList.remove("on"); tipFor = null; }

document.addEventListener("mouseover", e => {
  const t = e.target.closest("[data-tip]");
  if(t){ if(t !== tipFor) showTip(t); }
  else if(tipFor) hideTip();
});
// Keyboard parity without 17 extra tab stops: the tips are not focusable, so focusing a
// field shows the tip that belongs to its <label> instead.
document.addEventListener("focusin", e => {
  const el = e.target;
  if(el.dataset && el.dataset.tip){ showTip(el); return; }
  const own = el.id && document.querySelector(`label[for="${el.id}"] .tip`);
  if(own) showTip(own); else hideTip();
});
document.addEventListener("focusout", hideTip);
document.addEventListener("scroll", hideTip, true);
document.addEventListener("keydown", e => { if(e.key === "Escape") hideTip(); });

async function api(path, body){
  const r = await fetch(path + "?t=" + T, {
    method: body === undefined ? "GET" : "POST",
    headers: {"Content-Type":"application/json"},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({error:"bad response"}));
  if(!r.ok || j.error) throw new Error(j.error || ("HTTP " + r.status));
  return j;
}
function say(msg, isErr){
  const el = $("log");
  el.insertAdjacentHTML("beforeend",
    (isErr ? '<span class="err">' + esc(msg) + "</span>" : esc(msg)) + "\n");
  el.scrollTop = el.scrollHeight;
}
function esc(s){ return String(s).replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }
function opts(){
  return { xml:$("xml").value.trim(), out:$("out").value.trim(),
    sequence:$("seq").value, remap:$("remap").value.trim(), speed:$("speed").value,
    min_frames:+$("minf").value,
    tracks:$("tracks").value,
    resume:$("resume").checked };
}
function render(st){
  $("summary").textContent = st.summary || "No timeline loaded.";
  const blank = st.log.length
    ? "No cuts matched — check the sequence and Min frames."
    : "Pick an XML export, then Scan. Nothing is encoded until you press Cut.";
  let lastGroup = 0;
  const DIVIDERS = {
    1: "Not cuttable — fix the paths, or render the comps out of After Effects first",
  };
  $("rows").innerHTML = st.rows.length ? st.rows.map(r => {
    const head = (r.group > lastGroup && DIVIDERS[r.group])
      ? `<tr class="divider"><td colspan="8">${DIVIDERS[r.group]}</td></tr>` : "";
    lastGroup = r.group;
    return head + `<tr>
      <td class="num">${r.index}</td><td>${esc(r.tc)}</td>
      <td class="clip ${r.kind ? "k-" + r.kind : ""}">${esc(r.clip)}</td>
      <td>${esc(r.speed)}</td><td>${esc(r.timing)}</td>
      <td class="num">${r.frames}</td>
      <td class="${r.kind ? "k-" + r.kind : ""}">${esc(r.status)}</td>
      <td class="clip" style="color:var(--dim)">${esc(r.notes || "")}</td></tr>`;
  }).join("")
    : `<tr><td colspan="8" style="color:var(--dim)">${blank}</td></tr>`;
  $("log").innerHTML = st.log.map(l =>
    l.startsWith("!!") ? '<span class="err">' + esc(l) + "</span>" : esc(l)).join("\n");
  $("log").scrollTop = $("log").scrollHeight;
  const p = $("prog");
  p.max = Math.max(1, st.total); p.value = st.progress;
  p.classList.toggle("on", st.running || (st.finished && st.progress > 0));
  $("cut").disabled = st.running || !st.rows.length;
  $("scan").disabled = st.running;
  $("cancel").disabled = !st.running;
  $("reveal").disabled = !st.manifest && !st.finished;
  renderTypes(st);
  renderUpdate(st);
}
async function poll(){
  try{
    const st = await api("/api/state");
    render(st);
    if(!st.running && !st.update_busy && st.finished){
      clearInterval(polling); polling = null;
    }
  }catch(e){ say("!! " + e.message, true); clearInterval(polling); polling = null; }
}
$("bxml").onclick = async () => {
  try{
    const {path} = await api("/api/pick-file", {});
    if(path){ $("xml").value = path; await loadSeqs(); }
  }catch(e){ say("!! " + e.message, true); }
};
$("bout").onclick = async () => {
  try{ const {path} = await api("/api/pick-folder", {}); if(path) $("out").value = path; }
  catch(e){ say("!! " + e.message, true); }
};
function applySeqs(j){
  $("xml").value = j.xml;
  $("seq").innerHTML = j.sequences.map(s =>
    `<option value="${s.index}">${s.index}. ${esc(s.name)} — ${s.fps} fps, ` +
    `${esc(s.duration_tc)}, ${s.clip_count} clips</option>`).join("");
  if(!$("out").value) $("out").value = j.default_out;
  if(j.dropped) say("Loaded dropped file " + j.dropped +
                    " — clips will go to " + $("out").value);
  say(j.sequences.length + " sequence(s) in this file" +
      (j.sequences.length > 1
        ? " — pick the right one; Premiere exports them all." : ""));
}
async function loadSeqs(){
  try{ applySeqs(await api("/api/sequences", {xml: $("xml").value.trim()})); }
  catch(e){ say("!! " + e.message, true); }
}
$("xml").onchange = () => { if($("xml").value.trim()) loadSeqs(); };

// --- drag and drop ------------------------------------------------------------
// A drop gives us the file's text, never its path (browsers don't expose paths), so
// we hand the text to the local server and it writes a temp copy to parse. Listening
// on the whole document means a drop anywhere on the page works, not only on the box.
const zone = $("drop");
let dragDepth = 0;
function hasFile(e){
  return [...(e.dataTransfer?.types || [])].includes("Files");
}
document.addEventListener("dragenter", e => {
  if(!hasFile(e)) return;
  e.preventDefault(); dragDepth++; zone.classList.add("over");
});
document.addEventListener("dragover", e => { if(hasFile(e)) e.preventDefault(); });
document.addEventListener("dragleave", e => {
  if(!hasFile(e)) return;
  if(--dragDepth <= 0){ dragDepth = 0; zone.classList.remove("over"); }
});
document.addEventListener("drop", async e => {
  if(!hasFile(e)) return;
  e.preventDefault(); dragDepth = 0; zone.classList.remove("over");
  const f = e.dataTransfer.files[0];
  if(!f) return;
  if(!/\.xml$/i.test(f.name)){
    say(`!! ${f.name} isn't an .xml — export with File → Export → Final Cut Pro XML.`, true);
    return;
  }
  try{
    say(`Reading dropped ${f.name} (${(f.size/1024).toFixed(0)} KB) …`);
    applySeqs(await api("/api/dropped", {name: f.name, content: await f.text()}));
  }catch(err){ say("!! " + err.message, true); }
});
$("scan").onclick = async () => {
  $("scan").disabled = true;
  try{ render(await api("/api/scan", opts())); }
  catch(e){ say("!! " + e.message, true); }
  finally{ $("scan").disabled = false; }
};
$("cut").onclick = async () => {
  try{
    await api("/api/cut", opts());
    if(!polling) polling = setInterval(poll, 500);
    poll();
  }catch(e){ say("!! " + e.message, true); }
};
$("cancel").onclick = () => api("/api/cancel", {}).catch(e => say("!! " + e.message, true));
$("reveal").onclick = () => api("/api/reveal", {path: $("out").value.trim()})
                              .catch(e => say("!! " + e.message, true));
let excluded = new Set();
function renderTypes(st){
  const box = $("typesbox");
  if(!st.types || !st.types.length){ box.hidden = true; return; }
  box.hidden = false;
  $("types").innerHTML = st.types.map(t => `<label class="${t.on ? "" : "off"}">
      <input type="checkbox" data-ext="${esc(t.ext)}"${t.on ? " checked" : ""}>
      .${esc(t.ext)} <span class="n">${t.count}</span></label>`).join("");
  $("types").querySelectorAll("input").forEach(cb => {
    cb.onchange = async () => {
      if(cb.checked) excluded.delete(cb.dataset.ext); else excluded.add(cb.dataset.ext);
      try{ render(await api("/api/types", {excluded: [...excluded]})); }
      catch(e){ say("!! " + e.message, true); }
    };
  });
}
let lastUpdate = null;
function renderUpdate(st){
  const bar = $("updbar"), btn = $("updbtn");
  lastUpdate = st.update || null;
  // Mid-update: the button IS the status line. Nothing else on the page moves, so a
  // static "Update" label for the length of four downloads reads as a hang.
  if(st.update_busy){
    bar.hidden = false; bar.className = "";
    $("updtext").innerHTML = "Updating to <b>" +
      esc((st.update && st.update.version) || "") + "</b>";
    btn.hidden = false; btn.disabled = true;
    btn.textContent = st.update_stage || "Working …";
    if(!polling) polling = setInterval(poll, 500);
    return;
  }
  if(st.update_applied){
    bar.hidden = false;
    bar.className = st.update_ok ? "done" : "bad";
    $("updtext").textContent = st.update_applied;
    btn.disabled = false;
    if(st.update_ok){
      // It succeeded but this process still holds the old code in memory, so the only
      // useful next action is to stop the server and reopen it.
      btn.hidden = false; btn.textContent = "Quit server"; btn.onclick = quitServer;
    }else{
      btn.hidden = false; btn.textContent = "Retry"; btn.onclick = startUpdate;
    }
    return;
  }
  if(!st.update){ bar.hidden = true; return; }
  bar.hidden = false; bar.className = "";
  btn.hidden = false; btn.disabled = false;
  btn.textContent = "Update"; btn.onclick = startUpdate;
  $("updtext").innerHTML = "<b>" + esc(st.update.version) + "</b> is available" +
    (st.update.notes ? " — " + esc(st.update.notes) : "");
}
async function startUpdate(){
  if(!lastUpdate){ say("Already on the newest version."); return; }
  $("updbtn").disabled = true;
  $("updbtn").textContent = "Starting …";
  try{
    await api("/api/update", {});
    if(!polling) polling = setInterval(poll, 500);
    poll();
  }catch(e){ say("!! " + e.message, true); $("updbtn").disabled = false; poll(); }
}
async function quitServer(){
  await api("/api/quit", {}).catch(() => {});
  document.body.innerHTML =
    '<main><p>Server stopped. Reopen xmlcut to use the new version.</p></main>';
}
$("quit").onclick = quitServer;
poll();
</script></body></html>
"""


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    missing = [t for t in ("ffmpeg", "ffprobe") if not shutil.which(t)]
    if missing:
        print(f"error: {', '.join(missing)} not found on PATH "
              f"(macOS: brew install ffmpeg).")
        return 1

    start_update_check()
    srv = Server(("127.0.0.1", 0), Handler)
    port = srv.server_address[1]
    url = f"http://127.0.0.1:{port}/?t={TOKEN}"
    print(f"xmlcut {xmlcut.VERSION} GUI running at\n  {url}\n"
          f"Opening your browser. Ctrl-C here (or Quit server on the page) to stop.")
    threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
