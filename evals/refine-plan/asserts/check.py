"""Grade a plan review against seeded-defect signatures. No LLM judge.

The provider appends the edited plan as a <captured-file path="plan.md">
trailer; every metric reads that artifact, never the reviewer's prose.

Components, never blended into one number in the reasoning:

  fixed      of the seeded safe-fix defects, how many got their prescribed
             repair (string absent / present / reordered)
  flagged    of the seeded judgment defects, how many appear in a
             "Decisions to confirm" block while STILL PRESENT in the plan —
             flag-not-delete is the skill's core discipline, so a silently
             cut task fails this even though the "problem" is gone
  preserved  canary strings (paths, run commands, FAIL/PASS lines) that must
             survive verbatim
  restraint  (clean case only) difflib similarity to the original plan — a
             reviewer that pads or re-authors a correct plan loses here

Overall score = mean of the components a case defines; pass = perfect.
"""

from __future__ import annotations

import difflib
import json
import re
from pathlib import Path


def _component(name, passed, total, detail):
    score = passed / total if total else 1.0
    return {
        "pass": score == 1.0,
        "score": score,
        "reason": detail or f"{passed}/{total}",
        "assertion": {"type": "python", "metric": name},
    }


def get_assert(output, context):
    case_dir = Path(context["vars"]["case_dir"])
    checks = json.loads((case_dir / "case.json").read_text())["checks"]
    original = (case_dir / "workspace" / "plan.md").read_text()

    m = re.search(r'<captured-file path="plan\.md">\n(.*)\n</captured-file>', output, re.S)
    plan = m.group(1) if m else ""
    if not plan.strip():
        return {"pass": False, "score": 0.0, "reason": "no plan.md captured — file missing or emptied"}

    components, reasons = [], []

    # Fixed and preserved checks scan the plan BODY: the mandated blocks
    # legitimately quote old values ("24 hours -> 1 hour" in the changelog)
    # and deleted text, which would trip `absent`/canary checks. Flagged
    # checks scan the full document — they need the Decisions block.
    def strip_blocks(text):
        text = re.sub(r"#+\s*Decisions to confirm.*?(?=\n#+ |\Z)", "", text, flags=re.S | re.I)
        return re.sub(r"#+\s*What I changed.*?(?=\n#+ |\Z)", "", text, flags=re.S | re.I)

    full, plan = plan, strip_blocks(plan)

    if checks["fixed"]:
        ok, misses = 0, []
        for c in checks["fixed"]:
            good = True
            for s in c.get("absent", []):
                if s in plan:
                    good = False
            for s in c.get("present", []):
                if s not in plan:
                    good = False
            if "not_both" in c:  # over-granular pair: at most one title survives a merge
                a, b = c["not_both"]
                if a in plan and b in plan:
                    good = False
            if "before" in c:
                i, j = plan.find(c["before"]), plan.find(c["after"])
                if i < 0 or j < 0 or i > j:
                    good = False
            ok += good
            if not good:
                misses.append(c["name"])
        components.append(_component("fixed", ok, len(checks["fixed"]),
                                     f"{ok}/{len(checks['fixed'])}" + (f" — missed: {', '.join(misses)}" if misses else "")))
        reasons.append(f"fixed {ok}/{len(checks['fixed'])}" + (f" (missed {', '.join(misses)})" if misses else ""))

    if checks["flagged"]:
        has_block = re.search(r"decisions to confirm", full, re.I) is not None
        ok, misses = 0, []
        for c in checks["flagged"]:
            kw = c["keyword"]
            # default 2: seeded once in the plan, so a second mention means the
            # Decisions block took it up. min_mentions 1 fits defects seeded in
            # the SPEC (an ambiguity the plan ignores entirely).
            need = c.get("min_mentions", 2)
            surviving = full.count(kw) >= max(1, need - 1)
            raised = has_block and full.count(kw) >= need
            invented = bool(c.get("must_not_regex")) and re.search(c["must_not_regex"], plan) is not None
            good = surviving and raised and not invented
            ok += good
            if not good:
                why = "invented an implementation" if invented else ("deleted" if not surviving else "not flagged")
                misses.append(f"{c['name']}({why})")
        components.append(_component("flagged", ok, len(checks["flagged"]),
                                     f"{ok}/{len(checks['flagged'])}" + (f" — {', '.join(misses)}" if misses else "")))
        reasons.append(f"flagged {ok}/{len(checks['flagged'])}" + (f" ({', '.join(misses)})" if misses else ""))

    canaries = checks.get("preserved", [])
    if canaries:
        kept = sum(1 for s in canaries if s in plan)
        lost = [s for s in canaries if s not in plan]
        components.append(_component("preserved", kept, len(canaries),
                                     f"{kept}/{len(canaries)}" + (f" — lost: {lost[0][:50]}" if lost else "")))
        reasons.append(f"preserved {kept}/{len(canaries)}")

    # Output contract, graded only where it applies: with flags raised the
    # Decisions block must sit ABOVE the first task; with fixes applied a
    # "What I changed" note must exist and mention each fix (report_hints).
    struct_checks = []
    if checks["flagged"]:
        dec = re.search(r"decisions to confirm", full, re.I)
        task = re.search(r"^#+\s*Task", full, re.M)
        struct_checks.append(("decisions-on-top", bool(dec) and bool(task) and dec.start() < task.start()))
    if checks["fixed"]:
        # The changelog may live in the plan OR in the reviewer's report (the
        # delegation flow returns it as the subagent's answer) — scan both.
        struct_checks.append(("changelog-present", re.search(r"what i changed", output, re.I) is not None))
    if struct_checks:
        ok = sum(1 for _, p in struct_checks if p)
        bad = [n for n, p in struct_checks if not p]
        components.append(_component("structure", ok, len(struct_checks),
                                     f"{ok}/{len(struct_checks)}" + (f" — {', '.join(bad)}" if bad else "")))
        reasons.append(f"structure {ok}/{len(struct_checks)}")

    hints = [(c["name"], c["report_hints"]) for c in checks["fixed"] if c.get("report_hints")]
    if hints:
        m2 = re.search(r"what i changed.*", output, re.S | re.I)
        log = m2.group(0) if m2 else ""
        ok = sum(1 for _, hs in hints if any(h.lower() in log.lower() for h in hs))
        bad = [n for n, hs in hints if not any(h.lower() in log.lower() for h in hs)]
        components.append(_component("reported", ok, len(hints),
                                     f"{ok}/{len(hints)}" + (f" — unreported: {', '.join(bad)}" if bad else "")))
        reasons.append(f"reported {ok}/{len(hints)}")

    if checks.get("min_similarity"):
        # The skill's own output format ADDS blocks (Decisions to confirm, the
        # changelog note) — restraint is measured on the plan body with those
        # mandated sections stripped, so the format doesn't read as padding.
        body = plan
        
        ratio = difflib.SequenceMatcher(None, original, body).ratio()
        goal = checks["min_similarity"]
        score = 1.0 if ratio >= goal else ratio / goal
        components.append({
            "pass": ratio >= goal, "score": score,
            "reason": f"similarity {ratio:.2f} (floor {goal})",
            "assertion": {"type": "python", "metric": "restraint"},
        })
        reasons.append(f"similarity {ratio:.2f}")

    score = sum(c["score"] for c in components) / len(components)
    return {
        "pass": score >= 0.99,
        "score": score,
        "reason": "; ".join(reasons),
        "componentResults": components,
    }
