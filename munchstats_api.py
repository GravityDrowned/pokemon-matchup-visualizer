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

DEFAULT_FORMAT_ID is the gen-9 Champions Reg M-B Bo3 usage format. It is a
tournament dataset, but its roster differs from the Reg M-C tournaments the
app browses, and it often has no entry for a Champions Pokemon.

CHAMPIONS_FORMAT_ID (``championsdoubles``) is the in-game Champions dataset
behind ``munchstats.com/champions/doubles/{BaseSpecies}``. It carries the full
Reg M-C roster, but:

  - it is keyed by BASE species, so a Mega form must be queried by its base
    name (``Salamence-Mega`` -> ``Salamence``);
  - its ``spreads_list`` entries are ``[spreadString, pct]`` with NO embedded
    nature, and natures are a SEPARATE, INDEPENDENTLY-RANKED list. There is no
    joint distribution, so a spread's nature cannot be known -- only guessed
    from the top marginal. ``natureInferred`` records that.

MunchStats never 404s on an unknown name; it silently fuzzy-substitutes a
different Pokemon. Every lookup therefore checks the resolved name and walks a
fallback chain (see ``_resolve``) until one actually matches.

The public ``get_spreads``/``get_usage``/``get_best_spread`` functions take a
TOURNAMENT regulation as their ``format_id`` argument and map it to the right
usage dataset via ``usage_format_for_tournament`` (see
``TOURNAMENT_FORMAT_TO_USAGE``).
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
CHAMPIONS_FORMAT_ID = "championsdoubles"
DEFAULT_RATING = "0"

# Tournament regulation -> the usage dataset whose roster actually covers it.
#
# Only two usage datasets exist upstream:
#   - ``championsdoubles`` (Reg M-C in-game roster, incl. Megas);
#   - ``gen9championsvgc2026regmbbo3`` (Reg M-B Bo3 tournament data).
# Requesting regmc/regmcbo3/regma/regmabo3 silently returns the regmbbo3
# payload, so we must never ask for them directly.
#
# The mapping is explicit for the regulations whose roster we know:
#   - M-C and M-A are Champions regs, so ``championsdoubles`` is the only
#     dataset that carries their roster;
#   - M-B has an exact usage dataset (``regmbbo3``) whose spread labels embed
#     the nature, so it is strictly better data than ``championsdoubles``.
#
# Evidence for the M-C/M-B split (verified against the live API):
#   - Incineroar: regmbbo3 ``32/32/0/0/2/0`` (physical) vs championsdoubles
#     ``32/0/14/0/20/0`` (bulky) -- the M-C bulky spread is the correct one;
#   - Corviknight: regmbbo3 ``32/0/5/0/26/3`` vs championsdoubles
#     ``32/0/32/0/2/0``;
#   - Rillaboom is absent from the M-B roster (regmbbo3 fuzzy-substitutes
#     Kingambit) but present in ``championsdoubles``.
TOURNAMENT_FORMAT_TO_USAGE = {
    "gen9championsvgc2026regmc": CHAMPIONS_FORMAT_ID,
    "gen9championsvgc2026regma": CHAMPIONS_FORMAT_ID,
    "gen9championsvgc2026regmb": DEFAULT_FORMAT_ID,
}

# Human-readable provenance labels for the usage datasets.
SOURCE_LABELS = {
    CHAMPIONS_FORMAT_ID: "Champions (in-game)",
    DEFAULT_FORMAT_ID: "Reg M-B (Bo3)",
}

# Mega suffixes MunchStats folds into the base species for Champions data.
_MEGA_SUFFIX_RE = re.compile(r"-Mega(?:-[XYZ])?$", re.IGNORECASE)

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


def base_species(name: str) -> str:
    """Strip a Mega suffix: 'Salamence-Mega'->'Salamence', 'Raichu-Mega-Y'->'Raichu'.

    Handles ``-Mega``, ``-Mega-X``, ``-Mega-Y`` and ``-Mega-Z``. Names without a
    Mega suffix are returned unchanged (whitespace trimmed).
    """
    stripped = (name or "").strip()
    return _MEGA_SUFFIX_RE.sub("", stripped)


def usage_format_for_tournament(tournament_format: str) -> str:
    """Map a tournament regulation to the usage dataset that covers it.

    The app browses tournaments (``gen9championsvgc2026regmc`` etc.) but
    MunchStats only serves two real usage datasets. This picks the right one.

    Rules, in order:
      1. Strip a trailing ``bo3`` and lowercase, so ``...regmcbo3`` and
         ``...regmc`` map the same way.
      2. Use the explicit ``TOURNAMENT_FORMAT_TO_USAGE`` mapping when present.
      3. Any other ``champions`` regulation -> ``CHAMPIONS_FORMAT_ID``: the
         in-game Champions dataset carries the full current roster (incl.
         Megas), which is the closest match for a Champions regulation.
      4. Anything else (pre-Champions formats like ``gen9vgc2026regi`` or
         ``gen9vgc2025regh``) -> ``DEFAULT_FORMAT_ID``. ``championsdoubles``
         does not cover pre-Champions Pokemon (``Amoonguss`` and ``Urshifu``
         both resolve to ``Rillaboom``), so it is useless there.

    This is what fixes the wrong-spread bug: browsing an M-C tournament used to
    fetch Reg M-B spreads, e.g. Incineroar ``32/32/0/0/2/0`` (M-B physical)
    instead of the correct M-C ``32/0/14/0/20/0`` (bulky), and Corviknight
    ``32/0/5/0/26/3`` instead of ``32/0/32/0/2/0``.
    """
    normalized = (tournament_format or "").strip().lower()
    if normalized.endswith("bo3"):
        normalized = normalized[: -len("bo3")]

    if normalized in TOURNAMENT_FORMAT_TO_USAGE:
        return TOURNAMENT_FORMAT_TO_USAGE[normalized]
    if "champions" in normalized:
        return CHAMPIONS_FORMAT_ID
    return DEFAULT_FORMAT_ID


def source_label(source: str) -> str:
    """Human-readable label for a usage dataset id (raw id when unknown)."""
    return SOURCE_LABELS.get(source, source)

def _parse_spread_label(label: str) -> dict | None:
    """Parse a spread label into a nature + SP map.

    Accepts both shapes:
      - ``"Adamant:32/32/0/0/2/0"`` (nature embedded in the label);
      - ``"32/32/0/0/2/0"`` (nature supplied separately).

    Returns ``{"nature": str|None, "sps": {...}}`` or ``None`` when the stat
    part is not six slash-separated integers.
    """
    nature: str | None = None
    stats = label
    if ":" in label:
        nature, _, stats = label.partition(":")
        nature = nature.strip() or None

    parts = stats.split("/")
    if len(parts) != len(_SPREAD_KEYS):
        return None

    try:
        values = [int(p) for p in parts]
    except ValueError:
        return None

    sps = {key: value for key, value in zip(_SPREAD_KEYS, values)}
    return {"nature": nature, "sps": sps}


def _parse_spreads(raw_list: list, default_nature: str | None = None) -> list[dict]:
    """Turn a raw ``spreads_list`` into normalized, pct-sorted spread dicts.

    ``default_nature`` is used for the nature-less ``championsdoubles`` shape
    (the top marginal nature is the best available guess).
    """
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
                "nature": parsed["nature"] or default_nature,
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
    """Fetch and cache the raw usage payload for a Pokemon.

    The cache key includes the format id, so the same name fetched under
    different formats never collides. Callers do the fallback logic on top of
    this, so repeated lookups of a name do not re-fetch.
    """
    cache_key = f"usage_{format_id}_{rating}_{pokemon}"

    def fetch() -> dict:
        url = f"{BASE_URL}/api/{format_id}/{rating}/{quote(pokemon, safe='')}"
        data = _get_json(url)
        return data if isinstance(data, dict) else {}

    return cache.get_or_set(cache_key, fetch, CACHE_TTL)


def _resolved_name(data: dict) -> str:
    """The Pokemon the upstream payload actually describes.

    ``selected_pokemon`` is the cleanest field; ``current_pokemon[0]`` is the
    fallback for the ``championsdoubles`` shape.
    """
    selected = data.get("selected_pokemon")
    if isinstance(selected, str) and selected:
        return selected
    current = data.get("current_pokemon")
    if isinstance(current, (list, tuple)) and current and isinstance(current[0], str):
        return current[0]
    return ""


def _resolve(
    pokemon: str,
    format_id: str = DEFAULT_FORMAT_ID,
    rating: str = DEFAULT_RATING,
) -> dict:
    """Walk the fallback chain and return the first payload that matches.

    Attempts, in order:
      1. ``format_id`` with the exact name;
      2. ``format_id`` with the base species (Mega suffix stripped);
      3. the OTHER usage dataset with the base species -- ``championsdoubles``
         when the primary is the Reg M-B tournament dataset, and vice versa.
         This is the format-aware fallback: an M-C lookup that misses in
         ``championsdoubles`` can still fall back to Reg M-B, and a Reg M-B
         lookup can fall back to ``championsdoubles``.

    A match means the resolved name equals the name we queried for that
    attempt (case-insensitively). Returns a provenance dict::

        {"data": dict, "matched": bool, "requested": str,
         "resolved": str, "source": str, "sourceLabel": str,
         "nature_inferred": bool, "base": str}

    When nothing matches, ``data`` is the last payload fetched (or ``{}``) and
    ``matched`` is False, so callers can still read whatever came back while
    flagging it as assumed.
    """
    base = base_species(pokemon)
    other_format = (
        DEFAULT_FORMAT_ID
        if format_id == CHAMPIONS_FORMAT_ID
        else CHAMPIONS_FORMAT_ID
    )
    attempts = [
        (format_id, pokemon),
        (format_id, base),
        (other_format, base),
    ]

    last_data: dict = {}
    last_resolved = ""
    last_source = format_id
    for source, query in attempts:
        data = _fetch_usage(query, source, rating)
        resolved = _resolved_name(data)
        last_data, last_resolved, last_source = data, resolved, source
        if resolved and resolved.lower() == query.lower():
            return {
                "data": data,
                "matched": True,
                "requested": pokemon,
                "resolved": resolved,
                "source": source,
                "sourceLabel": source_label(source),
                "nature_inferred": source == CHAMPIONS_FORMAT_ID,
                "base": base,
            }

    return {
        "data": last_data,
        "matched": False,
        "requested": pokemon,
        "resolved": last_resolved,
        "source": last_source,
        "sourceLabel": source_label(last_source),
        "nature_inferred": last_source == CHAMPIONS_FORMAT_ID,
        "base": base,
    }


def get_spreads(
    pokemon: str,
    format_id: str = DEFAULT_FORMAT_ID,
    rating: str = DEFAULT_RATING,
) -> dict:
    """Return usage spreads for a Pokemon plus provenance, most common first.

    ``format_id`` is a TOURNAMENT regulation (e.g. ``gen9championsvgc2026regmc``);
    it is mapped to the usage dataset that covers it via
    :func:`usage_format_for_tournament` before the lookup.

    Each spread is ``{label, pct, nature, sps}`` where ``sps`` uses our short
    stat keys. ``natures`` is the full ranked nature list when the source
    exposes one (``championsdoubles`` only), else ``[]``.

    ``matched`` is False when every attempt in the fallback chain resolved to a
    different Pokemon (MunchStats fuzzy-substitutes instead of 404ing); callers
    should flag the data as assumed and fall back to a default spread.
    ``natureInferred`` is True only for the ``championsdoubles`` source, where
    spreads and natures are independent marginals and the nature attached to
    each spread is the top marginal guess, not a known pairing.
    ``sourceLabel`` is the human-readable name of the dataset used.
    """
    resolved = _resolve(pokemon, usage_format_for_tournament(format_id), rating)
    data = resolved["data"]

    natures = _clean_list(data.get("natures_list") or [])
    top_nature = natures[0]["name"] if natures else None
    spreads = _parse_spreads(data.get("spreads_list") or [], default_nature=top_nature)

    # Never hand back a substituted Pokemon's spreads: unmatched means no data.
    if not resolved["matched"]:
        spreads = []
        natures = []

    return {
        "spreads": spreads,
        "natures": natures,
        "matched": resolved["matched"],
        "requested": resolved["requested"],
        "resolved": resolved["resolved"],
        "source": resolved["source"],
        "sourceLabel": resolved["sourceLabel"],
        "natureInferred": resolved["nature_inferred"],
    }


def get_usage(
    pokemon: str,
    format_id: str = DEFAULT_FORMAT_ID,
    rating: str = DEFAULT_RATING,
) -> dict:
    """Return a cleaned usage summary for a Pokemon, with provenance.

    ``format_id`` is a TOURNAMENT regulation, mapped internally like
    :func:`get_spreads`. Includes moves, items, abilities and natures (each
    ``{name, pct}``), plus raw base stats and types. Missing fields come back as
    empty lists/values. Uses the same fallback chain as :func:`get_spreads`, so
    the provenance fields (``matched``, ``requested``, ``resolved``, ``source``,
    ``sourceLabel``, ``natureInferred``) describe the payload actually used.
    """
    resolved = _resolve(pokemon, usage_format_for_tournament(format_id), rating)
    data = resolved["data"]
    selected = _resolved_name(data) or pokemon

    return {
        "pokemon": selected,
        "requested": resolved["requested"],
        "resolved": resolved["resolved"],
        "source": resolved["source"],
        "sourceLabel": resolved["sourceLabel"],
        "natureInferred": resolved["nature_inferred"],
        "matched": resolved["matched"],
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
    """Return the single most common spread for a Pokemon, or ``None``.

    Respects the fallback chain: returns ``None`` when no attempt matched, so
    callers never get a substituted Pokemon's spread.
    """
    result = get_spreads(pokemon, format_id, rating)
    if not result["matched"] or not result["spreads"]:
        return None
    return result["spreads"][0]
