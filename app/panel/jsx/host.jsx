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
        result.clips = data.clips.length;
        result.video_clips = vids;
        result.keyframed_ramps = ramps;
    } catch (e) {
        result.error = String(e) + (e.line ? (" (line " + e.line + ")") : "");
    }
    return ser(result);
}
