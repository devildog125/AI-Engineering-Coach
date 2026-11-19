---
id: excessive-file-context
name: Excessive File Context
group: prompt-quality
severity: medium
scope: requests
version: 1
tags: [context, files, tokens, cost]
thresholds:
  minFiles: 30
  minOutliers: 10
  maxRatio: 0.005
---

# Description
Detects outlier requests that attach a very large number of files to the prompt. Each referenced file expands the input context — and the agent rarely reads all of them. Bulk-attaching files is a common pattern when the user isn't sure which files are relevant; it works, but pays for context that's mostly never used.

# When Triggered
{{count}} request(s) attached ≥{{thresholds.minFiles}} files to the prompt (largest: {{extra.maxFiles}} files). The model only reads a fraction of large attachments — the rest is paid-for context that contributes nothing.

# How to Improve
Be selective: attach only the 3–5 files most relevant to the task. Use `#codebase` or `#file:<glob>` patterns to let the model search on demand. For exploration tasks, ask the agent to `grep` first and read results into context only as needed.

# How to Improve (Claude Code)
Mention only the 3–5 files that matter with `@path`. Let Claude find the rest with Grep and Glob, and hand broad exploration to an Explore subagent so its reads stay out of your main context.

# Examples
{{length(referencedFiles)}} files: "{{messageText | truncate:60}}"

# Detection Logic
```detect
scan: requests
match: length(referencedFiles) >= thresholds.minFiles
aggregate: ratio
stats: excessFileContextStats(allReqs, thresholds.minFiles)
maxFiles: stats.maxFiles
p95Files: stats.p95Files
emitCount: stats.outlierCount
emitTotal: stats.totalReqs
check: stats.outlierCount >= thresholds.minOutliers AND stats.ratio >= thresholds.maxRatio
examples: {{length(referencedFiles)}} files: "{{messageText | truncate:60}}"
```
