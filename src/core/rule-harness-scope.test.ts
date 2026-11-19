/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* IDE-context rules judge only the harnesses they apply to: IDE harnesses plus
 * any listed in `harnesses:`. Guards the "All harnesses" view against Copilot-only
 * rules counting Claude requests. */

import { describe, it, expect } from 'vitest';
import { parseRule, serializeRule, suggestionTemplateFor } from './rule-parser';
import { executePipeline, parsePipeline } from './rule-pipeline';
import { createRequest, createSession } from './parser-shared';

/** Minimal IDE rule that matches every request; `extra` adds frontmatter lines. */
function ideRule(extra = ''): NonNullable<ReturnType<typeof parseRule>> {
  const rule = parseRule(`---
id: scope-test
name: Scope test
group: tool-mastery
severity: low
scope: requests
requiresIdeContext: true
${extra}version: 1
---

# Description
Test rule.

# Detection Logic
\`\`\`detect
scan: requests
match: true
aggregate: count
check: count > 0
\`\`\`
`);
  expect(rule).not.toBeNull();                                     // Fixture must parse.
  return rule!;
}

/** One session per harness, one request each. */
const sessions = ['Local Agent', 'Claude', 'Codex'].map((harness, i) => createSession({
  sessionId: `s${i}`, workspaceId: 'ws', workspaceName: 'ws', harness,
  requests: [createRequest({ requestId: `r${i}`, messageText: 'm', responseText: 'r' })],
}));
const ctx = { reqs: sessions.flatMap(s => s.requests), sessions, skipIdeDetectors: false };

describe('IDE rule harness scoping', () => {
  it('counts only IDE-harness requests by default', () => {
    const rule = ideRule();
    expect(executePipeline(parsePipeline(rule), rule, ctx).total).toBe(1); // Local Agent only.
  });

  it('also counts harnesses the rule opts into', () => {
    const rule = ideRule('harnesses: [Claude]\n');
    expect(rule.harnesses).toEqual(['Claude']);
    expect(executePipeline(parsePipeline(rule), rule, ctx).total).toBe(2); // Local Agent + Claude, not Codex.
  });

  it('round-trips harnesses through serializeRule', () => {
    expect(serializeRule(ideRule('harnesses: [Claude]\n'))).toContain('harnesses: [Claude]');
  });
});

describe('harness-fitting advice', () => {
  const rule = { suggestionTemplate: 'Use #file.', claudeSuggestionTemplate: 'Use @path.' };

  it('gives Claude advice when every judged request is from Claude', () => {
    expect(suggestionTemplateFor(rule, ['Claude'])).toBe('Use @path.');
  });

  it('gives both, labelled, for a mixed view', () => {
    expect(suggestionTemplateFor(rule, ['Local Agent', 'Claude'])).toBe('Use #file. In Claude Code: Use @path.');
  });

  it('keeps the generic advice without Claude data or Claude advice', () => {
    expect(suggestionTemplateFor(rule, ['Local Agent'])).toBe('Use #file.');
    expect(suggestionTemplateFor({ suggestionTemplate: 'Use #file.' }, ['Claude'])).toBe('Use #file.');
  });

  it('parses and round-trips a "How to Improve (Claude Code)" section', () => {
    const parsed = parseRule(serializeRule({ ...ideRule(), suggestionTemplate: 'Generic.', claudeSuggestionTemplate: 'Claude.' }));
    expect(parsed?.suggestionTemplate).toBe('Generic.');           // Generic section not swallowed by the Claude one.
    expect(parsed?.claudeSuggestionTemplate).toBe('Claude.');
  });
});
