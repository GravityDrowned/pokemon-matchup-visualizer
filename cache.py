"""Tiny TTL file-based JSON cache.

One JSON blob per key, stored under ``cache/`` in the working directory. The
file's mtime is the timestamp; a file older than its TTL is treated as a miss.
This is deliberately not a database — it exists so repeated MunchStats and
pokepaste lookups during development do not hammer the upstream services.

Modeled on the reference project's ``spellbook_api.py`` cache helpers, but
generalized into a standalone module.
"""

from __future__ import annotations

import json
import os
import re
import time
from collections.abc import Callable
from typing import Any

CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache")
DEFAULT_TTL = 7 * 24 * 60 * 60  # 7 days in seconds


def _sanitize_key(key: str) -> str:
    """Convert an arbitrary key into a filesystem-safe filename stem."""
    safe = re.sub(r"[^a-zA-Z0-9_-]", "_", key)
    return safe[:120] or "cache"


def _cache_path(key: str) -> str:
    """Return the filesystem path for a key's cache file."""
    return os.path.join(CACHE_DIR, _sanitize_key(key) + ".json")


def get(key: str, ttl: int = DEFAULT_TTL) -> Any | None:
    """Return cached JSON for ``key`` if fresh, else ``None``.

    A missing, stale, unreadable or corrupt file all count as a miss; we log
    and move on rather than letting a cache problem break a request.
    """
    path = _cache_path(key)
    if not os.path.isfile(path):
        return None

    age = time.time() - os.path.getmtime(path)
    if age > ttl:
        print(f"  Cache '{key}' is stale ({age / 3600:.1f}h old), re-fetching...")
        return None

    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as exc:
        print(f"  Cache read error for '{key}': {exc}, treating as miss")
        return None


def set(key: str, value: Any) -> None:
    """Write ``value`` as JSON under ``key``. Never raises on I/O failure."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = _cache_path(key)
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(value, f)
    except OSError as exc:
        print(f"  Cache write error for '{key}': {exc}")


def get_or_set(key: str, fetcher: Callable[[], Any], ttl: int = DEFAULT_TTL) -> Any:
    """Return the cached value, or call ``fetcher()``, store and return it.

    The fetcher is only called on a miss, so a fresh cache avoids all network
    work.
    """
    cached = get(key, ttl)
    if cached is not None:
        print(f"  Cache hit for '{key}'")
        return cached

    value = fetcher()
    set(key, value)
    return value


def clear() -> int:
    """Delete every cache file. Returns the number of files removed."""
    if not os.path.isdir(CACHE_DIR):
        return 0

    removed = 0
    for name in os.listdir(CACHE_DIR):
        if not name.endswith(".json"):
            continue
        try:
            os.remove(os.path.join(CACHE_DIR, name))
            removed += 1
        except OSError as exc:
            print(f"  Cache clear error for '{name}': {exc}")
    print(f"  Cleared {removed} cache file(s)")
    return removed
