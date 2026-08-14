#!/bin/bash
# Install the Raw-cutter panel into Premiere.
#
# Copies this folder to Adobe's CEP extensions directory. The panel is read-only —
# it never modifies your project — so reinstalling is always safe.
set -euo pipefail
cd "$(dirname "$0")"

DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.bom.xmlcutreader"

echo "Installing Raw-cutter..."
echo

# Unsigned panels only load when PlayerDebugMode is set. Premiere 2026 reads CSXS.12,
# but set the older keys too so the panel still loads if you roll back a version.
for v in 9 10 11 12; do
    defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1 2>/dev/null || true
done
echo "  PlayerDebugMode: on"

# Replace only the panel parts. `rm -rf "$DEST"` used to take lib/ with it, which is
# where an update puts the engine — so re-running this installer after the panel had
# updated itself silently reinstated whatever version this folder happens to hold. That is
# a downgrade, and re-running the installer is exactly what you tell someone to do when a
# panel misbehaves. lib/ is handled below, by version.
for item in CSXS client jsx .debug; do
    rm -rf "$DEST/$item"
done
mkdir -p "$DEST"
for item in CSXS client jsx .debug; do
    [ -e "$item" ] && cp -R "$item" "$DEST/"
done

# xmlcut.py travels INSIDE the panel, as lib/xmlcut.py. The panel used to search
# ~/Desktop for it, which fails when macOS has not granted Premiere access to that
# folder — the file is there and every check says no. The extension directory is one
# Premiere already reads, so a copy here is always reachable. Copied at install time so
# the repository keeps only one xmlcut.py.
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
# True when $1 is a strictly higher version than $2.
is_newer() {
    python3 - "$1" "$2" <<'PY' 2>/dev/null || echo 0
import sys
key = lambda v: tuple(int(x) if x.isdigit() else 0 for x in v.split(".")) if v else ()
print(1 if key(sys.argv[1]) > key(sys.argv[2]) else 0)
PY
}

if [ -f "../xmlcut.py" ]; then
    mkdir -p "$DEST/lib"
    SRCV=$(version_of "../xmlcut.py")
    DSTV=$(version_of "$DEST/lib/xmlcut.py")
    if [ -n "$DSTV" ] && [ "$(is_newer "$DSTV" "$SRCV")" = "1" ]; then
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

echo
echo "Installed. Now:"
echo "  1. Quit Premiere Pro completely (Cmd-Q), then reopen it."
echo "  2. Window > Extensions > Raw-cutter"
echo "  3. Open the timeline you want and click 'Read active sequence'."
echo
echo "Reads and XML exports land beside your Premiere project, in xmlcut/<sequence>/."
echo "An unsaved project falls back to ~/Desktop/xmlcut-dumps/. Nothing else is changed."
echo
read -n 1 -s -r -p "Press any key to close."
echo
