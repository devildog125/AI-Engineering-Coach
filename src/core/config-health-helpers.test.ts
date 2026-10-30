/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  scanConfigFiles,
  isCloudPath,
  analyzeHookCoverage,
  computeProgressiveDisclosureScore,
  computeInstructionQualityScore,
  generateWorkspaceSuggestions,
  safeFileExists,
  buildFileTree,
  readSnippet,
  resolveWorkspaceRoot,
} from './config-health-helpers';
import { ConfigFileInfo } from './types';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-engineer-coach-config-'));
  tempDirs.push(dir);
  return dir;
}

function writeFile(root: string, relativePath: string, content: string): void {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf-8');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveWorkspaceRoot', () => {
  it('uses existing Codex workspace paths as root paths', () => {
    const root = makeTempDir();
    expect(resolveWorkspaceRoot('codex-proj-1234', { id: 'codex-proj-1234', name: 'proj', path: root })).toBe(root);
  });

  // Claude workspaces carry the project cwd as their path; it used to be read as a .jsonl log folder and dropped.
  it('uses an existing Claude workspace cwd as the root path', () => {
    const root = makeTempDir();
    expect(resolveWorkspaceRoot('claude-proj-1234', { id: 'claude-proj-1234', name: 'proj', path: root })).toBe(root);
    expect(resolveWorkspaceRoot('claude-gone', { id: 'claude-gone', name: 'gone', path: path.join(root, 'missing') })).toBeNull();
  });
});

describe('scanConfigFiles', () => {
  it('detects documented custom agent profiles in .github/agents/*.md', () => {
    const root = makeTempDir();
    writeFile(root, '.github/agents/readme-creator.md', `---
name: readme-creator
description: Agent specializing in creating and improving README files
---

You are a documentation specialist focused on README files.
`);

    const files = scanConfigFiles(root);
    expect(files.some(file => file.kind === 'agent' && file.relativePath === path.join('.github/agents', 'readme-creator.md'))).toBe(true);
  });

  it('detects prompt templates recursively under prompt directories', () => {
    const root = makeTempDir();
    writeFile(root, '.github/prompts/explanations/explain-code.prompt.md', `---
description: Generate a clear code explanation with examples
---

Explain the following code.
`);

    const files = scanConfigFiles(root);
    expect(files.some(file => file.kind === 'prompt' && file.relativePath === path.join('.github/prompts', 'explanations', 'explain-code.prompt.md'))).toBe(true);
  });

  it('does not include personal skill files in per-workspace scans', () => {
    const root = makeTempDir();
    const home = makeTempDir();
    const prevHome = process.env.HOME;

    try {
      process.env.HOME = home;
      writeFile(home, '.agents/skills/test-skill/SKILL.md', '# Personal skill');

      const files = scanConfigFiles(root);
      expect(files.some(file => file.kind === 'skill')).toBe(false);
    } finally {
      process.env.HOME = prevHome;
    }
  });

  it('detects copilot-instructions.md', () => {
    const root = makeTempDir();
    writeFile(root, '.github/copilot-instructions.md', '# Instructions\n\nUse TypeScript.');
    const files = scanConfigFiles(root);
    expect(files.some(f => f.kind === 'instruction' && f.relativePath === '.github/copilot-instructions.md')).toBe(true);
  });

  it('detects CLAUDE.md', () => {
    const root = makeTempDir();
    writeFile(root, 'CLAUDE.md', '# Claude\n\nFollow conventions.');
    const files = scanConfigFiles(root);
    expect(files.some(f => f.kind === 'claude-md' && f.relativePath === 'CLAUDE.md')).toBe(true);
  });

  // Claude Code reads CLAUDE.md from .claude/ and from package directories, and scoped rules from .claude/rules/.
  it('detects .claude/CLAUDE.md, nested CLAUDE.md and .claude/rules, but not vendored copies', () => {
    const root = makeTempDir();
    writeFile(root, '.claude/CLAUDE.md', '# Claude\n\nFollow conventions.');
    writeFile(root, 'packages/api/CLAUDE.md', '# API\n\nUse the repo pattern.');
    writeFile(root, '.claude/rules/testing.md', '# Testing\n\nUse vitest.');
    writeFile(root, 'node_modules/dep/CLAUDE.md', '# Not ours');
    const files = scanConfigFiles(root);
    const paths = files.map(f => `${f.kind}:${f.relativePath}`);
    expect(paths).toContain('claude-md:.claude/CLAUDE.md');
    expect(paths).toContain('claude-md:packages/api/CLAUDE.md');
    expect(paths).toContain('instruction:.claude/rules/testing.md');
    expect(paths.some(p => p.includes('node_modules'))).toBe(false); // Vendored config is someone else's.
  });

  it('applies the lean-CLAUDE.md rule to a nested CLAUDE.md', () => {
    const root = makeTempDir();
    writeFile(root, 'packages/api/CLAUDE.md', '# API\n' + 'rule\n'.repeat(400));
    const nested = scanConfigFiles(root).find(f => f.relativePath === 'packages/api/CLAUDE.md');
    expect(nested?.sizeVerdict).toBe('oversized');
    expect(nested?.markdownIssues.join(' ')).toContain('@path');     // Claude imports are @path, not @import.
  });

  it('detects scoped instructions in .github/instructions/', () => {
    const root = makeTempDir();
    writeFile(root, '.github/instructions/react.instructions.md', '# React rules\n\nUse hooks.');
    const files = scanConfigFiles(root);
    expect(files.some(f => f.kind === 'instruction' && f.relativePath.includes('react.instructions.md'))).toBe(true);
  });

  it('marks oversized instruction files', () => {
    const root = makeTempDir();
    const longContent = '# Title\n' + 'x\n'.repeat(600);
    writeFile(root, '.github/copilot-instructions.md', longContent);
    const files = scanConfigFiles(root);
    const instrFile = files.find(f => f.relativePath === '.github/copilot-instructions.md');
    expect(instrFile).toBeDefined();
    expect(instrFile!.sizeVerdict).toBe('oversized');
  });

  it('detects skills in .github/skills/', () => {
    const root = makeTempDir();
    writeFile(root, '.github/skills/my-skill/SKILL.md', '# Skill\n\nDo things.');
    const files = scanConfigFiles(root);
    expect(files.some(f => f.kind === 'skill')).toBe(true);
  });
});

describe('isCloudPath', () => {
  it('returns true for OneDrive paths', () => {
    expect(isCloudPath('/Users/me/OneDrive/project')).toBe(true);
  });
  it('returns true for Dropbox paths', () => {
    expect(isCloudPath('/Users/me/Dropbox/project')).toBe(true);
  });
  it('returns true for iCloud paths', () => {
    expect(isCloudPath('/Users/me/Library/Mobile Documents/iCloud~com~apple/project')).toBe(true);
  });
  it('returns false for local paths', () => {
    expect(isCloudPath('/Users/me/projects/my-app')).toBe(false);
  });
});

describe('analyzeHookCoverage', () => {
  it('returns null when no settings files exist', () => {
    const root = makeTempDir();
    expect(analyzeHookCoverage(root)).toBeNull();
  });

  it('detects hook events from .claude/settings.json', () => {
    const root = makeTempDir();
    writeFile(root, '.claude/settings.json', JSON.stringify({
      hooks: {
        PreToolUse: [{ command: 'echo pre' }],
        PostToolUse: [{ command: 'echo post' }],
      },
    }));
    const result = analyzeHookCoverage(root);
    expect(result).not.toBeNull();
    expect(result!.hasPreToolUse).toBe(true);
    expect(result!.hasPostToolUse).toBe(true);
    expect(result!.totalHooks).toBe(2);
    expect(result!.hookEvents).toContain('PreToolUse');
  });

  it('merges hooks from settings.json and settings.local.json', () => {
    const root = makeTempDir();
    writeFile(root, '.claude/settings.json', JSON.stringify({ hooks: { PreToolUse: [] } }));
    writeFile(root, '.claude/settings.local.json', JSON.stringify({ hooks: { SessionStart: [] } }));
    const result = analyzeHookCoverage(root);
    expect(result).not.toBeNull();
    expect(result!.hasPreToolUse).toBe(true);
    expect(result!.hasSessionStart).toBe(true);
    expect(result!.totalHooks).toBe(2);
  });
});

describe('computeProgressiveDisclosureScore', () => {
  it('returns 0 for empty files list', () => {
    expect(computeProgressiveDisclosureScore([])).toBe(0);
  });

  it('gives 25 points for having instructions', () => {
    const files: ConfigFileInfo[] = [
      { relativePath: '.github/copilot-instructions.md', kind: 'instruction', lines: 10, chars: 100, isMarkdown: true, markdownIssues: [], sizeVerdict: 'compact', lastModified: null },
    ];
    expect(computeProgressiveDisclosureScore(files)).toBeGreaterThanOrEqual(25);
  });

  it('gives max score for comprehensive setup', () => {
    const files: ConfigFileInfo[] = [
      { relativePath: '.github/copilot-instructions.md', kind: 'instruction', lines: 10, chars: 100, isMarkdown: true, markdownIssues: [], sizeVerdict: 'compact', lastModified: null },
      { relativePath: '.github/instructions/ts.instructions.md', kind: 'instruction', lines: 10, chars: 80, isMarkdown: true, markdownIssues: [], sizeVerdict: 'compact', lastModified: null },
      { relativePath: '.github/instructions/py.instructions.md', kind: 'instruction', lines: 10, chars: 80, isMarkdown: true, markdownIssues: [], sizeVerdict: 'compact', lastModified: null },
      { relativePath: '.github/skills/lint/SKILL.md', kind: 'skill', lines: 20, chars: 200, isMarkdown: true, markdownIssues: [], sizeVerdict: 'compact', lastModified: null },
    ];
    expect(computeProgressiveDisclosureScore(files)).toBe(100);
  });
});

describe('computeInstructionQualityScore', () => {
  it('returns 0 when no markdown files', () => {
    expect(computeInstructionQualityScore([])).toBe(0);
  });

  it('returns 100 for a perfect compact file with no issues', () => {
    const files: ConfigFileInfo[] = [
      { relativePath: 'file.md', kind: 'instruction', lines: 20, chars: 200, isMarkdown: true, markdownIssues: [], sizeVerdict: 'compact', lastModified: null },
    ];
    expect(computeInstructionQualityScore(files)).toBe(100);
  });

  it('penalizes oversized files', () => {
    const files: ConfigFileInfo[] = [
      { relativePath: 'file.md', kind: 'instruction', lines: 600, chars: 6000, isMarkdown: true, markdownIssues: [], sizeVerdict: 'oversized', lastModified: null },
    ];
    expect(computeInstructionQualityScore(files)).toBe(70);
  });

  it('penalizes markdown issues', () => {
    const files: ConfigFileInfo[] = [
      { relativePath: 'file.md', kind: 'instruction', lines: 20, chars: 200, isMarkdown: true, markdownIssues: ['issue1', 'issue2'], sizeVerdict: 'compact', lastModified: null },
    ];
    expect(computeInstructionQualityScore(files)).toBe(70);
  });
});

describe('generateWorkspaceSuggestions', () => {
  it('suggests creating instructions when none exist', () => {
    const suggestions = generateWorkspaceSuggestions([], null, false);
    expect(suggestions.some(s => s.includes('copilot-instructions.md'))).toBe(true);
  });

  it('suggests hooks for claude workspace without hooks', () => {
    const files: ConfigFileInfo[] = [
      { relativePath: 'CLAUDE.md', kind: 'claude-md', lines: 10, chars: 100, isMarkdown: true, markdownIssues: [], sizeVerdict: 'compact', lastModified: null },
    ];
    const suggestions = generateWorkspaceSuggestions(files, null, true);
    expect(suggestions.some(s => s.includes('hooks'))).toBe(true);
  });

  it('suggests prompts when none exist', () => {
    const files: ConfigFileInfo[] = [
      { relativePath: '.github/copilot-instructions.md', kind: 'instruction', lines: 10, chars: 100, isMarkdown: true, markdownIssues: [], sizeVerdict: 'compact', lastModified: null },
    ];
    const suggestions = generateWorkspaceSuggestions(files, null, false);
    expect(suggestions.some(s => s.includes('prompt'))).toBe(true);
  });

  it('suggests splitting oversized instruction files', () => {
    const files: ConfigFileInfo[] = [
      { relativePath: '.github/copilot-instructions.md', kind: 'instruction', lines: 600, chars: 6000, isMarkdown: true, markdownIssues: [], sizeVerdict: 'oversized', lastModified: null },
    ];
    const suggestions = generateWorkspaceSuggestions(files, null, false);
    expect(suggestions.some(s => s.includes('600 lines'))).toBe(true);
  });
});

describe('safeFileExists', () => {
  it('returns true for existing files', () => {
    const root = makeTempDir();
    writeFile(root, 'test.txt', 'hi');
    expect(safeFileExists(path.join(root, 'test.txt'))).toBe(true);
  });

  it('returns false for non-existent paths', () => {
    expect(safeFileExists('/nonexistent/path/file.txt')).toBe(false);
  });

  it('returns false for directories', () => {
    const root = makeTempDir();
    expect(safeFileExists(root)).toBe(false);
  });
});

describe('buildFileTree', () => {
  it('lists files and dirs with indentation', () => {
    const root = makeTempDir();
    writeFile(root, 'src/main.ts', 'export {}');
    writeFile(root, 'README.md', '# Hello');
    const tree = buildFileTree(root, 2, 100);
    expect(tree).toContain('README.md');
    expect(tree).toContain('src/');
    expect(tree).toContain('main.ts');
  });

  it('respects maxEntries', () => {
    const root = makeTempDir();
    for (let i = 0; i < 10; i++) writeFile(root, `file${i}.txt`, 'x');
    const tree = buildFileTree(root, 1, 5);
    const lines = tree.split('\n');
    expect(lines.length).toBeLessThanOrEqual(6); // 5 + possible "..."
  });

  it('excludes node_modules', () => {
    const root = makeTempDir();
    writeFile(root, 'node_modules/pkg/index.js', 'x');
    writeFile(root, 'src/app.ts', 'x');
    const tree = buildFileTree(root, 2, 100);
    expect(tree).not.toContain('node_modules');
    expect(tree).toContain('src/');
  });
});

describe('readSnippet', () => {
  it('reads first matching candidate', () => {
    const root = makeTempDir();
    writeFile(root, 'package.json', '{"name":"test"}');
    const snippet = readSnippet(root, ['missing.json', 'package.json'], 100);
    expect(snippet).toContain('"name"');
  });

  it('returns empty string when no candidates exist', () => {
    const root = makeTempDir();
    expect(readSnippet(root, ['nope.txt'], 100)).toBe('');
  });

  it('truncates to maxChars', () => {
    const root = makeTempDir();
    writeFile(root, 'big.txt', 'x'.repeat(1000));
    const snippet = readSnippet(root, ['big.txt'], 50);
    expect(snippet.length).toBe(50);
  });
});

describe('generateWorkspaceSuggestions for Claude Code workspaces', () => {
  it('suggests CLAUDE.md and .claude/commands instead of Copilot files', () => {
    const suggestions = generateWorkspaceSuggestions([], null, true).join('\n');
    expect(suggestions).toContain('CLAUDE.md');
    expect(suggestions).toContain('.claude/commands');
    expect(suggestions).not.toContain('copilot-instructions.md');   // Copilot file is irrelevant to Claude Code.
    expect(suggestions).not.toContain('.prompt.md');
  });

  it('points an oversized instruction file at .claude/rules, not .github/instructions', () => {
    const files: ConfigFileInfo[] = [
      { relativePath: 'AGENTS.md', kind: 'instruction', lines: 600, chars: 6000, isMarkdown: true, markdownIssues: [], sizeVerdict: 'oversized', lastModified: null },
    ];
    const text = generateWorkspaceSuggestions(files, null, true).join('\n');
    expect(text).toContain('.claude/rules');
    expect(text).not.toContain('.github/instructions');
  });

  it('keeps Copilot suggestions for other workspaces', () => {
    expect(generateWorkspaceSuggestions([], null, false).join('\n')).toContain('copilot-instructions.md');
  });
});
