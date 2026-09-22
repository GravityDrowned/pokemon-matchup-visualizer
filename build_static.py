#!/usr/bin/env python3
"""Bake MunchStats data into static JSON and assemble ``docs/`` for GitHub Pages.

GitHub Pages has no server, and MunchStats sends no CORS headers, so the
browser cannot call it directly. This script fetches everything the frontend
needs at build time, strips the payloads down to the fields the UI actually
uses, and writes a ``docs/`` folder that is committed and served statically.

Reuses the existing ``munchstats_api`` functions (and its 24h disk cache) so
re-running is fast and does not hammer MunchStats.

Output layout::

    docs/
    ├── index.html                 (generated from templates/index.html)
    ├── style.css, favicon.svg, app.js, matrix.js, scoring.js, datasource.js
    ├── calc/{scaffold.js, adapter.js, vendor/...}
    └── data/
        ├── tournaments.json
        ├── teams/{tournamentId}_{day}.json
        ├── spreads/{usageFormat}/{pokemonSlug}.json
        └── manifest.json

``{usageFormat}`` is one of the two real MunchStats usage datasets
(``championsdoubles`` or ``gen9championsvgc2026regmbbo3``); the frontend maps
the selected tournament's regulation to one of them at request time. A Pokemon
is baked under every usage format the baked tournaments map to.

Usage::

    python build_static.py
    python build_static.py --tournaments 5 --days all,day2
    python build_static.py --tournaments id1,id2 --days all

The slug function below MUST stay identical to ``pokemonSlug`` in
``static/datasource.js``; the build names the files and the browser looks them
up. ``tests/test_build_static.py`` locks the two together.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import sys
import time

import cache
import munchstats_api

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(ROOT, "static")
TEMPLATES_DIR = os.path.join(ROOT, "templates")
DEFAULT_OUTPUT = os.path.join(ROOT, "docs")

# Be polite to MunchStats: pause between uncached upstream requests.
REQUEST_DELAY = 0.25

# If docs/data/ grows past this, reduce scope (see reduce_all_scope).
SIZE_LIMIT_BYTES = 50 * 1024 * 1024
KEEP_RECENT_ON_REDUCTION = 5

# Fields kept from a raw standings team (the rest is dropped).
_TEAM_FIELDS = ("name", "placement", "day_reached", "record", "team")
_MON_FIELDS = ("pokemon", "item", "ability", "nature", "moves", "tera_type", "sprite")

_SLUG_RE = re.compile(r"[^a-z0-9]+")
_STATIC_PATH_RE = re.compile(r'(["\'])/static/')


def pokemon_slug(name: str) -> str:
    """Filesystem-safe lowercase slug for a Pokemon name.

    Algorithm (identical to ``pokemonSlug`` in static/datasource.js):
    trim, lowercase, collapse every run of non-``[a-z0-9]`` to ``-``, strip
    leading/trailing ``-``, fall back to ``"unknown"`` when empty.
    """
    slug = _SLUG_RE.sub("-", (name or "").strip().lower()).strip("-")
    return slug or "unknown"


def strip_team(team: dict) -> dict:
    """Reduce one raw standings team to the fields the frontend uses."""
    out = {key: team.get(key) for key in _TEAM_FIELDS if key in team}
    out["team"] = [
        {key: mon.get(key) for key in _MON_FIELDS if key in mon}
        for mon in (team.get("team") or [])
    ]
    return out


def build_spread_payload(spreads: dict, usage: dict) -> dict:
    """Build the stripped per-format spread payload the frontend uses.

    Only the fields ``static/app.js`` and ``static/datasource.js`` read are
    kept: the spread list, ranked natures, the fallback-chain provenance, the
    source label, and the base stats/types the assumed-spread fallback needs.
    Moves/items/abilities are dropped -- the UI never uses them.
    """
    return {
        "spreads": spreads.get("spreads") or [],
        "natures": spreads.get("natures") or [],
        "matched": spreads.get("matched", False),
        "requested": spreads.get("requested", ""),
        "resolved": spreads.get("resolved", ""),
        "source": spreads.get("source", ""),
        "sourceLabel": spreads.get("sourceLabel", ""),
        "natureInferred": spreads.get("natureInferred", False),
        "base_stats": usage.get("base_stats") or [],
        "types": usage.get("types") or [],
    }


def reduce_all_scope(
    all_ids_newest_first: list,
    total_bytes: int,
    limit_bytes: int = SIZE_LIMIT_BYTES,
    keep_recent: int = KEEP_RECENT_ON_REDUCTION,
) -> tuple[list, bool]:
    """Decide which ``all``-day tournaments to keep under the size limit.

    Returns ``(kept_ids, triggered)``. When ``total_bytes`` is within the
    limit, every id is kept and ``triggered`` is False. Otherwise only the
    ``keep_recent`` most recent ids are kept and ``triggered`` is True.
    """
    if total_bytes <= limit_bytes:
        return list(all_ids_newest_first), False
    return list(all_ids_newest_first[:keep_recent]), True


def rewrite_index_html(html: str) -> str:
    """Rewrite the Flask template for static hosting.

    - absolute ``/static/...`` paths become relative (``./...``) so the site
      works under a GitHub Pages project subpath (``/repo-name/``);
    - the injected data-source flag flips from ``"api"`` to ``"static"``.
    """
    html = _STATIC_PATH_RE.sub(r"\1./", html)
    html = html.replace(
        'window.PM_VISUALIZER_MODE = "api"',
        'window.PM_VISUALIZER_MODE = "static"',
    )
    banner = (
        "<!-- Generated by build_static.py from templates/index.html. "
        "Do not edit by hand; edit the template and re-run the build. -->\n"
    )
    return html.replace("<head>", "<head>\n    " + banner, 1)


def _write_json(path: str, obj) -> int:
    """Write minified UTF-8 JSON and return the number of bytes written."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    payload = json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(payload)
    return len(payload.encode("utf-8"))


def _dir_size(path: str) -> int:
    """Total size in bytes of every file under ``path``."""
    total = 0
    for dirpath, _dirnames, filenames in os.walk(path):
        for name in filenames:
            try:
                total += os.path.getsize(os.path.join(dirpath, name))
            except OSError:
                pass
    return total


def _is_cached(key: str) -> bool:
    """True when ``key`` is present and fresh in the 24h cache."""
    return cache.get(key, munchstats_api.CACHE_TTL) is not None


def _polite_pause(key: str) -> None:
    """Sleep before an uncached upstream request (cache hits skip the wait)."""
    if not _is_cached(key):
        time.sleep(REQUEST_DELAY)


def _resolve_cache_keys(name: str, usage_format: str) -> list[str]:
    """Cache keys for every attempt in the munchstats fallback chain.

    Mirrors ``munchstats_api._resolve`` for a given usage dataset: exact name
    in that format, base species in that format, base species in the OTHER
    format. Used only to decide whether a polite pause is needed.
    """
    base = munchstats_api.base_species(name)
    other = (
        munchstats_api.DEFAULT_FORMAT_ID
        if usage_format == munchstats_api.CHAMPIONS_FORMAT_ID
        else munchstats_api.CHAMPIONS_FORMAT_ID
    )
    rating = munchstats_api.DEFAULT_RATING
    return [
        f"usage_{usage_format}_{rating}_{name}",
        f"usage_{usage_format}_{rating}_{base}",
        f"usage_{other}_{rating}_{base}",
    ]


def usage_formats_for_tournaments(tournaments: list) -> list[str]:
    """The set of usage datasets the baked tournaments map to, sorted.

    Every Pokemon is baked under each of these directories so the frontend can
    find it regardless of which tournament is selected.
    """
    formats = {
        munchstats_api.usage_format_for_tournament(t.get("format", ""))
        for t in tournaments
    }
    return sorted(formats)


def _polite_pause_any(keys: list[str]) -> None:
    """Sleep once when any key in ``keys`` is uncached (a request will happen)."""
    if any(not _is_cached(key) for key in keys):
        time.sleep(REQUEST_DELAY)


def _copy_static_tree(output_dir: str) -> None:
    """Copy the frontend assets into ``docs/`` preserving structure.

    ``static/calc/`` (including the pinned ``vendor/`` engine) is copied
    verbatim. Only ``*.js``, ``*.css`` and ``favicon.svg`` are copied from the
    top level; the top-level ``*.test.html`` pages are left behind (they are
    development tools, not part of the deployed site).
    """
    for name in os.listdir(STATIC_DIR):
        src = os.path.join(STATIC_DIR, name)
        if os.path.isfile(src):
            if name.endswith((".js", ".css")) or name == "favicon.svg":
                shutil.copy2(src, os.path.join(output_dir, name))
        elif name == "calc":
            shutil.copytree(src, os.path.join(output_dir, "calc"), dirs_exist_ok=True)


def _select_tournaments(all_tournaments: list, spec: str) -> list:
    """Resolve the ``--tournaments`` argument to a list of tournament dicts."""
    if spec == "all":
        return list(all_tournaments)
    if spec.isdigit():
        return list(all_tournaments[: int(spec)])
    wanted = [part.strip() for part in spec.split(",") if part.strip()]
    by_id = {t["id"]: t for t in all_tournaments}
    missing = [tid for tid in wanted if tid not in by_id]
    if missing:
        raise SystemExit(f"Unknown tournament id(s): {', '.join(missing)}")
    return [by_id[tid] for tid in wanted]


def _parse_days(spec: str) -> list:
    days = [part.strip() for part in spec.split(",") if part.strip()]
    invalid = [day for day in days if day not in munchstats_api.ALLOWED_DAYS]
    if invalid:
        raise SystemExit(
            f"Invalid day filter(s): {', '.join(invalid)} "
            f"(allowed: {', '.join(munchstats_api.ALLOWED_DAYS)})"
        )
    return days


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--tournaments", default="all",
        help="'all', a count N (most recent N), or a comma-separated id list",
    )
    parser.add_argument(
        "--days", default="all,day2,top16,top8",
        help="comma-separated day filters (all, day2, top16, top8)",
    )
    parser.add_argument("--output", default=DEFAULT_OUTPUT, help="output directory")
    parser.add_argument(
        "--limit-mb", type=float, default=SIZE_LIMIT_BYTES / (1024 * 1024),
        help="docs/data size limit in MB before scope reduction",
    )
    args = parser.parse_args(argv)

    days = _parse_days(args.days)
    limit_bytes = int(args.limit_mb * 1024 * 1024)
    output_dir = os.path.abspath(args.output)
    data_dir = os.path.join(output_dir, "data")
    teams_dir = os.path.join(data_dir, "teams")
    spreads_dir = os.path.join(data_dir, "spreads")

    print("=" * 68)
    print("build_static.py -- baking MunchStats data for GitHub Pages")
    print("=" * 68)

    # Fresh data dir each run so stale files never linger.
    if os.path.isdir(data_dir):
        shutil.rmtree(data_dir)

    print("\n[1/5] Fetching tournament list...")
    all_tournaments = munchstats_api.list_tournaments()
    selected = _select_tournaments(all_tournaments, args.tournaments)
    print(f"      {len(all_tournaments)} known, {len(selected)} selected")

    # --- tournaments.json -------------------------------------------------
    _write_json(os.path.join(data_dir, "tournaments.json"), {"tournaments": selected})

    # --- teams ------------------------------------------------------------
    print(f"\n[2/5] Baking teams (days: {', '.join(days)})...")
    for tournament in selected:
        tid = tournament["id"]
        for day in days:
            key = f"teams_{tid}_{day}"
            _polite_pause(key)
            teams = munchstats_api.get_teams(tid, day)
            stripped = [strip_team(team) for team in teams]
            _write_json(
                os.path.join(teams_dir, f"{tid}_{day}.json"),
                {"teams": stripped, "day": day},
            )
        print(f"      {tid}: {len(days)} day file(s)")

    # Size guard: if docs/data is over the limit, keep 'all' only for the
    # most recent tournaments (day2/top16/top8 are kept for all).
    all_guard_triggered = False
    if "all" in days:
        all_ids = [t["id"] for t in selected]
        kept_ids, triggered = reduce_all_scope(all_ids, _dir_size(data_dir), limit_bytes)
        if triggered:
            removed = 0
            for tid in all_ids:
                if tid not in kept_ids:
                    path = os.path.join(teams_dir, f"{tid}_all.json")
                    if os.path.isfile(path):
                        os.remove(path)
                        removed += 1
            all_guard_triggered = True
            print(
                f"      ! SIZE GUARD: docs/data exceeded {args.limit_mb:.0f} MB. "
                f"Reduced scope to day2/top16/top8 for all tournaments plus "
                f"'all' for the {KEEP_RECENT_ON_REDUCTION} most recent "
                f"({removed} 'all' file(s) removed)."
            )

    # --- spreads (union of all Pokemon in the baked teams) ----------------
    all_pokemon: set[str] = set()
    for name in os.listdir(teams_dir):
        if not name.endswith(".json"):
            continue
        with open(os.path.join(teams_dir, name), "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        for team in payload.get("teams") or []:
            for mon in team.get("team") or []:
                if mon.get("pokemon"):
                    all_pokemon.add(mon["pokemon"])

    pokemon = sorted(all_pokemon)
    usage_formats = usage_formats_for_tournaments(selected)
    print(f"\n[3/5] Baking spreads for {len(pokemon)} Pokemon "
          f"x {len(usage_formats)} usage format(s): {', '.join(usage_formats)}...")
    slug_owner: dict[str, str] = {}
    collisions = 0
    for name in pokemon:
        slug = pokemon_slug(name)
        if slug in slug_owner and slug_owner[slug] != name:
            collisions += 1
            print(f"      ! slug collision: {name!r} and {slug_owner[slug]!r} -> {slug!r}")
        else:
            slug_owner[slug] = name

    for index, name in enumerate(pokemon, 1):
        slug = pokemon_slug(name)
        for usage_format in usage_formats:
            # Pause once if any attempt in this format's fallback chain is
            # uncached. Repeated formats across Pokemon hit the cache.
            _polite_pause_any(_resolve_cache_keys(name, usage_format))
            # get_spreads/get_usage take a TOURNAMENT format and map it; pass
            # the usage format itself, which maps to itself (passthrough).
            result = munchstats_api.get_spreads(name, usage_format)
            usage = munchstats_api.get_usage(name, usage_format)
            # Baked under the slug of the name AS IT APPEARS IN TEAMS (e.g.
            # "salamence-mega"), so the frontend's pokemonSlug lookup finds it.
            _write_json(
                os.path.join(spreads_dir, usage_format, f"{slug}.json"),
                build_spread_payload(result, usage),
            )
        if index % 25 == 0 or index == len(pokemon):
            print(f"      {index}/{len(pokemon)} Pokemon baked")

    # --- manifest ---------------------------------------------------------
    manifest = {
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "tournaments": len(selected),
        "days": days,
        "pokemon": len(pokemon),
        "usageFormats": usage_formats,
    }
    _write_json(os.path.join(data_dir, "manifest.json"), manifest)

    # --- assemble docs/ ---------------------------------------------------
    print("\n[4/5] Assembling docs/ (HTML + frontend assets)...")
    os.makedirs(output_dir, exist_ok=True)
    _copy_static_tree(output_dir)
    with open(os.path.join(TEMPLATES_DIR, "index.html"), "r", encoding="utf-8") as handle:
        template = handle.read()
    with open(os.path.join(output_dir, "index.html"), "w", encoding="utf-8") as handle:
        handle.write(rewrite_index_html(template))

    # --- report -----------------------------------------------------------
    total_bytes = _dir_size(data_dir)
    team_files = sorted(os.listdir(teams_dir)) if os.path.isdir(teams_dir) else []
    spread_files: list[str] = []
    for usage_format in usage_formats:
        fmt_dir = os.path.join(spreads_dir, usage_format)
        if os.path.isdir(fmt_dir):
            spread_files.extend(os.listdir(fmt_dir))
    all_files = [f for f in team_files if f.endswith("_all.json")]
    largest = None
    largest_size = 0
    for dirpath, _dirnames, filenames in os.walk(data_dir):
        for fname in filenames:
            size = os.path.getsize(os.path.join(dirpath, fname))
            if size > largest_size:
                largest_size = size
                largest = os.path.relpath(os.path.join(dirpath, fname), output_dir)

    print("\n[5/5] Build complete.")
    print("-" * 68)
    print(f"  tournaments:     {len(selected)}")
    print(f"  team files:      {len(team_files)} ({len(all_files)} 'all' files)")
    print(f"  spread files:    {len(spread_files)} "
          f"({len(usage_formats)} usage format dirs)")
    print(f"  docs/data size:  {total_bytes / (1024 * 1024):.2f} MB")
    print(f"  largest file:    {largest} ({largest_size / 1024:.1f} KB)")
    print(f"  size guard:      {'TRIGGERED' if all_guard_triggered else 'not triggered'}")
    if collisions:
        print(f"  slug collisions: {collisions} (see warnings above)")
    print(f"  output:          {output_dir}")
    print("-" * 68)
    return 0


if __name__ == "__main__":
    sys.exit(main())
