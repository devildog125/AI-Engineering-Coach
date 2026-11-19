---
id: high-cancellation
name: Excessive Cancellations
group: session-hygiene
severity: medium
scope: requests
version: 1
tags: [session, cancellation, waste]
thresholds:
  maxCancelRate: 0.15
  highSeverityRate: 0.3
---

# Description
Detects a high rate of cancelled requests, which wastes premium quota and indicates unclear prompting.

# When Triggered
{{count}} of {{total}} requests cancelled ({{pct}}). This wastes premium quota.

# How to Improve
Write clearer, more specific prompts. Wait for responses instead of cancelling prematurely.

# How to Improve (Claude Code)
If you often press Esc, give Claude the goal, constraints and relevant `@files` up front, or start in plan mode (Shift+Tab) to agree on the approach before it edits.

# Examples
"{{message}}..."

# Detection Logic
```detect
scan: requests
match: isCanceled == true
aggregate: ratio
check: ratio > thresholds.maxCancelRate
examples: "{{messageText | clip:80}}"
```
