---
id: no-slash-commands
name: No Slash Commands
group: tool-mastery
severity: low
scope: requests
requiresIdeContext: true
harnesses: [Claude]
version: 1
tags: [tools, slash, commands]
thresholds:
  minRate: 0.02
  minReqs: 20
---

# Description
Detects low usage of slash commands, which produce more targeted responses than freeform prompts.

# When Triggered
Only {{extra.withSlash}} of {{total}} requests use slash commands. Slash commands produce more targeted responses.

# How to Improve
Try /fix for bugs, /explain for understanding code, /tests for test generation, /doc for documentation.

# How to Improve (Claude Code)
Try `/init` (CLAUDE.md), `/review`, `/compact`, `/context` and `/model`. Save prompts you repeat as custom commands or skills in `.claude/commands/` or `.claude/skills/`.

# Examples
/fix - Fix bugs in selected code
/explain - Explain how code works
/tests - Generate unit tests

# Detection Logic
```detect
scan: requests
match: slashCommand == ""
aggregate: count
usageRate: (total - count) / total
withSlash: total - count
check: usageRate < thresholds.minRate AND total > thresholds.minReqs
```
