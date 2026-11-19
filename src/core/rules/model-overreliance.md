---
id: model-overreliance
name: Model Overreliance
group: tool-mastery
severity: medium
scope: requests
version: 1
tags: [tools, model, diversity]
thresholds:
  maxTopModelRate: 0.8
  minSample: 10
  minModels: 3
---

# Description
Detects when the vast majority of requests use a single model, missing opportunities to use lighter models for simple tasks.

# When Triggered
{{pct}} of requests use {{extra.topModel}}. Different tasks benefit from different models.

# How to Improve
Use lighter models (gpt-4.1-mini, gemini-flash) for simple tasks to save premium quota and get faster responses.

# How to Improve (Claude Code)
Switch models per task with `/model`: Haiku or Sonnet for quick edits and questions, Opus or Fable for hard reasoning. Subagents can run on a lighter model too.

# Examples
{{extra.model}}: {{extra.reqCount}} requests

# Detection Logic
```detect
scan: requests
match: true
aggregate: count
models: modelStats(allReqs)
emitCount: models.topCount
emitTotal: models.total
topModel: models.topModel
check: models.topShare > thresholds.maxTopModelRate AND models.modelCount < thresholds.minModels AND models.total > thresholds.minSample
```
