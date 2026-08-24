# Raw-cutter

**Turn a finished Premiere Pro edit into a labelled library of its individual shots — in one
click, from the timeline you already have open.**

An editor cuts a 40-second ad from 60 takes. The edit ships; the *decisions* — which take,
which two seconds of it, at what speed, with which grade — stay locked inside a `.prproj` that
nothing else can read. Raw-cutter opens that up: every cut becomes its own video file, next to
a spreadsheet row saying exactly where it came from.

It was built to assemble training datasets out of finished edits. It turns out to be just as
useful for reusing a shot you know you cut three months ago and cannot find.

## What you get

Point it at an open sequence, press **Read timeline**, tick what you want, press **Export**:

| | |
|---|---|
| **One file per cut** | `07_(04.03-04.73)_B_roll_wide.mp4` — index, the exact seconds used from the source, and the source's own name |
| **A row per cut** | `clips.csv`: source file, timeline position, timecode, speed %, whether it was reversed, frame count, and whether the clip was switched off |
| **A manifest** | `manifest.json` — the same, machine-readable, plus every setting the run used, so a dataset built from it is reproducible |
| **The voice-over** | one MP3 as long as the sequence, voice at its timeline positions, silence in the gaps |

## Two ways to cut, and the second one is the point

**Source media** reads your original camera files. The clips are the untouched footage, frame
for frame — no grade, no titles, no transforms. That is what you want for a clean library.

**Timeline render** has Premiere render each cut with everything on it baked in — colour,
titles, Motion, speed ramps, adjustment layers — and cuts from that instead. Same filenames,
same manifest, same rows. **Measured at ≈0.65 seconds per cut** (17 cuts, 1,119 frames, 11
seconds — about 3.5× realtime), so a 60-cut timeline costs under a minute of Premiere's time.

No AI, and the XML is not thrown away: the timeline supplies the positions, Premiere supplies
the pixels.

## Frame-exact, and it tells you when it isn't

Cuts hold exactly the frames the timeline used. A sped-up clip therefore comes out **longer**
than it looks on the timeline — that is correct, not a bug, and the manifest records the
speed. Exactly one setting breaks frame-exactness (forcing an output frame rate), and the
panel says so in red when you choose it.

## Built to be checked, not trusted

- **Nine automated test suites**, run on every change. They cut real video and measure the
  result — the panel suite alone carries over 450 assertions.
- Every fix is **mutation-tested**: the code is deliberately broken to confirm the test
  actually fails. A test nobody has watched fail is not a test.
- Verified against **30 real Premiere exports**, not only synthetic fixtures.
- **No Python packages.** Both files import nothing outside the standard library — no
  virtualenv, no pip, nothing to keep up to date.
- Nothing leaves your machine except the update check, which reads one small file from GitHub.

---

## Install

Two commands, in this order. Both are one-time.

### 1. Install ffmpeg

ffmpeg is what does the actual cutting. Paste this in **Terminal**:

```bash
brew install ffmpeg
```

Already have it? Skip to step 2 — `ffmpeg -version` tells you.

<details>
<summary>No Homebrew? (that is what <code>brew</code> is)</summary>

Install it first from **[brew.sh](https://brew.sh)** — one line on that page, and it will ask
for your Mac password. Then come back and run `brew install ffmpeg`.

</details>

### 2. Install Raw-cutter

```bash
curl -fsSL https://raw.githubusercontent.com/mill2nn/xmlcut-releases/main/install.sh | bash
```

Nothing to download, nothing to unzip, and macOS does not question it — a script you run from
a Terminal you opened yourself is not treated as a downloaded file, so there is no
"unidentified developer" block to click through.

If you skipped step 1 and have Homebrew, this offers to install ffmpeg for you. If you have
neither it stops and tells you what to do, without changing anything.

### 3. Restart Premiere

**Quit it completely** — Cmd-Q, not just closing the window — then reopen. A panel that was
already open will not see the install until Premiere restarts; that is the usual reason it
looks like nothing happened.

Then **Window → Extensions → Raw-cutter**, open the sequence you want, and click
**Read timeline**.

The line under the panel's title always says what to do next. Hover any **?** for what a
control does.

## What you need

- **macOS** with `python3`. Usually already there; if not, `xcode-select --install`.
- **ffmpeg**, from step 1 above.

No Python packages. The tool imports nothing outside the standard library.

## Updates

You will not run that line again. When a new version is published the panel shows an
**Update** button — one click and it refreshes itself, the cut engine and the panel files
together. The version you were on is kept in a `.backup` folder, and if an update fails
part-way nothing on disk is changed.

## Prefer to download it?

There is a zip on the [latest release](../../releases/latest) if you would rather. It expands
to three things; double-click **Install Raw-cutter.command**.

macOS blocks it the first time, because it *did* arrive as a download:

> "Install Raw-cutter.command" cannot be opened because it is from an unidentified developer.

To get past it: **right-click the file → Open → Open**. Once only — it clears the same block
from everything else in the folder. This is the only reason the one-line install above
exists, and why it is the one to prefer.

## Without Premiere

`app/Open xmlcut GUI.command` opens a page in your browser instead: drag in an XML that
Premiere exported (**File → Export → Final Cut Pro XML**), pick the sequence, choose a
folder, then Scan and Cut. Leave its Terminal window open while you work — that window is
the server.

## What is in here

This repository is the download and update channel, not the source.

- `install.sh` — the one-line installer above
- `app/` — the files an installed copy fetches when it updates itself
- `latest.json` — the version and release notes the Update button reads
- [Releases](../../releases) — the zips

## Cutting is not lossy by accident

Clips are written at the source's own speed and hold exactly the frames the timeline used,
so a sped-up clip comes out **longer** than it looks on the timeline. Check a clip on its
frame count rather than by re-speeding it: the frame count is a whole number and the range
Premiere consumed is not, so a ratio of the two cannot reproduce the percentage exactly.

Forcing a frame rate is the one setting that breaks this, and the panel says so in red when
you do. Changing the resolution does not — it resamples space, not time, so the cuts stay
frame-exact.

Nothing leaves your machine except the update check, which reads one small file from GitHub.
