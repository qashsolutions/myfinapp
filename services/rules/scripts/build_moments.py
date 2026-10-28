"""moments.yaml -> moments.json: every in-app message, nudge and push label, for the web app
(packages/rules) and the API (push labels). Refuses to write a catalog that breaks a rule.

Run: uv run python scripts/build_moments.py
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
CONFIG = HERE.parent / "stackd_rules" / "config"
YAML = CONFIG / "moments.yaml"
TARGETS = [
    CONFIG / "moments.json",
    HERE.parent.parent.parent / "packages" / "rules" / "src" / "moments.json",
]
PLACEHOLDER = re.compile(r"\{([a-z_]+)\}")
SOUNDS = {"kaching", "chime", "none"}
CONFETTI = {"none", "small", "big"}
ONCE = {"always", "per_day", "per_month"}
TEXT_FIELDS = ("title", "detail", "cta", "to")


class CatalogError(ValueError):
    pass


def _check_vars(where: str, text: str, allowed: list[str]) -> None:
    for name in PLACEHOLDER.findall(text):
        if name not in allowed:
            raise CatalogError(f"{where}: {{{name}}} is not in vars {allowed}")


def compile_catalog(data: dict) -> dict:
    events: dict[str, dict] = {}
    for key, ev in data["events"].items():
        allowed = [str(v) for v in ev.get("vars", [])]
        out: dict = {"when": str(ev["when"]), "vars": allowed}
        if "push" in ev:
            label = str(ev["push"])
            if PLACEHOLDER.search(label) or re.search(r"[$0-9]", label):
                raise CatalogError(f"{key}.push must be fixed text with no amounts: {label!r}")
            out["push"] = label
            out["settings"] = str(ev["settings"])
        for field in ("toast", "card"):
            if field in ev:
                lines = [str(t) for t in ev[field]]
                if not lines:
                    raise CatalogError(f"{key}.{field} is empty")
                for i, line in enumerate(lines):
                    _check_vars(f"{key}.{field}[{i}]", line, allowed)
                out[field] = lines
        if "action" in ev:
            # A toast's one link (October 23, 2026): fixed words, an in-app path, no values.
            action = ev["action"]
            label, to = str(action.get("label", "")), str(action.get("to", ""))
            fixed = label and not PLACEHOLDER.search(label)
            if not fixed or not to.startswith("/") or "toast" not in ev:
                raise CatalogError(f"{key}.action needs fixed label text, a /path and a toast")
            out["action"] = {"label": label, "to": to}
        if "toast" in ev or "card" in ev:
            effects = ev.get("effects", {"sound": "none", "confetti": "none"})
            if effects.get("sound") not in SOUNDS or effects.get("confetti") not in CONFETTI:
                raise CatalogError(f"{key}.effects: {effects}")
            if "toast" not in ev:
                ev.setdefault("once", "always")  # a card line shows wherever its card is
            if ev.get("once") not in ONCE:
                raise CatalogError(f"{key}.once must be one of {sorted(ONCE)}")
            out["effects"] = {"sound": effects["sound"], "confetti": effects["confetti"]}
            out["once"] = ev["once"]
        if "push" not in out and "toast" not in out and "card" not in out:
            raise CatalogError(f"{key} does nothing: give it a toast, a card or a push")
        events[str(key)] = out
    summary = str(data["push_summary"])
    if PLACEHOLDER.findall(summary) != ["n"]:
        raise CatalogError("push_summary takes exactly {n}")
    summary_one = str(data["push_summary_one"])
    if PLACEHOLDER.findall(summary_one):
        raise CatalogError("push_summary_one takes no values")
    plan_ended = str(data["push_plan_ended"])
    if PLACEHOLDER.findall(plan_ended):
        raise CatalogError("push_plan_ended takes no values")
    trial_ends = str(data["push_trial_ends_tomorrow"])
    if PLACEHOLDER.findall(trial_ends):
        raise CatalogError("push_trial_ends_tomorrow takes no values")
    nudges: dict[str, dict] = {}
    for key, nd in data["nudges"].items():
        allowed = [str(v) for v in nd.get("vars", [])]
        out = {"vars": allowed}
        for field in TEXT_FIELDS:
            text = str(nd[field])
            _check_vars(f"nudges.{key}.{field}", text, allowed)
            out[field] = text
        nudges[str(key)] = out
    return {
        "version": int(data["version"]),
        "events": events,
        "push_summary": summary,
        "push_summary_one": summary_one,
        "push_plan_ended": plan_ended,
        "push_trial_ends_tomorrow": trial_ends,
        "nudges": nudges,
    }


def render() -> str:
    data = yaml.safe_load(YAML.read_text(encoding="utf-8"))
    return json.dumps(compile_catalog(data), indent=2, ensure_ascii=False) + "\n"


if __name__ == "__main__":
    text = render()
    for target in TARGETS:
        target.write_text(text, encoding="utf-8")
        print(f"wrote {target}")
