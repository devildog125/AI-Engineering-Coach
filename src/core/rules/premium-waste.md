---
id: premium-waste
name: Premium Model Waste
group: tool-mastery
severity: medium
scope: requests
version: 1
tags: [tools, model, waste, premium]
thresholds:
  minSample: 10
  maxMessageLength: 50
---

# Description
Detects simple requests (short prompt, no code output) that use premium models unnecessarily.

# When Triggered
{{count}} simple requests (short prompt, no code output) used premium models.

# How to Improve
Use lighter models for quick questions and simple tasks. Reserve premium models for complex code generation.

# How to Improve (Claude Code)
Use `/model` to drop to Sonnet or Haiku for quick questions and simple edits, and keep Opus or Fable for complex work.

# Examples
{{extra.model}}: "{{message}}..."

# Detection Logic
```detect
scan: requests
match: modelTier(modelId) >= 1 AND messageLength < thresholds.maxMessageLength AND messageLength > 0 AND aiCode.length == 0
aggregate: count
check: count > thresholds.minSample
examples: {{normalizeModel(modelId)}}: "{{messageText | truncate:50}}"
```
