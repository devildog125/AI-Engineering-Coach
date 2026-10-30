---
id: no-custom-instructions
name: No Custom Instructions
group: tool-mastery
severity: medium
scope: requests
requiresIdeContext: true
harnesses: [Claude]
version: 1
tags: [tools, instructions, personalization]
thresholds:
  minRate: 0.05
  minReqs: 20
---

# Description
Detects when very few requests use custom instructions, missing out on personalized and project-specific responses.

# When Triggered
Only {{extra.usagePct}}% of requests use custom instructions ({{extra.withInstructions}}/{{total}}). Missing out on personalized responses.

# How to Improve
Create a .github/copilot-instructions.md or .instructions.md file in your workspace to give Copilot persistent context about your project conventions, stack, and coding style.

# Examples
{{extra.withInstructions}} of {{total}} requests had custom instructions

# Detection Logic
```detect
scan: requests
match: customInstructions.length == 0
aggregate: count
usageRate: (total - count) / total
withInstructions: total - count
usagePct: round(usageRate * 100)
check: usageRate < thresholds.minRate AND total > thresholds.minReqs
```
