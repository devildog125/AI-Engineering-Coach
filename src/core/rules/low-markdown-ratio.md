---
id: low-markdown-ratio
name: Low Markdown Output Ratio
group: prompt-quality
severity: medium
scope: sessions
version: 1
tags: [prompt, markdown, documentation]
thresholds:
  markdownRatio: 0.05
  minTotalLoc: 100
  minWorkspaces: 1
fileTypes:
  documentation: [markdown, md, mdx, txt, rst, adoc]
patterns:
  docFileExtensions: [md, mdx, txt, rst, adoc]
---

# Description
Detects workspaces that produce almost no markdown output, suggesting specs, plans, and documentation are skipped before coding.

# When Triggered
{{count}} workspace(s) produce almost no markdown ({{extra.overallPct}}% of AI output). {{extra.totalCodeLoc}} LoC of code vs {{extra.totalMdLoc}} LoC of markdown. This suggests you skip writing specs, plans, and documentation before coding.

# How to Improve
Adopt spec-driven development: ask Copilot to draft a spec, plan, or design doc before writing code. Even a short markdown outline dramatically improves code quality and reduces iteration cycles. Try starting sessions with "Write a brief spec for..." or "Draft an implementation plan for...".

# How to Improve (Claude Code)
Start bigger tasks in plan mode (Shift+Tab) so Claude writes a plan you approve before any code, or ask it to draft a short spec file first.

# Examples
{{extra.workspace}}: {{extra.codeLoc}} code LoC, {{extra.mdLoc}} markdown LoC ({{extra.ratioPct}}%)

# Detection Logic
```detect
scan: sessions
match: true
aggregate: count
md: mdRatioByWorkspace(allSessions, thresholds.minTotalLoc, ["markdown", "md"])
emitCount: md.lowCount
emitTotal: md.totalWorkspaces
overallPct: round(md.overallRatio * 100)
totalCodeLoc: md.totalCodeLoc
totalMdLoc: md.totalMdLoc
workspaces: md.workspaces
check: md.lowCount >= thresholds.minWorkspaces
severity: md.overallRatio < 0.02
```
