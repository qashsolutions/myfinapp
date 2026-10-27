"""Trains the on-device category suggester (owner decision, October 11, 2026).

Reads the curated corpus (config/categorize_corpus.yaml), adds deterministic processor noise
(statement prefixes, store numbers, city + state), trains an averaged multiclass perceptron
over hashed character n-grams of the cleaned description, quantises the weights to integers,
picks the confidence floors from the held-out eval set, and writes `categorizer.json` here and
in packages/rules/src/ (both generated; tests/test_categorizer_model.py checks they match and
that eval accuracy holds). Pure Python, fixed seed: retraining the same corpus gives the same
artifact byte for byte. Nothing here runs at runtime; the app ships only the weights.

Run after editing the corpus:  uv run python scripts/train_categorizer.py
"""

from __future__ import annotations

import json
from pathlib import Path

import yaml

from stackd_rules.categorize import _hashed_features, suggest
from stackd_rules.fingerprint import clean_description
from stackd_rules.money import round_div

HERE = Path(__file__).resolve().parent.parent
CORPUS = HERE / "stackd_rules" / "config" / "categorize_corpus.yaml"
OUT = [
    HERE / "stackd_rules" / "config" / "categorizer.json",
    HERE.parent.parent / "packages" / "rules" / "src" / "categorizer.json",
]

DIM = 4096
NGRAMS = [3, 4]
SCALE = 100
EPOCHS = 15
SEED = 20261011
MIN_SCORE = 1  # a positive score at all; the margin floor does the real gating
MARGIN_CANDIDATES = list(range(0, 4001, 50))
# The model exists to recognise KNOWN merchants under statement noise it never saw; an unknown
# brand name carries no signal and the right answer is to abstain, never to guess. The floors
# say exactly that: on known merchants with unseen noise, suggest almost always and almost
# always correctly; on unseen brands, whatever little it does suggest must still usually be
# right (shared words like FINANCE or MOBILE), and abstaining is fine.
KNOWN_PRECISION_FLOOR_BPS = 9800
KNOWN_COVERAGE_FLOOR_BPS = 8800
UNSEEN_PRECISION_FLOOR_BPS = 7500

PREFIXES = ["", "SQ *", "TST* ", "PAYPAL *", "POS DEBIT ", "CHECKCARD 1012 ", "PURCHASE "]
SUFFIXES = [
    "",
    ".COM",
    " #1234",
    " 0441",
    " DALLAS TX",
    " AUSTIN TX",
    " HOUSTON TX",
    " 866-555-0101",
]
# Noise the training never sees, for the known-merchant half of the eval.
EVAL_NOISE = [
    ("DEBIT CRD ", " #9871"),
    ("WEB PMT ", " PLANO TX"),
    ("", " SAN JOSE CA 800-555-0199"),
]


class Lcg:
    """A tiny deterministic generator so training never depends on Python's RNG internals."""

    def __init__(self, seed: int) -> None:
        self.state = seed & 0xFFFFFFFF

    def next(self, bound: int) -> int:
        self.state = (self.state * 1664525 + 1013904223) & 0xFFFFFFFF
        return self.state % bound


def variants(example: str) -> list[str]:
    out = []
    for prefix in PREFIXES:
        for suffix in SUFFIXES:
            out.append(f"{prefix}{example}{suffix}")
    return out


def train() -> dict:
    corpus = yaml.safe_load(CORPUS.read_text())
    labels = sorted(corpus["train"])
    index = {label: i for i, label in enumerate(labels)}
    samples: list[tuple[list[int], int]] = []
    for label, examples in sorted(corpus["train"].items()):
        for example in examples:
            for text in variants(example):
                features = _hashed_features(clean_description(text), NGRAMS, DIM)
                samples.append((features, index[label]))

    classes = len(labels)
    buckets = 2 * DIM  # n-grams in [0, DIM), whole words in [DIM, 2*DIM)
    weights = [[0] * classes for _ in range(buckets)]
    summed = [[0] * classes for _ in range(buckets)]
    bias = [0] * classes
    bias_summed = [0] * classes
    rng = Lcg(SEED)
    step = 0
    order = list(range(len(samples)))
    for _ in range(EPOCHS):
        for i in range(len(order) - 1, 0, -1):  # Fisher-Yates with the LCG
            j = rng.next(i + 1)
            order[i], order[j] = order[j], order[i]
        for sample_index in order:
            features, truth = samples[sample_index]
            scores = list(bias)
            for bucket in features:
                for c in range(classes):
                    scores[c] += weights[bucket][c]
            predicted = max(range(classes), key=lambda c: (scores[c], -c))
            if predicted != truth:
                for bucket in features:
                    weights[bucket][truth] += 1
                    weights[bucket][predicted] -= 1
                    summed[bucket][truth] += step
                    summed[bucket][predicted] -= step
                bias[truth] += 1
                bias[predicted] -= 1
                bias_summed[truth] += step
                bias_summed[predicted] -= step
            step += 1

    # Averaged weights: w - summed/step, quantised half-even to integers at SCALE.
    sparse: dict[str, list[int]] = {}
    for bucket in range(2 * DIM):
        row = [
            round_div(SCALE * (weights[bucket][c] * step - summed[bucket][c]), step)
            for c in range(classes)
        ]
        if any(row):
            sparse[str(bucket)] = row
    avg_bias = [round_div(SCALE * (bias[c] * step - bias_summed[c]), step) for c in range(classes)]
    return {
        "version": 1,
        "dim": DIM,
        "ngrams": NGRAMS,
        "scale": SCALE,
        "labels": labels,
        "bias": avg_bias,
        "weights": sparse,
        "min_score": MIN_SCORE,
        "min_margin": 0,  # chosen below from the eval set
    }


def _score(model: dict, cases: list[tuple[str, str]], min_margin: int) -> tuple[int, int, int]:
    """(suggested, correct, total) for (description, true label) cases at a margin floor."""
    trial = {**model, "min_margin": min_margin}
    suggested = correct = 0
    for text, label in cases:
        answer = suggest(text, trial)
        if answer["category_id"] is not None:
            suggested += 1
            if answer["category_id"] == label:
                correct += 1
    return suggested, correct, len(cases)


def eval_cases(corpus: dict) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    known = [
        (f"{prefix}{example}{suffix}", label)
        for label, examples in sorted(corpus["train"].items())
        for example in examples
        for prefix, suffix in EVAL_NOISE
    ]
    unseen = [
        (text, label)
        for label, examples in sorted(corpus["eval"].items())
        for example in examples
        for text in (example, f"SQ *{example} #2210", f"{example} DALLAS TX")
    ]
    return known, unseen


def main() -> int:
    corpus = yaml.safe_load(CORPUS.read_text())
    model = train()
    known, unseen = eval_cases(corpus)
    chosen = None
    for margin in MARGIN_CANDIDATES:
        ks, kc, kt = _score(model, known, margin)
        us, uc, ut = _score(model, unseen, margin)
        known_precision = round_div(10000 * kc, ks) if ks else 0
        known_coverage = round_div(10000 * ks, kt)
        unseen_precision = round_div(10000 * uc, us) if us else 10000
        if (
            known_precision >= KNOWN_PRECISION_FLOOR_BPS
            and known_coverage >= KNOWN_COVERAGE_FLOOR_BPS
            and unseen_precision >= UNSEEN_PRECISION_FLOOR_BPS
        ):
            chosen = (margin, known_precision, known_coverage, unseen_precision, us, uc, ut, kt)
            break
    if chosen is None:
        print("no margin floor reaches the eval floors; model not written")
        return 1
    margin, known_precision, known_coverage, unseen_precision, us, uc, ut, kt = chosen
    model["min_margin"] = margin
    model["eval"] = {
        "known_cases": kt,
        "known_precision_bps": known_precision,
        "known_coverage_bps": known_coverage,
        "unseen_cases": ut,
        "unseen_suggested": us,
        "unseen_correct": uc,
        "unseen_precision_bps": unseen_precision,
    }
    text = json.dumps(model, indent=2, sort_keys=True) + "\n"
    for path in OUT:
        path.write_text(text)
        print(f"wrote {path}")
    print(
        f"margin floor {margin}: known-with-noise precision {known_precision / 100:.1f}% "
        f"coverage {known_coverage / 100:.1f}% ({kt} cases); unseen brands precision "
        f"{unseen_precision / 100:.1f}% on {us}/{ut} suggested; "
        f"{len(model['weights'])} active buckets"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
