/*
 * matrix.js -- Phase C2 matchup matrix + detail panel.
 *
 * Loads BEFORE app.js and registers itself on window.Matrix. app.js's
 * renderMatchup() calls Matrix.buildModel(state) then Matrix.render(model).
 * Nothing here touches window.App at parse time; shared helpers (escapeHtml,
 * state) are read lazily at call time so the load order stays simple.
 *
 * Responsibilities:
 *   - buildModel(state): run CalcEngine.calcMatchup for every pairing, cache
 *     by a stable (mySet, oppSet, field) signature, and pre-derive each side's
 *     best move + hits-to-KO.
 *   - render(model): draw the heatmap grid.
 *   - renderDetail(model, i, j): draw the click-through breakdown.
 *
 * KO-count derivation lives here (not in the adapter) because it is a display
 * concern: the adapter's `koText` stays authoritative and is shown verbatim in
 * the detail panel.
 */

(function () {
    "use strict";

    var SPRITE_SHEET_CELL_W = 40;
    var SPRITE_SHEET_CELL_H = 30;

    // Cache of pairing results keyed by set+field signature. Field options are
    // global, so a field toggle changes every key; the cache mainly avoids
    // recomputation on repeated renders and when the detail panel reopens.
    var CACHE_MAX = 4000;
    var cache = new Map();

    var lastModel = null;
    var selected = null;   // {i, j} of the open detail pairing

    // ------------------------------------------------------------------
    // Small DOM / string helpers
    // ------------------------------------------------------------------

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = String(text);
        return node;
    }

    /** MunchStats sprite sheet span from a [row, col] coordinate. */
    function sheetSprite(sprite, extraClass) {
        var span = el("span", "sprite" + (extraClass ? " " + extraClass : ""));
        if (Array.isArray(sprite) && sprite.length === 2) {
            var row = Number(sprite[0]) || 0;
            var col = Number(sprite[1]) || 0;
            span.style.backgroundPosition =
                (-col * SPRITE_SHEET_CELL_W) + "px " + (-row * SPRITE_SHEET_CELL_H) + "px";
        }
        return span;
    }

    /**
     * Showdown home sprite <img>, falling back to gen-5 art then hidden.
     * Used for "my team" (MunchStats sheet only covers their scraped teams).
     */
    function showdownSprite(species) {
        var img = document.createElement("img");
        img.className = "sprite sprite-my";
        img.alt = "";
        var slug = encodeURIComponent(String(species || "").toLowerCase().replace(/\s+/g, "-"));
        img.src = "https://play.pokemonshowdown.com/sprites/home/" + slug + ".png";
        img.onerror = function () {
            if (img.dataset.fallback) { img.style.visibility = "hidden"; return; }
            img.dataset.fallback = "1";
            img.src = "https://play.pokemonshowdown.com/sprites/gen5/" + slug + ".png";
        };
        return img;
    }

    /** Map of species -> sheet sprite coords for the selected opponent team. */
    function oppSpriteMap(state) {
        var map = {};
        var team = (state.selectedTeam && state.selectedTeam.team) || [];
        team.forEach(function (mon) {
            if (mon && mon.pokemon) map[mon.pokemon] = mon.sprite;
        });
        return map;
    }

    // ------------------------------------------------------------------
    // KO analysis
    // ------------------------------------------------------------------

    /**
     * Explicit "no data" KO state. Distinct from "no damaging move": the
     * engine could not build one of the two Pokemon, so there is nothing to
     * say about this pairing. Rendering and scoring must never treat it as
     * "safe" (which would reward missing data).
     */
    function unknownKo() {
        return { label: "?", minHits: null, maxHits: null, guaranteed: false, damaging: false, unknown: true };
    }

    /**
     * Derive hits-to-KO for one move against a defender's max HP.
     * @param {object} move - tidy move record from the adapter
     * @param {number} defenderHP - defender max HP
     * @returns {{label:string,minHits:(number|null),maxHits:(number|null),
     *            guaranteed:boolean,damaging:boolean}}
     */
    function analyzeMove(move, defenderHP) {
        if (!move || move.isStatus || !(move.max > 0) || !(defenderHP > 0)) {
            return { label: "\u2014", minHits: null, maxHits: null, guaranteed: false, damaging: false };
        }
        if (move.min >= defenderHP) {
            return { label: "OHKO", minHits: 1, maxHits: 1, guaranteed: true, damaging: true };
        }
        if (move.max >= defenderHP) {
            var worst = move.min > 0 ? Math.ceil(defenderHP / move.min) : null;
            return { label: "OHKO (roll)", minHits: 1, maxHits: worst, guaranteed: false, damaging: true };
        }
        var best = Math.ceil(defenderHP / move.max);
        var worstHits = move.min > 0 ? Math.ceil(defenderHP / move.min) : null;
        if (worstHits === null) {
            return { label: best + "HKO+", minHits: best, maxHits: null, guaranteed: false, damaging: true };
        }
        if (best === worstHits) {
            return { label: best + "HKO", minHits: best, maxHits: best, guaranteed: true, damaging: true };
        }
        return { label: best + "-" + worstHits + "HKO", minHits: best, maxHits: worstHits, guaranteed: false, damaging: true };
    }

    /**
     * Pick the move needing the fewest hits to KO. Tie-break: fewer worst-case
     * hits, then highest minimum damage. Status moves are ignored.
     *
     * Null maxHits means "min damage is 0, so the worst case is unbounded"
     * (the move can never guarantee a KO). Such a move must never win a
     * tie-break by comparing null with "<", so null is treated as +Infinity.
     * @param {object[]} moves
     * @param {number} defenderHP
     * @returns {{move:object, ko:object}|null}
     */
    function bestMove(moves, defenderHP) {
        var best = null;
        (moves || []).forEach(function (move) {
            if (move.isStatus) return;
            var ko = analyzeMove(move, defenderHP);
            if (!ko.damaging) return;
            if (!best) { best = { move: move, ko: ko }; return; }
            var better = false;
            if (ko.minHits < best.ko.minHits) better = true;
            else if (ko.minHits === best.ko.minHits) {
                if (worstHits(ko) < worstHits(best.ko)) better = true;
                else if (worstHits(ko) === worstHits(best.ko) && move.min > best.move.min) better = true;
            }
            if (better) best = { move: move, ko: ko };
        });
        return best;
    }

    /** Worst-case hit count, with null (unbounded) sorted last. */
    function worstHits(ko) {
        return ko.maxHits == null ? Infinity : ko.maxHits;
    }

    /**
     * Compact cell label: exact counts up to 3HKO, then "4HKO+". The tooltip
     * and detail panel keep the exact numbers.
     */
    function cellKoLabel(ko) {
        if (!ko || !ko.damaging) return "\u2014";
        if (ko.minHits <= 1) return ko.guaranteed ? "OHKO" : "OHKO (roll)";
        if (ko.minHits >= 4) return "4HKO+";
        return ko.label;
    }

    /** Heatmap class for my offensive effectiveness. */
    function offenseHeat(ko) {
        if (ko && ko.unknown) return "heat-unknown";
        if (!ko || !ko.damaging) return "heat-none";
        if (ko.minHits <= 1) return "heat-1";
        if (ko.minHits === 2) return "heat-2";
        if (ko.minHits === 3) return "heat-3";
        return "heat-4";
    }

    /** Defensive corner badge: how badly they threaten me. */
    function defenseBadge(ko) {
        if (ko && ko.unknown) return { cls: "def-unknown", label: "no data" };
        if (!ko || !ko.damaging) return { cls: "def-safe", label: "safe" };
        if (ko.minHits <= 2) return { cls: "def-danger", label: "danger" };
        if (ko.minHits === 3) return { cls: "def-risky", label: "risky" };
        return { cls: "def-safe", label: "safe" };
    }

    // ------------------------------------------------------------------
    // Model
    // ------------------------------------------------------------------

    function setSig(set) {
        set = set || {};
        var sps = set.sps || {};
        return [
            set.species || "", set.nature || "", set.ability || "", set.item || "",
            set.teraType || "", set.terastallized ? 1 : 0,
            sps.hp | 0, sps.at | 0, sps.df | 0, sps.sa | 0, sps.sd | 0, sps.sp | 0,
            (set.moves || []).join("|"),
        ].join("~");
    }

    function fieldSig(field) {
        field = field || {};
        return [
            field.weather || "", field.terrain || "",
            field.reflect ? 1 : 0, field.lightScreen ? 1 : 0,
            field.tailwind ? 1 : 0, field.helpingHand ? 1 : 0,
        ].join(",");
    }

    /**
     * Engine-derived stat lookup; null when the species is unknown to it.
     *
     * `key` is either "maxHP" (the computed max HP) or a raw stat key
     * ("at"|"df"|"sa"|"sd"|"sp") read from the engine's unboosted rawStats.
     * @param {object} set - normalized set
     * @param {string} key
     * @returns {number|null}
     */
    function statOf(set, key) {
        try {
            var pokemon = window.CalcEngine.buildPokemon(set, []);
            return key === "maxHP" ? pokemon.maxHP : pokemon.rawStats[key];
        } catch (err) {
            return null;
        }
    }

    /** maxHP via the engine; null when the species is unknown to it. */
    function maxHPOf(set) {
        return statOf(set, "maxHP");
    }

    /**
     * Unboosted Speed stat at the set's SPs/nature; null when unknown.
     *
     * This is the raw Speed stat only. It does NOT account for Tailwind,
     * Trick Room, stat boosts, Choice Scarf, or any other in-battle modifier.
     * Lead scoring compares these numbers directly.
     */
    function speedOf(set) {
        return statOf(set, "sp");
    }

    /**
     * A pairing is "unknown" when the engine could not build one of the two
     * Pokemon (unknown species) or otherwise failed to evaluate the set. Such
     * pairings must be rendered and scored as no-data, never as "safe".
     */
    function pairingIsUnknown(result, myHP, oppHP) {
        return !!(result && result.unknown) || myHP == null || oppHP == null;
    }

    /**
     * Compute every pairing. Correctness first: 36 calcMatchup calls, cached by
     * signature so repeated renders and the detail panel reuse results.
     * @param {object} state - App.state
     * @returns {object} model
     */
    function buildModel(state) {
        var my = (state && state.myTeam) || [];
        var opp = (state && state.oppTeam) || [];
        var field = (state && state.field) || {};
        var myHP = my.map(maxHPOf);
        var oppHP = opp.map(maxHPOf);
        var mySpeed = my.map(speedOf);
        var oppSpeed = opp.map(speedOf);
        var fsig = fieldSig(field);
        var pairings = [];
        var warnings = [];
        var unknownSpecies = {};

        // Species the engine cannot build are the root cause of unknown
        // pairings; collect them once so the UI can name them.
        my.forEach(function (set, i) { if (myHP[i] == null) unknownSpecies[set.species] = true; });
        opp.forEach(function (set, j) { if (oppHP[j] == null) unknownSpecies[set.species] = true; });

        for (var i = 0; i < my.length; i++) {
            var row = [];
            for (var j = 0; j < opp.length; j++) {
                var key = setSig(my[i]) + "|" + setSig(opp[j]) + "|" + fsig;
                var entry = cache.get(key);
                if (!entry) {
                    var result;
                    try {
                        result = window.CalcEngine.calcMatchup(my[i], opp[j], field);
                    } catch (err) {
                        result = { mine: { moves: [] }, theirs: { moves: [] }, warnings: ["calc failed: " + err.message], unknown: true };
                    }
                    var unknown = pairingIsUnknown(result, myHP[i], oppHP[j]);
                    entry = {
                        result: result,
                        unknown: unknown,
                        myBest: unknown ? null : bestMove(result.mine.moves, oppHP[j]),
                        theirBest: unknown ? null : bestMove(result.theirs.moves, myHP[i]),
                    };
                    if (cache.size >= CACHE_MAX) cache.clear();
                    cache.set(key, entry);
                }
                row.push(entry);
                warnings = warnings.concat(entry.result.warnings);
            }
            pairings.push(row);
        }

        var unresolved = Object.keys(unknownSpecies);
        if (unresolved.length) {
            warnings.unshift("Could not evaluate: " + unresolved.join(", ") +
                " \u2014 not present in the damage engine's dex. These are shown as \"no data\" and are not scored.");
        }

        return {
            my: my,
            opp: opp,
            myHP: myHP,
            oppHP: oppHP,
            mySpeed: mySpeed,
            oppSpeed: oppSpeed,
            pairings: pairings,
            warnings: warnings,
            unknownSpecies: unresolved,
            field: field,
        };
    }

    // ------------------------------------------------------------------
    // Matrix rendering
    // ------------------------------------------------------------------

    function headerCell(set, spriteNode, side) {
        var head = el("div", "mx-head mx-head-" + side);
        head.appendChild(spriteNode);
        head.appendChild(el("span", "mx-head-name", set.species || "?"));
        return head;
    }

    function cellTitle(mySet, oppSet, pairing) {
        var lines = [mySet.species + " vs " + oppSet.species];
        if (pairing.unknown) {
            lines.push("No data: one of these Pokemon is not in the damage engine's dex.");
            return lines.join("\n");
        }
        if (pairing.myBest) {
            lines.push("My " + pairing.myBest.move.name + ": " + pairing.myBest.move.min + "-" +
                pairing.myBest.move.max + " (" + pairing.myBest.move.minPct + "-" +
                pairing.myBest.move.maxPct + "%) \u2014 " + pairing.myBest.ko.label);
        } else {
            lines.push("My best: no damaging move");
        }
        if (pairing.theirBest) {
            lines.push("Their " + pairing.theirBest.move.name + ": " + pairing.theirBest.move.min + "-" +
                pairing.theirBest.move.max + " (" + pairing.theirBest.move.minPct + "-" +
                pairing.theirBest.move.maxPct + "%) \u2014 " + pairing.theirBest.ko.label);
        } else {
            lines.push("Their best: no damaging move");
        }
        return lines.join("\n");
    }

    function renderCell(model, i, j) {
        var pairing = model.pairings[i][j];
        var mySet = model.my[i];
        var oppSet = model.opp[j];
        var myKO = pairing.unknown ? unknownKo() : (pairing.myBest ? pairing.myBest.ko : null);
        var theirKO = pairing.unknown ? unknownKo() : (pairing.theirBest ? pairing.theirBest.ko : null);
        var badge = defenseBadge(theirKO);

        var btn = el("button", "mx-cell " + offenseHeat(myKO));
        btn.type = "button";
        btn.dataset.my = String(i);
        btn.dataset.opp = String(j);
        btn.title = cellTitle(mySet, oppSet, pairing);
        if (selected && selected.i === i && selected.j === j) btn.classList.add("selected");

        btn.appendChild(el("span", "mx-ko", pairing.unknown ? "?" : cellKoLabel(myKO)));
        if (pairing.unknown) {
            btn.appendChild(el("span", "mx-pct", "no data"));
        } else if (pairing.myBest) {
            btn.appendChild(el("span", "mx-pct",
                pairing.myBest.move.minPct + "\u2013" + pairing.myBest.move.maxPct + "%"));
        } else {
            btn.appendChild(el("span", "mx-pct", "no dmg"));
        }
        btn.appendChild(el("span", "mx-def " + badge.cls, badge.label));

        btn.addEventListener("click", function () {
            selected = { i: i, j: j };
            renderDetail(lastModel, i, j);
            markSelected();
        });
        return btn;
    }

    function markSelected() {
        var host = document.getElementById("matrix-container");
        if (!host) return;
        host.querySelectorAll(".mx-cell").forEach(function (cell) {
            var on = selected && Number(cell.dataset.my) === selected.i && Number(cell.dataset.opp) === selected.j;
            cell.classList.toggle("selected", !!on);
        });
    }

    function renderLegend() {
        var legend = el("div", "mx-legend");
        [
            ["heat-1", "OHKO"],
            ["heat-2", "2HKO"],
            ["heat-3", "3HKO"],
            ["heat-4", "4HKO+"],
            ["heat-none", "no damage"],
            ["heat-unknown", "no data"],
        ].forEach(function (pair) {
            var item = el("span", "mx-legend-item");
            item.appendChild(el("span", "mx-swatch " + pair[0]));
            item.appendChild(el("span", null, pair[1]));
            legend.appendChild(item);
        });
        var def = el("span", "mx-legend-item mx-legend-def");
        def.appendChild(el("span", "mx-swatch def-danger"));
        def.appendChild(el("span", null, "defensive corner: danger / risky / safe"));
        legend.appendChild(def);
        return legend;
    }

    /**
     * Render the heatmap. Safe to call repeatedly; rebuilds the grid.
     * @param {object} model
     */
    function render(model) {
        lastModel = model;
        var host = document.getElementById("matrix-container");
        if (!host) return;
        host.innerHTML = "";

        if (!window.CalcEngine || !window.CalcEngine.ready) {
            host.appendChild(el("p", "empty muted", "Damage engine unavailable; cannot render the matrix."));
            return;
        }
        if (!model.my.length || !model.opp.length) {
            host.appendChild(el("p", "empty muted", "Load my team and select an opponent team to see the matrix."));
            return;
        }

        var oppSprites = oppSpriteMap(window.App ? window.App.state : {});

        var grid = el("div", "mx-grid");
        grid.style.gridTemplateColumns = "140px repeat(" + model.opp.length + ", minmax(74px, 1fr))";

        grid.appendChild(el("div", "mx-corner", "mine \\ theirs"));
        model.opp.forEach(function (set) {
            grid.appendChild(headerCell(set, sheetSprite(oppSprites[set.species]), "opp"));
        });
        model.my.forEach(function (set, i) {
            var head = headerCell(set, showdownSprite(set.species), "my");
            grid.appendChild(head);
            for (var j = 0; j < model.opp.length; j++) {
                grid.appendChild(renderCell(model, i, j));
            }
        });

        var scroll = el("div", "mx-scroll");
        scroll.appendChild(grid);

        var wrap = el("div", "mx-wrap");
        wrap.appendChild(el("h2", null, "Matchup Matrix"));
        wrap.appendChild(el("p", "muted small",
            "Rows: my team. Columns: opponent. Cell = my best move's KO count and damage range; " +
            "corner badge = how hard they hit me."));
        wrap.appendChild(scroll);
        wrap.appendChild(renderLegend());
        host.appendChild(wrap);

        if (model.warnings.length) {
            var unique = [];
            model.warnings.forEach(function (w) { if (unique.indexOf(w) === -1) unique.push(w); });
            var box = el("div", "warnings");
            unique.forEach(function (w) { box.appendChild(el("p", null, w)); });
            host.appendChild(box);
        }

        renderDetailFromSelection(model);
    }

    // ------------------------------------------------------------------
    // Detail panel
    // ------------------------------------------------------------------

    function spriteForSet(set, model, isOpp) {
        if (!isOpp) return showdownSprite(set.species);
        var oppSprites = oppSpriteMap(window.App ? window.App.state : {});
        var coords = oppSprites[set.species];
        return coords ? sheetSprite(coords) : showdownSprite(set.species);
    }

    function setSummary(set) {
        var box = el("div", "dt-set");
        var sps = set.sps || {};
        box.appendChild(el("div", "dt-set-line", (set.item || "no item") + " \u00b7 " + (set.ability || "no ability")));
        box.appendChild(el("div", "dt-set-line", (set.nature || "Hardy") + " Nature \u00b7 SPs " +
            [sps.hp | 0, sps.at | 0, sps.df | 0, sps.sa | 0, sps.sd | 0, sps.sp | 0].join("/")));
        box.appendChild(el("div", "dt-set-line muted", (set.moves || []).join(", ")));
        return box;
    }

    function moveMeta(name) {
        var data = window.moves ? window.moves[name] : null;
        if (!data) return null;
        return {
            type: data.type || "",
            category: data.category || "",
            bp: data.bp || 0,
        };
    }

    function moveRow(move, isBest) {
        var meta = moveMeta(move.name);
        var row = el("div", "dt-move" + (isBest ? " dt-best" : ""));

        var head = el("div", "dt-move-head");
        head.appendChild(el("span", "dt-move-name", move.name));
        if (isBest) head.appendChild(el("span", "dt-best-tag", "best"));
        row.appendChild(head);

        var metaText = move.isStatus
            ? "Status"
            : [meta ? meta.type : "?", meta ? meta.category : "?", "BP " + (meta ? meta.bp : "?")].join(" \u00b7 ");
        row.appendChild(el("div", "dt-move-meta muted small", metaText));

        if (!move.isStatus) {
            row.appendChild(el("div", "dt-move-dmg",
                move.min + "\u2013" + move.max + " (" + move.minPct + "\u2013" + move.maxPct + "%)"));
            row.appendChild(el("div", "dt-rolls small muted", "rolls: " + (move.rolls || []).join(", ")));
        }
        row.appendChild(el("div", "dt-kotext", move.koText || ""));
        return row;
    }

    function renderDetail(model, i, j) {
        var host = document.getElementById("detail-panel");
        if (!host) return;
        host.innerHTML = "";

        if (!model || !model.my[i] || !model.opp[j]) {
            host.appendChild(el("h2", null, "Detail"));
            host.appendChild(el("p", "empty muted", "Click a matrix cell to inspect a pairing."));
            return;
        }

        var mySet = model.my[i];
        var oppSet = model.opp[j];
        var pairing = model.pairings[i][j];

        var head = el("div", "dt-head");
        var left = el("div", "dt-head-side");
        left.appendChild(spriteForSet(mySet, model, false));
        left.appendChild(el("span", "dt-head-name", mySet.species));
        var vs = el("span", "dt-vs", "vs");
        var right = el("div", "dt-head-side");
        right.appendChild(spriteForSet(oppSet, model, true));
        right.appendChild(el("span", "dt-head-name", oppSet.species));
        head.appendChild(left);
        head.appendChild(vs);
        head.appendChild(right);

        var close = el("button", "btn btn-small dt-close", "Close");
        close.type = "button";
        close.addEventListener("click", function () {
            selected = null;
            markSelected();
            renderDetail(null, null, null);
        });
        head.appendChild(close);
        host.appendChild(head);

        var entry = (window.App && window.App.state.oppSpreads) ? window.App.state.oppSpreads[oppSet.species] : null;
        if (entry && entry.matched === false) {
            host.appendChild(el("div", "dt-badge-row badge", "assumed spread \u2014 no real usage data"));
        }

        var sets = el("div", "dt-sets");
        var myBox = el("div", "dt-set-box");
        myBox.appendChild(el("h3", null, "My set"));
        myBox.appendChild(setSummary(mySet));
        var oppBox = el("div", "dt-set-box");
        oppBox.appendChild(el("h3", null, "Their set"));
        oppBox.appendChild(setSummary(oppSet));
        sets.appendChild(myBox);
        sets.appendChild(oppBox);
        host.appendChild(sets);

        if (pairing.unknown) {
            host.appendChild(el("div", "warnings dt-warnings",
                "No data: one of these Pokemon is not in the damage engine's dex, so this pairing cannot be evaluated."));
            return;
        }

        if (pairing.result.warnings.length) {
            var warn = el("div", "warnings dt-warnings");
            pairing.result.warnings.forEach(function (w) { warn.appendChild(el("p", null, w)); });
            host.appendChild(warn);
        }

        var cols = el("div", "dt-cols");
        cols.appendChild(moveColumn("My attacks", pairing.result.mine.moves, pairing.myBest));
        cols.appendChild(moveColumn("Their attacks", pairing.result.theirs.moves, pairing.theirBest));
        host.appendChild(cols);
    }

    function moveColumn(title, moves, best) {
        var col = el("div", "dt-col");
        col.appendChild(el("h3", null, title));
        if (!moves || !moves.length) {
            col.appendChild(el("p", "empty muted small", "No moves available."));
            return col;
        }
        var bestName = best && best.move ? best.move.name : null;
        moves.forEach(function (move) {
            col.appendChild(moveRow(move, move.name === bestName));
        });
        return col;
    }

    function renderDetailFromSelection(model) {
        if (selected && model && model.my[selected.i] && model.opp[selected.j]) {
            renderDetail(model, selected.i, selected.j);
        } else {
            renderDetail(null, null, null);
        }
    }

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------

    window.Matrix = {
        buildModel: buildModel,
        render: render,
        renderDetail: renderDetail,
        renderDetailFromSelection: renderDetailFromSelection,
        analyzeMove: analyzeMove,
        bestMove: bestMove,
        offenseHeat: offenseHeat,
        defenseBadge: defenseBadge,
        speedOf: speedOf,
        clearCache: function () { cache.clear(); },
        getSelected: function () { return selected; },
    };
})();
