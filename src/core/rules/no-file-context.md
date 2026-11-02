---
id: no-file-context
name: Missing File Context
group: prompt-quality
severity: medium
scope: requests
requiresIdeContext: true
harnesses: [Claude]
version: 1
tags: [prompt, context, files]
thresholds:
  maxNoContextRate: 0.7
  minSample: 10
---

# Description
Detects requests that have no file references, meaning Copilot cannot see the relevant code context.

# When Triggered
{{pct}} of requests have no file references. Copilot gives better answers with file context.

# How to Improve
Use #file to reference relevant files, or open files in the editor so Copilot can use them as context.

# How to Improve (Claude Code)
Mention relevant files with `@path/to/file` (Tab completes paths) so Claude starts from the right code instead of searching for it.

# Examples
"{{message}}..."

# Detection Logic
```detect
scan: requests
match: referencedFiles.length == 0 AND editedFiles.length == 0
aggregate: ratio
check: ratio > thresholds.maxNoContextRate AND count > thresholds.minSample
examples: "{{messageText | clip:80}}"
```
