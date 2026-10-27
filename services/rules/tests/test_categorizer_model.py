"""The shipped category model (owner decision, October 11, 2026): both engine copies match,
its held-out numbers reproduce exactly (training and inference are deterministic), and the
floors the trainer enforces hold. Retraining belongs to scripts/train_categorizer.py; this
only checks what ships."""

import json
from pathlib import Path

import yaml

from stackd_rules.categorize import suggest
from stackd_rules.money import round_div

ROOT = Path(__file__).resolve().parent.parent
MODEL_PATH = ROOT / "stackd_rules" / "config" / "categorizer.json"
PORT_COPY = ROOT.parent.parent / "packages" / "rules" / "src" / "categorizer.json"
CORPUS = ROOT / "stackd_rules" / "config" / "categorize_corpus.yaml"

# Keep in sync with scripts/train_categorizer.py (EVAL_NOISE and the floors).
EVAL_NOISE = [
    ("DEBIT CRD ", " #9871"),
    ("WEB PMT ", " PLANO TX"),
    ("", " SAN JOSE CA 800-555-0199"),
]
KNOWN_PRECISION_FLOOR_BPS = 9800
KNOWN_COVERAGE_FLOOR_BPS = 8800
UNSEEN_PRECISION_FLOOR_BPS = 7500


def test_both_copies_are_the_same_model() -> None:
    assert MODEL_PATH.read_text() == PORT_COPY.read_text()


def test_model_shape_and_labels() -> None:
    model = json.loads(MODEL_PATH.read_text())
    corpus = yaml.safe_load(CORPUS.read_text())
    assert model["labels"] == sorted(corpus["train"])
    assert all(label.startswith("cat-") for label in model["labels"])
    assert "cat-other" not in model["labels"]  # never guessed; below-floor answers are None
    assert model["min_margin"] > 0 and model["min_score"] >= 1


def test_eval_numbers_reproduce_and_hold_the_floors() -> None:
    model = json.loads(MODEL_PATH.read_text())
    corpus = yaml.safe_load(CORPUS.read_text())
    known_suggested = known_correct = known_total = 0
    for label, examples in sorted(corpus["train"].items()):
        for example in examples:
            for prefix, suffix in EVAL_NOISE:
                known_total += 1
                answer = suggest(f"{prefix}{example}{suffix}", model)
                if answer["category_id"] is not None:
                    known_suggested += 1
                    known_correct += answer["category_id"] == label
    unseen_suggested = unseen_correct = unseen_total = 0
    for label, examples in sorted(corpus["eval"].items()):
        for example in examples:
            for text in (example, f"SQ *{example} #2210", f"{example} DALLAS TX"):
                unseen_total += 1
                answer = suggest(text, model)
                if answer["category_id"] is not None:
                    unseen_suggested += 1
                    unseen_correct += answer["category_id"] == label
    known_precision = round_div(10000 * known_correct, known_suggested)
    known_coverage = round_div(10000 * known_suggested, known_total)
    unseen_precision = (
        round_div(10000 * unseen_correct, unseen_suggested) if unseen_suggested else 10000
    )
    assert model["eval"] == {
        "known_cases": known_total,
        "known_precision_bps": known_precision,
        "known_coverage_bps": known_coverage,
        "unseen_cases": unseen_total,
        "unseen_suggested": unseen_suggested,
        "unseen_correct": unseen_correct,
        "unseen_precision_bps": unseen_precision,
    }
    assert known_precision >= KNOWN_PRECISION_FLOOR_BPS
    assert known_coverage >= KNOWN_COVERAGE_FLOOR_BPS
    assert unseen_precision >= UNSEEN_PRECISION_FLOOR_BPS


def test_a_few_everyday_descriptions() -> None:
    model = json.loads(MODEL_PATH.read_text())
    assert suggest("TST* CHIPOTLE 2203 DALLAS TX", model)["category_id"] == "cat-dining"
    assert suggest("NETFLIX.COM 866-579-7172", model)["category_id"] == "cat-subscriptions"
    assert suggest("POS DEBIT WINCO FOODS #44", model)["category_id"] == "cat-groceries"
    # A brand it never saw stays Uncategorized instead of becoming a guess
    assert suggest("MUBI", model)["category_id"] is None
