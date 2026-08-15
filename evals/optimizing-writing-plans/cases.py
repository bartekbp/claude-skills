"""cases/<id>/ -> promptfoo tests.

Each case is a workspace/ (spec.md + plan.md + a stub src tree) beside a
case.json holding grep-checkable defect signatures. The labels are authored,
true by construction: every seeded defect names the exact strings whose
presence/absence/order proves its prescribed treatment (fix, flag, or keep).
case.json sits OUTSIDE workspace/ so the agent never sees the answer key —
the provider copies only repo_dir.
"""

from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent


def generate_tests() -> list[dict]:
    tests = []
    for case_file in sorted((HERE / "cases").glob("*/case.json")):
        case = json.loads(case_file.read_text())
        checks = case["checks"]
        tests.append(
            {
                "description": f"{case['id']} — {len(checks['fixed'])} fix, "
                f"{len(checks['flagged'])} flag",
                "vars": {
                    "repo_dir": str(case_file.parent / "workspace"),
                    "case_dir": str(case_file.parent),
                },
                "assert": [
                    {
                        "type": "python",
                        "value": "file://asserts/check.py",
                        "metric": "plan-review",
                    }
                ],
            }
        )
    if not tests:
        raise SystemExit("no cases under optimizing-writing-plans/cases/")
    return tests
