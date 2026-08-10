# xmlcut — downloads

Built downloads for **xmlcut**, a command-line tool and local GUI that extracts every cut of
an Adobe Premiere Pro timeline as an individual video file, straight from the timeline's
Final Cut Pro 7 XML export. Each clip comes with a manifest row describing exactly where it
came from, which makes the output usable as a labelled dataset.

Source lives elsewhere. This repository only holds the zips.

## Download

Grab the newest zip from **[Releases](../../releases/latest)**.

## What you need

- **macOS** with the built-in `python3` (3.8 or newer). No Python packages at all — the tool
  imports nothing outside the standard library.
- **ffmpeg**, once:

  ```bash
  brew install ffmpeg
  ```

  Without Homebrew, see [brew.sh](https://brew.sh) first.

## Running it

Unzip anywhere, then double-click **Open xmlcut GUI.command**. macOS blocks anything
downloaded from the internet on first launch — right-click the file → **Open** → **Open**.
Once only.

Your browser opens. Drag the XML Premiere exported onto the page, pick the sequence, choose
an output folder, then **Scan timeline** and **Cut clips**. Leave the Terminal window open
while you work; it is the local server. Nothing is installed, and nothing leaves your
machine — the server listens on `127.0.0.1` only.

`README.md` inside the zip has the full detail, including what every manifest column means.

## What it is careful about

- **Frame exact.** Cuts are re-encoded rather than stream-copied, because a stream copy can
  only start on a keyframe and overran measured cut lengths by 22–147%, contaminating clips
  with the neighbouring shot.
- **Lossless.** x264 crf 0, verified bit-for-bit identical to the decoded source. The
  source's pixel format is preserved, so a 10-bit 4:2:2 master is not quietly flattened.
- **Honest about timing.** The source range is read from Premiere's own tick values, which
  stay correct through speed ramps where frame arithmetic does not. Reversed clips, nested
  sequences, stills and speed ramps are each handled and labelled.
- **It refuses to guess.** Premiere exports every sequence in a project into one XML, so if
  there is more than one, the tool stops and asks which — silently cutting the wrong
  timeline is the worst failure mode for a dataset.
