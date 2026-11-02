---
id: tunnel-vision
name: Single-Workspace Tunnel Vision
group: code-review
severity: low
scope: sessions
version: 1
tags: [review, workspace, diversity]
thresholds:
  maxTopRate: 0.95
  minReqs: 50
  minWorkspaces: 3
---

# Description
Detects when the vast majority of requests are concentrated in a single workspace, missing opportunities to use AI across projects.

# When Triggered
{{pct}} of all requests ({{count}}/{{total}}) are in "{{extra.topWorkspace}}". Copilot can help across all your projects.

# How to Improve
Try using Copilot in other workspaces too. It can help with documentation, testing, DevOps, and exploratory coding across your entire workflow.

# How to Improve (Claude Code)
Try Claude Code in other repositories too. It can help with documentation, testing, DevOps and exploratory coding across your whole workflow.

# Examples
{{extra.workspace}}: {{extra.reqCount}} requests ({{extra.reqPct}}%)

# Detection Logic
```detect
scan: sessions
match: true
aggregate: count
top: groupTopBySum(allSessions, "workspaceName", "requestCount")
reqTotal: sumField(allSessions, "requestCount")
emitCount: top.sum
emitTotal: reqTotal
topWorkspace: top.key
check: top.share > thresholds.maxTopRate AND top.sum >= thresholds.minReqs AND top.count >= thresholds.minWorkspaces
```
