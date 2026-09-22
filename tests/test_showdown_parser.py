"""Tests for showdown_parser."""

from __future__ import annotations

import pytest

from showdown_parser import parse_team, team_to_showdown

FULL_BLOCK = """Salamence-Mega @ Salamencite
Ability: Intimidate
Level: 50
Tera Type: Steel
Timid Nature
EVs: 2 HP / 32 SpA / 32 Spe
- Hyper Voice
- Draco Meteor
- Flamethrower
- Protect
"""


def test_full_block():
    sets = parse_team(FULL_BLOCK)
    assert len(sets) == 1

    s = sets[0]
    assert s["species"] == "Salamence-Mega"
    assert s["nickname"] == ""
    assert s["level"] == 50
    assert s["nature"] == "Timid"
    assert s["ability"] == "Intimidate"
    assert s["item"] == "Salamencite"
    assert s["teraType"] == "Steel"
    assert s["gender"] == ""
    assert s["sps"] == {"hp": 2, "at": 0, "df": 0, "sa": 32, "sd": 0, "sp": 32}
    assert s["moves"] == ["Hyper Voice", "Draco Meteor", "Flamethrower", "Protect"]
    assert s["warnings"] == []


def test_nickname_and_gender():
    sets = parse_team("Draco (Salamence) (M) @ Life Orb\n- Draco Meteor\n")
    s = sets[0]
    assert s["species"] == "Salamence"
    assert s["nickname"] == "Draco"
    assert s["gender"] == "M"
    assert s["item"] == "Life Orb"


def test_gender_only_species():
    sets = parse_team("Salamence (F) @ Leftovers\n")
    s = sets[0]
    assert s["species"] == "Salamence"
    assert s["nickname"] == ""
    assert s["gender"] == "F"
    assert s["item"] == "Leftovers"


def test_defaults_when_fields_missing():
    sets = parse_team("Kingambit\n")
    s = sets[0]
    assert s["species"] == "Kingambit"
    assert s["level"] == 50
    assert s["nature"] == "Hardy"
    assert s["ability"] == ""
    assert s["item"] == ""
    assert s["teraType"] == ""
    assert s["sps"] == {"hp": 0, "at": 0, "df": 0, "sa": 0, "sd": 0, "sp": 0}
    assert s["moves"] == []


def test_slash_alternative_moves_take_first_and_warn():
    sets = parse_team("Incineroar @ Sitrus Berry\n- Protect / Detect\n- Flare Blitz\n")
    s = sets[0]
    assert s["moves"] == ["Protect", "Flare Blitz"]
    assert any("slash alternatives" in w for w in s["warnings"])


def test_single_type_less_input():
    # A bare "(Species)" header with no item/ability/nature/moves.
    sets = parse_team("(Audino)\n")
    s = sets[0]
    assert s["species"] == "Audino"
    assert s["item"] == ""
    assert s["moves"] == []


def test_crlf_and_nbsp_tolerated():
    text = "Salamence @ Life Orb\r\nAbility: Intimidate\r\nTimid Nature\r\n- Draco Meteor\r\n"
    sets = parse_team(text)
    s = sets[0]
    assert s["species"] == "Salamence"
    assert s["ability"] == "Intimidate"
    assert s["nature"] == "Timid"
    assert s["moves"] == ["Draco Meteor"]

    nbsp = "Salamence\xa0@\xa0Life Orb\n- Draco Meteor\n"
    sets = parse_team(nbsp)
    assert sets[0]["item"] == "Life Orb"


def test_ev_vs_sp_detection():
    # Standard 252-style EVs are converted to SPs and warned about.
    ev_text = "Garchomp @ Life Orb\nAdamant Nature\nEVs: 252 Atk / 252 Spe / 4 HP\n- Earthquake\n"
    s = parse_team(ev_text)[0]
    assert s["sps"] == {"hp": 0, "at": 31, "df": 0, "sa": 0, "sd": 0, "sp": 31}
    assert "EVs converted to SPs" in s["warnings"]

    # Champions-style SPs pass through untouched, no warning.
    sp_text = "Garchomp @ Life Orb\nAdamant Nature\nEVs: 32 Atk / 32 Spe / 2 HP\n- Earthquake\n"
    s = parse_team(sp_text)[0]
    assert s["sps"] == {"hp": 2, "at": 32, "df": 0, "sa": 0, "sd": 0, "sp": 32}
    assert s["warnings"] == []


def test_explicit_sps_line_always_treated_as_sps():
    text = "Garchomp\nSPs: 32 Atk / 32 Spe\n- Earthquake\n"
    s = parse_team(text)[0]
    assert s["sps"]["at"] == 32
    assert s["sps"]["sp"] == 32
    assert s["warnings"] == []


def test_non_default_ivs_warn():
    text = "Garchomp\nIVs: 0 Atk / 31 Spe\n- Earthquake\n"
    s = parse_team(text)[0]
    assert any("IVs" in w for w in s["warnings"])


def test_multiple_blocks():
    text = "Salamence @ Life Orb\n- Draco Meteor\n\nKingambit @ Chople Berry\n- Sucker Punch\n"
    sets = parse_team(text)
    assert [s["species"] for s in sets] == ["Salamence", "Kingambit"]


def test_zero_sets_raises_value_error():
    with pytest.raises(ValueError):
        parse_team("")
    with pytest.raises(ValueError):
        parse_team("\n\n   \n")


def test_team_to_showdown_round_trip():
    original = parse_team(FULL_BLOCK)
    rendered = team_to_showdown(original)
    reparsed = parse_team(rendered)

    assert reparsed[0]["species"] == original[0]["species"]
    assert reparsed[0]["ability"] == original[0]["ability"]
    assert reparsed[0]["item"] == original[0]["item"]
    assert reparsed[0]["nature"] == original[0]["nature"]
    assert reparsed[0]["teraType"] == original[0]["teraType"]
    assert reparsed[0]["sps"] == original[0]["sps"]
    assert reparsed[0]["moves"] == original[0]["moves"]


# ---------------------------------------------------------------------------
# HIGH-2 -- blank lines inside a set must not create bogus Pokemon
# ---------------------------------------------------------------------------


def test_blank_line_mid_set_merges_and_keeps_item():
    text = "Salamence @ Life Orb\n\n- Draco Meteor\n"
    sets = parse_team(text)

    assert len(sets) == 1
    s = sets[0]
    assert s["species"] == "Salamence"
    assert s["item"] == "Life Orb"
    assert s["moves"] == ["Draco Meteor"]
    assert any("merged continuation" in w for w in s["warnings"])


def test_blank_line_mid_set_between_fields():
    text = (
        "Garchomp @ Life Orb\n"
        "Ability: Rough Skin\n"
        "\n"
        "Adamant Nature\n"
        "EVs: 32 Atk / 32 Spe / 2 HP\n"
        "- Earthquake\n"
    )
    sets = parse_team(text)
    assert len(sets) == 1
    s = sets[0]
    assert s["species"] == "Garchomp"
    assert s["item"] == "Life Orb"
    assert s["ability"] == "Rough Skin"
    assert s["nature"] == "Adamant"
    assert s["moves"] == ["Earthquake"]


def test_blank_line_between_sets_still_splits():
    text = "Salamence @ Life Orb\n- Draco Meteor\n\nKingambit @ Chople Berry\n- Sucker Punch\n"
    sets = parse_team(text)
    assert [s["species"] for s in sets] == ["Salamence", "Kingambit"]
    assert sets[0]["item"] == "Life Orb"
    assert sets[1]["item"] == "Chople Berry"


def test_leading_and_trailing_blank_lines():
    text = "\n\n\nSalamence @ Life Orb\n- Draco Meteor\n\n\n\n"
    sets = parse_team(text)
    assert len(sets) == 1
    assert sets[0]["species"] == "Salamence"


def test_multiple_consecutive_blank_lines_mid_set():
    text = "Salamence @ Life Orb\n\n\n\n- Draco Meteor\n\n\n- Flamethrower\n"
    sets = parse_team(text)
    assert len(sets) == 1
    assert sets[0]["species"] == "Salamence"
    assert sets[0]["moves"] == ["Draco Meteor", "Flamethrower"]


def test_header_rejects_move_line_and_field_lines():
    # A block whose first line is a move must not become a Pokemon.
    sets = parse_team("Salamence @ Life Orb\n- Draco Meteor\n\n- Flamethrower\n")
    assert len(sets) == 1
    assert sets[0]["species"] == "Salamence"
    assert "Flamethrower" in sets[0]["moves"]


def test_orphan_move_block_skipped_with_warning():
    # A move-only block with no previous set is skipped and warned about.
    with pytest.raises(ValueError):
        parse_team("- Draco Meteor\n")


# ---------------------------------------------------------------------------
# MEDIUM-7 -- EV/SP heuristic
# ---------------------------------------------------------------------------


def test_evs_four_hp_is_converted_not_treated_as_sps():
    # "EVs: 4 HP" is a standard leftover EV, not 4 SPs -> floor(4/8) = 0.
    s = parse_team("Garchomp\nEVs: 4 HP\n- Earthquake\n")[0]
    assert s["sps"]["hp"] == 0
    assert "EVs converted to SPs" in s["warnings"]


def test_evs_252_spread_converted():
    s = parse_team("Garchomp\nEVs: 252 Atk / 252 Spe / 4 HP\n- Earthquake\n")[0]
    assert s["sps"] == {"hp": 0, "at": 31, "df": 0, "sa": 0, "sd": 0, "sp": 31}
    assert "EVs converted to SPs" in s["warnings"]


def test_explicit_sps_positional_form():
    # Champions positional form: HP/Atk/Def/SpA/SpD/Spe.
    s = parse_team("Garchomp\nSPs: 32/32/2\n- Earthquake\n")[0]
    assert s["sps"] == {"hp": 32, "at": 32, "df": 2, "sa": 0, "sd": 0, "sp": 0}
    assert "EVs converted to SPs" not in s["warnings"]


def test_ambiguous_small_sps_line_warns():
    # Total below the plausible-SP floor but not clearly EVs -> treated as SPs
    # is impossible here (below floor => EVs); a mid-size total warns.
    s = parse_team("Garchomp\nEVs: 16 HP / 16 Atk / 8 Def\n- Earthquake\n")[0]
    # total 40 -> ambiguous SP range, treated as SPs with a warning.
    assert s["sps"]["hp"] == 16
    assert any("ambiguous" in w for w in s["warnings"])


# ---------------------------------------------------------------------------
# LOW-17 -- gender after the item
# ---------------------------------------------------------------------------


def test_gender_after_item():
    sets = parse_team("Salamence @ Life Orb (M)\n- Draco Meteor\n")
    s = sets[0]
    assert s["species"] == "Salamence"
    assert s["gender"] == "M"
    assert s["item"] == "Life Orb"


def test_nickname_gender_after_item():
    sets = parse_team("Draco (Salamence) @ Life Orb (F)\n- Draco Meteor\n")
    s = sets[0]
    assert s["species"] == "Salamence"
    assert s["nickname"] == "Draco"
    assert s["gender"] == "F"
    assert s["item"] == "Life Orb"
