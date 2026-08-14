#!/bin/bash
# Remove the Raw-cutter panel. Leaves PlayerDebugMode alone, because other
# unsigned panels on this machine (Omni Link) need it.
set -euo pipefail

DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.bom.xmlcutreader"

if [ -d "$DEST" ]; then
    rm -rf "$DEST"
    echo "Removed: $DEST"
else
    echo "Not installed — nothing to remove."
fi

echo
echo "Any dumps in ~/Desktop/xmlcut-dumps/ were left in place."
echo "Restart Premiere Pro to clear the panel from the Extensions menu."
echo
read -n 1 -s -r -p "Press any key to close."
echo
