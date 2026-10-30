---
id: abandon-sessions
name: Abandoned Sessions
group: session-hygiene
severity: low
scope: sessions
version: 1
tags: [session, abandoned, single]
thresholds:
  maxAbandonRate: 0.4
  minSample: 10
---

# Description
Detects sessions with only a single message, indicating missed refinement opportunities.

# When Triggered
{{count}} sessions ({{pct}}) have only 1 message. You may be missing refinement opportunities.

# How to Improve
Use follow-up messages to refine Copilot's responses. Iterating produces much better results than one-shot prompts.

# How to Improve (Claude Code)
Reply in the same session to refine Claude's work instead of starting over. Press Esc to stop and redirect, and use `claude --continue` or `/resume` to pick an earlier session back up.

# Examples
{{extra.workspace}}: "{{message}}..."

# Detection Logic
```detect
scan: sessions
match: requestCount == 1
aggregate: ratio
check: ratio > thresholds.maxAbandonRate AND count > thresholds.minSample
examples: {{workspaceName}}: abandoned after 1 message
```
