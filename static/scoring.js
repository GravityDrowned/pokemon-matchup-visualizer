/*
 * scoring.js -- Phase C2 best-4-of-6 recommendation heuristic.
 *
 * Loads BEFORE app.js and registers on window.Scoring. app.js's
 * renderMatchup() calls Scoring.render(model) after Matrix.render(model).
 *
 * This is a HEURISTIC, not a verdict. It ranks all C(n,4) four-mon subsets
 * using per-pairing offense/defense scores derived from the matrix model
 * (window.Matrix.analyzeMove / bestMove), so the numbers always match the
 * heatmap. All weights are named constants below and are meant to be tuned.
 */

(function () {
    "use strict";

    // --- Tunable weights (documented; change these to re-tune the heuristic) ---
    var W_COVERAGE = 1.0;          // weight on "does the subset answer everything?"
    var W_THREAT = 0.5;            // weight on "how well does the subset survive?"
    var W_UTILITY = 0.15;          // per priority move (tiebreaker only)
    var W_PROTECT = 0.25;          // having Protect (tiebreaker only)
    var REDUNDANCY_PENALTY = 0.5;  // per pair sharing a primary type or item

    // Penalty applied to any subset that includes a Pokemon with unevaluated
    // pairings. Large enough that a fully resolvable subset always beats one
    // containing an unknown Pokemon, but not so large it overflows.
    // WHY: an unknown Pokemon must never be recommended just because the
    // engine could not score it (HIGH-1).
    var UNKNOWN_PENALTY = 1000;

    // Offense points by how few hits my best move needs to KO an opponent.
    var OFFENSE_POINTS = {
        ohko: 3,          // guaranteed OHKO
        ohkoRoll: 2.5,    // possible OHKO
        hko2: 2,
        hko3: 1,
        hko4: 0.5,
        none: 0,
    };

    // Defense points by how badly an opponent threatens me.
    var DEFENSE_POINTS = {
        ohko: 0,          // they guaranteed-OHKO me
        ohkoRoll: 0.5,
        hko2: 1,
        hko3: 2,
        hko4: 3,
        none: 3,          // they cannot damage me
    };

    // ------------------------------------------------------------------
    // Scoring primitives
    // ------------------------------------------------------------------

    /** Map a KO analysis object to an offense-point tier. */
    function offenseTier(ko) {
        if (!ko || !ko.damaging) return "none";
        if (ko.minHits <= 1) return ko.guaranteed ? "ohko" : "ohkoRoll";
        if (ko.minHits === 2) return "hko2";
        if (ko.minHits === 3) return "hko3";
        return "hko4";
    }

    /** Map a KO analysis object (against me) to a defense-point tier. */
    function defenseTier(ko) {
        if (!ko || !ko.damaging) return "none";
        if (ko.minHits <= 1) return ko.guaranteed ? "ohko" : "ohkoRoll";
        if (ko.minHits === 2) return "hko2";
        if (ko.minHits === 3) return "hko3";
        return "hko4";
    }

    function offensePoints(ko) { return OFFENSE_POINTS[offenseTier(ko)]; }
    function defensePoints(ko) { return DEFENSE_POINTS[defenseTier(ko)]; }

    /**
     * Offense points for a pairing, or ``null`` when the pairing is unknown.
     *
     * An unknown pairing (engine could not build one of the two Pokemon) is
     * deliberately NOT scored as "no damaging move": that would award the
     * best-case offense/defense value for missing data. ``null`` means
     * "excluded from the sums", so it neither rewards nor punishes the mon.
     */
    function offensePointsFor(pairing) {
        if (pairing && pairing.unknown) return null;
        return offensePoints(pairing && pairing.myBest ? pairing.myBest.ko : null);
    }

    /** Defense points for a pairing, or ``null`` when the pairing is unknown. */
    function defensePointsFor(pairing) {
        if (pairing && pairing.unknown) return null;
        return defensePoints(pairing && pairing.theirBest ? pairing.theirBest.ko : null);
    }

    /** Sum a vector that may contain nulls (nulls contribute nothing). */
    function sumKnown(values) {
        return values.reduce(function (a, b) { return a + (b == null ? 0 : b); }, 0);
    }

    /** Small utility score: priority moves + Protect. */
    function utilityScore(set) {
        var score = 0;
        (set.moves || []).forEach(function (name) {
            var data = window.moves ? window.moves[name] : null;
            if (data && data.isPriority) score += W_UTILITY;
            if (name === "Protect") score += W_PROTECT;
        });
        return score;
    }

    /** Primary type via the engine dex, or "" when unknown. */
    function primaryType(species) {
        if (!window.CalcEngine || !window.CalcEngine.ready) return "";
        var key = window.CalcEngine.resolveSpecies(species);
        var dex = key && window.pokedex ? window.pokedex[key] : null;
        return (dex && dex.t1) || "";
    }

    /** All C(n, k) index combinations. */
    function combinations(n, k) {
        var out = [];
        (function walk(start, picked) {
            if (picked.length === k) { out.push(picked.slice()); return; }
            for (var i = start; i < n; i++) {
                picked.push(i);
                walk(i + 1, picked);
                picked.pop();
            }
        })(0, []);
        return out;
    }

    // ------------------------------------------------------------------
    // Ranking
    // ------------------------------------------------------------------

    /**
     * Rank every four-mon subset.
     * @param {object} model - from Matrix.buildModel
     * @returns {object} ranking result (see below)
     */
    function rank(model) {
        var my = model.my || [];
        var oppCount = (model.opp || []).length;

        // Per-mon offense/defense vectors against each opponent. Entries are
        // ``null`` for unknown pairings (excluded from the sums).
        var perMon = my.map(function (set, i) {
            var offense = [];
            var defense = [];
            var unknownCount = 0;
            for (var j = 0; j < oppCount; j++) {
                var pairing = model.pairings[i][j];
                var off = offensePointsFor(pairing);
                var def = defensePointsFor(pairing);
                if (off == null || def == null) unknownCount++;
                offense.push(off);
                defense.push(def);
            }
            var offenseSum = sumKnown(offense);
            var defenseSum = sumKnown(defense);
            var utility = utilityScore(set);
            return {
                index: i,
                set: set,
                offense: offense,
                defense: defense,
                offenseSum: offenseSum,
                defenseSum: defenseSum,
                unknownCount: unknownCount,
                utility: utility,
                bringScore: offenseSum + defenseSum + utility,
                type: primaryType(set.species),
                item: set.item || "",
            };
        });

        var subsets = combinations(my.length, 4).map(function (idxs) {
            var coverage = 0;
            var threat = 0;
            var unknownCount = 0;
            for (var j = 0; j < oppCount; j++) {
                var best = null;
                var sum = 0;
                var known = 0;
                idxs.forEach(function (i) {
                    var off = perMon[i].offense[j];
                    var def = perMon[i].defense[j];
                    if (off == null || def == null) { unknownCount++; return; }
                    best = best == null ? off : Math.max(best, off);
                    sum += def;
                    known++;
                });
                // Unknown pairings are excluded from both sums rather than
                // counted as zero (which would punish) or as best-case (which
                // would reward). The UNKNOWN_PENALTY below is what stops a
                // missing-data Pokemon from being recommended.
                if (best != null) coverage += best;
                if (known) threat += sum / known;
            }
            var redundancy = 0;
            for (var a = 0; a < idxs.length; a++) {
                for (var b = a + 1; b < idxs.length; b++) {
                    var ma = perMon[idxs[a]];
                    var mb = perMon[idxs[b]];
                    if ((ma.type && ma.type === mb.type) || (ma.item && ma.item === mb.item)) {
                        redundancy += REDUNDANCY_PENALTY;
                    }
                }
            }
            var utility = idxs.reduce(function (t, i) { return t + perMon[i].utility; }, 0);
            return {
                indices: idxs,
                coverage: coverage,
                threat: threat,
                redundancy: redundancy,
                utility: utility,
                unknownCount: unknownCount,
                score: coverage * W_COVERAGE + threat * W_THREAT - redundancy -
                    unknownCount * UNKNOWN_PENALTY,
            };
        });

        subsets.sort(function (x, y) {
            if (y.score !== x.score) return y.score - x.score;
            return y.utility - x.utility;
        });

        var top = subsets[0] || null;
        return {
            perMon: perMon,
            subsets: subsets,
            top: top,
            reasons: top ? buildReasons(top, perMon, model) : [],
            weights: {
                coverage: W_COVERAGE, threat: W_THREAT, utility: W_UTILITY,
                protect: W_PROTECT, redundancy: REDUNDANCY_PENALTY,
            },
        };
    }

    /**
     * One-line reasons for the #1 subset's four Pokemon.
     * @param {object} subset
     * @param {object[]} perMon
     * @param {object} model
     * @returns {object[]} [{index, set, reason}]
     */
    function buildReasons(subset, perMon, model) {
        var oppCount = (model.opp || []).length;
        var chosen = subset.indices;

        // For each opponent, which chosen mon answers it best (and is it unique
        // among ALL my mons?).
        var bestOverall = [];
        var uniqueAnswer = {};
        for (var j = 0; j < oppCount; j++) {
            var allBest = 0;
            perMon.forEach(function (m) { allBest = Math.max(allBest, m.offense[j]); });
            bestOverall.push(allBest);
            var holders = perMon.filter(function (m) { return m.offense[j] === allBest && allBest >= 2; });
            if (holders.length === 1) uniqueAnswer[holders[0].index] = model.opp[j].species;
        }

        return chosen.map(function (i) {
            var mon = perMon[i];
            var ohkos = mon.offense.filter(function (p) { return p >= 2.5; }).length;
            var safe = mon.defense.filter(function (p) { return p >= 3; }).length;
            var reason;
            if (mon.unknownCount) {
                reason = "no data for " + mon.unknownCount + " matchup" +
                    (mon.unknownCount === 1 ? "" : "s") + " \u2014 not recommended";
            } else if (uniqueAnswer[i]) {
                reason = "only answer to " + uniqueAnswer[i];
            } else if (ohkos >= 3) {
                reason = "OHKOs " + ohkos + " of their mons";
            } else if (safe === oppCount && oppCount > 0) {
                reason = "survives everything";
            } else if (ohkos > 0) {
                reason = "OHKOs " + ohkos + " of their mons";
            } else {
                reason = "solid coverage / bulk";
            }
            return { index: i, set: mon.set, reason: reason, unknownCount: mon.unknownCount };
        });
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = String(text);
        return node;
    }

    function subsetLabel(subset, perMon) {
        return subset.indices.map(function (i) { return perMon[i].set.species; }).join(", ");
    }

    function scoreBreakdown(subset) {
        return "coverage " + subset.coverage.toFixed(1) + " \u00d7 " + W_COVERAGE +
            " + threat " + subset.threat.toFixed(1) + " \u00d7 " + W_THREAT +
            (subset.redundancy ? " \u2212 redundancy " + subset.redundancy.toFixed(1) : "") +
            " = " + subset.score.toFixed(2);
    }

    function renderTopSubsets(result, perMon) {
        var box = el("div", "b4-top");
        box.appendChild(el("h3", null, "Top 3 subsets"));
        result.subsets.slice(0, 3).forEach(function (subset, rank) {
            var row = el("div", "b4-subset" + (rank === 0 ? " b4-subset-top" : ""));
            var head = el("div", "b4-subset-head");
            head.appendChild(el("span", "b4-rank", "#" + (rank + 1)));
            head.appendChild(el("span", "b4-subset-names", subsetLabel(subset, perMon)));
            head.appendChild(el("span", "b4-score", subset.score.toFixed(2)));
            row.appendChild(head);
            row.appendChild(el("div", "b4-breakdown muted small", scoreBreakdown(subset)));
            box.appendChild(row);
        });
        return box;
    }

    function renderTopPick(result) {
        var box = el("div", "b4-pick");
        box.appendChild(el("h3", null, "Recommended bring"));
        result.reasons.forEach(function (item) {
            var row = el("div", "b4-pick-row");
            row.appendChild(el("span", "b4-pick-name", item.set.species));
            row.appendChild(el("span", "b4-pick-reason muted", item.reason));
            box.appendChild(row);
        });
        return box;
    }

    function renderTable(result) {
        var box = el("div", "b4-table-wrap");
        box.appendChild(el("h3", null, "Per-Pokemon scores"));
        var table = el("table", "b4-table");
        var thead = el("thead");
        var hrow = el("tr");
        ["Pokemon", "Offense", "Defense", "Bring"].forEach(function (label) {
            hrow.appendChild(el("th", null, label));
        });
        thead.appendChild(hrow);
        table.appendChild(thead);

        var chosen = {};
        if (result.top) result.top.indices.forEach(function (i) { chosen[i] = true; });

        var tbody = el("tbody");
        result.perMon.slice().sort(function (a, b) { return b.bringScore - a.bringScore; })
            .forEach(function (mon) {
                var tr = el("tr", chosen[mon.index] ? "b4-chosen" : "");
                var name = el("td", null, mon.set.species);
                if (chosen[mon.index]) name.appendChild(el("span", "b4-check", "\u2713"));
                if (mon.unknownCount) {
                    name.appendChild(el("span", "b4-unknown", "\u26a0 no data"));
                }
                tr.appendChild(name);
                tr.appendChild(el("td", null, mon.offenseSum.toFixed(1)));
                tr.appendChild(el("td", null, mon.defenseSum.toFixed(1)));
                tr.appendChild(el("td", null, mon.bringScore.toFixed(2)));
                tbody.appendChild(tr);
            });
        table.appendChild(tbody);
        box.appendChild(table);
        return box;
    }

    /** Compact summary for the sidebar placeholder. */
    function renderSidebar(result, message) {
        var host = document.getElementById("best4-sidebar");
        if (!host) return;
        host.innerHTML = "";
        host.className = "b4-sidebar";

        if (!result || !result.top) {
            host.appendChild(el("p", "empty muted small",
                message || "Best-4 suggestions appear once both teams are loaded."));
            return;
        }
        host.appendChild(el("p", "b4-sidebar-names", subsetLabel(result.top, result.perMon)));
        host.appendChild(el("p", "muted small", "score " + result.top.score.toFixed(2) +
            " \u00b7 coverage " + result.top.coverage.toFixed(1) +
            " \u00b7 threat " + result.top.threat.toFixed(1)));
    }

    /**
     * Render the best-4 panel and sidebar. Returns the ranking result.
     * @param {object} model
     * @returns {object|null}
     */
    function render(model) {
        var host = document.getElementById("best4-panel");
        if (!host) return null;
        host.innerHTML = "";

        if (!model || !model.my.length || !model.opp.length) {
            host.appendChild(el("h2", null, "Best 4"));
            host.appendChild(el("p", "empty muted", "Load my team and select an opponent team to see recommendations."));
            renderSidebar(null);
            return null;
        }
        if (model.my.length < 4) {
            host.appendChild(el("h2", null, "Best 4"));
            host.appendChild(el("p", "empty muted",
                "Best 4 needs at least 4 Pokemon on my team (currently " + model.my.length + ")."));
            renderSidebar(null, "Need at least 4 Pokemon on my team.");
            return null;
        }

        var result = rank(model);
        host.appendChild(el("h2", null, "Best 4"));
        host.appendChild(el("p", "muted small",
            "Heuristic recommendation only \u2014 not a verdict. Weights: coverage \u00d7 " + W_COVERAGE +
            " + threat \u00d7 " + W_THREAT + ", minus " + REDUNDANCY_PENALTY +
            " for each shared primary type/item."));

        var unresolved = result.perMon.filter(function (m) { return m.unknownCount; });
        if (unresolved.length) {
            var names = unresolved.map(function (m) { return m.set.species; }).join(", ");
            host.appendChild(el("div", "warnings",
                "No data for: " + names + ". The damage engine cannot evaluate these, " +
                "so they are excluded from scoring and will not be recommended."));
        }

        host.appendChild(renderTopPick(result));
        host.appendChild(renderTopSubsets(result, result.perMon));
        host.appendChild(renderTable(result));
        renderSidebar(result);
        return result;
    }

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------

    window.Scoring = {
        rank: rank,
        render: render,
        offensePoints: offensePoints,
        defensePoints: defensePoints,
        utilityScore: utilityScore,
        combinations: combinations,
        weights: {
            coverage: W_COVERAGE, threat: W_THREAT, utility: W_UTILITY,
            protect: W_PROTECT, redundancy: REDUNDANCY_PENALTY,
        },
    };
})();
