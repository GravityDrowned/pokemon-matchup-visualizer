"""Route tests for server.py using Flask's test client.

All network access is mocked so the suite runs fully offline.
"""

from __future__ import annotations

import pytest

import cache
import munchstats_api
import pokepaste_api
import server


@pytest.fixture(autouse=True)
def _isolated_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(cache, "CACHE_DIR", str(tmp_path))


@pytest.fixture
def client():
    server.app.config["TESTING"] = True
    with server.app.test_client() as c:
        yield c


# ---------------------------------------------------------------------------
# /healthz
# ---------------------------------------------------------------------------


def test_healthz(client):
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.get_json() == {"ok": True}


# ---------------------------------------------------------------------------
# /api/team -- valid inputs
# ---------------------------------------------------------------------------

SAMPLE_TEAM = "Salamence @ Life Orb\n- Draco Meteor\n"


def test_team_text_valid(client):
    resp = client.post("/api/team", json={"text": SAMPLE_TEAM})
    assert resp.status_code == 200
    body = resp.get_json()
    assert len(body["sets"]) == 1
    assert body["sets"][0]["species"] == "Salamence"
    assert body["sets"][0]["item"] == "Life Orb"


def test_team_url_valid(client, monkeypatch):
    monkeypatch.setattr(
        pokepaste_api, "fetch_team", lambda url: [{"species": "Pikachu", "warnings": ["w"]}]
    )
    resp = client.post("/api/team", json={"url": "https://pokepast.es/2e5d1e831c6d9e4c"})
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["sets"][0]["species"] == "Pikachu"
    assert body["warnings"] == ["w"]


def test_team_missing_both_returns_400(client):
    resp = client.post("/api/team", json={})
    assert resp.status_code == 400
    assert "error" in resp.get_json()


# ---------------------------------------------------------------------------
# /api/team -- malformed bodies (MEDIUM-3)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "payload",
    [
        [1, 2, 3],
        "just a string",
        42,
        True,
        None,
    ],
)
def test_team_non_object_body_returns_400(client, payload):
    resp = client.post("/api/team", json=payload)
    assert resp.status_code == 400
    assert "error" in resp.get_json()


def test_team_non_string_fields_return_400(client):
    assert client.post("/api/team", json={"url": 12345}).status_code == 400
    assert client.post("/api/team", json={"text": ["Salamence"]}).status_code == 400
    assert client.post("/api/team", json={"url": {"nested": 1}}).status_code == 400


def test_team_invalid_json_returns_400(client):
    resp = client.post(
        "/api/team", data="{not json", content_type="application/json"
    )
    assert resp.status_code == 400
    assert "error" in resp.get_json()


def test_team_bad_paste_id_returns_400(client):
    resp = client.post("/api/team", json={"url": "https://pokepast.es/nothex!!"})
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# /api/spreads -- invalid format/rating (MEDIUM-4)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "query",
    [
        "format=../../evil",
        "format=..",
        "format=has%20space",
        "format=" + "a" * 65,
        "rating=../../etc",
        "rating=..",
        "rating=bad%2Fslash",
    ],
)
def test_spreads_rejects_bad_params(client, query):
    resp = client.get("/api/spreads/Pikachu?" + query)
    assert resp.status_code == 400
    assert "error" in resp.get_json()


def test_spreads_rejects_overlong_pokemon_name(client):
    resp = client.get("/api/spreads/" + "a" * 65)
    assert resp.status_code == 400


def test_spreads_valid_params_call_through(client, monkeypatch):
    monkeypatch.setattr(
        munchstats_api,
        "get_spreads",
        lambda *a: {
            "spreads": [{"label": "x"}],
            "natures": [{"name": "Timid", "pct": 48.1}],
            "matched": True,
            "requested": "Pikachu",
            "resolved": "Pikachu",
            "source": "championsdoubles",
            "sourceLabel": "Champions (in-game)",
            "natureInferred": True,
        },
    )
    monkeypatch.setattr(munchstats_api, "get_usage", lambda *a: {"pokemon": "Pikachu"})
    resp = client.get("/api/spreads/Pikachu?format=gen9championsvgc2026regmbbo3&rating=0")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["spreads"] == [{"label": "x"}]
    # Provenance fields pass through.
    assert body["matched"] is True
    assert body["requested"] == "Pikachu"
    assert body["resolved"] == "Pikachu"
    assert body["source"] == "championsdoubles"
    assert body["sourceLabel"] == "Champions (in-game)"
    assert body["natureInferred"] is True
    assert body["natures"] == [{"name": "Timid", "pct": 48.1}]


def test_spreads_defaults_to_current_tournament_format(client, monkeypatch):
    captured = {}

    def fake_get_spreads(pokemon, format_id, rating):
        captured["format"] = format_id
        return {
            "spreads": [], "natures": [], "matched": False,
            "requested": pokemon, "resolved": "", "source": "",
            "sourceLabel": "", "natureInferred": False,
        }

    monkeypatch.setattr(munchstats_api, "get_spreads", fake_get_spreads)
    monkeypatch.setattr(munchstats_api, "get_usage", lambda *a: {"pokemon": "Pikachu"})

    resp = client.get("/api/spreads/Pikachu")
    assert resp.status_code == 200
    # No ?format= -> the current Reg M-C tournament format is used.
    assert captured["format"] == "gen9championsvgc2026regmc"


# ---------------------------------------------------------------------------
# MEDIUM-6 -- request size cap
# ---------------------------------------------------------------------------


def test_oversized_body_returns_json_413(client):
    big = "x" * (1024 * 1024 + 10)
    resp = client.post("/api/team", json={"text": big})
    assert resp.status_code == 413
    assert "error" in resp.get_json()


# ---------------------------------------------------------------------------
# LOW-11 -- cache clear gated behind PMV_ADMIN
# ---------------------------------------------------------------------------


def test_cache_clear_disabled_by_default(client, monkeypatch):
    monkeypatch.delenv("PMV_ADMIN", raising=False)
    resp = client.post("/api/cache/clear")
    assert resp.status_code == 404


def test_cache_clear_enabled_with_admin(client, monkeypatch):
    monkeypatch.setenv("PMV_ADMIN", "1")
    monkeypatch.setattr(cache, "clear", lambda: 3)
    resp = client.post("/api/cache/clear")
    assert resp.status_code == 200
    assert resp.get_json() == {"cleared": 3}
