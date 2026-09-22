/*
 * datasource.js -- data access abstraction for the two build targets.
 *
 * The same frontend runs against either:
 *   - "api"    : the Flask backend (server.py) at /api/...
 *   - "static" : pre-baked JSON under ./data/ (GitHub Pages build)
 *
 * Mode detection (deterministic first, probe as fallback):
 *   1. If window.PM_VISUALIZER_MODE is set ("api" or "static"), use it.
 *      templates/index.html sets "api"; build_static.py rewrites it to
 *      "static" in docs/index.html. No probe request is made.
 *   2. Otherwise probe ./data/manifest.json: a 2xx means static mode,
 *      anything else (including a network error) means api mode.
 *
 * Static paths are RELATIVE so the site works under a GitHub Pages project
 * subpath (/repo-name/):
 *   tournaments -> ./data/tournaments.json
 *   teams       -> ./data/teams/{tournamentId}_{day}.json
 *   spreads     -> ./data/spreads/{usageFormat}/{pokemonSlug}.json
 *
 * A missing static file (a day filter that was not baked, or a Pokemon with
 * no spreads) resolves to an empty result with `missing: true` instead of
 * throwing, so the UI can show a friendly note.
 *
 * Exposes: window.DataSource
 */

(function () {
    "use strict";

    var MANIFEST_PATH = "./data/manifest.json";
    var POKEPASTE_BASE = "https://pokepast.es";

    // Usage datasets MunchStats actually serves. Mirrors munchstats_api.py.
    var CHAMPIONS_FORMAT_ID = "championsdoubles";
    var DEFAULT_FORMAT_ID = "gen9championsvgc2026regmbbo3";

    // Tournament regulation -> usage dataset. Mirrors
    // TOURNAMENT_FORMAT_TO_USAGE in munchstats_api.py; the build bakes the
    // spread files under these usage-format directories.
    var TOURNAMENT_FORMAT_TO_USAGE = {
        "gen9championsvgc2026regmc": CHAMPIONS_FORMAT_ID,
        "gen9championsvgc2026regma": CHAMPIONS_FORMAT_ID,
        "gen9championsvgc2026regmb": DEFAULT_FORMAT_ID,
    };

    // pokepaste ids are hex strings, 8-32 chars (mirrors pokepaste_api.py).
    var PASTE_ID_RE = /^[0-9a-fA-F]{8,32}$/;

    var resolvedMode = null;
    var modePromise = null;

    /**
     * Map a tournament regulation to the usage dataset that covers it.
     *
     * MUST stay identical to usage_format_for_tournament() in
     * munchstats_api.py: strip a trailing "bo3", lowercase, use the explicit
     * mapping, else any other "champions" regulation -> championsdoubles, else
     * (pre-Champions) -> the Reg M-B tournament dataset.
     * @param {string} tournamentFormat
     * @returns {string}
     */
    function usageFormatForTournament(tournamentFormat) {
        var normalized = String(tournamentFormat == null ? "" : tournamentFormat)
            .trim()
            .toLowerCase();
        if (normalized.slice(-3) === "bo3") {
            normalized = normalized.slice(0, -3);
        }
        if (Object.prototype.hasOwnProperty.call(TOURNAMENT_FORMAT_TO_USAGE, normalized)) {
            return TOURNAMENT_FORMAT_TO_USAGE[normalized];
        }
        if (normalized.indexOf("champions") !== -1) return CHAMPIONS_FORMAT_ID;
        return DEFAULT_FORMAT_ID;
    }

    /**
     * Filesystem-safe lowercase slug for a Pokemon name.
     *
     * MUST stay identical to pokemon_slug() in build_static.py: the build
     * script names the files and this function looks them up. Algorithm:
     * trim, lowercase, collapse every run of non-[a-z0-9] to "-", strip
     * leading/trailing "-", and fall back to "unknown" for an empty result.
     * @param {string} name
     * @returns {string}
     */
    function pokemonSlug(name) {
        var slug = String(name == null ? "" : name)
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");
        return slug || "unknown";
    }

    /**
     * Extract and validate a pokepaste id from a URL or bare id.
     * Mirrors pokepaste_api.extract_paste_id.
     * @param {string} urlOrId
     * @returns {string}
     */
    function extractPasteId(urlOrId) {
        if (!urlOrId) throw new Error("No pokepaste id or URL provided");
        var candidate = String(urlOrId).trim();
        candidate = candidate.replace(/^https?:\/\//i, "");
        candidate = candidate.replace(/^pokepast\.es\//i, "");
        candidate = candidate.split("?")[0].split("#")[0];
        candidate = candidate.split("/")[0].trim();
        if (!PASTE_ID_RE.test(candidate)) {
            throw new Error("Invalid pokepaste id: " + JSON.stringify(urlOrId));
        }
        return candidate;
    }

    /** fetch() + JSON parse. A 404 resolves to {missing:true}. */
    async function fetchJSON(url, options) {
        var resp = await fetch(url, options);
        if (resp.status === 404) return { missing: true };
        var data = null;
        try { data = await resp.json(); } catch (err) { data = null; }
        if (!resp.ok) {
            var msg = (data && data.error) ? data.error : ("HTTP " + resp.status);
            throw new Error(msg);
        }
        return data;
    }

    function detectMode() {
        var flag = window.PM_VISUALIZER_MODE;
        if (flag === "static" || flag === "api") {
            resolvedMode = flag;
            return Promise.resolve(flag);
        }
        return fetch(MANIFEST_PATH)
            .then(function (resp) {
                resolvedMode = resp.ok ? "static" : "api";
                return resolvedMode;
            })
            .catch(function () {
                resolvedMode = "api";
                return resolvedMode;
            });
    }

    function resolveMode() {
        if (!modePromise) modePromise = detectMode();
        return modePromise;
    }

    /** GET tournaments. Static: ./data/tournaments.json. */
    async function getTournaments() {
        var mode = await resolveMode();
        if (mode === "static") {
            var data = await fetchJSON("./data/tournaments.json");
            if (!data || data.missing) return { tournaments: [], missing: true };
            return { tournaments: data.tournaments || [] };
        }
        return fetchJSON("/api/tournaments");
    }

    /** GET teams for a tournament + day filter. */
    async function getTeams(tournamentId, day) {
        var mode = await resolveMode();
        day = day || "all";
        if (mode === "static") {
            var url = "./data/teams/" + encodeURIComponent(tournamentId) + "_" +
                encodeURIComponent(day) + ".json";
            var data = await fetchJSON(url);
            if (!data || data.missing) return { teams: [], day: day, missing: true };
            return { teams: data.teams || [], day: data.day || day };
        }
        return fetchJSON(
            "/api/tournaments/" + encodeURIComponent(tournamentId) +
            "/teams?day=" + encodeURIComponent(day)
        );
    }

    /**
     * GET usage spreads + summary for a Pokemon.
     *
     * ``tournamentFormat`` is the selected tournament's regulation (e.g.
     * ``gen9championsvgc2026regmc``). In static mode it selects the baked
     * ``spreads/{usageFormat}/`` directory; in api mode it is passed through
     * as ``?format=`` for the server to map.
     *
     * Returns the spread list plus the provenance of the fallback chain that
     * produced it: `matched`, `requested`, `resolved`, `source`, `sourceLabel`,
     * `natureInferred` and the ranked `natures` list (empty when the source
     * has none).
     * @param {string} pokemon
     * @param {string} [tournamentFormat]
     */
    async function getSpreads(pokemon, tournamentFormat) {
        var mode = await resolveMode();
        if (mode === "static") {
            var usageFormat = usageFormatForTournament(tournamentFormat);
            var url = "./data/spreads/" + encodeURIComponent(usageFormat) + "/" +
                encodeURIComponent(pokemonSlug(pokemon)) + ".json";
            var data = await fetchJSON(url);
            if (!data || data.missing) {
                return {
                    spreads: [], usage: null, natures: [], matched: false,
                    requested: pokemon, resolved: "", source: "", sourceLabel: "",
                    natureInferred: false, missing: true,
                };
            }
            return {
                spreads: data.spreads || [],
                usage: data.usage || null,
                natures: data.natures || [],
                matched: data.matched !== false,
                requested: data.requested || pokemon,
                resolved: data.resolved || "",
                source: data.source || "",
                sourceLabel: data.sourceLabel || data.source || "",
                natureInferred: data.natureInferred === true,
            };
        }
        var apiUrl = "/api/spreads/" + encodeURIComponent(pokemon);
        if (tournamentFormat) {
            apiUrl += "?format=" + encodeURIComponent(tournamentFormat);
        }
        return fetchJSON(apiUrl);
    }

    /**
     * Parse a team from a pokepaste URL or raw Showdown text.
     *
     * API mode POSTs to /api/team. Static mode runs the JS parser and, for a
     * URL, fetches pokepaste directly -- pokepast.es/raw sends
     * `Access-Control-Allow-Origin: *`, so this works from the browser.
     * @param {{url?:string, text?:string}} body
     * @returns {Promise<{sets:object[], warnings:string[]}>}
     */
    async function parseTeam(body) {
        var mode = await resolveMode();
        if (mode === "api") {
            return fetchJSON("/api/team", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body || {}),
            });
        }

        var text;
        if (body && body.url && String(body.url).trim()) {
            var pasteId = extractPasteId(body.url);
            var resp = await fetch(POKEPASTE_BASE + "/" + pasteId + "/raw");
            if (!resp.ok) throw new Error("Upstream paste service is unavailable");
            text = await resp.text();
        } else if (body && body.text && String(body.text).trim()) {
            text = body.text;
        } else {
            throw new Error("Provide either 'url' or 'text'");
        }

        var sets = window.ShowdownParser.parseTeam(text);
        var warnings = [];
        sets.forEach(function (setObj) {
            (setObj.warnings || []).forEach(function (w) { warnings.push(w); });
        });
        return { sets: sets, warnings: warnings };
    }

    window.DataSource = {
        get mode() { return resolvedMode; },
        ready: resolveMode,
        pokemonSlug: pokemonSlug,
        usageFormatForTournament: usageFormatForTournament,
        extractPasteId: extractPasteId,
        getTournaments: getTournaments,
        getTeams: getTeams,
        getSpreads: getSpreads,
        parseTeam: parseTeam,
    };
})();
