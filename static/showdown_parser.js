/*
 * showdown_parser.js -- JavaScript port of showdown_parser.py.
 *
 * The static (GitHub Pages) build has no Python backend, so the Showdown
 * paste parser runs in the browser. This file is a faithful port of
 * showdown_parser.py: same normalization, same EV/SP heuristic, same
 * warnings, same output shape. The two implementations must not drift --
 * static/datasource.test.html asserts byte-for-byte JSON equality against
 * fixtures generated from the Python parser.
 *
 * Exposes: window.ShowdownParser.parseTeam(text) -> set[]
 *
 * Set shape (what static/calc/adapter.js expects):
 *   { species, nickname, level, nature, ability, item, teraType, gender,
 *     sps: {hp,at,df,sa,sd,sp}, moves: [], warnings: [] }
 */

(function () {
    "use strict";

    // Showdown stat label -> short key. Case-insensitive lookup below.
    var STAT_KEYS = { hp: "hp", atk: "at", def: "df", spa: "sa", spd: "sd", spe: "sp" };

    // Canonical order used when exporting back to Showdown text.
    var STAT_EXPORT = [
        ["hp", "HP"], ["at", "Atk"], ["df", "Def"],
        ["sa", "SpA"], ["sd", "SpD"], ["sp", "Spe"],
    ];

    var STAT_ENTRY_RE = /(\d+)\s*([A-Za-z]+)/;
    var GENDER_RE = /\s*\((M|F)\)\s*$/i;
    var NICK_SPECIES_RE = /^(.+?)\s*\(([^)]+)\)$/;
    var BLOCK_SPLIT_RE = /\n\s*\n/;

    // EV/SP disambiguation thresholds; see _applyStatLine.
    var MIN_PLAUSIBLE_SP_TOTAL = 32;
    var AMBIGUOUS_SP_TOTAL = 48;

    // Lines that are set fields, never a species header.
    var FIELD_PREFIXES = [
        "ability:", "level:", "evs:", "sps:", "ivs:", "tera type:",
        "shiny:", "happiness:", "gender:", "nature:",
    ];

    function startsWithAny(lower, prefixes) {
        for (var i = 0; i < prefixes.length; i++) {
            if (lower.indexOf(prefixes[i]) === 0) return true;
        }
        return false;
    }

    /** Python-style repr for a string, used to match warning text exactly. */
    function pyRepr(value) {
        var s = String(value);
        if (s.indexOf("'") !== -1 && s.indexOf('"') === -1) {
            return '"' + s + '"';
        }
        return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
    }

    function normalizeText(text) {
        text = String(text == null ? "" : text);
        text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        text = text.replace(/\u00a0/g, " ");
        return text.split("\n").map(function (line) {
            return line.replace(/\s+$/, "");
        }).join("\n");
    }

    function isPlausibleHeader(line) {
        line = String(line == null ? "" : line).trim();
        if (!line) return false;
        if (line.charAt(0) === "-" || line.charAt(0) === "@") return false;
        var lower = line.toLowerCase();
        if (startsWithAny(lower, FIELD_PREFIXES)) return false;
        if (lower.slice(-7) === " nature" || lower === "nature") return false;
        return true;
    }

    function looksLikeSetContent(block) {
        var lines = block.split("\n");
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;
            if (line.charAt(0) === "-") return true;
            var lower = line.toLowerCase();
            if (startsWithAny(lower, FIELD_PREFIXES)) return true;
            if (lower.slice(-7) === " nature") return true;
        }
        return false;
    }

    /** Split a header line into [species, nickname, gender, item]. */
    function parseHeader(line) {
        var item = "";
        var left;
        var at = line.indexOf(" @ ");
        if (at !== -1) {
            left = line.slice(0, at);
            item = line.slice(at + 3).trim();
        } else {
            left = line;
        }
        left = left.trim();

        var gender = "";
        var match = left.match(GENDER_RE);
        if (match) {
            gender = match[1].toUpperCase();
            left = left.slice(0, match.index).trim();
        }

        // Gender may also trail the item: "Species @ Life Orb (M)".
        match = item.match(GENDER_RE);
        if (match) {
            if (!gender) gender = match[1].toUpperCase();
            item = item.slice(0, match.index).trim();
        }

        // A bare "(Species)" means no nickname; check before the nickname
        // regex, which requires at least one character before the parens.
        if (left.charAt(0) === "(" && left.charAt(left.length - 1) === ")" &&
                countChar(left, "(") === 1) {
            return [left.slice(1, -1).trim(), "", gender, item];
        }

        match = left.match(NICK_SPECIES_RE);
        if (match) {
            return [match[2].trim(), match[1].trim(), gender, item];
        }

        return [left, "", gender, item];
    }

    function countChar(s, ch) {
        var n = 0;
        for (var i = 0; i < s.length; i++) if (s.charAt(i) === ch) n++;
        return n;
    }

    /** Parse "2 HP / 32 SpA / 32 Spe" or positional "32/32/2". */
    function parseStatLine(body) {
        var stats = {};
        var chunks = body.split("/");
        for (var i = 0; i < chunks.length; i++) {
            var match = chunks[i].match(STAT_ENTRY_RE);
            if (!match) continue;
            var value = parseInt(match[1], 10);
            var key = STAT_KEYS[match[2].toLowerCase()];
            if (key) stats[key] = value;
        }

        if (Object.keys(stats).length === 0) {
            var parts = [];
            var rawParts = body.split("/");
            for (var j = 0; j < rawParts.length; j++) {
                var p = rawParts[j].trim();
                if (p) parts.push(p);
            }
            var allDigits = parts.length > 0 && parts.every(function (p) {
                return /^\d+$/.test(p);
            });
            if (allDigits) {
                for (var k = 0; k < STAT_EXPORT.length && k < parts.length; k++) {
                    stats[STAT_EXPORT[k][0]] = parseInt(parts[k], 10);
                }
            }
        }

        return stats;
    }

    function emptySps() {
        var sps = {};
        for (var i = 0; i < STAT_EXPORT.length; i++) sps[STAT_EXPORT[i][0]] = 0;
        return sps;
    }

    function applyStatLine(prefix, body, sps, warnings) {
        var parsed = parseStatLine(body);
        var keys = Object.keys(parsed);
        if (keys.length === 0) return;

        var values = keys.map(function (k) { return parsed[k]; });
        var total = values.reduce(function (a, b) { return a + b; }, 0);

        var isSps;
        if (prefix === "sps") {
            isSps = true;
        } else if (values.some(function (v) { return v > 32; }) || total > 66) {
            isSps = false;
        } else if (total < MIN_PLAUSIBLE_SP_TOTAL) {
            isSps = false;
        } else {
            isSps = true;
            if (total < AMBIGUOUS_SP_TOTAL) {
                warnings.push("ambiguous EVs/SPs line; treating as SPs (Champions convention)");
            }
        }

        keys.forEach(function (key) {
            var value = parsed[key];
            if (isSps) {
                sps[key] = Math.max(0, Math.min(32, value));
            } else {
                sps[key] = Math.max(0, Math.min(32, Math.floor(value / 8)));
            }
        });

        if (!isSps) warnings.push("EVs converted to SPs");
    }

    function parseMove(line, warnings) {
        var name = line.replace(/^-+/, "").trim();
        if (name.indexOf("/") !== -1) {
            var first = name.split("/", 1)[0].trim();
            warnings.push('move "' + name + '" has slash alternatives; using "' + first + '"');
            return first;
        }
        return name;
    }

    /** Parse one non-empty block. Returns null when there is no valid header. */
    function parseBlock(block) {
        var rawLines = block.split("\n");
        var lines = [];
        for (var i = 0; i < rawLines.length; i++) {
            var trimmed = rawLines[i].trim();
            if (trimmed) lines.push(trimmed);
        }
        if (lines.length === 0) return null;
        if (!isPlausibleHeader(lines[0])) return null;

        var header = parseHeader(lines[0]);
        var species = header[0], nickname = header[1], gender = header[2], item = header[3];
        if (!species) return null;

        var warnings = [];
        var setObj = {
            species: species,
            nickname: nickname,
            level: 50,
            nature: "Hardy",
            ability: "",
            item: item,
            teraType: "",
            gender: gender,
            sps: emptySps(),
            moves: [],
            warnings: warnings,
        };

        for (var j = 1; j < lines.length; j++) {
            var line = lines[j];
            var lower = line.toLowerCase();

            if (line.charAt(0) === "-") {
                if (setObj.moves.length < 4) {
                    setObj.moves.push(parseMove(line, warnings));
                } else {
                    warnings.push('ignored extra move "' + line.replace(/^-+/, "").trim() + '"');
                }
            } else if (lower.indexOf("ability:") === 0) {
                setObj.ability = line.slice(line.indexOf(":") + 1).trim();
            } else if (lower.indexOf("level:") === 0) {
                var levelValue = line.slice(line.indexOf(":") + 1).trim();
                if (/^\d+$/.test(levelValue)) {
                    setObj.level = parseInt(levelValue, 10);
                } else {
                    warnings.push("unparseable level: " + pyRepr(levelValue));
                }
            } else if (lower.indexOf("tera type:") === 0) {
                setObj.teraType = line.slice(line.indexOf(":") + 1).trim();
            } else if (lower.indexOf("gender:") === 0) {
                var genderValue = line.slice(line.indexOf(":") + 1).trim().toUpperCase();
                if (genderValue === "M" || genderValue === "F") setObj.gender = genderValue;
            } else if (lower.indexOf("evs:") === 0) {
                applyStatLine("evs", line.slice(line.indexOf(":") + 1), setObj.sps, warnings);
            } else if (lower.indexOf("sps:") === 0) {
                applyStatLine("sps", line.slice(line.indexOf(":") + 1), setObj.sps, warnings);
            } else if (lower.indexOf("ivs:") === 0) {
                var ivs = parseStatLine(line.slice(line.indexOf(":") + 1));
                var nonDefault = Object.keys(ivs).some(function (k) { return ivs[k] !== 31; });
                if (nonDefault) warnings.push("non-default IVs ignored");
            } else if (lower.indexOf("shiny:") === 0 || lower.indexOf("happiness:") === 0) {
                // Parsed for completeness; not represented in our set shape.
            } else if (lower.slice(-7) === " nature") {
                setObj.nature = line.slice(0, line.length - 7).trim();
            } else if (lower.indexOf("nature:") === 0) {
                setObj.nature = line.slice(line.indexOf(":") + 1).trim();
            }
            // Any other line is ignored; Showdown exports vary slightly.
        }

        return setObj;
    }

    function appendContinuation(setObj, block, warnings) {
        var rawLines = block.split("\n");
        var lines = [];
        for (var i = 0; i < rawLines.length; i++) {
            var trimmed = rawLines[i].trim();
            if (trimmed) lines.push(trimmed);
        }
        if (lines.length === 0) return;

        var header = setObj.species || "";
        if (setObj.nickname) header = setObj.nickname + " (" + header + ")";
        var merged = parseBlock(header + "\n" + lines.join("\n"));
        if (!merged) return;

        merged.moves.forEach(function (move) {
            if (setObj.moves.length < 4) setObj.moves.push(move);
        });
        if (merged.ability) setObj.ability = merged.ability;
        if (merged.item) setObj.item = merged.item;
        if (merged.teraType) setObj.teraType = merged.teraType;
        if (merged.nature !== "Hardy") setObj.nature = merged.nature;
        if (merged.gender) setObj.gender = merged.gender;
        if (merged.level !== 50) setObj.level = merged.level;
        Object.keys(merged.sps).forEach(function (key) {
            if (merged.sps[key]) setObj.sps[key] = merged.sps[key];
        });
        merged.warnings.forEach(function (warning) {
            if (warnings.indexOf(warning) === -1) warnings.push(warning);
        });
    }

    function parseTeam(text) {
        var normalized = normalizeText(text || "");
        var blocks = normalized.split(BLOCK_SPLIT_RE).map(function (b) {
            return b.trim();
        }).filter(function (b) { return b.length > 0; });

        var sets = [];
        var warnings = [];
        for (var i = 0; i < blocks.length; i++) {
            var block = blocks[i];
            var parsed;
            try {
                parsed = parseBlock(block);
            } catch (err) {
                // Defensive: one bad block must not kill the team.
                if (typeof console !== "undefined" && console.warn) {
                    console.warn("  WARNING: failed to parse a set block: " + err);
                }
                continue;
            }

            if (parsed !== null) {
                sets.push(parsed);
                continue;
            }

            var first = block.split("\n", 1)[0].trim();
            if (sets.length && looksLikeSetContent(block)) {
                appendContinuation(sets[sets.length - 1], block, sets[sets.length - 1].warnings);
                sets[sets.length - 1].warnings.push(
                    "merged continuation block into " + pyRepr(sets[sets.length - 1].species) +
                    " (stray blank line?)"
                );
            } else {
                warnings.push("skipped unparseable block starting " + pyRepr(first));
            }
        }

        if (!sets.length) {
            throw new Error("No Pokemon sets found in input");
        }

        if (warnings.length) {
            sets[0].warnings = sets[0].warnings.concat(warnings);
        }

        return sets;
    }

    window.ShowdownParser = {
        parseTeam: parseTeam,
    };
})();
