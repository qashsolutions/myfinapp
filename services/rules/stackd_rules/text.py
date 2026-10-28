"""Whitespace handled the same way in both engines (invariant 10; October 27, 2026).

`SPACE` is the one list of whitespace: JavaScript's `\\s`, spelled out. Python's own `\\s` and
`str.strip()` differ from it (they include U+001C–U+001F and U+0085 and leave U+FEFF), so the
rules never use them on text; packages/rules/src/text.ts uses this same list. The device made
every stored fingerprint with JavaScript's list, which is why Python follows it.

Ordering needs nothing here: Python compares str by code point, and text.ts `compareText`
does the same in TypeScript.
"""

from __future__ import annotations

import re

SPACE_CLASS = (
    "[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]"
)
_RUNS = re.compile(SPACE_CLASS + "+")
_EDGES = re.compile("^" + SPACE_CLASS + "+|" + SPACE_CLASS + "+$")


def collapse_spaces(text: str) -> str:
    """Every run of whitespace becomes one space."""
    return _RUNS.sub(" ", text)


def trim_spaces(text: str) -> str:
    """Whitespace removed from both ends."""
    return _EDGES.sub("", text)
