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

    spreads = munchstats_api.get_spreads("Kingambit")

    assert len(spreads) == 3
    # Sorted by pct descending.
    assert [s["pct"] for s in spreads] == [14.03, 7.445, 5.05]
    top = spreads[0]
    assert top["label"] == "Adamant:32/32/0/0/2/0"
    assert top["nature"] == "Adamant"
    assert top["sps"] == {"hp": 32, "at": 32, "df": 0, "sa": 0, "sd": 2, "sp": 0}


def test_get_spreads_empty_when_missing(monkeypatch):
    _patch_get(monkeypatch, {"selected_pokemon": "X"})
    assert munchstats_api.get_spreads("X") == []


def test_get_usage_cleans_lists(monkeypatch):
    _patch_get(monkeypatch, SPREADS_PAYLOAD)

    usage = munchstats_api.get_usage("Kingambit")

    assert usage["pokemon"] == "Kingambit"
    assert usage["matched"] is True
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
