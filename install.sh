#!/bin/bash
#
# One-line install:
#
#   curl -fsSL https://raw.githubusercontent.com/mill2nn/xmlcut-releases/main/install.sh | bash
#
# WHY THIS EXISTS: a zip downloaded through a browser is quarantined by macOS, so the
# .command inside it is refused on first double-click with "cannot be opened because it is
# from an unidentified developer". Getting past that needs a right-click → Open → Open that
# nobody discovers on their own. A script the user pipes into bash from a Terminal they
# opened themselves is never quarantined, so there is no prompt to explain.
#
# TRUST, STATED PLAINLY: this downloads code from a repository and runs it. That is the same
# bargain the panel's own Update button already makes — anyone able to push to
# mill2nn/xmlcut-releases can run code on every machine running Raw-cutter — which is why
# the owner, repo and branch below are literals and not configurable.
#
# It is not published from the repo's file list. UPDATE_FILES describes what an UPDATE
# replaces; this is the thing that runs before there is anything to update.

set -euo pipefail

OWNER="mill2nn"
REPO="xmlcut-releases"
BRANCH="main"
RAW="https://raw.githubusercontent.com/$OWNER/$REPO/$BRANCH/app"
DEST="${RAWCUTTER_DIR:-$HOME/Raw-cutter}"

say() { printf '  %s\n' "$*"; }

printf '\n  Raw-cutter — installing\n\n'

for tool in curl python3; do
  command -v "$tool" >/dev/null 2>&1 || {
    say "!! $tool is not on PATH."
    [ "$tool" = "python3" ] && say "   Run:  xcode-select --install"
    exit 1
  }
done

# ffmpeg is what actually does the cutting, and on a fresh Mac it is not there. Offering to
# install it is the difference between "one line" and "one line, after two other things".
#
# ⚠️ READ FROM /dev/tty, NOT STDIN. This script is normally delivered by `curl | bash`, which
# means bash is READING THE SCRIPT from stdin — a plain `read` would swallow the rest of the
# script instead of waiting for the user. /dev/tty is the terminal itself. If there is no
# terminal at all (a CI runner, a nested pipe) the prompt is skipped rather than hung on.
#
# HOMEBREW ITSELF IS NOT INSTALLED HERE, and that is deliberate. It wants an admin password,
# writes outside the home directory, edits the shell profile and pulls down the Xcode command
# line tools. A script somebody pasted from a README should not be making that decision for
# them; a link is the honest answer.
if command -v ffmpeg >/dev/null 2>&1; then
  say "ffmpeg   : $(ffmpeg -version 2>/dev/null | head -1 | cut -d' ' -f3)"
elif command -v brew >/dev/null 2>&1; then
  say "ffmpeg   : NOT FOUND — it is what does the actual cutting."
  say ""
  if [ -r /dev/tty ]; then
    printf '  Install it now with Homebrew? This runs "brew install ffmpeg"\n'
    printf '  and takes a few minutes. [y/N] '
    read -r ANSWER < /dev/tty 2>/dev/null || ANSWER=""
  else
    ANSWER=""
  fi
  case "$ANSWER" in
    [yY]*)
      printf '\n'
      say "installing ffmpeg — this is Homebrew's output, not ours"
      printf '\n'
      brew install ffmpeg || { say "!! brew install ffmpeg failed — nothing else was changed."; exit 1; }
      printf '\n'
      command -v ffmpeg >/dev/null 2>&1 || { say "!! ffmpeg still not on PATH — stopping."; exit 1; }
      say "ffmpeg   : $(ffmpeg -version 2>/dev/null | head -1 | cut -d' ' -f3)"
      ;;
    *)
      say "Nothing was changed. Install it, then run this line again:"
      say ""
      say "    brew install ffmpeg"
      say ""
      exit 1
      ;;
  esac
else
  say "ffmpeg   : NOT FOUND — it is what does the actual cutting, and Homebrew"
  say "           is not installed either, which is the usual way to get it."
  say ""
  say "           1. Install Homebrew:  https://brew.sh"
  say "              (one line on that page; it will ask for your Mac password)"
  say "           2. Then:              brew install ffmpeg"
  say "           3. Then run this line again."
  say ""
  say "Nothing has been changed."
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# The engine first, because it carries the list of everything else. One source of truth for
# what a copy of Raw-cutter consists of: the same UPDATE_FILES the updater and the shareable
# zip both read, so none of the three can disagree.
curl -fsSL "$RAW/xmlcut.py" -o "$TMP/xmlcut.py"
VER=$(sed -n 's/^VERSION = "\(.*\)"/\1/p' "$TMP/xmlcut.py" | head -1)
[ -n "$VER" ] || { say "!! that download does not look like xmlcut.py — stopping."; exit 1; }
say "version  : $VER"

FILES=$(cd "$TMP" && python3 -c "
import sys; sys.path.insert(0, '.')
import xmlcut
print('\n'.join(xmlcut.UPDATE_FILES))
")
[ -n "$FILES" ] || { say "!! could not read the file list from xmlcut.py — stopping."; exit 1; }

printf '\n'
say "fetching into $DEST"
mkdir -p "$DEST"
COUNT=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  mkdir -p "$DEST/$(dirname "$f")"
  # ⚠️ PERCENT-ENCODE THE SPACES. Four of these files have spaces in their names —
  # "Open xmlcut GUI.command", the two panel installers — and curl rejects a URL
  # containing a raw space outright: "URL rejected: Malformed input to a URL function".
  # The first version of this script died on the fourth file with three already written,
  # which is precisely why it was run against a real fetch before being trusted.
  url="${f// /%20}"
  # Straight to the destination rather than via $TMP: a partial fetch then leaves a
  # half-written file that says so, instead of a tidy folder missing something.
  curl -fsSL "$RAW/$url" -o "$DEST/$f" || { say "!! failed on $f — stopping."; exit 1; }
  COUNT=$((COUNT + 1))
done <<< "$FILES"
say "$COUNT file(s)"

find "$DEST" -name "*.command" -exec chmod +x {} \; 2>/dev/null || true
# Nothing here was downloaded by a browser so nothing should be flagged, but a re-run over
# a folder that DID come from a zip would inherit its flags.
xattr -cr "$DEST" 2>/dev/null || true

printf '\n'
RAWCUTTER_WRAPPED=1 bash "$DEST/panel/Install xmlcut reader (Mac).command" </dev/null

printf '\n  ────────────────────────────────────────────────────────────\n'
say "Installed. Two steps left, and the first one matters:"
printf '\n'
say "  1. QUIT Premiere completely — Cmd-Q, not just closing the window."
say "     Reopen it."
say "  2. Window > Extensions > Raw-cutter"
printf '\n'
say "A panel that was already open will not pick this up until Premiere"
say "restarts. That is the usual reason it looks like nothing happened."
printf '\n'
say "Updates arrive in the panel from here on — it shows an Update button"
say "when a new version is published. You will not need this line again."
say "The engine and its files live in $DEST if you ever want them."
printf '\n'
