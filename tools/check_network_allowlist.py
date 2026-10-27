#!/usr/bin/env python3
"""Fail CI if backend source references an outbound host that is not allowlisted.

Hard constraint 2 (docs/spec.md): the backend may only call allowlisted hosts. This is the
static half of that guard: it scans URL literals in services/**/*.py and *.yaml|*.yml and
checks each host against tools/network_allowlist.txt. The runtime half (an HTTP client that
refuses non-allowlisted hosts) lands in chunk 0.5.

A line ending in the comment marker  # net-allow: <reason>  is exempt (for documentation
links in docstrings, for example). Standard library only; Python 3.9+.

Usage: python3 tools/check_network_allowlist.py [ROOT]
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
ALLOWLIST_PATH = HERE / "network_allowlist.txt"
SCAN_DIRS = ("services",)
SCAN_SUFFIXES = {".py", ".yaml", ".yml"}
SKIP_DIRS = {".git", "node_modules", ".venv", "dist", "__pycache__", ".pytest_cache"}
ALWAYS_ALLOWED = {"localhost", "127.0.0.1", "0.0.0.0", "::1"}
ALWAYS_ALLOWED_SUFFIXES = (".localhost", ".example", ".invalid", ".test", "example.com", "example.org", "example.net")
URL = re.compile(r"https?://([A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\])")
EXEMPT = re.compile(r"#\s*net-allow:")


def load_allowlist(path: Path = ALLOWLIST_PATH) -> list[str]:
    hosts = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip().lower()
        if line:
            hosts.append(line)
    return hosts


def is_allowed(host: str, allowlist: list[str]) -> bool:
    h = host.lower().strip("[]")
    if h in ALWAYS_ALLOWED or h.endswith(ALWAYS_ALLOWED_SUFFIXES):
        return True
    for entry in allowlist:
        if entry.startswith("*."):
            if h == entry[2:] or h.endswith(entry[1:]):
                return True
        elif h == entry:
            return True
    return False


def iter_sources(root: Path):
    for d in SCAN_DIRS:
        base = root / d
        if not base.is_dir():
            continue
        for path in base.rglob("*"):
            if any(part in SKIP_DIRS for part in path.relative_to(root).parts[:-1]):
                continue
            if path.is_file() and path.suffix in SCAN_SUFFIXES:
                yield path


def scan(root: Path, allowlist: list[str]) -> list[tuple[Path, int, str]]:
    hits = []
    for path in iter_sources(root):
        for lineno, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            if EXEMPT.search(line):
                continue
            for m in URL.finditer(line):
                host = m.group(1)
                if not is_allowed(host, allowlist):
                    hits.append((path.relative_to(root), lineno, host))
    return hits


def main(argv: list[str]) -> int:
    allowlist = load_allowlist()
    root = Path(argv[1]).resolve() if len(argv) > 1 else REPO_ROOT
    hits = scan(root, allowlist)
    if hits:
        print("Outbound hosts not in tools/network_allowlist.txt:")
        for path, lineno, host in hits:
            print(f"  {path}:{lineno}: {host}")
        return 1
    print("network-allowlist ok: every backend URL literal is allowlisted")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
