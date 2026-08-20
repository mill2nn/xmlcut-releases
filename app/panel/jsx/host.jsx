/*
 * Raw-cutter — dump the ACTIVE Premiere sequence to JSON.
 *
 * Read-only. Nothing in the project is modified, nothing is rendered. The only
 * side effect is a timestamped .json written beside the Premiere project, under
 * xmlcut/<Sequence Name>/.
 *
 * Why this exists: an FCP7 XML export records what Premiere *believed* about each
 * clip, flattened. Asking Premiere directly gets three things the XML cannot carry:
 *
 *   1. Time Remapping KEYFRAMES — the XML gives one speed value per clip, which
 *      cannot describe a clip whose speed changes across itself.
 *   2. The INTERPRETED frame rate — what the edit is actually built on, which is
 *      not always the rate stored in the file.
 *   3. Real media paths, with no path-drift remapping needed.
 *
 * ExtendScript is ES3: no JSON.stringify, no Array.forEach, no String.trim. Every
 * host call is wrapped, because the API surface varies across Premiere versions and
 * one missing method must not cost the whole dump.
 */

/* Premiere's tick base. Identical to xmlcut's PPRO_TICKS_PER_SECOND, which is how
 * the two can be compared at all. */
var TICKS_PER_SECOND = 254016000000;

/* ---------------------------------------------------------------- JSON out */

function jesc(s) {
    s = String(s);
    var out = "", ch, code, h, i;
    for (i = 0; i < s.length; i++) {
        ch = s.charAt(i);
        code = s.charCodeAt(i);
        if (ch === '"') out += '\\"';
        else if (ch === '\\') out += '\\\\';
        else if (ch === '\n') out += '\\n';
        else if (ch === '\r') out += '\\r';
        else if (ch === '\t') out += '\\t';
        // Everything outside printable ASCII is escaped, so a Vietnamese filename
        // survives regardless of what encoding the file ends up written in.
        else if (code < 32 || code > 126) {
            h = code.toString(16);
            while (h.length < 4) h = "0" + h;
            out += "\\u" + h;
        } else out += ch;
    }
    return '"' + out + '"';
}

function ser(v) {
    var i, parts, k;
    if (v === null || v === undefined) return "null";
    var t = typeof v;
    if (t === "boolean") return v ? "true" : "false";
    if (t === "number") return isFinite(v) ? String(v) : "null";
    if (t === "string") return jesc(v);
    if (v instanceof Array) {
        parts = [];
        for (i = 0; i < v.length; i++) parts.push(ser(v[i]));
        return "[" + parts.join(",") + "]";
    }
    if (t === "object") {
        parts = [];
        for (k in v) {
            if (v.hasOwnProperty(k)) parts.push(jesc(k) + ":" + ser(v[k]));
        }
        return "{" + parts.join(",") + "}";
    }
    return jesc(String(v));
}

/* ------------------------------------------------------------ safe reading */

/* Read a property that may not exist on this Premiere version. Returns fallback
 * rather than throwing, so a dump from an older host is still usable. */
function get(obj, name, fallback) {
    try {
        if (obj === null || obj === undefined) return fallback;
        var v = obj[name];
        if (v === undefined || v === null) return fallback;
        return v;
    } catch (e) {
        return fallback;
    }
}

/* Call a zero-argument method that may not exist. */
function call(obj, name, fallback) {
    try {
        if (obj === null || obj === undefined) return fallback;
        if (typeof obj[name] !== "function") return fallback;
        var v = obj[name]();
        if (v === undefined || v === null) return fallback;
        return v;
    } catch (e) {
        return fallback;
    }
}

/* A Premiere Time comes back as an object with .ticks (a STRING, because the
 * numbers exceed float precision) and .seconds. Keep the string verbatim — it is
 * the exact value, and parsing it here would throw away the precision that makes
 * this whole comparison worth doing. */
function timeObj(t) {
    if (t === null || t === undefined) return null;
    var ticks = get(t, "ticks", null);
    var secs = get(t, "seconds", null);
    return {
        ticks: ticks === null ? null : String(ticks),
        seconds: secs === null ? null : Number(secs)
    };
}

/* ------------------------------------------------------- time remap reader */

function looksLikeTimeRemap(displayName, matchName) {
    var d = String(displayName === null ? "" : displayName).toLowerCase();
    var m = String(matchName === null ? "" : matchName).toLowerCase();
    return d.indexOf("time remap") >= 0 || d.indexOf("timeremap") >= 0
        || m.indexOf("time remap") >= 0 || m.indexOf("timeremap") >= 0;
}

/* Pull the keyframes off one parameter, if it has any.
 *
 * This is the reason the panel exists, so it reports HOW it failed rather than
 * going quiet: if getKeys() is unavailable on this version we want to see that in
 * the dump, not infer it from an absence. */
function readParam(prop) {
    var out = { name: String(get(prop, "displayName", "?")) };
    var supported = call(prop, "areKeyframesSupported", null);
    out.keyframes_supported = (supported === true || supported === 1);

    var varying = call(prop, "isTimeVarying", null);
    out.time_varying = (varying === true || varying === 1);

    try {
        var v = prop.getValue();
        if (typeof v === "number" || typeof v === "string"
            || typeof v === "boolean") out.value = v;
        else out.value = String(v);
    } catch (e) {
        out.value = null;
        out.value_error = String(e);
    }

    if (out.keyframes_supported && out.time_varying) {
        try {
            var keys = prop.getKeys();
            out.keys = [];
            if (keys) {
                for (var i = 0; i < keys.length; i++) {
                    var kt = timeObj(keys[i]);
                    var kv = null;
                    try {
                        kv = prop.getValueAtKey(keys[i]);
                        if (!(typeof kv === "number" || typeof kv === "string"
                              || typeof kv === "boolean")) kv = String(kv);
                    } catch (e2) {
                        kv = null;
                    }
                    out.keys.push({ time: kt, value: kv });
                }
            }
        } catch (e3) {
            out.keys = null;
            out.keys_error = String(e3);
        }
    }
    return out;
}

/* Every component's NAME is recorded, but full parameter detail only for time
 * remapping. Dumping every param of Motion and Opacity on every clip would bury
 * the one thing being looked for and make the file enormous. */
function readComponents(clip) {
    var list = [];
    var comps = get(clip, "components", null);
    if (!comps) return list;
    var n = Number(get(comps, "numItems", 0));
    for (var i = 0; i < n; i++) {
        var entry;
        try {
            var comp = comps[i];
            var dn = get(comp, "displayName", "");
            var mn = get(comp, "matchName", "");
            entry = { displayName: String(dn), matchName: String(mn) };
            if (looksLikeTimeRemap(dn, mn)) {
                entry.is_time_remap = true;
                entry.params = [];
                var props = get(comp, "properties", null);
                var pn = Number(get(props, "numItems", 0));
                for (var p = 0; p < pn; p++) {
                    try {
                        entry.params.push(readParam(props[p]));
                    } catch (ep) {
                        entry.params.push({ name: "?", error: String(ep) });
                    }
                }
            }
        } catch (e) {
            entry = { displayName: "?", error: String(e) };
        }
        list.push(entry);
    }
    return list;
}

/* ------------------------------------------------------------ clip reading */

function readClip(clip, trackIndex, trackType) {
    var out = { track_index: trackIndex, track_type: trackType };
    try {
        out.name = String(get(clip, "name", ""));
        out.media_type = String(get(clip, "mediaType", ""));

        /* Timeline placement. */
        out.start = timeObj(get(clip, "start", null));
        out.end = timeObj(get(clip, "end", null));
        out.duration = timeObj(get(clip, "duration", null));

        /* Source range — the tick values that must match pproTicksIn/Out. */
        out.in_point = timeObj(get(clip, "inPoint", null));
        out.out_point = timeObj(get(clip, "outPoint", null));

        /* Speed. getSpeed() returns a multiplier (1.2 == 120%), not a percent. */
        var sp = call(clip, "getSpeed", null);
        out.speed = (sp === null) ? null : Number(sp);
        var rev = call(clip, "isSpeedReversed", null);
        out.reversed = (rev === true || rev === 1);

        out.disabled = (get(clip, "disabled", false) === true);
        out.selected = (get(clip, "isSelected", null) === true
                        || call(clip, "isSelected", false) === true);
        out.is_adjustment_layer = (call(clip, "isAdjustmentLayer", false) === true);

        /* Source media, straight from Premiere — no pathurl decoding, no remap. */
        var pi = get(clip, "projectItem", null);
        if (pi) {
            out.project_item = {
                name: String(get(pi, "name", "")),
                node_id: String(get(pi, "nodeId", "")),
                type: Number(get(pi, "type", -1)),
                media_path: String(call(pi, "getMediaPath", "")),
                is_sequence: (call(pi, "isSequence", false) === true),
                is_offline: (call(pi, "isOffline", false) === true),
                is_multicam: (call(pi, "isMulticamClip", false) === true)
            };

            /* The interpreted rate: what the EDIT is built on. A file shot at 24
             * and interpreted as 23.976 has one rate on disk and another here, and
             * the second one is the one Premiere cut against. */
            var fi = call(pi, "getFootageInterpretation", null);
            if (fi) {
                out.interpretation = {
                    frame_rate: Number(get(fi, "frameRate", 0)),
                    pixel_aspect_ratio: Number(get(fi, "pixelAspectRatio", 0)),
                    field_type: Number(get(fi, "fieldType", -1)),
                    remove_pulldown: (get(fi, "removePulldown", false) === true),
                    alpha_usage: Number(get(fi, "alphaUsage", -1))
                };
            }
        }

        out.components = readComponents(clip);

        /* A convenience flag so the comparison does not have to re-derive it. */
        out.has_keyframed_remap = false;
        for (var i = 0; i < out.components.length; i++) {
            var c = out.components[i];
            if (c.is_time_remap && c.params) {
                for (var p = 0; p < c.params.length; p++) {
                    if (c.params[p].time_varying && c.params[p].keys
                        && c.params[p].keys.length > 1) {
                        out.has_keyframed_remap = true;
                    }
                }
            }
        }
    } catch (e) {
        out.error = String(e);
    }
    return out;
}

/* ------------------------------------------------------------------- entry */

/* ------------------------------------------------------ where files go */

function two(n) { return (n < 10 ? "0" : "") + n; }

/* Sortable, and it says when. Same stamp for the .json and the .xml of one read, so
 * the pair is obviously a pair. */
function stampNow() {
    var d = new Date();
    return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate())
         + "_" + two(d.getHours()) + two(d.getMinutes()) + two(d.getSeconds());
}

/* A sequence name becomes a folder name, so it has to survive being one.
 *
 * "/" is illegal in a path component, and ":" is worse than illegal — HFS lets it
 * through but Finder renders it as "/", so a folder called "v2.0: final" appears as
 * something else entirely. Both are replaced rather than stripped, so two sequences
 * differing only there do not collapse into one folder. */
function safeName(s) {
    s = String(s === null || s === undefined ? "" : s);
    var out = "", c, ch;
    for (var i = 0; i < s.length; i++) {
        ch = s.charAt(i);
        c = s.charCodeAt(i);
        if (c < 32) continue;                       // control characters
        // "\" joins "/" and ":" here. It is legal in a macOS name but it is an escape
        // character everywhere this path is subsequently quoted, and it turned a folder
        // called "Cut\Final" into a write to a path that did not exist.
        else if (ch === "/" || ch === ":" || ch === "\\") out += "-";
        else out += ch;
    }
    // A trailing dot or space makes a folder that some tools cannot address.
    out = out.replace(/^[\s.]+/, "").replace(/[\s.]+$/, "");
    if (!out) out = "Untitled Sequence";
    if (out.length > 80) out = out.substring(0, 80);
    return out;
}

/* Folder.create() is not reliably recursive, so walk the components. */
function ensureFolder(pathStr) {
    var parts = String(pathStr).split("/");
    var acc = "";
    var f = null;
    for (var i = 0; i < parts.length; i++) {
        if (parts[i] === "") {
            acc = "";        // leading slash: keep building from root
            continue;
        }
        acc = acc + "/" + parts[i];
        f = new Folder(acc);
        if (!f.exists && !f.create()) return null;
    }
    return f;
}

/* Next to the PROJECT, one folder per sequence:
 *
 *     <project folder>/xmlcut/<Sequence Name>/2026-08-12_134500.xml
 *
 * Under an `xmlcut` container rather than loose beside the .prproj, because a project
 * with twenty sequences would otherwise drop twenty folders into the edit directory.
 *
 * An unsaved project has no path to be next to, so that falls back to the Desktop. */
function readFolderFor(seqName) {
    var base = null;
    try {
        var p = app.project.path;
        if (p) {
            var pf = new File(p);
            if (pf.parent && pf.parent.exists) base = pf.parent;
        }
    } catch (e) {
        base = null;
    }
    var root = base ? (base.fsName + "/xmlcut")
                    : (Folder.desktop.fsName + "/xmlcut-dumps");
    return {
        path: root + "/" + safeName(seqName),
        beside_project: !!base
    };
}

/* Keep the newest KEEP_READS pairs and delete the rest.
 *
 * A new pair per read is what was asked for, but this folder can sit on a shared drive,
 * where every read syncs ~1 MB to the whole team and nothing ever prunes it. Names are
 * sortable timestamps, so "newest" is a string sort. Only files matching the exact
 * stamp pattern are considered — never anything else that happens to be in there. */
var KEEP_READS = 10;

function pruneOldReads(dir) {
    var removed = 0;
    try {
        var files = dir.getFiles(function (f) {
            return (f instanceof File)
                && /^\d{4}-\d{2}-\d{2}_\d{6}\.(json|xml)$/.test(f.name);
        });
        if (!files || files.length === 0) return 0;

        // Collect the distinct stamps, newest first.
        var stamps = [], seen = {}, i, st;
        for (i = 0; i < files.length; i++) {
            st = files[i].name.substring(0, 17);
            if (!seen[st]) { seen[st] = true; stamps.push(st); }
        }
        stamps.sort();
        stamps.reverse();
        if (stamps.length <= KEEP_READS) return 0;

        var doomed = {};
        for (i = KEEP_READS; i < stamps.length; i++) doomed[stamps[i]] = true;
        for (i = 0; i < files.length; i++) {
            if (doomed[files[i].name.substring(0, 17)]) {
                try { if (files[i].remove()) removed++; } catch (e) {}
            }
        }
    } catch (e) {
        return 0;
    }
    return removed;
}

/* ----------------------------------------------------------- XML export */

/* Export the active sequence as Final Cut Pro 7 XML.
 *
 * Which method exists depends on the Premiere version, and none of this could be
 * tested from outside Premiere — so every known spelling is tried in turn and the
 * one that produced a file is reported back. A silent "maybe it worked" here would
 * mean cutting from a stale XML, so the file is checked for existence and size
 * rather than trusting a return value.
 *
 * Sequence-level export is preferred: it writes ONLY this sequence, which is what
 * makes the multi-sequence picker unnecessary.
 */
function exportSequenceXML(destPath) {
    var result = { ok: false, tried: [] };
    try {
        var seq = app.project.activeSequence;
        if (!seq) {
            result.error = "No active sequence.";
            return ser(result);
        }

        var target = new File(destPath);
        if (target.exists) {
            try { target.remove(); } catch (eRm) {}
        }

        function produced() {
            var f = new File(destPath);
            return f.exists && f.length > 0;
        }

        var attempts = [
            ["sequence.exportAsFinalCutProXML", function () {
                return seq.exportAsFinalCutProXML(destPath, 1);
            }],
            ["sequence.exportAsFinalCutProXML(no suppress)", function () {
                return seq.exportAsFinalCutProXML(destPath);
            }],
            ["project.exportFinalCutProXML", function () {
                return app.project.exportFinalCutProXML(destPath, 1);
            }],
            ["project.exportFinalCutProXML(no suppress)", function () {
                return app.project.exportFinalCutProXML(destPath);
            }]
        ];

        for (var i = 0; i < attempts.length; i++) {
            var name = attempts[i][0];
            try {
                attempts[i][1]();
                if (produced()) {
                    result.ok = true;
                    result.method = name;
                    result.path = new File(destPath).fsName;
                    result.bytes = new File(destPath).length;
                    result.tried.push(name + ": wrote the file");
                    return ser(result);
                }
                result.tried.push(name + ": returned without writing a file");
            } catch (e) {
                result.tried.push(name + ": " + String(e));
            }
        }
        result.error = "Premiere would not export an XML by any known method.";
    } catch (e) {
        result.error = String(e);
    }
    return ser(result);
}

/* ---------------------------------------------------- locating xmlcut.py */

/* Search for xmlcut.py from inside Premiere.
 *
 * The panel's own Node-side search can come back empty for a file that plainly
 * exists: ~/Desktop and ~/Documents are TCC-protected on modern macOS, and until
 * Premiere is granted Files-and-Folders access, a stat from the panel simply says no.
 * This is a second opinion through Adobe's own File/Folder API, and — more useful than
 * either result — it reports every path it looked at so the failure is diagnosable
 * instead of a shrug.
 *
 * Returns {home, found, tried[]}. */
function findXmlcut() {
    var result = { home: "", found: "", tried: [] };
    try {
        try {
            result.home = new Folder("~").fsName;
        } catch (eh) {
            result.home = "";
        }

        var roots = [];
        function addRoot(p) {
            try {
                var f = new Folder(p);
                if (f.exists) roots.push(f);
            } catch (e) {}
        }
        addRoot("~/Desktop");
        addRoot("~");
        addRoot("~/Documents");
        addRoot("~/Movies");
        addRoot("~/Downloads");

        function check(path) {
            result.tried.push(path);
            try {
                var f = new File(path);
                if (f.exists) {
                    result.found = f.fsName;
                    return true;
                }
            } catch (e) {}
            return false;
        }

        // The conventional spot under each root first.
        for (var i = 0; i < roots.length; i++) {
            if (check(roots[i].fsName + "/xmlcut/xmlcut.py")) return ser(result);
        }
        // Then one level down, so a folder called anything still turns up.
        for (var r = 0; r < roots.length; r++) {
            var subs;
            try {
                subs = roots[r].getFiles(function (f) { return f instanceof Folder; });
            } catch (eg) {
                continue;
            }
            if (!subs) continue;
            for (var k = 0; k < subs.length && k < 60; k++) {
                if (check(subs[k].fsName + "/xmlcut.py")) return ser(result);
            }
        }
    } catch (e) {
        result.error = String(e);
    }
    return ser(result);
}

/* A name prompt. CEP's own window.prompt is unreliable inside Premiere, so the ask goes
 * through ExtendScript, which has a real modal. Returns "" when cancelled. */
function askName(message) {
    try {
        var v = prompt(message, "");
        return (v === null || v === undefined) ? "" : String(v);
    } catch (e) {
        return "";
    }
}

/* --------------------------------------------------------------- pickers */

/* Native folder chooser. Returns "" when cancelled — the panel treats that as
 * "keep what you had", never as "clear it". */
function pickFolder(current) {
    try {
        var start = null;
        if (current) {
            var f = new Folder(current);
            if (f.exists) start = f;
        }
        var chosen = (start ? start : Folder.desktop).selectDlg("Where should the clips go?");
        return chosen ? chosen.fsName : "";
    } catch (e) {
        return "";
    }
}

/* Locate xmlcut.py when it is not where the panel guessed. */
function pickScript() {
    try {
        var f = File.openDialog("Find xmlcut.py", function (x) {
            return (x instanceof Folder) || x.name === "xmlcut.py";
        });
        return f ? f.fsName : "";
    } catch (e) {
        return "";
    }
}

/* Reveal the panel's own guess at where things live, so the UI can prefill. */
function defaultOutputFolder() {
    try {
        return Folder.desktop.fsName + "/xmlcut clips";
    } catch (e) {
        return "";
    }
}

function dumpActiveSequence() {
    var result = { ok: false };
    try {
        if (!app || !app.project) {
            result.error = "No project open.";
            return ser(result);
        }
        var seq = app.project.activeSequence;
        if (!seq) {
            result.error = "No active sequence — open a timeline first.";
            return ser(result);
        }

        var timebase = Number(get(seq, "timebase", 0));
        var data = {
            generator: "xmlcut reader",
            format_version: 1,
            premiere_version: String(get(app, "version", "")),
            project_name: String(get(app.project, "name", "")),
            project_path: String(get(app.project, "path", "")),
            sequence: {
                name: String(get(seq, "name", "")),
                id: String(get(seq, "sequenceID", "")),
                timebase_ticks_per_frame: timebase,
                /* fps from the tick base, which is exact, rather than a float the
                 * settings object may have rounded. */
                fps: timebase > 0 ? (TICKS_PER_SECOND / timebase) : 0,
                frame_width: Number(get(seq, "frameSizeHorizontal", 0)),
                frame_height: Number(get(seq, "frameSizeVertical", 0)),
                end: timeObj(get(seq, "end", null)),
                in_point: timeObj(call(seq, "getInPoint", null)),
                out_point: timeObj(call(seq, "getOutPoint", null))
            },
            ticks_per_second: TICKS_PER_SECOND,
            clips: []
        };

        var kinds = [["video", get(seq, "videoTracks", null)],
                     ["audio", get(seq, "audioTracks", null)]];
        for (var k = 0; k < kinds.length; k++) {
            var kind = kinds[k][0], tracks = kinds[k][1];
            if (!tracks) continue;
            var nt = Number(get(tracks, "numTracks", 0));
            for (var t = 0; t < nt; t++) {
                var track = tracks[t];
                var clips = get(track, "clips", null);
                if (!clips) continue;
                var nc = Number(get(clips, "numItems", 0));
                for (var c = 0; c < nc; c++) {
                    data.clips.push(readClip(clips[c], t + 1, kind));
                }
            }
        }

        /* Write from ExtendScript rather than handing a large string back across
         * the CEP boundary, which is slow and has truncated on big sequences. */
        var place = readFolderFor(data.sequence.name);
        var dir = ensureFolder(place.path);
        if (!dir) {
            result.error = "Could not create " + place.path
                + "\nCheck the project folder is writable.";
            return ser(result);
        }
        var stamp = stampNow();
        var out = new File(dir.fsName + "/" + stamp + ".json");
        out.encoding = "UTF-8";
        if (!out.open("w")) {
            result.error = "Could not write " + out.fsName;
            return ser(result);
        }
        out.write(ser(data));
        out.close();

        var vids = 0, ramps = 0;
        for (var i = 0; i < data.clips.length; i++) {
            if (data.clips[i].track_type === "video") vids++;
            if (data.clips[i].has_keyframed_remap) ramps++;
        }
        result.ok = true;
        result.path = out.fsName;
        result.folder = dir.fsName;
        result.stamp = stamp;
        result.beside_project = place.beside_project;
        result.pruned = pruneOldReads(dir);
        result.keep_reads = KEEP_READS;
        result.sequence = data.sequence.name;
        // The sequence name made safe to be a folder. Returned so the panel can name the
        // export's subfolder without a second copy of this rule — safeName() already has
        // to exist here to name the read folder, and two implementations of "what is a
        // legal folder name" would drift.
        result.safe_name = safeName(data.sequence.name);
        result.fps = data.sequence.fps;
        // The sequence's own pixels. A render is made at these, not at any source clip's,
        // so the panel needs them to work out what bitrate a quality setting asks for.
        result.frame_width = data.sequence.frame_width;
        result.frame_height = data.sequence.frame_height;
        result.clips = data.clips.length;
        result.video_clips = vids;
        result.keyframed_ramps = ramps;
    } catch (e) {
        result.error = String(e) + (e.line ? (" (line " + e.line + ")") : "");
    }
    return ser(result);
}

/* ==================================================== POC · rendering a range
 *
 * PROOF OF CONCEPT for "export with effects" — AI Product ask #3.
 *
 * The cutting path reads RAW SOURCE MEDIA, so nothing done on the timeline reaches
 * the output: no Lumetri, no Motion, no titles, no speed ramp. The only thing that
 * can bake those in is Premiere itself. This asks Premiere to render one in/out
 * range of the active sequence — the whole feature reduced to its one unknown.
 *
 * NOTHING HERE IS WIRED INTO AN EXPORT. It renders, it times, and it puts the
 * sequence's in/out points back exactly as it found them.
 *
 * Three questions it exists to answer, none of which can be settled by reading
 * Adobe's documentation:
 *
 *   1. Is exportAsMediaDirect callable at all in this Premiere? Every method is
 *      tried in turn and every attempt is reported, the same way exportSequenceXML
 *      handles four XML methods, because the DOM moves between versions.
 *   2. What does one export cost in FIXED overhead? At ~1s a cut, rendering each
 *      segment separately is obviously right. At ~15s, a 60-cut timeline is fifteen
 *      minutes of nothing and the architecture has to change. Two ranges of
 *      different lengths are rendered so the two costs can be told apart, and the
 *      first is rendered twice so a warm-up penalty shows up as itself.
 *   3. Does an in/out set in SECONDS land on the frame that was asked for? Both the
 *      requested and the stored tick counts come back, so this is measured rather
 *      than assumed.
 */

/* The H.264 exporter's directory is its four-CC pair: 'NICK' + 'H264'. Match Source
 * is what we want — it inherits the sequence's own resolution and frame rate, so
 * there is no size or rate decision to get wrong here. */
var H264_PRESET_DIR = "Contents/MediaIO/systempresets/4E49434B_48323634";
var PRESET_NAMES = [
    "00 - Match Source - High bitrate.epr",
    "01 - Match Source - High bitrate.epr",
    "00 - Match Source - Medium bitrate.epr",
    "01 - Match Source - Medium bitrate.epr"
];

/* The systempresets folder inside an application bundle, from any path within it.
 *
 * Pure string work, and separated out for that reason: it is the part that is easy to
 * get subtly wrong and the only part that can be checked outside Premiere. Accepts the
 * bundle itself or anything under it — Folder.startup points at Contents/MacOS, while
 * Folder.appPackage points at the .app. Returns "" for a path with no bundle in it. */
function presetDirFromAppPath(p) {
    p = String(p || "");
    var cut = p.indexOf(".app");
    if (cut < 0) return "";
    return p.substring(0, cut + 4) + "/" + H264_PRESET_DIR;
}

/* Open a folder whose path contains spaces.
 *
 * ExtendScript's Folder() takes either a URI or a platform path and the two disagree
 * about what a space is. Rather than deciding which this build wants, try both and
 * report which one answered — a wrong guess here reads as "the folder is not there". */
function openFolder(p) {
    var tries = [String(p)], f, i;
    try { tries.push(Folder.decode(String(p))); } catch (e) {}
    try { tries.push(encodeURI(String(p))); } catch (e) {}
    for (i = 0; i < tries.length; i++) {
        try {
            f = new Folder(tries[i]);
            if (f.exists) return f;
        } catch (e2) {}
    }
    return null;
}

/* Every place a stock H.264 preset might live, best first.
 *
 * ⚠️ THIS PREMIERE COMES FIRST, and is found without guessing at any path: we are
 * running inside it, so Folder.startup and Folder.appPackage point straight at the
 * bundle. Premiere ships the same Match Source presets Media Encoder does.
 *
 * That ordering is the fix for a real failure. The first version of this scanned
 * /Applications for a folder whose name began "Adobe Media Encoder" — and found
 * nothing on a machine that plainly had it, because a Folder's .name comes back URI
 * ESCAPED: the name being compared was "Adobe%20Media%20Encoder%202026". Looking
 * inside the host application needs no names at all, so it cannot fail that way. */
function presetRoots() {
    var roots = [], seen = {}, i, j, p;
    function add(path, why) {
        if (!path || seen[path]) return;
        seen[path] = 1;
        roots.push({ path: path, why: why });
    }

    var here = [];
    try { if (Folder.startup) here.push(Folder.startup.fsName); } catch (e) {}
    try { if (Folder.appPackage) here.push(Folder.appPackage.fsName); } catch (e) {}
    for (i = 0; i < here.length; i++) {
        p = presetDirFromAppPath(here[i]);
        if (p) add(p, "the running application");
    }

    /* Then any Adobe app in /Applications. Names are DECODED before they are compared,
     * which is the bug above; and an entry that is itself a bundle is accepted as well
     * as one that contains bundles, because both layouts exist. */
    try {
        var apps = new Folder("/Applications").getFiles();
        for (i = 0; i < (apps || []).length; i++) {
            var nm = String(apps[i].name);
            try { nm = decodeURI(nm); } catch (e3) {}
            if (nm.indexOf("Adobe Media Encoder") !== 0
                && nm.indexOf("Adobe Premiere Pro") !== 0) continue;
            if (nm.substring(nm.length - 4) === ".app") {
                add(apps[i].fsName + "/" + H264_PRESET_DIR, nm);
                continue;
            }
            var inner = null;
            try { inner = apps[i].getFiles("*.app"); } catch (e4) { inner = null; }
            for (j = 0; j < (inner || []).length; j++) {
                add(inner[j].fsName + "/" + H264_PRESET_DIR, nm);
            }
        }
    } catch (e5) {}
    return roots;
}

/* Locate a Match Source H.264 preset.
 *
 * Returns {found, name, tried[]}. `tried` lists every folder looked in and what was
 * there, because "no preset" and "looked in the wrong place" are indistinguishable
 * otherwise — which is exactly how the previous version wasted a round trip. */
function findRenderPreset() {
    var res = { found: "", name: "", tried: [] };
    var roots = presetRoots();
    var i, j, w;
    for (i = 0; i < roots.length; i++) {
        var dir = openFolder(roots[i].path);
        if (!dir) {
            res.tried.push("not there (" + roots[i].why + "): " + roots[i].path);
            continue;
        }
        var eprs = null;
        try { eprs = dir.getFiles("*.epr"); } catch (e) { eprs = null; }
        if (!eprs || !eprs.length) {
            res.tried.push("no .epr in " + dir.fsName);
            continue;
        }
        /* Matched on the DECODED name for the same reason as above: "00 - Match Source
         * - High bitrate.epr" arrives as "00%20-%20Match%20Source%20-%20High...". */
        for (w = 0; w < PRESET_NAMES.length; w++) {
            for (j = 0; j < eprs.length; j++) {
                var nm = String(eprs[j].name);
                try { nm = decodeURI(nm); } catch (e6) {}
                if (nm === PRESET_NAMES[w]) {
                    res.found = eprs[j].fsName;
                    res.name = nm;
                    res.tried.push("found " + nm + " in " + dir.fsName);
                    return res;
                }
            }
        }
        res.tried.push("none of the Match Source presets among " + eprs.length
            + " .epr file(s) in " + dir.fsName);
    }
    if (!roots.length) {
        res.tried.push("no candidate preset folder could be worked out at all — "
            + "neither Folder.startup nor /Applications gave one");
    }
    return res;
}


/* The sequence's in/out as exact TICKS.
 *
 * getInPointAsTime() carries ticks and is exact. getInPoint() carries seconds and is
 * a lossy second choice, so which one answered is reported alongside the numbers —
 * a tick count derived from a float should not be read as if it were measured. */
function rangeTicks(seq) {
    var out = { in_ticks: null, out_ticks: null, how: "" };
    var a = call(seq, "getInPointAsTime", null);
    var b = call(seq, "getOutPointAsTime", null);
    if (a && get(a, "ticks", null) !== null) {
        out.in_ticks = String(get(a, "ticks", ""));
        out.out_ticks = b ? String(get(b, "ticks", "")) : null;
        out.how = "getInPointAsTime (exact)";
        return out;
    }
    var s = call(seq, "getInPoint", null);
    var e = call(seq, "getOutPoint", null);
    if (s !== null && s !== undefined) {
        out.in_ticks = String(Math.round(Number(s) * TICKS_PER_SECOND));
        out.out_ticks = (e === null || e === undefined)
            ? null : String(Math.round(Number(e) * TICKS_PER_SECOND));
        out.how = "getInPoint (seconds, derived)";
    }
    return out;
}

/* Set the in/out points, and PROVE they took.
 *
 * ⚠️ THIS IS THE ONE THAT BIT. The first version tried two argument forms, treated "did
 * not throw" as success, and rendered. setInPoint accepted the value, did nothing with
 * it, and every range came out as the WHOLE SEQUENCE — seventeen times, each one a full
 * timeline render that then got trimmed to a cut's length, so every clip was the opening
 * shot. The read-back that would have caught it on the first range was already being
 * performed, recorded in the result, and never looked at.
 *
 * So: every form is tried, and after each one the points are READ BACK and compared with
 * what was asked for. A form that does nothing fails the comparison and the next is
 * tried. If none of them moves the in-point, nothing is rendered at all.
 *
 * If the points cannot be read back, that is also a failure. Rendering a range we cannot
 * confirm is precisely what produced seventeen wrong files.
 *
 * Returns {ok, how, tried[], got}. Tolerance is half a frame, because getInPoint() may
 * only be able to answer in seconds and a tick count derived from a float will not land
 * exactly. */
function setRange(seq, inTicks, outTicks, timebase) {
    var tried = [];
    var inSec = inTicks / TICKS_PER_SECOND;
    var outSec = outTicks / TICKS_PER_SECOND;
    var tol = Math.max(1, timebase / 2);

    function timeAt(ticks) {
        var t = new Time();
        t.ticks = String(ticks);
        return t;
    }

    var forms = [
        ["seconds (number)", function () {
            seq.setInPoint(inSec);
            seq.setOutPoint(outSec);
        }],
        ["seconds (string)", function () {
            seq.setInPoint(String(inSec));
            seq.setOutPoint(String(outSec));
        }],
        ["Time object", function () {
            seq.setInPoint(timeAt(inTicks));
            seq.setOutPoint(timeAt(outTicks));
        }],
        ["ticks (string)", function () {
            seq.setInPoint(String(inTicks));
            seq.setOutPoint(String(outTicks));
        }]
    ];

    for (var i = 0; i < forms.length; i++) {
        try {
            forms[i][1]();
        } catch (e) {
            tried.push(forms[i][0] + ": " + String(e));
            continue;
        }
        var got = rangeTicks(seq);
        if (got.in_ticks === null || got.out_ticks === null) {
            tried.push(forms[i][0] + ": accepted, but the points could not be read back"
                + " — refusing to render a range that cannot be confirmed");
            continue;
        }
        var dIn = Math.abs(Number(got.in_ticks) - inTicks);
        var dOut = Math.abs(Number(got.out_ticks) - outTicks);
        if (dIn <= tol && dOut <= tol) {
            tried.push(forms[i][0] + ": took (in off by "
                + (dIn / timebase).toFixed(3) + " frame(s), out by "
                + (dOut / timebase).toFixed(3) + ")");
            return { ok: true, how: forms[i][0], tried: tried, got: got };
        }
        tried.push(forms[i][0] + ": accepted but did not move the points — asked for "
            + inTicks + ".." + outTicks + ", got " + got.in_ticks + ".."
            + got.out_ticks + " (" + (dIn / timebase).toFixed(1) + " and "
            + (dOut / timebase).toFixed(1) + " frames out)");
    }
    return { ok: false, how: "", tried: tried, got: null };
}

/* What actually landed on disk. The preset decides the container, so the extension
 * is whatever Premiere decided to append — asking for it back by name is the only
 * way to know a render happened at all. */
function producedRender(base) {
    var exts = ["", ".mp4", ".m4v", ".mov", ".mxf"];
    for (var i = 0; i < exts.length; i++) {
        var f = new File(base + exts[i]);
        if (f.exists && f.length > 0) return f;
    }
    return null;
}

/* Render ONE timeline range, timed. Returns a record of what was asked for, what
 * Premiere stored, which method worked and how long it took. */
function renderOneRange(seq, label, inFrames, outFrames, destDir, preset, timebase) {
    var r = {
        label: label, in_frames: inFrames, out_frames: outFrames,
        frames: outFrames - inFrames, ok: false, ms: 0, tried: []
    };
    var i, t;

    var inTicks = inFrames * timebase;
    var outTicks = outFrames * timebase;
    r.want_in_ticks = String(inTicks);
    r.want_out_ticks = String(outTicks);

    /* ⚠️ NOTHING IS RENDERED UNTIL THE RANGE IS CONFIRMED. setRange reads the points
     * back and only reports success when they actually moved to where they were asked
     * to go — because "setInPoint did not throw" is what produced seventeen renders of
     * the whole timeline. `no_range` is flagged separately from an ordinary failure:
     * it is never one clip's problem, so the caller stops the run rather than repeating
     * it for every remaining cut. */
    var set = setRange(seq, inTicks, outTicks, timebase);
    r.set_how = set.how;
    for (t = 0; t < set.tried.length; t++) r.tried.push("set in/out: " + set.tried[t]);
    if (!set.ok) {
        r.no_range = true;
        r.error = "Premiere would not move the sequence's in/out points to this range,"
            + " so a render would have covered the whole timeline instead. Nothing was"
            + " rendered.";
        return r;
    }

    var got = set.got;
    r.got_in_ticks = got.in_ticks;
    r.got_out_ticks = got.out_ticks;
    r.read_how = got.how;
    r.in_off_frames = (Number(got.in_ticks) - inTicks) / timebase;
    r.out_off_frames = (Number(got.out_ticks) - outTicks) / timebase;

    /* Clear anything an earlier probe left at this name. Without this, a render
     * that fails finds the PREVIOUS run's file and reports it as a success — the
     * check reading the number the bug produced. */
    var base = destDir + "/" + label;
    var stale = producedRender(base);
    if (stale) {
        try { stale.remove(); } catch (eRm) {
            r.tried.push("could not remove the earlier " + stale.name
                + " — a stale file would be misread as this run's output");
            r.error = "Could not clear " + stale.fsName;
            return r;
        }
    }

    var attempts = [
        ["exportAsMediaDirect(in-to-out)", function () {
            return seq.exportAsMediaDirect(base, preset, 1);
        }],
        ["exportAsMediaDirect(ENCODE_IN_TO_OUT)", function () {
            return seq.exportAsMediaDirect(base, preset, app.encoder.ENCODE_IN_TO_OUT);
        }],
        ["encoder.encodeSequence (queues to AME)", function () {
            return app.encoder.encodeSequence(seq, base, preset, 1, 0);
        }]
    ];

    for (i = 0; i < attempts.length; i++) {
        var name = attempts[i][0];
        var t0 = new Date().getTime();
        try {
            attempts[i][1]();
        } catch (e) {
            r.tried.push(name + ": " + String(e));
            continue;
        }
        var ms = new Date().getTime() - t0;
        var f = producedRender(base);
        if (f) {
            r.ok = true;
            r.method = name;
            r.ms = ms;
            r.path = f.fsName;
            r.bytes = f.length;
            r.tried.push(name + ": wrote " + f.name + " in " + ms + " ms");
            return r;
        }
        /* encodeSequence hands the job to Media Encoder and returns immediately, so
         * "no file" here means queued, not failed. Saying so is the difference
         * between a useful result and a misleading one. */
        r.tried.push(name + ": returned in " + ms + " ms without writing a file"
            + (name.indexOf("encodeSequence") >= 0
                ? " — queued to Media Encoder, so any file appears later" : ""));
    }
    r.error = "Premiere would not render a range by any known method.";
    return r;
}

/* Parse the panel's range list: "label|inFrames|outFrames;label|inFrames|outFrames".
 * A delimited string rather than JSON because ExtendScript is ES3 and has no parser,
 * and eval on a built string is a worse trade than splitting on two characters. */
function parseRangeSpec(spec) {
    var out = [];
    var recs = String(spec || "").split(";");
    for (var i = 0; i < recs.length; i++) {
        if (!recs[i]) continue;
        var f = recs[i].split("|");
        if (f.length < 3) continue;
        var a = Math.round(Number(f[1])), b = Math.round(Number(f[2]));
        if (!isFinite(a) || !isFinite(b) || b <= a) continue;
        out.push({
            label: safeName(f[0] || ("range_" + (i + 1))),
            in_frames: a,
            out_frames: b
        });
    }
    return out;
}

/* The probe itself. Renders the given ranges, then the first one a second time so a
 * warm-up penalty is visible as its own number rather than inflating the average.
 *
 * The sequence's in/out points are read first and written back last, whatever
 * happens in between. */
function probeRender(destFolder, spec, mbps, onePass) {
    var res = { ok: false, renders: [], tried: [] };
    var i;
    try {
        if (!app || !app.project) {
            res.error = "No project open.";
            return ser(res);
        }
        var seq = app.project.activeSequence;
        if (!seq) {
            res.error = "No active sequence — open a timeline first.";
            return ser(res);
        }

        var timebase = Number(get(seq, "timebase", 0));
        if (!timebase) {
            res.error = "Premiere did not report a timebase for this sequence.";
            return ser(res);
        }
        res.sequence = String(get(seq, "name", ""));
        res.timebase = timebase;
        res.fps = TICKS_PER_SECOND / timebase;
        res.premiere_version = String(get(app, "version", ""));

        var pre = findRenderPreset();
        for (i = 0; i < pre.tried.length; i++) res.tried.push("preset: " + pre.tried[i]);
        if (!pre.found) {
            res.error = "No Match Source H.264 preset found. Media Encoder ships one;"
                + " without it Premiere has nothing to render with.";
            return ser(res);
        }
        res.preset = pre.found;
        res.preset_name = pre.name;
        res.warnings = [];

        var dir = ensureFolder(destFolder);
        if (!dir) {
            res.error = "Could not create " + destFolder;
            return ser(res);
        }
        res.folder = dir.fsName;

        /* A preset at the quality the slider is set to.
         *
         * Falling back to the stock one rather than failing: a 10 Mbps intermediate still
         * produces valid clips, so this is a quality shortfall and not a correctness one,
         * and stopping an export over it would be out of proportion. But it is carried
         * into the run's own notes — a render quietly made at a bitrate nobody chose is
         * exactly the kind of thing that never gets noticed. */
        if (Number(mbps) > 0) {
            var gen = writeRenderPreset(dir.fsName, mbps, onePass);
            for (i = 0; i < gen.tried.length; i++) res.tried.push("preset: " + gen.tried[i]);
            if (gen.ok) {
                pre = { found: gen.path, name: eprNumber(gen.target) + " Mbps" };
                res.preset = gen.path;
                res.preset_name = pre.name + " (built from the quality setting)";
                res.bitrate = { target: gen.target, max: gen.max, min: gen.min,
                                pass: gen.pass, base: gen.base };
            } else {
                res.warnings.push("could not build a render preset at the chosen quality ("
                    + (gen.error || "unknown") + ") — rendered at the stock "
                    + pre.name + " instead");
            }
        }

        var before = rangeTicks(seq);
        res.in_out_before = before;

        var ranges = parseRangeSpec(spec);
        if (!ranges.length) {
            /* Nothing handed over: fall back to two ranges from the sequence start,
             * 2s and 4s, which still answers the overhead question. */
            var fps = res.fps || 25;
            ranges = [
                { label: "probe_2s", in_frames: 0, out_frames: Math.round(fps * 2) },
                { label: "probe_4s", in_frames: 0, out_frames: Math.round(fps * 4) }
            ];
            res.tried.push("no ranges given — probing 2s and 4s from the sequence start");
        }

        for (i = 0; i < ranges.length; i++) {
            res.renders.push(renderOneRange(seq, "poc_" + (i + 1) + "_" + ranges[i].label,
                ranges[i].in_frames, ranges[i].out_frames,
                dir.fsName, pre.found, timebase));
        }
        /* The same range again. Two timings for identical work separate a one-off
         * warm-up from the per-export cost that matters. */
        if (ranges.length) {
            var again = renderOneRange(seq, "poc_repeat_" + ranges[0].label,
                ranges[0].in_frames, ranges[0].out_frames,
                dir.fsName, pre.found, timebase);
            again.is_repeat_of = 0;
            res.renders.push(again);
        }

        /* Put the timeline back. Tung's one condition on this whole feature was that
         * the timeline stays intact. */
        res.restored = false;
        if (before.in_ticks !== null && before.out_ticks !== null) {
            var back = setRange(seq, Number(before.in_ticks),
                                Number(before.out_ticks), timebase);
            res.restored = back.ok;
            res.in_out_after = rangeTicks(seq);
            if (!back.ok) res.tried.push("restoring in/out: " + back.tried.join(" · "));
        } else {
            res.tried.push("in/out could not be read before the probe, so it was left"
                + " where the last render put it");
        }

        var wrote = 0;
        for (i = 0; i < res.renders.length; i++) if (res.renders[i].ok) wrote++;
        res.ok = wrote > 0;
        res.written = wrote;
        if (!res.ok) {
            res.error = "Premiere rendered nothing. The attempts are listed below.";
        }
    } catch (e) {
        res.error = String(e) + (e.line ? (" (line " + e.line + ")") : "");
    }
    return ser(res);
}

/* =============================================== rendering every cut for export
 *
 * The export path for "with effects". Same machinery the probe uses, run over the
 * whole picked cut list instead of two samples.
 *
 * Each range is written as TRACKTYPE-TRACKINDEX-TIMELINEIN-TIMELINEOUT.mp4 — the same
 * four fields that identify a cut to --pick, to the progress lines and to the panel's
 * own rows. xmlcut.py looks for exactly that name, so neither side needs to be told
 * which file belongs to which cut. The OUT-POINT is in there because a cross-dissolve
 * puts two cuts on one track at the same in-point, and without it they asked for one
 * file between them.
 *
 * A PROGRESS FILE is written after every render, because exportAsMediaDirect blocks
 * until it finishes and one evalScript over sixty cuts would otherwise say nothing
 * at all for minutes. The panel reads it off disk while this loop runs.
 */

function writeRenderProgress(file, done, total, current, failed) {
    try {
        file.encoding = "UTF-8";
        if (!file.open("w")) return;
        file.write(ser({ done: done, total: total, current: String(current || ""),
                         failed: failed }));
        file.close();
    } catch (e) {}
}

function renderCuts(destFolder, spec, mbps, onePass, keepTracks) {
    var res = { ok: false, renders: [], tried: [], written: 0, failed: 0 };
    var i;
    try {
        if (!app || !app.project) {
            res.error = "No project open.";
            return ser(res);
        }
        var seq = app.project.activeSequence;
        if (!seq) {
            res.error = "No active sequence — open a timeline first.";
            return ser(res);
        }
        var timebase = Number(get(seq, "timebase", 0));
        if (!timebase) {
            res.error = "Premiere did not report a timebase for this sequence.";
            return ser(res);
        }
        res.sequence = String(get(seq, "name", ""));
        res.timebase = timebase;
        res.fps = TICKS_PER_SECOND / timebase;

        var pre = findRenderPreset();
        for (i = 0; i < pre.tried.length; i++) res.tried.push("preset: " + pre.tried[i]);
        if (!pre.found) {
            res.error = "No Match Source H.264 preset found. Media Encoder ships one;"
                + " without it Premiere has nothing to render with.";
            return ser(res);
        }
        res.preset = pre.found;
        res.preset_name = pre.name;
        res.warnings = [];

        var dir = ensureFolder(destFolder);
        if (!dir) {
            res.error = "Could not create " + destFolder
                + "\nIf that is on the Desktop or in Documents, Premiere may not have"
                + " Files and Folders permission yet.";
            return ser(res);
        }
        res.folder = dir.fsName;

        /* A preset at the quality the slider is set to.
         *
         * Falling back to the stock one rather than failing: a 10 Mbps intermediate still
         * produces valid clips, so this is a quality shortfall and not a correctness one,
         * and stopping an export over it would be out of proportion. But it is carried
         * into the run's own notes — a render quietly made at a bitrate nobody chose is
         * exactly the kind of thing that never gets noticed. */
        if (Number(mbps) > 0) {
            var gen = writeRenderPreset(dir.fsName, mbps, onePass);
            for (i = 0; i < gen.tried.length; i++) res.tried.push("preset: " + gen.tried[i]);
            if (gen.ok) {
                pre = { found: gen.path, name: eprNumber(gen.target) + " Mbps" };
                res.preset = gen.path;
                res.preset_name = pre.name + " (built from the quality setting)";
                res.bitrate = { target: gen.target, max: gen.max, min: gen.min,
                                pass: gen.pass, base: gen.base };
            } else {
                res.warnings.push("could not build a render preset at the chosen quality ("
                    + (gen.error || "unknown") + ") — rendered at the stock "
                    + pre.name + " instead");
            }
        }

        var ranges = parseRangeSpec(spec);
        if (!ranges.length) {
            res.error = "No cuts were handed over to render.";
            return ser(res);
        }
        res.total = ranges.length;

        /* Read the in/out points BEFORE anything moves them, and put them back at the
         * end whatever happens in between. Leaving the timeline as it was found is the
         * one condition this whole feature was given. */
        var before = rangeTicks(seq);
        res.in_out_before = before;

        /* ⚠️ AFTER every early return above, so no failure path can leave the user's
         * tracks switched off. Everything from here reaches the restore at the bottom. */
        var solo = null;
        if (String(keepTracks || "") !== "") {
            solo = soloVideoTrack(seq, keepTracks);
            for (i = 0; i < solo.tried.length; i++) res.tried.push("track: " + solo.tried[i]);
            res.tracks_hidden = solo.hidden;
            res.tracks_kept = solo.kept;
            if (!solo.ok) {
                restoreVideoTracks(seq, solo.before);
                res.error = solo.error;
                return ser(res);
            }
            if (solo.unverified) {
                res.warnings.push("Premiere would not confirm " + solo.unverified
                    + " video track(s) were hidden — check one clip for a logo or caption"
                    + " that should not be there");
            }
        }

        var prog = new File(dir.fsName + "/_render_progress.json");
        writeRenderProgress(prog, 0, ranges.length, ranges[0].label, 0);

        var totalMs = 0;
        var onePassUsed = !!(res.bitrate && res.bitrate.one_pass);

        for (i = 0; i < ranges.length; i++) {
            var one = renderOneRange(seq, ranges[i].label, ranges[i].in_frames,
                                     ranges[i].out_frames, dir.fsName, pre.found,
                                     timebase);

            /* ⚠️ ONE PASS IS VERIFIED BY RENDERING, because it cannot be verified by
             * reading — the stock presets are unanimous about the value, so there is
             * nothing to compare against.
             *
             * If the very FIRST range fails for any reason other than the in/out points,
             * the pass mode is the newest thing in the chain and the likeliest cause. The
             * preset is rebuilt at the stock two passes and the range tried once more.
             * Only the first range gets this: a failure on cut nine is that cut's problem,
             * not a broken setting, and rebuilding then would hide it.
             *
             * Reported in the run's notes either way. A performance setting quietly
             * reverting is still a thing that happened. */
            if (i === 0 && !one.ok && !one.no_range && onePassUsed) {
                var again = writeRenderPreset(dir.fsName, mbps, false);
                if (again.ok) {
                    res.warnings.push("the one-pass render preset produced nothing on the"
                        + " first cut, so this run fell back to the stock two-pass setting");
                    res.tried.push("preset: fell back to pass mode " + again.pass);
                    pre = { found: again.path, name: eprNumber(again.target) + " Mbps" };
                    res.preset = again.path;
                    res.preset_name = pre.name + " (two-pass fallback)";
                    res.bitrate = { target: again.target, max: again.max, min: again.min,
                                    pass: again.pass, one_pass: false, base: again.base };
                    onePassUsed = false;
                    one = renderOneRange(seq, ranges[i].label, ranges[i].in_frames,
                                         ranges[i].out_frames, dir.fsName, pre.found,
                                         timebase);
                } else {
                    res.tried.push("preset: could not rebuild at two passes ("
                        + (again.error || "unknown") + ")");
                }
            }

            res.renders.push(one);
            if (one.ok) {
                res.written++;
                totalMs += Number(one.ms || 0);
            } else res.failed++;
            writeRenderProgress(prog, i + 1, ranges.length,
                                (i + 1 < ranges.length) ? ranges[i + 1].label : "",
                                res.failed);
            /* ⚠️ STOP. An in/out that will not move is not this clip's problem — it will
             * not move for the next one either, and carrying on is how one broken
             * assumption became seventeen renders of the whole timeline. */
            if (one.no_range) {
                res.aborted = true;
                res.error = one.error;
                break;
            }
        }

        /* Tracks first, then the in/out points. Both are the user's timeline and both go
         * back whatever happened in between. */
        if (solo) {
            var back2 = restoreVideoTracks(seq, solo.before);
            res.tracks_restored = back2.restored;
            for (i = 0; i < back2.tried.length; i++) {
                res.tried.push("track restore: " + back2.tried[i]);
            }
            if (back2.failed) {
                res.warnings.push("could not switch " + back2.failed + " video track(s)"
                    + " back on — check the timeline before you keep editing");
            }
        }

        res.restored = false;
        if (before.in_ticks !== null && before.out_ticks !== null) {
            var back = setRange(seq, Number(before.in_ticks),
                                Number(before.out_ticks), timebase);
            res.restored = back.ok;
            res.in_out_after = rangeTicks(seq);
            if (!back.ok) res.tried.push("restoring in/out: " + back.tried.join(" · "));
        } else {
            res.tried.push("in/out could not be read before the run, so it was left"
                + " where the last render put it");
        }

        /* ok means SOMETHING rendered. Which cuts did not is in `renders`, and
         * xmlcut.py refuses those rather than cutting them from source — a folder half
         * with effects and half without is the one outcome worth failing over. */
        /* An abort is never a partial success. Some cuts may already have rendered
         * before the range stopped taking, but a folder that is right up to clip nine
         * and wrong after it is worse than one the engine refuses outright. */
        /* The total, so one run can be compared with the next. There is no before/after
         * machinery here and there does not need to be: the number is in the run's own
         * notes, and the pass mode it was rendered at is beside it. */
        res.total_ms = totalMs;
        res.pass_used = res.bitrate ? String(res.bitrate.pass || "") : "";
        res.one_pass_used = !!onePassUsed;

        res.ok = res.written > 0 && !res.aborted;
        if (!res.ok && !res.error) res.error = "Premiere rendered none of the cuts.";
    } catch (e) {
        res.error = String(e) + (e.line ? (" (line " + e.line + ")") : "");
    }
    return ser(res);
}

/* ============================================ a preset that follows the quality slider
 *
 * Premiere's exporter has no concept of CRF. It thinks in bitrate targets, so "render at
 * the quality the slider is set to" cannot be asked for directly — it has to be turned
 * into a number of megabits and written into a preset.
 *
 * ⚠️ WHY THE STOCK PRESET WAS NOT ENOUGH. "Match Source - High bitrate" is a fixed 10
 * Mbps target / 12 max, whatever the sequence is. On 1080x1920 that is roughly what crf
 * 18 spends anyway; on a 4K sequence it is well under it, and the render — the thing
 * every cut is then encoded FROM — becomes the limiting factor instead of the setting
 * the export was asked for.
 *
 * The preset is a copy of a stock one with three numbers changed, rather than authored
 * from scratch: an .epr carries a few hundred parameters, and the ones not being changed
 * are ones nobody here understands well enough to invent.
 */

/* Replace ONE parameter's value.
 *
 * ⚠️ The value is found by searching FORWARD from the identifier, so a parameter that has
 * no <ParamValue> would otherwise reach into the NEXT parameter and rewrite that one
 * instead — silently, and in a file no one is going to read. The guard below stops at the
 * next identifier. Returns null rather than a half-patched string. */
function patchEprParam(xml, ident, value) {
    var tag = "<ParamIdentifier>" + ident + "</ParamIdentifier>";
    var at = xml.indexOf(tag);
    if (at < 0) return null;
    var vs = xml.indexOf("<ParamValue>", at);
    if (vs < 0) return null;
    var ve = xml.indexOf("</ParamValue>", vs);
    if (ve < 0) return null;
    var next = xml.indexOf("<ParamIdentifier>", at + tag.length);
    if (next >= 0 && vs > next) return null;
    return xml.substring(0, vs + "<ParamValue>".length) + value + xml.substring(ve);
}

function readEprParam(xml, ident) {
    var tag = "<ParamIdentifier>" + ident + "</ParamIdentifier>";
    var at = xml.indexOf(tag);
    if (at < 0) return null;
    var vs = xml.indexOf("<ParamValue>", at);
    var ve = xml.indexOf("</ParamValue>", vs);
    if (vs < 0 || ve < 0) return null;
    var next = xml.indexOf("<ParamIdentifier>", at + tag.length);
    if (next >= 0 && vs > next) return null;
    return xml.substring(vs + "<ParamValue>".length, ve);
}

/* Adobe writes a whole number as "10." rather than "10". Matched, because a format the
 * file has never contained is a format nothing has ever parsed. */
function eprNumber(n) {
    n = Math.round(Number(n) * 10) / 10;
    return (n === Math.floor(n)) ? (String(Math.floor(n)) + ".") : String(n);
}

/* Write <destFolder>/_xmlcut_render.epr at the given target bitrate.
 *
 * Returns {ok, path, target, max, min, base, tried[]}. Everything it wrote is read back
 * out of the finished file and reported: a preset that patched the wrong parameter would
 * still render, and the only sign would be a bitrate nobody asked for. */
/* VBR one pass. Adobe's own enum, and the reason it is a constant rather than a
 * setting: every one of the 43 stock H.264 presets is TWO pass, which on an intermediate
 * that is about to be re-encoded buys precision in a bitrate target nobody reads. It is
 * not a large saving — rendering was measured at about two thirds of a second a cut with
 * two passes on — but it is free, and there is nothing to weigh up per export.
 *
 * ⚠️ NOT VERIFIABLE BY READING. The value cannot be confirmed from the stock files, which
 * are unanimous. So the caller renders with it and, if the very first range fails,
 * rebuilds the preset at the stock pass mode and tries once more — reporting both, never
 * silently. See renderCuts. */
var VBR_ONE_PASS = "1";

function writeRenderPreset(destFolder, mbps, onePass, baseOverride) {
    var res = { ok: false, tried: [] };
    try {
        var base = baseOverride ? { found: String(baseOverride), name: "(chosen by hand)",
                                    tried: [] }
                                : findRenderPreset();
        for (var i = 0; i < base.tried.length; i++) res.tried.push("base: " + base.tried[i]);
        if (!base.found) {
            res.error = "No stock H.264 preset to copy.";
            return res;
        }
        res.base = base.found;

        var f = new File(base.found);
        f.encoding = "UTF-8";
        if (!f.open("r")) {
            res.error = "Could not read " + base.found;
            return res;
        }
        var xml = f.read();
        f.close();

        var target = Number(mbps);
        if (!(target > 0)) {
            res.error = "No bitrate to write.";
            return res;
        }
        // Adobe's own presets sit max 20% above target (10/12, 20/24, 80/96). Kept, so the
        // generated preset behaves like the ones the exporter was tuned against.
        var maxb = target * 1.2;
        var minb = Math.min(2, target);

        var pairs = [["ADBEVideoTargetBitrate", eprNumber(target)],
                     ["ADBEVideoMaxBitrate", eprNumber(maxb)],
                     ["ADBEVideoMinBitrate", eprNumber(minb)]];
        /* The pass mode is an INTEGER parameter — type 2 in the file, written plainly,
         * unlike the bitrates which are floats carrying Adobe's trailing dot. */
        if (onePass) pairs.push(["ADBEVideoBitrateEncoding", VBR_ONE_PASS]);
        for (i = 0; i < pairs.length; i++) {
            var next = patchEprParam(xml, pairs[i][0], pairs[i][1]);
            if (next === null) {
                res.error = "This preset has no " + pairs[i][0]
                    + " to change — refusing to guess where that setting lives.";
                return res;
            }
            xml = next;
        }

        var out = new File(String(destFolder) + "/_xmlcut_render.epr");
        if (out.exists) { try { out.remove(); } catch (eRm) {} }
        out.encoding = "UTF-8";
        if (!out.open("w")) {
            res.error = "Could not write " + out.fsName;
            return res;
        }
        out.write(xml);
        out.close();

        /* READ IT BACK. Not a formality: patchEprParam returning the wrong span would
         * produce a preset that renders perfectly happily at a bitrate nobody chose. */
        var chk = new File(out.fsName);
        chk.encoding = "UTF-8";
        if (!chk.open("r")) {
            res.error = "Wrote " + out.fsName + " but could not read it back.";
            return res;
        }
        var back = chk.read();
        chk.close();
        var gotT = readEprParam(back, "ADBEVideoTargetBitrate");
        var gotM = readEprParam(back, "ADBEVideoMaxBitrate");
        if (gotT !== eprNumber(target) || gotM !== eprNumber(maxb)) {
            res.error = "The preset did not come back with the bitrate that was written"
                + " (target " + gotT + ", max " + gotM + ") — not using it.";
            return res;
        }
        /* The pass mode is checked too. It is the one setting here that cannot be
         * confirmed against the stock files — they are unanimous — so it had better be
         * confirmed against what was just written. */
        var gotP = readEprParam(back, "ADBEVideoBitrateEncoding");
        if (onePass && gotP !== VBR_ONE_PASS) {
            res.error = "The preset was written for one pass but reads back as " + gotP
                + " — not using it.";
            return res;
        }

        res.ok = true;
        res.path = out.fsName;
        res.target = Number(target);
        res.max = Number(maxb);
        res.min = Number(minb);
        res.pass = gotP;
        res.one_pass = !!onePass;
        res.tried.push("wrote " + eprNumber(target) + " Mbps target / "
            + eprNumber(maxb) + " max, pass mode " + gotP + ", from " + base.name);
    } catch (e) {
        res.error = String(e) + (e.line ? (" (line " + e.line + ")") : "");
    }
    return res;
}

/* ============================================ rendering ONE track, not the picture
 *
 * A render is the composite, which is the whole point of render mode and also its one
 * unwanted consequence: a logo on V3 and a caption on V2 are burned into every clip cut
 * from V1. On one real client timeline that meant a brand watermark and a caption
 * burned into all seventeen files.
 *
 * So the other video tracks are switched off for the duration and put back afterwards —
 * the same contract as the in/out points.
 *
 * ⚠️ THE TRADE-OFF IS REAL AND CANNOT BE INFERRED AWAY. An ADJUSTMENT LAYER above V1 is
 * also on an upper track, and hiding it removes colour work the editor applied to the
 * shot on purpose. Premiere gives no reliable way to tell "an overlay I do not want" from
 * "a grade I do". So this is a tick rather than a rule, and the tooltip says what it
 * costs.
 */

/* Every video track's current visibility, 1-based to match the cut list. `muted: null`
 * means this Premiere would not say, which is reported rather than assumed either way. */
function videoTrackStates(seq) {
    var out = [];
    var tracks = get(seq, "videoTracks", null);
    var n = tracks ? Number(get(tracks, "numTracks", 0)) : 0;
    for (var i = 0; i < n; i++) {
        var m = call(tracks[i], "isMuted", null);
        out.push({ index: i + 1, muted: (m === null ? null : !!m) });
    }
    return out;
}

/* Hide every video track that is NOT in `keepList`.
 *
 * `keepList` is "1,3" — the tracks whose pixels belong in the render. This started life as
 * "hide the other tracks", one master track and everything else off, which was too blunt:
 * an adjustment layer above the footage is on an upper track too, and hiding it threw away
 * grading the editor meant for the shot. Naming the tracks to KEEP separates the two —
 * include V3's grade, leave V2's caption out.
 *
 * Returns {ok, before[], tried[], unverified, denied}. `denied` counts tracks that were
 * asked to hide and REPORTED BACK STILL VISIBLE — a definite failure, and the caller
 * refuses to render on it: seventeen files with a watermark burned in are worse than a
 * clear stop. `unverified` counts tracks this Premiere would not report on at all, which
 * is a warning rather than a refusal — the difference between knowing it is wrong and not
 * knowing. */
function soloVideoTrack(seq, keepList) {
    var res = { ok: false, tried: [], before: [], unverified: 0, denied: 0, hidden: 0,
                kept: [] };
    var tracks = get(seq, "videoTracks", null);
    var n = tracks ? Number(get(tracks, "numTracks", 0)) : 0;
    if (!n) {
        res.error = "Premiere reported no video tracks on this sequence.";
        return res;
    }
    res.before = videoTrackStates(seq);

    /* The set of tracks to leave visible. An empty list would hide the picture entirely,
     * so it is refused rather than obeyed — the caller passes nothing at all when it wants
     * the timeline left alone. */
    var keep = {}, parts = String(keepList || "").split(","), kn = 0;
    for (var p = 0; p < parts.length; p++) {
        var v = parseInt(parts[p], 10);
        if (v > 0 && !keep[v]) { keep[v] = 1; kn++; res.kept.push(v); }
    }
    if (!kn) {
        res.error = "No video track was named as visible — refusing to render a black"
            + " picture.";
        return res;
    }

    for (var i = 0; i < n; i++) {
        if (keep[i + 1]) continue;               // its pixels belong in the render
        var want = 1;                            // 1 = hidden
        try {
            tracks[i].setMute(want);
        } catch (e) {
            res.tried.push("V" + (i + 1) + ": setMute threw: " + String(e));
            res.unverified++;
            continue;
        }
        var back = call(tracks[i], "isMuted", null);
        if (back === null) {
            res.unverified++;
            continue;
        }
        if (!back) {
            res.tried.push("V" + (i + 1) + ": asked to hide, still reports visible");
            res.denied++;
            continue;
        }
        res.hidden++;
    }

    res.ok = res.denied === 0;
    if (!res.ok) {
        res.error = "Premiere would not hide " + res.denied + " video track(s), so every"
            + " render would carry whatever is on them. Nothing was rendered.";
    }
    return res;
}

/* Put every track back exactly as it was found. A state of null was never known, so it is
 * left alone rather than guessed at. */
function restoreVideoTracks(seq, before) {
    var res = { restored: 0, failed: 0, tried: [] };
    var tracks = get(seq, "videoTracks", null);
    var n = tracks ? Number(get(tracks, "numTracks", 0)) : 0;
    for (var i = 0; i < (before || []).length; i++) {
        var was = before[i];
        if (!was || was.muted === null) continue;
        var idx = Number(was.index) - 1;
        if (idx < 0 || idx >= n) continue;
        try {
            tracks[idx].setMute(was.muted ? 1 : 0);
            res.restored++;
        } catch (e) {
            res.failed++;
            res.tried.push("V" + was.index + ": " + String(e));
        }
    }
    return res;
}
