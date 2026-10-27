#!/usr/bin/env python3
"""Fail CI if any package manifest or lockfile pulls in a denylisted AI/LLM package.

Hard constraint 2 (docs/spec.md): no LLM, AI or ML-as-a-service SDKs, client or server.
Patterns live in tools/denylist.txt. Standard library only; runs on Python 3.9+.

Scans, skipping node_modules / .venv / dist / docs:
  package.json, package-lock.json, pnpm-lock.yaml      (npm side)
  pyproject.toml, uv.lock, requirements*.txt           (Python side)

Usage:
  python3 tools/check_ai_denylist.py [ROOT]     # default ROOT = repo root
  python3 tools/check_ai_denylist.py --self-test  # proves a planted "openai" is caught
Exit code 1 lists every hit; 0 means clean.
"""

from __future__ import annotations

import fnmatch
import json
import re
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
DENYLIST_PATH = HERE / "denylist.txt"
SKIP_DIRS = {".git", "node_modules", ".venv", "dist", ".turbo", "__pycache__", ".pytest_cache", "docs"}

REQ_NAME = re.compile(r"\s*([A-Za-z0-9][A-Za-z0-9._-]*)")
# pnpm-lock.yaml v9: "  openai@4.0.0:" or "  '@langchain/core@0.1.0(peer@1)':"
PNPM_PKG = re.compile(r"""^\s*['"]?(@?[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9._-]+)?)@\d""")
UV_NAME = re.compile(r'^name\s*=\s*"([^"]+)"')
QUOTED = re.compile(r"""["']([A-Za-z0-9][A-Za-z0-9._-]*)""")


def norm(name: str) -> str:
    return name.strip().lower().replace("_", "-")


def load_denylist(path: Path = DENYLIST_PATH) -> list[str]:
    patterns = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if line:
            patterns.append(norm(line))
    return patterns


def denied_by(name: str, patterns: list[str]) -> str | None:
    n = norm(name)
    for p in patterns:
        if fnmatch.fnmatchcase(n, p):
            return p
    return None


def req_name(spec: str) -> str | None:
    m = REQ_NAME.match(spec)
    return m.group(1) if m else None


# --- extractors: file -> iterable of package names ------------------------------------------

def names_package_json(path: Path):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return
    if not isinstance(data, dict):
        return
    for section in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
        deps = data.get(section)
        if isinstance(deps, dict):
            yield from deps.keys()
    overrides = (data.get("pnpm") or {}).get("overrides") if isinstance(data.get("pnpm"), dict) else None
    if isinstance(overrides, dict):
        yield from overrides.keys()


def names_package_lock(path: Path):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return
    for key in (data.get("packages") or {}):
        if "node_modules/" in key:
            yield key.rsplit("node_modules/", 1)[1]


def names_pnpm_lock(path: Path):
    for line in path.read_text(encoding="utf-8").splitlines():
        m = PNPM_PKG.match(line)
        if m:
            yield m.group(1)


def names_pyproject(path: Path):
    text = path.read_text(encoding="utf-8")
    try:
        import tomllib  # Python 3.11+
    except ModuleNotFoundError:
        # Fallback: every quoted token that looks like a requirement name.
        for m in QUOTED.finditer(text):
            yield m.group(1)
        return
    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError:
        return
    project = data.get("project") or {}
    specs: list[str] = list(project.get("dependencies") or [])
    for group in (project.get("optional-dependencies") or {}).values():
        specs.extend(group)
    for group in (data.get("dependency-groups") or {}).values():
        specs.extend(s for s in group if isinstance(s, str))
    specs.extend((data.get("build-system") or {}).get("requires") or [])
    for spec in specs:
        name = req_name(spec)
        if name:
            yield name


def names_uv_lock(path: Path):
    for line in path.read_text(encoding="utf-8").splitlines():
        m = UV_NAME.match(line)
        if m:
            yield m.group(1)


def names_requirements(path: Path):
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line or line.startswith("-"):
            continue
        name = req_name(line)
        if name:
            yield name


def extractor_for(path: Path):
    name = path.name
    if name == "package.json":
        return names_package_json
    if name == "package-lock.json":
        return names_package_lock
    if name == "pnpm-lock.yaml":
        return names_pnpm_lock
    if name == "pyproject.toml":
        return names_pyproject
    if name == "uv.lock":
        return names_uv_lock
    if name.startswith("requirements") and name.endswith(".txt"):
        return names_requirements
    return None


def iter_manifests(root: Path):
    for path in root.rglob("*"):
        rel_parts = path.relative_to(root).parts
        if any(part in SKIP_DIRS for part in rel_parts[:-1]):
            continue
        if path.is_file() and extractor_for(path):
            yield path


def scan(root: Path, patterns: list[str]) -> list[tuple[Path, str, str]]:
    hits = []
    for path in iter_manifests(root):
        extract = extractor_for(path)
        seen = set()
        for name in extract(path):
            if name in seen:
                continue
            seen.add(name)
            pattern = denied_by(name, patterns)
            if pattern:
                hits.append((path.relative_to(root), name, pattern))
    return hits


def self_test(patterns: list[str]) -> int:
    """Plant denylisted packages in a scratch tree and make sure every one is caught."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "apps" / "web").mkdir(parents=True)
        (root / "apps" / "web" / "package.json").write_text(
            json.dumps({"dependencies": {"openai": "^4", "react": "^19"}, "devDependencies": {"@langchain/core": "1"}})
        )
        (root / "services" / "api").mkdir(parents=True)
        (root / "services" / "api" / "pyproject.toml").write_text(
            '[project]\nname = "x"\ndependencies = ["fastapi>=0.1", "Anthropic>=0.30"]\n'
        )
        (root / "pnpm-lock.yaml").write_text("packages:\n  langchain-openai@0.2.0:\n    resolution: {}\n")
        (root / "services" / "api" / "requirements-dev.txt").write_text("pytest\ngoogle_generativeai==1.0\n")
        expected = {"openai", "@langchain/core", "Anthropic", "langchain-openai", "google_generativeai"}
        found = {name for _, name, _ in scan(root, patterns)}
        missing = expected - found
        extra = found - expected
        if missing or extra:
            print(f"SELF-TEST FAILED: missing={sorted(missing)} unexpected={sorted(extra)}")
            return 1
    print(f"self-test ok: {len(expected)} planted packages caught")
    return 0


def main(argv: list[str]) -> int:
    patterns = load_denylist()
    if "--self-test" in argv:
        return self_test(patterns)
    root = Path(argv[1]).resolve() if len(argv) > 1 else REPO_ROOT
    hits = scan(root, patterns)
    if hits:
        print("Denylisted AI packages found (hard constraint 2, docs/spec.md):")
        for path, name, pattern in hits:
            print(f"  {path}: {name}  (matches '{pattern}')")
        return 1
    print(f"ai-denylist ok: no denylisted packages under {root}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
