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
