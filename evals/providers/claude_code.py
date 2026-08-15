"""promptfoo provider that answers through the Claude Code CLI.

Adapted from the claude-marketplace evals harness. One arm = one provider
entry, differing only in `config`. The arm's `system_file` becomes the system
prompt; promptfoo's rendered prompt becomes the user message.

Every call is isolated from this machine's Claude Code setup, because
otherwise the eval measures the operator rather than the skill:

  CLAUDE_CONFIG_DIR   a directory holding credentials and nothing else — no
                      settings.json, so no hooks, and no user CLAUDE.md
  cwd                 the case's synthetic repo (vars.repo_dir), because that
                      is where the skill runs for real
  --strict-mcp-config with an empty server map, so no MCP server boots
  --disallowed-tools  Write/Edit (nothing here should modify the repo) and
                      the web tools

What differs from the marketplace version:

  vars.repo_dir       each test case carries its own repo; cwd is per-call,
                      not a fixed checkout
  stub_path           a directory prepended to PATH so the agent's `gh` is
                      the eval's GitHub stub, never the real CLI
  GH_STUB_STATE       a fresh temp file per call, so arms, cases and repeats
                      never see each other's viewed marks
  state trailer       after the call the provider appends the stub's state as
                      `<gh-stub-state>{...}</gh-stub-state>` to the output, so
                      the assert grades what actually persisted rather than
                      what the answer claims
  announce_base_dir   appends "Base directory for this skill: <dir>" to the
                      system prompt, mirroring what the Skill tool tells a
                      real session — without it the skill cannot find its
                      helper script

Set up the config dir once (symlink, NEVER copy — OAuth refresh tokens
rotate, and a copied token and the real session invalidate each other):

    mkdir -p ~/.claude-eval && chmod 700 ~/.claude-eval
    ln -s ~/.claude/.credentials.json ~/.claude-eval/.credentials.json

`claude` must be on PATH and logged in.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
from functools import lru_cache
from pathlib import Path

HERE = Path(__file__).resolve().parent
EVAL_HOME = Path(os.environ.get("CLAUDE_EVAL_HOME", Path.home() / ".claude-eval"))
TIMEOUT_S = int(os.environ.get("CLAUDE_EVAL_TIMEOUT", "1200"))

ISOLATE = [
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    # Bash/Read/Grep/Glob are pre-approved — the skill's whole job is running a
    # helper script and gh against a checkout, and a headless `-p` session
    # cannot answer a permission prompt: without the grant the agent stalls and
    # asks for approval nobody can give. Write/Edit are blocked: marking files
    # viewed has no business changing the repo.
    "--allowedTools",
    "Bash",
    "Read",
    "Grep",
    "Glob",
    "--disallowed-tools",
    "Write",
    "Edit",
    "WebFetch",
    "WebSearch",
]


@lru_cache(maxsize=1)
def cli_version() -> str:
    try:
        done = subprocess.run(
            ["claude", "--version"], capture_output=True, text=True, timeout=30
        )
        return done.stdout.strip() or "unknown"
    except Exception:
        return "unknown"


def _preflight() -> str | None:
    creds = EVAL_HOME / ".credentials.json"
    if not creds.exists():
        return (
            f"no credentials at {creds} — create the eval config dir:\n"
            f"  mkdir -p {EVAL_HOME} && chmod 700 {EVAL_HOME}\n"
            f"  ln -s ~/.claude/.credentials.json {creds}\n"
            "Symlink, never copy: a copied OAuth token refreshes itself and "
            "invalidates the original. Credentials only — a settings.json here "
            "would put this machine's hooks back into every answer."
        )
    if not creds.is_symlink():
        return (
            f"{creds} is a copy. Replace it with a symlink to "
            "~/.claude/.credentials.json: OAuth refresh tokens rotate, so a copy "
            "and the real session invalidate each other part-way through a run."
        )
    try:
        oauth = json.loads(creds.read_text()).get("claudeAiOauth", {})
        expires_ms = oauth.get("expiresAt")
    except Exception:
        expires_ms = None
    if expires_ms and expires_ms / 1000 < time.time():
        return (
            "the Claude OAuth token has expired — run any `claude` command "
            "interactively to refresh it, then start the eval again"
        )
    return None


def call_api(prompt: str, options: dict, context: dict) -> dict:
    problem = _preflight()
    if problem:
        return {"error": problem}

    config = options.get("config") or {}
    for required in ("system_file", "model", "effort"):
        if not config.get(required):
            return {
                "error": f"provider config needs `{required}` — pin it so the "
                "snapshot records what produced it"
            }

    repo_dir = (context.get("vars") or {}).get("repo_dir")
    if not repo_dir or not Path(repo_dir).is_dir():
        return {"error": f"vars.repo_dir missing or not a directory: {repo_dir!r}"}

    system_path = (HERE.parent / config["system_file"]).resolve()
    if not system_path.exists():
        return {"error": f"system_file not found: {system_path}"}
    system_prompt = system_path.read_text()
    if config.get("announce_base_dir"):
        system_prompt += f"\n\nBase directory for this skill: {system_path.parent}"

    stub_dir = (HERE.parent / config.get("stub_path", "simplify-pr/bin")).resolve()
    if not (stub_dir / "gh").exists():
        return {"error": f"gh stub not found in {stub_dir}"}

    model = os.environ.get("SKILL_EVAL_MODEL") or config["model"]
    effort = os.environ.get("SKILL_EVAL_EFFORT") or config["effort"]

    cmd = [
        "claude",
        "-p",
        "--output-format",
        "json",
        *ISOLATE,
        "--model",
        model,
        "--effort",
        effort,
        "--system-prompt",
        system_prompt,
    ]

    # Each call gets its own copy of the repo. Write/Edit are blocked but Bash
    # is not, and the first baseline's control arm rewrote the shared checkout's
    # `pr` branch (amended the noise away) — with arms running concurrently
    # against one .work/<id>, that mutates another arm's ground truth mid-run.
    scratch = Path(tempfile.mkdtemp(prefix="simplify-eval-"))
    call_repo = scratch / "repo"
    shutil.copytree(repo_dir, call_repo, symlinks=True)
    state_file = scratch / "state.json"
    env = {
        **os.environ,
        "CLAUDE_CONFIG_DIR": str(EVAL_HOME),
        "PATH": f"{stub_dir}:{os.environ.get('PATH', '')}",
        "GH_STUB_STATE": str(state_file),
    }
    try:
        done = subprocess.run(
            cmd,
            input=prompt,
            capture_output=True,
            text=True,
            timeout=TIMEOUT_S,
            cwd=str(call_repo),
            env=env,
        )
    except subprocess.TimeoutExpired:
        shutil.rmtree(scratch, ignore_errors=True)
        return {"error": f"claude did not answer within {TIMEOUT_S}s"}

    if done.returncode != 0:
        shutil.rmtree(scratch, ignore_errors=True)
        return {"error": f"claude exited {done.returncode}: {done.stderr[:400]}"}

    text, turns, cost = done.stdout.strip(), None, None
    try:
        envelope = json.loads(done.stdout)
        text = (envelope.get("result") or "").strip() or text
        turns = envelope.get("num_turns")
        cost = envelope.get("total_cost_usd")
    except Exception:
        pass

    # What persisted in the stub is the ground truth the assert grades; an
    # untouched state file means the agent never issued a mutation.
    try:
        state = json.loads(state_file.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        state = {"viewed": [], "requests": []}
    shutil.rmtree(scratch, ignore_errors=True)
    text += f"\n\n<gh-stub-state>{json.dumps(state)}</gh-stub-state>"

    return {
        "output": text,
        "metadata": {
            "num_turns": turns,
            "cost_usd": cost,
            "model": model,
            "effort": effort,
            "cli_version": cli_version(),
            "gh_stub_state": state,
        },
    }
