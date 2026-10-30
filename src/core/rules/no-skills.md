---
id: no-skills
name: No Skills Usage
group: tool-mastery
severity: low
scope: requests
requiresIdeContext: true
harnesses: [Claude]
version: 1
tags: [tools, skills, domain]
thresholds:
  minReqs: 50
---

# Description
Detects when no requests use Copilot skills, missing out on specialized domain knowledge.

# When Triggered
No requests use Copilot skills. Skills provide specialized domain knowledge beyond general coding.

# How to Improve
Explore available skills in your IDE. Skills can help with specific frameworks, cloud providers, and development workflows.

# Examples
Skills extend Copilot with domain expertise
Check VS Code extensions for available skills

# Detection Logic
```detect
scan: requests
match: skillsUsed.length == 0
aggregate: count
check: count == total AND total > thresholds.minReqs
```
