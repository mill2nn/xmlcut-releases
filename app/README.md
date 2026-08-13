# auto bits

Extract every cut of a Premiere Pro timeline as an individual video file, straight from the
timeline's XML export. Built for assembling training datasets — every clip comes with a
manifest row describing exactly where it came from.

In Premiere it appears as **Window → Extensions → auto bits**.

> The engine file is still called `xmlcut.py`, the extension's bundle ID is still
> `com.bom.xmlcutreader`, and the release channel is still `xmlcut-releases`. Those are
> identifiers, not names: renaming them would break every installed copy's updater, leave a
> duplicate panel in Premiere's Extensions menu, or drop saved settings. Where you see
> `xmlcut` below, it is a filename or an identifier.

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
`~/Desktop/xmlcut-v<version>.zip` holding the tool, the browser GUI, the Premiere panel and
the diagnostics — the same set the update channel ships, read from one list in the source so
the two cannot disagree — plus a START HERE note. It deliberately leaves out the working
notes and the real cut list.

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

### It updates itself

When a new version is published you get a bar at the top of the page — *"2.0 is available"* —
and one **Update** button. No re-downloading, no new zip. From the terminal instead:

```bash
python3 xmlcut.py --update
```

The button is the status line while it works — *Downloading xmlcut_gui.py (2/4)*, *Backing up
the current version*, *Installing 2.4* — and turns into **Quit server** when it's done, because
the running process still holds the old code in memory and restarting is the only thing left to
do.

How it behaves, because an updater you can't trust is worse than none:

- **Nothing on disk is touched until every file has downloaded and been checked.** Python
  files must compile, and the new `xmlcut.py` must report the version `latest.json` promised.
  A failure at any point leaves you exactly where you were.
- **The version you were on is kept** in `.backup/`, so you can put it back by hand. A
  failure part-way through puts the old files back *and* removes any file the update had
  just created, so a rolled-back update leaves nothing behind.
- **A source checkout refuses to self-update** — if there's a `.git` beside `xmlcut.py` it
  tells you to `git pull` instead, rather than overwriting work in progress. This applies to
  the folder copy. The panel's bundled copy has no `.git` beside it and does update itself;
  it never touches your folder (see §10.2).
- **A check that failed says so.** "Could not reach the release channel" and "you are on the
  newest release" are different messages, because they are different facts — the panel used
  to report the first as the second to anyone without a network.
- Restart the tool afterwards; a running Python process keeps the old code in memory.

⚠️ Worth being explicit: anyone who can push to the releases repo can run code on every
machine running xmlcut. That is true of every auto-updater, and it is why the repo, owner and
branch are pinned constants in the source rather than anything configurable.

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

Filenames are **`index_(in-out)_originalfilename.ext`**. The index is the order the clip
appears in the timeline; the range is **where inside that source file the clip came from**, in
seconds and hundredths. So `03_(12.50-14.00)_CAM_A.mp4` is the third cut, taken from 12.5 s to
14.0 s of `CAM_A.mp4`.

The **source** range rather than the timeline position, because the filename already names the
source file — the numbers beside it should tell you where to look in that file. Timeline
position is in `clips.csv` and the manifest, where it belongs. (A still has no meaningful
source range — its in/out are an arbitrary offset into a virtual 24-hour clip — so it falls
back to its timeline position.)

Why a dot inside each time and not the colon you would write by hand: Finder still treats `:`
in a filename as a path separator and shows it as `/`, which would turn `(12:50-14:00)` into
`(12/50-14/00)`. The dot also leaves the hyphen meaning one thing only — the gap between the
two ends of the range.

Files sort in timeline order, and the index widens past 99 clips so that stays true.

### Choosing which file types to cut

A timeline usually mixes types you want and types you don't — generated `.mp4`, a `.png`
logo, an `.aep` comp. The GUI shows a **File types** panel after a scan, listing every type
your timeline actually uses with a count:

```
 ☑ .mp4 16      ☑ .aep 1      ☑ .png 1
```

Switch one off and those clips leave the scan entirely — the list, the count and the numbering
all rebuild, so the output is a clean run of numbers rather than one with gaps where the
skipped clips used to be. The panel keeps offering the type so you can switch it back on; it
counts from the full timeline, not the filtered list.

This happens at **scan** time, not cut time, which is what makes the renumbering possible —
the same point at which `--ext` filters on the CLI.

From the terminal it's `--ext`:

```bash
python3 xmlcut.py timeline.xml -o ./clips --sequence 1 --ext mp4,mov
```

Either way the filter is **recorded in the manifest** (`types_kept` / `types_excluded`). A
dataset with every still removed is a different dataset, and nothing else in the output would
say so.

### clips.csv — the sheet

Two parts: **what this export is**, then **one row per clip**. Made for opening in Sheets.

The section on top describes the export itself, and it is there because the facts that decide
whether a set of clips is usable as data — which source types were kept, whether clips were
chosen by hand, which ones carry a flattened speed ramp — used to live only in
`manifest.json`, and this is the file people actually open:

```
# xmlcut 3.10
sequence,PROMO_MASTER_v7
fps,30
timeline duration,00:00:31:28
source,PROMO_MASTER_v7.xml
state,cut
encode,"libx264 crf 1 profile high, preset veryfast"
speed,native
source types kept,(all)
cuts,19
unique sources,6
completeness,all 19 cuts on the timeline
written,17
failed,0
missing source,1
not decodable media,1
warning,"Ramp_keyframed: keyframed speed ramp (100–220%) treated as a constant 150% — …"
```

**`completeness` is the row to read first.** It says whether the folder is the whole timeline
and, if not, what took the rest away:

```
completeness,16 of 19 cuts on the timeline — limited to source types mp4; clips chosen by hand (pick.txt)
```

A folder of clips cannot say that about itself, and a dataset missing every still is a
different dataset. `state` distinguishes a real cut from a cut list written by a scan, where
`written` is legitimately 0.

Then a blank line, then the table — ten columns:

| file | clip name | timeline in | timeline out | speed % | cut length s | frames | timeline length s | original name | original path |
|---|---|---|---|---|---|---|---|---|---|
| 01_(00.00-02.00)_CAM_A.mp4 | Wide_establishing | 00:00:00:00 | 00:00:02:00 | 100.0 | 2.0 | 48 | 2.0 | CAM_A.mp4 | /Volumes/…/CAM_A.mp4 |

The blank line is deliberate: it is still a well-formed CSV, so a script can find the table
without knowing how tall the header is — everything after the first empty row. In pandas that
is `skiprows` up to and including it, and `manifest.json` remains the clean machine-readable
copy if you would rather not deal with it at all.

`manifest.csv` holds every clip field among its 52 columns, which is the wrong shape for
reading. This is the short version, and it matters more now that the filename no longer spells
out the full timecode. A scan writes both, so you get the sheet without encoding anything.

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
re-encode that replaced both runs the same 16 in about 0.75 s. The speed copy was reached for
is available without giving up accuracy. See §5.1.

Remaining encode options: `--vcodec libx264`, `--container mp4`. Quality is not an option —
see §5.1 — and neither is audio: clips are **video only**, for a reason worth knowing.

An AAC track makes the container declare a longer duration than the video it holds. AAC needs
priming samples, so the audio outruns the video by ~40 ms — one frame — and an NLE reads the
container, not the frame count. So every clip imported one frame long, and a speed round trip
landed short. Neither `-shortest` nor trimming the audio fixes the mp4 header; only leaving
audio out does. Measured: 48 frames of 24 fps video declared **2.041 s** with audio,
**2.000 s** without.

Extracting audio-track clips on their own still works via `--tracks audio`, which writes `.m4a`
files where audio is the point.

### 5.1 Quality is fixed: crf 1, and it plays everywhere

There is no `--crf` and no `--preset`. Every clip is **x264 crf 1, High profile, yuv420p**, at
the **veryfast** preset, with `+faststart`.

This was crf 0 — mathematically lossless — until clips turned out to be unplayable on another
Mac. The reason is not obvious and worth writing down: **x264's lossless mode emits the
`High 4:4:4 Predictive` profile even when the pixel format is plain `yuv420p`**, and QuickTime,
Finder preview and Premiere's macOS decoders cannot read that profile at all. Measured on one
2-second clip:

| | Size | Profile | Plays on a Mac |
|---|---|---|---|
| crf 0 (lossless) | 1000 KB | High 4:4:4 Predictive | **no** |
| **crf 1 (now)** | **712 KB** | **High** | **yes** |
| crf 16 | 299 KB | High | yes |

So crf 1 is both smaller and playable. What is given up is strict bit-exactness; what is gained
is a clip you can double-click. `-profile:v high` is pinned explicitly so lossless mode can
never quietly reintroduce 4:4:4.

The preset only changes how hard x264 works to compress; it never moves a frame boundary, which
is why veryfast costs nothing in accuracy — verified frame-exact at ultrafast, veryfast, medium
and slow.

**Everything lands in 8-bit 4:2:0.** Preserving a 10-bit 4:2:2 source was the right call under
lossless, but any format above 8-bit 4:2:0 pushes x264 into a High 10 or 4:4:4 profile — the
same thing that made these files unplayable. `pix_fmt_out` records what was used.

**Parallelism is fixed too.** There is no `--jobs`: it is `min(8, cores)`, and deliberately not
the core count. libx264 already parallelises across every core inside a single encode, so extra
concurrent encodes mostly add contention. Measured on 24 clips of 1080x1920, best of
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
  --speed {native,timeline}   how to treat speed-ramped clips (default native)
  --min-frames N         skip cuts shorter than N frames
  --ext LIST             only cut clips whose source file has one of these extensions,
                         comma separated (--ext mp4,mov); default is every type present
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
- **Variable-frame-rate sources** (screen captures, some phone video) are the one case where
  the frame count can still be wrong: it is derived from the source's declared rate, and a VFR
  file has no single rate. `tools/source_check.py` detects and reports this — see below — but
  the cut is not yet compensated. Constant-rate media, which is nearly all camera footage, is
  unaffected.
- **Third-party effects** don't survive the XML export; only the effect name is captured.
- **Multicam clips** export as their flattened result, which is usually what you want.
- **Audio** clips extract as `.m4a` via `--tracks audio`. Premiere mirrors linked audio onto
  its own track, so `--tracks all` gives you most video clips a second time as audio. A clip on
  an audio track whose source has no audio is reported as `no_audio` rather than failing.

---

## 10.1 Checking the media, not just the XML

The XML records what Premiere *believed* about each source file. Everything xmlcut derives —
where to seek, how many frames to keep — rests on the source's frame rate and on the file
running at that rate, evenly, from time zero. When a file breaks either assumption the cut
comes out the wrong length and the XML cannot tell you, because the XML is not where the truth
is.

```bash
python3 tools/source_check.py "timeline.xml"
```

It probes each source once and reports variable frame rate, dropped frames, a non-zero start
time, a header that miscounts its own frames, stream-vs-container duration splits, and any
disagreement between the rate Premiere recorded and the file's own. Then, per cut, it counts
the frames that really exist in the range being extracted and compares that to the number
xmlcut will pin. Add `--all` to list every cut, `--deep` to decode each source in full.

Nothing is encoded and nothing is written, so it is safe to run on anything. A clean report
means the media is not where your error is:

```
all 16 match       — every cut's frame count equals the frames really in its range
```

For timing and speed rather than media, `tools/speed_check.py "timeline.xml"` checks the other
invariant: source length ÷ speed should equal the clip's length on the timeline.

---

## 10.2 The Premiere panel — cut straight from the timeline

**It will not open in a state where nothing can be cut.** If the remembered selection leaves every
type this timeline actually has switched off, the panel switches them back on and says so. And if you
untick them yourself, it tells you what the timeline *does* contain instead of just greying the button
out — *"Nothing selected. This timeline has .mov (1), .png (1) — tick one of those."* There is a
**select what's here** link beside the heading.

**The file-type list is stable between projects.** `.mp4`, `.mov` and `.png` are always listed,
even when the open timeline has none of them — shown dimmed with a `0` and a dashed edge. A list that
only showed what happened to be on *this* timeline changed shape every time you switched project, so
a type you rely on looked like it had gone missing. Ticking an absent type is remembered for the next
timeline that does have it.

Output is always `.mp4`. On the CLI, `--container` takes anything ffmpeg can mux — but **avoid
`mkv`**: its muxer declares one frame more than the file actually holds (2.042 s for a 2.000 s clip
at 24 fps), and an NLE reads the container's duration, not the frame count. That is the same defect
that got audio removed in 2.6.

**`xmlcut.py` travels inside the panel.** It's copied to `lib/xmlcut.py` in the extension folder at
install time, so the panel never has to go looking for it. That matters: `~/Desktop` and
`~/Documents` are TCC-protected on modern macOS, and until Premiere is granted Files-and-Folders
access a file sitting there in plain sight is invisible to the panel. The extension folder is one
Premiere already reads to load the panel at all.

The repository still keeps exactly one `xmlcut.py` — the copy is made when you install, and refreshed
on every update, so the two can't drift.

**It updates itself, cut logic included.** Install once; after that the panel shows an
**Update** button whenever a new version is published, and pressing it refreshes the engine
(`xmlcut.py` — the cutting logic itself), the panel files and the diagnostics, then copies the
panel back into Premiere's extensions folder. Nobody re-downloads a zip.

So a change to how clips are cut reaches everyone through that button. Traced end to end:
change the encoder settings, publish, press Update on another machine, and a cut made there
afterwards reports the new settings in its own manifest.

**Whether a restart is needed depends on what changed**, and the panel now says which:

| you changed | teammate has to |
|---|---|
| `xmlcut.py` only — cutting, timing, encoding | nothing. Their next export uses it |
| anything under `panel/CSXS`, `client`, `jsx`, `.debug` | quit Premiere (⌘Q) and reopen |

Premiere loads the panel's HTML, JS and JSX once at launch, so those need a reload. The engine
is a subprocess started fresh for every export, so it does not. The update compares the bytes
it downloaded against what is installed, and only asks for a restart when a file Premiere
actually loads has changed — a message that appears every time is a message people learn to
skip past.

What it updates is the copy **inside the extension folder** — the one the panel runs — and
nothing else. It used to fetch the browser GUI, its launcher and the README in there too,
which built a second installation nothing launches, and it never touched the folder you
downloaded. So your own folder stays at whatever version you downloaded; if you also use the
browser GUI, update that separately with `python3 xmlcut.py --update`, or re-run the panel
installer from a fresh copy.

Re-running the installer is safe in either direction: it **will not put an older engine back**
over one the panel has updated itself to. That used to be a silent downgrade, and re-running
the installer is exactly what you do when a panel is misbehaving.

### The gear — and the panel repairing itself

Everything about the *tool* rather than about your timeline sits behind the **⚙** in the header:
the cut script, and **Check for updates**. It used to be a link competing with step 1, and the
engine path was buried in Advanced.

```
CUT SCRIPT   bundled with this panel · v3.10 · runs
             bundled with this panel                  [Find]
             [ Re-check cut script ]
             [ Check for updates ]
```

**Re-check cut script** does three things, in order:

1. **Is it there?** The bundled copy first, then the saved path, then the usual folders.
2. **Does it run?** It actually executes it. *Present* is not the same as *works* — a zero-byte
   or half-copied `xmlcut.py` passes an existence check and then fails at export time, which is
   the worst possible moment to find out.
3. **If not, fetch it.** The panel downloads `xmlcut.py` from the release channel, writes it to
   `lib/xmlcut.py` inside itself, and links it. No restart needed, and it happens automatically
   on open if no engine could be found anywhere.

A damaged **bundled** copy is replaced without being asked, because that file is only ever a
copy and the panel is dead without it. A script anywhere else — your own checkout — is never
overwritten; it is only reported.

The download is validated *before* anything is written: it must be big enough, its `VERSION`
must match what the channel promised, and it must contain the markers a real engine has and an
error page does not. A download that fails any of those is refused and **nothing is written**,
so a failed repair leaves the panel missing an engine and saying so, rather than holding a
broken one.

> This is the only thing the panel fetches for itself. Everything else still goes through
> `xmlcut.py` — but it cannot ask `xmlcut.py` to download `xmlcut.py`. The same trust note
> applies: whoever can push to the releases repo can put code on this machine.


No XML export, no sequence picker. `panel/` reads the sequence you have open and cuts it.

Install by double-clicking **`panel/Install xmlcut reader (Mac).command`**, then quit and reopen
Premiere and find it under **Window → Extensions → xmlcut reader**.

Three steps, in order, nothing happening until you ask for it:

1. **Read timeline & export XML** — reads the open sequence through Premiere's API *and* has
   Premiere export it as a Final Cut Pro 7 XML. Changes nothing in your project.
2. **Choose what to cut** — file types, and where the clips go.
3. **Export** — a progress bar per clip, then a status report.

It cuts from **both** sources, because neither is complete on its own:

| | comes from | why |
|---|---|---|
| Source ranges, nested sequences | **the XML** | the verified path, and the only one that resolves nests |
| Speed-ramp keyframes | **Premiere** | an XML flattens a whole curve to one number |
| Current media paths | **Premiere** | a stale path in the XML gets repaired automatically |
| Speed, frame rate, ranges | **both** | cross-checked; a disagreement is reported, never silently resolved |

You don't choose. The panel says which sources it's using, and if Premiere won't export an XML
it falls back to reading alone and tells you nests will be skipped.

It shows what it found:

```
MY_SEQUENCE
29.97 fps · 28 video clips
⚠ 3 clips have a keyframed speed ramp.
XML + Premiere · nests resolved, ramp keyframes read

FILE TYPES     [x] .mp4 24   [x] .mov 3   [ ] .aep 1
SAVE TO        …/Desktop/xmlcut clips           [Change]
               → MY_SEQUENCE/

              [ Export 27 clips ]
```

Untick a type to skip it; project files like `.aep` start unticked because they can't be
decoded.

**Save to is a root you pick once.** Each export creates a folder named after the sequence
inside it and writes there — `…/xmlcut clips/MY_SEQUENCE/`. That is not just tidiness: xmlcut
numbers its output `01..N` **per run**, so cutting three sequences into one folder interleaved
three sets of `01_`, `02_`, `03_` … and each run overwrote the previous one wherever a name
collided. A folder per sequence means each run's numbering, `clips.csv` and manifest describe
exactly one timeline.

The line under the path shows the folder before it is created. If that folder already exists
it says so in amber with a file count, because a re-export overwrites the names it reproduces
and leaves the rest — so a folder from an older cut of the same timeline ends up holding a
mixture. Tick **skip clips already in that folder** to add only what is missing, or empty it
first.

Illegal characters in a sequence name are replaced, not stripped: `v2.0: final/cut` becomes
`v2.0- final-cut`. `:` is the one that matters — HFS accepts it but Finder renders it as `/`,
so a folder would appear under a name you never chose.

Step 2 also lists **every clip the export will make**, the same columns as the browser GUI:

```
#   Timeline in   Clip               Speed    Timing  Frames  Status          Notes
01  00:00:00:00   Wide_establishing  100%     ticks       48  ready
05  00:00:09:00   Cutaway_fast       200%     ticks       50  ready
08  00:00:12:25   Reverse_shot       100% ⏪  ticks       50  ready           reversed
10  00:00:16:15   Ramp_keyframed     150%     ticks       60  ready           ramp 100–220%
15  00:00:25:10   Nested_head_trim   100%     ticks       24  ready           in Nested Sequence 05
── cannot be cut — fix these or untick their type
14  00:00:23:20   Offline_shot       100%     ticks       50  missing source
```

The list comes from a real `--manifest-only` pass, so it's produced by the same code that does
the cutting — not a second guess at it. Clips that can't be cut sort to the bottom under a
divider but keep their true number. Switch a file type off and the rest renumber to match the
filenames you'll actually get.

### Picking individual clips

Every row in the clip list has a tick. Untick one and it leaves the run: the numbering closes up so
the remaining clips are still `01..N`, the count updates, and the row dims. The header tick selects or
clears everything, and shows a mixed state when only some are on.

That travels to the cutter as `--pick FILE`, one clip per line as `TRACKTYPE TRACKINDEX TIMELINEIN`:

```
video 1 0
video 1 135
```

Matched on timeline position rather than an index, because an index shifts whenever anything else is
filtered, and a file rather than command-line arguments because a long timeline is hundreds of clips.
The manifest records `picked_from` and `picked_count`, so a partial run says it was one — a dataset
built from a manifest that claimed to be complete would silently be missing whatever you unticked.

### The status report

After the run you get a report built from the manifest — one row per clip, carrying the numbers
that let you check any cut without doing arithmetic:

```
16 written   1 offline   1 not media   1 ramp   4 retimed   2 reversed

05_(06.67-08.33)_CAM_B.mp4
    1.667s · 50f · 200.00% · → 0.833s on the timeline
10_(08.33-10.83)_CAM_C.mp4
    2.500s · 60f · 150.00% · → 1.667s · ramp 100–220%, cut at one speed
15_(00.33-02.00)_MISSING.mp4
    Source not found: /Volumes/OldDrive/Footage/MISSING.mp4
```

Read that as: the file is **1.667s** long and holds **50 frames**; its timeline clip ran at
**200%** and occupied **0.833s**. Tick **only problems** to hide everything that worked, **Copy
report** to paste it elsewhere, **Show in Finder** to open the folder.

A cut is written at the source's own speed, so a **sped-up clip comes out longer** than it looks
on the timeline, and a slowed one comes out shorter. Re-speeding a cut by the percentage shown
returns it to the timeline length — to within about a frame. It will not land on the percentage
exactly: the frame count is a whole number and the range Premiere consumed is not, and a ratio of
two rounded integers cannot reproduce an unrounded one. On a short clip that shows up as up to
about 1%.

The same four numbers are now columns in `clips.csv` too — `speed %`, `cut length s`, `frames`,
`timeline length s`.

Reading the sequence changes nothing in your project and renders nothing. Both files land
**beside your Premiere project**, one folder per sequence, as a new timestamped pair each read:

```
<project folder>/xmlcut/<Sequence Name>/2026-08-12_134500.xml
                                        2026-08-12_134500.json
```

Nothing is overwritten; the ten most recent reads are kept and older pairs are pruned. An
unsaved project falls back to `~/Desktop/xmlcut-dumps/`. The panel shows the folder with a
**Show** button. The same run works from the terminal:

```bash
python3 xmlcut.py "…/xmlcut/MY_SEQ/2026-08-12_134500.xml" --panel "…/xmlcut/MY_SEQ/2026-08-12_134500.json" -o ./clips
```

`--panel` is the merge: the XML is the base, the dump overlays the ramp keyframes and repairs
stale paths, and everything both carry is cross-checked. The JSON also works on its own —
`xmlcut.py` takes it anywhere it takes an XML — with nests skipped.

**The panel does not do the cutting.** It reads Premiere and hands the list to `xmlcut.py`,
which is the code verified frame-exact against a fixture. Both inputs were checked to produce
**byte-identical files** for the same timeline, so nothing about accuracy depends on which one
you use.

### What Premiere knows that the XML doesn't

1. **Time Remapping keyframes.** The XML gives one speed value per clip, which cannot describe
   a clip whose speed changes across itself. The panel reads the curve and flags those clips.
2. **The interpreted frame rate** — what the edit is really built on. Reinterpret 24 fps footage
   as 23.976 and the file says one thing while Premiere cut against another. Those clips are
   named on export; their ranges are right, their lengths are reported as unverified.
3. **Real media paths**, so `--remap` has nothing left to do.

To see whether any of that matters on your material, compare the two inputs directly:

```bash
python3 tools/compare_panel.py "timeline.xml"
```

If it says they agree, the XML loses nothing on that timeline and the panel is pure
convenience.

### Nested sequences

Handled — but by the XML half, not the panel. Premiere hands a nest over as a single clip, so
the panel alone would skip it. Because the panel auto-exports the XML and merges, nests are
resolved as normal. Only if the XML export fails does the panel fall back to reading alone, and
then it says so and reports how many nests it skipped.

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
