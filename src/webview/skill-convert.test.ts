/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { splitSkillMarkdown, toClaudeSkillMarkdown, toSkillName } from './skill-convert';

describe('toSkillName', () => {
  it('produces lowercase kebab-case names within 64 characters', () => {
    expect(toSkillName('Azure Deploy_Helper v2.0')).toBe('azure-deploy-helper-v2-0');
    expect(toSkillName('--x--')).toBe('x');
    expect(toSkillName('a'.repeat(70))).toHaveLength(64);
    expect(toSkillName('a'.repeat(63) + ' b')).toBe('a'.repeat(63));  // No trailing hyphen after truncation.
  });
});

describe('toClaudeSkillMarkdown', () => {
  it('keeps name, description, license and allowed-tools; drops Copilot-only keys', () => {
    const copilot = [
      '---',
      'name: My Skill',
      'description: >-',
      '  Deploys the app:',
      '  use for releases.',
      "applyTo: '**/*.ts'",
      'tools: [runCommands, editFiles]',
      'license: MIT',
      '---',
      '',
      '# Steps',
      'Run it.',
    ].join('\n');
    expect(toClaudeSkillMarkdown(copilot, 'fallback', 'fallback desc')).toBe([
      '---',
      'name: my-skill',
      'description: "Deploys the app: use for releases."',      // Folded block joined and quoted (colon-safe).
      'license: "MIT"',
      '---',
      '# Steps',
      'Run it.',
    ].join('\n'));
  });

  it('fills a missing name and description from the catalog entry', () => {
    const out = toClaudeSkillMarkdown('# Body only', 'Code Review', 'Reviews "risky" diffs.');
    expect(splitSkillMarkdown(out).fields).toEqual({ name: 'code-review', description: 'Reviews \\"risky\\" diffs.' });
    expect(out).toContain('description: "Reviews \\"risky\\" diffs."');
    expect(out.endsWith('# Body only')).toBe(true);
  });

  it('caps the description at 1024 characters on one line', () => {
    const out = toClaudeSkillMarkdown(`---\nname: x\ndescription: ${'word\t'.repeat(400)}\n---\nb`, 'x', '');
    const description = /description: "(.*)"/.exec(out)![1];
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).not.toMatch(/\t/);
  });
});
