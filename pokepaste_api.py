"""pokepaste.es client.

Fetches the raw Showdown text for a paste and parses it into normalized sets.
The paste id validation is security-critical: it is the only thing standing
between a user-supplied string and the URL we request, so it is strict and
rejects anything that is not a plain hex id.
"""

from __future__ import annotations

import re

import requests

import cache
import showdown_parser

BASE_URL = "https://pokepast.es"
REQUEST_TIMEOUT = 30  # seconds
CACHE_TTL = 7 * 24 * 60 * 60  # 7 days

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)

# pokepaste ids are hex strings, 8-32 chars. Anchored so no path segments,
# query strings or schemes can sneak through.
_ID_RE = re.compile(r"^[0-9a-fA-F]{8,32}$")


def extract_paste_id(url_or_id: str) -> str:
    """Extract and validate a pokepaste id from a URL or bare id.

    Accepts ``https://pokepast.es/abc123``, ``pokepast.es/abc123``,
    ``https://pokepast.es/abc123/raw`` and a bare ``abc123``. Raises
    ``ValueError`` for anything else.
    """
    if not url_or_id:
        raise ValueError("No pokepaste id or URL provided")

    candidate = url_or_id.strip()

    # Strip scheme and host if a URL was given, then take the first path part.
    candidate = re.sub(r"^https?://", "", candidate, flags=re.IGNORECASE)
    candidate = re.sub(r"^pokepast\.es/", "", candidate, flags=re.IGNORECASE)
    candidate = candidate.split("?", 1)[0].split("#", 1)[0]
    candidate = candidate.split("/", 1)[0].strip()

    if not _ID_RE.match(candidate):
        raise ValueError(f"Invalid pokepaste id: {url_or_id!r}")

    return candidate


def fetch_paste(url_or_id: str) -> str:
    """Fetch the raw Showdown text for a paste.

    Raises ``ValueError`` for a bad id and ``RuntimeError`` on network or HTTP
    failure. Successful responses are cached for 7 days.
    """
    paste_id = extract_paste_id(url_or_id)
    cache_key = f"paste_{paste_id}"

    cached = cache.get(cache_key, CACHE_TTL)
    if cached is not None:
        print(f"  Cache hit for paste '{paste_id}'")
        return cached

    url = f"{BASE_URL}/{paste_id}/raw"
    print(f"  Fetching pokepaste {url}")
    try:
        resp = requests.get(
            url, timeout=REQUEST_TIMEOUT, headers={"User-Agent": USER_AGENT}
        )
        resp.raise_for_status()
    except requests.RequestException as exc:
        # Log the detail server-side; the client only sees a generic message.
        print(f"  Failed to fetch pokepaste '{paste_id}': {exc!r}")
        raise RuntimeError("Upstream paste service is unavailable") from exc

    text = resp.text
    cache.set(cache_key, text)
    return text


def fetch_team(url_or_id: str) -> list[dict]:
    """Fetch a paste and parse it into normalized sets."""
    raw = fetch_paste(url_or_id)
    return showdown_parser.parse_team(raw)
