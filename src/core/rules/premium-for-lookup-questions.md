---
id: premium-for-lookup-questions
name: Premium Model for Lookup Questions
group: tool-mastery
severity: medium
scope: requests
version: 1
tags: [model, lookup, ask, cost]
thresholds:
  minSample: 10
  maxRatio: 0.1
  maxMessageLength: 120
---

# Description
Detects "lookup-style" questions ("what is X?", "where is Y?", "how do I Z?", "explain Y") that get routed to a premium model. These factual one-shot questions rarely need top-tier reasoning — `auto` or a base model usually returns the same answer for a fraction of the cost.

# When Triggered
{{count}} lookup-style questions ({{pct}}) used a premium model. Short factual questions almost never benefit from premium reasoning — they overpay on every request.

# How to Improve
Switch the default model to `auto` so lightweight questions are routed cheaply. Reserve premium models for tasks that need actual reasoning: planning, debugging, multi-step refactors. Custom-instruct your IDE to "use the cheapest model that can answer this" for short prompts.

# How to Improve (Claude Code)
Claude Code has no automatic model router: switch to Sonnet or Haiku with `/model` for quick lookups, and keep Opus or Fable for planning, debugging and multi-step refactors.

# Examples
{{normalizeModel(modelId)}}: "{{messageText | truncate:60}}"

# Detection Logic
```detect
scan: requests
match: modelTier(modelId) >= 1 AND messageLength > 0 AND messageLength < thresholds.maxMessageLength AND length(aiCode) == 0 AND length(toolsUsed) == 0 AND matches(messageText, "(?i)^\\s*(what(?:'s| is| are)|where(?:'s| is| are)|how do (?:i|you)|explain|why (?:does|is|are)|when (?:should|do)|which|tell me about|define)\\b")
aggregate: ratio
check: ratio > thresholds.maxRatio AND count > thresholds.minSample
examples: {{normalizeModel(modelId)}}: "{{messageText | truncate:60}}"
```
