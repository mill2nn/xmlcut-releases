# Raw-cutter

Every cut of an Adobe Premiere Pro timeline, as its own video file — read straight from the
sequence you have open, with a manifest row per clip describing exactly where it came from.

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
