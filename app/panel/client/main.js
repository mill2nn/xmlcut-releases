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
    /* ⚠️ THIRTEEN IDS LEFT THIS LIST when the message rail arrived, and every one of them was
     * a box that could hold prose: err, mode, seqwarn, savednote, stripfoot, presetwarn,
     * outdest, fpswarn, typehint, scanning, stalled, readhint, repcomplete. They are not
     * features that were dropped — say() carries the same sentences into #railmsgs. The
     * elements are gone because a message needs a place, not an element of its own. */
    var ids = ["read", "seqbox", "seqname", "seqmeta", "opts", "types",
               "outpath", "pickout", "export", "prog", "barfill", "progtext",
               "cancel", "reveal", "again", "adv", "scriptpath", "openout",
               "pickscript", "cmd", "log", "tip", "ver", "step3",
               "report", "repsum", "tally", "onlyprob", "repcount", "copyrep",
               "tablewrap", "cliptable", "clipbody",
               "listnote", "listlbl", "savedbox", "savedpath", "showsaved",
               "mergebox", "resume", "updbar", "updtext", "updbtn",
               "typeall", "typelbl", "scripthelp",
               "readprog", "readfill", "readtext", "pickall", "checkupd",
               "gear", "gearmenu", "enginestat", "recheck",
               "repdestrow", "repdest", "repdestlbl", "mergedet", "mergesum",
               "jobtally", "copyout", "copydest",
               "preset", "crf", "fps",
               "sizeest", "savepreset", "delpreset", "crfread", "sweetcrf",
               "crfblock", "cap", "capnote",
               "rail", "railmsgs", "nextline", "step1", "step1body", "readagain",
               "remeasure", "vcodec",
               "scale", "scaleread",
               "onlyproblab",
               "actionbar", "barready", "retry", "audiosel", "wholeframes",
               "pocrender", "pocnote",
               "cutfrom", "vtrack", "vtrackfield",
               "wfwrap", "wfwhy", "vinclude"];
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
        /* THE RUN, ON THE ROWS. clipKey -> {st, t0, t1, bytes, note}, where st is one of
         * run · ok · over · bad · kept. This is what makes the table you planned with the
         * table you watch and then read: three separate lists used to be built here — the
         * plan, the job rows, the report rows — each hiding the one before it, in three
         * different visual languages, and none of them keeping your ticks or the type
         * colours. One list with a state per row replaces all of it. */
        rowState: {},
        /* An EXPORT is running. Kept apart from `busy`, which a scan also sets: a scan
         * deliberately leaves the settings live, because it records the settings it ran at
         * and the panel reports the difference as stale. A run cannot do that — the flags
         * are already on ffmpeg's command line — so its settings lock instead. */
        running: false,
        // What the finished read said, held for the sequence card to print. The progress bar
        // used to keep saying it, at 100%, for the rest of the session.
        readDone: "",
        // Every audio track this timeline has: [{index, items}], straight from the manifest.
        audioTracks: [],
        // What he last chose, remembered across sessions: "" · "all" · a track number.
        audioWant: "",
        /* A saved track NUMBER that was thrown away because the engine renumbered the tracks.
         * Held only long enough to say so once — see sayAudioRenumbered(). */
        audioDropped: "",
        // "premiere" once the engine reports it numbers tracks Premiere's way; "" for a
        // manifest from before that, whose numbers mean something else.
        audioNumbering: "",
        /* WHERE THE PIXELS COME FROM: "source" cuts the camera originals, "render" cuts
         * ranges Premiere rendered from the timeline, with the effects already in them.
         * Held here as well as on the select because renderVideoTracks() rebuilds the
         * track menu on every read and the choice has to survive that — the same reason
         * audioWant is not read off the select either. */
        cutFrom: "source",
        // The MASTER track: the one whose clips become files.
        vtrackWant: "",
        /* Which tracks are IN THE PICTURE, as "1,3". Separate from the master because they
         * answer different questions — where the cuts are, and what is visible in them.
         * Empty means "not chosen yet"; renderVideoTracks fills it from the timeline. */
        vIncludeWant: "",
        // The render phase's own progress, read off a file Premiere writes as it goes:
        // {done, total, current, failed}. Null when no render phase is running.
        renderProg: null,
        // How many cuts the last render phase failed to produce, off its manifest. Decides
        // whether the _renders scratch is kept for a retry — see cleanRenders().
        rendersMissing: 0,
        renderTimer: null,
        /* The clips a RETRY is limited to, as clipKeys. Empty for an ordinary export. It is
         * read once, when the pick file is written, and cleared there — a leftover here would
         * silently narrow the next full export to the last failures. */
        retryKeys: [],
        // A report that has just been built, so "only problems" may tick itself once. Cleared
        // as it is used — see renderReport().
        reportFresh: false,
        /* output filename -> clipKey. The engine announces a start by name AND key; the
         * completion line carries only the name, so the key is remembered here as each
         * clip starts. Empty for a clip that never starts (resume skipped it, or its
         * source is missing) — those are filled in from the manifest after the run. */
        jobKey: {},
        presets: {},     // named export settings, owned by the engine
        crfVal: 1,       // the one quality setting there is
        cap: 0,          // MB above which a clip is flagged as large; 0 = no flagging
        // Which settings the MEASURED sizes belong to. Not the current settings — the ones
        // the probe actually ran at, so the panel can say when the two have parted.
        probeCrf: 1,
        probeScale: 100,
        probeVcodec: "libx264",
        // Set for ONE scan by the Re-measure button, then cleared. The default scan must
        // stay free, so this is never sticky.
        wantProbe: false,
        scrubbing: false,   // composed into body's class by paintBody(), not written raw
        scale: 100,      // output resolution, percent of each source's own
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
        /* THE NAME OF THE SEQUENCE PREMIERE HAD OPEN at the last check, kept only so the
         * export's confirmation can name it. The comparison itself is on the ID, which is
         * never held here — it is read fresh every time, because a remembered ID is exactly
         * the stale fact this whole guard exists to prevent. See checkSequence(). */
        seqOpenName: "",
        /* CANCEL WAS PRESSED for the run that is going. Read by the render phase to decide
         * whether to hand over to the encode phase at all, and by the close handler so a
         * stopped run is reported as stopped rather than as finished. Cleared when a run
         * STARTS, never when one ends — a flag cleared on the way out can be cleared by the
         * very handler that was supposed to read it. */
        cancelled: false,
        /* --resume for THIS RUN ONLY, because he answered "Skip" to the Replace question.
         * Kept apart from state.resume, which is his standing choice on the tick: answering
         * one question must not silently rewrite a setting. Consumed where it is used. */
        resumeOnce: false,
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
    /* AN ExtendScript REPLY, OR NULL. One helper, because `try { JSON.parse } catch` is not
     * the guard it looks like.
     *
     * ⚠️ JSON.parse("null") DOES NOT THROW. It succeeds and returns null, so a catch-only
     * guard hands null downstream and the next property read takes the panel down with a
     * TypeError. An ExtendScript function that returns undefined answers exactly "null", so
     * this is what a host.jsx older than the panel produces — and it crashed the READ path
     * (`r.ok`), the XML path (`r.tried`) and the render path (`r.tried`), all three of which
     * had a catch and none of which was protected by it. Measured, not theorised: a probe
     * against a host answering "null" died on main.js's dumpActiveSequence callback.
     *
     * Returning null and letting each caller say its own thing keeps that decision where it
     * belongs — a failed read is fatal, a failed XML export is not. */
    function hostReply(raw) {
        var r = null;
        try { r = JSON.parse(raw); } catch (e) { return null; }
        return (r && typeof r === "object") ? r : null;
    }

    function jsStr(s) {
        return '"' + String(s === null || s === undefined ? "" : s)
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"')
            .replace(/\r/g, "\\r")
            .replace(/\n/g, "\\n") + '"';
    }

    /* Reading happens WHERE THE SEQUENCE CARD WILL BE, not below a disabled button.
     *
     * The button and its hint used to stay on screen for the whole read — a full-width
     * primary reading "Reading…" that could not be pressed, with the real progress in a bar
     * underneath it. Two things claiming to be what you were waiting on, and when the card
     * finally arrived it pushed everything down. Now the button steps aside for the duration
     * and the card takes the same slot when it lands.
     *
     * n < 0 is a FAILED read, and it has to put the button back — there is no other way to
     * try again from that state. */
    function readStage(n, extra) {
        if (n < 0) {
            show(el.readprog, false);
            show(el.step1body, true);
            return;
        }
        if (n >= READ_STEPS.length) {
            /* Done. The bar goes rather than sitting at 100% under a card that already says
             * what was read — it stayed on screen two states later, above the clip list,
             * reporting a step that had finished long before. What it had to say that the
             * card did not is folded into the card by renderSequence(). */
            show(el.readprog, false);
            state.readDone = extra || "";
            return;
        }
        var pct = Math.round((n / READ_STEPS.length) * 100);
        el.readfill.style.width = pct + "%";
        el.readtext.textContent = "Step " + (n + 1) + " of " + READ_STEPS.length + " · "
            + READ_STEPS[n] + (extra ? " — " + extra : "") + " …";
        show(el.step1body, false);
        show(el.readprog, true);
    }

    /* One flag for the whole read → export XML → scan sequence.
     *
     * Re-enabling the Read button inside the evalScript callback left it live while the
     * XML export and the scan were still running, so a second click started a second
     * export and a second --manifest-only process writing the same scan folder. */
    /* The settings stay on SCREEN during a run and stop being editable.
     *
     * They used to be hidden outright, along with the clip list, and replaced by a progress
     * section. Hiding them answered the same question — you cannot change the encoder half
     * way through an encode — by removing the evidence of what the run is doing, which is
     * exactly what you want to look at while waiting. Locked and legible beats gone. */
    var LOCK_WHILE_RUNNING = ["preset", "savepreset", "delpreset", "vcodec", "crf",
                              "fps", "scale", "cap", "remeasure", "pickout", "pickall",
                              "readagain", "read"];

    function setRunning(on) {
        state.running = !!on;
        for (var i = 0; i < LOCK_WHILE_RUNNING.length; i++) {
            var e = el[LOCK_WHILE_RUNNING[i]];
            if (e) e.disabled = state.running;
        }
        paintBody();
    }

    function setBusy(on, label) {
        state.busy = !!on;
        el.read.disabled = state.busy;
        el.pickout.disabled = state.busy;
        el.pickscript.disabled = state.busy;
        el.resume.disabled = state.busy;
        el.read.textContent = (state.busy && label) ? label : "Read timeline";
        el.readagain.disabled = state.busy;
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
        /* ⚠️ THE TYPE FILTER IS A SOURCE-MODE CONCEPT AND ONLY A SOURCE-MODE CONCEPT.
         *
         * In source mode the extension genuinely decides the export: ffmpeg opens the camera
         * file, so a .mogrt — a Zip archive — is something it cannot read. In RENDER mode the
         * pixels come from Premiere, which has already resolved the .png, the adjustment layer
         * and the Essential Graphics title that has no source file at all, so filtering on a
         * source extension filters on something nothing is reading. His words: "in timeline
         * mode i dont need to select anything like the mp4, mov, png just render the clip as
         * the master track".
         *
         * The engine reached the same conclusion from its own side — its --ext now exempts any
         * cut that is render_planned, has a render_path, or has no source path, because --ext
         * was DELETING the very rows --render-planned had just declared cuttable. Not sending
         * the flag says that once instead of twice, and it also covers the case the engine's
         * exemption cannot: a cut whose render FAILED has neither flag, so a .png on the
         * master track would be dropped by --ext on the retry. */
        if (!allTypes && state.cutFrom !== "render") {
            var exts = selectedExts();
            if (exts.length) args.push("--ext", exts.join(","));
        }
        /* The settings ride on BOTH now, and that is a reversal.
         *
         * They used to be export-only, on the reasoning that a scan encodes nothing so its
         * manifest would describe no file. That stopped being true when the size estimate
         * started MEASURING: the scan encodes a second of each clip, and it has to encode
         * it at the settings on screen or the number it produces belongs to some other
         * export.
         *
         * Extrapolating instead was tried and is not an option. Probing at crf 1 and
         * scaling to the target with CRF_SIZE_RATIO was measured at 1.8x to 10.5x wrong —
         * the table's shape is off, and it is off by DIFFERENT amounts for h264 and ProRes
         * sources (0.25-0.30 vs 0.14-0.16 of the crf-1 rate at crf 14), so no single curve
         * fixes it. Measure at the settings you are going to use. */
        args = args.concat(settingArgs());
        // Opt-in, and for ONE scan. Encoding a second of every clip is the accurate way to
        // size an export and the slow way; the default estimate is metadata only.
        if (state.wantProbe) {
            args.push("--size-probe");
            // Cleared as soon as it is USED, not on the reply: the next ordinary scan —
            // a re-read, a type change — must not silently start encoding again.
            state.wantProbe = false;
        }
        return args;
    }

    function spawnOpts() {
        return {
            cwd: path.dirname(state.script),
            /* ⚠️ ITS OWN PROCESS GROUP, and this is what makes Cancel able to stop anything.
             *
             * The engine encodes with ThreadPoolExecutor(max_workers=JOBS), so several ffmpeg
             * processes are its children at once, and it installs no signal handler. Killing
             * python3 alone therefore ORPHANS them and every clip in flight finishes and lands
             * — which is "I pressed stop and it exported to the end" from the far side.
             *
             * `detached` makes python3 the leader of a new group, so kill(-pid) reaches ffmpeg
             * too. Without it, -pid would be the PANEL's own group and the kill would signal
             * Premiere. unref() is deliberately NOT called: the panel still holds the handle
             * and still gets the close event. */
            detached: true,
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
    /* ONE HUE PER EXTENSION, not per family.
     *
     * This table used to give every video container the same blue — mp4, m4v, avi and webm
     * were indistinguishable, and so were png/jpg/tif/gif — which defeated the point of
     * colouring them at all. The dot beside a clip name and the chip that switches its type
     * on are the same colour, so "which of these rows are the .mov ones" is answered by
     * looking rather than by reading.
     *
     * Hues are spread around the wheel and the WIDELY SEPARATED ones go to the extensions
     * that actually turn up together. Siblings inside a family keep the family's hue and
     * shift lightness instead, so .m4v still reads as "a video like .mp4" while remaining
     * its own colour — related, not identical.
     *
     * Saturated for a dark panel: on #16181d every one of these clears 8:1 against the
     * ground, which the muted set they replaced did not.
     */
    var TYPE_COLORS = {
        // video containers — cyan-blue family, one step apart
        mp4: "#00b4ff", m4v: "#5ad9ff", avi: "#2f9fd9", webm: "#7d8bff",
        // QuickTime — violet, the one the timelines pair with mp4 most often
        mov: "#b57bff", qt: "#9a5ff0",
        // broadcast/transport — teal
        mxf: "#22e0c8", mts: "#3ff0d8", m2ts: "#19c4b0",
        mpg: "#14b8a6", mpeg: "#14b8a6", ts: "#0fa396",
        // camera raw — ember
        r3d: "#ff6a2f", braw: "#ff8a3f", ari: "#e05520", dng: "#ff9d5c",
        // stills — green
        png: "#3ff08a", jpg: "#ffd23f", jpeg: "#ffd23f", tif: "#7ce68a",
        tiff: "#7ce68a", bmp: "#a8e05f", gif: "#b6f03f", webp: "#5ce0a8",
        // layered art — magenta
        psd: "#ff5ecb", psb: "#e04fb0", ai: "#ff8fd8",
        // audio — orange
        wav: "#ff9f2f", mp3: "#ff7a45", aif: "#ffb85c", aiff: "#ffb85c",
        m4a: "#e08a3f", aac: "#ffc98a", flac: "#d9762f",
        // project files, which are never cuttable — red-pink, the warning family
        aep: "#ff5470", prproj: "#ff7d92", c4d: "#e03f5c",
        aet: "#ff9aab", ppj: "#ff7d92", fcpxml: "#d9455f"
    };

    /* For an extension the table has never heard of. Eight hues that do not collide with
     * each other; which one an extension lands on is deterministic, so it keeps its colour
     * between runs rather than changing every read. */
    var FALLBACK_COLORS = ["#4fd0ff", "#c08cff", "#3fe8b0", "#ffd45c",
                           "#ff8a7a", "#c6f04f", "#ff7ad0", "#5fd8e8"];

    function colorFor(ext) {
        if (TYPE_COLORS[ext]) return TYPE_COLORS[ext];
        if (ext === "(none)") return "#8b93a3";
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

    /* ---------------------------------------------------------------- the message rail
     *
     * ONE PLACE, and everything this panel has to SAY arrives in it.
     *
     * MEASURED before this existed: twenty-nine elements in index.html could put prose in
     * front of the reader — a warning under Frame rate, another beside the folder, another
     * above the Export button, an error below the whole page, a note inside the sequence
     * card — spread over five regions. "Is anything wrong?" was a question you answered by
     * SCANNING the page, and someone opening the panel for the first time had no way to
     * learn where to look. "1 người mới nhìn vào sẽ thấy rối đấy."
     *
     * say(key, sev, text[, title]) is the whole interface. ONE KEY PER SUBJECT, not per call
     * site, so the frame-rate warning occupies exactly one row however many times it is set;
     * an empty text removes the row. Rows come out ordered error → warn → info, and within a
     * severity in the fixed order of RAIL_KEYS, so a message never changes place because an
     * unrelated one appeared or went.
     *
     * WHAT DELIBERATELY DID NOT MOVE HERE, and why none of it is a rail message:
     *
     *   #enginestat #scripthelp #pocnote  inside the gear menu, which is an OVERLAY that
     *     COVERS the rail. A message produced by a button in there could not be seen at all
     *     if it went to the rail, and each already sits beside the control that produced it.
     *   #readtext #progtext #jobtally     the text OF a progress bar, under that bar.
     *   #listnote #repcount #capnote      counters over a list, in that list's own heading.
     *     They change on every tick, and one that jumped to the top of the panel each time a
     *     checkbox moved would be worse than the scatter this replaces.
     *   #wfwhy                            why THIS control is disabled, inside its label.
     *   #repdestlbl                       the caption on a path row, with its Copy button.
     *   td.sts and the group headings      per row, in the row.
     *
     * Everything else routes. Thirteen elements left index.html for this.
     */
    var RAIL_SEV = { error: 0, warn: 1, info: 2 };
    /* Every subject say() can occupy, in the order they appear WITHIN a severity. A key that
     * nothing writes would be a promise about an ordering that never happens, so this list and
     * the say() call sites are the same eighteen. */
    /* "seq" leads, ahead even of a hard failure: when the open sequence is not the one that
     * was read, every other row on the rail — the destination folder, the cut list, the size
     * estimate — is describing a sequence that is not on screen, so it is the row that has to
     * be read first. */
    var RAIL_KEYS = ["seq", "err", "failures", "audionum", "audio", "fps", "readmode",
                     "ramps", "types", "preset", "dest", "stall", "sizes", "rendermode",
                     "complete", "renders", "scan", "saved"];
    var railRows = {};        // key -> {sev, text, title}

    /* Delegated. renderRail() replaces innerHTML, so a listener bound to a row dies with
     * the row it was bound to — the close button has to be caught on the rail itself. */
    if (el.railmsgs) {
        el.railmsgs.addEventListener("click", function (ev) {
            var t = ev.target;
            var k = t && t.getAttribute ? t.getAttribute("data-x") : null;
            if (!k || !railRows[k]) return;
            say(k, railRows[k].sev, "");
        });
    }

    /* WHAT CHANGED, shown once after an update.
     *
     * Asked for by the team lead, who updates often and could not tell what he was getting:
     * "thêm phần changelog vào sau khi mọi người ấn update nhé". It cannot live in the update
     * RESPONSE — that update is performed by the OLD engine and rendered by the OLD panel, so
     * neither knows this text exists. It therefore appears on the first launch AFTER the
     * version changes, which is the first moment the new code is the code running.
     *
     * Keyed by the version in xmlcut.py, which readVersion() already reads, so there is no
     * second place to bump. Vietnamese because the people reading it are the video team. */
    var CL_354 = [
            "Nested sequence — ở Timeline render, mỗi nest giờ ra 1 clip. Trước đây nest dùng "
            + "lại lần thứ 2 bị bỏ qua hoàn toàn nên thiếu cut.",
            "Track audio giờ đánh số đúng như Premiere. Trước đây panel hiện A1–A7 cho timeline "
            + "chỉ có 4 track, nên chọn A2 có thể ra tiếng của A1. ⚠️ Lựa chọn audio cũ đã "
            + "được xoá — chọn lại giúp mình nhé.",
            "Sau mỗi lần chạy, panel báo rõ track nào thật sự được mix, và báo đỏ nếu khác với "
            + "track mình đã chọn.",
            "Clip xuất ra chia 2 folder: raw/ khi cắt từ source, edited/ khi render từ "
            + "timeline. Không còn trộn 2 lần chạy vào chung 1 folder.",
            "Folder _renders tự xoá sau khi chạy xong sạch; nếu có clip lỗi thì giữ lại để "
            + "Retry không phải render lại từ đầu.",
            "Thêm nút mở folder cạnh Export. Thông báo gom về một chỗ, thanh dưới gọn hơn, và "
            + "lý do một clip lỗi giờ đọc được thay vì bị cắt mất."
    ];
    /* 3.54's list is carried forward rather than retyped: 3.54 went out and was replaced
     * within the hour, so anyone who lands straight on 3.55 must still be told what 3.54
     * changed — otherwise the release they skipped is the one nobody hears about. */
    var CL_355 = CL_354.concat([
        "Thông báo này giờ có nút × để tắt đi khi đã đọc xong."
    ]);
    /* ⚠️ 3.56 leads with a data-loss fix, so it goes FIRST in the list and not last. An audit
     * measured render mode silently deleting up to 72% of the cuts the scan had shown — 68
     * rows offered, 19 delivered on one real timeline — because the flag that marks a row as
     * render-backed was set AFTER the file-type filter that reads it. Anyone who exported in
     * Timeline render mode on 3.53-3.55 got fewer clips than the panel promised. */
    var CHANGELOG = {
        "3.54": CL_354,
        "3.55": CL_355,
        "3.56": [
            "⚠️ SỬA LỖI MẤT CLIP — quan trọng nhất bản này. Ở Timeline render, panel hiện "
            + "22 clip nhưng export ra ít hơn (có lần chỉ 6). Nguyên nhân: bộ lọc loại file "
            + "chạy TRƯỚC khi đánh dấu clip sẽ được render, nên .mov / .png / graphic bị xoá "
            + "âm thầm. Ai đã export bằng Timeline render ở bản 3.53–3.55 nên chạy lại.",
            "Ở Timeline render giờ không cần tick loại file nữa — mọi clip trên master track "
            + "đều được render, kể cả ảnh và graphic không có source.",
            "Panel kiểm tra sequence đang mở có đúng là sequence đã Read hay không. Không "
            + "khớp thì báo đỏ, và bấm Export sẽ hỏi lại trước khi chạy.",
            "Transition: cắt theo đúng in/out của clip trên master track, không cắt ở giữa "
            + "transition nữa.",
            "Hai clip giống hệt nhau trong cùng một nested sequence giờ tính là một, nên bỏ "
            + "tick một cái không còn làm mất cả hai.",
            "Bấm Cancel là dừng thật; nếu export lại mà trùng tên file thì panel hỏi Replace.",
            "Clip không có source (nest, title, graphic) giờ cũng có số dung lượng ước lượng."
        ].concat(CL_355)
    };

    /* Shown when the running version differs from the one last seen here.
     *
     * ⚠️ `hadPrior` exists because xmlcut.seenver DID NOT EXIST before this release, so its
     * absence cannot distinguish "just updated from 3.53" from "installed for the first time
     * five seconds ago". A remembered save-to folder or engine path proves the copy has been
     * used before, which is exactly the population this text is for. A fresh install gets
     * nothing: a changelog for a version you never had is noise. */
    function noteVersion(ver) {
        if (!ver) return;
        var seen = null, hadPrior = false;
        try {
            seen = window.localStorage.getItem("xmlcut.seenver");
            hadPrior = !!(window.localStorage.getItem("xmlcut.out")
                          || window.localStorage.getItem("xmlcut.script"));
        } catch (e) { return; }
        if (seen === ver) return;
        try { window.localStorage.setItem("xmlcut.seenver", ver); } catch (e) {}
        if (!seen && !hadPrior) return;
        var lines = CHANGELOG[ver];
        if (!lines || !lines.length) return;
        say("changelog", "info", "Bản " + ver + " có gì mới:\n• "
            + lines.join("\n• "), "", true);
    }

    function say(key, sev, text, title, dismissable) {
        var t = String(text === null || text === undefined ? "" : text);
        var had = railRows[key];
        if (!t) {
            if (!had) return;
            delete railRows[key];
        } else {
            if (had && had.sev === sev && had.text === t && had.title === title
                && had.dismiss === !!dismissable) return;
            railRows[key] = { sev: sev, text: t, title: title || "",
                              /* Only rows you have FINISHED with get a close button. A warning
                               * you can dismiss is a warning you can dismiss without fixing,
                               * so this is opt-in per subject rather than on by default. */
                              dismiss: !!dismissable };
        }
        renderRail();
    }

    /* Rebuilt whole rather than patched. There are never more than a handful of rows, and a
     * patcher would have to know which row moved when a severity changed — which is exactly
     * the class of bug that made the old scatter impossible to reason about. */
    function renderRail() {
        if (!el.railmsgs) return;
        var keys = [], k;
        for (k in railRows) {
            if (Object.prototype.hasOwnProperty.call(railRows, k)) keys.push(k);
        }
        keys.sort(function (a, b) {
            var d = RAIL_SEV[railRows[a].sev] - RAIL_SEV[railRows[b].sev];
            if (d) return d;
            var ia = RAIL_KEYS.indexOf(a), ib = RAIL_KEYS.indexOf(b);
            return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        });
        el.railmsgs.innerHTML = "";
        for (var i = 0; i < keys.length; i++) {
            var r = railRows[keys[i]];
            var d = document.createElement("div");
            d.className = "msg " + r.sev;
            // Read by the tests to find a row by SUBJECT rather than by position: rows are
            // created and destroyed as messages come and go, so children[3] means nothing.
            d.setAttribute("data-k", keys[i]);
            if (r.title) d.title = r.title;
            d.textContent = r.text;
            if (r.dismiss) {
                var x = document.createElement("button");
                x.type = "button";
                x.className = "msgx";
                x.setAttribute("data-x", keys[i]);
                x.setAttribute("aria-label", "close this message");
                x.title = "close";
                x.textContent = "\u00d7";
                d.appendChild(x);
                d.className += " hasx";
            }
            el.railmsgs.appendChild(d);
        }
    }

    /* The report is TWO blocks now — its counts and its destination sit above the list it
     * describes (#repsum), its next action sits in the bar (#report) — so they are revealed
     * together or not at all. Two show() calls at three sites is three chances to leave one
     * of them on screen alone. */
    function showReport(on) {
        show(el.report, on);
        show(el.repsum, on);
    }

    /* THE ONE WRITER of body's class, because two of them fought.
     *
     * A scrub sets a cursor for the whole page and the wide layout needs a class of its own;
     * each was assigning document.body.className directly, so whichever ran last erased the
     * other — drag the size flag while the export column was up and the layout collapsed to
     * one column mid-drag. Both are state now, and this composes them. */
    function paintBody() {
        var c = [];
        if (state.scrubbing) c.push("scrubbing");
        // Only claim the second column once there is something IN it. A grid reserves the
        // column regardless of whether its child is hidden.
        /* `cols` is gone with the two-column grid. It existed only to keep a CSS grid from
         * reserving a column for #step3 before there was anything in it — there is no grid
         * now, and no column to reserve. */
        // Dims the settings strip and mutes the row ticks. One writer for body's class —
        // this function — so a run cannot silently drop `scrubbing`.
        if (state.running) c.push("running");
        document.body.className = c.join(" ");
    }

    function log(line) {
        if (el.log.textContent === "—") el.log.textContent = "";
        el.log.textContent += line + "\n";
        el.log.scrollTop = el.log.scrollHeight;
    }

    function fail(msg) {
        say("err", "error", String(msg));
        log("ERROR " + msg);
    }

    function clearError() { say("err", "error", ""); }

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
            // The engine file is the single source of the version, so the changelog is keyed
            // off the same read rather than a constant that would drift from it.
            if (m) noteVersion(m[1]);
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
        state.readDone = "";
        el.clipbody.innerHTML = "";
        el.types.innerHTML = "";
        el.listnote.textContent = "";
        show(el.seqbox, false);
        show(el.step1body, true);
        el.step1.className = "step";
        show(el.opts, false);
        show(el.step3, false);
        show(el.tablewrap, false);
        /* ⚠️ #mergedet, NOT #mergebox — and getting this wrong is why "3 merge notes"
         * expanded to nothing.
         *
         * #mergebox is the INNER div of the <details>. This line used to hide it, from back
         * when it was the whole box, and the reset was never re-aimed after the disclosure
         * wrapper arrived. Nothing ever un-hid it, so from the first read onwards the body
         * was display:none for the rest of the session while renderMerge() went on showing
         * #mergedet with a count on its summary. He clicked it and got an empty box, twice.
         * Hiding the disclosure is what was meant: it takes its body with it. */
        show(el.mergedet, false);
        showReport(false);
        show(el.prog, false);
        /* Every rail row that belonged to the PREVIOUS read goes with it. They used to be
         * cleared one show(el.x, false) at a time, which is how "Premiere only" from the last
         * sequence survived into a read of a different one. */
        say("readmode", "info", "");
        say("ramps", "warn", "");
        say("saved", "info", "");
        say("types", "warn", "");
        say("audio", "info", "");
        say("complete", "info", "");
        say("sizes", "warn", "");
        say("renders", "info", "");
        say("failures", "error", "");
        /* And the mismatch row, which this read is about to settle one way or the other:
         * pressing Read is one of the two ways to resolve it (switching back is the other),
         * so leaving it up while the read runs would show an error about a state that has
         * just been replaced. */
        say("seq", "error", "");
        // The destination is named after the sequence, so it is unknown again until this
        // read answers. Leaving the old sequence's folder on screen would name the wrong
        // one — the same staleness as the clip table above.
        setOutDest();
        setBusy(true, "Reading…");
        readStage(0);
        readTimer(true);

        cs.evalScript("dumpActiveSequence()", function (raw) {
            if (!resumeRead()) return;
            var r = hostReply(raw);
            if (!r) {
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
            /* ⚠️ ONLY WHEN SOMETHING HAPPENED. This was a note under the saved path on every
             * single read, saying "a new pair each read · newest 10 kept" — which is the
             * policy, not news, and is already on the ? beside that very path. What IS news is
             * that files were deleted, or that the read did not land beside the project. */
            var note = [];
            if (r.pruned) {
                note.push(r.pruned + " older read" + (r.pruned === 1 ? "" : "s")
                    + " pruned — the newest " + keep + " are kept");
            }
            if (r.beside_project === false) {
                note.push("This project is unsaved, so the read went to the Desktop "
                    + "instead of beside the project.");
                log("project not saved — falling back to the Desktop");
            }
            say("saved", "info", note.join(" "));
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
                var r = hostReply(raw);
                if (!r) {
                    r = { ok: false, error: "unreadable reply from Premiere" };
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

    /* WHICH SOURCES the next export will use — but only when the answer costs you something.
     *
     * ⚠️ SPEAKS ONLY IN THE DEGRADED CASE, and that is a deliberate cut rather than an
     * omission. This was a note in the sequence card with three states, and two of the three
     * were already on screen somewhere else:
     *
     *   "Exporting XML…"     the read's own progress bar says "Step 2 of 3 · Asking Premiere
     *                        to export the XML", six pixels away, at the same moment.
     *   "XML + Premiere · …" the sequence card's meta line already ends with "· XML +
     *                        Premiere" — see state.readDone and renderSequence().
     *
     * So the only reading of this that was not a duplicate is the one where the XML failed and
     * nests will be skipped. That one is a warning, and it is the one that is kept. */
    function setMode(busyText) {
        if (busyText) return;
        say("readmode", "warn", state.xml ? "" : "Premiere only · XML export unavailable, "
            + "nested sequences will be skipped");
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
                // A project file is only dead when its own bytes are what get cut. In
                // render mode Premiere resolves the Dynamic Link, so .aep is live like
                // anything else — otherwise the one mode that can export it starts with
                // it switched off.
                else on = !DEAD_TYPES[ext] || state.cutFrom === "render";
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
        /* ⚠️ NOT IN RENDER MODE. The rescue below exists so a timeline can never open with
         * nothing cuttable ticked — but in render mode no tick gates anything, so there is no
         * such state to rescue, and running it anyway would rememberTypeChoices() a change he
         * never made and carry it into his next SOURCE export. */
        if (state.cutFrom === "render") return true;
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
    /* ⚠️ PAIRED WITH THE ENGINE, and it has to stay paired. The engine refuses these in
     * source mode; until this list matched it, the panel offered a type the engine would
     * refuse, TICKED BY DEFAULT — and a .mogrt is a Zip archive, so ffmpeg answers "Invalid
     * data found when processing input" and the clip simply does not appear. In render mode
     * Premiere resolves them, which is why this is a list of what cannot be CUT rather than a
     * list of what is not media; see ensure() in typesFromClips(). */
    var DEAD_TYPES = { aep: 1, prproj: 1, psb: 1, c4d: 1, aet: 1, ppj: 1, fcpxml: 1,
                       aegraphic: 1, mogrt: 1 };

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
            + " as Premiere counts them"
            // What the finished read had to say, on the card rather than on a progress bar
            // left at 100%: "37 cut(s) read · XML + Premiere".
            + (state.readDone ? " · " + state.readDone : "");
        show(el.seqbox, true);
        // A finished step 1 folds away. Its full-width blue button competed with the
        // one you actually want next, and took a third of the panel to say a line's
        // worth. `Read again` in the summary card is the way back.
        show(el.step1body, false);
        el.step1.className = "step done";

        say("ramps", "warn", r.keyframed_ramps > 0
            ? (r.keyframed_ramps + " clip"
               + (r.keyframed_ramps === 1 ? " has" : "s have")
               + " a keyframed speed ramp. The range extracted is exact; the speed "
               + "is treated as constant.")
            : "");

        // The destination folder is named after this sequence, so it is only knowable now.
        setOutDest();
        /* ⚠️ AND THE RENDER-MODE NOTE, WHICH COULD NOT APPEAR BEFORE THIS LINE EXISTED.
         *
         * renderStripFoot() opens with "nothing until the number exists" — the render bitrate
         * is frame size x fps x quality, so it is unknowable until a read has reported the
         * sequence's pixels. But nothing re-ran it WHEN the read landed: it was reached only
         * from renderSettings(), i.e. from touching a control. So in render mode the note
         * stayed empty from launch until something unrelated was nudged, which is the same
         * class of defect as a count over an empty box — a message with no route to the
         * screen. Found by a test asserting the note's wording and reading "". */
        renderStripFoot();
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
        // Stronger than the 0.18 it was: the chip has to read as lit from its own
        // colour rather than tinted with a hint of it.
        return "rgba(" + r + "," + g + "," + b + ",0.22)";
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
        /* Nothing to advise while a read is in flight: the type list is empty by
         * construction at that point, and "this timeline has no media that can be cut" is a
         * conclusion about a timeline that has not been read yet.
         *
         * ⚠️ AND NOTHING TO ADVISE BEFORE ONE, which this did not check. It could not be seen:
         * #typehint lived inside #opts, which is hidden until a scan lands, so the sentence
         * was drawn into a hidden container and nobody ever met it. On the rail there is
         * nowhere to hide, and the panel's very first screen said "This timeline has no media
         * that can be cut." above a button asking you to read a timeline. */
        if (state.busy || !state.clips.length) return "";
        /* ⚠️ SILENT IN RENDER MODE, because every sentence below it is about the type filter
         * and the type filter does not apply there. "Not selected: .aegraphic (36), .png (15)
         * — clips of those types are on this timeline and will NOT be cut" is simply FALSE
         * when Premiere is rendering them, and "This timeline has no media that can be cut"
         * is false of a timeline made entirely of graphics. A warning that is wrong is worse
         * than no warning: it sends him to fix something that is already right. */
        if (state.cutFrom === "render") return "";
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

    /* WHICH MODE THE BOTTOM BAR IS IN, derived from what is already true rather than
     * tracked in a flag of its own. #prog and #report keep the ids the old sections had, so
     * every show() that used to reveal a section now reveals a row of the bar; this is the
     * one line that keeps the third row — the ready one — out of their way.
     *
     * Derived, because a tracked mode is a fourth thing to keep in step with the other
     * three, and the run already has two flags. */
    function barMode() {
        if (!el.barready) return;
        var running = el.prog.hidden === false, done = el.report.hidden === false;
        show(el.barready, !running && !done);
        // The report's counts live above the list now, so they follow the bar's DONE row.
        show(el.repsum, done);
        /* ⚠️ NO BAR UNTIL THERE IS SOMETHING TO DO WITH IT. Before a read the panel's floor
         * held a disabled "Export clips" — a second, dead call to action under the one button
         * that actually did anything, on a screen whose whole job is to say "read a timeline
         * first". The bar earns its place once there is a list, and comes back for a run's
         * progress or its result whatever the list is doing. */
        show(el.actionbar, running || done || state.clips.length > 0);
    }

    function refreshExportEnabled() {
        barMode();
        var n = selectedCount();
        // Neutral when the panel fixed it itself, amber when he has to act.
        say("types", state.typesReset ? "info" : "warn", typeHint());
        // `!state.busy` is load-bearing, not belt-and-braces: setBusy() disables Read and
        // the pickers but never touched Export, so it stayed live through a read — and
        // during a read state.dump still points at the PREVIOUS sequence.
        var ready = !!(state.dump && state.script && state.out && n > 0) && !state.busy;
        el["export"].disabled = !ready;
        // Openable as soon as there is a root, not only once clips exist: checking where the
        // files will land is a thing you do BEFORE committing, which is the whole reason this
        // sits beside Export rather than in the report.
        el.openout.disabled = !state.out;
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
        renderNext();
    }

    /* ONE SENTENCE saying what to do next, and it is never blank.
     *
     * Everything the panel knew about its own state used to be spread across a disabled
     * button, the hint under it, a warning box and a note beside the folder — so "what do
     * I press now" was something the reader had to assemble from four places, and the
     * commonest question about this panel was exactly that.
     *
     * Ordered by what BLOCKS progress, most fundamental first, because that is the order
     * the answers have to come in: no engine beats no read beats no folder beats nothing
     * ticked. The last branch is the happy one and it still says something, because a line
     * that empties out when everything is fine reads as a line that broke.
     */
    function renderNext() {
        if (!el.nextline) return;
        var n = selectedCount(), cls = "msg next", msg;
        if (state.busy) {
            msg = "Reading the timeline…";
            cls += " busy";
        } else if (!state.script) {
            msg = "The cut script is missing. Open ⚙ and press Re-check to fetch it.";
            cls += " error";
        } else if (el.report && el.report.hidden === false && failedRows().length) {
            /* THE FAILURE HEADLINE, in the line that is already at the top of the panel. The
             * rows carry their own reasons and the bar carries the count, but both are below a
             * table that can be nineteen rows long — and "some of your clips are missing" is
             * not something to scroll for. When every failure shares a reason, it is said
             * once here rather than read off each row. */
            var bad = failedRows();
            var why = bad[0].facts || "";
            var same = true;
            for (var b = 1; b < bad.length; b++) {
                if ((bad[b].facts || "") !== why) { same = false; break; }
            }
            msg = bad.length + " clip" + (bad.length === 1 ? "" : "s") + " did not write"
                + (same && why ? " — " + why : "")
                + ". Retry them below, or open Advanced for the log.";
            cls += " error";
            /* ⚠️ AND WHEN THEY DO NOT SHARE A REASON, THE REASONS THEMSELVES.
             *
             * The status column is 76px docked and these cells clip rather than wrap, so
             * "failed — encoder exit 1" — which needs 131px — was unreadable at every width the
             * panel is used at. The cell now says "failed"; this is where the reason lives when
             * the line above cannot state it once. Only then: a rail row repeating what the
             * headline already says would be the duplication this rail exists to remove. */
            var list = [];
            for (var f2 = 0; f2 < bad.length; f2++) {
                list.push(bad[f2].name + " — " + (bad[f2].facts || "no reason reported"));
            }
            say("failures", "error", same ? "" : ("Why each one failed: " + list.join("; ")));
        } else if (!state.dump) {
            /* THE EMPTY STATE, IN ONE ROW. This said "Open a sequence in Premiere, then read
             * it." with a paragraph six pixels below it saying the same thing at greater
             * length — the panel's very first screen told a first-time reader the same thing
             * twice, in two components. What the paragraph added and this keeps is the half
             * that answers "is this safe": nothing is written until Export. What it also
             * claimed — nests resolved, speed ramps read — is on the button's own tooltip,
             * where a capability boast costs no pixels. */
            msg = "Open the sequence you want in Premiere, then press Read timeline. "
                + "Nothing is written until you press Export.";
        } else if (!state.out) {
            msg = "Choose a folder to save into.";
        } else if (!n) {
            // There is no file type to pick in render mode — the chips are not on screen.
            msg = state.cutFrom === "render"
                ? "Nothing is ticked yet — pick at least one clip."
                : "Nothing is ticked yet — pick at least one clip or file type.";
            cls += " warn";
        } else {
            msg = "Ready. " + n + " clip" + (n === 1 ? "" : "s") + " will be written into "
                + (seqFolder() ? seqFolder() + "/" : "the folder above") + ".";
            cls += " good";
        }
        el.nextline.textContent = msg;
        el.nextline.className = cls;
        // renderNext runs from refreshExportEnabled, which fires on every transition that
        // shows or hides step 3 — so the layout follows without a second hook to forget.
        paintBody();
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

    function jobsReset(total, only) {
        state.jobs = {};
        state.jobOrder = [];
        state.jobTotal = total || 0;
        state.jobDone = 0;
        state.lastEvent = nowMs();
        if (state.jobTimer) clearInterval(state.jobTimer);
        // Ticks whether or not the engine says anything, so the elapsed times keep moving.
        // A number that advances is the difference between "slow" and "dead".
        state.jobTimer = setInterval(renderRun, 1000);
        /* The rows start clean too. Without this a second run showed the FIRST run's greens
         * and reds until each clip reported again — a row claiming a size from a run that
         * had been abandoned.
         *
         * ⚠️ A RETRY clears only the clips it is about to re-run. It exports two of nineteen,
         * so wiping all of them would throw away seventeen results this run is not touching
         * and cannot restore — the retry's own manifest holds only the two. */
        if (only && only.length) {
            for (var z = 0; z < only.length; z++) delete state.rowState[only[z]];
        } else {
            state.rowState = {};
        }
        state.jobKey = {};
        el.jobtally.textContent = "";
        say("stall", "warn", "");
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

    /* The key the engine sent, converted to the one this panel keys cuts by. The engine
     * writes it with slashes because space-separated fields inside a line that also
     * carries a filename cannot be parsed back apart.
     *
     * FOUR FIELDS is the current engine: type, track, in, out — clipKey() exactly.
     *
     * THREE is an engine OLDER than this panel, from before the out-point was in the key.
     * It is resolved against the clip list rather than dropped, because the out-point is
     * the only thing that changed and the list already holds it: on a timeline where the
     * triple is unique — nearly all of them — a version mismatch then costs nothing.
     *
     * ⚠️ AMBIGUOUS MEANS DARK. Where two cuts share an in-point, an old engine cannot say
     * which of them it started. Lighting one anyway would put a running clip's elapsed time
     * and result on a clip that is not running, and there would be nothing on screen to say
     * so. Showing nothing is the honest failure; the manifest sets both rows right when the
     * run ends. */
    /* ⚠️ RESOLVED AGAINST THE CLIP LIST, BOTH LENGTHS, and that is the half that makes the
     * cut_id change safe.
     *
     * The engine's progress line is still "video/1/0/72 name.mp4" — the id was deliberately
     * NOT put in it, because the matcher for that line is
     * /^\s*>>\s+(?:([a-z]+\/\d+\/\d+(?:\/\d+)?)\s+)?(.+)$/ and a fifth slash component makes
     * group 1 fail, which dumps the whole token into the FILENAME group and takes live
     * progress out on the panel that is already installed.
     *
     * So the 4-field branch can no longer just reassemble the fields into a key: clipKey()
     * now returns an id whenever the manifest carried one, and a reassembled four-field
     * string would match no row at all. It has to look the clip up and ask clipKey() what
     * that clip's key IS — which is what the 3-field branch has always done, and for the
     * same reason. Ambiguous stays dark: that is this panel's existing convention for "we do
     * not know which row", and a wrong row lighting up is worse than none. */
    function keyFromEngine(k) {
        var p = String(k || "").split("/");
        if (p.length !== 3 && p.length !== 4) return "";
        var hit = "", n = 0;
        for (var i = 0; i < state.clips.length; i++) {
            var c = state.clips[i];
            if (String(c.trackType) === p[0] && String(c.trackIndex) === p[1]
                && String(c.timelineIn) === p[2]
                && (p.length === 3 || String(c.timelineOut) === p[3])) {
                hit = clipKey(c); n++;
            }
        }
        return n === 1 ? hit : "";
    }

    function setRow(key, patch) {
        if (!key) return;
        var r = state.rowState[key] || (state.rowState[key] = {});
        for (var f in patch) if (patch.hasOwnProperty(f)) r[f] = patch[f];
    }

    function jobStart(name, engineKey) {
        if (!state.jobs[name]) state.jobOrder.push(name);
        state.jobs[name] = { status: "run", t0: nowMs() };
        var key = keyFromEngine(engineKey);
        if (key) {
            state.jobKey[name] = key;
            setRow(key, { st: "run", t0: nowMs(), t1: 0, bytes: 0, note: "" });
        }
        state.lastEvent = nowMs();
        renderRun();
    }

    function jobDone(name, flag) {
        var j = state.jobs[name];
        if (!j) { state.jobOrder.push(name); j = state.jobs[name] = { t0: nowMs() }; }
        j.status = (flag === "OK" || flag === "HAVE") ? "ok" : "bad";
        j.flag = flag;
        j.t1 = nowMs();
        state.jobDone++;
        /* HAVE is not a failure and not a write: --resume found the file already there.
         * It gets its own row state so the row can say so instead of going green as
         * though this run had produced it. */
        var key = state.jobKey[name] || "";
        if (key) {
            setRow(key, { st: flag === "HAVE" ? "kept" : (j.status === "ok" ? "ok" : "bad"),
                          t1: nowMs(),
                          // Done as far as stdout knows. The SIZE is still unknown at this
                          // point — the manifest carries it and is not written until the
                          // whole run ends — so `bytes` stays 0 and the size cell says so
                          // with a tilde rather than promising a measurement.
                          done: true,
                          note: flag === "HAVE" ? "already there" : "" });
        }
        state.lastEvent = nowMs();
        renderRun();
    }

    function secs(ms) {
        var s = Math.max(0, Math.round(ms / 1000));
        return s < 60 ? (s + "s") : (Math.floor(s / 60) + "m " + (s % 60) + "s");
    }

    /* The run, drawn on the list that is already on screen.
     *
     * This replaced renderJobs(), which built a SECOND list — #joblist — of the clips the
     * table above it was already showing: running ones first, then the last eight finished,
     * name and elapsed only. It appeared where the table had been hidden, so the ticks, the
     * type colours, the frame counts and the size column all went away for the length of the
     * run, and the rows were in a different order from the ones you had just been reading.
     *
     * Now the table stays and its rows carry the state. What is left here is the tally and
     * the quiet-run note, which are about the run as a whole rather than any one clip. */
    function renderRun() {
        var now = nowMs(), running = 0, finished = 0;
        for (var i = 0; i < state.jobOrder.length; i++) {
            if (state.jobs[state.jobOrder[i]].status === "run") running++;
            else finished++;
        }
        var queued = Math.max(0, state.jobTotal - running - finished);
        el.jobtally.textContent = running + " encoding · " + finished + " done"
            + (queued ? (" · " + queued + " queued") : "");
        renderClips();          // the rows are the progress display now

        /* Said out loud rather than left to be inferred from a still bar. Not called
         * "frozen": several clips encoding at once on network media legitimately go quiet
         * for a while, and crying wolf would make the message worthless. */
        var quiet = now - (state.lastEvent || now);
        if (quiet > STALL_AFTER && running) {
            var longest = 0;
            for (var q = 0; q < state.jobOrder.length; q++) {
                var jj = state.jobs[state.jobOrder[q]];
                if (jj.status === "run") longest = Math.max(longest, now - jj.t0);
            }
            say("stall", "warn", "No clip has finished for " + secs(quiet)
                + ". Still working — the longest running clip has been going "
                + secs(longest) + ". Large or Drive-backed media takes this long; "
                + "the times on the rows keep moving while it is alive.");
        } else {
            say("stall", "warn", "");
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

    /* RAW OR EDITED, one subfolder per kind of output.
     *
     * "make the timeline export into the edited folder, and source export into the raw folder"
     * — and the reason it was asked for is a collision he hit: a source run and a timeline run
     * of the same sequence landed in one folder, both numbering their output 01..N, so the
     * second run's 01–06 overwrote the first's. Two folders make the two kinds of output
     * un-collidable and say which is which without opening a file.
     *
     * ⚠️ This does NOT stop two runs of the SAME kind colliding — two timeline exports still
     * both write into edited/ — which is a separate problem and still open.
     *
     * Read off state.cutFrom, which is the same value doExport() and renderSpec() branch on.
     * There is deliberately no second way of asking "am I in render mode". */
    function outKind() {
        return state.cutFrom === "render" ? "edited" : "raw";
    }

    /* Where THIS export writes. Empty until a sequence has been read, since the folder is
     * named after it. Everything that touches the output — the argv, the manifest the
     * report is built from, Show in Finder, the destination notice, renderDir() — goes
     * through here so they cannot disagree. */
    function outDir() {
        if (!state.out) return "";
        var f = seqFolder();
        return f ? path.join(state.out, f, outKind()) : state.out;
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
        if (!state.out) {
            say("dest", "info", "");
            return;
        }
        if (!state.info) {
            /* SILENT UNTIL THERE IS A FOLDER TO TALK ABOUT. This used to state the raw/edited
             * rule here, which put a row on the rail before anything had happened — and the
             * rail is for what needs attention, not for rules. The rule lives on the Save to
             * field's own ? instead, which is where you look when you want to know where
             * things land. What this branch has to say arrives after a read: whether the
             * target folder already holds files. */
            say("dest", "info", "");
            return;
        }
        var d = outDir();
        var n = countIn(d);
        /* ⚠️ SILENT WHEN THERE IS NOTHING TO WARN ABOUT. The happy reading of this note was
         * "→ PROMO_A_v3/", and renderNext() already ends with "…will be written into
         * PROMO_A_v3/." — the same folder, named twice, two rows apart on the same rail.
         *
         * A folder that ALREADY HOLDS FILES is the reading nothing else covers, and it
         * matters: a re-export overwrites the names it reproduces and leaves everything else,
         * so a folder from a DIFFERENT version of this timeline ends up holding a mix of both.
         * Tick "skip clips already there" to add only what is missing, or empty it first. */
        say("dest", "warn", n > 0
            ? (seqFolder() + "/" + outKind() + "/ exists already, with " + n
               + " file(s) in it. A re-export overwrites the names it reproduces and leaves "
               + "the rest, so the folder can end up holding two versions of this timeline.")
            : "", d);
    }

    function setOut(p) {
        state.out = p || "";
        setPathLabel(el.outpath, state.out, 40);
        try { window.localStorage.setItem("xmlcut.out", state.out); } catch (e) {}
        setOutDest();
        refreshExportEnabled();
    }

    /* ============================== IS THE OPEN SEQUENCE STILL THE ONE THAT WAS READ?
     *
     * THE FAILURE THIS EXISTS FOR: Read on sequence A, switch to B in Premiere, Export. The
     * cut list, the frame ranges, the file names and the manifest are all A's, and he is
     * looking at B. In source mode that is a wrong LIST — the clips are still cut from A's
     * own media, so nothing of B is inside them. In TIMELINE RENDER mode it is far worse:
     * Premiere renders whatever sequence is active, so every file would hold B's pixels under
     * A's name, A's number and A's timecode, and nothing in the output or in the report would
     * say so. Wrong data that looks right is the one thing this tool may not produce — it
     * exists to build a training set.
     *
     * COMPARED ON THE ID, NEVER THE NAME. A duplicate, a _v2, two sequences in different
     * bins can all be called the same thing, so a name comparison would agree on precisely
     * the confusion being guarded against. The names are carried only so a message can say
     * which sequence is which — "mismatch" on its own makes him go and work that out.
     *
     * ⚠️ THE ONE HOLE LEFT: if Premiere returns no sequenceID at either end, two different
     * sequences that share a name cannot be told apart here. That downgrade is said out loud
     * in the message and written to the log rather than hidden — a silent weaker check is how
     * a guard becomes a false reassurance.
     */

    /* 20 SECONDS while idle, and the number is a choice.
     *
     * Every check is a round trip into ExtendScript, which competes with Premiere's own main
     * thread — so this is not a tight timer, and it is not the primary trigger either. The
     * moment that actually matters is the focus check: he switches sequence in Premiere and
     * comes straight back to the panel. The interval only covers the panel that is visible
     * and never refocused — undocked, or on a second monitor — where 20s means the row is up
     * long before anyone could pick settings and reach Export. Three round trips a minute is
     * nothing beside one read, and it never fires while the panel is busy or a run is going. */
    var SEQ_CHECK_MS = 20000;

    function readSeqName() { return state.info ? String(state.info.sequence || "") : ""; }
    function readSeqId() { return state.info ? String(state.info.sequence_id || "") : ""; }

    /* Quoted, so a sequence called "final" or "V2" reads as one thing inside a sentence. */
    function qn(s) {
        return "“" + String(s === null || s === undefined || s === "" ? "?" : s) + "”";
    }

    /* THE ROW. "error", not "warn", for two reasons: the rail sorts errors first, and this is
     * not a thing to be aware of — everything else on screen is about the wrong sequence
     * until it is fixed.
     *
     * Kept to one sentence of consequence plus one of remedy. It costs real height at a 320px
     * dock, and each name appears once: after "Read A · B is open now", "a render" needs no
     * further pointing at. */
    function sayMismatch(open, weak) {
        var read = readSeqName();
        var what = state.cutFrom === "render"
            ? "A render would put " + qn(open) + "’s picture into " + qn(read)
              + "’s clips."
            : "Export would cut " + qn(read) + ", not " + qn(open) + ".";
        say("seq", "error", "Read " + qn(read) + " · " + qn(open) + " is open now. "
            + what + " Press Read again, or switch back."
            + (weak ? " (Name check only — no sequence id from Premiere.)" : ""));
    }

    /* @param when  "focus" | "idle" | "export". Logged, so a row that appeared can be traced
     *              to the check that found it, and it is what exempts the export check from
     *              the busy guard.
     * @param cb    called with true when it is safe to carry on, false on a mismatch. Only
     *              the export path passes one.
     */
    function checkSequence(when, cb) {
        // Nothing has been read, so there is no identity to compare against and no row.
        if (!state.info) { if (cb) cb(true); return; }
        /* NEVER MID-FLIGHT. An evalScript issued during a render or a scan queues behind
         * ExtendScript work that can run for minutes, and its answer would describe a moment
         * that has passed. The export check is exempt because it runs BEFORE anything starts
         * — that is the whole point of it. */
        if (when !== "export" && (state.busy || state.running)) return;
        cs.evalScript("activeSequenceStamp()", function (raw) {
            var r = null;
            try { r = JSON.parse(raw); } catch (e) {}
            if (!r || typeof r !== "object") {
                /* THE CHECK COULD NOT BE MADE. Said out loud, because a guard that has
                 * silently stopped working is worse than no guard. The realistic cause is a
                 * host.jsx older than this panel — reinstalling is the fix, and it is the
                 * same remedy folderSafe() already documents for that mismatch.
                 *
                 * It does NOT block the export. Refusing to cut at all because a panel is
                 * newer than the script beside it would strand him mid-job over a check,
                 * and the row plus the log say exactly what is missing. */
                say("seq", "warn", "Cannot tell which sequence is open. "
                    + "Reinstall the panel to restore this check.");
                log("sequence check (" + when + "): unreadable reply: " + raw);
                if (cb) cb(true);
                return;
            }
            if (r.none) {
                /* NO ACTIVE SEQUENCE AT ALL — deliberately neither a mismatch nor a row.
                 * It cannot produce wrong-data-that-looks-right, which is the only thing
                 * this guard is for: in source mode Premiere's state is irrelevant, the
                 * clips being cut from the camera files; and in render mode renderCuts()
                 * opens app.project.activeSequence itself and comes back with "No active
                 * sequence — open a timeline first", which is a loud failure that writes
                 * nothing. A row that appeared every time a timeline tab was closed is
                 * exactly the nagging that teaches him to ignore the rail. */
                say("seq", "error", "");
                log("sequence check (" + when + "): no active sequence");
                if (cb) cb(true);
                return;
            }
            if (!r.ok) {
                say("seq", "warn", "Cannot tell which sequence is open. "
                    + "Reinstall the panel to restore this check.");
                log("sequence check (" + when + "): " + (r.error || "unknown"));
                if (cb) cb(true);
                return;
            }
            var openId = String(r.id || ""), openName = String(r.name || "");
            var readId = readSeqId();
            /* The ID decides whenever both ends have one. Only when one of them does not
             * does this fall back to the name, and then it says so. */
            var weak = !readId || !openId;
            var same = weak ? (openName === readSeqName()) : (openId === readId);
            state.seqOpenName = openName;
            if (weak) {
                log("sequence check (" + when + "): NO SEQUENCE ID (read \"" + readId
                    + "\", open \"" + openId + "\") — comparing names, which cannot tell "
                    + "two sequences of the same name apart");
            }
            if (same) {
                // RESOLVED: he switched back, or this is simply the ordinary case. A stale
                // error row is worse than none — it teaches him to ignore the rail.
                say("seq", "error", "");
                if (cb) cb(true);
                return;
            }
            sayMismatch(openName, weak);
            log("sequence check (" + when + "): MISMATCH — read \"" + readSeqName()
                + "\" [" + readId + "], open \"" + openName + "\" [" + openId + "]");
            if (cb) cb(false);
        });
    }

    /* THE GATE, and nothing about it may be passable by accident.
     *
     * askConfirm() puts up an ExtendScript modal whose default is NO, so Return, Escape and
     * the close box all answer no; anything that is not exactly "yes" is read as no here, so
     * a thrown confirm() or an unreadable reply lands the same way. `proceed` is called on a
     * yes and on nothing else — the safe branch is the one that happens by default, by
     * accident, and by failure.
     *
     * ⚠️ askConfirm() BLOCKS PREMIERE'S MAIN THREAD while it is up, as every ExtendScript
     * modal does. That is why it is raised only here: as the direct consequence of a click
     * he made a moment ago, never from the focus check and never from the timer. */
    function confirmMismatch(proceed) {
        var read = readSeqName(), open = state.seqOpenName || "?";
        var msg;
        if (state.cutFrom === "render") {
            /* STRONGER IN RENDER MODE, because the consequence is different in kind rather
             * than in degree: the files themselves would be wrong, not just the list. */
            msg = "STOP — this is not the sequence you read.\n\n"
                + "You read:   " + read + "\n"
                + "Open now:   " + open + "\n\n"
                + "Timeline render renders WHATEVER SEQUENCE IS OPEN. Premiere will render "
                + open + ", and every clip will be written under " + read + "'s name, number "
                + "and timecode. The pictures inside them will be " + open + "'s, and nothing "
                + "in the files or in the report will say so.\n\n"
                + "Switch back to " + read + " in Premiere, or press Read on " + open + ".\n\n"
                + "Export anyway?";
        } else {
            msg = "This is not the sequence you read.\n\n"
                + "You read:   " + read + "\n"
                + "Open now:   " + open + "\n\n"
                + "The cut list, the frame ranges and the file names are all " + read
                + "'s. The clips are cut from " + read + "'s own media, so nothing from "
                + open + " will be inside them — but this export will not match the "
                + "timeline you are looking at.\n\n"
                + "Switch back to " + read + " in Premiere, or press Read on " + open + ".\n\n"
                + "Export " + read + " anyway?";
        }
        log("export held: read \"" + read + "\" but \"" + open + "\" is open — asking");
        cs.evalScript("askConfirm(" + jsStr(msg) + ")", function (raw) {
            var yes = String(raw === null || raw === undefined ? "" : raw).trim() === "yes";
            log("sequence mismatch: " + (yes ? "exported anyway" : "export cancelled"));
            if (yes) proceed();
        });
    }

    /* THE EXPORT, in one or two phases.
     *
     * Cutting from source is one phase: the engine reads the camera files. Cutting from a
     * timeline render is two: Premiere renders each cut first, with everything on it
     * baked in, and then the engine encodes those instead. The second phase is identical
     * either way — same naming, same manifest, same resume, same per-row retry — because
     * all that changes is which file ffmpeg opens.
     */
    function doExport() {
        /* THE AUTHORITATIVE CHECK, and the reason the rail row is not enough on its own: the
         * row can be up to SEQ_CHECK_MS old and he may never have looked at it. This one runs
         * at the moment the export is asked for, and nothing starts until it has answered. */
        checkSequence("export", function (safe) {
            if (safe) return startExport();
            confirmMismatch(startExport);
        });
    }

    /* ===================================================================== STOP MEANS STOP
     *
     * His report: "khi a phát hiện có vấn đề khi nó đang export, a bấm huỷ/dừng nhưng nó vẫn
     * export cho đến cùng" — he pressed cancel mid-export and it ran to the end.
     *
     * MEASURED, TWO CAUSES, ONE PER PHASE:
     *
     *   THE RENDER PHASE has no subprocess at all. It is ONE blocking evalScript across every
     *   range, with Premiere's main thread inside it, so state.proc is null the whole time —
     *   and the old handler was `if (state.proc) { proc.kill(); }`, i.e. it did NOTHING, in
     *   silence, with the button enabled. Press Cancel while Premiere is rendering and both
     *   phases run to completion. That is the report, exactly.
     *
     *   THE ENCODE PHASE is a subprocess, and killing it looks like it works. But the engine
     *   runs ffmpeg on a thread pool and installs no signal handler, so SIGTERM to python3
     *   orphans every ffmpeg it started and each finishes its clip. Killing the process GROUP
     *   is what actually stops it — see the `detached` note in spawnOpts().
     *
     * WHAT IS PROMISED, AND IT IS NOT THE SAME IN BOTH: the encode stops now. The render
     * finishes the range it is on and starts no other — a blocking host call cannot be
     * interrupted from here, and the button says so rather than offering a stop it cannot
     * deliver. Nothing is encoded from a stopped render.
     */

    /* Where the panel tells host.jsx to stop. renderCuts() reads this between ranges. */
    function renderStopFile() {
        var d = renderDir();
        return d ? path.join(d, "_render_stop") : "";
    }

    function writeRenderStop() {
        var f = renderStopFile();
        if (!f) return false;
        try {
            /* ⚠️ THE FOLDER MAY NOT EXIST YET. renderCuts() creates it, but Cancel can be
             * pressed in the seconds before Premiere gets that far — and writeFileSync into a
             * missing directory throws, which would make the button a no-op again in exactly
             * the window where someone who spotted the problem instantly would press it. */
            fs.mkdirSync(path.dirname(f), { recursive: true });
        } catch (e) { /* already there, or a runtime without recursive mkdir */ }
        try {
            // The content is never read — existence is the whole signal.
            fs.writeFileSync(f, "stop\n", "utf8");
            log("cancel: asked Premiere to stop after the current clip (" + f + ")");
            return true;
        } catch (e) {
            log("cancel: could not write the stop file: " + e);
            return false;
        }
    }

    function clearRenderStop() {
        var f = renderStopFile();
        if (!f) return;
        try { if (exists(f)) fs.unlinkSync(f); } catch (e) {}
    }

    /* SIGTERM the group, then SIGKILL whatever is left.
     *
     * ⚠️ THE NEGATIVE PID IS ONLY SAFE BECAUSE THE CHILD IS DETACHED. With spawnOpts()'s
     * `detached: true` python3 leads a group of its own; without it, -pid addresses the
     * PANEL's group and this would signal Premiere itself. Both calls are attempted and both
     * are wrapped, so a runtime with no process.kill still gets the plain proc.kill(). */
    function killTree(proc) {
        var pid = proc && proc.pid;
        var np = null;
        try { np = (node && node.process) ? node.process : null; } catch (e) {}
        if (!np) { try { np = process; } catch (e2) { np = null; } }
        try {
            if (np && pid) np.kill(-pid, "SIGTERM");
        } catch (e3) { log("cancel: group SIGTERM failed: " + e3); }
        try { proc.kill(); } catch (e4) {}
        /* AND A SECOND SHOT. python3 can be inside a blocking wait and ffmpeg can be mid
         * write; SIGTERM asks and SIGKILL insists. Only if the thing has not gone on its own
         * — state.proc is nulled by the close handler, so this compares identity rather than
         * killing whatever happens to be running by then. */
        setTimeout(function () {
            if (state.proc !== proc) return;
            log("cancel: still alive after SIGTERM — SIGKILL");
            try { if (np && pid) np.kill(-pid, "SIGKILL"); } catch (e5) {}
            try { proc.kill("SIGKILL"); } catch (e6) {}
        }, 1500);
    }

    function cancelRun() {
        if (!state.running && !state.proc) return;
        state.cancelled = true;
        if (state.proc) {
            log("cancel: killing the encode (pid " + state.proc.pid + ") and its group");
            killTree(state.proc);
            el.progtext.textContent = "Stopping…";
        } else {
            // No subprocess, so this is the render phase.
            writeRenderStop();
            el.progtext.textContent = "Stopping after this clip…";
        }
        // One call, after both branches. It used to sit in the render branch only, so the
        // button went on offering a stop it had already delivered for the whole encode.
        cancelLabel();
    }

    /* THE BUTTON MUST NOT LIE. In the encode phase it stops the run; in the render phase the
     * most it can do is stop the next clip from starting, so that is what it offers. One
     * short label, no explanatory sentence beside it — this is the whole control. */
    function cancelLabel() {
        if (!el.cancel) return;
        /* Between runs, back to rest. Without this the button would still read "Stopping…"
         * and be disabled when the NEXT run's progress row appeared. */
        if (!state.running && !state.proc) {
            el.cancel.disabled = false;
            el.cancel.textContent = "Cancel";
            return;
        }
        if (state.cancelled) {
            el.cancel.textContent = "Stopping…";
            el.cancel.disabled = true;
            return;
        }
        el.cancel.disabled = false;
        el.cancel.textContent = state.proc ? "Cancel" : "Stop after this clip";
    }

    function startExport() {
        /* THE REPLACE QUESTION. Asked only when the destination already holds something this
         * run could overwrite — a re-export, or the partial set a cancelled run left behind,
         * which is exactly the case he asked about.
         *
         * HOW IT COMPOSES with what is already here, because there are now three ways to
         * answer the same question and they must not contradict each other:
         *
         *   the `skip clips already there` tick IS the standing answer. Ticked, he has
         *   already said "skip", so asking again would be asking a question he has answered
         *   — no prompt, and --resume goes on the command line as it always did.
         *
         *   a RETRY is a deliberate request to rewrite the clips that failed. Replacing is
         *   the entire point of it, so it is never asked either.
         *
         *   otherwise: Replace overwrites (no --resume, which is today's behaviour), Skip
         *   passes --resume for this one run without touching his tick, and Cancel — the
         *   default, and what a dismissed dialog gives — writes nothing.
         */
        var already = (!state.resume && !state.retryKeys.length) ? clashCount() : 0;
        if (!already) return beginExport();
        askReplace(already, beginExport);
    }

    /* HOW MANY CLIPS ARE ALREADY IN THE DESTINATION.
     *
     * ⚠️ NOT countIn(). The engine writes its own bookkeeping into the very same folder —
     * manifest.json, clips.csv, the _renders scratch — so counting everything would raise the
     * Replace question after every export ever run into that folder, including one that
     * produced no clip at all. Measured: the first export leaves manifest.json behind, and
     * the second was then asked about "1 file(s)" that were never his. Only media counts,
     * because only media is what he stands to lose. */
    function clashCount() {
        var dir = outDir();
        if (!dir) return 0;
        var skip = { "manifest.json": 1, "clips.csv": 1, "pick.txt": 1,
                     "_renders": 1, "_render_progress.json": 1, "_render_stop": 1 };
        var n = 0;
        try {
            var names = fs.readdirSync(dir);
            for (var i = 0; i < names.length; i++) {
                var nm = String(names[i]);
                if (nm.charAt(0) === "." || skip[nm]) continue;
                n++;
            }
        } catch (e) { return 0; }
        return n;
    }

    function askReplace(already, proceed) {
        var dest = outDir();
        var msg = seqFolder() + "/" + outKind() + "/ already holds " + already
            + " file(s).\n\n" + dest + "\n\n"
            + "Replace — overwrite the names this export reproduces.\n"
            + "Skip — keep what is there and write only what is missing.\n"
            + "Cancel — write nothing.";
        log("clash: " + already + " file(s) already in " + dest + " — asking");
        cs.evalScript("askChoice(" + jsStr("Files are already there") + ", " + jsStr(msg)
            + ", " + jsStr("Replace") + ", " + jsStr("Skip") + ")", function (raw) {
            var a = String(raw === null || raw === undefined ? "" : raw).trim();
            if (a === "a") {
                log("clash: replacing");
                proceed();
                return;
            }
            if (a === "b") {
                log("clash: skipping what is already there");
                state.resumeOnce = true;
                proceed();
                return;
            }
            /* ⚠️ THE DEFAULT BRANCH, and it is the one that writes nothing. Cancel, Escape,
             * the close box, a ScriptUI that threw and an unreadable reply all land here. */
            log("clash: export cancelled");
        });
    }

    function beginExport() {
        state.cancelled = false;
        clearRenderStop();
        if (state.cutFrom !== "render") return runEngineExport(null);
        renderThenExport();
    }

    function stopRenderPoll() {
        if (state.renderTimer) {
            clearInterval(state.renderTimer);
            state.renderTimer = null;
        }
    }

    /* exportAsMediaDirect blocks until it finishes, so one evalScript across sixty cuts
     * would say nothing at all for minutes. Premiere writes its position to a file after
     * every render and this reads it off disk while that call is still running. */
    function pollRenderProgress(dir, total) {
        var f = path.join(dir, "_render_progress.json");
        stopRenderPoll();
        state.renderTimer = setInterval(function () {
            var o = null;
            try { o = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return; }
            if (!o || !o.total) return;
            state.renderProg = o;
            var pct = Math.max(0, Math.min(100, (o.done / o.total) * 100));
            el.barfill.style.width = pct.toFixed(1) + "%";
            el.progtext.textContent = "Rendering " + Math.min(o.done + 1, o.total)
                + " of " + o.total
                + (o.current ? " · " + o.current : "")
                + (o.failed ? " · " + o.failed + " failed" : "");
        }, 400);
        el.progtext.textContent = "Asking Premiere to render " + total + " cut(s)…";
    }

    function renderThenExport() {
        var spec = renderSpec();
        if (!spec.length) {
            fail("Nothing to render: no ticked video clips on V"
                + (state.vtrackWant || "?") + ".\nPick a different track under "
                + "\u201cShots from\u201d, or tick some clips.");
            return;
        }
        var dir = renderDir();
        clearError();
        showReport(false);
        show(el.prog, true);
        setRunning(true);
        setBusy(true, "Rendering…");
        // There is no subprocess in this phase, so the button says what it can actually do.
        cancelLabel();
        el.barfill.style.width = "0";
        log("render: " + spec.length + " cut(s) -> " + dir);
        pollRenderProgress(dir, spec.length);

        cs.evalScript("renderCuts(" + jsStr(dir) + ", " + jsStr(spec.join(";"))
            + ", " + renderMbps() + ", 1, " + jsStr(includeList().join(",")) + ")",
            function (raw) {
                stopRenderPoll();
                var i, t, r = hostReply(raw);
                if (!r) {
                    log("render: unreadable reply: " + raw);
                    show(el.prog, false);
                    setRunning(false);
                    setBusy(false);
                    fail("Premiere did not return a readable reply from the render."
                        + "\nThe raw text is in the log, under the gear.");
                    return;
                }
                for (i = 0; i < (r.tried || []).length; i++) log("render: " + r.tried[i]);
                for (i = 0; i < (r.renders || []).length; i++) {
                    for (t = 0; t < (r.renders[i].tried || []).length; t++) {
                        log("render: " + r.renders[i].label + ": " + r.renders[i].tried[t]);
                    }
                }
                if (!r.ok) {
                    show(el.prog, false);
                    setRunning(false);
                    setBusy(false);
                    fail((r.error || "Premiere rendered none of the cuts.")
                        + "\nEvery attempt it made is in the log, under the gear.");
                    return;
                }
                log("render: " + r.written + " written, " + (r.failed || 0)
                    + " failed, in " + r.folder);

                /* ⚠️ A STOPPED RENDER IS NOT HANDED TO THE ENCODE. `stopped` is renderCuts()
                 * honouring the stop file between ranges; state.cancelled covers the case
                 * where the click landed after the last range, when there was no boundary
                 * left to notice it. Encoding a partial render because he pressed Cancel at
                 * the wrong moment is the same class of surprise as not stopping at all.
                 *
                 * The renders are KEPT rather than swept, so a re-export with Skip finishes
                 * the job instead of asking Premiere to render it all again. */
                if (r.stopped || state.cancelled) {
                    stopRenderPoll();
                    show(el.prog, false);
                    setRunning(false);
                    setBusy(false);
                    cancelLabel();
                    say("renders", "warn", "Stopped after " + r.written + " of "
                        + spec.length + " clip(s). Nothing was cut. The finished renders are "
                        + "kept — export again and choose Skip to carry on from here.");
                    log("render: STOPPED at range " + (r.stopped_at === undefined
                        ? "?" : r.stopped_at) + " — the encode was not started");
                    return;
                }

                /* Carried into the run's own notes rather than shown and lost: the report
                 * is what he reads afterwards, and both of these change what it means. */
                var notes = [];
                for (i = 0; i < (r.warnings || []).length; i++) {
                    notes.push("⚠ " + r.warnings[i]);
                    log("render: " + r.warnings[i]);
                }
                if (r.bitrate) {
                    log("render: " + r.bitrate.target + " Mbps target / "
                        + r.bitrate.max + " max, pass mode " + r.bitrate.pass);
                }
                /* The one number that makes two runs comparable, and it goes in the NOTES
                 * rather than only the log — rendering was measured at about two thirds of
                 * a second a cut at two passes, and this is what says whether one pass
                 * moved it. The pass mode is named beside it, because a run that fell back
                 * has a different number for a reason. */
                if (r.tracks_hidden) {
                    log("render: hid " + r.tracks_hidden + " other video track(s)");
                }
                if (r.written && r.total_ms) {
                    var rsecs = r.total_ms / 1000;
                    notes.push("Premiere rendered " + r.written + " cut(s) in "
                        + rsecs.toFixed(1) + "s — "
                        + (rsecs / r.written).toFixed(2) + "s each, at "
                        + (r.one_pass_used ? "one pass" : "two passes"));
                }
                if (r.failed) {
                    notes.push("⚠ Premiere did not render " + r.failed + " cut(s) — those "
                        + "are marked 'no render' below and were NOT cut from their source "
                        + "instead");
                }
                if (!r.restored) {
                    notes.push("⚠ your sequence's in/out points could not be put back — "
                        + "check the timeline");
                }
                runEngineExport(dir, notes, spec.length);
            });
    }

    function runEngineExport(renderDirPath, notes, renderCount) {
        clearError();
        // Reset so the report shows THIS run's notes. The scan already ran the same merge,
        // so keeping its lines would print every one of them twice.
        state.merge = [];
        // …except anything the render phase found, which belongs to this run and has just
        // been thrown away by the line above.
        if (notes && notes.length) state.merge = notes.slice();
        // The sequence's own folder inside the chosen root. xmlcut mkdir -p's whatever it
        // is given, so there is nothing to create here.
        var args = argsFor(outDir(), false);
        if (renderDirPath) {
            args.push("--render-dir", renderDirPath);
            // Which track defined the shots. The engine drops every other video track and
            // every audio cut, so this and renderSpec() must agree or the run would ask
            // for renders it never made.
            if (state.vtrackWant) args.push("--video-track", String(state.vtrackWant));
        }
        /* His standing choice on the tick, OR the one-run answer to the Replace question.
         * resumeOnce is consumed here so answering "Skip" once cannot narrow the next run. */
        if (state.resume || state.resumeOnce) args.push("--resume");
        state.resumeOnce = false;
        // Only when something is actually unticked; otherwise the flag is noise.
        var retry = state.retryKeys.slice();
        state.retryKeys = [];          // consumed here, so it cannot narrow the next run
        var pickPath = writePickFile(workDir(), retry);
        if (pickPath) {
            args.push("--pick", pickPath);
            log("selection: " + (retry.length || pickedClips().length)
                + " clip(s) via " + pickPath + (retry.length ? " (retry)" : ""));
        }

        // Remember the manifest's mtime BEFORE starting. Cancelling used to leave the
        // previous run's manifest in place, which then rendered as though it described
        // the run that was just abandoned.
        state.manifestBefore = manifestMtime();
        // Belongs to THIS run. A leftover count would keep the render scratch for ever.
        state.rendersMissing = 0;
        say("renders", "info", "");
        // And the last run's reasons are not this run's.
        say("failures", "error", "");

        /* ⚠️ The list STAYS. This used to hide #opts and #step3 and show a progress
         * section in their place — see renderRun() for what that cost. */
        showReport(false);
        show(el.prog, true);
        setRunning(true);
        el.barfill.style.width = "0";
        el.progtext.textContent = "Starting…";
        // In render mode the run is limited to one video track, so the ticked total —
        // which counts every track — would leave the bar short of the end.
        jobsReset(retry.length || renderCount || selectedCount(), retry);
        setBusy(true, "Exporting…");

        log("$ " + state.python + " " + args.join(" "));

        var proc;
        try {
            proc = spawn(state.python, args, spawnOpts());
        } catch (e) {
            show(el.prog, false);
            setRunning(false);
            setBusy(false);
            fail("Could not start python3:\n" + e);
            return;
        }
        state.proc = proc;
        // A real subprocess now exists, so Cancel can promise a real stop again.
        cancelLabel();

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
            /* "  >> video/1/1234/1290 name.mp4" — a clip has STARTED encoding.
             *
             * The key is optional in the pattern on purpose: an engine older than this
             * panel emits the name alone, and then the tally and the log still work while
             * the row simply does not light up. Silently showing nothing is the right
             * failure for a version mismatch; throwing away the line is not.
             *
             * The fourth field — the out-point — is optional for the same reason in the
             * same direction: an engine from before it existed sends three, and
             * keyFromEngine() resolves those against the clip list. */
            var ms = line.match(/^\s*>>\s+(?:([a-z]+\/\d+\/\d+(?:\/\d+)?)\s+)?(.+)$/);
            if (ms) {
                jobStart(ms[2], ms[1] || "");
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
            setRunning(false);
            setBusy(false);
            fail("python3 could not run:\n" + e);
        });

        proc.on("close", function (code) {
            state.proc = null;
            if (tail) onLine(tail);
            jobsStop();
            setBusy(false);
            setRunning(false);
            show(el.prog, false);
            /* ⚠️ SAY THAT IT WAS STOPPED. A killed run exits non-zero with a partial manifest,
             * and the report built from it reads exactly like a run that failed halfway — so
             * without this the panel answers "stop" with what looks like a fault. The row also
             * names the way forward, because the folder now holds an incomplete set and the
             * next export has to be told what to do about it. */
            if (state.cancelled) {
                say("renders", "warn", "Stopped. The clips already written are in the folder; "
                    + "export again and choose Skip to finish the rest.");
                log("run stopped by Cancel (exit " + code + ")");
            }
            cancelLabel();

            if (stderr) log("stderr: " + stderr);

            // A non-zero exit still leaves a manifest behind when some clips were
            // written, so the report is built either way — a partial run is exactly
            // when knowing which clips made it matters most.
            var built = buildReport();
            if (built) {
                /* Revealed BEFORE it is rendered, because renderReport() ends by deciding
                 * which row of the action bar belongs on screen and that decision reads
                 * #report's own visibility. Rendering first left the bar offering an export
                 * and reporting a finished run at the same time — two next actions. */
                showReport(true);
                renderReport();
                renderMerge();          // this run's '++' and '!!' lines
            }

            /* AFTER the report, because whether to keep the renders depends on what the
             * report says failed — and never before, because the encode reads them. */
            if (renderDirPath) cleanRenders(renderDirPath, built, code);

            if (code === 0) {
                if (!built) fail("The run finished but wrote no manifest to report on.");
            } else if (code === null) {
                log("cancelled");
            } else {
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
        /* ⚠️ DO NOT EMPTY THE LIST TO RE-READ IT.
         *
         * This used to clear state.clips and hide the table on every scan, including a
         * Re-measure, which does not change WHICH clips exist — only what they cost. Two
         * things went wrong at once, and both are worse the wider the panel is:
         *
         *   the clip column went BLANK for as long as the scan took, which for a probing
         *   scan over Google Drive is not brief. Undocked wide, the two-column layout put
         *   that hole beside a full export column and read as a broken panel.
         *
         *   everything derived from the list went STALE without saying so: the button
         *   still offered "Export 19 clips" and the estimate still priced 19 clips, out of
         *   a state.clips of length zero. Numbers describing a list that had been emptied.
         *
         * So a re-read keeps the list it already has until the new one arrives. The rows
         * were never thrown away — they stayed in the DOM behind `hidden` the whole time.
         * Per-clip ticks live in state.unpicked, keyed by clip, so they survive a replaced
         * list and the table can stay live rather than being frozen. */
        var rescan = state.clips.length > 0;
        if (!rescan) {
            state.clips = [];
            show(el.tablewrap, false);
        }
        el.tablewrap.className = rescan ? "tablewrap rescanning" : "tablewrap";
        say("scan", "info", rescan
            ? "Re-reading the cut list… the list below is the last one read."
            : "Reading the cut list…");
        if (!rescan) el.listnote.textContent = "";

        var scanDir = path.join(workDir(), "scan");
        var args = argsFor(scanDir, /* allTypes */ true);
        args.push("--manifest-only");
        /* ⚠️ NOT --render-dir. No render exists at scan time, and handing the engine a
         * folder of nothing would mark every clip as having none. This says only that one
         * is COMING, so the cut list is reported as it will be — which is what makes an
         * .aep and an offline clip tickable instead of greyed out. */
        if (state.cutFrom === "render") args.push("--render-planned");
        log("$ " + state.python + " " + args.join(" "));

        var proc;
        try {
            proc = spawn(state.python, args, spawnOpts());
        } catch (e) {
            endRescan();
            setBusy(false);
            readStage(-1);
            fail("Could not read the cut list:\n" + e
                 + (rescan ? "\nThe list shown is the one read before." : ""));
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
            endRescan();
            setBusy(false);
            fail("Could not read the cut list:\n" + e
                 + (rescan ? "\nThe list shown is the one read before." : ""));
        });
        proc.on("close", function (code) {
            endRescan();
            if (errbuf) log("stderr: " + errbuf);
            if (code !== 0) {
                setBusy(false);
                readStage(-1);
                fail("Reading the cut list failed (exit " + code + ")."
                     + (errbuf ? "\n" + errbuf.split("\n").slice(-4).join("\n") : "")
                     + (rescan
                        ? "\nThe list shown is the one read before; you can still export."
                        : "\nYou can still export; the list just isn't shown."));
                return;
            }
            if (loadClips(scanDir)) {
                typesFromClips();
                renderTypes();
                // The Audio dropdown is built from what the scan just reported, so it is filled
                // here — where the data arrives — rather than only on the next settings repaint.
                renderAudioTracks();
                renderVideoTracks();
                renderClips();
                show(el.tablewrap, true);
                show(el.opts, true);
                show(el.step3, true);
            }
            renderMerge();
            readStage(READ_STEPS.length,
                      state.clips.length + " cut(s) read · "
                      + (state.xml ? "XML + Premiere" : "Premiere only"));
            // The card was drawn before the scan had a count, so it is written again now that
            // there is one. Cheap, and it keeps the count in one place.
            if (state.info) renderSequence();
            setBusy(false);
        });
    }

    /* Both halves of "the scan is over", together. They were separate lines at four
     * exits, which is four chances to hide the hint and leave the table dimmed. */
    function endRescan() {
        say("scan", "info", "");
        el.tablewrap.className = "tablewrap";
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
        /* The settings the scan's probe actually ran at, taken from the manifest rather
         * than assumed to be the current ones. A scan is asynchronous: the sliders can
         * have moved between spawning it and reading its result, and recording what is on
         * screen now would claim a measurement that was never taken. */
        var pset = data.settings || {};
        state.probeCrf = (pset.crf === null || pset.crf === undefined)
            ? state.crfVal : Number(pset.crf);
        state.probeScale = Number(pset.scale_percent || 100);
        // Manifests written before the engine recorded this are x264 by definition — it was
        // the only encoder there was.
        state.probeVcodec = String(pset.vcodec || "libx264");
        // What the timeline actually has to offer. The scan reports it whether or not audio was
        // asked for, so the dropdown is right before anything is exported.
        state.audioTracks = (pset.audio_tracks_available || []).map(function (t) {
            return { index: Number(t.index || 0), items: Number(t.items || 0) };
        }).filter(function (t) { return t.index > 0; });
        /* WHOSE NUMBERS THESE ARE. "premiere" means the engine numbered the tracks the way
         * Premiere does; absent means an older engine, whose numbers are the old per-channel
         * ones. The panel gates its migration notice on this so it cannot tell someone their
         * numbers changed on the evidence of a manifest written before they did. */
        state.audioNumbering = String(pset.audio_track_numbering || "");
        /* THE SEQUENCE'S OWN FRAME SIZE, off the FCP7 XML's <samplecharacteristics>.
         *
         * This is what a row with NO SOURCE FILE can be priced from. A nest cut as one clip,
         * an adjustment layer, a title, an offline clip — every input the size model wants
         * (width, height, fps, bitrate) comes from probing a source file, and there is no
         * file to probe, so those rows showed nothing at all. In render mode the output IS
         * the sequence, so the sequence's own pixels are the right basis.
         *
         * Backward compatible by construction: a manifest from an older engine has no
         * sequence_width, these stay 0, and the branch in clipBytes() never fires. */
        state.seqW = Number(pset.sequence_width || 0);
        state.seqH = Number(pset.sequence_height || 0);
        sayAudioRenumbered();
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
            /* ⚠️ A ROW THAT CAN BE CUT MUST NOT BE PAINTED AS A FAILURE.
             *
             * The engine's describe() sets kind "bad" whenever a cut has no source file, and
             * in render mode that cut is perfectly cuttable — Premiere is what supplies the
             * picture. So a nest, a title and an adjustment layer arrived TICKABLE AND RED at
             * once, which is how the reviewer found them ("những file báo màu đỏ"). Red has to
             * mean "this will not work"; k-warn is the class for "look at this".
             *
             * ⚠️ DEMOTED HERE RATHER THAN IN THE ENGINE, because the panel is the only side
             * that knows the mode. The identical manifest row IS a failure in source mode,
             * where there is no file to cut from — so a kind changed engine-side would paint
             * a genuinely broken row amber. estimate_basis "sequence" is the engine saying
             * "this cut has no source", which is exactly the population. */
            if (kind === "bad" && cuttable && state.cutFrom === "render"
                && String(c.estimate_basis || "") === "sequence") {
                kind = "warn";
            }
            var spd = Number(c.speed_percent || 100);

            state.clips.push({
                // What --pick matches on: (track type, track index, timeline in-point in
                // frames). Stable against filtering and re-indexing, and unique — two
                // clips cannot start on the same frame of the same track.
                trackType: String(c.track_type || "video"),
                trackIndex: Number(c.track_index || 1),
                timelineIn: Number(c.timeline_in_frames || 0),
                // The other end of the same range. Carried for the render probe, which
                // asks Premiere for a timeline range rather than a source range.
                timelineOut: Number(c.timeline_out_frames || 0),
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
                // For the live size estimate — no encoding needed, the scan already
                // probed the source.
                secs: Number(c.source_duration_seconds || 0),
                srcBitrate: Number(c.bitrate || 0),
                /* WHAT THE ENGINE'S OWN SIZE FIGURE RESTS ON: measured · source · sequence ·
                 * ceiling · unknown. The panel does not use the engine's estimated_bytes —
                 * it recomputes, so the number keeps following the crf and scale controls
                 * instead of freezing at scan time — but it does use this to know WHICH kind
                 * of row it is looking at. "sequence" is the one with no source file. */
                estBasis: String(c.estimate_basis || ""),
                cutId: String(c.cut_id || ""),
                // MEASURED bits per second, from the engine encoding a second or so of
                // this very clip at these very settings. The only trustworthy basis for
                // the size column — see size_probe() in xmlcut.py for the 180x that the
                // source-bitrate model was out by.
                probeBps: Number(c.probe_bps || 0),
                // For the metadata model: what it costs per pixel depends on the source's
                // codec class and its own bits per pixel, not on its bitrate alone.
                w: Number(c.width || 0),
                h: Number(c.height || 0),
                srcFps: Number(c.source_fps || 0),
                codec: String(c.codec || "").toLowerCase(),
                // media_kind, not display_kind — `kind` above is the row's colour, and
                // pricing a video as a still because they shared a field name was exactly
                // the bug this separates.
                still: String(c.media_kind || "") === "still",
                // The source's own pixels, so the resolution slider can say what it will
                // actually produce rather than only a percentage. A timeline mixes
                // 1080x1920 and 2160x3840, and "50%" means two different files.
                w: Number(c.width || 0),
                h: Number(c.height || 0),
                status: status,
                notes: notes,
                kind: kind,
                source: src
            });
        }
        return true;
    }

    /* WHAT IDENTIFIES A CLIP, everywhere in this panel: the ticks, the row states, the
     * pick file, the retry scope and the key the engine announces all use this string.
     *
     * ⚠️ THE OUT-POINT IS PART OF IT. It used to be type + track + in-point, on the
     * assumption that two clips cannot start on the same frame of one track. A
     * cross-dissolve breaks that — the outgoing clip's overlap sits on exactly the frame
     * the incoming clip starts — and a real client timeline had a 10-frame "K8 (before)"
     * and an 88-frame "K8 (after)" both at frame 448 of V1. Sharing a key, they shared a
     * tick (unticking one dropped both from the export), shared a row state (one row told
     * both stories while the other stayed dark), and shared a line in the pick file, so a
     * retry of one failed clip re-encoded two. */
    /* AND NOW THE ENGINE'S OWN ID WHEN THERE IS ONE.
     *
     * cut_id is a 12-hex content digest — clip name, track, timeline range, source path,
     * source in and duration, speed, reverse, and the nest it came out of. It is the only
     * thing that can separate TWO DIFFERENT PICTURES occupying the same frames of one track,
     * which the four fields cannot: that is the residual collision the out-point fix did not
     * reach. It is also computed at parse time, so unlike a timeline range it is immune to
     * the cross-dissolve split and to --whole-frames, both of which move ranges afterwards.
     *
     * ⚠️ THE FALLBACK IS NOT OPTIONAL. A manifest from an older engine carries no cut_id, and
     * the four fields are still correct there. Every other key-producing path in this panel
     * has to agree with this function about which of the two it is using — see keyFromEngine()
     * and the manifest key in buildReport(), both of which prefer the id for the same reason.
     * Landing this alone, with those two still spelling four fields, would point the live
     * progress states and the whole report at keys no row holds. */
    function clipKey(c) {
        if (c.cutId) return c.cutId;
        return c.trackType + " " + c.trackIndex + " " + c.timelineIn + " " + c.timelineOut;
    }

    /* A clip is cut when its type is on, it can be cut at all, and it has not been
     * individually unticked. Type filtering and per-clip ticking are separate on
     * purpose: switching a type back on should not resurrect a clip you deliberately
     * dropped. */
    /* IS THIS CLIP'S TYPE TICKED?
     *
     * ⚠️ ALWAYS YES IN RENDER MODE, and this is the ONE place that answer is given — so the
     * clip list, the count on the button, the pick file, the size estimate and the argv
     * cannot disagree about it. There is nothing to gate there: the picture comes out of
     * Premiere, not out of the source file, so anything sitting on the master track is a
     * shot — a still, an adjustment layer, a title with no <file> path at all. */
    function typeOn(c) {
        if (state.cutFrom === "render") return true;
        return state.types[c.ext] ? state.types[c.ext].on : true;
    }

    function isPicked(c) {
        return !state.unpicked[clipKey(c)];
    }

    /* IS THIS CLIP IN THE RUN AT ALL?
     *
     * In timeline mode it is one video track and nothing else — the engine drops every
     * other track and every audio cut, so a list showing them was describing a different
     * export from the one about to happen. Ticks on those rows did nothing, their sizes
     * were added into an estimate that would never include them, and the count above the
     * button was wrong.
     *
     * In source mode nothing is excluded and this is always true. */
    function inRun(c) {
        if (state.cutFrom !== "render") return true;
        if (c.trackType !== "video") return false;
        var want = Number(state.vtrackWant || 0);
        return !want || Number(c.trackIndex) === want;
    }

    function pickedClips() {
        var out = [];
        for (var i = 0; i < state.clips.length; i++) {
            var c = state.clips[i];
            if (c.group === 0 && typeOn(c) && isPicked(c) && inRun(c)) out.push(c);
        }
        return out;
    }

    /* Write the selection for --pick. A file rather than argv, because a long timeline is
     * hundreds of clips. Returns the path, or "" when everything is selected and the flag
     * is not needed. */
    function writePickFile(dir, onlyKeys) {
        var all = [], chosen;
        if (onlyKeys && onlyKeys.length) {
            /* A RETRY. Not the ticked set — the clips that failed, whatever is ticked now.
             * Re-ticking the list to express this would destroy a selection he made, and
             * reading it back afterwards would be guesswork. */
            chosen = [];
            for (var q = 0; q < state.clips.length; q++) {
                var cc = state.clips[q];
                if (cc.group === 0 && onlyKeys.indexOf(clipKey(cc)) >= 0) chosen.push(cc);
            }
        } else {
            chosen = pickedClips();
        }
        for (var i = 0; i < state.clips.length; i++) {
            var c = state.clips[i];
            if (c.group === 0 && typeOn(c)) all.push(c);
        }
        if (chosen.length === all.length) return "";
        var lines = ["# written by the xmlcut panel — one clip per line",
                     "# TRACKTYPE TRACKINDEX TIMELINEIN TIMELINEOUT"];
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
    /* WHICH GROUP A ROW BELONGS TO. Ranked by what needs attention, not by what is
     * pleasant to report — the two failures on a 23-cut timeline were at rows 6 and 20,
     * which is a poor place to keep the only things you have to act on.
     *
     * Before a run there are two groups: everything is Ready, and whatever cannot be cut
     * is at the bottom. That is the old divider, generalised. */
    var GROUPS = [
        { key: "bad",   rank: 0, title: "Problems",       cls: "g-bad" },
        { key: "run",   rank: 1, title: "Encoding now",   cls: "g-run" },
        { key: "ready", rank: 2, title: "Ready",          cls: "" },
        { key: "ok",    rank: 3, title: "Written",        cls: "g-ok" },
        { key: "kept",  rank: 4, title: "Already there",  cls: "g-kept" },
        { key: "dead",  rank: 5, title: "Cannot be cut — fix these or untick their type",
          cls: "g-dead" }
    ];
    function groupOf(rail, rst, isDead) {
        if (isDead) return "dead";
        if (rail === "bad") return "bad";
        if (rail === "run") return "run";
        if (rst === "kept") return "kept";
        // `over` is written, and says so on its own row. A clip is not a different KIND of
        // outcome for being larger than a threshold somebody typed.
        if (rst === "ok" || rail === "over") return "ok";
        return "ready";
    }
    function groupDef(key) {
        for (var i = 0; i < GROUPS.length; i++) if (GROUPS[i].key === key) return GROUPS[i];
        return GROUPS[2];
    }

    function renderClips() {
        var body = el.clipbody;
        body.innerHTML = "";
        // Read once for the whole table rather than per row.
        var qs = settings(), lim = capBytes();
        /* "only problems" filters THIS table now, rather than a separate report list. It
         * only bites once a run has produced something to have an opinion about. */
        var onlyProb = !!(el.onlyprob && el.onlyprob.checked && state.report.length);
        var visible = [];
        for (var i = 0; i < state.clips.length; i++) {
            var r = state.clips[i];
            /* ⚠️ THROUGH typeOn(), NOT A SECOND COPY OF IT. This line held its own inline
             * `state.types[r.ext] ? ... : true`, which is how the list came to disagree with
             * everything computed from typeOn() — in render mode the chips filtered the rows
             * on screen while the argv, the count and the pick file had stopped caring. One
             * definition, one answer. */
            if (typeOn(r) && inRun(r)) visible.push(r);
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
        /* Each row's group is worked out ONCE, here, and the list is sorted by it —
         * stably, so timeline order survives inside every group. */
        var qsLim = lim;
        for (var g = 0; g < visible.length; g++) {
            var gv = visible[g];
            var grs = state.rowState[clipKey(gv)] || null;
            var grst = grs ? String(grs.st || "") : "";
            var gEb = clipBytes(gv, qs);
            var gAct = (grs && grs.done && grs.bytes > 0) ? grs.bytes : 0;
            var gOver = (qsLim > 0 && (gAct || gEb) > qsLim && isPicked(gv)
                         && gv.group === 0 && grst !== "bad");
            var gRail = grst === "bad" ? "bad" : grst === "run" ? "run"
                : gOver && grst ? "over" : grst === "kept" ? "kept"
                : grst === "ok" ? "ok" : "";
            gv._grp = groupOf(gRail, grst, gv.group !== 0);
            gv._rank = groupDef(gv._grp).rank;
        }
        visible = visible.slice().sort(function (a, b) { return a._rank - b._rank; });

        // How many rows each group will actually SHOW, counted before any are built so a
        // heading can carry its own total. Rows the filter removes are not counted.
        var counts = {};
        for (var cq = 0; cq < visible.length; cq++) {
            var cv = visible[cq];
            var crs = state.rowState[clipKey(cv)] || null;
            var crst = crs ? String(crs.st || "") : "";
            if (onlyProb && cv._grp !== "bad" && cv._grp !== "dead"
                && !(crst && cv._grp === "ok" && capBytes() > 0
                     && ((crs.bytes || clipBytes(cv, qs)) > capBytes()))) continue;
            counts[cv._grp] = (counts[cv._grp] || 0) + 1;
        }

        var headed = {};
        for (var j = 0; j < visible.length; j++) {
            var v = visible[j];
            var tr = document.createElement("tr");
            var picked = isPicked(v);
            // Sized at the CURRENT settings, so both the number and the flag move with
            // the sliders. Computed before the row class, which needs to know.
            var eb = clipBytes(v, qs);
            /* WHAT THIS ROW IS DOING, if a run has touched it. The same cell that held the
             * estimate holds the finished size once the file exists — the estimate is not
             * kept beside it, because two numbers in one column is how you end up reading
             * the wrong one. The end-of-run comparison lives once, in the action bar. */
            var rs = state.rowState[clipKey(v)] || null;
            var rst = rs ? String(rs.st || "") : "";
            var actual = (rs && rs.done && rs.bytes > 0) ? rs.bytes : 0;
            var shown = actual || eb;
            // The flag is re-applied to whichever number is on screen, so typing a new
            // threshold re-marks a finished run as readily as a planned one.
            var over = (lim > 0 && shown > lim && picked && v.group === 0
                        && rst !== "bad");
            /* One rail per row, and the precedence is what needs attention rather than what
             * is nicest to report: failed, then running, then bigger than you asked for,
             * then left alone, then written. A clip can be both written and over the flag;
             * amber wins, because the flag is the half worth seeing. */
            var rail = rst === "bad" ? "bad"
                : rst === "run" ? "run"
                : over && rst ? "over"
                : rst === "kept" ? "kept"
                : rst === "ok" ? "ok" : "";
            /* Filtered AFTER numbering, never before: the numbers are the filenames the
             * run produced, so hiding a row must not renumber the ones that remain. */
            if (onlyProb && rst !== "bad" && !over && v.group === 0) continue;
            /* ⚠️ AFTER the filter, never before: a heading built for a group whose every
             * row is then filtered away is a heading over nothing. Class keeps "divider"
             * in it so everything that already skips dividers still does. */
            if (!headed[v._grp]) {
                headed[v._grp] = true;
                var gd = groupDef(v._grp);
                var hr = document.createElement("tr");
                hr.className = "divider grouphead " + gd.cls;
                var hc = document.createElement("td");
                hc.setAttribute("colspan", "5");
                var ht = document.createElement("span");
                ht.className = "ghtitle";
                ht.textContent = gd.title;
                var hn = document.createElement("b");
                hn.textContent = String(counts[v._grp] || 0);
                hc.appendChild(ht);
                hc.appendChild(hn);
                hr.appendChild(hc);
                body.appendChild(hr);
            }
            tr.className = "k-" + v.kind + (picked ? "" : " unpicked")
                + (over ? " over" : "") + (rail ? " st-" + rail : "");

            // The tick lives in its own cell, built here rather than through the generic
            // cell loop because it holds a control rather than text.
            (function (clip, row) {
                var td = document.createElement("td");
                td.className = "pick";
                var box = document.createElement("input");
                box.type = "checkbox";
                box.checked = picked;
                // Nothing to include if it cannot cut, and nothing to change once the
                // run has the selection on its command line.
                box.disabled = (clip.group !== 0) || state.running;
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
                        // In full, because the cell above shows only what fits in 76px.
                        v.status && v.status !== shortStatus(v.status) ? v.status : "",
                        v.timing ? "timing from " + v.timing : "",
                        // WHY THIS ROW FAILED, in full. The cell has room for a word.
                        (rs && rs.why) ? rs.why : "",
                        v.notes, v.source,
                        over ? "over the " + state.cap + " MB flag" : ""
                       ].filter(function (s) { return !!s; }).join(" · ");
            /* The size cell, in whichever of its three lives applies. A mark as well as a
             * colour every time, because the row tint alone would be the only thing saying
             * it to anyone who cannot rely on colour. */
            var sizeText = rst === "run" ? "encoding"
                : rst === "bad" ? "✕ —"
                : actual ? ((over ? "▲ " : "✓ ") + humanBytes(actual))
                : rst === "kept" ? "–"
                /* Written, but not yet measured: the completion line says a file landed and
                 * says nothing about its size, so the estimate stays and the tilde says it
                 * is still an estimate. A tick beside a bare number here would present a
                 * guess as a measurement for the length of the run. */
                : rst === "ok" ? (eb > 0 ? "✓ ~" + humanBytes(eb) : "✓")
                : (eb > 0 ? (over ? "▲ " : "") + humanBytes(eb) : "—");
            /* The last column says the one thing worth saying at this moment: how long a
             * running clip has been going, what a finished one took or why it did not
             * write, and otherwise the status — except the plain "ready", which was the
             * same word repeated down all nineteen rows and told nobody anything. */
            /* ⚠️ "ready — from render" WAS THE SAME NINETEEN CHARACTERS ON EVERY ROW, and
             * truncated on all of them because the column is 84px. That is exactly why
             * plain "ready" is blanked here already: a word repeated down every row tells
             * nobody anything. Where the pixels come from is a property of the RUN, not of
             * each clip, and the strip's footer says it once. */
            var lastText = rst === "run" ? secs(nowMs() - (rs.t0 || nowMs()))
                : (rs && rs.done)
                    ? (rs.note || ((rs.t1 && rs.t0) ? secs(rs.t1 - rs.t0) : ""))
                    : (v.group === 0 && /^ready/i.test(v.status)
                        ? "" : shortStatus(v.status));
            var cells = [
                [v.n ? pad2(v.n) : "—", "idx num"], [v.clip, "clipname"],
                [sizeText, "siz num" + (over ? " over" : "")
                 + (rst === "run" ? " running" : "") + (actual ? " actual" : "")],
                [lastText, "sts" + (rst === "bad" ? " why" : "")]
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
        renderSizeEstimate();
    }

    /* WHAT FITS IN THE STATUS COLUMN, which is 76px at a 320px dock.
     *
     * These cells are white-space: nowrap, so anything too long is CLIPPED — the row never gets
     * taller and nothing announces it. The engine phrases a status as "<what> — <what to do>"
     * ("graphic — needs a render", "AE comp — render it", "ready — from render"), and the half
     * after the dash is the half that does not fit. It is not lost: the row's tooltip carries
     * the status in full, along with the path, the timing source and the failure reason.
     *
     * A rule, not a lookup table. A table of the engine's exact strings would drift the first
     * time the engine rephrased one, and drift silently, which is how this column came to be
     * clipping on every row of a real timeline in the first place. */
    function shortStatus(text) {
        var s = String(text || "");
        var i = s.indexOf(" — ");
        return i > 0 ? s.substring(0, i) : s;
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
            var txt = item ? raw.substring(2) : raw;
            /* A BLANK NOTE IS NOT A NOTE. It used to be counted and then rendered as an
             * empty div — a number over nothing, the same lie from the other direction. */
            if (!txt.replace(/^\s+|\s+$/g, "")) continue;
            if (!item) heads++;
            var d = document.createElement("div");
            d.className = "mergeline" + (item ? " item" : "");
            d.textContent = txt;
            el.mergebox.appendChild(d);
        }
        /* ⚠️ THE COUNT COMES FROM WHAT WAS ACTUALLY APPENDED, so "3 merge notes" over an
         * empty box is a state this function can no longer produce — which is the whole
         * point, because it produced exactly that and it was reported twice.
         *
         * `heads || shown` covers the other end of it: a run whose every line is a "· "
         * detail has no headings, and announcing "0 merge notes" above a box full of lines
         * would be the same defect mirrored. */
        var shown = el.mergebox.children.length;
        if (!shown) {
            show(el.mergedet, false);
            return;
        }
        // The one writer of both, so the body can never be hidden under a visible summary.
        show(el.mergebox, true);
        var n = heads || shown;
        el.mergesum.textContent = n === 1 ? "1 merge note" : (n + " merge notes");
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
        el.enginestat.className = "msg" + (cls ? " " + cls : "");
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
     * a script somewhere else is the user's own checkout, and not ours to overwrite. */
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
            setEngineStat("error", "xmlcut.py is there but did not run — " + lastLine(e));
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
     * `auto` is true when this ran by itself on open. The download was asked to happen
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
            setEngineStat("error", "xmlcut.py is missing and this panel cannot work out "
                          + "where it is installed, so it cannot repair itself. Press Find.");
            return;
        }
        if (!https) {
            setEngineStat("error", "xmlcut.py is missing and this panel has no network "
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
                stop("error", "could not reach the release channel (" + err
                     + "). Press Find and point at xmlcut.py, or re-run the installer.");
                return;
            }
            var want = "";
            try { want = String(JSON.parse(text).version || ""); } catch (e) {}
            if (!want) {
                stop("error", "the release channel did not name a version.");
                return;
            }
            setEngineStat("busy", "Downloading xmlcut.py " + want + "…");
            fetchRel(UPDATE_DIR + "/xmlcut.py", function (body, err2) {
                if (!body) {
                    stop("error", "the download failed (" + err2 + ").");
                    return;
                }
                var bad = engineComplaint(body, want);
                if (bad) {
                    // Nothing is written. A rejected download leaves the panel exactly as
                    // it was: missing an engine and saying so.
                    stop("error", "refused the download — " + bad + ". Nothing was written.");
                    return;
                }
                var lib = dir + "/lib";
                var target = lib + "/xmlcut.py";
                try {
                    fs.mkdirSync(lib, { recursive: true });
                    fs.writeFileSync(target, body, "utf8");
                } catch (e3) {
                    stop("error", "could not write " + target + " (" + e3 + ").");
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

    /* ------------------------------------------------- export settings */

    /* The defaults here are the MEASURED ones — crf 1 because crf 0 emits a profile no Mac
     * can play, veryfast because the preset never moves a frame boundary. Everything in
     * this section is a deliberate move away from them, so each control states its cost
     * rather than leaving it to be discovered in the output. */
    function settings() {
        return {
            crf: state.crfVal,
            fps: el.fps.value ? parseFloat(el.fps.value) : null,
            scale: state.scale,
            vcodec: el.vcodec.value || "libx264",
            // "" = no audio files · "all" = every audio track · "2" = that track alone
            audio: String(el.audiosel.value || ""),
            wholeFrames: !!el.wholeframes.checked,
            // Not in settingArgs(): --render-dir is added by the EXPORT only. The scan
            // runs before any render exists, and handing it a folder of nothing would
            // report every clip as having no render.
            cutFrom: state.cutFrom,
            vtrack: state.cutFrom === "render" ? Number(state.vtrackWant || 0) : 0
        };
    }

    /* The engine's own flags, so the panel cannot describe one export and run another. */
    function settingArgs() {
        var s = settings(), a = [];
        if (s.crf && s.crf !== 1) a.push("--crf", String(s.crf));
        if (s.fps) a.push("--fps", String(s.fps));
        if (s.scale && s.scale < 100) a.push("--scale", String(s.scale));
        // Only when it differs from the engine's own default, so an ordinary export's
        // command line stays as short as what it actually asks for.
        if (s.vcodec && s.vcodec !== "libx264") a.push("--vcodec", s.vcodec);
        /* The voice-over, and which tracks it reads. One control, two flags: --audio is the
         * switch and --audio-tracks narrows it, so "every track" needs no second argument and
         * the ordinary case stays a short command line. */
        // Only the frames wholly inside each cut's source range.
        if (s.wholeFrames) a.push("--whole-frames");
        if (s.audio) {
            a.push("--audio");
            if (s.audio !== "all") a.push("--audio-tracks", s.audio);
        }
        return a;
    }

    /* Output bitrate relative to the source's, per crf. The same measured table the engine
     * carries — it cannot be imported into JavaScript, so it is duplicated deliberately and
     * noted in both places. Panel-side only for the live preview; the number that goes in
     * the manifest is always the engine's. */
    var CRF_SIZE_RATIO = [[1, 2.77], [14, 1.26], [18, 0.94], [23, 0.62], [28, 0.37]];

    function sizeRatio(crf) {
        if (crf <= CRF_SIZE_RATIO[0][0]) return CRF_SIZE_RATIO[0][1];
        var last = CRF_SIZE_RATIO[CRF_SIZE_RATIO.length - 1];
        if (crf >= last[0]) return last[1];
        for (var i = 0; i < CRF_SIZE_RATIO.length - 1; i++) {
            var a = CRF_SIZE_RATIO[i], b = CRF_SIZE_RATIO[i + 1];
            if (crf >= a[0] && crf <= b[0]) {
                return a[1] + (crf - a[0]) / (b[0] - a[0]) * (b[1] - a[1]);
            }
        }
        return last[1];
    }

    function humanBytes(n) {
        var u = ["B", "KB", "MB", "GB"], i = 0;
        while (n >= 1024 && i < 3) { n /= 1024; i++; }
        return (i < 2 ? Math.round(n) : n.toFixed(1)) + " " + u[i];
    }

    /* Live estimate from the SCAN's manifest — seconds and source bitrates are already
     * there, so this needs no encoding and updates as the settings change. Measured
     * against real encodes of the fixture, it lands within ~6% (13.0 vs 12.3 MB) on
     * footage the ratio table fits, and is worded as an estimate everywhere. */
    /* Bytes for ONE clip at the current settings. Everything that shows a size goes
     * through here: the per-row column, the total beside the slider, and the report. Three
     * copies of this arithmetic would be three chances for the table and the total to
     * disagree in front of someone deciding whether to press Export. */
    /* Bytes for ONE clip. MEASURED where possible.
     *
     * The measured path needs no arithmetic beyond multiplying by the clip's length: the
     * engine already encoded a second of this clip at these settings, resolution filter
     * included, so the resolution and the crf are inside the number. Applying the crf table
     * or the area factor on top would be counting them twice.
     *
     * The modelled path below is the fallback for --no-size-probe, for a clip whose probe
     * timed out, and for an older engine that does not send probe_bps. It scales the
     * SOURCE's bitrate, which is unreliable by up to 180x on intraframe footage; it is kept
     * only so that something is shown, and staleSizes() tells the reader which they have. */
    /* THE SIZE MODEL, mirrored from xmlcut.py — metadata only, so it costs nothing and
     * follows the sliders live. Duplicated deliberately: it cannot be imported into a CEP
     * panel, and both copies carry the same note. Calibrated by measuring real encodes at
     * six crf values; see estimate_bps() and CLAUDE.md.
     *
     * Unit is OUTPUT bits per pixel per frame, which is the thing that clusters. Codec class
     * separates it — an already-compressed source re-encodes larger, because the second pass
     * has to reproduce the first one's artefacts as well as the picture. */
    var INTRAFRAME = { prores: 1, dnxhd: 1, dnxhr: 1, mjpeg: 1, cineform: 1, v210: 1,
                       v410: 1, rawvideo: 1, ffv1: 1, huffyuv: 1, dvvideo: 1, hqx: 1,
                       cfhd: 1, prores_ks: 1 };
    var BPP_INTER = [[6, 0.759], [14, 0.290], [18, 0.144], [23, 0.066], [28, 0.032]];
    var BPP_INTRA = [[6, 0.261], [14, 0.069], [18, 0.030], [23, 0.013], [28, 0.006]];
    var SRC_SHARE = [[6, 2.806], [14, 1.074], [18, 0.598], [23, 0.288], [28, 0.144]];
    /* Every table above is x264's. This is what x265 costs as a multiple of it at the SAME
     * CRF NUMBER — which is the knob on screen, and not the question the "HEVC is half the
     * size" charts answer: those hold quality equal, not crf.
     *
     * Measured on 19 real clips, both encoders, same slices, paired per clip so content
     * cancels. At crf 6 there is NO SAVING (1.01x, and it can come out larger); the saving
     * peaks around crf 18 and shrinks again as crf climbs. Mirrors CODEC_BPP_RATIO in the
     * engine — the two are diffed by tests/check_panel.js, because a panel promising one
     * size while the engine plans another is the failure this whole model exists to avoid. */
    var CODEC_RATIO = {
        libx265: [[6, 1.01], [14, 0.72], [18, 0.70], [23, 0.78], [28, 0.82]]
    };
    // A still is not a rate — almost all of its file is the one keyframe, so it is priced
    // as this many frames' worth of picture whatever its length.
    var STILL_FRAMES = 1.5;
    var CONTAINER_FIXED = 512;   // measured: 458-byte intercept, and it does NOT scale

    function lerp(tbl, x) {
        if (x <= tbl[0][0]) return tbl[0][1];
        var last = tbl[tbl.length - 1];
        if (x >= last[0]) return last[1];
        for (var i = 0; i < tbl.length - 1; i++) {
            var a = tbl[i], b = tbl[i + 1];
            if (x >= a[0] && x <= b[0]) {
                return a[1] + (x - a[0]) / (b[0] - a[0]) * (b[1] - a[1]);
            }
        }
        return last[1];
    }

    function clipBytes(c, s) {
        if (!c || !(c.secs > 0)) return 0;
        // MEASURED, if Re-measure was pressed. Nothing to compute — the probe ran at these
        // settings with the resolution filter applied, so the number is already right.
        if (c.probeBps > 0) return c.probeBps * c.secs / 8 + CONTAINER_FIXED;

        var crf = s.crf || 1, pct = s.scale || 100;
        var d = scaledDims(c.w, c.h, pct);
        var intra = !!INTRAFRAME[c.codec];
        // 1.0 for x264 (the tables ARE x264) and for any encoder with no measured ratio,
        // which shows the figure there is evidence for rather than an invented discount.
        var ratio = CODEC_RATIO[s.vcodec] ? lerp(CODEC_RATIO[s.vcodec], crf) : 1;
        if (d && c.still) {
            // A still: one picture, not a per-second rate. Checked FIRST, so a video that
            // happens to be missing its frame rate cannot fall through into this branch —
            // which it did, and priced a 2-second clip as a single frame.
            // No codec ratio here, and that is MEASURED rather than forgotten: a real
            // jpeg encoded both ways came out the same size to within a percent. x265's
            // win is prediction BETWEEN frames, and a still has none to do.
            return lerp(BPP_INTER, crf) * d[0] * d[1] * STILL_FRAMES / 8 + CONTAINER_FIXED;
        }
        if (d && c.srcFps > 0) {
            var px = d[0] * d[1] * c.srcFps;
            var bpp = lerp(intra ? BPP_INTRA : BPP_INTER, crf) * ratio;
            if (!intra && c.srcBitrate > 0) {
                // The source's own bits per pixel, as a CEILING — a genuinely low-bitrate
                // source really does encode small. Computed at the SOURCE's dimensions,
                // because a downscale removes pixels, not detail per pixel.
                var sbpp = c.srcBitrate / (c.w * c.h * c.srcFps);
                bpp = Math.min(bpp, sbpp * lerp(SRC_SHARE, crf) * ratio);
            }
            return bpp * px * c.secs / 8 + CONTAINER_FIXED;
        }
        /* NO SOURCE TO READ — a nest cut as one clip, an adjustment layer, a title, an
         * offline clip. Eight rows on a real render-mode timeline showed no size at all,
         * and the reviewer read the blanks as a fault.
         *
         * In render mode the output is the SEQUENCE, so it is priced from the sequence's
         * frame size with the same model and the same controls: same bits-per-pixel curve,
         * same codec ratio, same scale. Computed here rather than read from the engine's
         * estimated_bytes on purpose — a stored figure would freeze at scan time and stop
         * following the crf and scale sliders, which is the one property that makes these
         * numbers worth showing.
         *
         * ⚠️ RENDER MODE ONLY. In source mode these rows cannot be cut at all, so a number
         * would describe a file that is never going to exist. */
        if (!d && state.cutFrom === "render" && state.seqW > 0 && state.seqH > 0) {
            var sd = scaledDims(state.seqW, state.seqH, pct);
            // The sequence's real rate, which the read already reported. Only if it did:
            // inventing one would put a number on screen with nothing behind it.
            var sfps = state.info ? Number(state.info.fps || 0) : 0;
            if (sd && sfps > 0) {
                return lerp(BPP_INTER, crf) * ratio * sd[0] * sd[1] * sfps
                     * c.secs / 8 + CONTAINER_FIXED;
            }
        }
        if (!(c.srcBitrate > 0)) return 0;
        // No dimensions at all — the last resort, and the unreliable one.
        return c.srcBitrate * sizeRatio(crf) * ratio * Math.pow(pct / 100, 2) * c.secs / 8;
    }

    /* Are the measured sizes still describing the settings on screen?
     *
     * A probe belongs to the crf and the scale it ran at. Moving either makes every size
     * on screen the answer to a question nobody is asking any more — and the estimate must
     * say so rather than quietly scaling the number, because scaling it is exactly the
     * 10x-wrong extrapolation this whole change exists to remove.
     */
    function measured() {
        for (var i = 0; i < state.clips.length; i++) {
            if (state.clips[i].probeBps > 0) return true;
        }
        return false;
    }

    /* Only the MEASURED sizes can go stale. The model follows the sliders by construction,
     * so with no probe there is nothing to be out of date — which is the whole reason the
     * model is the default: live, free, and never lying about which settings it describes. */
    function staleSizes() {
        return measured() && (state.crfVal !== state.probeCrf
                              || state.scale !== state.probeScale
                              // ⚠️ The encoder counts. Switching to x265 changes the size
                              // of every clip by up to 30%, and without this the measured
                              // numbers sat there describing an x264 export that is no
                              // longer the one about to run — with no re-measure offered.
                              || settings().vcodec !== state.probeVcodec);
    }

    /* The dimensions this scale will actually produce, computed the SAME way the engine's
     * scaled_dims() and ffmpeg's own filter compute them — truncated to even, because
     * H.264 4:2:0 cannot encode an odd dimension. Three copies of this rounding would be
     * three chances for the panel to promise a size the file does not have. */
    function scaledDims(w, h, pct) {
        if (!w || !h) return null;
        var f = pct / 100;
        return [Math.max(2, Math.floor(w * f / 2) * 2),
                Math.max(2, Math.floor(h * f / 2) * 2)];
    }

    /* "50% · 540×960", or "50% · mixed sources" when the timeline holds more than one
     * resolution — naming one of them would be wrong for every clip of the other. */
    /* THE AUDIO DROPDOWN, built from the timeline that was read.
     *
     * A fixed list would be a lie on two counts: it would offer tracks that are not there, and
     * it would miss a third one when a project has it. The engine reports every audio track it
     * found and how many items sit on each, so this offers exactly those and says plainly when
     * there is nothing to offer.
     *
     * ⚠️ THE REMEMBERED CHOICE IS RE-CHECKED against each timeline. "A2" on one project is the
     * voice-over and on the next it does not exist — keeping the number would silently export
     * silence. When the remembered track is missing, this falls back to every track rather than
     * to off, because "he asked for audio" is the durable half of the preference and "which
     * track" is the part that belongs to a project. */
    /* ══════════════════════════ THE AUDIO CHOICE, AND WHY IT MOVED KEY
     *
     * The engine now numbers audio tracks the way PREMIERE numbers them, not the way the XML's
     * per-channel lanes happened to fall out. So a saved "5" from before that change points at
     * different material — and the panel's old fallback for a number the timeline does not have
     * was `if (!known) want = "all"`, silently, with nothing said. Between them: an editor with
     * a saved A5–A7 gets a full mix of everything instead of the one track they picked, and an
     * editor with a saved A3 gets a different track. Both look like a working export.
     *
     * ⚠️ DISCARDED, NEVER REMAPPED. Old number → new number is only computable from the
     * manifest OF THE SAME TIMELINE, which the panel does not have when it restores a
     * preference at boot. Any mapping invented here would be a guess presented as a memory,
     * which is the failure mode being fixed.
     *
     * "" and "all" carry over untouched, because neither is a track number and neither can
     * mean something different under a new numbering. Only a NUMBER is thrown away, and only
     * then does the panel say anything. */
    var AUDIO_KEY = "xmlcut.audio.v2";
    var AUDIO_KEY_OLD = "xmlcut.audio";

    function loadAudioWant() {
        var now = null, old = null;
        try { now = window.localStorage.getItem(AUDIO_KEY); } catch (e) {}
        try { old = window.localStorage.getItem(AUDIO_KEY_OLD); } catch (e) {}
        // Gone either way: a key left behind is a key that gets read again by mistake.
        if (old !== null) {
            try { window.localStorage.removeItem(AUDIO_KEY_OLD); } catch (e) {}
        }
        if (now !== null) {
            state.audioWant = String(now);
            return;
        }
        if (old === null) { state.audioWant = ""; return; }
        old = String(old);
        if (old === "" || old === "all") {
            // Not a number, so the renumbering cannot have changed what it means.
            state.audioWant = old;
            return;
        }
        /* A saved NUMBER. Thrown away, and remembered only so the panel can say it did — and
         * only once the engine confirms it is the one that renumbered (see audioNumbering). */
        state.audioDropped = old;
        state.audioWant = "all";
        rememberAudioWant();
    }

    function rememberAudioWant() {
        try { window.localStorage.setItem(AUDIO_KEY, state.audioWant); } catch (e) {}
    }

    /* Said ONCE, and only when the engine that read this timeline is the one whose numbers
     * changed. A manifest with no audio_track_numbering came from an older engine, whose
     * numbers are the OLD ones — telling someone their numbers now match Premiere on the
     * strength of that manifest would be false. */
    function sayAudioRenumbered() {
        if (!state.audioDropped || state.audioNumbering !== "premiere") return;
        say("audionum", "warn", "Audio track numbers now match Premiere's own, which the "
            + "earlier numbering did not. Your saved choice of A" + state.audioDropped
            + " could have meant a different track under the new numbers, so it was cleared "
            + "and every audio track is selected. Pick the track you want again.");
        // Once. It is news about a migration, not a standing state.
        state.audioDropped = "";
    }

    function renderAudioTracks() {
        var have = state.audioTracks || [];
        var sel = el.audiosel;
        sel.innerHTML = "";
        function opt(value, label) {
            var o = document.createElement("option");
            o.setAttribute("value", value);
            o.value = value;
            o.textContent = label;
            sel.appendChild(o);
            return o;
        }
        opt("", "No audio files");
        if (!have.length) {
            // Nothing to choose from, and the reason said out loud rather than an empty menu.
            opt("none", state.clips.length
                ? "— this timeline has no audio tracks —"
                : "— read a timeline first —");
            sel.value = "";
            sel.disabled = true;
            /* ⚠️ state.audioWant is NOT cleared here. This branch runs before anything has been
             * read, and clearing it would throw away the choice he made last session — the menu
             * has nothing to show yet, which is not the same as him having chosen nothing. */
            return;
        }
        sel.disabled = false;
        opt("all", have.length === 1
            ? "The audio track"
            : "All " + have.length + " audio tracks");
        for (var i = 0; i < have.length; i++) {
            var t = have[i];
            opt(String(t.index), "A" + t.index + " only · " + t.items
                + (t.items === 1 ? " item" : " items"));
        }
        var want = state.audioWant || "";
        if (want && want !== "all") {
            var known = false;
            for (var k = 0; k < have.length; k++) {
                if (String(have[k].index) === want) known = true;
            }
            if (!known) want = "all";
        }
        sel.value = want;
        state.audioWant = want;
    }

    /* ------------------------------------------------------- cutting from a render
     *
     * A render is the finished picture at that instant, so ONE video track supplies the
     * shot list and everything above it is in the pixels rather than in the list. Built
     * from the timeline that was read, like the audio menu and for the same reason: V2
     * on one project is not V2 on the next, and offering a track with nothing on it
     * would be offering an empty export.
     */
    function videoTracksPresent() {
        var seen = {}, out = [], i, c;
        for (i = 0; i < state.clips.length; i++) {
            c = state.clips[i];
            if (c.trackType !== "video") continue;
            /* ⚠️ ONLY THE CLIPS THAT WOULD ACTUALLY BE CUT. This counted every video
             * clipitem, so the menu offered "V1 · 11 clips" beside a list reading "10 of 10
             * cuttable" — one number describing the timeline, the other describing the
             * export, two lines apart, with nothing saying which was which. If a count and
             * the list can disagree, one of them is wrong. */
            if (c.group !== 0) continue;
            if (!seen[c.trackIndex]) { seen[c.trackIndex] = 0; }
            seen[c.trackIndex]++;
        }
        for (var k in seen) {
            if (Object.prototype.hasOwnProperty.call(seen, k)) {
                out.push({ index: Number(k), items: seen[k] });
            }
        }
        out.sort(function (a, b) { return a.index - b.index; });
        return out;
    }

    function renderVideoTracks() {
        // The include ticks are built from the same list and must follow the master, so
        // they are rebuilt here rather than at a second call site that could drift.
        var rebuildInclude = true;
        var sel = el.vtrack;
        if (!sel) return;
        var have = videoTracksPresent();
        sel.innerHTML = "";
        function opt(value, label) {
            var o = document.createElement("option");
            o.value = value;
            o.textContent = label;
            sel.appendChild(o);
        }
        if (!have.length) {
            opt("", state.clips.length ? "— no video clips —" : "— read a timeline first —");
            sel.disabled = true;
            /* ⚠️ state.vtrackWant is NOT cleared. Nothing has been read yet, which is not
             * the same as him having chosen nothing — same trap as the audio menu. */
            return;
        }
        sel.disabled = false;
        for (var i = 0; i < have.length; i++) {
            opt(String(have[i].index), "V" + have[i].index + " · " + have[i].items
                + (have[i].items === 1 ? " clip" : " clips"));
        }
        // Default to the LOWEST track, which is where the main footage sits on a normal
        // timeline. His call, 19 Aug: "Pick the track, default V1".
        var want = state.vtrackWant || "";
        var known = false;
        for (var k = 0; k < have.length; k++) {
            if (String(have[k].index) === want) known = true;
        }
        if (!known) want = String(have[0].index);
        sel.value = want;
        state.vtrackWant = want;
        if (rebuildInclude) renderIncludeTracks();
    }

    /* An intermediate has to be BETTER than the thing encoded from it.
     *
     * The final encode is crf — it targets a quality, not a rate — so if the render spends
     * the bits the final would, the final faithfully reproduces the render's own
     * artefacts and the export is two generations of the same loss. At twice the rate the
     * render's artefacts sit below what the crf is looking for, and only the second
     * encode decides how the clip looks. Hence 2, and hence it being written down. */
    var RENDER_HEADROOM = 2;

    /* What the quality slider asks for, in megabits, at the SEQUENCE's own size.
     *
     * Premiere's exporter has no crf, so this is the translation — the same measured
     * bits-per-pixel table the size estimate uses, applied to the sequence's pixels
     * rather than to any one clip's. 0 means the sequence's size is not known yet, and
     * the caller falls back to the stock preset rather than inventing a figure.
     *
     * ⚠️ This is why the stock preset was not enough: "Match Source - High bitrate" is a
     * fixed 10 Mbps whatever the sequence is, which is about right for 1080x1920 and well
     * under crf 18 on anything 4K. */
    function renderMbps() {
        var info = state.info || {};
        var w = Number(info.frame_width || 0);
        var h = Number(info.frame_height || 0);
        var fps = Number(info.fps || 0);
        if (!(w > 0 && h > 0 && fps > 0)) return 0;
        var bits = lerp(BPP_INTER, state.crfVal || 1) * w * h * fps * RENDER_HEADROOM;
        // Floored so a very low quality setting cannot produce an intermediate that is
        // itself the problem; capped so a near-lossless one cannot ask for a rate no
        // sensible disk wants. Both are limits on the RENDER, never on the export.
        return Math.max(4, Math.min(150, bits / 1e6));
    }

    /* The list only holds what the run will cut, so it has to say so — a list that
     * suddenly shows a third of the clips otherwise reads as a fault. */
    function renderListLabel() {
        if (!el.listlbl) return;
        var txt = (state.cutFrom === "render" && state.vtrackWant)
            ? ("Every cut on V" + state.vtrackWant + ", in timeline order")
            : "Every cut, in timeline order";
        /* The tip marker is a child ELEMENT, so only the leading text node may be replaced.
         *
         * ⚠️ nodeType, NOT tagName. This read `first.tagName === "#text"`, and a real text node
         * has no tagName at all — the test was always false, so every call PREPENDED another
         * copy of the label instead of replacing it. Measured in a real browser: eight calls,
         * nine copies of "Every cut, in timeline order" stacked above the list. The DOM shim in
         * tests/panel_dom.js gave its text nodes `tagName: "#text"`, which made the broken test
         * true there and is exactly why no test could see this. nodeType 3 is what a text node
         * actually is, in the browser and now in the shim. */
        var first = el.listlbl.firstChild;
        if (first && first.nodeType === 3) first.textContent = txt + " ";
        else el.listlbl.insertBefore(document.createTextNode(txt + " "), first || null);
    }

    /* Which tracks are in the picture. Built from the timeline, and the MASTER is always
     * in and cannot be unticked — a render without the track the cuts come from is a
     * folder of black files. */
    function includeSet() {
        var out = {}, parts = String(state.vIncludeWant || "").split(",");
        for (var i = 0; i < parts.length; i++) {
            var v = parseInt(parts[i], 10);
            if (v > 0) out[v] = true;
        }
        var m = Number(state.vtrackWant || 0);
        if (m) out[m] = true;
        return out;
    }
    function includeList() {
        var set = includeSet(), out = [];
        for (var k in set) {
            if (Object.prototype.hasOwnProperty.call(set, k) && set[k]) out.push(Number(k));
        }
        out.sort(function (a, b) { return a - b; });
        return out;
    }
    function rememberInclude() {
        state.vIncludeWant = includeList().join(",");
        try {
            window.localStorage.setItem("xmlcut.vinclude", state.vIncludeWant);
        } catch (e) {}
    }

    function renderIncludeTracks() {
        var box = el.vinclude;
        if (!box) return;
        var have = videoTracksPresent();
        box.innerHTML = "";
        if (!have.length) {
            var none = document.createElement("span");
            none.className = "vinnone";
            none.textContent = state.clips.length ? "no video tracks" : "read a timeline first";
            box.appendChild(none);
            return;
        }
        /* Default: everything the timeline has. Overlays are the exception, not the rule,
         * and a default that silently dropped a track would be a default that changed the
         * picture without being asked. */
        if (!state.vIncludeWant) {
            var all = [];
            for (var d = 0; d < have.length; d++) all.push(have[d].index);
            state.vIncludeWant = all.join(",");
        }
        var set = includeSet();
        var master = Number(state.vtrackWant || 0);
        for (var i = 0; i < have.length; i++) {
            (function (t) {
                var lab = document.createElement("label");
                lab.className = "vintick" + (t.index === master ? " vinmaster" : "");
                var box2 = document.createElement("input");
                box2.type = "checkbox";
                box2.checked = !!set[t.index];
                // The master is in by definition, so its tick is on and cannot be moved.
                box2.disabled = (t.index === master) || state.running;
                box2.addEventListener("change", function () {
                    var cur = includeSet();
                    if (box2.checked) cur[t.index] = true;
                    else delete cur[t.index];
                    var keep = [];
                    for (var k in cur) {
                        if (Object.prototype.hasOwnProperty.call(cur, k) && cur[k]) {
                            keep.push(Number(k));
                        }
                    }
                    keep.sort(function (a, b) { return a - b; });
                    state.vIncludeWant = keep.join(",");
                    rememberInclude();
                    renderIncludeTracks();
                });
                lab.appendChild(box2);
                var txt = document.createElement("span");
                txt.textContent = "V" + t.index
                    + (t.index === master ? " · master" : "");
                lab.appendChild(txt);
                box.appendChild(lab);
            })(have[i]);
        }
        rememberInclude();
    }

    /* Source media or a timeline render. The track field only exists in render mode. */
    function applyCutFrom() {
        var render = state.cutFrom === "render";
        if (el.cutfrom) el.cutfrom.value = state.cutFrom;
        show(el.vtrackfield, render);
        /* whole-frames only means anything OUT of render mode. It stays on screen either
         * way — dimmed and disabled rather than removed, because a control that vanishes
         * is a control you go looking for. */
        if (el.wholeframes) el.wholeframes.disabled = render;
        if (el.wfwrap) el.wfwrap.className = "tick" + (render ? " inert" : "");
        show(el.wfwhy, render);
        /* THE FILE-TYPE CHIPS GO ENTIRELY IN RENDER MODE — hidden, not dimmed, and the
         * departure from the `whole frames only` convention two lines up is deliberate.
         *
         * That convention is for a control whose STATE still means something in the mode you
         * are in: one checkbox, one line, and four words beside it saying why it is asleep.
         * The chips are not that. They are a variable-length row of three to eight
         * interactive labels, each carrying a COUNT, which wraps to two or three lines at a
         * 320px dock. Dimming them would leave twenty-odd nodes and eight numbers on screen
         * doing nothing AND add a reason phrase to explain them — cutting the knobs while
         * adding the text, which is exactly how the last "calmer" pass came out busier.
         *
         * The counts are also the specific thing a QA pass found misleading here: they summed
         * every cut on every track (37 + 10 + 8 + 1 = 56) beside a list holding the master
         * track's 10. A dimmed number is still read. Removing the artefact beats annotating
         * it, and it leaves nothing that can disagree with the list.
         *
         * And it is not a control he could go looking for and fail to find: the mode is a
         * deliberate choice in a dropdown, and putting it back brings the whole block back
         * visibly in the same gesture. */
        show(el.typelbl, !render);
        show(el.types, !render);
        renderStripFoot();
    }

    /* Every consequence of the current settings, in one place at the foot of the strip.
     * These were four separate labels living inside four different fields, which is most
     * of why the strip read as busy. */
    function renderStripFoot() {
        if (state.cutFrom !== "render") {
            say("rendermode", "info", "");
            return;
        }
        var mb = renderMbps();
        /* NOTHING UNTIL THE NUMBER EXISTS. The bitrate is frame size x fps x quality, so none
         * of it is knowable before a read — and "read a timeline to see the render bitrate" is
         * an instruction to do the one thing the panel is already asking for, taking a rail row
         * to do it. The caveat below goes with it: there are no sizes to qualify yet either. */
        if (!mb) {
            say("rendermode", "info", "");
            return;
        }
        var out = [];
        // Plain text, no <b>. The bold was the only inline emphasis left in the panel and it
        // was carrying a number that is already the only number in the sentence.
        out.push("Premiere renders each cut at ~"
                 + (mb < 10 ? mb.toFixed(1) : Math.round(mb))
                 + " Mbps, then ffmpeg encodes it at your quality.");
        // Said because it is not obvious and it is wrong for a retimed clip: the scan runs
        // before any render exists, so the estimate can only come from the source.
        /* Both bases, in one sentence. It said only "from the source clips", which became
         * half true the moment rows with no source started being priced from the sequence's
         * frame size instead — and a blank was what sent the reviewer looking in the first
         * place, so which basis a number has is worth the eight extra words. */
        out.push("Sizes are estimated from the source clips, or from the sequence's frame "
                 + "size where a clip has no source — a nest, a title, an adjustment layer.");
        say("rendermode", "info", out.join(" "));
    }

    /* Where Premiere writes the rendered ranges: <sequence>/edited/_renders, composed out of
     * outDir() so it follows the raw/edited split for free.
     *
     * Beside the clips rather than in a temp folder: these are large — Match Source High on a
     * 4K sequence is tens of MB a cut — and /tmp is on the system volume, which is not the
     * volume he chose to have room on.
     *
     * ⚠️ DELETED AFTER A CLEAN RUN, kept after a dirty one. This comment used to say the
     * opposite — "kept after the run, not deleted" — and the reason it gave is still true and
     * is why the deletion is conditional: the engine CUTS FROM these files, so "Retry the N
     * that failed" re-encodes the failed rows out of _renders without asking Premiere to
     * render anything again. Throw them away while something still needs retrying and the
     * retry becomes a full re-render.
     *
     * What deleting on a clean run buys: these are Premiere intermediates carrying a full
     * stereo mix of the whole sequence, while the delivered clips are silent by design. Left
     * behind, they read as a second folder of the same clips WITH sound — which is exactly how
     * they were reported ("two folders, one with sound one without"). See cleanRenders(). */
    function renderDir() {
        return path.join(outDir(), "_renders");
    }

    /* Remove a directory tree, on whatever this runtime actually provides.
     *
     * ⚠️ PROBED, NOT ASSUMED. CEP 11 bundles its own Node and it is not the one on the machine:
     * fs.rmSync arrived in Node 14.14, and rmdirSync's `recursive` option was deprecated in 14
     * and REMOVED in 16 — so on some builds one works, on some the other, and on some neither.
     * The hand-rolled walk at the end needs no options at all and is the only branch that can
     * be relied on. Returns whether the directory is gone. */
    function rmTree(dir) {
        if (!dir || !exists(dir)) return true;
        try {
            if (typeof fs.rmSync === "function") {
                fs.rmSync(dir, { recursive: true, force: true });
                if (!exists(dir)) return true;
            }
        } catch (e) { log("rmSync could not remove " + dir + ": " + e); }
        try {
            if (typeof fs.rmdirSync === "function") {
                fs.rmdirSync(dir, { recursive: true });
                if (!exists(dir)) return true;
            }
        } catch (e2) { log("rmdirSync could not remove " + dir + ": " + e2); }
        try {
            var names = fs.readdirSync(dir);
            for (var i = 0; i < names.length; i++) {
                var p = path.join(dir, names[i]);
                var st = null;
                try { st = fs.statSync(p); } catch (e3) { st = null; }
                if (st && st.isDirectory()) rmTree(p);
                else { try { fs.unlinkSync(p); } catch (e4) {} }
            }
            fs.rmdirSync(dir);
        } catch (e5) {
            log("could not remove " + dir + ": " + e5);
        }
        return !exists(dir);
    }

    /* THE RENDER SCRATCH, after the run. Deleted only when there is nothing left to retry.
     *
     * ⚠️ NEVER BEFORE OR DURING THE RUN. ffmpeg is reading these files; they are the source
     * material of a render-mode export, not a by-product of it.
     *
     * A failure to delete NEVER fails an export. The clips are the deliverable and a leftover
     * working folder is cosmetic, so the worst case here is one quiet line on the rail. */
    function cleanRenders(dir, built, code) {
        if (!dir || !exists(dir)) return;
        var failed = failedRows().length;
        var missing = state.rendersMissing || 0;
        var why = "";
        if (!built || code !== 0) why = "this run did not finish cleanly";
        else if (failed) {
            why = failed + " clip" + (failed === 1 ? "" : "s") + " did not write";
        } else if (missing) {
            why = missing + " cut" + (missing === 1 ? "" : "s") + " had no render";
        }
        if (why) {
            /* Said out loud, because a folder that is sometimes there and sometimes not is a
             * thing you go looking for an explanation of. */
            say("renders", "info", "The rendered ranges are still in _renders/ because " + why
                + " — Retry re-encodes those without asking Premiere to render them again. "
                + "Delete the folder by hand once you are done with it.");
            return;
        }
        if (rmTree(dir)) {
            log("removed the render scratch: " + dir);
            say("renders", "info", "");
        } else {
            say("renders", "info", "The rendered ranges in _renders/ could not be removed. "
                + "They are Premiere intermediates and safe to delete by hand.");
        }
    }

    /* The cuts a render phase has to produce, as the host's "label|in|out" records. Only
     * video, only the chosen track, only what is actually ticked — the same set the
     * engine will be asked to cut, or the two would disagree about what a run is. */
    function renderSpec() {
        var want = Number(state.vtrackWant || 0);
        var picked = pickedClips(), out = [], i, c;
        for (i = 0; i < picked.length; i++) {
            c = picked[i];
            if (c.trackType !== "video") continue;
            if (want && Number(c.trackIndex) !== want) continue;
            if (!(c.timelineOut > c.timelineIn)) continue;
            /* The label IS the filename xmlcut.py looks the render up by, so it is
             * built from the timeline geometry and never from the clip's name.
             *
             * ⚠️ IN **AND** OUT. A cross-dissolve leaves the outgoing clip's overlap
             * sitting on the exact frame the incoming clip starts, so two cuts on one
             * track really can share an in-point — a 10-frame tail and an 88-frame clip
             * both at frame 448 on a real timeline. With the in-point alone they named
             * the same render and one of them got a file 78 frames too long. */
            out.push(c.trackType + "-" + c.trackIndex + "-" + c.timelineIn
                + "-" + c.timelineOut
                + "|" + c.timelineIn + "|" + c.timelineOut);
        }
        return out;
    }

    function renderScaleRead() {
        if (!el.scaleread) return;
        var pct = state.scale;
        var NAMES = { 100: "Full", 50: "Half", 25: "Quarter", 12.5: "Eighth" };
        var name = NAMES[pct] || (pct + "%");
        if (pct >= 100) { el.scaleread.textContent = "Full · source"; return; }
        // The clips that will actually be CUT, not every clip on the timeline: an
        // unticked 3000x3000 still would otherwise turn a uniform 1080x1920 export into
        // "mixed sources" on the strength of a file nobody is exporting.
        var picked = pickedClips();
        var seen = {}, dims = null, n = 0;
        for (var i = 0; i < picked.length; i++) {
            var c = picked[i];
            if (!c.w || !c.h) continue;
            var k = c.w + "x" + c.h;
            if (!seen[k]) { seen[k] = 1; n++; dims = [c.w, c.h]; }
        }
        var out = (n === 1) ? scaledDims(dims[0], dims[1], pct) : null;
        el.scaleread.textContent = name + " · "
            + (out ? (out[0] + "×" + out[1])
                   : (n > 1 ? "mixed sources" : "of source"));
    }

    /* The "flag large clips" threshold in BYTES, or 0 for off.
     *
     * MB here is 1024*1024, matching humanBytes — the two numbers sit next to each other
     * on the same row, and a clip shown as "10 MB" that is not flagged by a 10 MB cap
     * would read as a bug in whichever of the two the reader trusted less. */
    /* "H.265", not "libx265" — the stale-size line is read next to a dropdown that says
     * H.264 and H.265, and an ffmpeg library name there reads as a different setting. */
    function codecName(v) {
        return v === "libx265" ? "H.265" : "H.264";
    }

    /* The encoders this panel can SHOW. Diffed against index.html by tests/check_panel.js,
     * because the two have to agree in both directions: an option in the markup and not
     * here would make every preset naming it warn as unrepresentable, and an entry here
     * with no option would let applyPreset set a value the dropdown cannot display. */
    var PANEL_VCODECS = ["libx264", "libx265"];

    function capBytes() {
        return state.cap > 0 ? state.cap * 1024 * 1024 : 0;
    }

    /* Whether one finished clip is over the flag, asked of the size it ACTUALLY came out
     * at. Derived on every render rather than stored on the row, so typing a new
     * threshold re-marks a report that is already on screen — the report survives in
     * state.report long after the run, and a stored verdict would answer the question the
     * field asked at export time rather than the one being asked now. */
    function isOver(r) {
        var lim = capBytes();
        /* A FAILURE is not a size problem. ffmpeg can leave a partial file behind when it
         * exits non-zero, and that wreckage can be larger than the flag — but the fact worth
         * reporting about that clip is that it did not write, not how heavy the debris is.
         * The rows exclude it for the same reason, and this is the function that has to
         * agree with them: a count that disagrees with the rows under it is worse than no
         * count. */
        return !!(lim && r && !r.bad && r.bytes > lim);
    }

    /* The CRF band, MEASURED on real 1080x1920 footage at 13-15 Mbps — SSIM against the
     * originals, then the knee found by asking what each step buys:
     *
     *   MB saved per 0.001 SSIM: 5.49 (1->14), 1.71, 1.27, then 0.81, 0.53 …
     *   so the bend is 14-18.
     *
     * The bitrate band that used to sit beside it is gone with its slider. The reason is
     * kept here because it is the evidence for offering ONE control rather than two:
     * CRF 18 reached SSIM 0.9915 at 4.9 MB where 8 Mbps needed 5.9 MB for 0.9922 — the
     * same quality, 20% bigger, because a fixed rate spends the same bits everywhere
     * while CRF spends them where the picture needs them. */
    var BANDS = { crf: [1, 35, 14, 18] };

    /* Where a value sits along its slider, 0..1. Linear — the scale has run 1..35 since
     * it was drawn, and the band at 14-18 already lands mid-track without help.
     *
     * (The bitrate slider needed a logarithmic mapping to put its own band anywhere
     * usable. That went with the slider; if a rate control ever returns, the note in
     * CLAUDE.md explains why a linear one is unusable.) */
    function frac(key, v) {
        var b = BANDS[key];
        return (v - b[0]) / (b[1] - b[0]);
    }

    function paintBand(node, key) {
        node.style.left = (frac(key, BANDS[key][2]) * 100) + "%";
        node.style.width = ((frac(key, BANDS[key][3]) - frac(key, BANDS[key][2])) * 100)
            + "%";
    }

    /* Writes the state back into every control. Called on any settings change and after a
     * scan, so nothing on screen can be showing the boot value of something that moved. */
    function applyScale() {
        paintBand(el.sweetcrf, "crf");
        el.crf.value = String(state.crfVal);
        el.cap.value = state.cap > 0 ? String(state.cap) : "";
        el.scale.value = String(state.scale);
        renderScaleRead();
    }

    /* How many picked clips are over the flag, and — while the list is short enough to
     * name them — WHICH. On a 74-clip timeline "3 are over" leaves you scrolling for the
     * three; their numbers are the same numbers the filenames will carry. */
    function renderCapNote() {
        if (!el.capnote) return;
        var lim = capBytes();
        if (!lim) { el.capnote.textContent = ""; el.capnote.className = "capnote"; return; }
        var picked = pickedClips(), s = settings();
        var hits = [];
        for (var i = 0; i < picked.length; i++) {
            var b = clipBytes(picked[i], s);
            if (b > lim) hits.push(picked[i].n ? pad2(picked[i].n) : "?");
        }
        el.capnote.className = "capnote" + (hits.length ? " hit" : " clear");
        if (!picked.length) { el.capnote.textContent = ""; return; }
        if (!hits.length) {
            el.capnote.textContent = "none over";
        } else if (hits.length <= 5) {
            el.capnote.textContent = hits.length + " over · " + hits.join(" ");
        } else {
            el.capnote.textContent = hits.length + " of " + picked.length + " over";
        }
    }

    function renderSizeEstimate() {
        if (!el.sizeest) return;
        renderCapNote();
        /* Offered only when pressing it would change something: the sizes on screen were
         * measured at other settings, or were never measured at all. Set HERE rather than
         * where the settings change, so that after a
         * re-measure had already answered the question the button stayed on screen still
         * asking it. */
        if (el.remeasure) {
            // Always offered when nothing has been measured — it is the accurate path, not
            // a repair for a broken one.
            show(el.remeasure, !!state.clips.length && (staleSizes() || !measured()));
            el.remeasure.className = "mini" + (staleSizes() ? " on" : "");
        }
        var picked = pickedClips();
        if (!picked.length) {
            show(el.sizeest, false);
            say("sizes", "warn", "");
            return;
        }
        var s = settings(), total = 0, known = 0;
        for (var i = 0; i < picked.length; i++) {
            var b = clipBytes(picked[i], s);
            if (b > 0) { total += b; known++; }
        }
        // The readout beside the slider is the same number, so it is set HERE rather than
        // recomputed in renderSettings — which only ran on a settings change, leaving the
        // readout showing the boot value after a scan.
        el.crfread.textContent = state.crfVal
            + (total > 0 ? "  ·  " + humanBytes(total) : "");
        if (!known) {
            show(el.sizeest, false);
            say("sizes", "warn", "");
            return;
        }
        /* THE NUMBER IN THE BAR, THE CAVEAT ELSEWHERE.
         *
         * This one line used to carry both, and the explaining half is three times the
         * length of the fact: at a 320px dock "an estimate, usually within about 1.5x.
         * Re-measure encodes a second of each clip for a figure good to a few percent."
         * wrapped to three lines and made the action bar 96px tall to state one figure.
         *
         * So the bar gets the figure and one word for its provenance. The full explanation
         * of `estimated` and `measured` is on the ? beside it — the panel's own idiom for
         * "how is this number made", and it costs no pixels. The rail gets a row ONLY in the
         * stale case, which is the one where there is something to DO about it. */
        var stale = staleSizes();
        var how = stale
            ? ("measured at " + codecName(state.probeVcodec) + " CRF " + state.probeCrf
               + " · " + state.probeScale + "%")
            : (measured() ? "measured" : "estimated");
        el.sizeest.className = "abfact" + (stale ? " warn" : "");
        el.sizeest.textContent = "~" + humanBytes(total) + " for " + picked.length
            + " clip" + (picked.length === 1 ? "" : "s") + " · " + how;
        show(el.sizeest, true);
        // Never a scaled number. The sizes shown are the ones that were measured, and this
        // says which settings they belong to and what would refresh them.
        say("sizes", "warn", stale
            ? ("The sizes on screen were measured at " + codecName(state.probeVcodec)
               + " CRF " + state.probeCrf + " · " + state.probeScale + "% size, not at "
               + codecName(settings().vcodec) + " CRF " + state.crfVal + " · " + state.scale
               + "%. Re-measure to update them.")
            : "");
    }

    function renderSettings() {
        applyScale();
        // The one setting that changes what the files CONTAIN rather than how big
        // they are. Said in red, and not folded into a tooltip.
        say("fps", "error", el.fps.value
            ? ("Forcing " + el.fps.value + " fps RESAMPLES: frames are dropped or "
               + "duplicated to hit that rate, so these clips will NOT hold the frames "
               + "the timeline used. The manifest records them as frame_exact = false.")
            : "");
        renderAudioTracks();
        renderVideoTracks();
        applyCutFrom();
        renderListLabel();
        renderSizeEstimate();
        rememberSettings();
    }

    function rememberSettings() {
        try {
            window.localStorage.setItem("xmlcut.export", JSON.stringify({
                crf: state.crfVal, fps: el.fps.value,
                scale: state.scale,
                // Kept here rather than in a preset: presets are the ENGINE's file and
                // describe an encode, and this changes nothing about the encode.
                cap: state.cap
            }));
        } catch (e) {}
    }

    function restoreSettings() {
        var o = null;
        try { o = JSON.parse(window.localStorage.getItem("xmlcut.export") || "null"); }
        catch (e) { o = null; }
        if (!o) return;
        if (o.crf) state.crfVal = parseFloat(o.crf) || 1;
        if (o.fps) el.fps.value = o.fps;
        if (o.cap) state.cap = Math.max(0, parseFloat(o.cap) || 0);
        if (o.scale) state.scale = Math.max(10, Math.min(100, parseFloat(o.scale) || 100));
    }

    /* Presets live in a FILE the engine owns, not in localStorage — so one can be made in
     * the panel and used from a terminal, inspected, or shared. The engine is the only
     * thing that writes it. */
    function loadPresets(then) {
        runJson(["--list-presets-json"], function (r) {
            state.presets = (r && r.presets) || {};
            var keep = el.preset.value;
            el.preset.innerHTML = "";
            var blank = document.createElement("option");
            blank.value = "";
            blank.textContent = "Custom";
            el.preset.appendChild(blank);
            var names = [];
            for (var k in state.presets) {
                if (state.presets.hasOwnProperty(k)) names.push(k);
            }
            names.sort();
            for (var i = 0; i < names.length; i++) {
                var o = document.createElement("option");
                o.value = names[i];
                o.textContent = names[i];
                el.preset.appendChild(o);
            }
            el.preset.value = keep;
            el.delpreset.disabled = !el.preset.value;
            if (then) then();
        });
    }

    /* A preset can still carry a target bitrate — one made before the slider was
     * removed, or made from a terminal, where --bitrate is still supported. There is no
     * control here that can show one, so the quality half of such a preset is REFUSED and
     * said out loud. Applying it invisibly would export at a setting nothing on screen
     * names, which is the one thing this panel is not allowed to do; and silently
     * substituting the current CRF would be worse, because the preset would then have a
     * name that means something different in the panel than on the command line. */
    function applyPreset(name) {
        var s = state.presets && state.presets[name];
        if (!s) return;
        // Both halves below can be unrepresentable at once, so the refusals are collected
        // and said together rather than one of them overwriting the other.
        var refused = [];
        if (s.bitrate) {
            refused.push("\u201c" + name + "\u201d targets a bitrate of "
                + s.bitrate + ". This panel exports by CRF only, so its quality setting "
                + "was NOT applied — CRF " + state.crfVal + " still stands. Run "
                + "xmlcut.py --bitrate " + s.bitrate + " from a terminal if you need it.");
        } else {
            // parseFloat, not parseInt: a preset saved at crf 18.5 must not come back
            // as 18 while still calling itself by the same name.
            if (s.crf) {
                state.crfVal = Math.max(1, Math.min(35, parseFloat(s.crf) || 1));
            }
        }
        /* THE ENCODER IS A STORED SETTING, so applying a preset has to move the dropdown.
         * Until this was added, a preset saved while H.265 was chosen came back as H.264:
         * the panel showed one encoder and exported it, under a name the person had chosen
         * precisely so they would not have to remember which. It belongs with crf and
         * scale — it determines the size — not with the size flag.
         *
         * A preset with NO vcodec is H.264 by definition: either it predates the dropdown,
         * when x264 was the only encoder there was, or a panel saved it while dropping the
         * field. Leaving the current encoder standing instead would make one preset mean
         * different things depending on what happened to be on screen before it, which is
         * the same fault in the other direction. */
        var vc = s.vcodec ? String(s.vcodec) : "libx264";
        if (PANEL_VCODECS.indexOf(vc) < 0) {
            /* A presets.json is meant to be hand-editable, so it can name an encoder this
             * panel has no option for. Same rule as the bitrate half: refuse it out loud.
             * Falling back to H.264 silently would export something the preset's name says
             * it is not, and setting the value anyway would leave the dropdown blank. */
            refused.push("\u201c" + name + "\u201d was saved with encoder " + vc
                + ", which this panel cannot show. Its encoder was NOT applied — "
                + codecName(el.vcodec.value) + " still stands. Run xmlcut.py --vcodec "
                + vc + " from a terminal if you need it.");
        } else {
            el.vcodec.value = vc;
        }
        say("preset", "warn", refused.join(" "));
        el.fps.value = s.fps ? String(s.fps) : "";
        state.scale = s.scale ? Math.max(10, Math.min(100, parseFloat(s.scale) || 100)) : 100;
        renderSettings();
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
        el.updbar.className = "msg act " + (cls === "done" ? "good" : (cls || "good"));
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
                setEngineStat("error", "xmlcut.py is at that path but did not run: "
                              + (e || "no reply") + ". Check python3 is installed.");
            }
            if (!r) {
                log("update check failed: " + e);
                if (manual) {
                    setUpd("error", "Could not reach the release channel. " + e, "");
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
                    setUpd("error", "Could not check for updates — "
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
                setUpd("error", "Update failed: " + e, "");
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
                setUpd("error", r.message, "");
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

    /* WHICH AUDIO TRACKS THE MIX ACTUALLY READ, said after every run that asked for audio.
     *
     * "tuy a chọn render track A2 nhưng nó lại trả về audio của A1" — he chose one track and
     * got a different one, and the panel showed him NOTHING either way. The manifest has
     * carried `audio_tracks` (what was mixed) and `audio_tracks_requested` (what was asked
     * for) as separate fields all along, precisely so that a filter which failed to apply can
     * be told apart from "every track was wanted" — and nothing in this panel read either of
     * them. The one fact he needed in order to see the bug was the one fact he could not get.
     *
     * ⚠️ FACTS ONLY, AND NO ASSUMPTION ABOUT WHAT IS ON A TRACK. This panel does not know
     * which track holds a voice-over and which holds music. On his timeline the voice-over
     * was A2 and the music A1; on the next project it may be A4. Naming a track by what it is
     * expected to contain is the assumption that produced the complaint, so this reports the
     * numbers the engine reports, plus how many items each track holds, and lets the reader
     * judge which one they wanted.
     *
     * ⚠️ A MISMATCH IS AN ERROR, not a footnote. It means the mp3 sitting beside the clips is
     * not the audio that was asked for — silently wrong data, which for a dataset is the
     * worst kind of wrong.
     */
    function trackNames(list) {
        var out = [];
        for (var i = 0; i < (list || []).length; i++) out.push("A" + list[i]);
        return out.join(", ");
    }

    function sayAudioTracks(st) {
        // Audio was not asked for, so there is nothing to report — not even that there isn't.
        if (!st.audio) { say("audio", "info", ""); return; }
        var used = (st.audio_tracks || []).map(Number);
        var want = (st.audio_tracks_requested || []).map(Number);
        var have = st.audio_tracks_available || [];
        var ta = st.timeline_audio || {};
        /* What the timeline HAD to offer, with each track's item count, so a mismatch can be
         * understood without going anywhere else. On a real timeline the track holding one
         * long item and the track holding fourteen short ones are obvious to their editor and
         * invisible to this tool. */
        var offer = [], h, n;
        for (h = 0; h < have.length; h++) {
            n = Number(have[h].items || 0);
            offer.push("A" + have[h].index + " (" + n + (n === 1 ? " item" : " items") + ")");
        }
        var had = offer.length ? " This timeline has " + offer.join(", ") + "." : "";
        /* ⚠️ THE FILES THAT WENT IN, BY NAME. This is the one fact a wrong number cannot fake,
         * and its absence is why "A2 only" shipped a full copy of the background music for a
         * whole release with every numeric field reading green: nothing anywhere named the
         * material in the mix, so there was nothing to check the number against. The engine
         * reports it as settings.timeline_audio.sources — [{name, parts}] — and a basename is
         * something an editor recognises at a glance. */
        var src = [], q;
        for (q = 0; q < (ta.sources || []).length; q++) {
            var nm = String(ta.sources[q].name || "?");
            var pc = Number(ta.sources[q].parts || 0);
            src.push(nm + (pc > 1 ? " ×" + pc : ""));
        }
        var mix = ta.file
            ? (" Written: " + ta.file
               + (ta.seconds ? ", " + Number(ta.seconds).toFixed(2) + "s" : "")
               + (ta.parts ? ", from " + ta.parts + " item(s)" : "") + "."
               + (src.length ? " It holds: " + src.join(", ") + "." : ""))
            : (ta.note ? " " + String(ta.note) : " No audio file was written.");

        // THE BUG. Said first, said loudly, and said in the words of what it costs.
        if (want.length && want.join(",") !== used.join(",")) {
            say("audio", "error", "AUDIO TRACK MISMATCH — " + trackNames(want)
                + " was asked for, but the mix read "
                + (used.length ? trackNames(used) : "no track")
                + ". The audio file beside these clips is NOT the track you chose." + had
                + mix);
            return;
        }
        // Asked for and got: still reported, because "it worked" is only checkable if the
        // panel says which track it read when it worked.
        var sev = ta.file ? "info" : "warn";
        if (!want.length) {
            say("audio", sev, "Audio: read "
                + (used.length ? "every audio track — " + trackNames(used)
                               : "no audio track")
                + "." + mix);
            return;
        }
        say("audio", sev, "Audio: read " + trackNames(used) + ", as asked." + had + mix);
    }

    function buildReport() {
        state.report = [];
        state.reportFresh = true;
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
            // The real size, not an estimate — the file is on disk by now. xmlcut records
            // what it wrote; if it did not, fall back to nothing rather than guessing.
            var wrote = Number(c.output_bytes || 0);
            if (wrote > 0) facts.push(humanBytes(wrote));
            if (Math.abs(spd - 100) > 0.01) {
                facts.push(Math.round(spd) + "%");
                if (tl > 0) facts.push("→ " + tl.toFixed(2) + "s");
            }
            if (c.reversed) facts.push("reversed");
            if (c.speed_varies) facts.push("ramp " + (c.speed_span || "varies"));
            if (bad) facts.push(String(c.error || st).substring(0, 120));
            else if (st === "unsupported") facts.push("not decodable");
            else if (st === "skipped_existing") facts.push("kept");

            /* The manifest is the AUTHORITY on what happened, and the row states are
             * brought up to it here. The live states came off stdout, which cannot know
             * the finished size and never hears about a clip that returned before it
             * announced itself — a missing source, or one --resume skipped. This is also
             * what makes the table the report: after this loop every row says what the
             * manifest says. */
            /* Built by hand rather than through clipKey(), because a manifest row is not a
             * clip row — it carries the engine's field names. It must therefore make the SAME
             * choice clipKey() makes, in the same order: the engine's cut_id when the manifest
             * sent one, and the four fields (out-point included) when it did not. Spell it any
             * other way and the whole report writes to keys no row holds — every outcome, every
             * size, every failure reason landing nowhere. */
            var rkey = String(c.cut_id || "") || (String(c.track_type || "video") + " "
                + Number(c.track_index || 1) + " "
                + Number(c.timeline_in_frames || 0) + " "
                + Number(c.timeline_out_frames || 0));
            setRow(rkey, {
                st: bad ? "bad" : (st === "skipped_existing" ? "kept"
                                   : (st === "ok" ? "ok" : "bad")),
                bytes: wrote,
                // What to say in the last column when it is not just a time: the reason it
                // failed, or that the file was already there.
                /* ⚠️ A WORD, NOT A SENTENCE. This carried the engine's error message, up to 90
                 * characters of it, into a column that is 76px wide at a 320px dock — so the one
                 * thing anybody wants after a failed run, WHY it failed, was silently clipped at
                 * every width the panel is used at (measured: "failed — encoder exit 1" needs
                 * 131px, the column gives 76 docked and 120 undocked). These cells are
                 * white-space: nowrap, so it never even wrapped to announce itself.
                 *
                 * The reason now goes where there is room for it: the row's own tooltip, and the
                 * rail when the failures do not share one. This says which of four things
                 * happened, in a word that fits. */
                note: bad ? "failed"
                    : (st === "skipped_existing" ? "kept"
                       : (st === "unsupported" ? "not media" : "")),
                // The full reason, for the tooltip and the rail. Never for the cell.
                why: bad ? String(c.error || st).split("\n")[0].substring(0, 160) : "",
                done: true
            });
            state.report.push({
                key: rkey,
                name: String(c.output_file || c.clip_name || "?"),
                facts: facts.join(" · "),
                bad: bad,
                warn: warn,
                // The size the file ACTUALLY came out at, kept as a number so the flag
                // can be re-applied when the threshold changes. Storing an over/under
                // verdict here instead would freeze it at whatever the field said the
                // moment the export finished, and the whole point of typing a new number
                // is to ask the same question again.
                bytes: wrote,
                // Did this cut actually get WRITTEN this run? Kept apart from `bad`, which
                // only says something went wrong: a clip that was skipped by --resume is
                // neither written nor broken, and calling it either would be a lie in the
                // one place someone checks after a long export.
                wrote: (st === "ok"),
                kept: (st === "skipped_existing"),
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
        // Kept in state as well as said on the rail: reportText() pastes it, and reading it
        // back off the element it was written to is how that line silently emptied when the
        // element moved.
        state.completeness = comp;
        say("complete", "info", comp);
        /* How many cuts the render phase failed to produce. Read here because this is where the
         * run's manifest is already open, and needed by cleanRenders(): a cut with no render is
         * a reason to KEEP the scratch folder even when nothing reported a failure. */
        state.rendersMissing = Number((data.settings || {}).renders_missing || 0);

        // WHICH AUDIO TRACKS THE MIX ACTUALLY READ. See sayAudioTracks().
        sayAudioTracks(data.settings || {});

        // And WHERE it wrote, which the report never said despite having a Show button.
        // Named in words too: the clips are in a folder called after the sequence, and
        // anyone expecting the root folder finds it empty and calls the files missing.
        var f = seqFolder();
        // Names the SUBFOLDER too, since there are two now. A caption that said only
        // "a folder named after the sequence" would send someone to the level above the
        // clips, find it holding two folders, and be exactly as lost as before.
        el.repdestlbl.textContent = f
            ? ("Clips are in a folder named after the sequence — " + f + "/"
               + outKind() + "/")
            : "Clips are in:";
        show(el.repdestlbl, !!outDir());
        setPathLabel(el.repdest, outDir(), 60);
        show(el.repdestrow, !!outDir());
        return true;
    }

    /* The end of a run, said once — and NOT as a second list.
     *
     * This used to build #rows: every clip again, with a marker, a name and a facts string,
     * in a section that appeared where the table had been hidden. Same clips, third visual
     * language, and the ticks and type colours gone. buildReport() now brings the row states
     * up to what the manifest says, so the table you have been watching IS the report; what
     * is left here is the filter and the counts, which are about the run, not a clip. */
    /* The keys of the clips that did not write, for a retry to run and for the headline to
     * count. Derived from the report rather than stored, so it answers for whatever run is
     * currently on screen. */
    function failedRows() {
        var out = [];
        for (var i = 0; i < state.report.length; i++) {
            if (state.report[i].bad && state.report[i].key) out.push(state.report[i]);
        }
        return out;
    }

    function renderReport() {
        var anyProblem = false, nOver = 0;
        for (var q = 0; q < state.report.length; q++) {
            if (state.report[q].problem) anyProblem = true;
            if (isOver(state.report[q])) nOver++;
        }
        /* FAILURES LEAD. When clips did not write, the list filters itself down to them and
         * the primary action becomes retrying those — the two things you would otherwise do
         * by hand, in that order, after reading nineteen rows to find the two red ones.
         *
         * Auto-ticked only when a run has just produced failures (state.reportFresh), never
         * on a re-render: typing a new size threshold or clicking a row must not silently
         * re-filter a list he has just unfiltered. */
        var failed = failedRows();
        if (state.reportFresh) {
            state.reportFresh = false;
            el.onlyprob.checked = failed.length > 0;
        }
        show(el.retry, failed.length > 0);
        // One expression, not a special case for a single failure: "Retry the 1 that failed"
        // reads correctly out of the general form, and a hard-coded branch beside a computed
        // one is where an off-by-one hides — the fixture has exactly one failure, so the
        // computed half was never exercised by a test at all.
        el.retry.textContent = "Retry the " + failed.length + " that failed";
        el.retry.disabled = state.busy || state.running;
        /* Two primaries would compete, so only one of them is ever the primary: retrying is
         * the next move when something failed, and exporting again is the next move when
         * nothing did. */
        el.again.className = failed.length > 0 ? "mini" : "primary";
        // Offering "only problems" when there are none is a control that can only produce
        // an empty list. Hidden instead — and un-ticked, so a run that fixes everything
        // cannot leave the table filtered down to nothing.
        if (!anyProblem && el.onlyprob.checked) el.onlyprob.checked = false;
        show(el.onlyproblab, anyProblem || nOver > 0);
        el.repcount.textContent = nOver ? (nOver + " over " + state.cap + " MB") : "";
        el.repcount.className = "repcount" + (nOver ? " hit" : "");
        barMode();
        /* The headline lives in the next-action line at the top of the panel, and this is the
         * only place that knows a run has just failed. refreshExportEnabled() runs before the
         * report is revealed — it is called from setBusy() — so without this the line still
         * read "Ready. 4 clips will be written…" underneath a report saying two did not. */
        renderNext();
        renderClips();
    }

    /* A CEP panel has no reliable navigator.clipboard, so everything goes through a
     * textarea and execCommand, which does work in the embedded Chromium. One helper,
     * because there are now three things worth copying. */
    function copyText(text, btn, label) {
        var ta = document.createElement("textarea");
        ta.value = String(text || "");
        ta.style.position = "fixed";
        ta.style.top = "-1000px";
        document.body.appendChild(ta);
        ta.select();
        var ok = false;
        try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
        document.body.removeChild(ta);
        var was = btn.textContent;
        btn.textContent = ok ? "Copied" : "Failed";
        if (!ok) log("could not copy: " + text);
        setTimeout(function () { btn.textContent = label || was; }, 1400);
        return ok;
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
        if (state.completeness) out.push(state.completeness);
        // The size flag travels with the paste. This report gets sent to whoever asked
        // why the output was heavy, and "▲" beside four filenames means nothing without
        // the line that says what the ▲ is measured against.
        var over = [];
        for (var v = 0; v < state.report.length; v++) {
            if (isOver(state.report[v])) over.push(state.report[v].name);
        }
        if (over.length) {
            out.push(over.length + " clip(s) over " + state.cap + " MB, marked ▲");
        }
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

    el.read.addEventListener("click", function () {
        // Reading a sequence means he is past "what changed" and into the work.
        say("changelog", "info", "");
        readSequence();
    });

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

    /* WHEN THE SEQUENCE CHECK FIRES. Two of the three moments are here; the third and
     * authoritative one is inside doExport().
     *
     * 1. THE PANEL REGAINS FOCUS OR BECOMES VISIBLE. This is the exact moment the failure
     *    happens through: he switches sequence in Premiere, then comes back to the panel to
     *    press Export. Both events are bound because a docked CEP panel does not reliably
     *    get a window focus event when the tab it lives in is brought forward — the
     *    visibility change does. Firing twice costs one round trip and the check is
     *    idempotent, so the overlap is not worth avoiding. */
    window.addEventListener("focus", function () { checkSequence("focus"); });
    document.addEventListener("visibilitychange", function () {
        if (!document.hidden) checkSequence("focus");
    });
    /* 2. SLOWLY, WHILE IDLE, so a mismatch does not sit unnoticed on a panel that is never
     *    refocused. Whether a round trip is allowed at all is decided inside
     *    checkSequence() — one place makes that call, not two. */
    setInterval(function () { checkSequence("idle"); }, SEQ_CHECK_MS);

    el.cancel.addEventListener("click", cancelRun);

    el.retry.addEventListener("click", function () {
        var keys = [];
        var bad = failedRows();
        for (var i = 0; i < bad.length; i++) keys.push(bad[i].key);
        if (!keys.length) return;
        state.retryKeys = keys;
        /* Straight into the run. doExport() hides the report and shows progress itself, and
         * the rows being retried go back to "encoding" as their start lines arrive — the rest
         * keep the results they already have. */
        doExport();
    });

    el.again.addEventListener("click", function () {
        /* Back to planning. The rows keep the finished run's states — they are facts about
         * files on disk, and jobsReset() clears them when the next run actually starts, not
         * when you say you might. The list and the settings never went away, so there is
         * nothing here to restore. */
        showReport(false);
        barMode();
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

    el.wholeframes.addEventListener("change", function () {
        try { window.localStorage.setItem("xmlcut.wholeframes",
                                          el.wholeframes.checked ? "1" : ""); } catch (e) {}
        // It changes which frames land in the file, so it is not the named preset any more.
        el.preset.value = "";
        el.delpreset.disabled = true;
        if (state.clips.length) renderClips();
    });

    el.audiosel.addEventListener("change", function () {
        /* ⚠️ state.audioWant TOO, not only localStorage. renderAudioTracks() rebuilds the menu on
         * every settings repaint and sets its value from state — so writing the choice to storage
         * alone let the very next repaint put the old value back, and the flag never reached the
         * engine. */
        state.audioWant = String(el.audiosel.value || "");
        rememberAudioWant();
        // A fresh choice answers the migration notice, so it goes.
        state.audioDropped = "";
        say("audionum", "warn", "");
        // It changes what a run writes, so it is not the named preset any more.
        el.preset.value = "";
        el.delpreset.disabled = true;
    });

    el.resume.addEventListener("change", function () {
        state.resume = el.resume.checked;
        try { window.localStorage.setItem("xmlcut.resume",
                                          state.resume ? "1" : ""); } catch (e) {}
    });

    el.copyrep.addEventListener("click", function () {
        copyText(reportText(), el.copyrep, "Copy report");
    });

    // The FULL path, not the shortened label on screen — what you paste to a teammate.
    el.copyout.addEventListener("click", function () {
        copyText(state.out, el.copyout, "Copy");
    });
    el.copydest.addEventListener("click", function () {
        copyText(outDir(), el.copydest, "Copy");
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

    /* The same folder as #reveal, reachable BEFORE a run instead of only from the report.
     * Same fallback for the same reason: the sequence folder is not created until the engine
     * writes into it, so until then the honest thing to open is the root he chose. */
    el.openout.addEventListener("click", function () {
        var d = outDir();
        reveal(exists(d) ? d : state.out);
    });

    /* Re-measure. Deliberately a BUTTON rather than something that fires on its own after a
     * pause: it spawns a real encode of every clip, and a control that starts nineteen ffmpeg
     * processes because you nudged a slider is worse than an estimate that says it is one.
     * Sets the flag for ONE scan; argsFor clears it as it is used. */
    el.remeasure.addEventListener("click", function () {
        if (state.busy || !state.dump) return;
        state.wantProbe = true;
        setBusy(true, "Measuring…");
        scanClips();
    });
    // The way back into a collapsed step 1. Same action as the big button it replaced;
    // readSequence() re-expands the step itself on the way through its reset.
    el.readagain.addEventListener("click", function () { readSequence(); });
    el.updbtn.addEventListener("click", applyUpdate);
    /* --------------------------------------------- POC · export with effects
     *
     * Cutting reads RAW SOURCE MEDIA, so nothing done on the timeline reaches the
     * clips — no colour, no Motion, no titles, no speed ramp. Only Premiere can bake
     * those in, by rendering the timeline range instead of seeking the source file.
     *
     * The question that decides whether that is buildable is not whether it works —
     * it is what ONE export costs in fixed overhead. At a second a cut, rendering
     * every cut separately is plainly right: it removes the frame-alignment risk
     * entirely, keeps resume and per-row retry working, and needs no intermediate on
     * disk. At fifteen seconds a cut, a sixty-cut timeline is fifteen minutes of
     * nothing and the whole approach has to change to one render, sliced.
     *
     * So: two ranges of different lengths, then the first one again.
     *
     *     warm-up   = first − repeat            (a one-off, not a per-cut cost)
     *     per frame = (long − repeat) / (long frames − short frames)
     *     overhead  = repeat − per frame × short frames
     *
     * Two points is a line, not a model, and it is reported as one. It is enough to
     * separate a second from fifteen, which is the only distinction the architecture
     * actually turns on.
     *
     * Nothing here touches an export. It renders two short ranges and puts the
     * sequence's in/out points back where it found them.
     */

    /* `pad` because this is a report to be read, not a status to be glanced at: it
     * keeps the line breaks, sizes the text like body copy, and stays selectable so
     * the numbers can be copied out. */
    function pocSay(text, cls) {
        el.pocnote.className = "msg pad" + (cls ? " " + cls : "");
        el.pocnote.textContent = text;
        show(el.pocnote, true);
    }

    function pocMins(secs) {
        return secs < 90 ? (Math.round(secs) + "s")
                         : ((secs / 60).toFixed(1) + " min");
    }

    /* The shortest video cut and the longest, so the two timings differ by as much as
     * this timeline allows — two ranges a frame apart measure nothing but noise. Both
     * are capped, because a probe that renders a five-minute clip is not a probe. */
    function pocPickRanges() {
        var fps = Number((state.info && state.info.fps) || 0) || 25;
        var cap = Math.max(1, Math.round(fps * 20));
        var vids = [], i, c, n;
        for (i = 0; i < state.clips.length; i++) {
            c = state.clips[i];
            if (c.trackType !== "video") continue;
            n = c.timelineOut - c.timelineIn;
            if (n > 0) vids.push({ label: c.clip, inF: c.timelineIn,
                                   outF: c.timelineOut, n: n });
        }
        if (!vids.length) return [];
        vids.sort(function (a, b) { return a.n - b.n; });

        function capped(v) {
            return { label: v.label, inF: v.inF,
                     outF: Math.min(v.outF, v.inF + cap) };
        }
        var a = capped(vids[0]);
        var b = capped(vids[vids.length - 1]);
        // Equal lengths after capping — or only one clip — leave nothing to fit a line
        // through. One render still answers "does it work at all", which is worth having.
        if ((b.outF - b.inF) === (a.outF - a.inF)) return [a];
        return [a, b];
    }

    function pocSpec(ranges) {
        var parts = [], i, lab;
        for (i = 0; i < ranges.length; i++) {
            // `|` and `;` are the host's field and record separators, and a clip called
            // "A;B" would otherwise silently become two malformed records.
            lab = String(ranges[i].label || "clip")
                .replace(/[|;]/g, " ").replace(/\s+/g, "_").substring(0, 28);
            parts.push(lab + "|" + ranges[i].inF + "|" + ranges[i].outF);
        }
        return parts.join(";");
    }

    function pocReport(r) {
        var L = [], rs = r.renders || [], i, t, x;
        for (i = 0; i < (r.tried || []).length; i++) log("poc: " + r.tried[i]);
        for (i = 0; i < rs.length; i++) {
            for (t = 0; t < (rs[i].tried || []).length; t++) {
                log("poc: " + rs[i].label + ": " + rs[i].tried[t]);
            }
        }

        if (!r.ok) {
            L.push(r.error || "The probe failed.");
            for (i = 0; i < rs.length; i++) {
                for (t = 0; t < (rs[i].tried || []).length; t++) {
                    L.push("· " + rs[i].tried[t]);
                }
            }
            L.push("");
            L.push("Every attempt is in the log, under the gear.");
            pocSay(L.join("\n"), "error");
            return;
        }

        var ok = [];
        for (i = 0; i < rs.length; i++) if (rs[i].ok) ok.push(rs[i]);

        L.push("✅ Premiere rendered " + ok.length + " of " + rs.length
            + " range(s) — " + (ok[0].method || "?"));
        L.push("Preset: " + (r.preset_name || r.preset || "?"));

        /* Frame accuracy. The in/out is set in seconds and read back in ticks, so this
         * is the round-trip error measured rather than assumed. Anything but zero here
         * would mean every cut lands off by a fraction of a frame. */
        var off = 0, howRead = "";
        for (i = 0; i < rs.length; i++) {
            var a = Math.abs(Number(rs[i].in_off_frames || 0));
            var b = Math.abs(Number(rs[i].out_off_frames || 0));
            if (a > off) off = a;
            if (b > off) off = b;
            if (!howRead && rs[i].read_how) howRead = rs[i].read_how;
        }
        L.push(off === 0
            ? "🎯 In/out landed exactly on the frames asked for (" + howRead + ")."
            : "⚠️ In/out was off by up to " + off.toFixed(3) + " frame(s) ("
                + howRead + ").");
        L.push("");

        for (i = 0; i < rs.length; i++) {
            x = rs[i];
            if (!x.ok) {
                L.push("· " + x.label + " — " + (x.error || "no file written"));
                continue;
            }
            L.push("· " + x.label + " — " + x.frames + " frames in "
                + (x.ms / 1000).toFixed(1) + "s"
                + (x.bytes ? "  (" + (x.bytes / 1048576).toFixed(1) + " MB)" : ""));
        }
        L.push("");

        var first = null, longer = null, repeat = null;
        for (i = 0; i < rs.length; i++) {
            if (rs[i].is_repeat_of === 0) repeat = rs[i];
            else if (first === null) first = rs[i];
            else if (longer === null) longer = rs[i];
        }

        if (first && repeat && first.ok && repeat.ok) {
            var warm = first.ms - repeat.ms;
            if (warm > 250) {
                L.push("Warm-up: the first render cost " + (warm / 1000).toFixed(1)
                    + "s more than the identical repeat — paid once, not per cut.");
            }
        }

        // The WARM timing is the honest per-export cost; the first one carries start-up.
        var base = (repeat && repeat.ok) ? repeat : first;
        if (!(base && base.ok && longer && longer.ok
              && longer.frames !== base.frames)) {
            L.push("Only one length rendered, so fixed overhead cannot be separated"
                + " from encoding time. The numbers above are still real timings.");
            pocFinish(L, r);
            return;
        }

        var perFrame = (longer.ms - base.ms) / (longer.frames - base.frames);
        var overhead = base.ms - perFrame * base.frames;
        if (!(perFrame > 0) || !(overhead > 0)) {
            L.push("The two timings were too close to tell overhead and encoding apart"
                + " — " + base.frames + " and " + longer.frames + " frames took "
                + (base.ms / 1000).toFixed(1) + "s and "
                + (longer.ms / 1000).toFixed(1) + "s. Try a timeline with a longer clip.");
            pocFinish(L, r);
            return;
        }

        var cuts = 0, frames = 0, seqEnd = 0, c;
        for (i = 0; i < state.clips.length; i++) {
            c = state.clips[i];
            if (c.timelineOut > seqEnd) seqEnd = c.timelineOut;
            if (c.trackType !== "video") continue;
            cuts++;
            frames += (c.timelineOut - c.timelineIn);
        }
        var perSeg = (cuts * overhead + perFrame * frames) / 1000;
        var oneGo = (overhead + perFrame * seqEnd) / 1000;

        L.push("Overhead per export: " + (overhead / 1000).toFixed(1)
            + "s · encoding: " + perFrame.toFixed(1) + " ms/frame");
        L.push("This timeline — " + cuts + " video cuts, " + frames + " frames:");
        L.push("   each cut rendered separately ≈ " + pocMins(perSeg));
        L.push("   the whole sequence rendered once ≈ " + pocMins(oneGo)
            + " (then sliced by ffmpeg)");
        L.push("");
        L.push("Two timings is a line, not a model — enough to tell a second a cut"
            + " from fifteen, which is all this has to decide.");
        pocFinish(L, r);
    }

    function pocFinish(L, r) {
        L.push("");
        L.push(r.restored
            ? "Your in/out points were put back."
            : "⚠️ Your in/out points could NOT be restored — check the timeline.");
        if (r.folder) {
            L.push("Files: " + r.folder);
            reveal(r.folder);
        }
        pocSay(L.join("\n"), r.restored ? "" : "warn");
    }

    function runRenderPoc() {
        if (!state.clips.length) {
            pocSay("Read the timeline first — the probe renders two of its own clips,"
                + " so it needs the cut list.", "warn");
            return;
        }
        if (state.running) {
            pocSay("An export is running. Let it finish first.", "warn");
            return;
        }
        var ranges = pocPickRanges();
        if (!ranges.length) {
            pocSay("No video clips on this timeline to render.", "warn");
            return;
        }
        var dir = String(state.out || "").replace(/\/+$/, "");
        if (!dir) {
            pocSay("Set a destination folder first — the renders have to land"
                + " somewhere.", "warn");
            return;
        }
        dir = dir + "/_render_poc";

        el.pocrender.disabled = true;
        pocSay("Rendering " + (ranges.length + 1) + " range(s) through Premiere."
            + "\nPremiere is busy until it finishes. This panel stays live.", "");
        log("poc: probing " + dir);

        cs.evalScript("probeRender(" + jsStr(dir) + ", " + jsStr(pocSpec(ranges))
            + ", " + renderMbps() + ", 1)",
            function (raw) {
                el.pocrender.disabled = false;
                var r = hostReply(raw);
                if (!r) {
                    log("poc: unreadable reply: " + raw);
                    pocSay("Premiere did not return a readable reply. The raw text is"
                        + " in the log, under the gear.", "error");
                    return;
                }
                pocReport(r);
            });
    }

    el.pocrender.addEventListener("click", runRenderPoc);

    el.checkupd.addEventListener("click", function () { checkUpdate(true); });
    el.recheck.addEventListener("click", function () { recheckScript(false); });

    /* `input`, not `change`: a range fires `change` only on release, and watching the
     * size move while dragging is the whole point of a slider here.
     *
     * renderSettings is deliberately NOT called from either handler — it writes the value
     * back into the slider, which would fight a drag in progress.
     *
     * There is no mode to select any more. The touch-to-select machinery that used to sit
     * here existed only to stop the two quality sliders needing a radio ticked first;
     * with one quality control there is nothing to choose between, so it is gone rather
     * than left switching a thing to itself. */
    el.crf.addEventListener("input", function () {
        // parseFloat, not parseInt: CRF steps in halves and x264 takes a float, so
        // rounding here would quietly discard half of every step.
        var v = parseFloat(el.crf.value);
        if (!isNaN(v)) state.crfVal = v;
        el.preset.value = "";
        el.delpreset.disabled = true;
        say("preset", "warn", "");
        renderSizeEstimate();
        if (state.clips.length) renderClips();
    });

    /* Resolution applies ON TOP of the quality setting rather than competing with it — it
     * resamples space, not bits. It does clear the named preset, because unlike the size
     * flag it genuinely changes what ffmpeg is told. */
    /* `change`, not `input`, and parseFloat, not parseInt: this is a <select> of named
     * fractions now, and "12.5" truncated to 12 would silently export an Eighth as 12%. */
    el.scale.addEventListener("change", function () {
        var v = parseFloat(el.scale.value);
        if (!isNaN(v)) state.scale = Math.max(1, Math.min(100, v));
        el.preset.value = "";
        el.delpreset.disabled = true;
        say("preset", "warn", "");
        rememberSettings();
        renderScaleRead();
        renderSizeEstimate();
        if (state.clips.length) renderClips();
    });

    /* The flag is not an encode setting, so it does not clear the named preset and does
     * not go through renderSettings — nothing it changes affects what ffmpeg is told.
     * ONE function, reached both by typing and by dragging, so the two cannot drift. */
    function applyCap() {
        var v = parseFloat(el.cap.value);
        state.cap = (isNaN(v) || v <= 0) ? 0 : v;
        rememberSettings();
        renderCapNote();
        if (state.clips.length) renderClips();
        if (state.report.length) renderReport();
    }

    // `input` rather than `change`, so the table reacts as the number is typed.
    el.cap.addEventListener("input", applyCap);

    /* Drag the number sideways to change it, the way every numeric field in Premiere
     * works. It was asked for by that comparison, and the details are what make it feel
     * like that one rather than merely respond to a drag:
     *
     *   - a click that does not MOVE is still a click. Premiere focuses the field for
     *     typing; so mousedown cannot commit to a scrub, it has to wait and see. Under
     *     SLOP px of travel this ends in focus() and select(), and typing works as before.
     *   - the pointer is followed on `document`, not on the input. Drag faster than the
     *     repaint and the cursor leaves the 62px box within one frame; bound to the input,
     *     the scrub would stop dead the moment it did.
     *   - the delta is measured from where the drag STARTED, never accumulated per move.
     *     Accumulating rounds every step and the value drifts away from the pointer over a
     *     long drag, so letting go leaves it somewhere you did not put it.
     *   - it never goes below zero, because zero is already "off" and there is nothing
     *     underneath it to mean.
     */
    function scrubNumber(input, pxPer, after) {
        var SLOP = 3;
        var live = false, moved = false, x0 = 0, v0 = 0;
        input.addEventListener("mousedown", function (e) {
            live = true;
            moved = false;
            x0 = e.clientX;
            v0 = parseFloat(input.value);
            if (isNaN(v0)) v0 = 0;
            // Stops the caret being placed and the label being text-selected mid-drag.
            // The click case is put back by hand on mouseup.
            if (e.preventDefault) e.preventDefault();
        });
        document.addEventListener("mousemove", function (e) {
            if (!live) return;
            var dx = e.clientX - x0;
            if (!moved && Math.abs(dx) < SLOP) return;
            moved = true;
            state.scrubbing = true;
            paintBody();
            var v = Math.max(0, Math.round(v0 + dx / pxPer));
            if (String(v) !== input.value) {
                input.value = String(v);
                after();
            }
        });
        document.addEventListener("mouseup", function () {
            if (!live) return;
            live = false;
            state.scrubbing = false;
            paintBody();
            if (!moved) {
                if (input.focus) input.focus();
                if (input.select) input.select();
            }
        });
    }

    // 3px per MB: 5 to 50 is a 135px drag, about the width of the panel's controls, and a
    // single pixel of jitter cannot move the number.
    scrubNumber(el.cap, 3, applyCap);

    var setInputs = [el.fps, el.vcodec, el.audiosel];
    for (var si = 0; si < setInputs.length; si++) {
        setInputs[si].addEventListener("change", function () {
            // Any hand edit means the settings are no longer the named preset.
            el.preset.value = "";
            el.delpreset.disabled = true;
            renderSettings();
            if (state.clips.length) renderClips();
        });
    }
    el.preset.addEventListener("change", function () {
        el.delpreset.disabled = !el.preset.value;
        if (el.preset.value) applyPreset(el.preset.value);
    });

    /* ⚠️ NOT in the setInputs loop above, and not in a preset. A preset is the ENGINE's
     * file and describes an ENCODE — crf, codec, scale, rate. Where the pixels come from
     * is a different kind of choice, and putting it in a preset would mean applying a
     * saved preset could silently switch a run from source to render. */
    el.cutfrom.addEventListener("change", function () {
        state.cutFrom = String(el.cutfrom.value || "source");
        try { window.localStorage.setItem("xmlcut.cutfrom", state.cutFrom); } catch (e) {}
        applyCutFrom();
        renderSettings();
        if (state.clips.length) renderClips();
        /* ⚠️ RE-READ THE LIST, because the mode changes what is IN it.
         *
         * `cuttable` depends on the mode: typesFromClips() switches DEAD_TYPES back on in
         * render mode, since Premiere resolves a Dynamic Link that ffmpeg cannot open. So after
         * a switch the list on screen was the OTHER mode's answer — an .aep shown as
         * uncuttable in the mode that can cut it, and the destination folder had changed under
         * it too.
         *
         * A rescan rather than a stale marker: it costs one --manifest-only run, it is the same
         * call a re-read makes, and the alternative is a list that is on screen and wrong with
         * a disabled Export button beside it — which is the state this panel has been reported
         * for twice. scanClips() keeps the existing rows up while it runs, so nothing blanks. */
        if (state.clips.length && state.dump && state.script && !state.busy
            && !state.running) {
            setBusy(true, "Re-reading…");
            scanClips();
        }
    });

    el.vtrack.addEventListener("change", function () {
        state.vtrackWant = String(el.vtrack.value || "");
        renderListLabel();
        // The new master must be ticked and locked, and the old one released.
        renderIncludeTracks();
        try { window.localStorage.setItem("xmlcut.vtrack", state.vtrackWant); } catch (e) {}
        renderSettings();
        if (state.clips.length) renderClips();
    });
    el.savepreset.addEventListener("click", function () {
        cs.evalScript("askName(" + jsStr("Save these export settings as:") + ")",
            function (name) {
                name = String(name || "").trim();
                if (!name || name === "null" || name === "undefined") return;
                var s = settings(), a = ["--save-preset", name, "--presets-only"];
                if (s.crf) a.push("--crf", String(s.crf));
                if (s.fps) a.push("--fps", String(s.fps));
                if (s.scale && s.scale < 100) a.push("--scale", String(s.scale));
                // Same convention as settingArgs(): sent only when it differs from H.264.
                // Omitting it does NOT leave the preset silent about the encoder — the
                // engine records vcodec_of(args), which resolves an absent --vcodec to
                // libx264, so a preset always names one.
                if (s.vcodec && s.vcodec !== "libx264") a.push("--vcodec", s.vcodec);
                runJson(a, function () {
                    loadPresets(function () {
                        el.preset.value = name;
                        el.delpreset.disabled = false;
                    });
                });
            });
    });
    el.delpreset.addEventListener("click", function () {
        var name = el.preset.value;
        if (!name) return;
        runJson(["--delete-preset", name, "--presets-only"], function () {
            el.preset.value = "";
            loadPresets();
        });
    });

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
        // Remembered the same way, and for the same reason: it is a property of how he works
        // rather than of this timeline. The TRACK part of it is re-checked against each
        // timeline in renderAudioTracks(), because A2 on one project is not A2 on the next.
        loadAudioWant();
        try {
            el.wholeframes.checked = !!window.localStorage.getItem("xmlcut.wholeframes");
        } catch (e) { el.wholeframes.checked = false; }
        /* Remembered across sessions, like the audio choice and for the same reason: it is
         * a property of how he works, not of this one timeline. The track number is kept
         * too but re-validated against whatever gets read — V3 on the last project may not
         * exist on this one, and renderVideoTracks() falls back to the lowest track. */
        try {
            state.cutFrom = window.localStorage.getItem("xmlcut.cutfrom") === "render"
                ? "render" : "source";
        } catch (e) { state.cutFrom = "source"; }
        try {
            state.vtrackWant = window.localStorage.getItem("xmlcut.vtrack") || "";
        } catch (e) { state.vtrackWant = ""; }
        /* Default ON. The overlays being baked in was reported as a bug, so the useful
         * default is the one that does not do it — but the choice is remembered, because
         * a timeline whose upper track is an adjustment layer wants the opposite. */
        try {
            state.vIncludeWant = window.localStorage.getItem("xmlcut.vinclude") || "";
        } catch (e) { state.vIncludeWant = ""; }
        applyCutFrom();
        restoreSettings();
        renderSettings();
        if (state.script) loadPresets();
        wireTips();
        // Off the critical path: a slow or absent network must never delay the panel.
        if (state.script) checkUpdate(false);
        // Deliberately does NOT read on open. Reading exports an XML as a side effect,
        // and a panel that writes files the moment it appears is a panel you cannot
        // trust to sit open while you work. Step 1 is a button.
    }
})();
