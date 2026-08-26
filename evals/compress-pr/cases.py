"""Build each synthetic PR repo and turn cases/<id>/case.json into promptfoo
tests.

Repos are rebuilt into .work/<id> on every test generation. The builders pin
git identity and dates, so a rebuild is byte-identical and promptfoo's cache
(keyed on prompt + vars, which include the repo path) stays valid.

The label is authored, not judged: each case.json lists which files are
mechanical noise and which are substantive, and the fixture builders construct
the repos to make those labels true by construction (the noise diffs really
are reproduced by scripts/format.sh, the substantive diffs really are not).
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORK = HERE / ".work"


def generate_tests() -> list[dict]:
    tests = []
    for case_file in sorted((HERE / "cases").glob("*/case.json")):
        case = json.loads(case_file.read_text())
        repo_dir = WORK / case["id"]
        subprocess.run(
            ["bash", str(case_file.parent / "build.sh"), str(repo_dir)],
            check=True,
            capture_output=True,
            text=True,
        )
        tests.append(
            {
                "description": f"{case['id']} — {len(case['noise'])} noise, "
                f"{len(case['substantive'])} substantive",
                "vars": {
                    "repo_dir": str(repo_dir),
                    "repo_slug": "acme/webapp",
                    "fix_cmd": case["fix_cmd"],
                    # JSON, not a dict: promptfoo expands structured vars in
                    # surprising ways; a string round-trips untouched.
                    "expected": json.dumps(
                        {"noise": case["noise"], "substantive": case["substantive"]}
                    ),
                },
                "assert": [
                    {
                        "type": "python",
                        "value": "file://asserts/check.py",
                        "metric": "compress",
                    }
                ],
            }
        )
    if not tests:
        raise SystemExit("no cases under compress-pr/cases/")
    return tests
