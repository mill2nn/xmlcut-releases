# xmlcut

Cut every clip of a Premiere Pro timeline into its own video file — from inside Premiere, or from
an XML export. Built for assembling training datasets: every clip comes with a row saying exactly
where it came from.

## Install

Paste this into Terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/mill2nn/xmlcut-releases/main/install.sh | bash
```

That downloads xmlcut to `~/Desktop/xmlcut` and installs the Premiere panel. Then:

1. **`brew install ffmpeg`** — once, if you don't already have it. (No Homebrew? [brew.sh](https://brew.sh))
2. **Quit Premiere completely** (⌘Q) and reopen it.
3. **Window → Extensions → xmlcut**

Open the sequence you want, press **Read timeline**, pick a folder, **Export**.

Prefer not to pipe a script into bash? Download it, read it, then run it:

```bash
curl -fsSLO https://raw.githubusercontent.com/mill2nn/xmlcut-releases/main/install.sh
less install.sh          # it's short, and it uses no sudo
bash install.sh
```

Or take [the zip from the latest release](../../releases/latest) and follow `START HERE.txt`.

## You only install once

After that the panel shows an **Update** button whenever a new version is published, and it
refreshes the tool, the browser GUI and the panel together.

## What it needs

- macOS
- `ffmpeg` and `ffprobe` on your PATH
- Python 3.8+ — already on macOS
- Premiere Pro 2020 or newer, for the panel

No Python packages. Nothing to keep up to date but xmlcut itself.

## What you get

```
01_(05.71-07.71)_CAM_A.mp4     index · the range inside that source file · source name
clips.csv                      file, clip name, timeline in/out, speed, length, frames
manifest.csv / .json           the same plus 40 more columns per cut
```

Clips are H.264 High / 4:2:0 / video-only, so they play everywhere and never claim a length they
don't have. Speed ramps, reversed clips and nested sequences are all handled; stills, After Effects
comps and offline media are reported rather than silently skipped.

Full documentation is in `README.md` inside the install.
