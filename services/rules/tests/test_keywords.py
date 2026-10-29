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

from stackd_rules.fingerprint import clean_description  # noqa: E402
from stackd_rules.recurring import OTHER_KIND, contains_word  # noqa: E402

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


def test_no_word_is_hidden_by_an_earlier_one() -> None:
    """A word that an earlier word of another kind already matches (as a whole word) could
    never be reached: first match wins."""
    kinds = json.loads(render())["subscription_kinds"]
    for i, later in enumerate(kinds):
        for earlier in kinds[:i]:
            if earlier["kind"] != later["kind"]:
                assert not contains_word(later["match"], earlier["match"]), (earlier, later)


def _kind_of(payee: str) -> str | None:
    table = [(e["match"], e["kind"]) for e in json.loads(render())["subscription_kinds"]]
    clean = clean_description(payee)
    return next((k for word, k in table if contains_word(clean, word)), None)


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
