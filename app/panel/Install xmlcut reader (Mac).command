#!/bin/bash
# Install the Raw-cutter panel into Premiere.
#
# Copies this folder to Adobe's CEP extensions directory. The panel is read-only —
# it never modifies your project — so reinstalling is always safe. It will not put an older
# panel or an older engine over a newer installed one; --force says you mean it.
set -euo pipefail
cd "$(dirname "$0")"

DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.bom.xmlcutreader"

# A deliberate rollback is a real thing to want; an accidental one is what this file is
# guarding against. RAWCUTTER_FORCE exists because the wrappers invoke this with no
# arguments, so a double-clicked zip has no other way to say "yes, go back".
FORCE=""
if [ "${1:-}" = "--force" ]; then FORCE=1; fi
if [ -n "${RAWCUTTER_FORCE:-}" ]; then FORCE=1; fi

echo "Installing Raw-cutter..."
echo

# Unsigned panels only load when PlayerDebugMode is set. Premiere 2026 reads CSXS.12,
# but set the older keys too so the panel still loads if you roll back a version.
for v in 9 10 11 12; do
    defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1 2>/dev/null || true
done
echo "  PlayerDebugMode: on"

version_of() {
    python3 - "$1" <<'PY' 2>/dev/null || true
import re, sys, pathlib
try:
    t = pathlib.Path(sys.argv[1]).read_text()
except Exception:
    print(""); raise SystemExit
m = re.search(r'VERSION\s*=\s*"([^"]+)"', t)
print(m.group(1) if m else "")
PY
}
# The panel's own number, read where Adobe reads it. It is bumped from the engine's version
# by the publisher, so the two are the same string on any release since it started moving.
manifest_version() {
    python3 - "$1" <<'PY' 2>/dev/null || true
import re, sys, pathlib
try:
    t = pathlib.Path(sys.argv[1]).read_text()
except Exception:
    print(""); raise SystemExit
m = re.search(r'ExtensionBundleVersion="([^"]+)"', t)
print(m.group(1) if m else "")
PY
}
# True when $1 is a strictly higher version than $2.
is_newer() {
    python3 - "$1" "$2" <<'PY' 2>/dev/null || echo 0
import sys
key = lambda v: tuple(int(x) if x.isdigit() else 0 for x in v.split(".")) if v else ()
print(1 if key(sys.argv[1]) > key(sys.argv[2]) else 0)
PY
}

# Replace only the panel parts. `rm -rf "$DEST"` used to take lib/ with it, which is
# where an update puts the engine — so re-running this installer after the panel had
# updated itself silently reinstated whatever version this folder happens to hold. That is
# a downgrade, and re-running the installer is exactly what you tell someone to do when a
# panel misbehaves. lib/ is handled below, by version.
#
# ⚠️ AND THE PANEL PARTS NEED THE SAME GUARD, which they did not have until now. Only
# lib/xmlcut.py was version-compared, so an older installer over a panel that had updated
# itself rolled CSXS/client/jsx back and kept the newer engine: measured, a 3.70 folder over
# an installed 3.75 left ExtensionBundleVersion="3.70" and a 3.70 main.js beside VERSION =
# "3.75". The update check reads the ENGINE's version, so that skew then reports "up to date"
# and survives until the next release — old UI, no changelog, the newest number in the header.
# Equal versions still copy: re-running the installer is the documented repair for a panel
# that misbehaves, and that has to keep working.
SRCPV=$(manifest_version "CSXS/manifest.xml")
DSTPV=$(manifest_version "$DEST/CSXS/manifest.xml")
if [ -z "$FORCE" ] && [ -n "$DSTPV" ] && [ -n "$SRCPV" ] && [ "$(is_newer "$DSTPV" "$SRCPV")" = "1" ]; then
    echo "  kept: the installed panel $DSTPV — newer than this folder's $SRCPV"
    echo "        (the panel updated itself; not putting an older UI back)"
    echo "        To roll it back on purpose: bash 'Install xmlcut reader (Mac).command' --force"
else
    for item in CSXS client jsx .debug; do
        rm -rf "$DEST/$item"
    done
    mkdir -p "$DEST"
    for item in CSXS client jsx .debug; do
        [ -e "$item" ] && cp -R "$item" "$DEST/"
    done
    if [ -n "$DSTPV" ]; then
        echo "  panel: ${SRCPV:-?} (was $DSTPV)"
    else
        echo "  panel: ${SRCPV:-?}"
    fi
fi

# xmlcut.py travels INSIDE the panel, as lib/xmlcut.py. The panel used to search
# ~/Desktop for it, which fails when macOS has not granted Premiere access to that
# folder — the file is there and every check says no. The extension directory is one
# Premiere already reads, so a copy here is always reachable. Copied at install time so
# the repository keeps only one xmlcut.py.
if [ -f "../xmlcut.py" ]; then
    mkdir -p "$DEST/lib"
    SRCV=$(version_of "../xmlcut.py")
    DSTV=$(version_of "$DEST/lib/xmlcut.py")
    # --force takes the engine back too. A forced rollback that moved only the panel would
    # recreate by hand the exact skew the guard above exists to prevent.
    if [ -z "$FORCE" ] && [ -n "$DSTV" ] && [ "$(is_newer "$DSTV" "$SRCV")" = "1" ]; then
        echo "  kept: lib/xmlcut.py $DSTV — newer than this folder's $SRCV"
        echo "        (the panel updated itself; not putting an older engine back)"
    else
        cp "../xmlcut.py" "$DEST/lib/xmlcut.py"
        echo "  bundled: lib/xmlcut.py ${SRCV:-?}"
    fi
    # The diagnostics ride along as lib/tools/. They import xmlcut from parent.parent,
    # which from lib/tools/ is lib/ — so they run from in here unchanged. Only touched
    # when this folder actually has them, so an install from a zip does not wipe a set
    # that arrived through an update.
    if [ -d "../tools" ]; then
        mkdir -p "$DEST/lib/tools"
        cp ../tools/*.py "$DEST/lib/tools/" 2>/dev/null || true
        echo "  bundled: lib/tools"
    fi
else
    echo "  !! ../xmlcut.py not found — the panel will have to be pointed at it by hand"
fi
echo "  copied to: $DEST"

# Quiet when something else is doing the talking. The top-level installer and install.sh
# both call this and then print their own closing instructions, so unguarded this said
# "Installed. Now:" twice with two slightly different versions of the same three steps.
if [ -z "${RAWCUTTER_WRAPPED:-}" ]; then
  echo
  echo "Installed. Now:"
  echo "  1. Quit Premiere Pro completely (Cmd-Q), then reopen it."
  echo "  2. Window > Extensions > Raw-cutter"
  echo "  3. Open the sequence you want and click 'Read timeline'."
  echo
  echo "Reads and XML exports land beside your Premiere project, in xmlcut/<sequence>/."
  echo "An unsaved project falls back to ~/Desktop/xmlcut-dumps/. Nothing else is changed."
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
  [ -t 0 ] && read -n 1 -s -r -p "Press any key to close." || true
  echo
fi
