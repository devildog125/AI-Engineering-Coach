---
id: no-language-exploration
name: No Language Exploration
group: code-review
severity: low
scope: requests
version: 1
tags: [review, languages, exploration]
thresholds:
  minSample: 10
  minWeeks: 4
  recentWeeks: 8
---

# Description
Detects when no new programming languages have been explored recently, despite AI being a learning accelerator.

# When Triggered
You've used {{extra.totalLanguages}} languages total, but haven't explored a new one in {{count}} weeks. AI is a learning accelerator -- use it to try new languages and frameworks.

# How to Improve
AI coding assistants dramatically lower the barrier to learning new languages. Try asking Copilot to help you build something small in a language you haven't used before. Start with "Write a simple HTTP server in [Go/Rust/Elixir]" to break the ice.

# How to Improve (Claude Code)
AI coding assistants dramatically lower the barrier to learning new languages. Try asking Claude to build something small in a language you haven't used before, such as "Write a simple HTTP server in Go".

# Examples
{{extra.languageList}}

# Detection Logic
```detect
scan: requests
match: timestamp > 0
aggregate: count
lang: langExplorationWeeks(allReqs)
emitCount: lang.weeksSinceNew
emitTotal: lang.totalWeeks
totalLanguages: lang.totalLangs
check: lang.recentNew == 0 AND lang.totalWeeks >= thresholds.minWeeks
severity: lang.weeksSinceNew > 12
```
