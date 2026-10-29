"""keywords.json copies are current and well-formed.

stackd_rules/config/keywords.yaml is the source; scripts/build_keywords.py writes both copies.
"""

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "scripts"))

from build_keywords import TARGETS, render  # noqa: E402

from stackd_rules import categorize  # noqa: E402
from stackd_rules.fingerprint import clean_description, merchant_key  # noqa: E402
from stackd_rules.recurring import OTHER_KIND, contains_word, longest_word  # noqa: E402

VALID_CATEGORIES = {
    "cat-rent",
    "cat-groceries",
    "cat-utilities",
    "cat-transport",
    "cat-insurance",
    "cat-dining",
    "cat-shopping",
    "cat-subscriptions",
    "cat-fun",
    "cat-savings",
    "cat-debt-payoff",
    "cat-other",
    "cat-paycheck",
    "cat-side-income",
    "cat-refund",
    "cat-other-income",
}


def test_json_copies_match_the_yaml() -> None:
    expected = render()
    for target in TARGETS:
        assert target.exists(), f"missing {target}; run scripts/build_keywords.py"
        assert target.read_text(encoding="utf-8") == expected, f"{target} is stale"


def test_table_is_well_formed() -> None:
    data = json.loads(render())
    assert data["transfer"] and all(isinstance(w, str) and w for w in data["transfer"])
    for entry in data["keywords"]:
        assert entry["match"] and entry["match"] == entry["match"].strip()
        assert entry["category_id"] in VALID_CATEGORIES, entry
        assert entry["direction"] in {"in", "out", "any"}
        income = entry["category_id"] in {
            "cat-paycheck",
            "cat-side-income",
            "cat-refund",
            "cat-other-income",
        }
        assert entry["direction"] == ("in" if income else "out"), entry


SUBSCRIPTION_KINDS = [
    "video",
    "music",
    "audio",
    "cloud",
    "news",
    "fitness",
    "food",
    "software",
    "gaming",
    "dating",
    "learning",
    "security",
    "phone",
    "shopping",
    "boxes",
    "home",
]


def test_subscription_kinds_are_well_formed() -> None:
    data = json.loads(render())
    kinds = data["subscription_kinds"]
    assert len(kinds) >= 300, "the table was made more robust on October 29, 2026"
    for entry in kinds:
        assert entry["match"] and entry["match"] == entry["match"].strip(), entry
        assert clean_description(entry["match"]) == entry["match"], entry
        assert entry["kind"] in SUBSCRIPTION_KINDS, entry
    assert len({e["match"] for e in kinds}) == len(kinds)
    # Every kind has words, and every kind the person can pick has a name.
    names = data["subscription_kind_names"]
    assert [n["kind"] for n in names] == SUBSCRIPTION_KINDS
    for n in names:
        assert n["label"] and n["many"] and n["kind"] != OTHER_KIND, n
    assert {e["kind"] for e in kinds} == set(SUBSCRIPTION_KINDS)


def test_every_kind_word_reaches_its_own_kind() -> None:
    """The sweep (invariant 50: the longest word found decides, ties by order): each word, as a
    payee of its own, lands in its own kind, so no word is hidden by another."""
    for entry in json.loads(render())["subscription_kinds"]:
        assert _kind_of(entry["match"]) == entry["kind"], entry


def _kind_of(payee: str) -> str | None:
    table = [(e["match"], e["kind"]) for e in json.loads(render())["subscription_kinds"]]
    return longest_word(clean_description(payee), merchant_key(payee), table)


def test_common_payees_get_their_kind() -> None:
    cases = {
        "NETFLIX.COM 866-579-7172 CA": "video",
        "Hulu 877-8244858 CA": "video",
        "AMAZON PRIME VIDEO": "video",
        "Spotify USA": "music",
        "Audible*2K4LP": "audio",
        "APPLE.COM/BILL ICLOUD": "cloud",
        "NYTIMES*NYTDIGITAL": "news",
        "PLANET FITNESS #123": "fitness",
        "Golds Gym": "fitness",
        "DASHPASS*DOORDASH": "food",
        "HELLOFRESH 646-846-3663": "food",
        "Adobe *Creative Cld": "software",
        "MICROSOFT*365 PERSONAL": "software",
        "XBOX GAME PASS": "gaming",
        "TINDER*SUBSCRIPTION": "dating",
        "DUOLINGO": "learning",
        "NORDVPN": "security",
        "1PASSWORD": "security",
        "APPLECARE+": "phone",
        "AMAZON PRIME*1A2B3": "shopping",
        "WALMART+ MEMBERSHIP": "shopping",
        "BARKBOX": "boxes",
        "RING.COM": "home",
        "SIMPLISAFE": "home",
    }
    for payee, kind in cases.items():
        assert _kind_of(payee) == kind, payee


def test_short_words_never_hit_inside_other_words() -> None:
    """Word-boundary-safe matching (October 29, 2026): false positives stay out."""
    for payee in (
        "GYMBOREE PLAY & MUSIC",  # GYM
        "SPRINGFIELD WATER",  # RING
        "TIDALWAVE AUTO SPA",  # TIDAL
        "BADTOWN DELI",  # ADT
        "UPSNAP CAMERAS",  # PSN
        "STEAMBOAT GRILL",  # STEAM
        "QUIPPY TOYS",  # QUIP
        "WINCO FOODS",  # WINC
        "OURANOS CAFE",  # OURA
        "ARLOS TACOS",  # ARLO
        "SLACKWATER BREWING",  # SLACK
        "DISCORDIA BOOKS",  # DISCORD
        "WIREDRIVE",  # WIRED
        "CRUNCHY ROLLS BAKERY",  # CRUNCH and CRUNCHYROLL
        "HINGEMAN HARDWARE",  # HINGE
        "COSTCOTTA MARKET",  # COSTCO
        "CITY UTILITIES",
    ):
        assert _kind_of(payee) is None, payee


def test_contains_word() -> None:
    assert contains_word("GOLDS GYM", "GYM")
    assert contains_word("GYM-24", "GYM")
    assert not contains_word("GYMBOREE", "GYM")
    assert contains_word("RINGTONES RING.COM", "RING")  # a later place counts
    assert contains_word("ESPN+ 800", "ESPN+")
    assert not contains_word("BIGYM", "GYM")
    assert not contains_word("", "GYM")
    assert not contains_word("GYM", "")  # an empty word is never in anything


def _category_of(description: str, direction: str = "out") -> str | None:
    return categorize.match(description, direction, [], json.loads(render()))["category_id"]


def test_every_keyword_reaches_its_own_category() -> None:
    """The sweep (October 29, 2026, invariant 50): each keyword, as a description of its own,
    lands in its own category, so no keyword is hidden by another, shorter or earlier one."""
    for entry in json.loads(render())["keywords"]:
        direction = "in" if entry["direction"] == "in" else "out"
        assert _category_of(entry["match"], direction) == entry["category_id"], entry


def test_no_keyword_hits_inside_another_word() -> None:
    """Every keyword that sits inside a longer word of another keyword (RENT in PARENT, MKT in
    MKTP) is a whole word only: that longer text never takes the short keyword's category."""
    table = json.loads(render())["keywords"]
    for short in table:
        for other in table:
            text = other["match"]
            word = short["match"]
            if word in text and not contains_word(text, word):
                assert _category_of(text, other["direction"]) == other["category_id"], (
                    short,
                    other,
                )


def test_common_payees_get_their_category() -> None:
    cases = {
        ("UBER EATS PENDING", "out"): "cat-dining",
        ("UBER *EATS", "out"): "cat-dining",
        ("UBER *TRIP", "out"): "cat-transport",
        ("ENTERPRISE RENT-A-CAR #1234", "out"): "cat-transport",
        ("SHELLS SEAFOOD RESTAURANT", "out"): "cat-dining",
        ("SHELL OIL 57444", "out"): "cat-transport",
        ("AMZN MKTP US*2K3L45", "out"): "cat-shopping",
        ("Netflix.com", "out"): "cat-subscriptions",
        ("www.netflix.com", "out"): "cat-subscriptions",
        ("SUPERMARKET 21", "out"): "cat-groceries",
        ("CITY GROCERY", "out"): "cat-groceries",
        ("ACME DIRECT DEPOSIT", "in"): "cat-paycheck",
        ("TRADER JOES #552", "out"): "cat-groceries",
        ("MCDONALDS F1234", "out"): "cat-dining",
        ("JUNE RENT", "out"): "cat-rent",
        ("CITY POWER & LIGHT", "out"): "cat-utilities",
        ("METRO LIGHT & POWER 0042", "out"): "cat-utilities",
        ("PACIFIC GAS & ELECTRIC", "out"): "cat-utilities",
        ("SPRINGFIELD UTILITIES", "out"): "cat-utilities",
        ("CITY WATER DEPT", "out"): "cat-utilities",
    }
    for (payee, direction), category in cases.items():
        assert _category_of(payee, direction) == category, payee


def test_short_keywords_never_hit_inside_other_words() -> None:
    for payee in (
        "SHELLS SEAFOOD",  # SHELL
        "PARENT TEACHER ASSOC",  # RENT
        "ENTERPRISE RENTALS",  # RENT
        "METROPCS WIRELESS",  # METRO
        "CAFETERIA",  # CAFE
        "TARGETED ADS LLC",  # TARGET
    ):
        assert _category_of(payee) is None, payee
