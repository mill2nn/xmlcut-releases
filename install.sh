#!/bin/bash
#
# xmlcut installer — one command, no zip, no Gatekeeper prompt.
#
#   curl -fsSL https://raw.githubusercontent.com/mill2nn/xmlcut-releases/main/install.sh | bash
#
# Installs to ~/Desktop/xmlcut (override with XMLCUT_DIR=... before the pipe) and puts
# the Premiere panel where Premiere looks for it.
#
# WHY THIS EXISTS ALONGSIDE THE ZIP: a downloaded .command is quarantined by Gatekeeper,
# so the zip route needs a right-click → Open → Open that confuses everyone the first
# time. A script piped from curl is not quarantined, and it can also set the one Adobe
# preference an unsigned panel needs. Same files either way.
#
# It downloads exactly what the built-in updater downloads: the file list in
# latest.json, from app/ in the public releases repo. One source of truth, so a fresh
# install and an updated install are byte-identical.
#
# Nothing here uses sudo. Nothing is written outside $XMLCUT_DIR and Adobe's own
# extensions folder.

set -euo pipefail

OWNER="mill2nn"
REPO="xmlcut-releases"
BRANCH="main"
APPDIR="app"
PANEL_ID="com.bom.xmlcutreader"

DEST="${XMLCUT_DIR:-$HOME/Desktop/xmlcut}"
CEP="${XMLCUT_CEP_DIR:-$HOME/Library/Application Support/Adobe/CEP/extensions}"
RAW="https://raw.githubusercontent.com/$OWNER/$REPO/$BRANCH"

say()  { printf '  %s\n' "$1"; }
die()  { printf '\n  %s\n\n' "$1" >&2; exit 1; }

printf '\nxmlcut installer\n\n'

# ---- 1. prerequisites -----------------------------------------------------
command -v python3 >/dev/null 2>&1 || die "python3 not found. Install Apple's command line tools:
      xcode-select --install"

FFMPEG_OK=1
command -v ffmpeg  >/dev/null 2>&1 || FFMPEG_OK=0
command -v ffprobe >/dev/null 2>&1 || FFMPEG_OK=0

# ---- 2. refuse to overwrite a source checkout -----------------------------
if [ -d "$DEST/.git" ]; then
  die "$DEST is a git checkout. Use 'git pull' there instead — this installer
      would overwrite work in progress."
fi

# ---- 3. what to download, straight from the channel -----------------------
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

say "asking the release channel what to fetch ..."
curl -fsSL "$RAW/latest.json" -o "$TMP/latest.json" \
  || die "could not reach GitHub. Check your connection."

VERSION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' \
          "$TMP/latest.json") || die "latest.json was not readable."
say "installing xmlcut $VERSION"

# Same guard as the updater: reject anything that is not a plain relative path, since
# this list comes from a public repo. The JSON is passed as a FILE, not on stdin — a
# heredoc script and a piped payload cannot both be stdin.
FILES=$(python3 - "$TMP/latest.json" <<'PY'
import json, re, sys
from urllib.parse import quote
data = json.load(open(sys.argv[1]))
out = []
for f in data.get("files") or []:
    parts = [p for p in str(f).split("/") if p not in ("", ".")]
    if not parts or len(parts) > 4:
        sys.exit(f"refusing suspicious path: {f}")
    for i, p in enumerate(parts):
        if p == ".." or not re.fullmatch(r"[A-Za-z0-9 ._()+-]+", p):
            sys.exit(f"refusing suspicious path: {f}")
        if p.startswith(".") and i != len(parts) - 1:
            sys.exit(f"refusing suspicious path: {f}")
    rel = "/".join(parts)
    # Tab-separated: the path to write, then a URL-safe form of it. "Open xmlcut
    # GUI.command" has spaces, and curl rejects an unencoded space outright.
    out.append(rel + "\t" + quote(rel))
print("\n".join(out))
PY
) || die "latest.json listed a filename this installer will not write."

# ---- 4. download everything BEFORE touching the destination ---------------
COUNT=0
TOTAL=$(printf '%s\n' "$FILES" | grep -c .)
while IFS=$'\t' read -r rel enc; do
  [ -n "$rel" ] || continue
  COUNT=$((COUNT + 1))
  printf '\r  downloading %s/%s ...\033[K' "$COUNT" "$TOTAL"
  mkdir -p "$TMP/$(dirname "$rel")"
  curl -fsSL "$RAW/$APPDIR/$enc" -o "$TMP/$rel" \
    || die "download failed: $rel — nothing was installed."
  [ -s "$TMP/$rel" ] || die "$rel came back empty — nothing was installed."
done <<< "$FILES"
printf '\r  downloaded %s files\033[K\n' "$TOTAL"

# ---- 5. check them before installing --------------------------------------
while IFS=$'\t' read -r rel _; do
  case "$rel" in
    *.py) python3 -m py_compile "$TMP/$rel" 2>/dev/null \
            || die "$rel did not compile — nothing was installed." ;;
  esac
done <<< "$FILES"
find "$TMP" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true

GOT=$(python3 - "$TMP/xmlcut.py" <<'PY'
import re, sys
m = re.search(r'VERSION\s*=\s*"([^"]+)"', open(sys.argv[1]).read())
print(m.group(1) if m else "")
PY
)
[ "$GOT" = "$VERSION" ] || die "the download reports $GOT but latest.json says $VERSION.
      Nothing was installed — that mismatch means a broken publish."
say "checked: every file parses and reports $VERSION"

# ---- 6. install -----------------------------------------------------------
mkdir -p "$DEST"
while IFS=$'\t' read -r rel _; do
  [ -n "$rel" ] || continue
  mkdir -p "$DEST/$(dirname "$rel")"
  cp "$TMP/$rel" "$DEST/$rel"
done <<< "$FILES"
find "$DEST" -name '*.command' -exec chmod +x {} \; 2>/dev/null || true
say "installed to $DEST"

# ---- 7. the Premiere panel ------------------------------------------------
PANEL_DONE=0
if [ -d "$DEST/panel" ]; then
  # An unsigned panel only loads with PlayerDebugMode set. Several CSXS versions are
  # set because which one Premiere reads depends on its release.
  for v in 9 10 11 12; do
    defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1 2>/dev/null || true
  done
  mkdir -p "$CEP/$PANEL_ID"
  for part in CSXS client jsx .debug; do
    [ -e "$DEST/panel/$part" ] || continue
    rm -rf "$CEP/$PANEL_ID/$part"
    cp -R "$DEST/panel/$part" "$CEP/$PANEL_ID/$part"
  done
  PANEL_DONE=1
  say "Premiere panel installed"
fi

# ---- 8. what to do next --------------------------------------------------
printf '\n  Done — xmlcut %s\n\n' "$VERSION"

if [ "$FFMPEG_OK" -eq 0 ]; then
  printf '  ONE THING LEFT: xmlcut needs ffmpeg.\n\n'
  printf '      brew install ffmpeg\n\n'
  printf '  (No Homebrew? https://brew.sh, then run the line above.)\n\n'
fi

if [ "$PANEL_DONE" -eq 1 ]; then
  printf '  To use it inside Premiere:\n'
  printf '    1. Quit Premiere completely (Cmd-Q) and reopen it.\n'
  printf '    2. Window > Extensions > xmlcut\n'
  printf '    3. Open the sequence you want and press Read timeline.\n\n'
fi
printf '  Or in a browser window:\n'
printf '    open "%s/Open xmlcut GUI.command"\n\n' "$DEST"
printf '  Updates arrive through the panel — you will not download this again.\n\n'
