/* xmlcut panel — read the active sequence, then cut it.
 *
 * The panel is a front end only. Reading is ExtendScript (host.jsx); cutting is
 * xmlcut.py, spawned as a child process. Nothing about timing, seeking or encoding
 * lives here — that code is verified frame-exact against a fixture, and a second
 * implementation in JavaScript would be a second thing to be wrong.
 */
(function () {
    "use strict";

    var cs = new CSInterface();
    var node = (typeof window.cep_node !== "undefined") ? window.cep_node : null;
    var fs = node ? node.require("fs") : null;
    var path = node ? node.require("path") : null;
    var spawn = node ? node.require("child_process").spawn : null;

    /* CEP does not inherit a login shell's PATH, so Homebrew's ffmpeg is invisible to
     * a spawned process unless it is put back. Without this, export fails with
     * "ffmpeg not found" inside the panel while working fine in Terminal. */
    var PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

    var el = {};
    var ids = ["read", "seqbox", "seqname", "seqmeta", "seqwarn", "opts", "types",
               "outpath", "pickout", "export", "prog", "barfill", "progtext",
               "cancel", "reveal", "again", "err", "adv", "scriptpath",
               "pickscript", "cmd", "log", "tip", "ver", "mode", "step3",
               "report", "tally", "rows", "onlyprob", "repcount", "copyrep",
               "readhint", "scanning", "tablewrap", "cliptable", "clipbody",
               "listnote", "listlbl", "savedbox", "savedpath", "showsaved",
               "mergebox", "resume", "savednote", "updbar", "updtext", "updbtn",
               "typehint", "typeall", "scripthelp"];
    for (var i = 0; i < ids.length; i++) el[ids[i]] = document.getElementById(ids[i]);

    var state = {
        dump: null,          // this read's .json, beside the project
        folder: "",          // where this read's files landed
        xml: null,           // path to the auto-exported FCP7 XML, when it worked
        xmlMethod: "",       // which host API produced it
        info: null,          // summary returned by the ExtendScript
        types: {},           // ext -> {count, on}
        out: "",
        script: "",
        python: "",
        proc: null,
        total: 0,
        clips: [],       // the cut list, from a --manifest-only scan
        report: [],      // rows built from the manifest after a run
        merge: [],       // the '++' lines xmlcut printed about the merge
        busy: false,
        resume: false,
        typesReset: "",
        hostHome: "",
        searchTried: [],
        updateInfo: null
    };

    /* One flag for the whole read → export XML → scan sequence.
     *
     * Re-enabling the Read button inside the evalScript callback left it live while the
     * XML export and the scan were still running, so a second click started a second
     * export and a second --manifest-only process writing the same scan folder. */
    function setBusy(on, label) {
        state.busy = !!on;
        el.read.disabled = state.busy;
        el.pickout.disabled = state.busy;
        el.pickscript.disabled = state.busy;
        el.resume.disabled = state.busy;
        el.read.textContent = (state.busy && label) ? label
                                                    : "Read timeline & export XML";
        refreshExportEnabled();
    }

    /* Both the scan and the export invoke xmlcut the same way — only the output folder
     * and whether the type filter applies differ. Building the argv in one place keeps
     * the preview honest: if it were assembled differently it could show a list the
     * export would not produce. */
    function argsFor(outDir, allTypes) {
        var args;
        if (state.xml) {
            // The XML is the base, the dump the overlay. --sequence is always passed: a
            // sequence-level export holds only this one, but the project-level fallback
            // holds them all, and xmlcut refuses to guess between them.
            args = [state.script, state.xml,
                    "--sequence", state.info.sequence,
                    "--panel", state.dump,
                    "-o", outDir];
        } else {
            args = [state.script, state.dump, "-o", outDir];
        }
        if (!allTypes) {
            var exts = selectedExts();
            if (exts.length) args.push("--ext", exts.join(","));
        }
        return args;
    }

    function spawnOpts() {
        return {
            cwd: path.dirname(state.script),
            // A bare env means the C locale, and Python then cannot print a Vietnamese
            // filename to stdout without raising. Pin UTF-8.
            env: {
                PATH: PATH,
                HOME: homeDir(),
                LANG: "en_US.UTF-8",
                PYTHONIOENCODING: "utf-8"
            }
        };
    }

    /* A stable colour per source type, so a timeline of mixed media is scannable at a
     * glance. Families share a hue — camera video blue/purple, stills green, audio
     * amber, project files red — because what usually matters is "is this footage or
     * is this a graphic", not which exact container it came in. */
    var TYPE_COLORS = {
        mp4: "#4a90d9", m4v: "#4a90d9", avi: "#4a90d9", webm: "#4a90d9",
        mov: "#8e6fd9", qt: "#8e6fd9",
        mxf: "#3f9e8c", mts: "#3f9e8c", m2ts: "#3f9e8c", mpg: "#3f9e8c",
        mpeg: "#3f9e8c", ts: "#3f9e8c",
        r3d: "#c0603f", braw: "#c0603f", ari: "#c0603f", dng: "#c0603f",
        png: "#4fa85f", jpg: "#4fa85f", jpeg: "#4fa85f", tif: "#4fa85f",
        tiff: "#4fa85f", bmp: "#4fa85f", gif: "#4fa85f", webp: "#4fa85f",
        psd: "#7fae4a", psb: "#7fae4a", ai: "#7fae4a",
        wav: "#c99a3f", mp3: "#c99a3f", aif: "#c99a3f", aiff: "#c99a3f",
        m4a: "#c99a3f", aac: "#c99a3f", flac: "#c99a3f",
        aep: "#c05c5c", prproj: "#c05c5c", c4d: "#c05c5c", aet: "#c05c5c",
        ppj: "#c05c5c", fcpxml: "#c05c5c"
    };
    var FALLBACK_COLORS = ["#5b8fc9", "#9a7bc8", "#4f9e86", "#b98a44",
                           "#b3695f", "#7d9a4a", "#a86fa0", "#5f9aa8"];

    function colorFor(ext) {
        if (TYPE_COLORS[ext]) return TYPE_COLORS[ext];
        if (ext === "(none)") return "#6a6a6a";
        // Deterministic, so the same extension keeps its colour between runs.
        var h = 0;
        for (var i = 0; i < ext.length; i++) h = (h * 31 + ext.charCodeAt(i)) % 9973;
        return FALLBACK_COLORS[h % FALLBACK_COLORS.length];
    }

    /* Which types were ticked last time, by extension. Remembered across reads and
     * across restarts — on a repeating job the same handful of types get switched off
     * every single time otherwise. */
    function savedTypeChoices() {
        try {
            var raw = window.localStorage.getItem("xmlcut.types");
            var o = raw ? JSON.parse(raw) : null;
            return (o && typeof o === "object") ? o : {};
        } catch (e) {
            return {};
        }
    }

    function rememberTypeChoices() {
        var o = savedTypeChoices();
        for (var k in state.types) {
            if (state.types.hasOwnProperty(k)) o[k] = !!state.types[k].on;
        }
        try {
            window.localStorage.setItem("xmlcut.types", JSON.stringify(o));
        } catch (e) {}
    }

    /* ------------------------------------------------------------ helpers */

    function esc(s) {
        return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
                        .replace(/>/g, "&gt;");
    }

    function show(node_, on) { node_.hidden = !on; }

    function log(line) {
        if (el.log.textContent === "—") el.log.textContent = "";
        el.log.textContent += line + "\n";
        el.log.scrollTop = el.log.scrollHeight;
    }

    function fail(msg) {
        el.err.textContent = String(msg);
        show(el.err, true);
        log("ERROR " + msg);
    }

    function clearError() { show(el.err, false); }

    function exists(p) {
        try { return !!p && fs.existsSync(p); } catch (e) { return false; }
    }

    /* Keep the tail of a path, which is the part that identifies it. The panel can be
     * dragged very narrow, so this is a hard cap rather than a CSS ellipsis. */
    function shortPath(p, keep) {
        p = String(p || "");
        if (p.length <= keep) return p;
        var parts = p.split("/");
        var tail = parts.pop() || "";
        var out = tail;
        while (parts.length) {
            var next = parts.pop();
            if (next === "") continue;
            if (("…/" + next + "/" + out).length > keep) break;
            out = next + "/" + out;
        }
        // A single component longer than the cap has nothing to drop, and prefixing it
        // would make the label longer than the path it is shortening.
        if (out.length + 2 > keep) return "…" + out.substring(out.length - keep + 1);
        return "…/" + out;
    }

    function setPathLabel(node_, full, keep) {
        node_.textContent = full ? shortPath(full, keep) : "—";
        node_.title = full || "";
    }

    /* ------------------------------------------------- locating the tool */

    /* Every way a CEP panel can learn where home is.
     *
     * `cep_node.process` is not guaranteed — the Node globals a panel gets vary with the
     * CEP version — and a single failed lookup here silently turned every candidate path
     * into "/Desktop/xmlcut/xmlcut.py", which of course does not exist. Ask everything
     * available and keep whatever answers. */
    function homeDirs() {
        var out = [], seen = {};
        function add(h) {
            if (h && typeof h === "string" && h.charAt(0) === "/" && !seen[h]) {
                seen[h] = 1;
                out.push(h.replace(/\/+$/, ""));
            }
        }
        try { if (node && node.process && node.process.env) add(node.process.env.HOME); } catch (e) {}
        try { if (typeof process !== "undefined" && process.env) add(process.env.HOME); } catch (e) {}
        try { add(node.require("os").homedir()); } catch (e) {}
        try { add(node.process.env.USER ? "/Users/" + node.process.env.USER : ""); } catch (e) {}
        add(state.hostHome);          // whatever ExtendScript said, once it has answered
        return out;
    }

    function homeDir() {
        var h = homeDirs();
        return h.length ? h[0] : "";
    }

    /* xmlcut.py is not inside the panel — the panel is installed into Adobe's
     * extensions folder, the tool lives wherever he keeps it. Guess the usual spots,
     * remember what worked, and let him point at it when the guess is wrong.
     *
     * `state.searchTried` records every path examined, because a silent "not found" for
     * a file that is plainly there is impossible to debug. On modern macOS ~/Desktop and
     * ~/Documents are TCC-protected, so until Premiere has Files-and-Folders access a
     * stat from in here says no for a file you can see in Finder. */
    function findScript() {
        state.searchTried = [];
        var saved = null;
        try { saved = window.localStorage.getItem("xmlcut.script"); } catch (e) {}

        function tryPath(p) {
            if (!p) return false;
            state.searchTried.push(p);
            return exists(p);
        }

        if (tryPath(saved)) return saved;

        var homes = homeDirs();
        var subs = ["/Desktop/xmlcut", "/xmlcut", "/Documents/xmlcut",
                    "/Movies/xmlcut", "/Downloads/xmlcut",
                    "/Desktop/xmlcut-main", "/Documents/xmlcut-main"];
        var i, j;
        for (i = 0; i < homes.length; i++) {
            for (j = 0; j < subs.length; j++) {
                var cand = homes[i] + subs[j] + "/xmlcut.py";
                if (tryPath(cand)) return cand;
            }
        }

        // One level down, so a folder called anything still turns up.
        var scanRoots = [];
        for (i = 0; i < homes.length; i++) {
            scanRoots.push(homes[i] + "/Desktop", homes[i] + "/Documents", homes[i]);
        }
        for (i = 0; i < scanRoots.length; i++) {
            var names;
            try {
                names = fs.readdirSync(scanRoots[i]);
            } catch (e) {
                continue;
            }
            for (j = 0; j < names.length && j < 80; j++) {
                if (names[j].charAt(0) === ".") continue;
                var p2 = scanRoots[i] + "/" + names[j] + "/xmlcut.py";
                if (tryPath(p2)) return p2;
            }
        }
        return "";
    }

    function findPython() {
        var tries = ["/usr/bin/python3", "/opt/homebrew/bin/python3",
                     "/usr/local/bin/python3"];
        for (var i = 0; i < tries.length; i++) {
            if (exists(tries[i])) return tries[i];
        }
        return "python3";
    }

    function setScript(p) {
        state.script = p || "";
        if (state.script) {
            setPathLabel(el.scriptpath, state.script, 40);
            show(el.scripthelp, false);
        } else {
            el.scriptpath.textContent = "not found — click Find";
            // A silent failure for a file that is visibly there is the worst outcome, so
            // name the likely cause and every path that was checked.
            var tried = state.searchTried || [];
            el.scripthelp.textContent =
                "Looked in " + tried.length + " place(s) and found no xmlcut.py. If it IS "
                + "on your Desktop, macOS is probably blocking Premiere from reading that "
                + "folder — System Settings > Privacy & Security > Files and Folders > "
                + "Adobe Premiere Pro, switch on Desktop Folder, then restart Premiere. "
                + "Or just press Find and point at it.";
            show(el.scripthelp, true);
            for (var t = 0; t < tried.length; t++) log("looked for xmlcut.py: " + tried[t]);
        }
        if (state.script) {
            try { window.localStorage.setItem("xmlcut.script", state.script); } catch (e) {}
            var dir = path.dirname(state.script);
            el.cmd.textContent = 'cd "' + dir + '" && ' + state.python
                + ' tools/compare_panel.py "MY_TIMELINE.xml"';
        }
        refreshExportEnabled();
    }

    /* ------------------------------------------------------------ reading */

    function readSequence() {
        clearError();
        setBusy(true, "Reading…");
        state.merge = [];
        show(el.mergebox, false);
        show(el.report, false);
        show(el.prog, false);

        cs.evalScript("dumpActiveSequence()", function (raw) {
            var r;
            try {
                r = JSON.parse(raw);
            } catch (e) {
                setBusy(false);
                fail("Premiere did not return a readable reply:\n" + raw);
                return;
            }
            if (!r.ok) {
                setBusy(false);
                fail(r.error || "unknown error");
                show(el.seqbox, false);
                show(el.opts, false);
                show(el.step3, false);
                return;
            }
            state.info = r;
            state.dump = r.path;
            state.folder = r.folder || path.dirname(r.path);
            log("read " + r.sequence + " -> " + r.path);
            setPathLabel(el.savedpath, state.folder, 40);
            show(el.savedbox, true);
            // Say what the folder is costing, since it can sit on a shared drive where
            // every read syncs ~1 MB to the whole team.
            var keep = r.keep_reads || 10;
            var note = "a new pair each read · newest " + keep + " kept";
            if (r.pruned) note += " · " + r.pruned + " older file(s) pruned";
            if (r.beside_project === false) {
                note += " · project unsaved, so this is the Desktop";
                log("project not saved — falling back to the Desktop");
            }
            el.savednote.textContent = note;
            renderSequence();
            exportXML();
        });
    }

    /* Ask Premiere for a Final Cut Pro 7 XML of the same sequence.
     *
     * The XML is the base for cutting because it is the path with the fixture behind
     * it and the only one that resolves nested sequences; the dump is overlaid on it
     * for the speed-ramp keyframes and the live media paths. When the export is not
     * available, the dump alone still cuts — with nests skipped, which the UI says. */
    function exportXML() {
        state.xml = null;
        state.xmlMethod = "";
        setMode("Exporting XML…");
        var dest = state.dump.replace(/\.json$/i, ".xml");
        cs.evalScript('exportSequenceXML("' + dest.replace(/"/g, '\\"') + '")',
            function (raw) {
                var r;
                try {
                    r = JSON.parse(raw);
                } catch (e) {
                    log("xml export: unreadable reply: " + raw);
                    setMode(null);
                    return;
                }
                for (var i = 0; i < (r.tried || []).length; i++) {
                    log("xml export · " + r.tried[i]);
                }
                if (r.ok) {
                    state.xml = r.path;
                    state.xmlMethod = r.method;
                    log("xml export: " + r.path + " (" + r.bytes + " bytes)");
                } else {
                    log("xml export failed: " + (r.error || "unknown"));
                }
                setMode(null);
                refreshExportEnabled();
                // The cut list can only be produced once we know whether there is an
                // XML to base it on, so it waits for the export attempt to settle.
                if (state.script) scanClips();
                else log("skipping the cut list: xmlcut.py not located yet");
            });
    }

    /* One line saying exactly which sources the next export will use. Guessing about
     * accuracy is worse than being told. */
    function setMode(busyText) {
        if (busyText) {
            el.mode.textContent = busyText;
            el.mode.className = "mode busy";
            show(el.mode, true);
            return;
        }
        if (state.xml) {
            el.mode.textContent = "XML + Premiere · nests resolved, ramp keyframes read";
            el.mode.className = "mode good";
        } else {
            el.mode.textContent = "Premiere only · XML export unavailable, "
                + "nested sequences will be skipped";
            el.mode.className = "mode warnmode";
        }
        show(el.mode, true);
    }

    /* Read the dump back off disk to build the type list. The ExtendScript already
     * wrote it, so re-deriving here beats passing a second copy across the boundary. */
    /* Build the type list from the CUT LIST, not from the raw panel read.
     *
     * The read sees a nested sequence as one clip with no media path, so three .mov
     * clips inside a nest showed up as ".(none) 3" while the table below listed them
     * correctly by name — and unticking a type then filtered something other than what
     * was on screen. The scan's manifest has nests resolved, which is what the export
     * will actually cut.
     */
    function typesFromClips() {
        var remembered = savedTypeChoices();
        state.types = {};
        state.total = 0;

        function ensure(ext) {
            if (!state.types[ext]) {
                var on;
                if (remembered.hasOwnProperty(ext)) on = !!remembered[ext];
                else on = !DEAD_TYPES[ext];   // project files start off
                state.types[ext] = { count: 0, on: on };
            }
            return state.types[ext];
        }

        for (var i = 0; i < state.clips.length; i++) {
            var t = ensure(state.clips[i].ext);
            t.count++;
            state.total++;
        }
        // The stable set, plus anything a previous project taught us he cares about.
        for (var a = 0; a < ALWAYS_TYPES.length; a++) ensure(ALWAYS_TYPES[a]);
        for (var k in remembered) {
            if (remembered.hasOwnProperty(k) && k !== "(none)") ensure(k);
        }

        /* NEVER open in a state where nothing can be cut.
         *
         * Remembering choices plus always listing .mp4 combined into a trap: a .mov
         * timeline opened with .mp4 ticked (remembered from another project, count 0)
         * and .mov unticked (remembered from before it was even read correctly), so the
         * panel said "0 of 0 cuttable · Nothing selected" and gave no hint why.
         *
         * A remembered "off" on the only type a timeline actually contains is not a
         * decision anyone made about THIS timeline, so the present types are switched
         * back on and the panel says it did that. */
        state.typesReset = "";
        var present = presentCuttable();
        var anyOn = false;
        for (var q = 0; q < present.length; q++) {
            if (state.types[present[q]].on) anyOn = true;
        }
        if (present.length && !anyOn) {
            var turned = [];
            for (var w = 0; w < present.length; w++) {
                state.types[present[w]].on = true;
                turned.push("." + present[w]);
            }
            rememberTypeChoices();
            state.typesReset = turned.join(" and ");
        }
        return true;
    }

    /* Types this timeline actually has AND that can be decoded — the set that has to
     * contain at least one ticked entry for the export to do anything. */
    function presentCuttable() {
        var out = [];
        for (var k in state.types) {
            if (state.types.hasOwnProperty(k) && state.types[k].count > 0
                && !DEAD_TYPES[k] && k !== "(none)") {
                out.push(k);
            }
        }
        out.sort();
        return out;
    }

    // Not decodable media, so they start unticked rather than failing one by one during
    // the export. Overridden by anything remembered from last time.
    var DEAD_TYPES = { aep: 1, prproj: 1, psb: 1, c4d: 1, aet: 1, ppj: 1, fcpxml: 1 };

    /* Always listed, even when the open timeline has none of them.
     *
     * A chip list that only shows what happens to be on THIS timeline changes shape
     * between projects, so a type you rely on looks like it went missing — .mp4 is
     * absent from a .mov shoot and present in the next one. Showing them at zero keeps
     * the list stable and lets a preference be set once and remembered. They are dimmed
     * and cannot be mistaken for something that will be cut. */
    var ALWAYS_TYPES = ["mp4", "mov", "png"];

    function renderSequence() {
        var r = state.info;
        el.seqname.textContent = r.sequence;
        // Premiere's own count, which sees a nested sequence as ONE clip. The cut list
        // below resolves nests, so its total is usually higher — saying which is which
        // stops the two numbers looking like a contradiction.
        el.seqmeta.textContent = (Math.round(r.fps * 1000) / 1000) + " fps · "
            + r.video_clips + " video clip" + (r.video_clips === 1 ? "" : "s")
            + " as Premiere counts them";
        show(el.seqbox, true);

        if (r.keyframed_ramps > 0) {
            el.seqwarn.textContent = r.keyframed_ramps + " clip"
                + (r.keyframed_ramps === 1 ? " has" : "s have")
                + " a keyframed speed ramp. The range extracted is exact; the speed "
                + "is treated as constant.";
            show(el.seqwarn, true);
        } else {
            show(el.seqwarn, false);
        }

        // Types and the clip table are both built by the scan, which runs after the XML
        // export settles — so they can never disagree about what is being cut.
        show(el.readhint, false);
        refreshExportEnabled();
    }

    function renderTypes() {
        el.types.innerHTML = "";
        var exts = [];
        for (var k in state.types) if (state.types.hasOwnProperty(k)) exts.push(k);
        // On this timeline first, most numerous first within that; the zero-count ones
        // trail behind so the list reads as "what you have, then what you could have".
        exts.sort(function (a, b) {
            var ca = state.types[a].count, cb = state.types[b].count;
            if ((ca === 0) !== (cb === 0)) return ca === 0 ? 1 : -1;
            var d = cb - ca;
            return d !== 0 ? d : (a < b ? -1 : a > b ? 1 : 0);
        });
        for (var i = 0; i < exts.length; i++) {
            (function (ext) {
                var t = state.types[ext];
                var col = colorFor(ext);
                var absent = (t.count === 0);
                var chip = document.createElement("label");
                chip.className = "chip " + (t.on ? "on" : "off")
                    + (absent ? " absent" : "");
                if (absent) {
                    chip.title = "no ." + ext + " on this timeline — ticking it is "
                        + "remembered for the next one";
                }
                // The colour is per type and set inline, since it is data-driven — a
                // class per extension would mean editing CSS for every new format.
                chip.style.borderColor = (t.on && !absent) ? col : "";
                chip.style.background = (t.on && !absent) ? tint(col) : "";

                var box = document.createElement("input");
                box.type = "checkbox";
                box.checked = t.on;
                box.addEventListener("change", function () {
                    t.on = box.checked;
                    chip.className = "chip " + (t.on ? "on" : "off")
                        + (absent ? " absent" : "");
                    chip.style.borderColor = (t.on && !absent) ? col : "";
                    chip.style.background = (t.on && !absent) ? tint(col) : "";
                    state.typesReset = "";
                    rememberTypeChoices();
                    refreshExportEnabled();
                    // Re-filtered and renumbered locally — no need to re-run the scan,
                    // because hiding rows in order reproduces xmlcut's own indices.
                    if (state.clips.length) renderClips();
                });
                chip.appendChild(box);

                var dot = document.createElement("span");
                dot.className = "dot";
                dot.style.background = col;
                chip.appendChild(dot);

                chip.appendChild(document.createTextNode("." + ext));
                var n = document.createElement("span");
                n.className = "n";
                n.textContent = t.count;
                chip.appendChild(n);
                el.types.appendChild(chip);
            })(exts[i]);
        }
    }

    /* A translucent wash of the type's colour, so a ticked chip reads as that type
     * without the text losing contrast against it. */
    function tint(hex) {
        var r = parseInt(hex.substring(1, 3), 16);
        var g = parseInt(hex.substring(3, 5), 16);
        var b = parseInt(hex.substring(5, 7), 16);
        return "rgba(" + r + "," + g + "," + b + ",0.18)";
    }

    function selectedCount() {
        var n = 0;
        for (var k in state.types) {
            if (state.types.hasOwnProperty(k) && state.types[k].on) {
                n += state.types[k].count;
            }
        }
        return n;
    }

    function selectedExts() {
        var out = [];
        for (var k in state.types) {
            if (state.types.hasOwnProperty(k) && state.types[k].on && k !== "(none)") {
                out.push(k);
            }
        }
        return out;
    }

    function typeHint() {
        if (state.typesReset) {
            return "Nothing was selected, so " + state.typesReset
                 + " — the types on this timeline — were switched back on.";
        }
        var n = selectedCount();
        if (n > 0) return "";
        var present = presentCuttable();
        if (!present.length) {
            return "This timeline has no media that can be cut.";
        }
        var names = [];
        for (var i = 0; i < present.length; i++) {
            names.push("." + present[i] + " (" + state.types[present[i]].count + ")");
        }
        return "Nothing selected. This timeline has " + names.join(", ")
             + " — tick one of those. A type showing 0 has none on this timeline.";
    }

    function refreshExportEnabled() {
        var n = selectedCount();
        if (el.typehint) {
            var h = typeHint();
            el.typehint.textContent = h;
            el.typehint.className = "typehint" + (state.typesReset ? " fixed" : "");
            show(el.typehint, !!h);
        }
        var ready = !!(state.dump && state.script && state.out && n > 0);
        el["export"].disabled = !ready;
        el["export"].textContent = n > 0
            ? ("Export " + n + " clip" + (n === 1 ? "" : "s"))
            : "Nothing selected";
        if (!state.script && state.dump) {
            el["export"].textContent = "Find xmlcut.py first";
            el.adv.open = true;
        }
    }

    /* ----------------------------------------------------------- exporting */

    function setOut(p) {
        state.out = p || "";
        setPathLabel(el.outpath, state.out, 40);
        try { window.localStorage.setItem("xmlcut.out", state.out); } catch (e) {}
        refreshExportEnabled();
    }

    function doExport() {
        clearError();
        var args = argsFor(state.out, false);
        if (state.resume) args.push("--resume");

        // Remember the manifest's mtime BEFORE starting. Cancelling used to leave the
        // previous run's manifest in place, which then rendered as though it described
        // the run that was just abandoned.
        state.manifestBefore = manifestMtime();

        show(el.opts, false);
        show(el.step3, false);
        show(el.report, false);
        show(el.prog, true);
        el.barfill.style.width = "0";
        el.progtext.textContent = "Starting…";
        setBusy(true, "Exporting…");

        log("$ " + state.python + " " + args.join(" "));

        var proc;
        try {
            proc = spawn(state.python, args, spawnOpts());
        } catch (e) {
            show(el.prog, false);
            show(el.opts, true);
            show(el.step3, true);
            setBusy(false);
            fail("Could not start python3:\n" + e);
            return;
        }
        state.proc = proc;

        var tail = "";
        var stderr = "";

        function onLine(line) {
            if (!line) return;
            log(line);
            // xmlcut prefixes anything the merge decided with '++'. Those lines explain
            // why a clip kept the XML's values, or which paths were repaired, and they
            // were previously only visible by opening the Advanced log.
            var mm = line.match(/^\s*\+\+\s*(.+)$/);
            if (mm) {
                state.merge.push(mm[1]);
                return;
            }
            // xmlcut prints "  [7/18] OK  name.mp4" per clip.
            var m = line.match(/\[(\d+)\/(\d+)\]\s+(\S+)\s*(.*)$/);
            if (m) {
                var done = parseInt(m[1], 10), all = parseInt(m[2], 10);
                el.barfill.style.width = Math.round(done / all * 100) + "%";
                el.progtext.textContent = "[" + done + "/" + all + "] " + (m[4] || m[3]);
                return;
            }
            if (line.indexOf("Cutting with") === 0 || line.indexOf("  Cutting") === 0) {
                el.progtext.textContent = "Encoding…";
            }
        }

        proc.stdout.on("data", function (chunk) {
            tail += chunk.toString();
            var parts = tail.split("\n");
            tail = parts.pop();
            for (var i = 0; i < parts.length; i++) onLine(parts[i].replace(/\r$/, ""));
        });

        proc.stderr.on("data", function (chunk) {
            stderr += chunk.toString();
        });

        proc.on("error", function (e) {
            show(el.prog, false);
            show(el.opts, true);
            show(el.step3, true);
            setBusy(false);
            fail("python3 could not run:\n" + e);
        });

        proc.on("close", function (code) {
            state.proc = null;
            if (tail) onLine(tail);
            setBusy(false);
            show(el.prog, false);

            if (stderr) log("stderr: " + stderr);

            // A non-zero exit still leaves a manifest behind when some clips were
            // written, so the report is built either way — a partial run is exactly
            // when knowing which clips made it matters most.
            var built = buildReport();
            if (built) {
                renderReport();
                show(el.report, true);
            }

            if (code === 0) {
                if (!built) fail("The run finished but wrote no manifest to report on.");
            } else if (code === null) {
                log("cancelled");
                if (!built) {
                    show(el.opts, true);
                    show(el.step3, true);
                }
            } else {
                show(el.opts, true);
                show(el.step3, true);
                fail("xmlcut exited with code " + code
                     + (stderr ? ("\n" + stderr.split("\n").slice(-6).join("\n")) : "")
                     + "\nOpen Advanced for the full log.");
            }
        });
    }

    /* -------------------------------------------------- the clip list */

    /* Run xmlcut with --manifest-only to get the real cut list without encoding a
     * frame, then show it. Deriving this in JavaScript from the dump would mean a
     * second implementation of the tick maths, drifting from the one that is tested —
     * so the preview is produced by exactly the code that will do the cutting. */
    function scanClips() {
        state.clips = [];
        show(el.tablewrap, false);
        show(el.scanning, true);
        el.listnote.textContent = "";

        var scanDir = path.join(path.dirname(state.dump), "scan");
        var args = argsFor(scanDir, /* allTypes */ true);
        args.push("--manifest-only");
        log("$ " + state.python + " " + args.join(" "));

        var proc;
        try {
            proc = spawn(state.python, args, spawnOpts());
        } catch (e) {
            show(el.scanning, false);
            setBusy(false);
            fail("Could not read the cut list:\n" + e);
            return;
        }
        var errbuf = "";
        var stail = "";
        proc.stdout.on("data", function (c) {
            stail += String(c);
            var parts = stail.split("\n");
            stail = parts.pop();
            for (var i = 0; i < parts.length; i++) {
                var ln = parts[i].replace(/\r$/, "");
                if (ln) log(ln);
                var mm = ln.match(/^\s*\+\+\s*(.+)$/);
                if (mm) state.merge.push(mm[1]);
            }
        });
        proc.stderr.on("data", function (c) { errbuf += String(c); });
        proc.on("error", function (e) {
            show(el.scanning, false);
            setBusy(false);
            fail("Could not read the cut list:\n" + e);
        });
        proc.on("close", function (code) {
            show(el.scanning, false);
            if (errbuf) log("stderr: " + errbuf);
            if (code !== 0) {
                setBusy(false);
                fail("Reading the cut list failed (exit " + code + ")."
                     + (errbuf ? "\n" + errbuf.split("\n").slice(-4).join("\n") : "")
                     + "\nYou can still export; the list just isn't shown.");
                return;
            }
            if (loadClips(scanDir)) {
                typesFromClips();
                renderTypes();
                renderClips();
                show(el.tablewrap, true);
                show(el.opts, true);
                show(el.step3, true);
            }
            renderMerge();
            setBusy(false);
        });
    }

    function loadClips(dir) {
        var data;
        try {
            data = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
        } catch (e) {
            log("no cut list to show: " + e);
            return false;
        }
        state.clips = [];
        var clips = data.clips || [];
        for (var i = 0; i < clips.length; i++) {
            var c = clips[i];
            var src = String(c.source_path || "");
            var dot = src.lastIndexOf(".");
            var ext = dot > 0 ? src.substring(dot + 1).toLowerCase() : "(none)";
            // Status, notes and severity come from the manifest, which xmlcut fills in
            // via describe() — the same function the browser GUI uses. There used to be
            // a second copy of this logic here and the two had already drifted.
            var cuttable = (c.cuttable === true);
            var status = String(c.display_status || "");
            var notes = String(c.display_notes || "");
            var kind = String(c.display_kind || "") || "ok";
            var spd = Number(c.speed_percent || 100);

            state.clips.push({
                ext: ext,
                group: cuttable ? 0 : 1,
                tc: String(c.timeline_in_tc || ""),
                clip: String(c.clip_name || ""),
                speed: (Math.round(spd * 100) / 100) + "%" + (c.reversed ? " ⏪" : ""),
                timing: String(c.timing_source || ""),
                frames: Number(c.source_consumed_frames || 0),
                status: status,
                notes: notes,
                kind: kind,
                source: src
            });
        }
        return true;
    }

    /* Rows for switched-off types are hidden and the rest are renumbered in place.
     * That is not cosmetic: xmlcut filters by type and THEN assigns 1..N in the same
     * order, so renumbering the visible rows reproduces exactly the indices the
     * filenames will carry. */
    function renderClips() {
        var body = el.clipbody;
        body.innerHTML = "";
        var visible = [];
        for (var i = 0; i < state.clips.length; i++) {
            var r = state.clips[i];
            var on = state.types[r.ext] ? state.types[r.ext].on : true;
            if (on) visible.push(r);
        }

        // Numbered in TIMELINE order — the order the manifest is already in — because
        // that is the order xmlcut assigns 1..N in after its own type filtering. Only
        // then are the uncuttable ones sorted to the bottom for display, carrying the
        // number they were given. Numbering after that sort would put an offline clip
        // at the end with a number it will never have.
        for (var q = 0; q < visible.length; q++) visible[q].n = q + 1;
        visible = visible.slice().sort(function (a, b) { return a.group - b.group; });

        var dividerDone = false;
        for (var j = 0; j < visible.length; j++) {
            var v = visible[j];
            if (v.group === 1 && !dividerDone) {
                dividerDone = true;
                var dr = document.createElement("tr");
                dr.className = "divider";
                var dc = document.createElement("td");
                dc.setAttribute("colspan", "8");
                dc.textContent = "cannot be cut — fix these or untick their type";
                dr.appendChild(dc);
                body.appendChild(dr);
            }
            var tr = document.createElement("tr");
            tr.className = "k-" + v.kind;
            var cells = [
                [pad2(v.n), ""], [v.tc, ""], [v.clip, "clipname"], [v.speed, ""],
                [v.timing, ""], [String(v.frames), "num"], [v.status, ""], [v.notes, ""]
            ];
            for (var k = 0; k < cells.length; k++) {
                var td = document.createElement("td");
                if (cells[k][1]) td.className = cells[k][1];
                td.textContent = cells[k][0];
                if (k === 2) {
                    td.title = v.source || v.clip;
                    // The REAL extension, shown because the Clip column is Premiere's
                    // clip NAME, not the filename. A clip called "shot.mov" can easily
                    // be backed by an .mp4 after a transcode or a relink, and then the
                    // type chips look wrong when they are in fact right. Showing both
                    // makes that visible instead of confusing.
                    var tag = document.createElement("span");
                    tag.className = "exttag";
                    tag.textContent = v.ext;
                    tag.style.color = colorFor(v.ext);
                    td.insertBefore(tag, td.firstChild);
                    var d = document.createElement("span");
                    d.className = "dot";
                    d.style.background = colorFor(v.ext);
                    td.insertBefore(d, td.firstChild);
                }
                tr.appendChild(td);
            }
            body.appendChild(tr);
        }
        var cut = 0;
        for (var m = 0; m < visible.length; m++) if (visible[m].group === 0) cut++;
        el.listnote.textContent = cut + " of " + visible.length + " cuttable";
    }

    function pad2(n) { return (n < 10 ? "0" : "") + n; }

    /* The merge's own explanations, promoted out of the Advanced log. These say why a
     * clip kept the XML's values, and which media paths were repaired. */
    function renderMerge() {
        el.mergebox.innerHTML = "";
        if (!state.merge.length) {
            show(el.mergebox, false);
            return;
        }
        for (var i = 0; i < state.merge.length; i++) {
            var d = document.createElement("div");
            d.className = "mergeline";
            d.textContent = state.merge[i];
            el.mergebox.appendChild(d);
        }
        show(el.mergebox, true);
    }

    /* ------------------------------------------------------------ updates */

    /* The panel does not implement any of this — it shells out to xmlcut.py, which
     * already knows how to check the channel, validate a download and roll back. A
     * second implementation in JavaScript would be a second thing to get wrong, and
     * this one would be the one running unattended on a teammate's machine.
     *
     * xmlcut.py also refreshes panel/ and copies it into Adobe's extensions folder, so
     * a teammate never re-downloads anything: they install once, and every release
     * after that arrives through this button. */
    function runJson(extraArgs, done) {
        if (!state.script) { done(null, "xmlcut.py not located"); return; }
        var args = [state.script].concat(extraArgs);
        var proc;
        try {
            proc = spawn(state.python, args, spawnOpts());
        } catch (e) {
            done(null, String(e));
            return;
        }
        var out = "", err = "";
        proc.stdout.on("data", function (c) { out += String(c); });
        proc.stderr.on("data", function (c) { err += String(c); });
        proc.on("error", function (e) { done(null, String(e)); });
        proc.on("close", function () {
            // The JSON is the LAST line: an update prints progress before it.
            var lines = out.split("\n").filter(function (l) { return l.trim() !== ""; });
            for (var i = lines.length - 1; i >= 0; i--) {
                try { return done(JSON.parse(lines[i]), null); } catch (e) {}
            }
            done(null, err || out || "no readable reply");
        });
    }

    function setUpd(cls, text, btn) {
        el.updbar.className = "updbar" + (cls ? " " + cls : "");
        el.updtext.textContent = text;
        el.updbtn.hidden = !btn;
        if (btn) el.updbtn.textContent = btn;
        show(el.updbar, true);
    }

    function checkUpdate() {
        runJson(["--check-update-json"], function (r, e) {
            if (!r) { log("update check failed: " + e); return; }
            log("update check: on " + r.current
                + (r.update ? ", " + r.update.version + " available" : ", up to date"));
            if (!r.update) return;
            if (r.source_checkout) {
                // This copy is a git checkout, so xmlcut.py refuses to overwrite it.
                // Saying so beats offering a button that cannot work.
                setUpd("busy", "xmlcut " + r.update.version
                       + " is out — this copy is a git checkout, so use git pull", "");
                return;
            }
            state.updateInfo = r.update;
            setUpd("", "xmlcut " + r.update.version + " is available"
                   + (r.update.notes ? " — " + r.update.notes : ""), "Update");
        });
    }

    function applyUpdate() {
        el.updbtn.hidden = true;
        setUpd("busy", "Downloading and checking every file first…", "");
        runJson(["--self-update-json"], function (r, e) {
            if (!r) {
                setUpd("bad", "Update failed: " + e, "");
                return;
            }
            for (var i = 0; i < (r.steps || []).length; i++) log("update: " + r.steps[i]);
            log("update result: " + r.message);
            if (r.ok) {
                setUpd("done", "Updated to " + r.version
                       + ". Quit Premiere (Cmd-Q) and reopen it to load the new panel.",
                       "");
            } else {
                setUpd("bad", r.message, "");
            }
        });
    }

    /* ------------------------------------------------------------ report */

    /* Built from the manifest xmlcut already writes, rather than by parsing stdout.
     * The manifest is the authoritative record of what each cut actually is, and it
     * carries the numbers needed to check a clip without doing arithmetic: the frame
     * count, the native length, the speed, and the length it occupied on the timeline. */
    function manifestMtime() {
        try {
            return fs.statSync(path.join(state.out, "manifest.json")).mtimeMs;
        } catch (e) {
            return 0;
        }
    }

    function buildReport() {
        state.report = [];
        if (manifestMtime() === state.manifestBefore) {
            // Nothing was written this run — do not present an older manifest as this
            // run's result.
            log("no manifest written by this run; not reporting");
            return false;
        }
        var data;
        try {
            data = JSON.parse(fs.readFileSync(path.join(state.out, "manifest.json"),
                                              "utf8"));
        } catch (e) {
            log("no manifest to report on: " + e);
            return false;
        }

        var clips = data.clips || [];
        for (var i = 0; i < clips.length; i++) {
            var c = clips[i];
            var st = String(c.status || "");
            var kind = String(c.display_kind || "");
            var bad = (kind === "bad");
            var warn = (kind === "warn" || c.speed_varies === true
                        || st === "skipped_existing");

            var facts = [];
            var cut = Number(c.source_duration_seconds || 0);
            var tl = Number(c.duration_seconds || 0);
            var spd = Number(c.speed_percent || 100);
            var frames = Number(c.source_consumed_frames || 0);
            if (cut > 0) facts.push(cut.toFixed(3) + "s");
            if (frames > 0) facts.push(frames + "f");
            if (Math.abs(spd - 100) > 0.01) {
                facts.push(spd.toFixed(2) + "%");
                if (tl > 0) facts.push("→ " + tl.toFixed(3) + "s on the timeline");
            }
            if (c.reversed) facts.push("reversed");
            if (c.speed_varies) {
                facts.push("ramp " + (c.speed_span || "varies")
                           + ", cut at one speed");
            }
            if (bad) facts.push(String(c.error || st).substring(0, 120));
            else if (st === "unsupported") facts.push("not decodable media");
            else if (st === "skipped_existing") facts.push("already existed, kept");

            state.report.push({
                name: String(c.output_file || c.clip_name || "?"),
                facts: facts.join(" · "),
                bad: bad,
                warn: warn,
                problem: bad || warn
            });
        }

        // Counted from the clip statuses, not from the manifest's `counts` block. That
        // block's missing_sources also counts project files like .aep, which are not
        // offline media, and a tally that disagrees with the rows below it is worse
        // than no tally.
        var n = { ok: 0, failed: 0, missing: 0, unsupported: 0, kept: 0,
                  ramps: 0, retimed: 0, reversed: 0 };
        for (var j = 0; j < clips.length; j++) {
            var cc = clips[j], s2 = String(cc.status || "");
            if (s2 === "ok") n.ok++;
            else if (s2 === "failed") n.failed++;
            else if (s2 === "missing_source") n.missing++;
            else if (s2 === "unsupported") n.unsupported++;
            else if (s2 === "skipped_existing") n.kept++;
            if (cc.speed_varies) n.ramps++;
            if (cc.reversed) n.reversed++;
            if (Math.abs(Number(cc.speed_percent || 100) - 100) > 0.01) n.retimed++;
        }

        var pills = [];
        function pill(text, cls) { pills.push({ t: text, c: cls || "" }); }
        pill(n.ok + " written", n.ok > 0 ? "good" : "");
        if (n.kept) pill(n.kept + " already there", "");
        if (n.failed) pill(n.failed + " failed", "bad");
        if (n.missing) pill(n.missing + " offline", "bad");
        if (n.unsupported) pill(n.unsupported + " not media", "warnp");
        if (n.ramps) pill(n.ramps + " ramp" + (n.ramps === 1 ? "" : "s"), "warnp");
        if (n.retimed) pill(n.retimed + " retimed");
        if (n.reversed) pill(n.reversed + " reversed");

        el.tally.innerHTML = "";
        for (var p = 0; p < pills.length; p++) {
            var d = document.createElement("span");
            d.className = "pill " + pills[p].c;
            d.textContent = pills[p].t;
            el.tally.appendChild(d);
        }
        return true;
    }

    function renderReport() {
        var only = el.onlyprob.checked;
        var shown = 0;
        el.rows.innerHTML = "";
        for (var i = 0; i < state.report.length; i++) {
            var r = state.report[i];
            if (only && !r.problem) continue;
            shown++;
            var div = document.createElement("div");
            div.className = "row2" + (r.bad ? " isbad" : (r.warn ? " iswarn" : ""));
            var nm = document.createElement("span");
            nm.className = "nm";
            nm.textContent = r.name;
            div.appendChild(nm);
            if (r.facts) {
                var f = document.createElement("span");
                f.className = "facts";
                f.textContent = r.facts;
                div.appendChild(f);
            }
            el.rows.appendChild(div);
        }
        el.repcount.textContent = shown + " of " + state.report.length + " shown";
        if (!shown) {
            var e2 = document.createElement("div");
            e2.className = "row2";
            e2.textContent = only ? "No problems." : "Nothing to show.";
            el.rows.appendChild(e2);
        }
    }

    /* Copies exactly what is on screen, so ticking "only problems" and pressing Copy
     * gives you the list of things to fix and nothing else. */
    function reportText() {
        var only = el.onlyprob.checked;
        var out = [];
        if (state.info) {
            out.push(state.info.sequence + "  " + (state.xml ? "XML + Premiere"
                                                             : "Premiere only"));
        }
        out.push(el.tally.textContent.replace(/\s+/g, "  "));
        if (state.merge.length) {
            out.push("");
            for (var m = 0; m < state.merge.length; m++) out.push("- " + state.merge[m]);
        }
        out.push("");
        for (var i = 0; i < state.report.length; i++) {
            if (only && !state.report[i].problem) continue;
            out.push(state.report[i].name);
            if (state.report[i].facts) out.push("    " + state.report[i].facts);
        }
        return out.join("\n");
    }

    /* -------------------------------------------------------------- tips */

    function wireTips() {
        var qs = document.querySelectorAll("[data-tip]");
        for (var i = 0; i < qs.length; i++) {
            (function (q) {
                q.addEventListener("mouseenter", function () {
                    el.tip.textContent = q.getAttribute("data-tip");
                    el.tip.hidden = false;
                    var r = q.getBoundingClientRect();
                    var top = r.bottom + 6;
                    el.tip.style.left = "0px";
                    el.tip.style.top = top + "px";
                    // Measure after showing, then nudge back inside the panel — a
                    // narrow panel would otherwise clip the bubble off the edge.
                    var w = el.tip.getBoundingClientRect().width;
                    var left = Math.min(Math.max(4, r.left), window.innerWidth - w - 4);
                    el.tip.style.left = left + "px";
                    if (top + el.tip.getBoundingClientRect().height > window.innerHeight) {
                        el.tip.style.top = Math.max(4, r.top - 6
                            - el.tip.getBoundingClientRect().height) + "px";
                    }
                });
                q.addEventListener("mouseleave", function () { el.tip.hidden = true; });
            })(qs[i]);
        }
    }

    /* -------------------------------------------------------------- wiring */

    el.read.addEventListener("click", readSequence);

    el.pickout.addEventListener("click", function () {
        cs.evalScript('pickFolder("' + (state.out || "").replace(/"/g, '\\"') + '")',
            function (p) {
                if (p && p !== "null" && p !== "undefined") setOut(p);
            });
    });

    el.pickscript.addEventListener("click", function () {
        cs.evalScript("pickScript()", function (p) {
            if (p && p !== "null" && p !== "undefined") {
                setScript(p);
                clearError();
                // The cut list could not be produced without the script; now it can, so
                // run it instead of making him click Read again.
                if (state.dump && !state.busy) {
                    setBusy(true, "Reading…");
                    scanClips();
                }
                checkUpdate();
            }
        });
    });

    el["export"].addEventListener("click", doExport);

    el.cancel.addEventListener("click", function () {
        if (state.proc) {
            try { state.proc.kill(); } catch (e) {}
        }
    });

    el.again.addEventListener("click", function () {
        show(el.report, false);
        show(el.opts, true);
        show(el.step3, true);
        clearError();
    });

    el.typeall.addEventListener("click", function () {
        var present = presentCuttable();
        for (var i = 0; i < present.length; i++) state.types[present[i]].on = true;
        state.typesReset = "";
        rememberTypeChoices();
        renderTypes();
        renderClips();
        refreshExportEnabled();
    });

    el.onlyprob.addEventListener("change", renderReport);

    el.resume.addEventListener("change", function () {
        state.resume = el.resume.checked;
        try { window.localStorage.setItem("xmlcut.resume",
                                          state.resume ? "1" : ""); } catch (e) {}
    });

    el.copyrep.addEventListener("click", function () {
        var t = reportText();
        // A CEP panel has no reliable navigator.clipboard, so go through a textarea
        // and execCommand, which does work in the embedded Chromium.
        var ta = document.createElement("textarea");
        ta.value = t;
        ta.style.position = "fixed";
        ta.style.top = "-1000px";
        document.body.appendChild(ta);
        ta.select();
        var ok = false;
        try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
        document.body.removeChild(ta);
        el.copyrep.textContent = ok ? "Copied" : "Copy failed — see the log";
        if (!ok) log(t);
        setTimeout(function () { el.copyrep.textContent = "Copy report"; }, 1600);
    });

    function reveal(dir) {
        if (!dir) return;
        try {
            spawn("/usr/bin/open", [dir], { env: { PATH: PATH } });
        } catch (e) {
            fail("Could not open the folder:\n" + e);
        }
    }

    el.reveal.addEventListener("click", function () { reveal(state.out); });
    el.showsaved.addEventListener("click", function () { reveal(state.folder); });
    el.updbtn.addEventListener("click", applyUpdate);

    /* --------------------------------------------------------------- boot */

    if (!node) {
        fail("This panel needs Node access, which the manifest enables with "
             + "--enable-nodejs. Reinstall the panel and restart Premiere.");
        el.read.disabled = true;
    } else {
        state.python = findPython();
        setScript(findScript());
        if (!state.script) {
            // Second opinion from inside Premiere: it resolves "~" reliably and may see
            // folders the panel's own stat cannot.
            cs.evalScript("findXmlcut()", function (raw) {
                var r = null;
                try { r = JSON.parse(raw); } catch (e) {}
                if (!r) { log("host search returned nothing readable"); return; }
                if (r.home) {
                    state.hostHome = r.home;
                    log("host home: " + r.home);
                }
                for (var t = 0; t < (r.tried || []).length; t++) {
                    log("host looked: " + r.tried[t]);
                }
                if (r.found) {
                    log("host found xmlcut.py: " + r.found);
                    setScript(r.found);
                    if (state.dump && !state.busy) { setBusy(true, "Reading…"); scanClips(); }
                    checkUpdate();
                } else {
                    // Re-run the panel-side search now that home is known for certain.
                    var again = findScript();
                    if (again) setScript(again);
                }
            });
        }
        var savedOut = null;
        try { savedOut = window.localStorage.getItem("xmlcut.out"); } catch (e) {}
        if (savedOut) {
            setOut(savedOut);
        } else {
            cs.evalScript("defaultOutputFolder()", function (p) {
                setOut((p && p !== "null") ? p : "");
            });
        }
        try {
            state.resume = !!window.localStorage.getItem("xmlcut.resume");
        } catch (e) { state.resume = false; }
        el.resume.checked = state.resume;
        wireTips();
        // Off the critical path: a slow or absent network must never delay the panel.
        if (state.script) checkUpdate();
        // Deliberately does NOT read on open. Reading exports an XML as a side effect,
        // and a panel that writes files the moment it appears is a panel you cannot
        // trust to sit open while you work. Step 1 is a button.
    }
})();
