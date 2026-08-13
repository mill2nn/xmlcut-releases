#!/bin/bash
# Install the xmlcut reader panel into Premiere.
#
# Copies this folder to Adobe's CEP extensions directory. The panel is read-only —
# it never modifies your project — so reinstalling is always safe.
set -euo pipefail
cd "$(dirname "$0")"

DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.bom.xmlcutreader"

echo "Installing xmlcut reader..."
echo

# Unsigned panels only load when PlayerDebugMode is set. Premiere 2026 reads CSXS.12,
# but set the older keys too so the panel still loads if you roll back a version.
for v in 9 10 11 12; do
    defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1 2>/dev/null || true
done
echo "  PlayerDebugMode: on"

rm -rf "$DEST"
mkdir -p "$DEST"
# Copy the panel itself, not the installers or anything git-related.
for item in CSXS client jsx .debug; do
    [ -e "$item" ] && cp -R "$item" "$DEST/"
done

# xmlcut.py travels INSIDE the panel, as lib/xmlcut.py. The panel used to search
# ~/Desktop for it, which fails when macOS has not granted Premiere access to that
# folder — the file is there and every check says no. The extension directory is one
# Premiere already reads, so a copy here is always reachable. Copied at install time so
# the repository keeps only one xmlcut.py.
if [ -f "../xmlcut.py" ]; then
    mkdir -p "$DEST/lib"
    cp "../xmlcut.py" "$DEST/lib/xmlcut.py"
    echo "  bundled: lib/xmlcut.py"
else
    echo "  !! ../xmlcut.py not found — the panel will have to be pointed at it by hand"
fi
echo "  copied to: $DEST"

echo
echo "Installed. Now:"
echo "  1. Quit Premiere Pro completely (Cmd-Q), then reopen it."
echo "  2. Window > Extensions > xmlcut reader"
echo "  3. Open the timeline you want and click 'Read active sequence'."
echo
echo "It writes ~/Desktop/xmlcut-dumps/latest.json and changes nothing else."
echo
read -n 1 -s -r -p "Press any key to close."
echo
