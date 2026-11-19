---
id: auto-avoidance
name: Auto Model Avoidance
group: tool-mastery
severity: medium
scope: requests
version: 1
tags: [model, auto, routing, cost]
thresholds:
  minTopShare: 0.6
  minSample: 30
---

# Description
Detects users who pin a single premium model for every request and never let auto-routing pick a cheaper model when one would suffice. Auto routing handles many requests with smaller models for the same outcome.

# When Triggered
{{pct}} of requests use {{extra.topModel}} (a premium model) and no requests use auto routing. Pinning a top-tier model for every task overpays on simple work.

# How to Improve
Switch the default to "auto" or use the model picker. Reserve specific top-tier models (Claude Opus, GPT-5) for hard reasoning, planning, or large-context tasks. For routine edits and questions, the lighter model auto picks is usually enough.

# How to Improve (Claude Code)
Claude Code has no auto model, so pick one per task with `/model`: Sonnet for routine edits and questions, Opus or Fable for hard reasoning and large-context work.

# Examples
{{extra.topModel}}: {{extra.topCount}} requests ({{pct}})

# Detection Logic
```detect
scan: requests
match: modelId != ""
aggregate: count
models: modelStats(matched)
topModel: models.topModel
topCount: models.topCount
hasAutoUsage: countWhere(matched, "modelId", "matches", "(?i)auto")
emitCount: models.topCount
emitTotal: models.total
check: models.topShare > thresholds.minTopShare AND modelTier(models.topModel) >= 1 AND hasAutoUsage == 0 AND models.total > thresholds.minSample
```
