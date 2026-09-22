"""Tests for pokepaste_api id extraction and validation."""

from __future__ import annotations

import pytest

from pokepaste_api import extract_paste_id

VALID_ID = "2e5d1e831c6d9e4c"


@pytest.mark.parametrize(
    "value",
    [
        VALID_ID,
        f"https://pokepast.es/{VALID_ID}",
        f"pokepast.es/{VALID_ID}",
        f"https://pokepast.es/{VALID_ID}/raw",
        f"http://pokepast.es/{VALID_ID}",
        f"  https://pokepast.es/{VALID_ID}  ",
    ],
)
def test_extract_valid_forms(value):
    assert extract_paste_id(value) == VALID_ID


def test_extract_uppercase_hex_id():
    assert extract_paste_id("ABCDEF12") == "ABCDEF12"


@pytest.mark.parametrize(
    "bad",
    [
        "",
        "   ",
        "../etc/passwd",
        "http://evil.com/abc12345",
        "https://pokepast.es/../secret",
        "https://pokepast.es/nothex!!",
        "https://pokepast.es/abc",
        "https://pokepast.es/" + "a" * 33,
        "zzzzzzzz",
        "1234567",
    ],
)
def test_extract_rejects_bad(bad):
    with pytest.raises(ValueError):
        extract_paste_id(bad)


def test_extract_strips_query_and_fragment():
    assert extract_paste_id(f"https://pokepast.es/{VALID_ID}?x=1") == VALID_ID
    assert extract_paste_id(f"https://pokepast.es/{VALID_ID}#frag") == VALID_ID
