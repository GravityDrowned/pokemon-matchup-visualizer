"""Tests for munchstats_api with requests mocked (runs fully offline)."""

from __future__ import annotations

import pytest

import cache
import munchstats_api


@pytest.fixture(autouse=True)
def _isolated_cache(tmp_path, monkeypatch):
    """Point the file cache at a temp dir so tests never touch the real one."""
    monkeypatch.setattr(cache, "CACHE_DIR", str(tmp_path))


class FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


def _patch_get(monkeypatch, payload):
    """Make requests.get return ``payload`` and record the requested URL."""
    calls: list[tuple[str, dict]] = []

    def fake_get(url, params=None, timeout=None, headers=None):
        calls.append((url, params or {}))
        return FakeResponse(payload)

    monkeypatch.setattr(munchstats_api.requests, "get", fake_get)
    return calls


def _patch_routes(monkeypatch, routes):
    """Route requests by ``(format_id, pokemon)`` to a payload.

    ``routes`` maps ``(format_id, pokemon)`` to a payload dict. Any route not
    present resolves to an empty payload (which never matches). Records the
    requested URLs so tests can assert how many upstream calls were made.
    """
    calls: list[str] = []

    def fake_get(url, params=None, timeout=None, headers=None):
        calls.append(url)
        tail = url.split("/api/", 1)[1]
        fmt, _rating, name = tail.split("/", 2)
        return FakeResponse(routes.get((fmt, name), {}))

    monkeypatch.setattr(munchstats_api.requests, "get", fake_get)
    return calls


SPREADS_PAYLOAD = {
    "selected_pokemon": "Kingambit",
    "spreads_list": [
        ["Adamant:32/32/0/0/2/0", "14.030"],
        ["Adamant:32/32/0/0/1/1", "7.445"],
        ["Adamant:2/32/0/0/0/32", "5.050"],
    ],
    "moves_list": [["Sucker Punch", "99.434", "Dark (Physical)"]],
    "items_list": [["Chople Berry", "30.641", "Halves damage.", [4, 7]]],
    "abilities_list": [["Defiant", "99.6", "Raises Attack."]],
    "natures_list": [["Adamant", "92.945", "+Atk / -SpA"]],
    "tera_types_list": [["Dark", "40.0"]],
    "base_stats": [100, 135, 120, 60, 85, 50],
    "pokemon_types": ["Dark", "Steel"],
}


def test_get_spreads_parses_and_sorts(monkeypatch):
    _patch_get(monkeypatch, SPREADS_PAYLOAD)

    result = munchstats_api.get_spreads("Kingambit")

    spreads = result["spreads"]
    assert len(spreads) == 3
    # Sorted by pct descending.
    assert [s["pct"] for s in spreads] == [14.03, 7.445, 5.05]
    top = spreads[0]
    assert top["label"] == "Adamant:32/32/0/0/2/0"
    assert top["nature"] == "Adamant"
    assert top["sps"] == {"hp": 32, "at": 32, "df": 0, "sa": 0, "sd": 2, "sp": 0}
    assert result["matched"] is True
    assert result["source"] == munchstats_api.DEFAULT_FORMAT_ID
    assert result["natureInferred"] is False


def test_get_spreads_empty_when_missing(monkeypatch):
    # Resolves to "X" (a match) but has no spreads_list.
    _patch_get(monkeypatch, {"selected_pokemon": "X"})
    result = munchstats_api.get_spreads("X")
    assert result["spreads"] == []
    assert result["matched"] is True


def test_get_usage_cleans_lists(monkeypatch):
    _patch_get(monkeypatch, SPREADS_PAYLOAD)

    usage = munchstats_api.get_usage("Kingambit")

    assert usage["pokemon"] == "Kingambit"
    assert usage["matched"] is True
    assert usage["source"] == munchstats_api.DEFAULT_FORMAT_ID
    assert usage["moves"][0]["name"] == "Sucker Punch"
    assert usage["moves"][0]["pct"] == 99.434
    assert usage["items"][0]["sprite"] == [4, 7]
    assert usage["abilities"][0]["name"] == "Defiant"
    assert usage["base_stats"] == [100, 135, 120, 60, 85, 50]
    assert usage["types"] == ["Dark", "Steel"]


def test_get_usage_flags_fuzzy_substitution(monkeypatch):
    # The API fuzzy-matches unknown names; we must surface the mismatch.
    payload = dict(SPREADS_PAYLOAD, selected_pokemon="Kingambit")
    _patch_get(monkeypatch, payload)

    usage = munchstats_api.get_usage("NotARealMon")

    assert usage["pokemon"] == "Kingambit"
    assert usage["requested"] == "NotARealMon"
    assert usage["matched"] is False


def test_get_best_spread(monkeypatch):
    _patch_get(monkeypatch, SPREADS_PAYLOAD)
    best = munchstats_api.get_best_spread("Kingambit")
    assert best["label"] == "Adamant:32/32/0/0/2/0"


def test_get_best_spread_none_when_unmatched(monkeypatch):
    _patch_get(monkeypatch, {"selected_pokemon": "Kingambit"})
    assert munchstats_api.get_best_spread("NotARealMon") is None


# ---------------------------------------------------------------------------
# usage_format_for_tournament() -- tournament regulation -> usage dataset
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "tournament_format,expected",
    [
        ("gen9championsvgc2026regmc", munchstats_api.CHAMPIONS_FORMAT_ID),
        ("gen9championsvgc2026regmcbo3", munchstats_api.CHAMPIONS_FORMAT_ID),
        ("gen9championsvgc2026regmb", munchstats_api.DEFAULT_FORMAT_ID),
        ("gen9championsvgc2026regmabo3", munchstats_api.CHAMPIONS_FORMAT_ID),
        ("gen9championsvgc2026regma", munchstats_api.CHAMPIONS_FORMAT_ID),
        ("gen9vgc2026regi", munchstats_api.DEFAULT_FORMAT_ID),
        ("gen9vgc2025regh", munchstats_api.DEFAULT_FORMAT_ID),
        # A usage id passes through unchanged.
        ("championsdoubles", munchstats_api.CHAMPIONS_FORMAT_ID),
        # Empty/unknown is not a Champions regulation -> the Reg M-B default.
        ("", munchstats_api.DEFAULT_FORMAT_ID),
        # Case-insensitive and whitespace-tolerant.
        ("  Gen9ChampionsVGC2026RegMB  ", munchstats_api.DEFAULT_FORMAT_ID),
        ("GEN9CHAMPIONSVGC2026REGMCBO3", munchstats_api.CHAMPIONS_FORMAT_ID),
    ],
)
def test_usage_format_for_tournament(tournament_format, expected):
    assert munchstats_api.usage_format_for_tournament(tournament_format) == expected


def test_pre_champions_tournament_prefers_regmb_not_championsdoubles():
    # championsdoubles does not cover pre-Champions mons (Amoonguss/Urshifu
    # both resolve to Rillaboom), so a pre-Champions reg must use regmbbo3.
    assert (
        munchstats_api.usage_format_for_tournament("gen9vgc2025regh")
        == munchstats_api.DEFAULT_FORMAT_ID
    )
    assert (
        munchstats_api.usage_format_for_tournament("gen9vgc2026regi")
        == munchstats_api.DEFAULT_FORMAT_ID
    )


def test_source_label_maps_both_sources_and_raw_fallback():
    assert munchstats_api.source_label(munchstats_api.CHAMPIONS_FORMAT_ID) == "Champions (in-game)"
    assert munchstats_api.source_label(munchstats_api.DEFAULT_FORMAT_ID) == "Reg M-B (Bo3)"
    assert munchstats_api.source_label("somethingelse") == "somethingelse"


# ---------------------------------------------------------------------------
# Format-aware chain: a TOURNAMENT format is mapped before resolving
# ---------------------------------------------------------------------------


def test_regmc_primary_maps_to_championsdoubles(monkeypatch):
    calls = _patch_routes(
        monkeypatch,
        {
            (munchstats_api.CHAMPIONS_FORMAT_ID, "Incineroar"): dict(
                CHAMPIONS_PAYLOAD,
                selected_pokemon="Incineroar",
                current_pokemon=["Incineroar", "", "3", [1, 1]],
            ),
        },
    )

    result = munchstats_api.get_spreads("Incineroar", "gen9championsvgc2026regmc")

    assert result["matched"] is True
    assert result["source"] == munchstats_api.CHAMPIONS_FORMAT_ID
    assert result["sourceLabel"] == "Champions (in-game)"
    assert result["natureInferred"] is True
    # The regmbbo3 dataset was never queried.
    assert all(munchstats_api.CHAMPIONS_FORMAT_ID in url for url in calls)


def test_regmb_primary_maps_to_regmbbo3(monkeypatch):
    _patch_routes(
        monkeypatch,
        {(munchstats_api.DEFAULT_FORMAT_ID, "Incineroar"): dict(
            SPREADS_PAYLOAD, selected_pokemon="Incineroar",
        )},
    )

    result = munchstats_api.get_spreads("Incineroar", "gen9championsvgc2026regmb")

    assert result["matched"] is True
    assert result["source"] == munchstats_api.DEFAULT_FORMAT_ID
    assert result["sourceLabel"] == "Reg M-B (Bo3)"
    assert result["natureInferred"] is False


def test_chain_falls_back_to_other_format_when_primary_fails(monkeypatch):
    # Primary is championsdoubles (regmc); it substitutes, so the chain must
    # fall back to the OTHER format (regmbbo3).
    _patch_routes(
        monkeypatch,
        {
            (munchstats_api.CHAMPIONS_FORMAT_ID, "Rillaboom"): {"selected_pokemon": "Kingambit"},
            (munchstats_api.DEFAULT_FORMAT_ID, "Rillaboom"): dict(
                SPREADS_PAYLOAD, selected_pokemon="Rillaboom",
            ),
        },
    )

    result = munchstats_api.get_spreads("Rillaboom", "gen9championsvgc2026regmc")

    assert result["matched"] is True
    assert result["source"] == munchstats_api.DEFAULT_FORMAT_ID
    assert result["sourceLabel"] == "Reg M-B (Bo3)"


def test_chain_falls_back_from_regmb_to_championsdoubles(monkeypatch):
    # Primary is regmbbo3 (regmb); it substitutes, so fall back to
    # championsdoubles.
    _patch_routes(
        monkeypatch,
        {
            (munchstats_api.DEFAULT_FORMAT_ID, "Salamence"): {"selected_pokemon": "Sableye-Mega"},
            (munchstats_api.CHAMPIONS_FORMAT_ID, "Salamence"): CHAMPIONS_PAYLOAD,
        },
    )

    result = munchstats_api.get_spreads("Salamence", "gen9championsvgc2026regmb")

    assert result["matched"] is True
    assert result["source"] == munchstats_api.CHAMPIONS_FORMAT_ID
    assert result["sourceLabel"] == "Champions (in-game)"
    assert result["natureInferred"] is True


def test_source_label_present_on_unmatched(monkeypatch):
    _patch_routes(
        monkeypatch,
        {
            (munchstats_api.CHAMPIONS_FORMAT_ID, "NotARealMon"): {"selected_pokemon": "Inteleon"},
            (munchstats_api.DEFAULT_FORMAT_ID, "NotARealMon"): {"selected_pokemon": "Kingambit"},
        },
    )

    result = munchstats_api.get_spreads("NotARealMon", "gen9championsvgc2026regmc")

    assert result["matched"] is False
    assert result["sourceLabel"] in ("Champions (in-game)", "Reg M-B (Bo3)")
    assert result["sourceLabel"] == munchstats_api.source_label(result["source"])


# ---------------------------------------------------------------------------
# base_species() -- Mega suffix stripping
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "name,expected",
    [
        ("Salamence-Mega", "Salamence"),
        ("Charizard-Mega-X", "Charizard"),
        ("Raichu-Mega-Y", "Raichu"),
        ("Absol-Mega-Z", "Absol"),
        ("Lucario-Mega-Z", "Lucario"),
        ("Floette-Mega", "Floette"),
        ("Kingambit", "Kingambit"),
        ("Indeedee", "Indeedee"),
        ("  Salamence-Mega  ", "Salamence"),
    ],
)
def test_base_species(name, expected):
    assert munchstats_api.base_species(name) == expected


# ---------------------------------------------------------------------------
# Fallback chain
# ---------------------------------------------------------------------------

SUBSTITUTE = {
    "selected_pokemon": "Sableye-Mega",
    "spreads_list": [["Sassy:32/0/9/0/25/0", "10.661"]],
    "natures_list": [["Sassy", "50.0", "+SpD / -Spe"]],
}

CHAMPIONS_PAYLOAD = {
    "selected_format": ["championsdoubles", "[Champions] In-Game Doubles"],
    "current_pokemon": ["Salamence", "", "3", [31, 1]],
    "selected_pokemon": "Salamence",
    "spreads_list": [
        ["2/0/0/32/0/32", "43.2"],
        ["1/0/0/32/1/32", "6.1"],
        ["1/21/0/15/0/29", "4.3"],
    ],
    "natures_list": [
        ["Timid", "48.1", "+Speed / -Attack"],
        ["Modest", "24.3", "+Sp. Atk / -Attack"],
        ["Naive", "12.0", "+Speed / -Sp. Def"],
    ],
    "evs_list": [[]],
    "moves_list": [["Protect", "94.7", "Normal (Status)"]],
    "items_list": [["Salamencite", "98.0", "Mega stone.", [39, 3]]],
    "abilities_list": [["Intimidate", "98.9", "Lowers Attack."]],
    "tera_types_list": [],
    "base_stats": [95, 135, 80, 110, 80, 100],
    "pokemon_types": ["Dragon", "Flying"],
}


def test_fallback_exact_match_wins(monkeypatch):
    calls = _patch_routes(
        monkeypatch,
        {
            (munchstats_api.DEFAULT_FORMAT_ID, "Kingambit"): SPREADS_PAYLOAD,
            (munchstats_api.CHAMPIONS_FORMAT_ID, "Kingambit"): CHAMPIONS_PAYLOAD,
        },
    )

    result = munchstats_api.get_spreads("Kingambit")

    assert result["matched"] is True
    assert result["source"] == munchstats_api.DEFAULT_FORMAT_ID
    assert result["resolved"] == "Kingambit"
    assert result["natureInferred"] is False
    # Only the first attempt was needed.
    assert len(calls) == 1


def test_fallback_base_species_when_exact_fails(monkeypatch):
    base_payload = dict(SPREADS_PAYLOAD, selected_pokemon="Salamence")
    _patch_routes(
        monkeypatch,
        {
            (munchstats_api.DEFAULT_FORMAT_ID, "Salamence-Mega"): SUBSTITUTE,
            (munchstats_api.DEFAULT_FORMAT_ID, "Salamence"): base_payload,
        },
    )

    result = munchstats_api.get_spreads("Salamence-Mega")

    assert result["matched"] is True
    assert result["source"] == munchstats_api.DEFAULT_FORMAT_ID
    assert result["requested"] == "Salamence-Mega"
    assert result["resolved"] == "Salamence"
    assert result["natureInferred"] is False


def test_fallback_championsdoubles_when_primary_fails(monkeypatch):
    _patch_routes(
        monkeypatch,
        {
            (munchstats_api.DEFAULT_FORMAT_ID, "Salamence-Mega"): SUBSTITUTE,
            (munchstats_api.DEFAULT_FORMAT_ID, "Salamence"): SUBSTITUTE,
            (munchstats_api.CHAMPIONS_FORMAT_ID, "Salamence"): CHAMPIONS_PAYLOAD,
        },
    )

    result = munchstats_api.get_spreads("Salamence-Mega")

    assert result["matched"] is True
    assert result["source"] == munchstats_api.CHAMPIONS_FORMAT_ID
    assert result["resolved"] == "Salamence"
    assert result["natureInferred"] is True
    # Natures come back ranked for the UI to offer.
    assert [n["name"] for n in result["natures"]] == ["Timid", "Modest", "Naive"]
    # Nature-separate shape: the top marginal nature is the best guess.
    assert result["spreads"][0]["nature"] == "Timid"
    assert result["spreads"][0]["label"] == "2/0/0/32/0/32"
    assert result["spreads"][0]["sps"] == {
        "hp": 2, "at": 0, "df": 0, "sa": 32, "sd": 0, "sp": 32,
    }


def test_fallback_all_fail_matched_false(monkeypatch):
    _patch_routes(
        monkeypatch,
        {
            (munchstats_api.DEFAULT_FORMAT_ID, "NotARealMon"): {"selected_pokemon": "Kingambit"},
            (munchstats_api.CHAMPIONS_FORMAT_ID, "NotARealMon"): {"selected_pokemon": "Inteleon"},
        },
    )

    result = munchstats_api.get_spreads("NotARealMon")

    assert result["matched"] is False
    assert result["spreads"] == []
    assert result["natures"] == []
    assert result["requested"] == "NotARealMon"


def test_matched_true_when_mega_resolves_to_base(monkeypatch):
    _patch_routes(
        monkeypatch,
        {
            (munchstats_api.DEFAULT_FORMAT_ID, "Salamence-Mega"): SUBSTITUTE,
            (munchstats_api.CHAMPIONS_FORMAT_ID, "Salamence"): CHAMPIONS_PAYLOAD,
        },
    )

    result = munchstats_api.get_spreads("Salamence-Mega")

    # Querying the base species and resolving it is a MATCH even though the
    # original request was a Mega form.
    assert result["matched"] is True
    assert result["requested"] == "Salamence-Mega"
    assert result["resolved"] == "Salamence"


def test_floette_mega_resolving_to_eternal_is_not_matched(monkeypatch):
    # Floette's base lookup resolves to Floette-Eternal, a DIFFERENT form.
    # We deliberately treat that as NOT matched: showing Floette-Eternal's
    # spreads for Floette-Mega would be as wrong as the Sableye-Mega bug.
    eternal = dict(CHAMPIONS_PAYLOAD, selected_pokemon="Floette-Eternal",
                   current_pokemon=["Floette-Eternal", "", "3", [1, 1]])
    _patch_routes(
        monkeypatch,
        {
            (munchstats_api.DEFAULT_FORMAT_ID, "Floette-Mega"): SUBSTITUTE,
            (munchstats_api.DEFAULT_FORMAT_ID, "Floette"): eternal,
            (munchstats_api.CHAMPIONS_FORMAT_ID, "Floette"): eternal,
        },
    )

    result = munchstats_api.get_spreads("Floette-Mega")

    assert result["matched"] is False
    assert result["resolved"] == "Floette-Eternal"


def test_nature_inferred_only_for_championsdoubles(monkeypatch):
    _patch_routes(
        monkeypatch,
        {
            (munchstats_api.DEFAULT_FORMAT_ID, "Kingambit"): SPREADS_PAYLOAD,
            (munchstats_api.CHAMPIONS_FORMAT_ID, "Salamence"): CHAMPIONS_PAYLOAD,
        },
    )

    primary = munchstats_api.get_spreads("Kingambit")
    champs = munchstats_api.get_spreads("Salamence")

    assert primary["natureInferred"] is False
    assert champs["natureInferred"] is True


def test_parse_both_spread_shapes(monkeypatch):
    # Nature-embedded shape (primary format).
    _patch_routes(
        monkeypatch,
        {(munchstats_api.DEFAULT_FORMAT_ID, "Kingambit"): SPREADS_PAYLOAD},
    )
    embedded = munchstats_api.get_spreads("Kingambit")
    assert embedded["spreads"][0]["nature"] == "Adamant"
    assert embedded["spreads"][0]["label"] == "Adamant:32/32/0/0/2/0"

    # Nature-separate shape (championsdoubles).
    _patch_routes(
        monkeypatch,
        {(munchstats_api.CHAMPIONS_FORMAT_ID, "Salamence"): CHAMPIONS_PAYLOAD},
    )
    separate = munchstats_api.get_spreads("Salamence")
    assert separate["spreads"][0]["nature"] == "Timid"
    assert ":" not in separate["spreads"][0]["label"]


def test_fallback_caches_per_format_and_does_not_refetch(monkeypatch):
    calls = _patch_routes(
        monkeypatch,
        {
            (munchstats_api.DEFAULT_FORMAT_ID, "Salamence-Mega"): SUBSTITUTE,
            (munchstats_api.DEFAULT_FORMAT_ID, "Salamence"): SUBSTITUTE,
            (munchstats_api.CHAMPIONS_FORMAT_ID, "Salamence"): CHAMPIONS_PAYLOAD,
        },
    )

    first = munchstats_api.get_spreads("Salamence-Mega")
    calls_after_first = len(calls)
    second = munchstats_api.get_spreads("Salamence-Mega")

    assert first == second
    # Every upstream payload is cached per (format, name); no re-fetch.
    assert len(calls) == calls_after_first
    assert calls_after_first == 3


TOURNAMENTS_PAYLOAD = {
    "tournaments": [
        {
            "id": "OLD",
            "name": "Old Regional",
            "date": "2025-01-01",
            "type": "Regional",
            "format": "gen9vgc",
            "total_players": 100,
            "teams_scraped": 90,
            "day2_count": 20,
        },
        {
            "id": "NEW",
            "name": "New Regional",
            "date": "2026-09-18",
            "type": "Regional",
            "format": "gen9champions",
            "total_players": 1079,
            "teams_scraped": 1079,
            "day2_count": 156,
        },
    ]
}


def test_list_tournaments_cleans_and_sorts_newest_first(monkeypatch):
    calls = _patch_get(monkeypatch, TOURNAMENTS_PAYLOAD)

    tournaments = munchstats_api.list_tournaments()

    assert [t["id"] for t in tournaments] == ["NEW", "OLD"]
    assert tournaments[0]["teams_scraped"] == 1079
    assert tournaments[0]["day2_count"] == 156
    # Only the fields we care about are kept.
    assert set(tournaments[0]) == {
        "id",
        "name",
        "date",
        "type",
        "format",
        "total_players",
        "teams_scraped",
        "day2_count",
    }
    assert calls  # a request was made


STANDINGS_PAYLOAD = [
    {"name": "Third", "placement": 3, "team": []},
    {"name": "First", "placement": 1, "team": []},
    {"name": "Second", "placement": 2, "team": []},
]


def test_get_teams_sorts_by_placement(monkeypatch):
    calls = _patch_get(monkeypatch, STANDINGS_PAYLOAD)

    teams = munchstats_api.get_teams("BA002-JL3KVbvivVKNAc", "all")

    assert [t["placement"] for t in teams] == [1, 2, 3]
    assert calls[0][1] == {"day": "all"}


def test_get_teams_rejects_bad_day(monkeypatch):
    _patch_get(monkeypatch, STANDINGS_PAYLOAD)
    with pytest.raises(ValueError):
        munchstats_api.get_teams("BA002-JL3KVbvivVKNAc", "day3")


@pytest.mark.parametrize(
    "bad_id",
    ["../etc/passwd", "has space", "a" * 65, "", "semi;colon", "slash/inside"],
)
def test_get_teams_rejects_bad_id(monkeypatch, bad_id):
    _patch_get(monkeypatch, STANDINGS_PAYLOAD)
    with pytest.raises(ValueError):
        munchstats_api.get_teams(bad_id, "all")


def test_request_failure_raises_runtime_error(monkeypatch):
    def boom(*args, **kwargs):
        raise munchstats_api.requests.RequestException("network down")

    monkeypatch.setattr(munchstats_api.requests, "get", boom)
    monkeypatch.setattr(munchstats_api.time, "sleep", lambda _: None)

    with pytest.raises(RuntimeError):
        munchstats_api.get_spreads("Kingambit")


def test_request_failure_message_is_generic(monkeypatch):
    # LOW-13: the client-facing error must not leak the upstream URL.
    def boom(*args, **kwargs):
        raise munchstats_api.requests.RequestException("network down")

    monkeypatch.setattr(munchstats_api.requests, "get", boom)
    monkeypatch.setattr(munchstats_api.time, "sleep", lambda _: None)

    with pytest.raises(RuntimeError) as excinfo:
        munchstats_api.get_spreads("Kingambit")
    assert "munchstats.com" not in str(excinfo.value)


# ---------------------------------------------------------------------------
# MEDIUM-4 -- format/rating/pokemon allowlist
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "format_id,rating,pokemon",
    [
        ("../../evil", "0", "Pikachu"),
        ("gen9x", "../../etc", "Pikachu"),
        ("..", "0", "Pikachu"),
        ("has space", "0", "Pikachu"),
        ("a" * 65, "0", "Pikachu"),
        ("gen9x", "0", "a" * 65),
        ("gen9x", "0", ""),
        ("gen9x\n", "0", "Pikachu"),
    ],
)
def test_validate_usage_params_rejects(format_id, rating, pokemon):
    with pytest.raises(ValueError):
        munchstats_api.validate_usage_params(pokemon, format_id, rating)


def test_validate_usage_params_accepts_defaults():
    munchstats_api.validate_usage_params(
        "Pikachu", munchstats_api.DEFAULT_FORMAT_ID, munchstats_api.DEFAULT_RATING
    )


def test_get_teams_rejects_trailing_newline_id():
    # LOW-10: "$" would allow a trailing newline; fullmatch must not.
    with pytest.raises(ValueError):
        munchstats_api.get_teams("BA002-JL3KVbvivVKNAc\n", "all")
