/*
 * scaffold.js -- prepares the vendored NCP-VGC-Damage-Calculator engine for
 * headless, client-side use.
 *
 * WHY THIS FILE EXISTS
 * The engine is a set of classic global-scope scripts with no module boundary.
 * Its own UI glue (ap_calc.js) is what normally declares the "current
 * generation" globals, reads the DOM, and assigns the top-level calc function.
 * We do not vendor that glue, so this file reproduces the *minimum* global
 * state the math files need, then exposes a small window.CalcEngine API.
 *
 * Load order: this file must come AFTER jQuery, the data files, the damage
 * files, and ko_chance.js.
 *
 * The gen-10 ("CHAMPIONS", Regulation M-C) dataset selection mirrors
 * ap_calc.js `case 10:` (upstream commit 1369b359...):
 *   pokedex   = POKEDEX_CHAMPIONS
 *   typeChart = TYPE_CHART_SV
 *   moves     = MOVES_CHAMPIONS
 *   items     = ITEMS_CHAMPIONS
 *   abilities = ABILITIES_CHAMPIONS
 *   STATS     = STATS_GSC
 *   calculateAllMoves = CALCULATE_ALL_MOVES_SV
 *   calcHP    = CALC_HP_CHAMP
 *   calcStat  = CALC_STAT_CHAMP
 *
 * NOTE: `gen`, `typeChart`, `calculateAllMoves`, `calcHP`, `calcStat`,
 * `setHasTypeFunc`, `resultDisplayMode`, `transformSpecies`, `manualProtoQuark`
 * and `lastHighestStat` are declared by the non-vendored ap_calc.js, so we
 * create them here as window properties. The engine reads them as bare
 * identifiers, which resolve to the same window properties.
 */

(function () {
    var w = window;

    // --- Current-generation globals read by the vendored math files ---
    w.gen = 10;
    w.pokedex = POKEDEX_CHAMPIONS;
    w.typeChart = TYPE_CHART_SV;
    w.moves = MOVES_CHAMPIONS;
    w.items = ITEMS_CHAMPIONS;
    w.abilities = ABILITIES_CHAMPIONS;
    w.STATS = STATS_GSC;
    w.calculateAllMoves = CALCULATE_ALL_MOVES_SV;
    w.calcHP = CALC_HP_CHAMP;
    w.calcStat = CALC_STAT_CHAMP;

    // --- Globals the math files read but that ap_calc.js normally declares ---
    // resultDisplayMode selects how investment is shown in descriptions.
    w.resultDisplayMode = "SPs";
    // transformSpecies is read when attacker.isTransformed is true.
    w.transformSpecies = { p1: "", p2: "" };
    // manualProtoQuark forces the Protosynthesis/Quark Drive boost.
    w.manualProtoQuark = false;
    // setHighestStat() writes into this array.
    w.lastHighestStat = [0, 0];

    // The engine calls pokemon.hasType(...) and re-attaches setHasTypeFunc to
    // deep-copied Pokemon inside additionalDamageCalcs(). ap_calc.js normally
    // defines it, so we define it here as a global.
    w.setHasTypeFunc = function () {
        for (var i = 0; i < arguments.length; i++) {
            if (this.type1 === arguments[i] || this.type2 === arguments[i]) {
                return true;
            }
        }
        return false;
    };

    function own(obj, key) {
        return Object.prototype.hasOwnProperty.call(obj, key);
    }

    // The Champions dex keys Megas as "Mega Salamence" / "Mega Raichu Y",
    // while Showdown-style input uses "Salamence-Mega" / "Raichu-Mega-Y".
    // Resolve either convention to the actual dex key.
    function resolveSpecies(name) {
        if (!name) return undefined;
        if (own(pokedex, name)) return name;
        var parts = name.split("-");
        var megaIndex = parts.indexOf("Mega");
        if (megaIndex !== -1) {
            var rest = parts.filter(function (_, i) { return i !== megaIndex; });
            var candidate = "Mega " + rest.join(" ");
            if (own(pokedex, candidate)) return candidate;
        }
        return undefined;
    }

    w.CalcEngine = {
        ready: true,

        info: {
            gen: w.gen,
            pokedexName: "POKEDEX_CHAMPIONS",
            moveCount: Object.keys(w.moves).length,
            speciesCount: Object.keys(w.pokedex).length,
            hasChampions: typeof POKEDEX_CHAMPIONS !== "undefined",
        },

        hasSpecies: function (name) {
            return resolveSpecies(name) !== undefined;
        },

        resolveSpecies: resolveSpecies,

        hasMove: function (name) {
            return own(w.moves, name);
        },

        hasItem: function (name) {
            return w.items.indexOf(name) !== -1;
        },

        hasAbility: function (name) {
            return w.abilities.indexOf(name) !== -1;
        },

        // The engine expects pokemon.hasType to be this function.
        setHasType: w.setHasTypeFunc,

        // Thin wrapper over the engine's top-level function.
        calcAllMoves: function (p1, p2, field) {
            return w.calculateAllMoves(p1, p2, field);
        },

        // Thin wrapper over the KO-chance helper.
        getKOChanceText: function (damage, move, defender, side, isBadDreams, isItemlessAttacker) {
            return getKOChanceText(damage, move, defender, side, isBadDreams, isItemlessAttacker);
        },
    };
})();
