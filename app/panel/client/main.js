/* Raw-cutter panel — read the active sequence, then cut it.
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
               "typehint", "typeall", "scripthelp",
               "readprog", "readfill", "readtext", "pickall", "checkupd", "outdest",
               "gear", "gearmenu", "enginestat", "recheck",
               "repcomplete", "repdestrow", "repdest", "repdestlbl", "mergedet", "mergesum",
               "jobtally", "joblist", "stalled",
               "onlyproblab"];
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
        jobs: {},            // output_file -> {status, t0, t1} while cutting
        jobOrder: [],
        jobTimer: null,      // 1s tick so elapsed times move even when quiet
        fetching: false,     // a cut-script recovery download is in flight
        repaired: false,     // a damaged bundled engine has already been replaced once
        readTimer: null,     // watchdog on the two ExtendScript calls
        manifestBefore: 0,   // manifest mtime before an export, so a cancel reports nothing
        resume: false,
        typesReset: "",
        hostHome: "",
        bundled: "",
        searchTried: [],
        unpicked: {},   // clip key -> true when individually unticked
        updateInfo: null
    };

    /* Reading is three steps with no progress of their own — ExtendScript gives none, and
     * the scan is a subprocess. So the bar is staged: it says which step is running and
     * how many are left, which is honest and more use than a spinner. */
    var READ_STEPS = ["Reading the sequence from Premiere",
                      "Asking Premiere to export the XML",
                      "Reading the cut list"];

    /* A read is two ExtendScript calls, and neither can be cancelled. If the host never
     * answers — Premiere busy in a modal, a project closing mid-read — every control was
     * left disabled on "Reading…" with no way back but closing the panel. Generous,
     * because a very long timeline legitimately takes a while, and recoverable: a late
     * answer is still taken (see resumeRead). */
    var READ_TIMEOUT = 180000;

    function readTimer(on) {
        if (state.readTimer) {
            clearTimeout(state.readTimer);
            state.readTimer = null;
        }
        if (!on) return;
        state.readTimer = setTimeout(function () {
            state.readTimer = null;
            if (!state.busy) return;
            setBusy(false);
            readStage(-1);
            fail("Premiere has not answered in " + Math.round(READ_TIMEOUT / 1000)
                 + " seconds. If the read is still running it will finish on its own and "
                 + "carry on from there. Otherwise switch to Premiere, check a sequence "
                 + "is open and nothing is waiting on a dialog, then read again.");
        }, READ_TIMEOUT);
    }

    /* Called first in every host callback. Returns false only if the panel has moved on
     * to a different read; a reply that merely arrived after the watchdog gave up is
     * good news and is picked back up. */
    function resumeRead() {
        readTimer(false);
        if (!state.busy) {
            clearError();
            setBusy(true, "Reading…");
        }
        return true;
    }

    /* A string literal for ExtendScript.
     *
     * Backslash FIRST, and it is not decorative: escaping only the quotes meant a project
     * folder called `Cut\Final` — legal on macOS — sent `\F` into the literal, which
     * ExtendScript evaluates to `F`. The host then wrote the XML to a path that does not
     * exist and the export failed with nothing useful to say. */
    function jsStr(s) {
        return '"' + String(s === null || s === undefined ? "" : s)
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"')
            .replace(/\r/g, "\\r")
            .replace(/\n/g, "\\n") + '"';
    }

    function readStage(n, extra) {
        if (n < 0) {
            show(el.readprog, false);
            return;
        }
        var pct = Math.round((n / READ_STEPS.length) * 100);
        el.readfill.style.width = pct + "%";
        el.readtext.textContent = (n >= READ_STEPS.length)
            ? (extra || "Done")
            : ("Step " + (n + 1) + " of " + READ_STEPS.length + " · "
               + READ_STEPS[n] + (extra ? " — " + extra : "") + " …");
        show(el.readprog, true);
    }

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
                PYTHONIOENCODING: "utf-8",
                // Belt and braces with the engine's own line buffering: an
                // older xmlcut.py block-buffers into this pipe and the panel
                // then sees nothing until the run ends.
                PYTHONUNBUFFERED: "1"
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

    /* Where the panel's own working files go: the scan's manifest and the selection file.
     *
     * They used to be written beside the project, inside the xmlcut/<sequence>/ folder —
     * which is often on the team's shared drive, and which pruneOldReads() cannot clean
     * because it only ever considers Files matching a timestamp pattern. A directory
     * called `scan` therefore lived there forever, holding the media paths of the whole
     * timeline. These are regenerated on every read; temp is where they belong. */
    function workDir() {
        var base = "";
        try { base = node.require("os").tmpdir(); } catch (e) {}
        if (!base) return path.dirname(state.dump);
        var d = path.join(base, "xmlcut-panel");
        try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
        return exists(d) ? d : path.dirname(state.dump);
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

    /* Where this panel is installed, from the page's own URL.
     *
     * client/index.html is loaded as a file:// URL from inside the extension folder, so
     * the extension root is two levels up. Derived from window.location rather than a
     * CEP API call because it cannot be unavailable or version-dependent. */
    function extensionDir() {
        try {
            var href = decodeURI(String(window.location.href));
            var i = href.indexOf("/client/");
            if (i < 0) return "";
            var base = href.substring(0, i);
            return base.replace(/^file:\/\//, "");
        } catch (e) {
            return "";
        }
    }

    /* xmlcut.py now ships INSIDE the panel, at lib/xmlcut.py, copied there at install
     * time. That is the whole answer in the normal case: the extension folder is one
     * Premiere already reads to load this panel, so it is always reachable — unlike
     * ~/Desktop, which macOS blocks until Premiere is granted Files-and-Folders access,
     * and which made a file sitting in plain sight impossible to find.
     *
     * Everything below the bundled copy is a fallback for an install that predates the
     * bundling, or a source checkout being driven by hand.
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

        // Bundled copy first, and normally last.
        var ext = extensionDir();
        state.bundled = "";
        if (ext) {
            var lib = ext + "/lib/xmlcut.py";
            if (tryPath(lib)) {
                state.bundled = lib;
                return lib;
            }
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

    /* The running version, read straight off the engine file.
     *
     * The header span was only ever filled in by a successful update check, so on a first
     * launch with no network — or before the engine had been located — the panel never
     * said what it was. No subprocess and no network: VERSION is a literal near the top of
     * xmlcut.py. */
    function readVersion() {
        if (!state.script) return;
        try {
            var head = String(fs.readFileSync(state.script, "utf8")).substring(0, 4000);
            var m = head.match(/VERSION\s*=\s*"([^"]+)"/);
            if (m) el.ver.textContent = "v" + m[1];
        } catch (e) {}
    }

    function setScript(p) {
        state.script = p || "";
        readVersion();
        if (state.script) {
            var isBundled = (state.bundled && state.bundled === state.script);
            if (isBundled) {
                // Nothing for him to do or supply, so say that rather than showing a
                // path and a Find button — which read as "this still needs configuring"
                // even when it had already been found.
                el.scriptpath.textContent = "bundled with this panel";
                el.scriptpath.title = state.script;
                el.pickscript.hidden = true;
            } else {
                setPathLabel(el.scriptpath, state.script, 40);
                el.scriptpath.title = state.script;
                el.pickscript.hidden = false;
            }
            show(el.scripthelp, false);
        } else {
            el.pickscript.hidden = false;
            el.scriptpath.textContent = "not found — click Find";
            // A silent failure for a file that is visibly there is the worst outcome, so
            // name the likely cause and every path that was checked.
            var tried = state.searchTried || [];
            el.scripthelp.textContent =
                "xmlcut.py should be bundled inside this panel, at lib/xmlcut.py, and it "
                + "is not — so this panel was installed by an older installer. Re-run "
                + "panel/Install xmlcut reader (Mac).command from your xmlcut folder, or "
                + "press Find and point at xmlcut.py. (" + tried.length
                + " place(s) checked; the log lists them.)";
            show(el.scripthelp, true);
            for (var t = 0; t < tried.length; t++) log("looked for xmlcut.py: " + tried[t]);
        }
        if (state.script) {
            try { window.localStorage.setItem("xmlcut.script", state.script); } catch (e) {}
            // Point at the copy of tools/ that actually exists. Bundled installs have
            // lib/tools/ beside lib/xmlcut.py; a source checkout has tools/ at its root.
            // Printing a path with no tools/ in it gave a command that could not run.
            var dir = path.dirname(state.script);
            if (exists(path.join(dir, "tools", "compare_panel.py"))) {
                el.cmd.textContent = 'cd "' + dir + '" && ' + state.python
                    + ' tools/compare_panel.py "MY_TIMELINE.xml"';
            } else {
                el.cmd.textContent = "the diagnostics are not bundled in this install — "
                    + "run tools/compare_panel.py from your xmlcut folder";
            }
        }
        refreshExportEnabled();
    }

    /* ------------------------------------------------------------ reading */

    function readSequence() {
        clearError();
        /* NOTHING from the previous read may survive into this one.
         *
         * This used to clear only the merge notes and the per-clip ticks, which left the
         * last read's clip table on screen and — worse — state.dump still pointing at it.
         * setBusy() does not disable Export, so reading a second sequence gave you the
         * first sequence's table above a header that had already changed, with a live
         * "Export 2 clips" button wired to the old dump. Step 1 is the long step on a real
         * timeline (ExtendScript walks every clip), so that window is not brief, and a
         * click in it wrote the wrong sequence's clips and then reported them as this
         * read's. Tear the whole previous read down before starting. */
        state.dump = null;
        state.info = null;
        state.xml = null;
        state.clips = [];
        state.report = [];
        state.merge = [];
        state.unpicked = {};
        // state.types too, or selectedCount() falls back to summing the PREVIOUS read's
        // type counts and the Export button keeps its old "Export 2 clips" label while a
        // different sequence is being read.
        state.types = {};
        state.typesReset = "";
        el.clipbody.innerHTML = "";
        el.types.innerHTML = "";
        el.listnote.textContent = "";
        show(el.seqbox, false);
        show(el.opts, false);
        show(el.step3, false);
        show(el.tablewrap, false);
        show(el.mode, false);
        show(el.mergebox, false);
        show(el.report, false);
        show(el.prog, false);
        // The destination is named after the sequence, so it is unknown again until this
        // read answers. Leaving the old sequence's folder on screen would name the wrong
        // one — the same staleness as the clip table above.
        setOutDest();
        setBusy(true, "Reading…");
        readStage(0);
        readTimer(true);

        cs.evalScript("dumpActiveSequence()", function (raw) {
            if (!resumeRead()) return;
            var r;
            try {
                r = JSON.parse(raw);
            } catch (e) {
                setBusy(false);
                readStage(-1);
                fail("Premiere did not return a readable reply:\n" + raw);
                return;
            }
            if (!r.ok) {
                setBusy(false);
                readStage(-1);
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
        readStage(1);
        var dest = state.dump.replace(/\.json$/i, ".xml");
        readTimer(true);
        cs.evalScript("exportSequenceXML(" + jsStr(dest) + ")",
            function (raw) {
                if (!resumeRead()) return;
                // An unreadable reply means no XML — not the end of the read. This used to
                // `return` here, which left the panel busy on step 2 with every control
                // disabled and no error shown. The dump alone still cuts.
                var r = { ok: false, error: "unreadable reply from Premiere" };
                try {
                    r = JSON.parse(raw);
                } catch (e) {
                    log("xml export: unreadable reply: " + raw);
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
                if (state.script) {
                    readStage(2);
                    scanClips();
                } else {
                    readStage(-1);
                    log("skipping the cut list: xmlcut.py not located yet");
                }
            });
    }

    /* One line saying exactly which sources the next export will use. Guessing about
     * accuracy is worse than being told. */
    function setMode(busyText) {
        if (busyText) {
            el.mode.textContent = busyText;
            el.mode.className = "note busy";
            show(el.mode, true);
            return;
        }
        if (state.xml) {
            el.mode.textContent = "XML + Premiere · nests resolved, ramp keyframes read";
            el.mode.className = "note good";
        } else {
            el.mode.textContent = "Premiere only · XML export unavailable, "
                + "nested sequences will be skipped";
            el.mode.className = "note warn";
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
        // The stable set, and only that.
        //
        // Every remembered extension used to be listed too, which put chips on screen for
        // types this panel can never produce: the scan runs --tracks video, so a .wav or a
        // .mp3 can only ever appear at count 0 with nothing behind it, no matter how it is
        // ticked. Remembering still works — ensure() reads the saved choice the moment a
        // timeline actually contains that type — it just no longer advertises it.
        for (var a = 0; a < ALWAYS_TYPES.length; a++) ensure(ALWAYS_TYPES[a]);

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
        // The destination folder is named after this sequence, so it is only knowable now.
        setOutDest();
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

    /* What the Export button will actually write: type on, cuttable, and ticked. Counted
     * from the clip list rather than by summing type counts, which ignored both the
     * uncuttable clips and the per-clip ticks. */
    function selectedCount() {
        if (state.clips.length) return pickedClips().length;
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
        // Nothing to advise while a read is in flight: the type list is empty by
        // construction at that point, and "this timeline has no media that can be cut" is
        // a conclusion about a timeline that has not been read yet.
        if (state.busy) return "";
        if (state.typesReset) {
            return "Nothing was selected, so " + state.typesReset
                 + " — the types on this timeline — were switched back on.";
        }
        var n = selectedCount();
        var present = presentCuttable();
        if (n > 0) {
            /* Types this timeline HAS, that are switched off.
             *
             * Choices are remembered across projects, so a type unticked once stays
             * unticked on every timeline after it. On a real job that meant five .png
             * clips were never cut and nothing on screen said why — the export simply
             * contained eight fewer files than the timeline had, and it read as clips
             * going missing. An exclusion the user is not currently looking at has to
             * announce itself. */
            var off = [];
            for (var j = 0; j < present.length; j++) {
                if (!state.types[present[j]].on) {
                    off.push("." + present[j] + " (" + state.types[present[j]].count + ")");
                }
            }
            return off.length
                ? ("Not selected: " + off.join(", ")
                   + " — clips of those types are on this timeline and will NOT be cut.")
                : "";
        }
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
            // Neutral when the panel fixed it itself, amber when he has to act.
            el.typehint.className = "note" + (state.typesReset ? "" : " warn");
            show(el.typehint, !!h);
        }
        // `!state.busy` is load-bearing, not belt-and-braces: setBusy() disables Read and
        // the pickers but never touched Export, so it stayed live through a read — and
        // during a read state.dump still points at the PREVIOUS sequence.
        var ready = !!(state.dump && state.script && state.out && n > 0) && !state.busy;
        el["export"].disabled = !ready;
        el["export"].textContent = n > 0
            ? ("Export " + n + " clip" + (n === 1 ? "" : "s"))
            : "Nothing selected";
        if (!state.script && state.dump) {
            el["export"].textContent = "Find xmlcut.py first";
            // The gear, not Advanced: the engine row moved there, so opening Advanced
            // would reveal a compare command and a log rather than the thing to fix.
            show(el.gearmenu, true);
            el.gear.className = "gearbtn on";
        }
    }

    /* -------------------------------------------------- live per-clip state */

    /* What each clip is doing right now, built from the engine's own output.
     *
     * xmlcut announces a clip when it STARTS ("  >> name.mp4") and again when it finishes
     * ("  [7/18] OK  name.mp4"). Both matter: JOBS clips encode at once, so reporting only
     * on completion left the panel silent for the whole of the first encode — and a single
     * long clip on Drive-backed media can hold that silence for minutes, which is
     * indistinguishable from a hang. */
    var STALL_AFTER = 25000;

    function jobsReset(total) {
        state.jobs = {};
        state.jobOrder = [];
        state.jobTotal = total || 0;
        state.jobDone = 0;
        state.lastEvent = nowMs();
        if (state.jobTimer) clearInterval(state.jobTimer);
        // Ticks whether or not the engine says anything, so the elapsed times keep moving.
        // A number that advances is the difference between "slow" and "dead".
        state.jobTimer = setInterval(renderJobs, 1000);
        el.joblist.innerHTML = "";
        el.jobtally.textContent = "";
        show(el.stalled, false);
    }

    function jobsStop() {
        if (state.jobTimer) {
            clearInterval(state.jobTimer);
            state.jobTimer = null;
        }
    }

    function nowMs() {
        // Date.now() via a constructor-free path; CEP's Chromium has both, this is just
        // the one place a clock is read.
        return (new Date()).getTime();
    }

    function jobStart(name) {
        if (!state.jobs[name]) state.jobOrder.push(name);
        state.jobs[name] = { status: "run", t0: nowMs() };
        state.lastEvent = nowMs();
        renderJobs();
    }

    function jobDone(name, flag) {
        var j = state.jobs[name];
        if (!j) { state.jobOrder.push(name); j = state.jobs[name] = { t0: nowMs() }; }
        j.status = (flag === "OK" || flag === "HAVE") ? "ok" : "bad";
        j.flag = flag;
        j.t1 = nowMs();
        state.jobDone++;
        state.lastEvent = nowMs();
        renderJobs();
    }

    function secs(ms) {
        var s = Math.max(0, Math.round(ms / 1000));
        return s < 60 ? (s + "s") : (Math.floor(s / 60) + "m " + (s % 60) + "s");
    }

    function renderJobs() {
        var now = nowMs(), running = [], finished = [];
        for (var i = 0; i < state.jobOrder.length; i++) {
            var nm = state.jobOrder[i], j = state.jobs[nm];
            (j.status === "run" ? running : finished).push({ nm: nm, j: j });
        }
        var queued = Math.max(0, state.jobTotal - running.length - finished.length);
        el.jobtally.textContent = running.length + " encoding · " + finished.length
            + " done" + (queued ? (" · " + queued + " queued") : "");

        // Running first — those are the ones you are waiting on. Then the most recently
        // finished, capped: a 94-clip run does not need 94 rows of "done".
        var rows = running.concat(finished.slice(-8).reverse());
        el.joblist.innerHTML = "";
        for (var k = 0; k < rows.length; k++) {
            var r = rows[k], d = document.createElement("div");
            d.className = "row2" + (r.j.status === "bad" ? " isbad" : "");
            var nm2 = document.createElement("span");
            nm2.className = "nm";
            nm2.textContent = r.nm;
            d.appendChild(nm2);
            var f = document.createElement("span");
            f.className = "facts";
            f.textContent = r.j.status === "run"
                ? secs(now - r.j.t0)
                : (r.j.flag || "done") + " " + secs((r.j.t1 || now) - r.j.t0);
            d.appendChild(f);
            el.joblist.appendChild(d);
        }

        /* Said out loud rather than left to be inferred from a still bar. Not called
         * "frozen": several clips encoding at once on network media legitimately go quiet
         * for a while, and crying wolf would make the message worthless. */
        var quiet = now - (state.lastEvent || now);
        if (quiet > STALL_AFTER && running.length) {
            var longest = 0;
            for (var q = 0; q < running.length; q++) {
                longest = Math.max(longest, now - running[q].j.t0);
            }
            el.stalled.textContent = "No clip has finished for " + secs(quiet)
                + ". Still working — the longest running clip has been going "
                + secs(longest) + ". Large or Drive-backed media takes this long; "
                + "the times above keep moving while it is alive.";
            show(el.stalled, true);
        } else {
            show(el.stalled, false);
        }
    }

    /* ----------------------------------------------------------- exporting */

    /* "Save to" is a ROOT you pick once. Each export creates <root>/<sequence>/ inside it
     * and writes there.
     *
     * Why it matters beyond tidiness: xmlcut numbers its output 01..N per run, so cutting
     * three sequences into one folder interleaved three sets of 01_, 02_, 03_ … and the
     * later runs overwrote the earlier ones wherever a name collided. A folder per sequence
     * keeps each run's numbering meaning what it says.
     *
     * The folder name comes from the HOST (`safe_name`), which already has to turn a
     * sequence name into a legal folder name for the read folder. folderSafe() below is
     * only reached by a panel newer than the host.jsx beside it, which reinstalling fixes;
     * it can disagree about the name but never about what gets cut. */
    function folderSafe(name) {
        var s = String(name === null || name === undefined ? "" : name);
        var out = "", ch, c;
        for (var i = 0; i < s.length; i++) {
            ch = s.charAt(i);
            c = s.charCodeAt(i);
            if (c < 32) continue;                                   // control characters
            out += (ch === "/" || ch === ":" || ch === "\\") ? "-" : ch;
        }
        out = out.replace(/^[\s.]+/, "").replace(/[\s.]+$/, "");
        if (!out) out = "Untitled Sequence";
        return out.length > 80 ? out.substring(0, 80) : out;
    }

    function seqFolder() {
        if (!state.info) return "";
        return String(state.info.safe_name || folderSafe(state.info.sequence));
    }

    /* Where THIS export writes. Empty until a sequence has been read, since the folder is
     * named after it. Everything that touches the output — the argv, the manifest the
     * report is built from, Show in Finder — goes through here so they cannot disagree. */
    function outDir() {
        if (!state.out) return "";
        var f = seqFolder();
        return f ? path.join(state.out, f) : state.out;
    }

    function countIn(dir) {
        try {
            return fs.readdirSync(dir).filter(function (n) {
                return n.charAt(0) !== ".";
            }).length;
        } catch (e) {
            return 0;
        }
    }

    /* Show the folder that will actually be written, before it is written. A root plus an
     * invisible rule about what gets appended to it is worse than no rule. */
    function setOutDest() {
        if (!el.outdest) return;
        if (!state.out) {
            show(el.outdest, false);
            return;
        }
        if (!state.info) {
            el.outdest.className = "note";
            el.outdest.textContent = "A folder named after the sequence is created in "
                + "here when you export.";
            el.outdest.title = "";
            show(el.outdest, true);
            return;
        }
        var d = outDir();
        var n = countIn(d);
        el.outdest.textContent = "→ " + seqFolder() + "/"
            + (n > 0 ? ("  · exists already, " + n + " file(s) in it") : "");
        // Flagged rather than merely mentioned: a re-export overwrites the names it
        // reproduces and leaves everything else, so a folder from a DIFFERENT version of
        // this timeline ends up holding a mix of both. Tick "skip clips already in that
        // folder" to add only what is missing, or empty it first.
        el.outdest.className = "note" + (n > 0 ? " warn" : "");
        el.outdest.title = d;
        show(el.outdest, true);
    }

    function setOut(p) {
        state.out = p || "";
        setPathLabel(el.outpath, state.out, 40);
        try { window.localStorage.setItem("xmlcut.out", state.out); } catch (e) {}
        setOutDest();
        refreshExportEnabled();
    }

    function doExport() {
        clearError();
        // Reset so the report shows THIS run's notes. The scan already ran the same merge,
        // so keeping its lines would print every one of them twice.
        state.merge = [];
        // The sequence's own folder inside the chosen root. xmlcut mkdir -p's whatever it
        // is given, so there is nothing to create here.
        var args = argsFor(outDir(), false);
        if (state.resume) args.push("--resume");
        // Only when something is actually unticked; otherwise the flag is noise.
        var pickPath = writePickFile(workDir());
        if (pickPath) {
            args.push("--pick", pickPath);
            log("selection: " + pickedClips().length + " clip(s) via " + pickPath);
        }

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
        jobsReset(selectedCount());
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
            // '!!' lines are xmlcut's own warnings, and one of them matters a lot: when a
            // selection matches no clip the run cuts fewer clips than were ticked. It was
            // reaching the Advanced log only.
            var mw = line.match(/^\s*!!\s*(.+)$/);
            if (mw) {
                state.merge.push("⚠ " + mw[1]);
                return;
            }
            // "  >> name.mp4" — a clip has STARTED encoding.
            var ms = line.match(/^\s*>>\s+(.+)$/);
            if (ms) {
                jobStart(ms[1]);
                return;
            }
            // xmlcut prints "  [7/18] OK  name.mp4" per clip.
            var m = line.match(/\[(\d+)\/(\d+)\]\s+(\S+)\s*(.*)$/);
            if (m) {
                var done = parseInt(m[1], 10), all = parseInt(m[2], 10);
                state.jobTotal = all;
                el.barfill.style.width = Math.round(done / all * 100) + "%";
                el.progtext.textContent = "[" + done + "/" + all + "] " + (m[4] || m[3]);
                if (m[4]) jobDone(m[4], m[3]);
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
            jobsStop();
            show(el.prog, false);
            show(el.opts, true);
            show(el.step3, true);
            setBusy(false);
            fail("python3 could not run:\n" + e);
        });

        proc.on("close", function (code) {
            state.proc = null;
            if (tail) onLine(tail);
            jobsStop();
            setBusy(false);
            show(el.prog, false);

            if (stderr) log("stderr: " + stderr);

            // A non-zero exit still leaves a manifest behind when some clips were
            // written, so the report is built either way — a partial run is exactly
            // when knowing which clips made it matters most.
            var built = buildReport();
            if (built) {
                renderReport();
                renderMerge();          // this run's '++' and '!!' lines, above the rows
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

        var scanDir = path.join(workDir(), "scan");
        var args = argsFor(scanDir, /* allTypes */ true);
        args.push("--manifest-only");
        log("$ " + state.python + " " + args.join(" "));

        var proc;
        try {
            proc = spawn(state.python, args, spawnOpts());
        } catch (e) {
            show(el.scanning, false);
            setBusy(false);
            readStage(-1);
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
                readStage(-1);
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
            readStage(READ_STEPS.length,
                      state.clips.length + " clip(s) read · "
                      + (state.xml ? "XML + Premiere" : "Premiere only"));
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
                // What --pick matches on: (track type, track index, timeline in-point in
                // frames). Stable against filtering and re-indexing, and unique — two
                // clips cannot start on the same frame of the same track.
                trackType: String(c.track_type || "video"),
                trackIndex: Number(c.track_index || 1),
                timelineIn: Number(c.timeline_in_frames || 0),
                ext: ext,
                group: cuttable ? 0 : 1,
                tc: String(c.timeline_in_tc || ""),
                clip: String(c.clip_name || ""),
                // Whole percent, and blank at native speed. 44px of column cannot hold
                // "145.46%", and the exact figure is in clips.csv and the manifest — this
                // column exists to say "this one is retimed", not to be arithmetic.
                speedNum: spd,
                speed: (Math.abs(spd - 100) > 0.01 || c.reversed)
                    ? (Math.round(spd) + "%" + (c.reversed ? "⏪" : "")) : "",
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

    function clipKey(c) {
        return c.trackType + " " + c.trackIndex + " " + c.timelineIn;
    }

    /* A clip is cut when its type is on, it can be cut at all, and it has not been
     * individually unticked. Type filtering and per-clip ticking are separate on
     * purpose: switching a type back on should not resurrect a clip you deliberately
     * dropped. */
    function typeOn(c) {
        return state.types[c.ext] ? state.types[c.ext].on : true;
    }

    function isPicked(c) {
        return !state.unpicked[clipKey(c)];
    }

    function pickedClips() {
        var out = [];
        for (var i = 0; i < state.clips.length; i++) {
            var c = state.clips[i];
            if (c.group === 0 && typeOn(c) && isPicked(c)) out.push(c);
        }
        return out;
    }

    /* Write the selection for --pick. A file rather than argv, because a long timeline is
     * hundreds of clips. Returns the path, or "" when everything is selected and the flag
     * is not needed. */
    function writePickFile(dir) {
        var all = [], chosen = pickedClips();
        for (var i = 0; i < state.clips.length; i++) {
            var c = state.clips[i];
            if (c.group === 0 && typeOn(c)) all.push(c);
        }
        if (chosen.length === all.length) return "";
        var lines = ["# written by the xmlcut panel — one clip per line",
                     "# TRACKTYPE TRACKINDEX TIMELINEIN"];
        for (var k = 0; k < chosen.length; k++) lines.push(clipKey(chosen[k]));
        /* The clips that CANNOT be cut go in too, even though they produce no file.
         *
         * --pick filters the cut list before the manifest is written, so listing only the
         * ticked ones deleted every offline clip and every AE comp from the manifest the
         * report is built from. Measured on the fixture: unticking one clip took it from
         * 19 rows with "missing source" and "AE comp" to 16 rows all reading "ready", and
         * counts.missing_sources to 0. Unticking a clip is not a request to stop being
         * told that media is broken. They arrive as warnings, exactly as they do in a run
         * with no selection at all. */
        for (var u = 0; u < state.clips.length; u++) {
            var d = state.clips[u];
            if (d.group !== 0 && typeOn(d)) lines.push(clipKey(d));
        }
        var p = path.join(dir, "pick.txt");
        try {
            fs.writeFileSync(p, lines.join("\n") + "\n", "utf8");
        } catch (e) {
            log("could not write the selection file: " + e);
            return "";
        }
        return p;
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
        // that is the order xmlcut assigns 1..N in after its own filtering. Only then are
        // the uncuttable ones sorted to the bottom for display, carrying the number they
        // were given. Numbering after that sort would put an offline clip at the end with
        // a number it will never have.
        //
        // Unticked clips take no number at all: they will not be in the run, so giving
        // them one would misdescribe every filename after them.
        var n = 0;
        for (var q = 0; q < visible.length; q++) {
            var vv = visible[q];
            vv.n = (vv.group === 0 && isPicked(vv)) ? (++n) : 0;
        }
        visible = visible.slice().sort(function (a, b) { return a.group - b.group; });

        var dividerDone = false;
        for (var j = 0; j < visible.length; j++) {
            var v = visible[j];
            if (v.group === 1 && !dividerDone) {
                dividerDone = true;
                var dr = document.createElement("tr");
                dr.className = "divider";
                var dc = document.createElement("td");
                dc.setAttribute("colspan", "6");
                dc.textContent = "cannot be cut — fix these or untick their type";
                dr.appendChild(dc);
                body.appendChild(dr);
            }
            var tr = document.createElement("tr");
            var picked = isPicked(v);
            tr.className = "k-" + v.kind + (picked ? "" : " unpicked");

            // The tick lives in its own cell, built here rather than through the generic
            // cell loop because it holds a control rather than text.
            (function (clip, row) {
                var td = document.createElement("td");
                td.className = "pick";
                var box = document.createElement("input");
                box.type = "checkbox";
                box.checked = picked;
                box.disabled = (clip.group !== 0);   // nothing to include if it cannot cut
                box.title = clip.clip;
                box.addEventListener("change", function () {
                    if (box.checked) delete state.unpicked[clipKey(clip)];
                    else state.unpicked[clipKey(clip)] = true;
                    row.className = "k-" + clip.kind + (box.checked ? "" : " unpicked");
                    syncPickAll();
                    renderClips();          // renumber, since the run changed
                    refreshExportEnabled();
                });
                td.appendChild(box);
                row.appendChild(td);
            })(v, tr);

            /* SIX columns, sized to fit 320px. Timeline position, timing source and notes
             * moved to the row's tooltip: nine columns meant the table scrolled sideways
             * inside a page that scrolls down, and two axes fighting in one region is most
             * of why this panel felt disorderly. Nothing was dropped — the manifest and
             * clips.csv carry all of it, and the tooltip has it per row. */
            tr.title = [v.clip, "at " + v.tc,
                        v.timing ? "timing from " + v.timing : "",
                        v.notes, v.source].filter(function (s) { return !!s; }).join(" · ");
            var cells = [
                [v.n ? pad2(v.n) : "—", "idx num"], [v.clip, "clipname"],
                [v.speed, "spd"], [String(v.frames), "frm num"], [v.status, "sts"]
            ];
            for (var k = 0; k < cells.length; k++) {
                var td = document.createElement("td");
                if (cells[k][1]) td.className = cells[k][1];
                td.textContent = cells[k][0];
                if (k === 1) {
                    // A coloured dot for the SOURCE type, which matters because this column
                    // is Premiere's clip NAME, not the filename: a clip called "shot.mov"
                    // can be backed by an .mp4 after a transcode, and then the type chips
                    // look wrong when they are right. The three-letter tag that used to sit
                    // beside it is gone — this column is now ~100px and the dot says the
                    // same thing in 7. The exact path is on the row's tooltip.
                    var d = document.createElement("span");
                    d.className = "dot";
                    d.title = "." + v.ext;
                    d.style.background = colorFor(v.ext);
                    td.insertBefore(d, td.firstChild);
                }
                tr.appendChild(td);
            }
            body.appendChild(tr);
        }
        var cuttable = 0, chosen = 0;
        for (var m = 0; m < visible.length; m++) {
            if (visible[m].group !== 0) continue;
            cuttable++;
            if (isPicked(visible[m])) chosen++;
        }
        el.listnote.textContent = (chosen === cuttable)
            ? (cuttable + " of " + visible.length + " cuttable")
            : (chosen + " of " + cuttable + " ticked");
        syncPickAll();
    }

    function pad2(n) { return (n < 10 ? "0" : "") + n; }

    /* The header tick reflects the rows: on when all are on, off when none are, and
     * indeterminate in between — so it never claims a state the table contradicts. */
    function syncPickAll() {
        var total = 0, on = 0;
        for (var i = 0; i < state.clips.length; i++) {
            var c = state.clips[i];
            if (c.group !== 0 || !typeOn(c)) continue;
            total++;
            if (isPicked(c)) on++;
        }
        el.pickall.checked = (total > 0 && on === total);
        el.pickall.indeterminate = (on > 0 && on < total);
    }

    /* The merge's own explanations, promoted out of the Advanced log. These say why a
     * clip kept the XML's values, and which media paths were repaired. */
    /* Folded away, and BELOW the results.
     *
     * This box used to sit above the clip list and take 747 characters doing it — notes about
     * clips that were fine, pushing the list of what was actually written off screen. It is
     * now a <details> under the rows, with a summary that says how many notes there are so it
     * can be ignored without being opened.
     *
     * Lines the engine prefixes with "· " are details of the note above them, and are shown
     * indented and monospaced so they read as a table rather than as three paragraphs. */
    function renderMerge() {
        el.mergebox.innerHTML = "";
        if (!state.merge.length) {
            show(el.mergedet, false);
            return;
        }
        var heads = 0;
        for (var i = 0; i < state.merge.length; i++) {
            var raw = String(state.merge[i]);
            var item = raw.indexOf("· ") === 0;
            if (!item) heads++;
            var d = document.createElement("div");
            d.className = "mergeline" + (item ? " item" : "");
            d.textContent = item ? raw.substring(2) : raw;
            el.mergebox.appendChild(d);
        }
        el.mergesum.textContent = heads === 1 ? "1 merge note"
                                             : (heads + " merge notes");
        show(el.mergedet, true);
    }

    /* ------------------------------------------- recovering the cut script */

    /* If xmlcut.py is missing, the panel cannot ask xmlcut.py to fetch it. So this is the
     * one place the panel does its own downloading, and it is deliberately the ONLY one —
     * every other network operation still shells out to the engine.
     *
     * These constants necessarily duplicate UPDATE_OWNER/REPO/BRANCH/DIR in xmlcut.py.
     * They cannot be read from it: the whole point is bootstrapping when it is absent. They
     * are pinned literals rather than anything configurable for the same reason they are
     * there — whoever controls that repo can run code on this machine.
     */
    var UPDATE_OWNER = "mill2nn";
    var UPDATE_REPO = "xmlcut-releases";
    var UPDATE_BRANCH = "main";
    var UPDATE_DIR = "app";
    var MAX_FETCH = 8 * 1024 * 1024;
    var FETCH_TIMEOUT = 20000;

    var https = null;
    try { https = node ? node.require("https") : null; } catch (e) { https = null; }

    /* Contents API first, then raw — the same order and the same reason as xmlcut.py:
     * raw.githubusercontent is CDN-cached for five minutes and can answer with a stale
     * file, while the contents API answers from the repository immediately. */
    function fetchUrls(rel) {
        var safe = rel.split("/").map(encodeURIComponent).join("/");
        return [
            ["https://api.github.com/repos/" + UPDATE_OWNER + "/" + UPDATE_REPO
             + "/contents/" + safe + "?ref=" + UPDATE_BRANCH,
             { "User-Agent": "xmlcut-panel", "Accept": "application/vnd.github.raw" }],
            ["https://raw.githubusercontent.com/" + UPDATE_OWNER + "/" + UPDATE_REPO + "/"
             + UPDATE_BRANCH + "/" + safe,
             { "User-Agent": "xmlcut-panel" }]
        ];
    }

    function httpGet(url, headers, done, depth) {
        if (!https) { done(null, "this panel has no https module"); return; }
        depth = depth || 0;
        if (depth > 4) { done(null, "too many redirects"); return; }
        var req;
        try {
            req = https.get(url, { headers: headers }, function (res) {
                if (res.statusCode > 299 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    httpGet(res.headers.location, headers, done, depth + 1);
                    return;
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    done(null, "HTTP " + res.statusCode);
                    return;
                }
                // Text, and decoded as UTF-8 by the stream: xmlcut.py contains em dashes,
                // and a multi-byte character split across two chunks must not be mangled.
                res.setEncoding("utf8");
                var buf = "", over = false;
                res.on("data", function (c) {
                    if (over) return;
                    buf += c;
                    // A cap, so a wrong URL or a hostile repo cannot hand this an
                    // arbitrarily large body.
                    if (buf.length > MAX_FETCH) {
                        over = true;
                        try { res.destroy(); } catch (e) {}
                    }
                });
                res.on("end", function () {
                    done(over ? null : buf,
                         over ? "the response exceeded the 8 MB cap" : null);
                });
                res.on("error", function (e) { done(null, String(e)); });
            });
        } catch (e) {
            done(null, String(e));
            return;
        }
        req.on("error", function (e) { done(null, String(e)); });
        req.setTimeout(FETCH_TIMEOUT, function () {
            try { req.destroy(); } catch (e) {}
            done(null, "timed out after " + (FETCH_TIMEOUT / 1000) + "s");
        });
    }

    /* Try each URL in turn; report the last failure if none answered. */
    function fetchRel(rel, done) {
        var urls = fetchUrls(rel), i = 0, lastErr = "no attempt made";
        function attempt() {
            if (i >= urls.length) { done(null, lastErr); return; }
            var u = urls[i++];
            httpGet(u[0], u[1], function (text, err) {
                if (text) { done(text, null); return; }
                lastErr = err;
                log("fetch " + rel + " failed: " + err);
                attempt();
            });
        }
        attempt();
    }

    /* Is this actually xmlcut.py, or an error page / a truncated download?
     *
     * The panel writes an executable Python file, so it validates before writing rather
     * than after — the same bargain apply_update() makes, for the same reason: a
     * half-written engine is worse than a missing one, because a missing one says so. */
    function engineComplaint(text, wantVersion) {
        if (!text || text.length < 2000) {
            return "the download is far too small to be xmlcut.py";
        }
        var m = text.match(/VERSION\s*=\s*"([^"]+)"/);
        if (!m) return "the download has no VERSION line";
        if (wantVersion && m[1] !== wantVersion) {
            return "the download says " + m[1] + ", not the " + wantVersion
                 + " the channel promised";
        }
        // Markers a real engine has and an error page, a redirect stub or a truncated
        // body does not.
        if (text.indexOf("PPRO_TICKS_PER_SECOND") < 0
            || text.indexOf("def build_command") < 0
            || text.indexOf("def run_cut") < 0) {
            return "the download does not look like xmlcut.py";
        }
        return "";
    }

    function setEngineStat(cls, text) {
        el.enginestat.className = "note" + (cls ? " " + cls : "");
        el.enginestat.textContent = text;
    }

    /* The useful line of a subprocess failure. A SyntaxError arrives as a four-line
     * traceback whose last line is the only part worth showing in a 320px panel. */
    function lastLine(s) {
        var parts = String(s || "").split("\n").filter(function (l) {
            return l.trim() !== "";
        });
        return parts.length ? parts[parts.length - 1].trim() : "no reply";
    }

    /* Is this path the copy the panel owns? Only that one is ever replaced automatically —
     * a script somewhere else is his own checkout, and not ours to overwrite. */
    function isOurCopy(p) {
        var dir = extensionDir();
        return !!(dir && p && String(p).indexOf(dir + "/lib/") === 0);
    }

    /* Prove the script RUNS, not merely that a file exists at that path. A zero-byte or
     * half-copied xmlcut.py passes an existence check and then fails at export time, which
     * is the worst moment to find out. */
    function probeEngine(then) {
        setEngineStat("busy", "Checking it runs…");
        runJson(["--check-update-json"], function (r, e) {
            if (r && r.current) {
                el.ver.textContent = "v" + r.current;
                setEngineStat("good",
                    (state.bundled && state.bundled === state.script
                        ? "bundled with this panel" : "found") + " · v" + r.current
                    + " · runs");
                if (then) then(true);
                return;
            }
            setEngineStat("bad", "xmlcut.py is there but did not run — " + lastLine(e));
            // A broken copy of OUR OWN file is worth replacing without being asked: it is
            // only ever a copy, the panel cannot do anything without it, and "present" was
            // never the same as "works". Once only, so a download that also fails to run
            // cannot loop.
            if (isOurCopy(state.script) && !state.repaired) {
                state.repaired = true;
                log("the bundled engine does not run; fetching a fresh copy");
                setEngineStat("busy", "That copy is damaged — fetching a fresh one…");
                downloadEngine(true);
                return;
            }
            if (then) then(false);
        });
    }

    /* The whole recovery, in order: is it there → does it run → if absent, download it,
     * validate it, write it into the panel and link it.
     *
     * `auto` is true when this ran by itself on open. He asked for the download to happen
     * without being asked, and it only ever happens when NO engine could be found —
     * an existing one is never replaced from here. */
    function recheckScript(auto) {
        if (state.fetching) return;
        clearError();
        state.repaired = false;         // a deliberate re-check earns one repair attempt
        var found = findScript();
        if (found) {
            setScript(found);
            probeEngine();
            return;
        }
        downloadEngine(auto);
    }

    /* Fetch, validate, write, link. Separate from recheckScript because probeEngine also
     * needs it: a bundled copy that exists but will not run has to be replaced, and going
     * back through the search would only rediscover the broken file. */
    function downloadEngine(auto) {
        if (state.fetching) return;
        var dir = extensionDir();
        if (!dir) {
            setEngineStat("bad", "xmlcut.py is missing and this panel cannot work out "
                          + "where it is installed, so it cannot repair itself. Press Find.");
            return;
        }
        if (!https) {
            setEngineStat("bad", "xmlcut.py is missing and this panel has no network "
                          + "module to fetch it. Re-run the installer, or press Find.");
            return;
        }

        state.fetching = true;
        el.recheck.disabled = true;
        show(el.gearmenu, true);           // whatever happens next, he should see it
        setEngineStat("busy", "xmlcut.py is missing — asking the release channel…");
        log("cut script missing; " + (auto ? "auto-" : "") + "recovering from "
            + UPDATE_OWNER + "/" + UPDATE_REPO);

        function stop(cls, msg) {
            state.fetching = false;
            el.recheck.disabled = false;
            setEngineStat(cls, msg);
            log("cut script recovery: " + msg);
        }

        fetchRel("latest.json", function (text, err) {
            if (!text) {
                stop("bad", "could not reach the release channel (" + err
                     + "). Press Find and point at xmlcut.py, or re-run the installer.");
                return;
            }
            var want = "";
            try { want = String(JSON.parse(text).version || ""); } catch (e) {}
            if (!want) {
                stop("bad", "the release channel did not name a version.");
                return;
            }
            setEngineStat("busy", "Downloading xmlcut.py " + want + "…");
            fetchRel(UPDATE_DIR + "/xmlcut.py", function (body, err2) {
                if (!body) {
                    stop("bad", "the download failed (" + err2 + ").");
                    return;
                }
                var bad = engineComplaint(body, want);
                if (bad) {
                    // Nothing is written. A rejected download leaves the panel exactly as
                    // it was: missing an engine and saying so.
                    stop("bad", "refused the download — " + bad + ". Nothing was written.");
                    return;
                }
                var lib = dir + "/lib";
                var target = lib + "/xmlcut.py";
                try {
                    fs.mkdirSync(lib, { recursive: true });
                    fs.writeFileSync(target, body, "utf8");
                } catch (e3) {
                    stop("bad", "could not write " + target + " (" + e3 + ").");
                    return;
                }
                state.fetching = false;
                el.recheck.disabled = false;
                log("cut script written: " + target + " (" + body.length + " bytes)");
                // Link it, then prove it runs before calling this a success.
                state.bundled = target;
                setScript(target);
                probeEngine(function (ok) {
                    if (!ok) return;
                    setEngineStat("good", "downloaded " + want
                                  + " and linked · restart Premiere is not needed");
                    // The cut list could not be produced without an engine. Now it can.
                    if (state.dump && !state.busy) {
                        setBusy(true, "Reading…");
                        scanClips();
                    }
                });
            });
        });
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
        // "done" was a distinct blue box; it is the same news as "good".
        el.updbar.className = "note row " + (cls === "done" ? "good" : (cls || "good"));
        el.updtext.textContent = text;
        el.updbtn.hidden = !btn;
        if (btn) el.updbtn.textContent = btn;
        show(el.updbar, true);
    }

    /* `manual` is true when he pressed the button rather than the panel checking on
     * open. The difference is what happens when there is nothing new: on boot, say
     * nothing — an "up to date" banner every launch is noise. On a deliberate press,
     * always answer, because a button that appears to do nothing is worse than no
     * button. */
    function checkUpdate(manual) {
        if (manual) {
            el.checkupd.disabled = true;
            setUpd("busy", "Checking the release channel…", "");
        }
        runJson(["--check-update-json"], function (r, e) {
            el.checkupd.disabled = false;
            // The same reply proves the engine runs, so the gear's status line is set from
            // here too rather than costing a second subprocess.
            if (r && r.current) {
                setEngineStat("good",
                    (state.bundled && state.bundled === state.script
                        ? "bundled with this panel" : "found") + " · v" + r.current
                    + " · runs");
            } else if (state.script) {
                setEngineStat("bad", "xmlcut.py is at that path but did not run: "
                              + (e || "no reply") + ". Check python3 is installed.");
            }
            if (!r) {
                log("update check failed: " + e);
                if (manual) {
                    setUpd("bad", "Could not reach the release channel. " + e, "");
                } else {
                    // A failed check on open says nothing: no network is not news, and a
                    // red bar on every launch would be. Hidden explicitly rather than
                    // relying on the markup's initial state.
                    show(el.updbar, false);
                }
                return;
            }
            if (r.current) el.ver.textContent = "v" + r.current;
            /* The check FAILED, which is not the same as being current.
             *
             * check_update() used to return None for both, so with no network the reply
             * was byte-identical to being up to date and this panel said "nothing newer
             * published" — a claim it had no basis for. xmlcut.py now reports `checked`,
             * and it is the first thing to look at. */
            if (r.checked === false) {
                log("update check failed: " + (r.error || "no reason given"));
                if (manual) {
                    setUpd("bad", "Could not check for updates — "
                           + (r.error || "no reason given")
                           + ". You are still running " + r.current + ".", "");
                } else {
                    show(el.updbar, false);
                }
                return;
            }
            log("update check: on " + r.current
                + (r.update ? ", " + r.update.version + " available" : ", up to date"));
            if (!r.update) {
                if (manual) {
                    setUpd("done", "Up to date — running " + r.current
                           + ", nothing newer published.", "");
                } else {
                    show(el.updbar, false);
                }
                return;
            }
            if (r.source_checkout) {
                // This copy is a git checkout, so xmlcut.py refuses to overwrite it.
                // Saying so beats offering a button that cannot work.
                setUpd("busy", "Raw-cutter " + r.update.version
                       + " is out — this copy is a git checkout, so use git pull", "");
                return;
            }
            state.updateInfo = r.update;
            setUpd("", "Raw-cutter " + r.update.version + " is available"
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
                // Only a PANEL file needs Premiere restarting — Premiere loads this HTML
                // and JS once, at launch. The cut engine is a subprocess spawned fresh for
                // every export, so a release that only changes the cutting logic is live
                // immediately. Saying "quit and reopen" every time trains people to ignore
                // it on the one occasion it matters.
                var restart = (r.restart_needed !== false);
                setUpd("done", restart
                    ? ("Updated to " + r.version
                       + ". Quit Premiere (Cmd-Q) and reopen it to load the new panel.")
                    : ("Updated to " + r.version
                       + " — cut engine only, so it is already live. No restart needed; "
                       + "your next export uses it."), "");
                log("update changed: " + ((r.changed || []).join(", ") || "nothing"));
                readVersion();
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
            return fs.statSync(path.join(outDir(), "manifest.json")).mtimeMs;
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
            data = JSON.parse(fs.readFileSync(path.join(outDir(), "manifest.json"),
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
            // `skipped_existing` is deliberately NOT a problem. With resume on, every clip
            // that was already there counted as one, so ticking "only problems" after a
            // resumed run listed the clips that were fine. The row still says
            // "already existed, kept".
            var warn = (kind === "warn" || c.speed_varies === true);

            /* Facts for ONE line, sharing it with the filename.
             *
             * Dropped: the source length in seconds, which the filename already spells out
             * as its (in-out) range; and "on the timeline", which repeated on every retimed
             * row — eleven times in one real run. What is left is the frame count (the
             * number to check a clip against) and the speed. */
            var facts = [];
            var tl = Number(c.duration_seconds || 0);
            var spd = Number(c.speed_percent || 100);
            var frames = Number(c.source_consumed_frames || 0);
            if (frames > 0) facts.push(frames + "f");
            if (Math.abs(spd - 100) > 0.01) {
                facts.push(Math.round(spd) + "%");
                if (tl > 0) facts.push("→ " + tl.toFixed(2) + "s");
            }
            if (c.reversed) facts.push("reversed");
            if (c.speed_varies) facts.push("ramp " + (c.speed_span || "varies"));
            if (bad) facts.push(String(c.error || st).substring(0, 120));
            else if (st === "unsupported") facts.push("not decodable");
            else if (st === "skipped_existing") facts.push("kept");

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

        /* Where 25-matched became 18-written.
         *
         * The report showed the merge's "25 of 27 video clips matched" and the tally's
         * "18 written" with nothing whatsoever accounting for the gap — a reader could not
         * tell whether seven clips had failed silently. xmlcut computes exactly this
         * sentence and was only writing it to clips.csv. */
        var comp = String(data.completeness || "");
        el.repcomplete.textContent = comp;
        show(el.repcomplete, !!comp);

        // And WHERE it wrote, which the report never said despite having a Show button.
        // Named in words too: the clips are in a folder called after the sequence, and
        // anyone expecting the root folder finds it empty and calls the files missing.
        var f = seqFolder();
        el.repdestlbl.textContent = f
            ? ("Clips are in a folder named after the sequence — " + f + "/")
            : "Clips are in:";
        show(el.repdestlbl, !!outDir());
        setPathLabel(el.repdest, outDir(), 60);
        show(el.repdestrow, !!outDir());
        return true;
    }

    function renderReport() {
        var only = el.onlyprob.checked;
        var shown = 0;
        // Offering "only problems" when there are none is a control that can only produce
        // "No problems." Hidden instead.
        var anyProblem = false;
        for (var q = 0; q < state.report.length; q++) {
            if (state.report[q].problem) anyProblem = true;
        }
        if (!anyProblem && el.onlyprob.checked) el.onlyprob.checked = only = false;
        show(el.onlyproblab, anyProblem);
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
        // "18 of 18 shown" restated the "18 written" pill directly above it. Only says
        // anything when the filter is actually hiding something.
        el.repcount.textContent = (shown === state.report.length)
            ? "" : (shown + " of " + state.report.length + " shown");
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
        // The two lines added to the report on screen belong in the pasted copy too — they
        // are the ones that make a partial run legible to whoever receives it.
        if (el.repcomplete.textContent) out.push(el.repcomplete.textContent);
        if (outDir()) out.push(outDir());
        if (state.merge.length) {
            out.push("");
            for (var m = 0; m < state.merge.length; m++) out.push("  " + state.merge[m]);
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
        cs.evalScript("pickFolder(" + jsStr(state.out || "") + ")",
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
                checkUpdate(false);
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

    el.pickall.addEventListener("change", function () {
        var on = el.pickall.checked;
        for (var i = 0; i < state.clips.length; i++) {
            var c = state.clips[i];
            if (c.group !== 0 || !typeOn(c)) continue;
            if (on) delete state.unpicked[clipKey(c)];
            else state.unpicked[clipKey(c)] = true;
        }
        renderClips();
        refreshExportEnabled();
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

    // The sequence's folder, which is where the clips are. Falls back to the root if the
    // export never got as far as creating it.
    el.reveal.addEventListener("click", function () {
        var d = outDir();
        reveal(exists(d) ? d : state.out);
    });
    el.showsaved.addEventListener("click", function () { reveal(state.folder); });
    el.updbtn.addEventListener("click", applyUpdate);
    el.checkupd.addEventListener("click", function () { checkUpdate(true); });
    el.recheck.addEventListener("click", function () { recheckScript(false); });

    el.gear.addEventListener("click", function () {
        var open = el.gearmenu.hidden;
        show(el.gearmenu, open);
        el.gear.className = "gearbtn" + (open ? " on" : "");
    });

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
                    // checkUpdate also sets the engine status line, so this is one
                    // subprocess rather than two saying overlapping things.
                    checkUpdate(false);
                } else {
                    // Re-run the panel-side search now that home is known for certain.
                    var again = findScript();
                    if (again) {
                        setScript(again);
                        checkUpdate(false);
                    } else {
                        // Every search has failed. Rather than sit there telling him to go
                        // find a file, fetch it — this is exactly the state the panel got
                        // stuck in before, with the engine sitting in plain sight in a
                        // folder macOS would not let it stat.
                        recheckScript(true);
                    }
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
        if (state.script) checkUpdate(false);
        // Deliberately does NOT read on open. Reading exports an XML as a side effect,
        // and a panel that writes files the moment it appears is a panel you cannot
        // trust to sit open while you work. Step 1 is a button.
    }
})();
