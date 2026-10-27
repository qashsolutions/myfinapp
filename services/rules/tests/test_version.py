"""RULES_VERSION is the value stamped on results; keep it equal to the package version."""

import re
import tomllib
from pathlib import Path

from stackd_rules import RULES_VERSION


def test_rules_version_matches_pyproject() -> None:
    pyproject = tomllib.loads((Path(__file__).parents[1] / "pyproject.toml").read_text())
    assert RULES_VERSION == pyproject["project"]["version"]


def test_rules_version_is_semver() -> None:
    assert re.fullmatch(r"\d+\.\d+\.\d+", RULES_VERSION)
