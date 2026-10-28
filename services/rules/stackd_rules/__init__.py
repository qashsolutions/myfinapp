"""Stackd money math: pure, deterministic, versioned.

Stamp RULES_VERSION on every computed result so past numbers can be reproduced.
Keep it equal to the version in pyproject.toml (tests/test_version.py checks).
"""

RULES_VERSION = "0.32.0"

__all__ = ["RULES_VERSION"]
