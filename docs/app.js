/*
 * app.js -- Pokemon Matchup Visualizer application shell (Phase C1).
 *
 * Owns the sidebar UI, data loading, state, and the field-toggle plumbing.
 * Damage math lives in the vendored engine; this file never computes damage.
 * Phase C2 replaces window.renderMatchup with the real matrix/detail/scoring.
 *
 * Load order: after static/calc/adapter.js (which requires scaffold.js).
 */

(function () {
    "use strict";

    // ------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------

    var SPRITE_SHEET_CELL_W = 40;
    var SPRITE_SHEET_CELL_H = 30;
    var MY_TEAM_STORAGE_KEY = "pmv.myTeam";
    var TEAM_FILTER_STORAGE_KEY = "pmv.teamFilter";

    // Monotonically increasing request tokens. Async loaders capture the
    // current token before awaiting and only mutate state if it is still the
    // latest. This stops a slow, stale response from clobbering a newer
    // selection (rapid tournament/day switching or team clicking).
    var requestTokens = {
        tournaments: 0,
        teams: 0,
        team: 0,
    };

    /**
     * Bump and return the token for a named request channel.
     * @param {string} channel
     * @returns {number}
     */
    function nextToken(channel) {
        requestTokens[channel] = (requestTokens[channel] || 0) + 1;
        return requestTokens[channel];
    }

    /**
     * True while ``token`` is still the latest for ``channel``.
     * @param {string} channel
     * @param {number} token
     * @returns {boolean}
     */
    function isCurrent(channel, token) {
        return requestTokens[channel] === token;
    }

    // MunchStats base_stats order: [hp, at, df, sa, sd, sp].
    var BASE_STAT_INDEX = { hp: 0, at: 1, df: 2, sa: 3, sd: 4, sp: 5 };

    var DEFAULT_SPREAD_PHYSICAL = { hp: 32, at: 32, df: 0, sa: 0, sd: 0, sp: 2 };
    var DEFAULT_SPREAD_SPECIAL = { hp: 32, at: 0, df: 0, sa: 32, sd: 0, sp: 2 };
    var DEFAULT_SPREAD_UNKNOWN = { hp: 2, at: 32, df: 0, sa: 0, sd: 0, sp: 32 };

    // ------------------------------------------------------------------
    // State (frozen shape -- Phase C2 depends on it)
    // ------------------------------------------------------------------

    var state = {
        myTeam: [],            // normalized sets (from /api/team)
        tournaments: [],       // from /api/tournaments
        selectedTournament: null,
        day: "all",
        teams: [],             // from /api/tournaments/<id>/teams
        teamFilter: "",        // raw text in the team-name filter ("" = show all)
        selectedTeam: null,    // one entry from teams[]
        oppTeam: [],           // normalized sets built from selectedTeam + chosen spreads
        oppSpreads: {},        // { [pokemonName]: {spreads:[...], chosenIndex:0, matched:bool} }
        field: {
            weather: "", terrain: "", reflect: false, lightScreen: false,
            tailwind: false, helpingHand: false,
        },
        matchup: null,         // result of CalcEngine.calcMatchup per cell (C2 fills this)
    };

    // ------------------------------------------------------------------
    // DOM helpers
    // ------------------------------------------------------------------

    function $(id) { return document.getElementById(id); }

    /**
     * Escape a string for safe insertion into innerHTML.
     * Tournament/player/Pokemon names come from an external API, so every
     * data-derived string must pass through here.
     * @param {*} value
     * @returns {string}
     */
    function escapeHtml(value) {
        return String(value == null ? "" : value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    /**
     * Write a status line. Never alerts.
     * @param {HTMLElement} node
     * @param {string} text
     * @param {""|"loading"|"success"|"error"} [kind]
     */
    function setStatus(node, text, kind) {
        if (!node) return;
        node.textContent = text || "";
        node.className = "status" + (kind ? " " + kind : "");
    }

    /**
     * Create a MunchStats sprite element from a [row, col] sheet coordinate.
     * @param {number[]} sprite
     * @param {string} [extraClass]
     * @returns {HTMLElement}
     */
    function spriteEl(sprite, extraClass) {
        var span = document.createElement("span");
        span.className = "sprite" + (extraClass ? " " + extraClass : "");
        if (Array.isArray(sprite) && sprite.length === 2) {
            var row = Number(sprite[0]) || 0;
            var col = Number(sprite[1]) || 0;
            span.style.backgroundPosition =
                (-col * SPRITE_SHEET_CELL_W) + "px " + (-row * SPRITE_SHEET_CELL_H) + "px";
        }
        return span;
    }

    /**
     * Create a Pokemon sprite <img> for "my team" cards (Showdown home art,
     * falling back to gen-5 art, then hidden).
     * @param {string} species
     * @returns {HTMLImageElement}
     */
    function mySpriteEl(species) {
        var img = document.createElement("img");
        img.className = "sprite sprite-my";
        img.alt = "";
        var slug = encodeURIComponent(String(species || "").toLowerCase().replace(/\s+/g, "-"));
        img.src = "https://play.pokemonshowdown.com/sprites/home/" + slug + ".png";
        img.onerror = function () {
            if (img.dataset.fallback) {
                img.style.visibility = "hidden";
                return;
            }
            img.dataset.fallback = "1";
            img.src = "https://play.pokemonshowdown.com/sprites/gen5/" + slug + ".png";
        };
        return img;
    }

    // ------------------------------------------------------------------
    // My Team
    // ------------------------------------------------------------------

    /** Persist the loaded team so a refresh does not lose it. */
    function saveMyTeam() {
        try {
            localStorage.setItem(MY_TEAM_STORAGE_KEY, JSON.stringify(state.myTeam));
        } catch (err) {
            // Private mode / quota: persistence is best-effort only.
        }
    }

    /** Restore the last loaded team from localStorage, if any. */
    function restoreMyTeam() {
        try {
            var raw = localStorage.getItem(MY_TEAM_STORAGE_KEY);
            if (!raw) return;
            var parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length) {
                state.myTeam = parsed;
                renderMyTeam();
            }
        } catch (err) {
            // Corrupt entry: ignore and start clean.
        }
    }

    /** Render the 6 loaded sets as compact cards. */
    function renderMyTeam() {
        var list = $("my-team-list");
        var warnBox = $("my-team-warnings");
        list.innerHTML = "";
        warnBox.innerHTML = "";

        if (!state.myTeam.length) {
            list.innerHTML = '<p class="empty muted">No team loaded.</p>';
            return;
        }

        state.myTeam.forEach(function (set, index) {
            var card = document.createElement("div");
            card.className = "mon-card";

            var head = document.createElement("div");
            head.className = "mon-card-head";
            head.appendChild(mySpriteEl(set.species));

            var title = document.createElement("div");
            var name = set.nickname
                ? escapeHtml(set.nickname) + " <span class=\"muted\">(" + escapeHtml(set.species) + ")</span>"
                : escapeHtml(set.species);
            title.innerHTML = '<div class="mon-card-title">' + name + "</div>" +
                '<div class="mon-card-sub">' + escapeHtml(set.item || "no item") + "</div>";
            head.appendChild(title);
            card.appendChild(head);

            var sub = document.createElement("div");
            sub.className = "mon-card-sub";
            sub.textContent = (set.ability || "no ability") + " \u00b7 " + (set.nature || "Hardy") + " Nature";
            card.appendChild(sub);

            var moves = document.createElement("div");
            moves.className = "mon-card-moves";
            (set.moves || []).forEach(function (mv) {
                var s = document.createElement("span");
                s.textContent = mv;
                moves.appendChild(s);
            });
            card.appendChild(moves);

            if (set.teraType) {
                var teraLabel = document.createElement("label");
                teraLabel.className = "tera-toggle";
                var teraBox = document.createElement("input");
                teraBox.type = "checkbox";
                teraBox.checked = set.terastallized === true;
                teraBox.addEventListener("change", function () {
                    state.myTeam[index].terastallized = teraBox.checked;
                    saveMyTeam();
                    recompute();
                });
                teraLabel.appendChild(teraBox);
                teraLabel.appendChild(document.createTextNode(" Terastallized (" + set.teraType + ")"));
                card.appendChild(teraLabel);
            }

            list.appendChild(card);
        });

        var warnings = [];
        state.myTeam.forEach(function (set) {
            (set.warnings || []).forEach(function (w) {
                warnings.push(set.species + ": " + w);
            });
        });
        if (warnings.length) {
            warnBox.innerHTML = warnings.map(function (w) {
                return "<p>" + escapeHtml(w) + "</p>";
            }).join("");
        }
    }

    /**
     * Load a team from a pokepaste URL or raw Showdown text via DataSource.
     * @param {{url?:string, text?:string}} body
     * @param {HTMLElement} statusNode
     * @param {HTMLElement[]} buttons - disabled while loading
     * @returns {Promise<void>}
     */
    async function loadTeam(body, statusNode, buttons) {
        buttons.forEach(function (b) { b.disabled = true; });
        setStatus(statusNode, "Loading team...", "loading");
        try {
            var data = await window.DataSource.parseTeam(body);
            var sets = (data && data.sets) || [];
            if (!sets.length) throw new Error("No Pokemon sets found");
            sets.forEach(function (set) {
                // Terastallization is opt-in and defaults off (MEDIUM-8).
                if (set.terastallized === undefined) set.terastallized = false;
            });
            state.myTeam = sets;
            saveMyTeam();
            renderMyTeam();
            var n = sets.length;
            setStatus(statusNode, "Loaded " + n + " Pokemon." + (n < 6 ? " (fewer than 6)" : ""), "success");
            recompute();
        } catch (err) {
            setStatus(statusNode, "Error: " + err.message, "error");
        } finally {
            buttons.forEach(function (b) { b.disabled = false; });
        }
    }

    /** Load a team from the pokepaste URL input. */
    function loadMyTeamUrl() {
        var input = $("paste-url");
        var url = (input.value || "").trim();
        if (!url) {
            setStatus($("my-team-status"), "Enter a pokepaste URL first.", "error");
            return Promise.resolve();
        }
        return loadTeam({ url: url }, $("my-team-status"), [$("load-url-btn")]);
    }

    /** Load a team from the raw Showdown textarea. */
    function loadMyTeamText() {
        var text = $("paste-text").value || "";
        if (!text.trim()) {
            setStatus($("my-team-status"), "Paste a team first.", "error");
            return Promise.resolve();
        }
        return loadTeam({ text: text }, $("my-team-status"), [$("load-text-btn")]);
    }

    /** Clear the loaded team and its persisted copy. */
    function clearMyTeam() {
        state.myTeam = [];
        state.matchup = null;
        try { localStorage.removeItem(MY_TEAM_STORAGE_KEY); } catch (err) { /* ignore */ }
        $("paste-url").value = "";
        $("paste-text").value = "";
        setStatus($("my-team-status"), "Team cleared.", "");
        renderMyTeam();
        recompute();
    }

    // ------------------------------------------------------------------
    // Opponent -- tournaments, teams, spreads
    // ------------------------------------------------------------------

    /** GET tournaments and populate the select (newest first). */
    async function loadTournaments() {
        var select = $("tournament-select");
        var token = nextToken("tournaments");
        setStatus($("opp-status"), "Loading tournaments...", "loading");
        try {
            var data = await window.DataSource.getTournaments();
            if (!isCurrent("tournaments", token)) return;
            var list = (data && data.tournaments) || [];
            state.tournaments = list;
            select.innerHTML = "";
            if (!list.length) {
                select.innerHTML = '<option value="">No tournaments</option>';
                setStatus($("opp-status"), "No tournaments available.", "error");
                return;
            }
            list.forEach(function (t) {
                var opt = document.createElement("option");
                opt.value = t.id;
                opt.textContent = t.name + " (" + t.date + ")";
                select.appendChild(opt);
            });
            setStatus($("opp-status"), list.length + " tournaments.", "success");
            await selectTournament(list[0].id);
        } catch (err) {
            if (!isCurrent("tournaments", token)) return;
            select.innerHTML = '<option value="">Failed to load</option>';
            setStatus($("opp-status"), "Error: " + err.message, "error");
        }
    }

    /**
     * Select a tournament and fetch its teams for the current day filter.
     * @param {string} id
     */
    async function selectTournament(id) {
        var token = nextToken("teams");
        var found = state.tournaments.filter(function (t) { return t.id === id; })[0] || null;
        state.selectedTournament = found;
        state.selectedTeam = null;
        state.teams = [];
        state.oppTeam = [];
        state.oppSpreads = {};
        state.matchup = null;
        renderTeamList();
        renderOppTeam();
        recompute();
        await loadTeams(token);
    }

    /**
     * Fetch teams for the current tournament + day filter via DataSource.
     * @param {number} [token] - token from selectTournament; a fresh one is
     *   minted when called directly (e.g. setDay).
     */
    async function loadTeams(token) {
        if (!state.selectedTournament) return;
        if (token === undefined) token = nextToken("teams");
        var id = state.selectedTournament.id;
        var day = state.day;
        setStatus($("opp-status"), "Loading teams...", "loading");
        try {
            var data = await window.DataSource.getTeams(id, day);
            if (!isCurrent("teams", token)) return;
            state.teams = (data && data.teams) || [];
            renderTeamList();
            if (data && data.missing) {
                setStatus($("opp-status"), "No teams baked for " + day + " in this build.", "error");
            } else {
                setStatus($("opp-status"), state.teams.length + " teams (" + day + ").", "success");
            }
        } catch (err) {
            if (!isCurrent("teams", token)) return;
            state.teams = [];
            renderTeamList();
            setStatus($("opp-status"), "Error: " + err.message, "error");
        }
    }

    /** Change the day filter and re-fetch teams. */
    function setDay(day) {
        state.day = day;
        document.querySelectorAll("#day-filters .btn-day").forEach(function (btn) {
            btn.classList.toggle("active", btn.dataset.day === day);
        });
        state.selectedTeam = null;
        state.oppTeam = [];
        state.oppSpreads = {};
        state.matchup = null;
        renderOppTeam();
        recompute();
        return loadTeams();
    }

    /**
     * Normalize a Pokemon name for forgiving filter matching.
     *
     * Rule: lowercase, then strip hyphens, spaces and periods. This makes
     * "Salamence Mega", "salamence-mega" and "SalamenceMega" all normalize to
     * "salamencemega", so they match the species "Salamence-Mega". Matching is
     * substring-based, so "Salamence" also matches "Salamence-Mega".
     * @param {string} s
     * @returns {string}
     */
    function normalizeName(s) {
        return String(s == null ? "" : s)
            .toLowerCase()
            .replace(/[-\s.]/g, "");
    }

    /**
     * Split the raw filter into normalized, non-empty terms.
     * A trailing comma (or blank term) is ignored rather than matching nothing.
     * @param {string} query
     * @returns {string[]}
     */
    function filterTerms(query) {
        return String(query || "")
            .split(",")
            .map(normalizeName)
            .filter(function (term) { return term.length > 0; });
    }

    /**
     * Filter state.teams by the current state.teamFilter.
     *
     * AND semantics: every comma-separated term must appear as a substring of
     * at least one of the team's species names (terms may match different
     * members). Matching is against mon.pokemon only -- never item, ability,
     * nature or moves.
     *
     * Each result keeps its ORIGINAL index into state.teams so selectTeam()
     * receives the correct full-array index even when the list is filtered.
     * @returns {{team:object, index:number}[]}
     */
    function getFilteredTeams() {
        var terms = filterTerms(state.teamFilter);
        if (!terms.length) {
            return state.teams.map(function (team, index) {
                return { team: team, index: index };
            });
        }
        return state.teams.reduce(function (acc, team, index) {
            var species = (team.team || []).map(function (mon) {
                return normalizeName(mon.pokemon);
            });
            var matchesAll = terms.every(function (term) {
                return species.some(function (name) { return name.indexOf(term) !== -1; });
            });
            if (matchesAll) acc.push({ team: team, index: index });
            return acc;
        }, []);
    }

    /** Persist the team filter so a refresh keeps it. Best-effort. */
    function saveTeamFilter() {
        try {
            localStorage.setItem(TEAM_FILTER_STORAGE_KEY, state.teamFilter);
        } catch (err) {
            // Private mode / quota: persistence is best-effort only.
        }
    }

    /** Restore the persisted team filter into state (does not re-render). */
    function restoreTeamFilter() {
        try {
            var raw = localStorage.getItem(TEAM_FILTER_STORAGE_KEY);
            if (raw != null) state.teamFilter = raw;
        } catch (err) {
            // Corrupt/unavailable storage: start with no filter.
        }
    }

    /**
     * Set the team filter, persist it and re-render the list (no re-fetch).
     * @param {string} query
     */
    function setTeamFilter(query) {
        state.teamFilter = String(query == null ? "" : query);
        var input = $("team-filter");
        if (input && input.value !== state.teamFilter) input.value = state.teamFilter;
        saveTeamFilter();
        renderTeamList();
    }

    /** Render the clickable team list for the current tournament. */
    function renderTeamList() {
        var list = $("team-list");
        var count = $("team-count");
        var clearBtn = $("team-filter-clear");
        list.innerHTML = "";

        var filtered = getFilteredTeams();
        var filterActive = filterTerms(state.teamFilter).length > 0;
        var total = state.teams.length;

        if (clearBtn) clearBtn.hidden = state.teamFilter.length === 0;

        if (!total) {
            count.textContent = "";
            list.innerHTML = '<p class="empty muted">' +
                (state.selectedTournament ? "No teams for this filter." : "Select a tournament.") +
                "</p>";
            return;
        }

        count.textContent = filterActive
            ? filtered.length + " of " + total + " teams"
            : total + " teams";

        if (!filtered.length) {
            list.innerHTML = '<p class="empty muted">No teams match &quot;' +
                escapeHtml(state.teamFilter.trim()) + "&quot;.</p>";
            return;
        }

        filtered.forEach(function (entry) {
            var team = entry.team;
            var row = document.createElement("div");
            row.className = "team-row" + (state.selectedTeam === team ? " selected" : "");
            // Keep the ORIGINAL state.teams index so a filtered row still
            // selects the right team (see getFilteredTeams).
            row.dataset.index = String(entry.index);

            var record = team.record || {};
            var head = document.createElement("div");
            head.className = "team-row-head";
            head.innerHTML =
                '<span class="team-row-name">#' + escapeHtml(team.placement) + " " +
                escapeHtml(team.name) + "</span>" +
                '<span class="team-row-record">' +
                escapeHtml(record.wins != null ? record.wins : "?") + "-" +
                escapeHtml(record.losses != null ? record.losses : "?") + "</span>";
            row.appendChild(head);

            var sprites = document.createElement("div");
            sprites.className = "team-row-sprites";
            (team.team || []).slice(0, 6).forEach(function (mon) {
                sprites.appendChild(spriteEl(mon.sprite, "sprite-mini"));
            });
            row.appendChild(sprites);

            row.addEventListener("click", function () { selectTeam(entry.index); });
            list.appendChild(row);
        });
    }

    /**
     * Look up a species' base stats from the local engine dex.
     *
     * WHY NOT usage.base_stats: when MunchStats fuzzy-substitutes a different
     * Pokemon, its `base_stats` describe the SUBSTITUTE (e.g. Salamence-Mega ->
     * Sableye-Mega), not the mon we asked about. The local Champions dex has
     * the authoritative stats, so we prefer it and only fall back to the usage
     * payload when the species is unknown to the engine.
     * @param {string} species
     * @returns {number[]|null} [hp, at, df, sa, sd, sp]
     */
    function localBaseStats(species) {
        if (!window.CalcEngine || !window.CalcEngine.ready) return null;
        var key = window.CalcEngine.resolveSpecies(species);
        var dex = key ? window.pokedex[key] : null;
        if (!dex || !dex.bs) return null;
        var bs = dex.bs;
        return [bs.hp, bs.at, bs.df, bs.sa, bs.sd, bs.sp];
    }

    /**
     * The stat a nature raises and lowers, from the engine's NATURES table.
     * @param {string} nature
     * @returns {{raised:string, lowered:string}}
     */
    function natureMods(nature) {
        var mods = (window.NATURES && window.NATURES[nature]) || ["", ""];
        return { raised: mods[0] || "", lowered: mods[1] || "" };
    }

    /**
     * Build a fallback spread for a Pokemon with no usable usage data.
     *
     * Rule: the attacking stat is decided by the nature when the nature boosts
     * Attack (Adamant/Brave/Naughty/Lonely) or Sp. Atk (Modest/Quiet/Mild/Rash);
     * otherwise (Speed-boosting or neutral natures) it falls back to comparing
     * the dex base Atk vs SpA. A nature that *lowers* the chosen attacking stat
     * is contradictory (e.g. Timid lowers Atk), so it is replaced with neutral
     * Hardy and the substitution is recorded in the set's warnings. The goal is
     * a plausible spread, never a contradictory one.
     *
     * @param {object} mon - raw team member {pokemon, nature, ...}
     * @param {object|null} usage - /api/spreads usage summary
     * @returns {{label:string, pct:null, nature:string, sps:object, assumed:true, warnings:string[]}}
     */
    function assumedSpread(mon, usage) {
        var base = localBaseStats(mon.pokemon);
        if (!base && usage && Array.isArray(usage.base_stats) && usage.base_stats.length >= 6) {
            base = usage.base_stats;
        }

        var mods = natureMods(mon.nature);
        var attacking = null;
        if (mods.raised === "at" || mods.raised === "sa") {
            attacking = mods.raised;
        } else if (base) {
            attacking = base[BASE_STAT_INDEX.at] >= base[BASE_STAT_INDEX.sa] ? "at" : "sa";
        }

        var sps;
        if (attacking === "at") {
            sps = DEFAULT_SPREAD_PHYSICAL;
        } else if (attacking === "sa") {
            sps = DEFAULT_SPREAD_SPECIAL;
        } else {
            sps = DEFAULT_SPREAD_UNKNOWN;
        }
        sps = { hp: sps.hp, at: sps.at, df: sps.df, sa: sps.sa, sd: sps.sd, sp: sps.sp };

        var nature = mon.nature || "Serious";
        var warnings = [];
        if (attacking && mods.lowered === attacking) {
            warnings.push("team nature " + nature + " lowers " +
                (attacking === "at" ? "Attack" : "Sp. Atk") +
                "; assumed a neutral Hardy nature for the " +
                (attacking === "at" ? "physical" : "special") + " spread");
            nature = "Hardy";
        }

        return {
            label: nature + ":" + [sps.hp, sps.at, sps.df, sps.sa, sps.sd, sps.sp].join("/"),
            pct: null,
            nature: nature,
            sps: sps,
            assumed: true,
            warnings: warnings,
        };
    }

    /**
     * Fetch usage spreads for one opponent Pokemon and pick a default.
     * @param {object} mon - raw team member
     * @returns {Promise<{set:object, entry:object}>}
     */
    async function buildOppMon(mon) {
        var spreads = [];
        var usage = null;
        try {
            var data = await window.DataSource.getSpreads(mon.pokemon);
            spreads = (data && data.spreads) || [];
            usage = (data && data.usage) || null;
        } catch (err) {
            usage = null;
            spreads = [];
        }

        var matched = !!(usage && usage.matched !== false && spreads.length);
        var options, assumed;
        if (matched) {
            options = spreads;
            assumed = false;
        } else {
            options = [assumedSpread(mon, usage)];
            assumed = true;
        }

        var chosen = options[0];
        var set = {
            species: mon.pokemon,
            level: 50,
            nature: chosen.nature || mon.nature || "Serious",
            ability: mon.ability || "",
            item: mon.item || "",
            teraType: mon.tera_type || "",
            // Terastallization is opt-in; see the per-mon checkbox.
            terastallized: false,
            sps: chosen.sps,
            moves: mon.moves || [],
            warnings: chosen.warnings || [],
        };

        return {
            set: set,
            entry: {
                spreads: options,
                chosenIndex: 0,
                matched: !!(usage && usage.matched !== false),
                assumed: assumed,
            },
        };
    }

    /**
     * Select a team, fetch spreads for all six Pokemon in parallel, and build
     * state.oppTeam / state.oppSpreads.
     * @param {number} index - index into state.teams
     */
    async function selectTeam(index) {
        var team = state.teams[index];
        if (!team) return;
        var token = nextToken("team");
        state.selectedTeam = team;
        state.oppTeam = [];
        state.oppSpreads = {};
        state.matchup = null;
        renderTeamList();
        setStatus($("opp-status"), "Loading spreads...", "loading");

        try {
            var mons = (team.team || []).slice(0, 6);
            var built = await Promise.all(mons.map(buildOppMon));
            if (!isCurrent("team", token)) return;
            state.oppTeam = built.map(function (b) { return b.set; });
            state.oppSpreads = {};
            built.forEach(function (b, i) {
                state.oppSpreads[mons[i].pokemon] = b.entry;
            });
            renderOppTeam();
            setStatus($("opp-status"), "Team loaded (" + state.oppTeam.length + " Pokemon).", "success");
            recompute();
        } catch (err) {
            if (!isCurrent("team", token)) return;
            setStatus($("opp-status"), "Error: " + err.message, "error");
        }
    }

    /** Render the selected opponent team with per-mon spread dropdowns. */
    function renderOppTeam() {
        var host = $("opp-team-list");
        if (!host) return;
        host.innerHTML = "";

        if (!state.oppTeam.length) {
            host.innerHTML = '<p class="empty muted">No opponent selected.</p>';
            return;
        }

        state.oppTeam.forEach(function (set) {
            var mon = (state.selectedTeam && state.selectedTeam.team || []).filter(function (m) {
                return m.pokemon === set.species;
            })[0] || {};
            var entry = state.oppSpreads[set.species] || { spreads: [], chosenIndex: 0, matched: false, assumed: true };

            var card = document.createElement("div");
            card.className = "opp-card";

            var head = document.createElement("div");
            head.className = "opp-card-head";
            head.appendChild(spriteEl(mon.sprite));
            var title = document.createElement("div");
            var badge = (entry.assumed || !entry.matched)
                ? '<span class="badge" title="No real usage data; a default spread is assumed.">assumed</span>'
                : "";
            title.innerHTML = '<div class="opp-card-title">' + escapeHtml(set.species) + badge + "</div>" +
                '<div class="opp-card-sub">' + escapeHtml(set.item || "no item") + " \u00b7 " +
                escapeHtml(set.ability || "no ability") + "</div>";
            head.appendChild(title);
            card.appendChild(head);

            var select = document.createElement("select");
            select.className = "select-input";
            select.setAttribute("aria-label", "Spread for " + set.species);
            entry.spreads.forEach(function (sp, i) {
                var opt = document.createElement("option");
                opt.value = String(i);
                var pctText = (sp.pct == null) ? "assumed" : (sp.pct + "%");
                opt.textContent = sp.label + " (" + pctText + ")";
                if (i === entry.chosenIndex) opt.selected = true;
                select.appendChild(opt);
            });
            select.addEventListener("change", function () {
                setOppSpread(set.species, Number(select.value));
            });
            card.appendChild(select);

            if (set.warnings && set.warnings.length) {
                var warn = document.createElement("div");
                warn.className = "warnings";
                set.warnings.forEach(function (w) {
                    var p = document.createElement("p");
                    p.textContent = w;
                    warn.appendChild(p);
                });
                card.appendChild(warn);
            }

            // Terastallization opt-in. Only shown when the set has a Tera Type
            // (otherwise there is nothing to terastallize into).
            if (set.teraType) {
                var teraLabel = document.createElement("label");
                teraLabel.className = "tera-toggle";
                var teraBox = document.createElement("input");
                teraBox.type = "checkbox";
                teraBox.checked = set.terastallized === true;
                teraBox.addEventListener("change", function () {
                    setOppTerastallized(set.species, teraBox.checked);
                });
                teraLabel.appendChild(teraBox);
                teraLabel.appendChild(document.createTextNode(" Terastallized (" + set.teraType + ")"));
                card.appendChild(teraLabel);
            }

            host.appendChild(card);
        });
    }

    /**
     * Toggle Terastallization for one opponent Pokemon.
     * @param {string} pokemon
     * @param {boolean} on
     */
    function setOppTerastallized(pokemon, on) {
        var set = state.oppTeam.filter(function (s) { return s.species === pokemon; })[0];
        if (!set) return;
        set.terastallized = !!on;
        recompute();
    }

    /**
     * Change the chosen spread for one opponent Pokemon.
     * @param {string} pokemon
     * @param {number} index
     */
    function setOppSpread(pokemon, index) {
        var entry = state.oppSpreads[pokemon];
        if (!entry || !entry.spreads[index]) return;
        entry.chosenIndex = index;
        var sp = entry.spreads[index];
        var set = state.oppTeam.filter(function (s) { return s.species === pokemon; })[0];
        if (set) {
            set.sps = sp.sps;
            set.nature = sp.nature || set.nature;
        }
        recompute();
    }

    // ------------------------------------------------------------------
    // Field
    // ------------------------------------------------------------------

    /**
     * Update one or more field toggles and recompute.
     * @param {object} partial - subset of state.field
     */
    function setField(partial) {
        Object.keys(partial).forEach(function (k) {
            state.field[k] = partial[k];
        });
        recompute();
    }

    /** Wire the field radios/checkboxes to state. */
    function initFieldControls() {
        document.querySelectorAll('#weather-radios input[name="weather"]').forEach(function (r) {
            r.addEventListener("change", function () {
                if (r.checked) setField({ weather: r.value });
            });
        });
        document.querySelectorAll('#terrain-radios input[name="terrain"]').forEach(function (r) {
            r.addEventListener("change", function () {
                if (r.checked) setField({ terrain: r.value });
            });
        });
        [
            ["field-reflect", "reflect"],
            ["field-light-screen", "lightScreen"],
            ["field-tailwind", "tailwind"],
            ["field-helping-hand", "helpingHand"],
        ].forEach(function (pair) {
            var el = $(pair[0]);
            if (!el) return;
            el.addEventListener("change", function () {
                var partial = {};
                partial[pair[1]] = el.checked;
                setField(partial);
            });
        });
    }

    // ------------------------------------------------------------------
    // Main area / recompute
    // ------------------------------------------------------------------

    /** Render the matchup header. */
    function renderHeader() {
        var header = $("matchup-header");
        var myLead = state.myTeam[0];
        if (!myLead || !state.selectedTeam) {
            header.innerHTML = '<p class="empty muted">Select a team to begin.</p>';
            return;
        }
        var tournamentName = state.selectedTournament ? state.selectedTournament.name : "";
        header.innerHTML = "<h2>" + escapeHtml(myLead.species) + " vs " +
            escapeHtml(state.selectedTeam.name) + " \u2014 " + escapeHtml(tournamentName) + "</h2>";
    }

    /**
     * Clear the C2 panels with a message (used for empty state / no engine).
     * @param {string} message
     */
    function clearMatchupPanels(message) {
        ["matrix-container", "detail-panel", "best4-panel"].forEach(function (id) {
            var node = $(id);
            if (node) node.innerHTML = '<p class="empty muted">' + escapeHtml(message) + "</p>";
        });
        var sidebar = $("best4-sidebar");
        if (sidebar) {
            sidebar.className = "placeholder muted small";
            sidebar.textContent = message;
        }
    }

    /**
     * Phase C2 renderMatchup. Orchestrates the matrix, detail panel and best-4
     * panels. matrix.js/scoring.js load BEFORE this file and register
     * window.Matrix / window.Scoring, so the C2 renderers are always present
     * when the engine is; the guards below only cover a missing engine or a
     * script that failed to load.
     *
     * The matrix model (all 36 calcMatchup results) is built once and shared
     * with the detail and best-4 renderers so field toggles recompute
     * everything through this single path.
     */
    function renderMatchup() {
        renderHeader();

        if (!window.CalcEngine || !window.CalcEngine.ready) {
            clearMatchupPanels("Damage engine unavailable; matchups cannot be computed.");
            return;
        }
        if (!state.myTeam.length || !state.oppTeam.length) {
            clearMatchupPanels("Load my team and select an opponent team to see the matchup.");
            return;
        }
        if (!window.Matrix || typeof window.Matrix.buildModel !== "function") {
            clearMatchupPanels("matrix.js failed to load; cannot render the matchup.");
            return;
        }

        var started = (window.performance && performance.now) ? performance.now() : Date.now();
        var model = window.Matrix.buildModel(state);
        state.matchup = model.pairings;
        window.Matrix.render(model);
        if (window.Scoring && typeof window.Scoring.render === "function") {
            window.Scoring.render(model);
        }
        var elapsed = ((window.performance && performance.now) ? performance.now() : Date.now()) - started;
        console.log("[recompute] " + state.myTeam.length + "\u00d7" + state.oppTeam.length +
            " matrix in " + elapsed.toFixed(1) + " ms (field=" + JSON.stringify(state.field) + ")");
    }

    window.renderMatchup = renderMatchup;

    /**
     * Single recompute entry point. All field/spread/team changes flow through
     * here so the matrix, detail panel and best-4 ranking stay in sync.
     */
    function recompute() {
        console.log("[recompute] field=", state.field,
            "myTeam=" + state.myTeam.length, "oppTeam=" + state.oppTeam.length);
        if (typeof window.renderMatchup === "function") {
            window.renderMatchup();
        }
    }

    // ------------------------------------------------------------------
    // Bootstrap
    // ------------------------------------------------------------------

    /** Show a banner if the vendored engine failed to load. */
    function checkEngine() {
        var banner = $("engine-banner");
        if (!window.CalcEngine || !window.CalcEngine.ready) {
            banner.hidden = false;
            banner.textContent = "Damage engine failed to load (CalcEngine missing or not ready). " +
                "Matchups cannot be computed.";
            return false;
        }
        return true;
    }

    /** Wire all static controls once. */
    function initControls() {
        $("load-url-btn").addEventListener("click", loadMyTeamUrl);
        $("load-text-btn").addEventListener("click", loadMyTeamText);
        $("clear-team-btn").addEventListener("click", clearMyTeam);

        $("paste-toggle").addEventListener("click", function () {
            var wrap = $("paste-text-wrap");
            var open = wrap.hidden;
            wrap.hidden = !open;
            $("paste-toggle").setAttribute("aria-expanded", String(open));
        });

        $("tournament-select").addEventListener("change", function (e) {
            selectTournament(e.target.value);
        });

        document.querySelectorAll("#day-filters .btn-day").forEach(function (btn) {
            btn.addEventListener("click", function () { setDay(btn.dataset.day); });
        });

        $("team-filter").addEventListener("input", function (e) {
            setTeamFilter(e.target.value);
        });
        $("team-filter-clear").addEventListener("click", function () {
            setTeamFilter("");
            $("team-filter").focus();
        });

        initFieldControls();
    }

    /** Public API for Phase C2 and debugging. */
    window.App = {
        state: state,
        escapeHtml: escapeHtml,
        loadMyTeamUrl: loadMyTeamUrl,
        loadMyTeamText: loadMyTeamText,
        clearMyTeam: clearMyTeam,
        loadTournaments: loadTournaments,
        selectTournament: selectTournament,
        setDay: setDay,
        setTeamFilter: setTeamFilter,
        getFilteredTeams: getFilteredTeams,
        normalizeName: normalizeName,
        selectTeam: selectTeam,
        setOppSpread: setOppSpread,
        setOppTerastallized: setOppTerastallized,
        setField: setField,
        recompute: recompute,
        renderMatchup: window.renderMatchup,
    };

    function init() {
        checkEngine();
        initControls();
        restoreMyTeam();
        restoreTeamFilter();
        $("team-filter").value = state.teamFilter;
        renderTeamList();
        loadTournaments();
        recompute();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
