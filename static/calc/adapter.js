/*
 * adapter.js -- turns our normalized set objects into the vendored NCP engine's
 * p1/p2/field objects, runs the calc, and returns a tidy result.
 *
 * WHY THIS FILE EXISTS
 * The vendored engine (static/calc/vendor/) is a set of global-scope scripts.
 * scaffold.js wires up its globals and exposes `window.CalcEngine`. This file
 * layers a small, DOM-free, normalized API on top of it:
 *
 *     CalcEngine.buildPokemon(set)                 -> engine pokemon object
 *     CalcEngine.buildField(config)                -> engine field object
 *     CalcEngine.calcSide(atk, def, fieldConfig)   -> { moves: [...] }
 *     CalcEngine.calcMatchup(my, opp, fieldConfig) -> { mine, theirs, warnings }
 *
 * Load order: jQuery, the data files, the damage files, ko_chance.js,
 * scaffold.js, then this file.
 *
 * NO DOM IS REQUIRED. `field.getSide(i)` returns a plain object; the engine's
 * only DOM reads are jQuery lookups on ids that simply do not exist here, which
 * resolve to empty jQuery sets (falsy) rather than throwing.
 */

(function () {
    "use strict";

    var w = window;
    var CalcEngine = w.CalcEngine;
    if (!CalcEngine) {
        throw new Error("adapter.js: CalcEngine is missing; load scaffold.js first");
    }

    var STATS = w.STATS;                 // ["at","df","sa","sd","sp"]
    var NATURES = w.NATURES;             // { Timid: ["sp","at"], ... }
    var pokedex = w.pokedex;
    var moves = w.moves;
    var items = w.items;
    var abilities = w.abilities;

    // ---------------------------------------------------------------------
    // Stat computation (gen-10 "Champions", level forced to 50, SP-based)
    // ---------------------------------------------------------------------
    //
    // The vendored CALC_HP_CHAMP / CALC_STAT_CHAMP (stat_data.js) are DOM-based:
    // they read `.val()` off jQuery elements. We reproduce their arithmetic
    // exactly. Confirmed against stat_data.js:92-119:
    //
    //   HP   = floor((base*2 + 31) * 50 / 100) + 50 + 10 + sps   (base === 1 -> 1)
    //   stat = floor((floor((base*2 + 31) * 50 / 100) + 5 + sps) * natureMod)
    //
    // The `base === 1 -> 1` HP case is Shedinja; CALC_HP_CHAMP special-cases it.
    // The nature multiplier is 1.1 for the nature's raised stat, 0.9 for the
    // lowered stat, else 1 (nature_data.js shape: { Name: [raised, lowered] }).

    /**
     * Gen-10 HP from a base stat and HP Stat Points.
     * @param {number} base - base HP stat
     * @param {number} sps - HP Stat Points (0..32)
     * @returns {number} max HP
     */
    function champHP(base, sps) {
        if (base === 1) return 1;
        return Math.floor((base * 2 + 31) * 50 / 100) + 50 + 10 + sps;
    }

    /**
     * Gen-10 non-HP stat from base, Stat Points and nature.
     * @param {number} base - base stat
     * @param {number} sps - Stat Points (0..32)
     * @param {string} nature - nature name (key into NATURES)
     * @param {string} stat - "at"|"df"|"sa"|"sd"|"sp"
     * @returns {number} final stat
     */
    function champStat(base, sps, nature, stat) {
        var mods = NATURES[nature] || ["", ""];
        var mod = mods[0] === stat ? 1.1 : mods[1] === stat ? 0.9 : 1;
        return Math.floor(((Math.floor((base * 2 + 31) * 50 / 100) + 5) + sps) * mod);
    }

    // ---------------------------------------------------------------------
    // Moves
    // ---------------------------------------------------------------------

    /**
     * Reproduce ap_calc.js `showHits`/`setHitsVal` default hit counts for
     * multi-hit moves. Gen-10 is not Legends Z-A, so `isPlusMove` is false.
     * @param {object} moveData - raw entry from `moves`
     * @param {string} ability - attacker ability (Skill Link)
     * @param {string} item - attacker item (Loaded Dice)
     * @returns {number} number of hits
     */
    function defaultHits(moveData, ability, item) {
        var hr = moveData.hitRange;
        if (!hr) return 1;
        if (typeof hr === "number") return hr;
        if (hr[0] === 2 && hr[1] === 5) {
            if (ability === "Skill Link") return 5;
            if (item === "Loaded Dice") return 4;
            return 3;
        }
        if (hr[0] === 1 && hr[1] === 2) return 1;   // Dragon Darts
        if (hr[0] === 1 && hr[1] === 6) return 4;   // Beat Up
        return hr[1];
    }

    /**
     * Build an engine move object from a move name.
     * Mirrors ap_calc.js `getMoveDetails`: spread the raw move data, then
     * override the fields the engine reads. `isCrit` follows `alwaysCrit`.
     * @param {string} name - move name
     * @param {string} ability - attacker ability
     * @param {string} item - attacker item
     * @returns {object} engine move object
     */
    function buildMove(name, ability, item) {
        var base = moves[name];
        return $.extend({}, base, {
            name: name,
            bp: base.bp || 0,
            type: base.type,
            category: base.category,
            isCrit: base.alwaysCrit === true,
            isZ: false,
            hits: defaultHits(base, ability, item),
            isDouble: 0,
            combinePledge: 0,
            timesAffected: 0,
            usedOppMoveIndex: 0,
            getsStellarBoost: false,
            isPlusMove: false,
        });
    }

    // ---------------------------------------------------------------------
    // Pokemon
    // ---------------------------------------------------------------------

    /**
     * Build an engine `p1`/`p2` pokemon object from one of our normalized sets.
     *
     * Set shape:
     *   { species, level, nature, ability, item, teraType,
     *     sps: {hp,at,df,sa,sd,sp}, moves: [name, ...] }
     *
     * Unknown species throws (the caller cannot recover). Unknown moves, items
     * and abilities are reported through the optional `warnings` array and
     * degrade gracefully: unknown moves are skipped, unknown items/abilities
     * simply have no engine effect.
     *
     * MEGA CONVENTION: our sets already name the Mega forme (e.g.
     * "Salamence-Mega") and carry the Mega Stone as the item. The engine does
     * NOT activate Megas from the item; it treats the named species as-is and
     * applies the set's ability/item directly. So there is nothing to "turn on".
     *
     * @param {object} set - normalized set
     * @param {string[]} [warnings] - optional array to collect warning strings
     * @returns {object} engine pokemon object
     */
    function buildPokemon(set, warnings) {
        warnings = warnings || [];

        var dexKey = CalcEngine.resolveSpecies(set.species);
        if (!dexKey) {
            throw new Error("unknown species: " + set.species);
        }
        var dex = pokedex[dexKey];

        var nature = set.nature || "Serious";
        if (!NATURES[nature]) {
            warnings.push("unknown nature \"" + nature + "\" for " + dexKey + "; using Serious");
            nature = "Serious";
        }

        var ability = set.ability || "";
        if (ability && !CalcEngine.hasAbility(ability)) {
            warnings.push("unknown ability \"" + ability + "\" on " + dexKey);
        }

        var item = set.item || "";
        if (item && !CalcEngine.hasItem(item)) {
            warnings.push("unknown item \"" + item + "\" on " + dexKey);
        }

        var sps = set.sps || {};
        var rawStats = {};
        var engineSps = {};
        var boosts = {};
        STATS.forEach(function (stat) {
            engineSps[stat] = sps[stat] || 0;
            boosts[stat] = 0;
            rawStats[stat] = champStat(dex.bs[stat], engineSps[stat], nature, stat);
        });
        var hpSps = sps.hp || 0;
        var maxHP = champHP(dex.bs.hp, hpSps);

        var engineMoves = [];
        (set.moves || []).forEach(function (name) {
            if (!CalcEngine.hasMove(name)) {
                warnings.push("unknown move \"" + name + "\" on " + dexKey + "; skipped");
                return;
            }
            engineMoves.push(buildMove(name, ability, item));
        });

        // The engine indexes moves[0..3]; pad with "(No Move)" so missing
        // slots are inert rather than undefined.
        while (engineMoves.length < 4) {
            engineMoves.push(buildMove("(No Move)", ability, item));
        }

        return {
            name: dexKey,
            type1: dex.t1,
            // Single-type dex entries omit t2 entirely (e.g. Audino). The
            // engine treats type2 === "" as "no second type" and also guards
            // type2 !== type1, so "" is the correct sentinel.
            type2: dex.t2 || "",
            tera_type: set.teraType || "",
            level: 50,
            maxHP: maxHP,
            curHP: maxHP,
            HPSPs: hpSps,
            HPEVs: 0,
            HPIVs: 31,
            HPraw: maxHP,
            isDynamax: false,
            gmax_factor: false,
            // Terastallization is opt-in. A set carrying a teraType is NOT
            // automatically Terastallized: `terastallized` must be true (the
            // UI exposes a per-Pokemon checkbox). This avoids silently applying
            // Tera STAB/type in every calc, including defensive ones.
            isTerastalize: set.terastallized === true,
            rawStats: rawStats,
            boosts: boosts,
            stats: {},
            sps: engineSps,
            evs: {},
            ivs: {},
            nature: nature,
            ability: ability,
            // VGC abilities (Intimidate, Defiant, ...) are active by default.
            abilityOn: set.abilityOn !== undefined ? set.abilityOn : true,
            supremeOverlord: 0,
            rivalryGender: "",
            highestStat: -1,
            item: item,
            status: set.status || "Healthy",
            toxicCounter: 0,
            moves: engineMoves,
            glaiveRushMod: false,
            // Weight comes from the dex entry and is what Low Kick / Grass Knot
            // read (via getWeightMods -> basePowerFunc). Mega formes have their
            // own weight (e.g. "Mega Salamence" = 112.6).
            weight: dex.w,
            canEvolve: dex.canEvolve || false,
            isTransformed: false,
            hasType: CalcEngine.setHasType,
        };
    }

    // ---------------------------------------------------------------------
    // Field / Side
    // ---------------------------------------------------------------------

    /**
     * Build a Side object. A Side is the per-side battle state the engine reads
     * while calculating one attack. It is a plain object (no DOM).
     *
     * SIDE INDEXING (verified empirically): `CALCULATE_ALL_MOVES_SV(p1, p2, field)`
     * computes p1's moves against `field.getSide(1)` and p2's moves against
     * `field.getSide(0)`. That Side is the DEFENDER's side: it carries the
     * screens/hazards/Protect that protect the defender, plus the attacker's
     * Helping Hand/Battery/etc. (the UI reverses those arrays when building it).
     * We always call it as `calcAllMoves(attacker, defender, field)` with the
     * attacker as p1, so the attacker's moves use `getSide(1)`, and the KO text
     * must be handed that same Side object.
     * Config mapping (attacker is always p1 here):
     *   - `reflect`/`lightScreen` protect the defender.
     *   - `helpingHand` aids the attacker.
     *   - `tailwind` is read via `getTailwind(0)`, the attacker's tailwind.
     * `weather`/`terrain` are copied onto each Side because the engine reads
     * them off the Side, not the Field, during damage/KO math.
     *
     * @param {object} state - shared field state (weather, terrain, flags)
     * @returns {object} plain Side object with every field the engine reads
     */
    function buildSide(state) {
        return {
            format: state.format,
            terrain: state.terrain,
            weather: state.weather,
            isGravity: state.isGravity,
            isSR: false,
            spikes: 0,
            isReflect: state.reflect,
            isLightScreen: state.lightScreen,
            isForesight: false,
            isHelpingHand: state.helpingHand,
            isFriendGuard: false,
            isBattery: false,
            isProtect: false,
            isPowerSpot: false,
            isSteelySpirit: false,
            isNeutralizingGas: state.isNeutralizingGas,
            isGMaxField: false,
            isFlowerGiftSpD: false,
            isFlowerGiftAtk: false,
            isTailwind: state.tailwind,
            isSaltCure: false,
            isAuroraVeil: false,
            isSwamp: false,
            isSeaFire: false,
            isRedItem: false,
            isBlueItem: false,
            isCharge: false,
            isLeechSeed: false,
            isIngrain: false,
            isCurse: false,
            isBinding: false,
            isAquaRing: false,
            isNightmare: false,
        };
    }

    /**
     * Build an engine `field` object from our field config.
     *
     * Config shape:
     *   { weather: ""|"Sun"|"Rain"|"Sand"|"Snow",
     *     terrain: ""|"Electric"|"Grassy"|"Misty"|"Psychic",
     *     reflect, lightScreen, tailwind, helpingHand: boolean }
     *
     * Interpretation (documented so the UI and the math agree):
     *   - `reflect`/`lightScreen` protect the DEFENDER.
     *   - `helpingHand`/`tailwind` aid the ATTACKER.
     * Because we always pass the attacker as p1, `calcMatchup` interprets the
     * same config symmetrically in both directions.
     *
     * @param {object} [config] - field config
     * @returns {object} engine field object
     */
    function buildField(config) {
        config = config || {};

        var state = {
            format: "Doubles",
            weather: config.weather || "",
            terrain: config.terrain || "",
            isGravity: false,
            isNeutralizingGas: false,
            reflect: !!config.reflect,
            lightScreen: !!config.lightScreen,
            tailwind: !!config.tailwind,
            helpingHand: !!config.helpingHand,
        };

        return {
            format: state.format,
            weather: state.weather,
            terrain: state.terrain,
            isGravity: state.isGravity,
            isIngrain: false,
            isNeutralizingGas: state.isNeutralizingGas,
            getNeutralGas: function () { return state.isNeutralizingGas; },
            getWeather: function () { return state.weather; },
            getTerrain: function () { return state.terrain; },
            getTailwind: function (i) { return i === 0 ? state.tailwind : false; },
            getSwamp: function () { return false; },
            getSide: function (i) {
                // Both sides carry the screens/helping-hand flags; the engine
                // only reads the ones relevant to the role it is computing.
                return buildSide(state);
            },
            clearWeather: function () { state.weather = this.weather = ""; },
        };
    }

    // ---------------------------------------------------------------------
    // Result shaping
    // ---------------------------------------------------------------------

    /**
     * Flatten an engine damage value into a sorted list of per-roll TOTALS.
     *
     * Single-hit moves return a flat array of 16 rolls. Multi-hit moves also
     * return a flat array, but each entry is ONE hit's damage; the engine's KO
     * helper multiplies by `move.hits` itself. Additional-calc cases (Multiscale,
     * resist berries, stat-changing hits) return an array of arrays, one per
     * unique hit. We sum across hits (reusing the last array for any remaining
     * hits, matching ko_chance.js `damageArrToDict`) so `min`/`max`/percentages
     * reflect the whole move.
     *
     * @param {number[]|number[][]} damage - engine damage value
     * @param {number} hits - number of hits the move makes
     * @returns {number[]} total damage per roll
     */
    function normalizeRolls(damage, hits) {
        if (!Array.isArray(damage)) return [damage];
        if (damage.length === 0) return [];
        hits = hits && hits > 0 ? hits : 1;

        var is2d = Array.isArray(damage[0]);
        var perRoll = is2d ? damage[0].length : damage.length;
        var totals = [];
        for (var i = 0; i < perRoll; i++) {
            var sum = 0;
            if (is2d) {
                for (var h = 0; h < hits; h++) {
                    var arr = damage[Math.min(h, damage.length - 1)];
                    sum += arr[Math.min(i, arr.length - 1)];
                }
            } else {
                sum = damage[i] * hits;
            }
            totals.push(sum);
        }
        // Ascending so min/max map to rolls[0] / rolls[last].
        totals.sort(function (a, b) { return a - b; });
        return totals;
    }

    /**
     * Round to one decimal place.
     * @param {number} n
     * @returns {number}
     */
    function round1(n) {
        return Math.round(n * 10) / 10;
    }

    /**
     * Shape one engine move result into our tidy move record.
     * @param {object} move - engine move object
     * @param {object} result - engine { damage, description }
     * @param {object} defender - engine defender pokemon
     * @param {object} defenderSide - the defender's Side (for KO text)
     * @param {boolean} isItemlessAttacker - attacker has no item
     * @returns {object} tidy move record
     */
    function shapeMove(move, result, defender, defenderSide, isItemlessAttacker) {
        var isStatus = move.category === "Status";
        var rolls = isStatus ? [] : normalizeRolls(result.damage, move.hits);
        var min = rolls.length ? rolls[0] : 0;
        var max = rolls.length ? rolls[rolls.length - 1] : 0;

        // getKOChanceText's 4th parameter is a Side object (the defender's),
        // NOT the Field -- despite the source naming it `field`.
        var koText = CalcEngine.getKOChanceText(
            result.damage, move, defender, defenderSide, false, isItemlessAttacker
        );

        return {
            name: move.name,
            category: move.category,
            bp: move.bp,
            min: min,
            max: max,
            minPct: round1(min / defender.maxHP * 100),
            maxPct: round1(max / defender.maxHP * 100),
            rolls: rolls,
            koText: koText,
            isStatus: isStatus,
        };
    }

    /**
     * Run one direction: attacker's moves against defender.
     * @param {object} attackerSet - normalized set
     * @param {object} defenderSet - normalized set
     * @param {object} fieldConfig - field config
     * @param {string[]} warnings - collector
     * @returns {object[]} tidy move records
     */
    function runSide(attackerSet, defenderSet, fieldConfig, warnings) {
        // Fresh objects every call: the engine mutates pokemon (boosts, item
        // consumption, type changes), so directions must not share state.
        var attacker = buildPokemon(attackerSet, warnings);
        var defender = buildPokemon(defenderSet, warnings);
        var field = buildField(fieldConfig);

        var results = CalcEngine.calcAllMoves(attacker, defender, field);
        var attackerResults = results[0];

        // Only report the moves the set actually declared; the trailing
        // "(No Move)" padding exists solely to satisfy the engine's 4-slot loop.
        var realCount = (attackerSet.moves || []).filter(function (name) {
            return CalcEngine.hasMove(name);
        }).length;

        var out = [];
        for (var i = 0; i < realCount; i++) {
            out.push(shapeMove(
                attacker.moves[i],
                attackerResults[i],
                defender,
                field.getSide(1),   // defender's side (same Side used in the calc)
                !attacker.item
            ));
        }
        return out;
    }

    /**
     * Calculate one side's moves against the other.
     * @param {object} attackerSet - normalized set
     * @param {object} defenderSet - normalized set
     * @param {object} fieldConfig - field config
     * @returns {{moves: object[]}} tidy result for the attacker's moves
     */
    function calcSide(attackerSet, defenderSet, fieldConfig) {
        var warnings = [];
        return { moves: runSide(attackerSet, defenderSet, fieldConfig, warnings) };
    }

    /**
     * Calculate both directions of a matchup, resilient to unknown data.
     * Unknown species/move/item/ability never throw; they add a warning and
     * degrade gracefully (unknown moves are skipped).
     * @param {object} mySet - normalized set
     * @param {object} oppSet - normalized set
     * @param {object} fieldConfig - field config
     * @returns {{mine: object, theirs: object, warnings: string[]}}
     */
    function calcMatchup(mySet, oppSet, fieldConfig) {
        var warnings = [];

        var mine = [];
        try {
            mine = runSide(mySet, oppSet, fieldConfig, warnings);
        } catch (err) {
            warnings.push("mine: " + err.message);
        }

        var theirs = [];
        try {
            theirs = runSide(oppSet, mySet, fieldConfig, warnings);
        } catch (err) {
            warnings.push("theirs: " + err.message);
        }

        return {
            mine: { moves: mine },
            theirs: { moves: theirs },
            warnings: warnings,
        };
    }

    // ---------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------

    CalcEngine.buildPokemon = buildPokemon;
    CalcEngine.buildField = buildField;
    CalcEngine.calcSide = calcSide;
    CalcEngine.calcMatchup = calcMatchup;

    // Exposed for tests / callers that want the raw gen-10 formulas.
    CalcEngine.champHP = champHP;
    CalcEngine.champStat = champStat;
})();
