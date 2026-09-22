"""MunchStats JSON API client.

MunchStats (munchstats.com) serves the tournament and usage data we compare
against. It is a small undocumented JSON API, so this module wraps the four
endpoints we rely on, normalizes their shapes and caches everything.

Endpoint notes (all verified against the live service):

1. Tournament list. There is no ``/api/tournaments``. The full list is embedded
   in the per-tournament payload under ``tournaments``. The ``/tournaments/api/
   {id}/all/{pokemon}`` route ignores the id and pokemon for this purpose and
   returns every tournament, so we use one known id as a bootstrap key. This is
   a trick, hence the comment.

2. Standings / teams. ``/tournaments/api/{id}/standings?day=...`` returns a list
   of players with their six-Pokemon teams.

3. Usage / spreads. ``/api/{formatId}/{rating}/{pokemon}`` returns a large
   object with ``spreads_list`` (label, pct), plus moves/items/abilities/
   natures/base stats/types.

DEFAULT_FORMAT_ID is the gen-9 Champions Reg M-B Bo3 usage format. It is the
closest available usage dataset and is what the MunchStats API serves for the
Champions ruleset.
"""

from __future__ import annotations

import re
import time
from typing import Any
from urllib.parse import quote

import requests

import cache

BASE_URL = "https://www.munchstats.com"
REQUEST_TIMEOUT = 30  # seconds
CACHE_TTL = 24 * 60 * 60  # 24 hours

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)

DEFAULT_FORMAT_ID = "gen9championsvgc2026regmbbo3"
DEFAULT_RATING = "0"

# Bootstrap key for the embedded tournament list; the route ignores it and
# returns every tournament regardless.
_TOURNAMENT_LIST_ID = "BA002-JL3KVbvivVKNAc"
_TOURNAMENT_LIST_POKEMON = "Kingambit"

ALLOWED_DAYS = ("all", "day2", "top16", "top8")

_TOURNAMENT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# Strict allowlist for the format id / rating bucket interpolated into the
# upstream URL and the cache key. Dots are allowed (format ids contain none,
# but ratings could in principle), so ``..`` is rejected explicitly below.
_PARAM_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
MAX_POKEMON_NAME_LENGTH = 64


def validate_usage_params(pokemon: str, format_id: str, rating: str) -> None:
    """Validate the values that get interpolated into the upstream URL.

    Raises ``ValueError`` for anything that is not a short, plain token. This
    stops a client from driving arbitrary upstream paths or minting unbounded
    cache files (e.g. ``format=../../evil``).
    """
    if not _PARAM_RE.fullmatch(format_id or "") or ".." in (format_id or ""):
        raise ValueError(f"Invalid format: {format_id!r}")
    if not _PARAM_RE.fullmatch(rating or "") or ".." in (rating or ""):
        raise ValueError(f"Invalid rating: {rating!r}")
    if not pokemon or len(pokemon) > MAX_POKEMON_NAME_LENGTH:
        raise ValueError(
            f"Invalid pokemon name (1-{MAX_POKEMON_NAME_LENGTH} chars)"
        )

# Stat order in a spread label: Nature:HP/Atk/Def/SpA/SpD/Spe
_SPREAD_KEYS = ("hp", "at", "df", "sa", "sd", "sp")

_RETRY_ATTEMPTS = 2
_RETRY_BACKOFF = 1.0  # seconds


def _get_json(url: str, params: dict | None = None) -> Any:
    """GET ``url`` and return parsed JSON, with a small retry.

    Raises ``RuntimeError`` after the attempts are exhausted or on a JSON
    decode error, so callers never see a raw requests/JSON exception.
    """
    last_error: Exception | None = None

    for attempt in range(1, _RETRY_ATTEMPTS + 1):
        try:
            print(f"  GET {url}" + (f" params={params}" if params else ""))
            resp = requests.get(
                url,
                params=params,
                timeout=REQUEST_TIMEOUT,
                headers={"User-Agent": USER_AGENT},
            )
            resp.raise_for_status()
            return resp.json()
        except (requests.RequestException, ValueError) as exc:
            last_error = exc
            print(f"  Attempt {attempt}/{_RETRY_ATTEMPTS} failed: {exc}")
            if attempt < _RETRY_ATTEMPTS:
                time.sleep(_RETRY_BACKOFF)

    # Log the URL/detail server-side; the client only sees a generic message.
    print(f"  Upstream request failed: {url} ({last_error!r})")
    raise RuntimeError("Upstream data service is unavailable")


def _clean_tournament(raw: dict) -> dict:
    """Reduce one raw tournament record to the fields the app uses."""
    return {
        "id": raw.get("id", ""),
        "name": raw.get("name", ""),
        "date": raw.get("date", ""),
        "type": raw.get("type", ""),
        "format": raw.get("format", ""),
        "total_players": raw.get("total_players", 0),
        "teams_scraped": raw.get("teams_scraped", 0),
        "day2_count": raw.get("day2_count", 0),
    }


def list_tournaments() -> list[dict]:
    """Return every known tournament, newest first.

    Uses the embedded ``tournaments`` array from the bootstrap tournament
    payload (see module docstring). Cached for 24 hours.
    """
    cache_key = "tournaments"

    def fetch() -> list[dict]:
        url = (
            f"{BASE_URL}/tournaments/api/"
            f"{_TOURNAMENT_LIST_ID}/all/{_TOURNAMENT_LIST_POKEMON}"
        )
        data = _get_json(url)
        raw_list = (data or {}).get("tournaments") or []
        cleaned = [_clean_tournament(t) for t in raw_list]
        cleaned.sort(key=lambda t: t.get("date", ""), reverse=True)
        print(f"  -> {len(cleaned)} tournaments")
        return cleaned

    return cache.get_or_set(cache_key, fetch, CACHE_TTL)


def get_teams(tournament_id: str, day: str = "all") -> list[dict]:
    """Return the standings/teams for a tournament, sorted by placement.

    ``day`` filters the field: ``all``, ``day2``, ``top16`` or ``top8``. Raises
    ``ValueError`` for a malformed id or unknown day. Cached 24 hours.
    """
    if not _TOURNAMENT_ID_RE.fullmatch(tournament_id or ""):
        raise ValueError(f"Invalid tournament id: {tournament_id!r}")
    if day not in ALLOWED_DAYS:
        raise ValueError(f"Invalid day filter: {day!r} (allowed: {', '.join(ALLOWED_DAYS)})")

    cache_key = f"teams_{tournament_id}_{day}"

    def fetch() -> list[dict]:
        url = f"{BASE_URL}/tournaments/api/{tournament_id}/standings"
        data = _get_json(url, params={"day": day})
        teams = data if isinstance(data, list) else []
        teams.sort(key=lambda t: t.get("placement", 0))
        print(f"  -> {len(teams)} teams for {tournament_id} ({day})")
        return teams

    return cache.get_or_set(cache_key, fetch, CACHE_TTL)


def _parse_spread_label(label: str) -> dict | None:
    """Parse ``"Adamant:32/32/0/0/2/0"`` into nature + SP map.

    Returns ``None`` if the label is not in the expected shape.
    """
    nature, _, stats = label.partition(":")
    parts = stats.split("/")
    if len(parts) != len(_SPREAD_KEYS):
        return None

    try:
        values = [int(p) for p in parts]
    except ValueError:
        return None

    sps = {key: value for key, value in zip(_SPREAD_KEYS, values)}
    return {"nature": nature.strip(), "sps": sps}


def _parse_spreads(raw_list: list) -> list[dict]:
    """Turn a raw ``spreads_list`` into normalized, pct-sorted spread dicts."""
    spreads: list[dict] = []

    for entry in raw_list or []:
        if not isinstance(entry, (list, tuple)) or len(entry) < 2:
            continue
        label, pct = entry[0], entry[1]
        parsed = _parse_spread_label(str(label))
        if parsed is None:
            continue
        try:
            pct_value = round(float(pct), 3)
        except (TypeError, ValueError):
            pct_value = 0.0
        spreads.append(
            {
                "label": label,
                "pct": pct_value,
                "nature": parsed["nature"],
                "sps": parsed["sps"],
            }
        )

    spreads.sort(key=lambda s: s["pct"], reverse=True)
    return spreads


def _clean_list(raw_list: list, with_description: bool = True) -> list[dict]:
    """Normalize a MunchStats ``*_list`` of ``[name, pct, ...]`` entries."""
    cleaned: list[dict] = []

    for entry in raw_list or []:
        if not isinstance(entry, (list, tuple)) or not entry:
            continue
        name = entry[0]
        try:
            pct = round(float(entry[1]), 3) if len(entry) > 1 else 0.0
        except (TypeError, ValueError):
            pct = 0.0
        item = {"name": name, "pct": pct}
        if with_description and len(entry) > 2 and isinstance(entry[2], str):
            item["description"] = entry[2]
        if len(entry) > 3 and isinstance(entry[3], list):
            item["sprite"] = entry[3]
        cleaned.append(item)

    return cleaned


def _fetch_usage(pokemon: str, format_id: str, rating: str) -> dict:
    """Fetch and cache the raw usage payload for a Pokemon."""
    cache_key = f"usage_{format_id}_{rating}_{pokemon}"

    def fetch() -> dict:
        url = f"{BASE_URL}/api/{format_id}/{rating}/{quote(pokemon, safe='')}"
        data = _get_json(url)
        return data if isinstance(data, dict) else {}

    return cache.get_or_set(cache_key, fetch, CACHE_TTL)


def get_spreads(
    pokemon: str,
    format_id: str = DEFAULT_FORMAT_ID,
    rating: str = DEFAULT_RATING,
) -> list[dict]:
    """Return usage spreads for a Pokemon, most common first.

    Each entry is ``{label, pct, nature, sps}`` where ``sps`` uses our short
    stat keys. Returns ``[]`` when the payload has no ``spreads_list``.
    """
    data = _fetch_usage(pokemon, format_id, rating)
    return _parse_spreads(data.get("spreads_list") or [])


def get_usage(
    pokemon: str,
    format_id: str = DEFAULT_FORMAT_ID,
    rating: str = DEFAULT_RATING,
) -> dict:
    """Return a cleaned usage summary for a Pokemon.

    Includes moves, items, abilities and natures (each ``{name, pct}``), plus
    raw base stats and types. Missing fields come back as empty lists/values.

    ``matched`` is False when the API silently substituted a different Pokemon
    (it fuzzy-matches unknown names instead of 404ing); callers should flag the
    data as assumed in that case.
    """
    data = _fetch_usage(pokemon, format_id, rating)
    selected = data.get("selected_pokemon") or pokemon

    return {
        "pokemon": selected,
        "requested": pokemon,
        "matched": selected.lower() == pokemon.lower(),
        "moves": _clean_list(data.get("moves_list") or []),
        "items": _clean_list(data.get("items_list") or []),
        "abilities": _clean_list(data.get("abilities_list") or []),
        "natures": _clean_list(data.get("natures_list") or []),
        "tera_types": _clean_list(data.get("tera_types_list") or [], with_description=False),
        "base_stats": data.get("base_stats") or [],
        "types": data.get("pokemon_types") or [],
    }


def get_best_spread(
    pokemon: str,
    format_id: str = DEFAULT_FORMAT_ID,
    rating: str = DEFAULT_RATING,
) -> dict | None:
    """Return the single most common spread for a Pokemon, or ``None``."""
    spreads = get_spreads(pokemon, format_id, rating)
    return spreads[0] if spreads else None
