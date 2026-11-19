---
id: no-plan-mode
name: Never Uses Plan Mode
group: tool-mastery
severity: medium
scope: requests
requiresIdeContext: true
harnesses: [Claude]
version: 1
tags: [tools, planning, agent]
thresholds:
  minReqs: 30
  agentRate: 0.3
---

# Description
Detects heavy agentic usage with no use of plan mode, which helps the agent understand scope before implementation.

# When Triggered
{{extra.agenticReqs}} agentic requests but no use of plan mode. Jumping straight to implementation often leads to wrong approaches.

# How to Improve
Use plan mode (or /plan) before complex tasks. Planning helps the agent understand scope, break down work, and avoid wasted iterations.

# How to Improve (Claude Code)
Press Shift+Tab to switch to plan mode before complex tasks: Claude researches and proposes a plan you approve before it edits anything.

# Examples
Switch to Plan mode in the mode picker before starting large features
Use /plan to outline an approach before coding
Plan first, then switch to Agent mode to execute

# Detection Logic
```detect
scan: requests
match: agentMode == "agent" OR agentName != ""
aggregate: count
agentRatio: count / total
planUsage: someWhere(all, "slashCommand", "plan") OR \
  someWhere(all, "agentMode", "matches", "(?i)plan")
agenticReqs: count
check: planUsage == 0 AND total >= thresholds.minReqs AND agentRatio >= thresholds.agentRate
```
