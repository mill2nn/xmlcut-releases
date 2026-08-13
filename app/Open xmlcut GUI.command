#!/bin/bash
#
# Double-click this file to open the xmlcut GUI.
#
# It starts a small local server and opens the page in your browser. Leave the
# Terminal window that appears OPEN — it is the server. Close it, or press
# Ctrl-C in it, and the GUI stops.
#
# Nothing is installed and nothing leaves your machine: the server listens on
# 127.0.0.1 only, on a port it picks fresh each time.

set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "auto bits — starting the GUI"
echo

# ffmpeg is the only real prerequisite. Say so clearly here rather than letting
# Python exit with a one-liner that scrolls past.
missing=""
for tool in ffmpeg ffprobe; do
  command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
done
if [ -n "$missing" ]; then
  echo "  Missing:$missing"
  echo
  echo "  xmlcut needs ffmpeg to cut anything. Install it with:"
  echo
  echo "      brew install ffmpeg"
  echo
  echo "  (If you don't have Homebrew: https://brew.sh)"
  echo
  echo "  Press return to close this window."
  read -r _
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "  python3 not found. On macOS it ships with the Xcode command line tools:"
  echo
  echo "      xcode-select --install"
  echo
  read -r _
  exit 1
fi

# -u so the URL appears immediately; without it Python buffers stdout whenever
# this runs somewhere that isn't a terminal.
exec python3 -u xmlcut_gui.py
