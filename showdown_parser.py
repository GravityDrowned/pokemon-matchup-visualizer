"""Parse Pokemon Showdown / pokepaste export text into normalized sets.

The app works exclusively in the gen-10 "Champions" Stat Point (SP) convention,
where a stat can hold 0-32 SPs. Showdown exports those as ``EVs:`` lines with
values 0-32 (total <= 66); real VGC exports use 0-252 EVs. We detect which
convention a line uses and, for standard EVs, convert with ``floor(ev / 8)``
capped at 32, recording a warning.

The normalized set shape is what ``static/calc/adapter.js`` expects:

    {
      "species": str, "nickname": str, "level": int, "nature": str,
      "ability": str, "item": str, "teraType": str, "gender": "M"|"F"|"",
      "sps": {"hp": int, "at": int, "df": int, "sa": int, "sd": int, "sp": int},
      "moves": [str, ...], "warnings": [str, ...],
    }
"""

from __future__ import annotations

import re

# Showdown stat label -> our short key. Case-insensitive lookup below.
_STAT_KEYS = {
    "hp": "hp",
    "atk": "at",
    "def": "df",
    "spa": "sa",
    "spd": "sd",
    "spe": "sp",
}

# Canonical order used when exporting back to Showdown text.
_STAT_EXPORT = [
    ("hp", "HP"),
    ("at", "Atk"),
    ("df", "Def"),
    ("sa", "SpA"),
    ("sd", "SpD"),
    ("sp", "Spe"),
]

_STAT_ENTRY_RE = re.compile(r"(\d+)\s*([A-Za-z]+)")
_GENDER_RE = re.compile(r"\s*\((M|F)\)\s*$", re.IGNORECASE)
_NICK_SPECIES_RE = re.compile(r"^(.+?)\s*\(([^)]+)\)$")
_BLOCK_SPLIT_RE = re.compile(r"\n\s*\n")

# EV/SP disambiguation thresholds (see _apply_stat_line).
#
# A real Champions SP spread almost always invests heavily (e.g. 32/32/2 = 66,
# 32/32/0/0/2/0 = 66). Totals below 32 are overwhelmingly the standard-EV
# leftover pattern ("EVs: 4 HP" => 4, "EVs: 252/252/4" is already > 66). We use
# 32 as the floor below which an EVs: line is treated as EVs, and warn on
# small-but-plausible SP totals up to 48.
_MIN_PLAUSIBLE_SP_TOTAL = 32
_AMBIGUOUS_SP_TOTAL = 48

# Lines that are set fields, never a species header. A block whose first line
# matches one of these was almost certainly produced by a stray blank line
# inside a set (HIGH-2). ``@``-only fragments are handled separately.
_FIELD_PREFIXES = (
    "ability:",
    "level:",
    "evs:",
    "sps:",
    "ivs:",
    "tera type:",
    "shiny:",
    "happiness:",
    "gender:",
    "nature:",
)


def _normalize_text(text: str) -> str:
    """Normalize line endings, non-breaking spaces and trailing whitespace."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace("\xa0", " ")
    return "\n".join(line.rstrip() for line in text.split("\n"))


def _is_plausible_header(line: str) -> bool:
    """Return True if ``line`` could be a set's species header.

    Rejects move lines (``- ...``), known field lines (``Ability:``, ``EVs:``,
    ``... Nature``, ...) and ``@``-only fragments. This is what stops a stray
    blank line from turning a continuation into a bogus Pokemon.
    """
    line = (line or "").strip()
    if not line:
        return False
    if line.startswith("-") or line.startswith("@"):
        return False
    lower = line.lower()
    if any(lower.startswith(prefix) for prefix in _FIELD_PREFIXES):
        return False
    if lower.endswith(" nature") or lower == "nature":
        return False
    return True


def _looks_like_set_content(block: str) -> bool:
    """Return True if a header-less block looks like set fields/moves.

    Used to decide whether a block without a valid header is a continuation of
    the previous set (merge it) or unrelated garbage (skip it).
    """
    for raw in block.split("\n"):
        line = raw.strip()
        if not line:
            continue
        if line.startswith("-"):
            return True
        lower = line.lower()
        if any(lower.startswith(prefix) for prefix in _FIELD_PREFIXES):
            return True
        if lower.endswith(" nature"):
            return True
    return False


def _parse_header(line: str) -> tuple[str, str, str, str]:
    """Split a set header line into (species, nickname, gender, item).

    Handles ``Nickname (Species) (M) @ Item``, ``Species @ Item``, ``Species``,
    ``(Species)`` and gender placed after the item (``Species @ Item (M)``).
    """
    item = ""
    if " @ " in line:
        left, _, item = line.partition(" @ ")
        item = item.strip()
    else:
        left = line
    left = left.strip()

    gender = ""
    match = _GENDER_RE.search(left)
    if match:
        gender = match.group(1).upper()
        left = left[: match.start()].strip()

    # Gender may also trail the item: "Species @ Life Orb (M)".
    match = _GENDER_RE.search(item)
    if match:
        if not gender:
            gender = match.group(1).upper()
        item = item[: match.start()].strip()

    # A bare "(Species)" means no nickname; check before the nickname regex,
    # which intentionally requires at least one character before the parens.
    if left.startswith("(") and left.endswith(")") and left.count("(") == 1:
        return left[1:-1].strip(), "", gender, item

    match = _NICK_SPECIES_RE.match(left)
    if match:
        return match.group(2).strip(), match.group(1).strip(), gender, item

    return left, "", gender, item


def _parse_stat_line(body: str) -> dict[str, int]:
    """Parse ``2 HP / 32 SpA / 32 Spe`` into ``{"hp": 2, "sa": 32, "sp": 32}``.

    Also accepts the positional Champions form ``32/32/2`` (HP/Atk/Def/SpA/
    SpD/Spe, matching MunchStats spread labels) when no stat labels are given.
    """
    stats: dict[str, int] = {}
    for chunk in body.split("/"):
        match = _STAT_ENTRY_RE.search(chunk)
        if not match:
            continue
        value = int(match.group(1))
        key = _STAT_KEYS.get(match.group(2).lower())
        if key:
            stats[key] = value

    if not stats:
        parts = [p.strip() for p in body.split("/") if p.strip()]
        if parts and all(p.isdigit() for p in parts):
            for key, part in zip([k for k, _ in _STAT_EXPORT], parts):
                stats[key] = int(part)

    return stats


def _empty_sps() -> dict[str, int]:
    """Return a fresh all-zero SP map."""
    return {key: 0 for key, _ in _STAT_EXPORT}


def _apply_stat_line(
    prefix: str, body: str, sps: dict[str, int], warnings: list[str]
) -> None:
    """Merge one EVs/SPs line into ``sps``, converting standard EVs if needed.

    Rule (documented because the conventions overlap):

    - An explicit ``SPs:`` line is always Stat Points.
    - An ``EVs:`` line with any value > 32 or a total > 66 cannot be an SP
      spread, so it is standard EVs and is converted with ``floor(ev / 8)``.
    - An ``EVs:`` line whose values all fit SPs but whose total is below
      ``_MIN_PLAUSIBLE_SP_TOTAL`` is treated as standard EVs: totals that small
      match the common leftover-EV pattern (``EVs: 4 HP``) and are implausible
      as a deliberate Champions spread.
    - Everything else is genuinely ambiguous. We prefer the Champions SP
      convention (this tool's target) and emit a warning when the total is
      small enough to be doubtful.
    """
    parsed = _parse_stat_line(body)
    if not parsed:
        return

    values = list(parsed.values())
    total = sum(values)

    if prefix == "sps":
        is_sps = True
    elif any(value > 32 for value in values) or total > 66:
        is_sps = False
    elif total < _MIN_PLAUSIBLE_SP_TOTAL:
        is_sps = False
    else:
        is_sps = True
        if total < _AMBIGUOUS_SP_TOTAL:
            warnings.append(
                "ambiguous EVs/SPs line; treating as SPs (Champions convention)"
            )

    for key, value in parsed.items():
        if is_sps:
            sps[key] = max(0, min(32, value))
        else:
            sps[key] = max(0, min(32, value // 8))

    if not is_sps:
        warnings.append("EVs converted to SPs")


def _parse_move(line: str, warnings: list[str]) -> str:
    """Extract a move name, taking the first slash alternative if present."""
    name = line.lstrip("-").strip()
    if "/" in name:
        first = name.split("/", 1)[0].strip()
        warnings.append(f'move "{name}" has slash alternatives; using "{first}"')
        return first
    return name


def _parse_block(block: str) -> dict | None:
    """Parse one non-empty set block. Returns ``None`` if no valid header.

    The first line must be a plausible species header; a block that starts with
    a move or a field line is not a set (see ``_is_plausible_header``).
    """
    lines = [line.strip() for line in block.split("\n") if line.strip()]
    if not lines:
        return None

    if not _is_plausible_header(lines[0]):
        return None

    warnings: list[str] = []
    species, nickname, gender, item = _parse_header(lines[0])
    if not species:
        return None

    set_obj: dict = {
        "species": species,
        "nickname": nickname,
        "level": 50,
        "nature": "Hardy",
        "ability": "",
        "item": item,
        "teraType": "",
        "gender": gender,
        "sps": _empty_sps(),
        "moves": [],
        "warnings": warnings,
    }

    for raw in lines[1:]:
        line = raw.strip()
        lower = line.lower()

        if line.startswith("-"):
            if len(set_obj["moves"]) < 4:
                set_obj["moves"].append(_parse_move(line, warnings))
            else:
                warnings.append(f'ignored extra move "{line.lstrip("-").strip()}"')
        elif lower.startswith("ability:"):
            set_obj["ability"] = line.split(":", 1)[1].strip()
        elif lower.startswith("level:"):
            value = line.split(":", 1)[1].strip()
            if value.isdigit():
                set_obj["level"] = int(value)
            else:
                warnings.append(f"unparseable level: {value!r}")
        elif lower.startswith("tera type:"):
            set_obj["teraType"] = line.split(":", 1)[1].strip()
        elif lower.startswith("gender:"):
            value = line.split(":", 1)[1].strip().upper()
            if value in ("M", "F"):
                set_obj["gender"] = value
        elif lower.startswith("evs:"):
            _apply_stat_line("evs", line.split(":", 1)[1], set_obj["sps"], warnings)
        elif lower.startswith("sps:"):
            _apply_stat_line("sps", line.split(":", 1)[1], set_obj["sps"], warnings)
        elif lower.startswith("ivs:"):
            parsed = _parse_stat_line(line.split(":", 1)[1])
            if any(value != 31 for value in parsed.values()):
                warnings.append("non-default IVs ignored")
        elif lower.startswith("shiny:") or lower.startswith("happiness:"):
            pass  # Parsed for completeness; not represented in our set shape.
        elif lower.endswith(" nature"):
            set_obj["nature"] = line[: -len(" nature")].strip()
        elif lower.startswith("nature:"):
            set_obj["nature"] = line.split(":", 1)[1].strip()
        # Any other line is ignored; Showdown exports vary slightly.

    return set_obj


def _append_continuation(set_obj: dict, block: str, warnings: list[str]) -> None:
    """Merge a header-less continuation block into an existing set.

    A stray blank line inside a set (common when copy-pasting) splits the set
    in two; the second half has no species header but does contain moves/fields.
    We re-parse it as if its lines were part of the previous set rather than
    inventing a bogus Pokemon.
    """
    lines = [line.strip() for line in block.split("\n") if line.strip()]
    if not lines:
        return

    # Reuse the existing parser by synthesising a header from the set's species.
    header = set_obj.get("species", "")
    if set_obj.get("nickname"):
        header = f"{set_obj['nickname']} ({header})"
    merged = _parse_block(header + "\n" + "\n".join(lines))
    if not merged:
        return

    for move in merged["moves"]:
        if len(set_obj["moves"]) < 4:
            set_obj["moves"].append(move)
    if merged["ability"]:
        set_obj["ability"] = merged["ability"]
    if merged["item"]:
        set_obj["item"] = merged["item"]
    if merged["teraType"]:
        set_obj["teraType"] = merged["teraType"]
    if merged["nature"] != "Hardy":
        set_obj["nature"] = merged["nature"]
    if merged["gender"]:
        set_obj["gender"] = merged["gender"]
    if merged["level"] != 50:
        set_obj["level"] = merged["level"]
    for key, value in merged["sps"].items():
        if value:
            set_obj["sps"][key] = value
    for warning in merged["warnings"]:
        if warning not in warnings:
            warnings.append(warning)


def parse_team(text: str) -> list[dict]:
    """Parse Showdown/pokepaste export text into normalized sets.

    Never raises on malformed content: blocks without a valid species header
    are merged into the previous set when they look like set content, or
    skipped (with a warning) otherwise. Raises ``ValueError`` only when the
    input yields zero sets.
    """
    normalized = _normalize_text(text or "")
    blocks = [b.strip() for b in _BLOCK_SPLIT_RE.split(normalized) if b.strip()]

    sets: list[dict] = []
    warnings: list[str] = []
    for block in blocks:
        try:
            parsed = _parse_block(block)
        except Exception as exc:  # Defensive: one bad block must not kill the team.
            print(f"  WARNING: failed to parse a set block: {exc}")
            continue

        if parsed is not None:
            sets.append(parsed)
            continue

        # No valid header. Merge into the previous set if this looks like a
        # continuation (moves/fields), otherwise skip it.
        if sets and _looks_like_set_content(block):
            first = block.split("\n", 1)[0].strip()
            _append_continuation(sets[-1], block, sets[-1]["warnings"])
            sets[-1]["warnings"].append(
                f'merged continuation block into {sets[-1]["species"]!r} (stray blank line?)'
            )
            print(f"  WARNING: merged header-less block starting {first!r}")
        else:
            first = block.split("\n", 1)[0].strip()
            warnings.append(f"skipped unparseable block starting {first!r}")
            print(f"  WARNING: skipped unparseable block starting {first!r}")

    if not sets:
        raise ValueError("No Pokemon sets found in input")

    if warnings:
        sets[0]["warnings"].extend(warnings)

    print(f"  Parsed {len(sets)} set(s) from Showdown text")
    return sets


def team_to_showdown(sets: list[dict]) -> str:
    """Render normalized sets back to Showdown export text (inverse of parse)."""
    blocks: list[str] = []

    for set_obj in sets:
        species = set_obj.get("species", "")
        nickname = set_obj.get("nickname", "")
        gender = set_obj.get("gender", "")
        item = set_obj.get("item", "")

        header = f"{nickname} ({species})" if nickname else species
        if gender in ("M", "F"):
            header += f" ({gender})"
        if item:
            header += f" @ {item}"

        lines = [header]
        if set_obj.get("ability"):
            lines.append(f"Ability: {set_obj['ability']}")
        if set_obj.get("level", 50) != 50:
            lines.append(f"Level: {set_obj['level']}")
        if set_obj.get("teraType"):
            lines.append(f"Tera Type: {set_obj['teraType']}")
        lines.append(f"{set_obj.get('nature', 'Hardy')} Nature")

        sps = set_obj.get("sps", {})
        entries = [
            f"{sps.get(key, 0)} {label}"
            for key, label in _STAT_EXPORT
            if sps.get(key, 0)
        ]
        if entries:
            lines.append("EVs: " + " / ".join(entries))

        for move in set_obj.get("moves", []):
            lines.append(f"- {move}")

        blocks.append("\n".join(lines))

    return "\n\n".join(blocks) + "\n"
