# xmlcut

Extract every cut of a Premiere Pro timeline as an individual video file, straight from the
timeline's XML export. Built for assembling training datasets — every clip comes with a
manifest row describing exactly where it came from.

---

## 1. Get it, and set up once

**If you have access to the repo:**

```bash
git clone https://github.com/mill2nn/xmlcut.git ~/Desktop/xmlcut
```

**If someone sent you the zip:** unzip it anywhere, then double-click
**Open xmlcut GUI.command**. macOS blocks it the first time because it came from the
internet — right-click the file → Open → Open. Once only.

Either way, one prerequisite:

```bash
brew install ffmpeg          # xmlcut needs ffmpeg + ffprobe
python3 --version            # 3.8 or newer, already on macOS
```

**No Python packages at all** — both files import nothing outside the standard library, so
there is no virtualenv, no pip, and nothing to keep up to date.

To hand xmlcut to someone else, double-click **Make Shareable Zip.command**. It writes
`~/Desktop/xmlcut-v<version>.zip` with just the four files a user needs plus a START HERE
note, and deliberately leaves out the working notes and the real cut list.

## 2. Export the XML from Premiere

1. Open the project and click the **sequence** you want (Project panel or Timeline).
2. **File → Export → Final Cut Pro XML…**
3. Pick a location, name it, **Save**.
4. Premiere may show a summary of things it couldn't translate — that's normal, and
   harmless here, because xmlcut only reads cut points and source paths.

**Important:** Premiere writes *every sequence in the project* into that one XML, not just
the one you selected. xmlcut handles this — see below.

## 3. Run it

**In a window:**

```bash
python3 xmlcut_gui.py
```

It opens a page in your browser. **Drag the XML straight from Finder onto the page** — or use
Browse, which is a real macOS dialog. Then pick the sequence from the dropdown, pick an output
folder, press **Scan timeline**. Every control has a **?** next to it explaining what it does
and when it matters.
You get the full cut list — clip name, timeline in-point, speed, whether the timing came from
ticks, frame count, and any missing or unsupported media — before anything is encoded. Press
**Cut clips** when it looks right, and watch the rows update. Retimed clips are blue, missing
media red, After Effects comps amber.

Nothing extra to install: it serves a self-contained page on `127.0.0.1` using only the
standard library, and it calls the same code as the CLI, so the two cannot drift apart. Stop
it with **Quit server** on the page, or Ctrl-C in the terminal.

One quirk worth knowing about the drag-and-drop: a browser gives a dropped file's *contents*
but never its path, so the page uploads the XML to the local server, which writes a temp copy
and parses that. Cutting is unaffected — FCP7 XML records its media as absolute `file://`
paths, so a timeline parses the same from anywhere — but the output folder can't be guessed
from the XML's location, so it defaults to `~/Desktop/<name>_clips`. Change it before cutting
if you want it elsewhere. Folders can't be dropped at all; use Browse for those.

**In the terminal, the easy way — no flags to remember.** Type `python3 ` (with a space), drag
`xmlcut.py` in, and press return:

```bash
python3 xmlcut.py
```

It walks you through it: drag in the XML, pick the sequence, choose where clips go. It shows
the cut list and what's linked *before* touching any video, then asks whether to proceed.

**Or with flags, once you know what you want:**

```bash
# What sequences are in this file?
python3 xmlcut.py PROMO_MASTER_v7.xml --list-sequences

# See the cut list first, without touching any video
python3 xmlcut.py PROMO_MASTER_v7.xml -o ./clips --manifest-only

# Then cut for real
python3 xmlcut.py PROMO_MASTER_v7.xml -o ./clips --sequence "PROMO_MASTER_v7"
```

If the XML holds more than one sequence and you don't say which, xmlcut prints the list and
stops rather than guessing — cutting the wrong timeline silently is the worst failure mode
for a dataset. Select by name (`--sequence "Main Edit"`) or by number (`--sequence 2`).

Output:

```
clips/
  01_(00.00-02.00)_CAM_A.mp4
  02_(02.00-04.50)_CAM_B.mp4
  03_(04.50-06.00)_CAM_A.mp4
  ...
  clips.csv
  manifest.csv
  manifest.json
```

Filenames are **`index_(start-end)_originalfilename.ext`** — the order the clip appears in the
timeline, the span it occupies, and which source file it came from. Times are seconds and
hundredths, so `(02.00-04.50)` is a two-and-a-half second clip starting two seconds in. They
sort in timeline order, and the index widens past 99 clips so that stays true.

Why a dot inside each time and not the colon you would write by hand: Finder still treats `:`
in a filename as a path separator and shows it as `/`, which would turn `(00:00-00:02)` into
`(00/00-00/02)`. The dot also leaves the hyphen meaning one thing only — the gap between the
two ends of the range.

The source file's name rather than the Premiere clip name, because that is what you go looking
for when you want the original. Both are in `clips.csv` either way.

### clips.csv — the sheet

Six columns, made for opening in Sheets and looking things up:

| file | clip name | timeline in | timeline out | original name | original path |
|---|---|---|---|---|---|
| 01_(00.00-02.00)_CAM_A.mp4 | Wide_establishing | 00:00:00:00 | 00:00:02:00 | CAM_A.mp4 | /Volumes/…/CAM_A.mp4 |

`manifest.csv` holds all of this among its 46 columns, which is the wrong shape for reading.
This is the short version, and it matters more now that the filename no longer spells out the
full timecode. A scan writes it too, so you get the sheet without encoding anything.

---

## 4. When media has moved

The XML stores the path as it was at export time. If the drive was renamed or the footage
was moved, xmlcut tells you which paths are stale and stops short of guessing:

```
  !! 3 cut(s) reference media that isn't at the recorded path:
     /Volumes/OldDrive/Footage/CAM_A.mp4
```

Fix it with `--remap`, repeatable:

```bash
python3 xmlcut.py timeline.xml -o ./clips \
  --remap "/Volumes/OldDrive=/Volumes/SSD_2024" \
  --remap "/Users/bom/Movies=/Volumes/Archive/Movies"
```

---

## 5. One cut path, and why there is only one

Every cut is decoded and re-encoded. That is the only method that is frame exact, so it is
the only one available — there is no `--mode` flag to trade accuracy for speed.

Stream copy used to be an option. It was removed because of what it actually does: a copy can
only *start* on a keyframe, so on long-GOP H.264 it lands late and then overruns the
out-point to the next keyframe. Measured
on the v1.4 fixture (keyframe every 50 frames, so ~2 s), start frame and length, both modes:

| Cut | now (re-encode) | what copy did |
|---|---|---|
| Wide_establishing | frame 137, 48 frames — exact | frame 140, **88 frames — 83% too long** |
| Wide_reaction | frame 300, 36 frames — exact | frame 302, **89 frames — 147% too long** |
| Ramp_hot | frame 48, 72 frames — exact | frame 48, **123 frames — 71% too long** |
| Product_detail | frame 13, 72 frames — exact | frame 16, **88 frames — 22% too long** |

The start landed within a few frames; the **length** was the real damage. Every one of those
clips carried material from the following shot, which for a training dataset is worse than
being a few frames late.

And it bought almost nothing: 0.42 s against 0.91 s for the same 16 clips — while the
lossless re-encode that replaced both now runs the same 16 in 0.75 s. The speed copy was
reached for is available without giving up accuracy. See §5.1.

Remaining encode options: `--vcodec libx264`, `--container mp4`, `--no-audio`. Quality is not
an option — see §5.1.

### 5.1 Quality is fixed: lossless

There is no `--crf` and no `--preset`. Every clip is encoded with **x264 crf 0** — x264's
lossless mode — at the **veryfast** preset.

`crf 0` is lossless in the strict sense, not "visually lossless": every comparable clip in the
fixture decodes **bit-for-bit identical** to the same range decoded straight from the source.
For a dataset that is the point — an artefact introduced here is indistinguishable from one the
model is meant to learn from.

The cost is size, and it is smaller than you would guess, because dropping to `veryfast` pays
for part of it:

| | 16 fixture clips | Output size |
|---|---|---|
| lossless, veryfast **(now)** | 0.75 s | 16.2 MB |
| crf 16, medium (before) | 0.91 s | 5.4 MB |

Roughly **3x the bytes, and slightly faster**. The preset only changes how hard x264 works to
compress; it never moves a frame boundary, which is why dropping from medium to veryfast costs
nothing in accuracy — re-verified exact at ultrafast, veryfast, medium and slow.

**Pixel format is preserved.** "Lossless" would be a lie if a 10-bit 4:2:2 ProRes source were
flattened to `yuv420p` before the encoder saw it, so the source's format is kept wherever
libx264 can take it (4:2:0 / 4:2:2 / 4:4:4, 8- and 10-bit). `pix_fmt_out` records what was
actually used, and anything x264 cannot encode is reported as a lossy conversion rather than
done quietly. Stills are the deliberate exception: they arrive as RGB, which x264 cannot take,
so they go to `yuv444p` — graphics and logos are where 4:2:0 chroma subsampling shows most.

**Parallelism is fixed too.** There is no `--jobs`: it is `min(8, cores)`, and deliberately not
the core count. libx264 already parallelises across every core inside a single encode, so extra
concurrent encodes mostly add contention. Measured on 24 clips of 1080x1920 lossless, best of
two runs each:

| jobs | wall | vs fastest |
|---|---|---|
| 4 | 7.2 s | — |
| 7 | 7.7 s | 1.07x |
| 14 | 8.3 s | 1.15x |

More jobs is *slower*, and the whole spread is 19% — it was never a knob worth having. Four
would win on local media, but sources on Google Drive File Stream block on network reads, where
parallelism does pay, so the value sits in the middle and is capped to stay sane on an 8-core
laptop.

`--vcodec` remains if you want to try `h264_videotoolbox` (verified frame-exact here, though it
ignores the crf setting and was slower on 640x360 stand-ins).

---

## 6. The manifest

`manifest.csv` — one row per cut, 46 columns. `manifest.json` — the same plus sequence
info, marker list, and run settings. Columns worth knowing:

**Identity** — `index`, `clip_name`, `output_file`, `track_type`, `track_index`

**Where it sits in the edit** — `timeline_in_frames`, `timeline_out_frames`,
`timeline_in_tc`, `timeline_out_tc`

**Where it came from** — `source_path`, `source_in_frames`, `source_out_frames`,
`source_in_tc`, `source_out_tc`, `source_in_seconds`, `source_duration_seconds`,
`source_exists`, `file_id`, `timing_source` (`ticks` = exact, from Premiere;
`frames` = derived; `timeline` = a still)

**Length** — `duration_frames` / `duration_seconds` (length on the timeline),
`source_consumed_frames` (source material used, counted in the **source file's own frame
rate** — larger than the timeline length on a sped-up clip, and different from it on any
clip whose rate doesn't match the sequence). `source_consumed_frames` is exactly the number
of frames written in the default `--speed native` mode.

**Edit metadata** — `speed_percent` (200 = double speed), `enabled`, `transition_in`,
`transition_out` (e.g. `Cross Dissolve`), `filters`, `edge_in_transition`
(`head`/`tail` when Premiere buried that edge under a transition and xmlcut rebuilt it),
`media_kind` (`video` / `still` / `unsupported`), `pix_fmt_out` (what was encoded; differs from
`pix_fmt` only when x264 could not take the source format), `reversed`,
`speed_varies` / `speed_span`
(a keyframed ramp and its range), `nested_from` / `nested_trimmed` (which nested sequence a cut
came out of, and whether the nest's edges clipped it)

**Technical specs (ffprobe)** — `codec`, `width`, `height`, `source_fps`, `pix_fmt`,
`bitrate`, `audio_codec`, `audio_channels`, `audio_sample_rate`

**Run result** — `status`, `error`

| status | meaning |
|---|---|
| `ok` | clip written |
| `missing_source` | media isn't at the recorded path — fix with `--remap` |
| `unsupported` | source is an `.aep` / `.prproj` (Dynamic Link comp), not decodable media |
| `failed` | ffmpeg errored — see `error` |
| `no_audio` | an audio-track clip whose source has no audio stream |
| `skipped_existing` | `--resume` found the file already written |

Sequence markers land in `manifest.json` under `markers`, with name, comment, and timecode.

---

## 7. All options

```
  xml                    Final Cut Pro 7 XML exported from Premiere
                         (omit it entirely for step-by-step prompts)
  -o, --out DIR          output directory (default ./clips)
  --tracks {video,audio,all}    default: video
  --remap OLD=NEW        rewrite source paths (repeatable)
  --sequence NAME|N      which sequence to cut (name or 1-based index)
  --list-sequences       list sequences in the XML and exit
  --vcodec NAME          encoder (default libx264)
  --container EXT        output container (default mp4)
  --no-audio             drop audio from outputs
  --speed {native,timeline}   how to treat speed-ramped clips (default native)
  --min-frames N         skip cuts shorter than N frames
  --resume               skip cuts whose output file already exists and is non-empty
  --no-probe             skip ffprobe technical specs (faster)
  --manifest-only        write the manifest, cut nothing
  --dry-run              show what would happen
  --timeout SEC          per-clip ffmpeg timeout (default 1800)
```

---

## 8. How source timing is read (the subtle part)

Premiere records each clip's source range twice, and the two disagree:

- `<in>` / `<out>` — frame numbers, counted in the **sequence's** rate, not the source
  file's. On a **retimed** clip they describe the range *before* the speed change.
- `<pproTicksIn>` / `<pproTicksOut>` — the true source range in absolute seconds
  (1 second = 254,016,000,000 ticks), already correct for speed ramps.

xmlcut uses the tick values whenever present, and falls back to frame math otherwise. The
`timing_source` column records which was used. On a 292%-speed clip the frame values pointed
1.35 seconds away from the real in-point — a completely different shot.

## 9. Frame-rate conforming

Premiere counts a clip's `<in>`/`<out>` in the **sequence's** frame rate, not the source
file's. A 24 fps clip in a 30 fps timeline has its in-point expressed in 30ths of a second.
Reading those numbers as source frames stretches every seek and duration by 30/24 = 1.25x —
silently, with no error, producing clips that start late and run long.

xmlcut converts using the clipitem rate and seeks half a frame early (ffmpeg's `-ss` takes
the first frame at or after the seek time, which otherwise lands one frame late), then pins
the exact output length with `-frames:v`. Verified frame-exact on mixed 24/30 fps material.

## 10. Known limits

- **Speed changes**: `--speed native` (default) extracts every real source frame the clip
  consumed — a 300% clip occupying 40 timeline frames yields 120 frames of genuine motion,
  which is what you want for training data. `--speed timeline` retimes it instead, so the
  clip matches what played on screen. `speed_percent` and `source_consumed_frames` record
  both, so you can filter either way.
- **Stills** (`.png`, `.jpg`, `.psd`…) are looped to their on-screen duration rather than
  seeked into, because their XML in/out points are an arbitrary offset into a virtual
  24-hour clip. Odd pixel dimensions are padded to even so H.264 accepts them.
- **After Effects Dynamic Link** clips (`.aep`) can't be cut — nothing on disk to decode.
  They're reported as `unsupported`; render them to real media first, or ignore them.
- **Transitions** are flagged per clip, not baked in — each cut is the hard in/out, so a
  clip that dissolved on screen is extracted clean.
- **Reversed clips** are extracted backwards, as they played. `reversed` marks them in the
  manifest.
- **Nested sequences** are resolved: cuts inside a nest are recovered, trimmed to the part of
  the nest that's actually visible, and listed with `nested_from` / `nested_trimmed`. The nest's
  own speed and reverse compound with each clip's. If your timeline nests heavily, check the cut
  count against Premiere once — the source ranges are frame-verified, the parent-side placement
  is not.
- **Keyframed speed ramps** (Time Remapping with keyframes, rather than a flat Speed/Duration
  change) are flagged, not followed: `speed_varies` and `speed_span` record that the speed moves
  across the clip, and a warning is printed. The extracted *range* is still exact; only
  `--speed timeline` approximates, retiming uniformly instead of along the curve.
- **Third-party effects** don't survive the XML export; only the effect name is captured.
- **Multicam clips** export as their flattened result, which is usually what you want.
- **Audio** clips extract as `.m4a` via `--tracks audio`. Premiere mirrors linked audio onto
  its own track, so `--tracks all` gives you most video clips a second time as audio. A clip on
  an audio track whose source has no audio is reported as `no_audio` rather than failing.

---

## 11. Typical dataset workflow

```bash
# 1. Inspect: how many cuts, any offline media, what codecs
python3 xmlcut.py timeline.xml -o ./clips --manifest-only

# 2. Fix any path drift, then cut, dropping anything under 12 frames
python3 xmlcut.py timeline.xml -o ./clips \
  --remap "/Volumes/OldDrive=/Volumes/SSD" \
  --min-frames 12 --no-audio

# 3. manifest.csv is your label file — join it to the clip filenames
```
