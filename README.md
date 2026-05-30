# claude-skills

Bartek's personal [Claude Code](https://docs.claude.com/en/docs/claude-code) skills, packaged as a plugin marketplace.

## Install

```
/plugin marketplace add bartekbp/claude-skills
/plugin install plan-tools@bartek-skills
```

(`bartekbp/claude-skills` resolves to this private repo; Claude Code clones it over your authenticated GitHub access.)

## Plugins

### plan-tools

| Skill | Triggers on |
|-------|-------------|
| `tightening-plans` | Right after the `superpowers:writing-plans` skill produces an implementation plan, or when you ask to shorten / condense / parallelize an existing plan. Merges trivial tasks and annotates parallelism, without dropping scope or executable detail. |

## Layout

```
.claude-plugin/marketplace.json     # marketplace manifest
plugins/
  plan-tools/
    .claude-plugin/plugin.json       # plugin manifest
    skills/
      tightening-plans/SKILL.md      # skill
```

## Adding a skill

1. Create `plugins/<plugin>/skills/<skill-name>/SKILL.md` with `name` + `description` frontmatter.
2. Commit and push.
3. In Claude Code: `/plugin marketplace update bartek-skills` to pull the latest.
