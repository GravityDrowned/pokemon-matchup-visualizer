"""Flask backend for the Pokemon Matchup Visualizer.

Serves the page and the JSON API the frontend calls. All external data
(MunchStats, pokepaste) is fetched and normalized here; damage math stays
client-side in the vendored NCP engine.
"""

from __future__ import annotations

import os

from flask import Flask, jsonify, render_template, request
from werkzeug.exceptions import HTTPException

import cache
import munchstats_api
import pokepaste_api
import showdown_parser

app = Flask(__name__)

# Reject oversized request bodies before they are read into memory.
app.config["MAX_CONTENT_LENGTH"] = 1 * 1024 * 1024  # 1 MB

# The current tournament regulation. The frontend normally passes the selected
# tournament's format explicitly; this is only the fallback when it does not.
DEFAULT_TOURNAMENT_FORMAT = "gen9championsvgc2026regmc"


@app.route("/")
def index():
    """Serve the single-page app shell."""
    return render_template("index.html")


@app.route("/healthz")
def healthz():
    """Liveness probe."""
    return jsonify({"ok": True})


@app.route("/api/tournaments")
def api_tournaments():
    """Return every known tournament, newest first."""
    try:
        tournaments = munchstats_api.list_tournaments()
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 502
    return jsonify({"tournaments": tournaments})


@app.route("/api/tournaments/<tournament_id>/teams")
def api_tournament_teams(tournament_id: str):
    """Return the standings/teams for a tournament.

    Query params:
      - day: ``all`` (default), ``day2``, ``top16`` or ``top8``.
    """
    day = request.args.get("day", "all")
    try:
        teams = munchstats_api.get_teams(tournament_id, day)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 502
    return jsonify({"teams": teams, "day": day})


@app.route("/api/spreads/<path:pokemon>")
def api_spreads(pokemon: str):
    """Return usage spreads and a usage summary for a Pokemon.

    Query params:
      - format: TOURNAMENT regulation (defaults to the current Reg M-C,
        ``gen9championsvgc2026regmc``). It is mapped internally to the usage
        dataset that actually covers that regulation.
      - rating: rating bucket, default ``0``.

    ``format``/``rating`` are validated against a strict allowlist and
    ``pokemon`` is length-capped before any upstream request or cache write.

    The response carries the provenance of the fallback chain that was used:
    ``matched`` (False when MunchStats substituted a different Pokemon),
    ``requested``/``resolved`` names, ``source`` format id, ``sourceLabel``
    (human-readable dataset name), ``natureInferred`` (True when the source
    ranks spreads and natures independently) and the ranked ``natures`` list
    the UI can offer.
    """
    format_id = request.args.get("format", DEFAULT_TOURNAMENT_FORMAT)
    rating = request.args.get("rating", munchstats_api.DEFAULT_RATING)
    try:
        munchstats_api.validate_usage_params(pokemon, format_id, rating)
        result = munchstats_api.get_spreads(pokemon, format_id, rating)
        usage = munchstats_api.get_usage(pokemon, format_id, rating)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 502
    return jsonify(
        {
            "spreads": result["spreads"],
            "natures": result["natures"],
            "matched": result["matched"],
            "requested": result["requested"],
            "resolved": result["resolved"],
            "source": result["source"],
            "sourceLabel": result["sourceLabel"],
            "natureInferred": result["natureInferred"],
            "usage": usage,
        }
    )


@app.route("/api/team", methods=["POST"])
def api_team():
    """Parse a team from a pokepaste URL or raw Showdown text.

    Body (JSON): ``{"url": "..."}`` or ``{"text": "..."}``.
    Returns ``{"sets": [...], "warnings": [...]}``.
    """
    body = request.get_json(silent=True)
    if body is None:
        return jsonify({"error": "Request body must be a JSON object"}), 400
    if not isinstance(body, dict):
        return jsonify({"error": "Request body must be a JSON object"}), 400

    url = body.get("url")
    text = body.get("text")
    if url is not None and not isinstance(url, str):
        return jsonify({"error": "'url' must be a string"}), 400
    if text is not None and not isinstance(text, str):
        return jsonify({"error": "'text' must be a string"}), 400

    url = (url or "").strip()
    text = text or ""

    try:
        if url:
            sets = pokepaste_api.fetch_team(url)
        elif text.strip():
            sets = showdown_parser.parse_team(text)
        else:
            return jsonify({"error": "Provide either 'url' or 'text'"}), 400
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 502

    warnings: list[str] = []
    for set_obj in sets:
        warnings.extend(set_obj.get("warnings", []))

    return jsonify({"sets": sets, "warnings": warnings})


@app.route("/api/cache/clear", methods=["POST"])
def api_cache_clear():
    """Delete all cached responses. Returns the number of files removed.

    Disabled unless ``PMV_ADMIN=1`` is set in the environment: wiping the
    shared cache is an operator action, not a public one.
    """
    if os.environ.get("PMV_ADMIN") != "1":
        return jsonify({"error": "Not found"}), 404
    return jsonify({"cleared": cache.clear()})


@app.after_request
def _no_store_api(response):
    """Prevent browsers/proxies from caching API responses."""
    if request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.errorhandler(Exception)
def _handle_unexpected(exc: Exception):
    """Return a JSON error instead of an HTML traceback.

    Werkzeug HTTP errors (404, 405, 413, ...) keep their own status code; every
    other exception is logged and reported as a 500.
    """
    if isinstance(exc, HTTPException):
        # 413 (RequestEntityTooLarge) has no useful description by default.
        if exc.code == 413:
            return jsonify({"error": "Request body too large (max 1 MB)"}), 413
        return jsonify({"error": exc.description}), exc.code
    print(f"  UNHANDLED ERROR on {request.path}: {exc!r}")
    return jsonify({"error": "Internal server error"}), 500


if __name__ == "__main__":
    # Allow `python server.py` for quick smoke-testing. Debug mode is opt-in
    # via FLASK_DEBUG=1 so a stray run never exposes the Werkzeug debugger.
    debug = os.environ.get("FLASK_DEBUG") == "1"
    app.run(debug=debug, port=5000)
