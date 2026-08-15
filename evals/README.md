# Evals

Behavioural evals for skills in this repo, on [promptfoo](https://promptfoo.dev). Modeled on the
claude-marketplace evals harness, but self-contained: nothing here runs in CI, nothing ships, and
`plugins/` never references `evals/`.

## The idea

A skill is instructions, and instructions can be too long, wrong, or have no effect at all. None of
that is visible by reading them. So: give the skill a scenario whose correct outcome is known, and
check whether what it *did* matches.

Unlike the marketplace suites (vendored real documents, labels from what actually shipped), the
suites here use **artificial scenarios**: synthetic git repos built by fixture scripts, with labels
true by construction. That trades ecological validity for a label nobody has to argue with — the
fixture builder decides which diffs are mechanical noise by generating them that way.

## Setup, once

The provider shells out to the `claude` CLI, and every call must be isolated from this machine's
Claude Code setup — otherwise the eval measures the operator (a `SessionStart` hook rewriting every
answer is not hypothetical; it is what the first version of the marketplace harness accidentally
measured).

```bash
mkdir -p ~/.claude-eval && chmod 700 ~/.claude-eval
ln -s ~/.claude/.credentials.json ~/.claude-eval/.credentials.json
```

Credentials and nothing else — no `settings.json` (hooks would come back), no installed plugins
(the control arm must not be able to load the skill under test).

**Symlink, never copy.** OAuth refresh tokens rotate: a copied token refreshes itself, invalidates
the original, and both sessions die mid-run. The provider refuses to start on a copied file and on
an expired token.

## Running a suite

One directory per skill, self-contained. Run from the suite's own directory:

```bash
cd evals/simplify-pr
npx promptfoo@latest eval --filter-providers '^skill$' -j 4 --no-cache
npx promptfoo@latest view        # results in the browser
```

Discipline carried over from the marketplace harness, still true here:

- **Pass `--no-cache` after changing the skill.** promptfoo keys its cache on provider config and
  prompt, neither of which mentions `SKILL.md`; an edited skill otherwise replays old answers.
- **A full run is a one-shot**, not something to repeat until the numbers look good. Each call is a
  whole Claude Code session. Re-running an unchanged config mostly replays the cache; it is useful
  only to resume a killed run.
- **Spend calls on cases, not repeats.** Reach for `--repeat 3` only when a result is surprising
  and you need to know whether it repeats.
- **Env overrides** `SKILL_EVAL_MODEL` / `SKILL_EVAL_EFFORT` exist for a cheap plumbing pass
  (haiku/low). Never record a baseline from an override run.

## Layout

```
evals/
  providers/claude_code.py     the harness, shared by every suite
  simplify-pr/                 promptfooconfig.yaml, cases.py, asserts/, bin/gh (GitHub stub),
                               fixtures/, cases/, tests/run-helper.sh, baseline.md, README.md
  optimizing-writing-plans/    seeded-defect spec+plan fixtures, judge-free artifact grading
```

Only the provider is shared. Each suite decides its own label shape, metrics and prompt.
