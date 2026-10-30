/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { mapCopilotModel, mapCopilotTools, parseFrontmatterList, splitSkillMarkdown, toClaudeAgentMarkdown, toClaudeRuleMarkdown, toClaudeSkillMarkdown, toSkillName, withOriginalFrontmatter } from './skill-convert';

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

describe('parseFrontmatterList', () => {
  it('reads flow lists, block lists and comma lists without splitting glob braces', () => {
    expect(parseFrontmatterList("['codebase', \"editFiles\"]")).toEqual(['codebase', 'editFiles']);
    expect(parseFrontmatterList('- search - runCommands')).toEqual(['search', 'runCommands']);
    expect(parseFrontmatterList('**/*.{ts,tsx},src/**/*.py')).toEqual(['**/*.{ts,tsx}', 'src/**/*.py']);
  });
});

describe('Copilot agent → Claude Code subagent', () => {
  it('maps tools and Claude models, drops unknown tools and Copilot-only keys', () => {
    const agent = [
      '---',
      "description: 'Reviews pull requests'",
      "tools: ['codebase', 'editFiles', 'runCommands', 'problems', 'github/*']",
      "model: 'Claude Sonnet 4.5'",
      'handoffs: []',
      '---',
      'You are a reviewer.',
    ].join('\n');
    expect(toClaudeAgentMarkdown(agent, 'PR Reviewer', '')).toBe([
      '---',
      'name: pr-reviewer',
      'description: "Reviews pull requests"',
      'tools: Read, Grep, Glob, Edit, Write, Bash',             // problems / github/* have no Claude equivalent.
      'model: sonnet',
      '---',
      'You are a reviewer.',
    ].join('\n'));
  });

  it('omits tools when none map (inherit all) and model for non-Claude models', () => {
    const out = toClaudeAgentMarkdown("---\ntools: ['problems']\nmodel: GPT-5\n---\nx", 'a', 'Does a.');
    expect(out).not.toContain('tools:');
    expect(out).not.toContain('model:');
    expect(mapCopilotModel('Claude Opus 4.7')).toBe('opus');
    expect(mapCopilotTools(['vscode/runCommands'])).toEqual(['Bash']);
  });
});

describe('Copilot instructions → Claude Code rule', () => {
  it('turns applyTo into paths', () => {
    expect(toClaudeRuleMarkdown("---\ndescription: TS rules\napplyTo: '**/*.ts,**/*.tsx'\n---\nUse strict mode.")).toBe(
      '---\npaths:\n  - "**/*.ts"\n  - "**/*.tsx"\n---\nUse strict mode.');
  });

  it('drops the frontmatter for rules that apply to every file', () => {
    expect(toClaudeRuleMarkdown("---\napplyTo: '**'\n---\nBe concise.")).toBe('Be concise.');
  });
});

describe('withOriginalFrontmatter', () => {
  it('keeps the source frontmatter even if the rewrite dropped or changed it', () => {
    const merged = withOriginalFrontmatter("---\ntools: ['search']\n---\nUse #file.", '---\nname: x\n---\nUse @path.');
    expect(merged).toBe("---\ntools: ['search']\n---\nUse @path.");
  });
});
