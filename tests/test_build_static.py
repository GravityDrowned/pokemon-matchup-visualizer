"""Tests for build_static.py (offline; no network access).

The slug table here is mirrored verbatim in static/datasource.test.html, which
asserts the JavaScript ``pokemonSlug`` produces the same values. Keeping the
two tables identical is what stops the Python build and the browser from
disagreeing about filenames.
"""

from __future__ import annotations

import json

import build_static


# Shared with static/datasource.test.html -- do not change one without the
# other.
SLUG_CASES = [
    ("Salamence-Mega", "salamence-mega"),
    ("Kingambit", "kingambit"),
    ("Indeedee-F", "indeedee-f"),
    ("Mr. Mime", "mr-mime"),
    ("Flutter Mane", "flutter-mane"),
    ("Charizard-Mega-Y", "charizard-mega-y"),
    ("  Charizard  ", "charizard"),
    ("Type: Null", "type-null"),
    ("Farfetch'd", "farfetch-d"),
    ("", "unknown"),
]


def test_pokemon_slug_matches_shared_table():
    for name, expected in SLUG_CASES:
        assert build_static.pokemon_slug(name) == expected, name


def test_pokemon_slug_is_filesystem_safe():
    slug = build_static.pokemon_slug("../../etc/passwd")
    assert "/" not in slug
    assert ".." not in slug
    assert slug == "etc-passwd"


# ---------------------------------------------------------------------------
# Payload stripping
# ---------------------------------------------------------------------------

RAW_TEAM = {
    "name": "Joseph Ugarte",
    "placement": 1,
    "day_reached": "top8",
    "record": {"wins": 16, "losses": 2},
    "team": [
        {
            "pokemon": "Excadrill",
            "item": "Focus Sash",
            "ability": "Sand Rush",
            "nature": "Jolly",
            "moves": ["Iron Head", "High Horsepower", "Rock Slide", "Protect"],
            "tera_type": "",
            "sprite": [44, 2],
            # Fields the frontend never reads; must be dropped.
            "evs": [0, 32, 0, 0, 0, 32],
            "unknown_extra": {"nested": "payload"},
        }
    ],
    # Top-level noise that must be dropped.
    "country": "US",
    "replays": ["http://example.invalid"],
}


def test_strip_team_keeps_only_used_fields():
    stripped = build_static.strip_team(RAW_TEAM)

    assert set(stripped) == {"name", "placement", "day_reached", "record", "team"}
    mon = stripped["team"][0]
    assert set(mon) == {
        "pokemon", "item", "ability", "nature", "moves", "tera_type", "sprite",
    }
    assert mon["pokemon"] == "Excadrill"
    assert mon["moves"] == RAW_TEAM["team"][0]["moves"]
    assert "evs" not in mon
    assert "unknown_extra" not in mon
    assert "country" not in stripped
    assert "replays" not in stripped


def test_strip_team_tolerates_missing_team():
    stripped = build_static.strip_team({"name": "X", "placement": 2})
    assert stripped["team"] == []


RAW_USAGE = {
    "pokemon": "Kingambit",
    "requested": "Kingambit",
    "matched": True,
    "moves": [{"name": "Sucker Punch", "pct": 99.434}],
    "items": [{"name": "Chople Berry", "pct": 30.641, "sprite": [4, 7]}],
    "abilities": [{"name": "Defiant", "pct": 99.6}],
    "natures": [{"name": "Adamant", "pct": 92.945}],
    "tera_types": [{"name": "Dark", "pct": 40.0}],
    "base_stats": [100, 135, 120, 60, 85, 50],
    "types": ["Dark", "Steel"],
    # Huge fields that must be dropped.
    "evs_list": [[0, 32, 0, 0, 0, 32]] * 100,
    "graph_data": "x" * 5000,
    "available_months": ["2026-01", "2026-02"],
    "teammates_list": [["Incineroar", "30.0"]] * 50,
}

RAW_POKEMON_NAMES = [
    ["Kingambit", "41.72", [81, 11], "up"],
    ["Incineroar", "32.15", [60, 7], "down"],
]


def test_strip_usage_keeps_used_fields_and_drops_huge_ones():
    stripped = build_static.strip_usage(RAW_USAGE, RAW_POKEMON_NAMES)

    for key in ("evs_list", "graph_data", "available_months", "teammates_list"):
        assert key not in stripped
    assert stripped["base_stats"] == [100, 135, 120, 60, 85, 50]
    assert stripped["types"] == ["Dark", "Steel"]
    assert stripped["moves"][0]["name"] == "Sucker Punch"
    # pokemon_names is reduced to names only (frontend only needs the names).
    assert stripped["pokemon_names"] == ["Kingambit", "Incineroar"]


def test_strip_usage_shrinks_payload_substantially():
    raw_size = len(json.dumps(RAW_USAGE))
    stripped_size = len(json.dumps(build_static.strip_usage(RAW_USAGE, [])))
    assert stripped_size < raw_size / 4


# ---------------------------------------------------------------------------
# Size guard
# ---------------------------------------------------------------------------

IDS = ["t1", "t2", "t3", "t4", "t5", "t6", "t7"]


def test_size_guard_not_triggered_under_limit():
    kept, triggered = build_static.reduce_all_scope(IDS, total_bytes=100, limit_bytes=200)
    assert kept == IDS
    assert triggered is False


def test_size_guard_triggers_and_keeps_most_recent():
    kept, triggered = build_static.reduce_all_scope(
        IDS, total_bytes=300, limit_bytes=200, keep_recent=5
    )
    assert triggered is True
    assert kept == IDS[:5]


def test_size_guard_at_exact_limit_is_not_triggered():
    kept, triggered = build_static.reduce_all_scope(IDS, total_bytes=200, limit_bytes=200)
    assert triggered is False
    assert kept == IDS


# ---------------------------------------------------------------------------
# Relative-path rewriting
# ---------------------------------------------------------------------------

SAMPLE_HTML = """<!DOCTYPE html>
<html>
<head>
    <link rel="icon" href="/static/favicon.svg">
    <link rel="stylesheet" href="/static/style.css">
    <script>window.PM_VISUALIZER_MODE = "api";</script>
</head>
<body>
    <script src="/static/calc/vendor/jquery.min.js"></script>
    <script src="/static/calc/adapter.js"></script>
    <script src="/static/app.js"></script>
</body>
</html>
"""


def test_rewrite_index_html_makes_paths_relative():
    result = build_static.rewrite_index_html(SAMPLE_HTML)

    assert 'href="./favicon.svg"' in result
    assert 'href="./style.css"' in result
    assert 'src="./calc/vendor/jquery.min.js"' in result
    assert 'src="./calc/adapter.js"' in result
    assert 'src="./app.js"' in result
    assert "/static/" not in result


def test_rewrite_index_html_flips_mode_flag():
    result = build_static.rewrite_index_html(SAMPLE_HTML)
    assert 'window.PM_VISUALIZER_MODE = "static"' in result
    assert 'window.PM_VISUALIZER_MODE = "api"' not in result


def test_rewrite_index_html_adds_generated_banner():
    result = build_static.rewrite_index_html(SAMPLE_HTML)
    assert "Generated by build_static.py" in result


def test_rewrite_real_template_has_no_absolute_static_paths():
    import os

    template_path = os.path.join(build_static.TEMPLATES_DIR, "index.html")
    with open(template_path, "r", encoding="utf-8") as handle:
        result = build_static.rewrite_index_html(handle.read())
    assert "/static/" not in result
    assert 'window.PM_VISUALIZER_MODE = "static"' in result


# ---------------------------------------------------------------------------
# CLI parsing helpers
# ---------------------------------------------------------------------------

TOURNAMENTS = [{"id": f"id{i}"} for i in range(10)]


def test_select_tournaments_all():
    assert build_static._select_tournaments(TOURNAMENTS, "all") == TOURNAMENTS


def test_select_tournaments_count():
    selected = build_static._select_tournaments(TOURNAMENTS, "3")
    assert [t["id"] for t in selected] == ["id0", "id1", "id2"]


def test_select_tournaments_explicit_ids():
    selected = build_static._select_tournaments(TOURNAMENTS, "id2,id5")
    assert [t["id"] for t in selected] == ["id2", "id5"]


def test_select_tournaments_unknown_id_exits():
    import pytest

    with pytest.raises(SystemExit):
        build_static._select_tournaments(TOURNAMENTS, "nope")


def test_parse_days_valid():
    assert build_static._parse_days("all,day2") == ["all", "day2"]


def test_parse_days_invalid_exits():
    import pytest

    with pytest.raises(SystemExit):
        build_static._parse_days("all,day3")
