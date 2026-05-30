# claude-skills

[Claude Code](https://docs.claude.com/en/docs/claude-code) skills, packaged as a plugin marketplace.

## Install

```
/plugin marketplace add bartekbp/claude-skills
/plugin install brainstorming-tools@bartekbp
/plugin install pr-tools@bartekbp
```

(`bartekbp/claude-skills` resolves to this repo; Claude Code clones it over your authenticated GitHub access. `bartekbp` after the `@` is the marketplace name, not the install target.)

## Staying up to date

Third-party marketplaces do **not** auto-update by default. To pull the latest skills, either run:

```
/plugin marketplace update bartekbp
```

…or enable auto-update so Claude Code refreshes this marketplace and its installed plugins at startup. Add it to your user `settings.json` (or a project `.claude/settings.json` to enable it for the whole team):

```json
{
  "extraKnownMarketplaces": {
    "bartekbp": {
      "source": {
        "source": "github",
        "repo": "bartekbp/claude-skills"
      },
      "autoUpdate": true
    }
  }
}
```

You can also toggle auto-update per marketplace from the `/plugin` UI (Marketplaces tab).

## Plugins

### brainstorming-tools

| Skill | Triggers on |
|-------|-------------|
| `optimizing-writing-plans` | Immediately after the `superpowers:writing-plans` skill produces an implementation plan. An independent second-pass review that checks the plan against its spec across four lenses (soundness, completeness, executability, brevity + parallelism) and applies the safe fixes in place, flagging judgment calls. |

### pr-tools

| Skill | Triggers on |
|-------|-------------|
| `simplify-pr` | A PR mixes a substantive change with mechanical review noise — a mass formatter/linter pass or import-path-only edits from moving files. Marks the noise-only files as "Viewed" via the GitHub GraphQL API so they collapse by default, leaving only the real-change files expanded. |

## Layout

```
.claude-plugin/marketplace.json     # marketplace manifest (name: bartekbp)
plugins/
  brainstorming-tools/
    .claude-plugin/plugin.json       # plugin manifest
    skills/
      optimizing-writing-plans/SKILL.md  # skill
  pr-tools/
    .claude-plugin/plugin.json
    skills/
      simplify-pr/SKILL.md
```

## Adding a skill

1. Create `plugins/<plugin>/skills/<skill-name>/SKILL.md` with `name` + `description` frontmatter.
2. Commit and push.
3. In Claude Code: `/plugin marketplace update bartekbp` to pull the latest.
