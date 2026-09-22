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

    // --- Lead-scoring weights (see rankLeads) ---
    // pressure: how hard the pair hits their whole team (best offense of the two).
    // safety:   how well the pair survives their whole team (mean defense of the two).
    // speed:    how often the pair moves first (both/one outspeeds each opponent).
    var W_LEAD_PRESSURE = 1.0;
    var W_LEAD_SAFETY = 0.5;
    var W_LEAD_SPEED = 0.8;

    // --- Lead tempo bonuses (flat, per lead pair; several can stack) ---
    // WHY: these are opening-move/ability advantages that the damage matrix
    // cannot see. Small, named, and deliberately weaker than a full KO tier.
    var TEMPO_FAKE_OUT = 1.5;      // Fake Out on either lead
    var TEMPO_INTIMIDATE = 1.0;    // Intimidate on either lead
    var TEMPO_REDIRECTION = 1.0;   // Follow Me / Rage Powder on either lead
    var TEMPO_TAILWIND = 1.0;      // Tailwind on either lead
    var TEMPO_TRICK_ROOM = 0.5;    // Trick Room on either lead

    var REDIRECTION_MOVES = ["Follow Me", "Rage Powder"];

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
     * Per-mon offense/defense vectors against each opponent. Entries are
     * ``null`` for unknown pairings (excluded from the sums). Shared by the
     * subset ranking and the lead ranking.
     * @param {object} model
     * @returns {object[]}
     */
    function buildPerMon(model) {
        var my = model.my || [];
        var oppCount = (model.opp || []).length;
        return my.map(function (set, i) {
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
    }

    /**
     * Rank every four-mon subset.
     * @param {object} model - from Matrix.buildModel
     * @returns {object} ranking result (see below)
     */
    function rank(model) {
        var my = model.my || [];
        var oppCount = (model.opp || []).length;
        var perMon = buildPerMon(model);

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
    // Lead scoring
    // ------------------------------------------------------------------

    /** True when the set carries the named move. */
    function hasMove(set, name) {
        return (set.moves || []).indexOf(name) !== -1;
    }

    /**
     * Flat tempo bonuses for one lead. Returns the total plus the human tags
     * that earned it, so the pair's reasons can name them.
     * @param {object} set
     * @returns {{total:number, tags:string[]}}
     */
    function tempoFor(set) {
        var total = 0;
        var tags = [];
        if (hasMove(set, "Fake Out")) { total += TEMPO_FAKE_OUT; tags.push("Fake Out pressure"); }
        if (set.ability === "Intimidate") { total += TEMPO_INTIMIDATE; tags.push("Intimidate"); }
        if (REDIRECTION_MOVES.some(function (m) { return hasMove(set, m); })) {
            total += TEMPO_REDIRECTION;
            tags.push("redirection");
        }
        if (hasMove(set, "Tailwind")) { total += TEMPO_TAILWIND; tags.push("Tailwind"); }
        if (hasMove(set, "Trick Room")) { total += TEMPO_TRICK_ROOM; tags.push("Trick Room"); }
        return { total: total, tags: tags };
    }

    /**
     * One short line per reason for the best lead pair.
     * @param {object} pair
     * @param {object[]} perMon
     * @param {object} model
     * @returns {string[]}
     */
    function leadReasons(pair, perMon, model) {
        var oppCount = (model.opp || []).length;
        var mySpeed = model.mySpeed || [];
        var oppSpeed = model.oppSpeed || [];
        var a = perMon[pair.indices[0]];
        var b = perMon[pair.indices[1]];
        var reasons = [];

        var bothOutspeed = 0;
        var oneOutspeeds = 0;
        var ties = [];
        for (var j = 0; j < oppCount; j++) {
            var sa = mySpeed[a.index];
            var sb = mySpeed[b.index];
            var so = oppSpeed[j];
            if (sa != null && so != null && sa === so) ties.push(model.opp[j].species);
            if (sb != null && so != null && sb === so) ties.push(model.opp[j].species);
            if (sa == null || sb == null || so == null) continue;
            var outs = (sa > so ? 1 : 0) + (sb > so ? 1 : 0);
            if (outs === 2) bothOutspeed++;
            if (outs >= 1) oneOutspeeds++;
        }
        if (bothOutspeed === oppCount && oppCount > 0) {
            reasons.push("outspeeds all " + oppCount);
        } else if (oneOutspeeds > 0) {
            reasons.push("outspeeds " + oneOutspeeds + " of " + oppCount);
        }

        var ohkos = 0;
        var survivesAll = oppCount > 0;
        for (var k = 0; k < oppCount; k++) {
            var bestOff = Math.max(a.offense[k] || 0, b.offense[k] || 0);
            if (bestOff >= 2.5) ohkos++;
            if ((a.defense[k] == null || a.defense[k] < 3) ||
                (b.defense[k] == null || b.defense[k] < 3)) {
                survivesAll = false;
            }
        }
        if (ohkos > 0) reasons.push("OHKOs " + ohkos + " of their mons");
        if (survivesAll) reasons.push("survives everything");

        tempoFor(a.set).tags.forEach(function (t) { if (reasons.indexOf(t) === -1) reasons.push(t); });
        tempoFor(b.set).tags.forEach(function (t) { if (reasons.indexOf(t) === -1) reasons.push(t); });

        ties.forEach(function (name) {
            var line = "Speed tie with " + name;
            if (reasons.indexOf(line) === -1) reasons.push(line);
        });
        return reasons;
    }

    /**
     * Rank the C(4,2) = 6 lead pairs drawn from the recommended 4.
     *
     * ASSUMPTION: their leads are unknown, so every pair is scored against ALL
     * of their Pokemon, not a presumed pair. Speed is the unboosted stat from
     * the model (no Tailwind / Trick Room / boosts).
     *
     * @param {object} model - from Matrix.buildModel
     * @param {object} subset - the recommended 4 (uses subset.indices)
     * @returns {{pairs:object[], best:(object|null), caveats:string[]}}
     */
    function rankLeads(model, subset) {
        var perMon = buildPerMon(model);
        var oppCount = (model.opp || []).length;
        var mySpeed = model.mySpeed || [];
        var oppSpeed = model.oppSpeed || [];

        var caveats = [
            "Speeds are unboosted: no Tailwind, Trick Room, or stat boosts are modelled.",
            "Their leads are unknown, so each pair is scored against all " + oppCount +
                " of their Pokemon.",
        ];
        var trickRoomUsers = (model.opp || []).filter(function (set) {
            return hasMove(set, "Trick Room");
        }).length;
        if (trickRoomUsers >= 2) {
            caveats.push("Their team has " + trickRoomUsers +
                " Trick Room users; Trick Room may invert the speed logic.");
        }

        var indices = (subset && subset.indices) ? subset.indices : [];
        // A lead we cannot evaluate must never be suggested: drop any mon with
        // unknown pairings or an entirely null offense/defense vector.
        var known = indices.map(function (i) { return perMon[i]; }).filter(function (m) {
            if (!m || m.unknownCount > 0) return false;
            var allNull = m.offense.every(function (p) { return p == null; }) &&
                m.defense.every(function (p) { return p == null; });
            return !allNull;
        });

        if (known.length < 2) {
            return { pairs: [], best: null, caveats: caveats };
        }

        var pairs = combinations(known.length, 2).map(function (combo) {
            var a = known[combo[0]];
            var b = known[combo[1]];
            var pressure = 0;
            var safety = 0;
            var speed = 0;
            var sa = mySpeed[a.index];
            var sb = mySpeed[b.index];
            for (var j = 0; j < oppCount; j++) {
                pressure += Math.max(a.offense[j] || 0, b.offense[j] || 0);
                safety += ((a.defense[j] || 0) + (b.defense[j] || 0)) / 2;
                var so = oppSpeed[j];
                if (sa == null || sb == null || so == null) continue;
                var outs = (sa > so ? 1 : 0) + (sb > so ? 1 : 0);
                if (outs === 2) speed += 1;
                else if (outs === 1) speed += 0.5;
            }
            var tempo = tempoFor(a.set).total + tempoFor(b.set).total;
            return {
                indices: [a.index, b.index],
                setA: a.set,
                setB: b.set,
                pressure: pressure,
                safety: safety,
                speed: speed,
                tempo: tempo,
                score: pressure * W_LEAD_PRESSURE + safety * W_LEAD_SAFETY +
                    speed * W_LEAD_SPEED + tempo,
                reasons: [],
            };
        });

        pairs.sort(function (x, y) {
            if (y.score !== x.score) return y.score - x.score;
            return y.pressure - x.pressure;
        });

        var best = pairs[0] || null;
        if (best) best.reasons = leadReasons(best, perMon, model);

        return { pairs: pairs, best: best, caveats: caveats };
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
        // Sort by contribution (bringScore desc), NOT team order: the bring
        // order carries no lead meaning, so most-valuable-first is the only
        // useful ordering.
        var byScore = result.perMon.slice().sort(function (a, b) {
            return b.bringScore - a.bringScore;
        });
        var rankOf = {};
        byScore.forEach(function (m, i) { rankOf[m.index] = i; });
        var ordered = result.reasons.slice().sort(function (x, y) {
            return rankOf[x.index] - rankOf[y.index];
        });
        ordered.forEach(function (item) {
            var row = el("div", "b4-pick-row");
            row.appendChild(el("span", "b4-pick-name", item.set.species));
            row.appendChild(el("span", "b4-pick-reason muted", item.reason));
            box.appendChild(row);
        });
        box.appendChild(el("p", "muted small",
            "Sorted by contribution to the bring, not by lead order."));
        return box;
    }

    /** One lead pair as a prominent card. */
    function leadCard(pair, label, prominent) {
        var card = el("div", "b4-lead" + (prominent ? " b4-lead-best" : ""));
        var head = el("div", "b4-lead-head");
        head.appendChild(el("span", "b4-lead-label", label));
        head.appendChild(el("span", "b4-lead-names",
            pair.setA.species + " + " + pair.setB.species));
        head.appendChild(el("span", "b4-lead-score", pair.score.toFixed(2)));
        card.appendChild(head);

        var chips = el("div", "b4-lead-reasons");
        pair.reasons.forEach(function (r) {
            chips.appendChild(el("span", "b4-chip", r));
        });
        card.appendChild(chips);

        card.appendChild(el("div", "b4-breakdown muted small",
            "pressure " + pair.pressure.toFixed(1) + " \u00d7 " + W_LEAD_PRESSURE +
            " + safety " + pair.safety.toFixed(1) + " \u00d7 " + W_LEAD_SAFETY +
            " + speed " + pair.speed.toFixed(1) + " \u00d7 " + W_LEAD_SPEED +
            " + tempo " + pair.tempo.toFixed(1) +
            " = " + pair.score.toFixed(2)));
        return card;
    }

    function renderLeads(leads) {
        var box = el("div", "b4-leads");
        box.appendChild(el("h3", null, "Suggested leads"));
        box.appendChild(el("p", "muted small",
            "The best 2 to open with, chosen from the recommended 4."));

        if (!leads || !leads.best) {
            box.appendChild(el("p", "empty muted small",
                "Need at least 2 evaluable Pokemon in the recommended bring to suggest leads."));
            return box;
        }

        box.appendChild(leadCard(leads.best, "Lead", true));
        if (leads.pairs[1]) {
            box.appendChild(leadCard(leads.pairs[1], "Alternative", false));
        }
        leads.caveats.forEach(function (c) {
            box.appendChild(el("p", "muted small b4-caveat", c));
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
        var leads = rankLeads(model, result.top);
        host.appendChild(renderLeads(leads));
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
        rankLeads: rankLeads,
        render: render,
        offensePoints: offensePoints,
        defensePoints: defensePoints,
        utilityScore: utilityScore,
        combinations: combinations,
        weights: {
            coverage: W_COVERAGE, threat: W_THREAT, utility: W_UTILITY,
            protect: W_PROTECT, redundancy: REDUNDANCY_PENALTY,
            leadPressure: W_LEAD_PRESSURE, leadSafety: W_LEAD_SAFETY,
            leadSpeed: W_LEAD_SPEED,
        },
    };
})();
