"""Grade a compress-pr run against the authored file labels.

No LLM judge: the ground truth is which files ended up VIEWED in the gh stub's
persisted state, which the provider appends to the output as a
<gh-stub-state> trailer. The answer's prose is not graded at all — a run that
claims success while the throttle dropped its marks scores what actually
persisted, which is the point.

Two metrics, never blended into one:

  collapsed   of the noise files, how many are VIEWED. Recall of the cleanup.
  spared      of the substantive files, how many were LEFT ALONE. The guard —
              marking a real change viewed hides it from review, which is
              strictly worse than doing nothing.

The clean-pr case has no noise, so its score is spared alone: the only way to
score there is to mark nothing.

The stub's request log rides along in the reason line: `aliases=[...]` shows
whether marks went up in one batched mutation or a per-file loop, and
`dropped=N` how many requests the simulated throttle discarded. A low
`collapsed` with a long dropped tail is the rate-limit trap, not a
classification failure.
"""

from __future__ import annotations

import json
import re


def get_assert(output, context):
    expected = context["vars"]["expected"]
    if isinstance(expected, str):
        expected = json.loads(expected)
    noise = set(expected["noise"])
    substantive = set(expected["substantive"])

    m = re.search(r"<gh-stub-state>(.*?)</gh-stub-state>", output, re.S)
    state = json.loads(m.group(1)) if m else {"viewed": [], "requests": []}
    viewed = set(state.get("viewed") or [])
    requests = state.get("requests") or []

    collapsed = len(viewed & noise) / len(noise) if noise else None
    bad = sorted(viewed & substantive)
    spared = 1.0 - len(bad) / len(substantive) if substantive else 1.0

    score = spared if collapsed is None else (collapsed + spared) / 2

    missed = sorted(noise - viewed)
    aliases = [r.get("aliases") for r in requests]
    dropped = sum(1 for r in requests if not r.get("persisted"))
    parts = []
    if collapsed is not None:
        parts.append(f"collapsed {len(viewed & noise)}/{len(noise)}")
        if missed:
            parts.append(f"missed: {', '.join(missed)}")
    else:
        parts.append(f"nothing to collapse; {len(viewed)} file(s) marked")
    parts.append(f"substantive marked: {', '.join(bad) if bad else 'none'}")
    parts.append(f"requests aliases={aliases} dropped={dropped}")

    components = [
        {
            "pass": spared == 1.0,
            "score": spared,
            "reason": f"{len(bad)} substantive file(s) marked viewed",
            "assertion": {"type": "python", "metric": "spared"},
        }
    ]
    if collapsed is not None:
        components.append(
            {
                "pass": collapsed == 1.0,
                "score": collapsed,
                "reason": f"{len(viewed & noise)}/{len(noise)} noise files collapsed",
                "assertion": {"type": "python", "metric": "collapsed"},
            }
        )

    return {
        "pass": score >= 0.99,
        "score": score,
        "reason": "; ".join(parts),
        "componentResults": components,
    }
