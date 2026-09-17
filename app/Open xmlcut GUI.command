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

echo "Raw-cutter — starting the GUI"
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
  # ⚠️ ONLY PAUSE IF A HUMAN IS THERE TO PRESS THE KEY. These files are written to be
  # double-clicked in Finder, which hands them a Terminal window that would vanish before the
  # result could be read — hence the pause. Run any other way (a build script, a task runner,
  # plain `bash <file>`) stdin is a pipe that never closes, so the script sat here FOREVER with
  # its work already done. Measured: five of them parked for up to 3h45m at 0% CPU.
  #
  # `[ -t 0 ]` asks the only question that matters: is stdin a terminal someone can type into.
  # ⚠️ NOT `[ -r /dev/tty ]`, which install.sh uses for a DIFFERENT problem — it runs as
  # `curl … | bash`, so its stdin is the script itself and it has to reach around to the human.
  # Here stdin is exactly the thing being tested.
  if [ -t 0 ]; then
    echo "  Press return to close this window."
    read -r _
  fi
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "  python3 not found. On macOS it ships with the Xcode command line tools:"
  echo
  echo "      xcode-select --install"
  echo
  [ -t 0 ] && read -r _ || true
  exit 1
fi

# -u so the URL appears immediately; without it Python buffers stdout whenever
# this runs somewhere that isn't a terminal.
exec python3 -u xmlcut_gui.py
