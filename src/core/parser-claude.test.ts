/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Tests for the Claude JSONL parser — focuses on synthetic user-record
 * filtering (tool_result deliveries, slash-command bookkeeping, interrupt
 * markers) so we don't inflate the missing-token rate. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { describe, it, expect } from 'vitest';
import { EditLocIndex } from './edit-loc-diff';
import { parseClaudeSessions } from './parser-claude';
import { claudeCallCostUSD } from './claude-pricing';

/** os.tmpdir() on Windows often returns 8.3 short names (e.g. TAMASB~1)
 *  that don't match readdirSync output. Resolve to the long form so
 *  tests that encode and decode filesystem paths work reliably. */
function longTmpDir(): string {
  const tmp = os.tmpdir();
  if (process.platform !== 'win32' || !tmp.includes('~')) return tmp;
  try {
    return execSync(
      `powershell -NoProfile -Command "(Get-Item ${JSON.stringify(tmp)}).FullName"`,
      { encoding: 'utf-8' },
    ).trim();
  } catch {
    return tmp;
  }
}

function makeUser(text: string, ts = '2025-06-15T10:00:00Z', extra: Record<string, unknown> = {}): object {
  return {
    type: 'user',
    timestamp: ts,
    sessionId: 'sess-1',
    cwd: '/Users/me/proj',
    message: { role: 'user', content: [{ type: 'text', text }] },
    ...extra,
  };
}

function makeToolResultUser(ts = '2025-06-15T10:00:01Z'): object {
  return {
    type: 'user',
    timestamp: ts,
    sessionId: 'sess-1',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }] },
  };
}

function makeAssistant(text: string, ts = '2025-06-15T10:00:02Z', usage?: Record<string, number>): object {
  return {
    type: 'assistant',
    timestamp: ts,
    sessionId: 'sess-1',
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4',
      content: [{ type: 'text', text }],
      usage: usage ?? { input_tokens: 1000, output_tokens: 50 },
    },
  };
}

function makeToolAssistant(
  name: string,
  input: Record<string, unknown>,
  ts = '2025-06-15T10:00:02Z',
  id?: string,
): object {
  return {
    type: 'assistant',
    timestamp: ts,
    sessionId: 'sess-1',
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4',
      content: [{ type: 'tool_use', id, name, input }],
      usage: { input_tokens: 100, output_tokens: 20 },
    },
  };
}

function withProjectsDir(filename: string, lines: object[], run: (projectsDir: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-parser-test-'));
  const projectsDir = path.join(root, 'projects');
  const projDir = path.join(projectsDir, '-Users-me-proj');
  fs.mkdirSync(projDir, { recursive: true });
  const file = path.join(projDir, filename);
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n'), 'utf-8');
  try { run(projectsDir); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

describe('parseClaudeSessions', () => {
  it('extracts current Edit new_string and MultiEdit deltas', () => {
    withProjectsDir('s.jsonl', [
      makeUser('edit files', '2025-06-15T10:00:00Z', { uuid: 'request_claude_edit' }),
      makeToolAssistant('Edit', {
        file_path: '/Users/me/proj/app.ts',
        old_string: 'a\nold',
        new_string: 'a\nnew\nextra',
      }),
      makeToolAssistant('MultiEdit', {
        file_path: '/Users/me/proj/other.ts',
        edits: [
          { old_string: 'old1', new_string: 'new1' },
          { old_string: 'old2', new_string: 'new2\nextra2' },
        ],
      }, '2025-06-15T10:00:03Z'),
    ], (projectsDir) => {
      const editLocIndex: EditLocIndex = new Map();
      const request = parseClaudeSessions(projectsDir, editLocIndex)[0].sessions[0].requests[0];

      expect(request.toolsUsed).toEqual(['Edit', 'MultiEdit']);
      expect(request.editedFiles).toEqual([
        '/Users/me/proj/app.ts',
        '/Users/me/proj/other.ts',
      ]);
      expect(editLocIndex.get('request_claude_edit')?.get('/Users/me/proj/app.ts'))
        .toEqual({ added: 2, removed: 1 });
      expect(editLocIndex.get('request_claude_edit')?.get('/Users/me/proj/other.ts'))
        .toEqual({ added: 3, removed: 2 });
    });
  });

  it('excludes edits whose correlated tool result reports an error', () => {
    withProjectsDir('s.jsonl', [
      makeUser('edit a file', '2025-06-15T10:00:00Z', { uuid: 'request_failed_edit' }),
      makeToolAssistant('Edit', {
        file_path: '/Users/me/proj/app.ts',
        old_string: 'old',
        new_string: 'new',
      }, '2025-06-15T10:00:01Z', 'tool-failed'),
      {
        type: 'user',
        timestamp: '2025-06-15T10:00:02Z',
        sessionId: 'sess-1',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-failed', is_error: true }],
        },
      },
    ], (projectsDir) => {
      const editLocIndex: EditLocIndex = new Map();
      const request = parseClaudeSessions(projectsDir, editLocIndex)[0].sessions[0].requests[0];

      expect(request.toolsUsed).toEqual(['Edit']);
      expect(request.editedFiles).toEqual([]);
      expect(editLocIndex.has('request_failed_edit')).toBe(false);
    });
  });

  it('excludes correlated edits without a tool result', () => {
    withProjectsDir('s.jsonl', [
      makeUser('edit a file', '2025-06-15T10:00:00Z', { uuid: 'request_incomplete_edit' }),
      makeToolAssistant('Edit', {
        file_path: '/Users/me/proj/app.ts',
        old_string: 'old',
        new_string: 'new',
      }, '2025-06-15T10:00:01Z', 'tool-incomplete'),
    ], (projectsDir) => {
      const editLocIndex: EditLocIndex = new Map();
      const request = parseClaudeSessions(projectsDir, editLocIndex)[0].sessions[0].requests[0];

      expect(request.editedFiles).toEqual([]);
      expect(editLocIndex.size).toBe(0);
    });
  });

  it('captures explicit WebFetch hosts and resets them for each human turn', () => {
    withProjectsDir('sources.jsonl', [
      makeUser('Why?'),
      { type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'WebFetch', input: { url: 'https://docs.python.org/3/?private=1' } },
        { type: 'tool_use', name: 'WebSearch', input: { query: 'https://not-a-source.example' } },
      ] } },
      makeAssistant('An answer.'),
      makeUser('How?', '2025-06-15T10:01:00Z'),
      makeAssistant('Another answer.', '2025-06-15T10:01:01Z'),
    ], projectsDir => {
      expect(parseClaudeSessions(projectsDir)[0].sessions[0].requests.map(request => request.webDomains))
        .toEqual([['docs.python.org'], []]);
    });
  });

  it('keeps human IDs and final-answer evidence, without counting tool commentary as an answer', () => {
    withProjectsDir('s.jsonl', [
      makeUser('Why?', undefined, { uuid: 'human-1' }),
      { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'An answer.' }] } },
      makeUser('How?', '2025-06-15T10:01:00Z', { uuid: 'human-2' }),
      makeAssistant('I will inspect it.'),
      { type: 'assistant', message: { stop_reason: 'tool_use', content: [
        { type: 'tool_use', name: 'Read', input: { file_path: '/repo/a.ts' } },
        { type: 'tool_use', name: 'Agent', input: { subagent_type: 'Explore' } },
      ] } },
    ], projectsDir => {
      expect(parseClaudeSessions(projectsDir)[0].sessions[0].requests).toMatchObject([
        { userEventId: 'human-1', answerEvidence: 'final' },
        { userEventId: 'human-2', answerEvidence: 'missing', toolsUsed: ['Read', 'Agent'], referencedFiles: ['/repo/a.ts'],
          investigationDelegations: ['explore'] },
      ]);
    });
  });

  it.each([{ isSidechain: true }, { isMeta: true }, { isCompactSummary: true }])('excludes %j messages from Curiosity without dropping their session data', extra => {
    withProjectsDir('s.jsonl', [
      makeUser('Why does this fail?', undefined, extra),
      makeAssistant('Because the input is missing.'),
    ], projectsDir => {
      const sessions = parseClaudeSessions(projectsDir).flatMap(workspace => workspace.sessions);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].requests).toHaveLength(1);
      expect(sessions[0].requests[0].curiosity).toEqual({ kind: 'excluded', excerpts: [] });
    });
  });

  it('skips tool_result-only user records and merges following assistant into prior real user request', () => {
    withProjectsDir('s.jsonl', [
      makeUser('write a file please'),
      makeAssistant('I will use the Write tool', '2025-06-15T10:00:01Z',
        { input_tokens: 100, output_tokens: 30 }),
      makeToolResultUser('2025-06-15T10:00:02Z'),
      makeAssistant('Done.', '2025-06-15T10:00:03Z',
        { input_tokens: 200, output_tokens: 10 }),
    ], (projectsDir) => {
      const result = parseClaudeSessions(projectsDir);
      expect(result).toHaveLength(1);
      const session = result[0].sessions[0];
      // ONE request, not two — the tool_result delivery is consumed into
      // the parent request alongside both assistant follow-ups
      expect(session.requests).toHaveLength(1);
      expect(session.requests[0].promptTokens).toBe(300);  // sum of both assistants
      expect(session.requests[0].completionTokens).toBe(40);
    });
  });

  it('skips slash-command bookkeeping records (<command-name>, <local-command-stdout>)', () => {
    withProjectsDir('s.jsonl', [
      // Three slash-command records that have text but aren't real prompts —
      // these used to be parsed as missing-token requests.
      makeUser('<local-command-caveat>resumed conversation</local-command-caveat>'),
      makeUser('<command-name>/mcp</command-name>'),
      makeUser('<local-command-stdout>No MCP servers configured.</local-command-stdout>'),
      // Real user prompt comes after
      makeUser('how does mcp work?', '2025-06-15T10:01:00Z'),
      makeAssistant('It works like this…', '2025-06-15T10:01:01Z',
        { input_tokens: 500, output_tokens: 100 }),
    ], (projectsDir) => {
      const session = parseClaudeSessions(projectsDir)[0].sessions[0];
      expect(session.requests).toHaveLength(1);
      expect(session.requests[0].messageText).toContain('how does mcp work?');
    });
  });

  it('skips [Request interrupted by user…] markers', () => {
    withProjectsDir('s.jsonl', [
      makeUser('do something'),
      makeAssistant('starting', '2025-06-15T10:00:01Z',
        { input_tokens: 100, output_tokens: 5 }),
      makeUser('[Request interrupted by user for tool use]', '2025-06-15T10:00:02Z'),
      // Real follow-up
      makeUser('actually do this instead', '2025-06-15T10:00:03Z'),
      makeAssistant('ok', '2025-06-15T10:00:04Z',
        { input_tokens: 200, output_tokens: 5 }),
    ], (projectsDir) => {
      const session = parseClaudeSessions(projectsDir)[0].sessions[0];
      expect(session.requests).toHaveLength(2);
      expect(session.requests[0].messageText).toBe('do something');
      expect(session.requests[1].messageText).toBe('actually do this instead');
    });
  });

  it('marks tokens as missing when a real user prompt has no assistant response', () => {
    withProjectsDir('s.jsonl', [
      makeUser('this prompt errors and gets no response'),
      // No assistant follow-up
    ], (projectsDir) => {
      const session = parseClaudeSessions(projectsDir)[0].sessions[0];
      expect(session.requests).toHaveLength(1);
      expect(session.requests[0].promptTokens).toBeNull();
      expect(session.requests[0].completionTokens).toBeNull();
    });
  });

  // ---- entrypoint classification & subagent merging ----

  it('classifies cli entrypoint as interactive Claude harness', () => {
    withProjectsDir('s.jsonl', [
      makeUser('hi', '2025-06-15T10:00:00Z', { entrypoint: 'cli' }),
      makeAssistant('hello', '2025-06-15T10:00:01Z', { input_tokens: 10, output_tokens: 5 }),
    ], (projectsDir) => {
      const session = parseClaudeSessions(projectsDir)[0].sessions[0];
      expect(session.harness).toBe('Claude');
      expect(session.launcherKind).toBe('interactive');
      expect(session.entrypoint).toBe('cli');
    });
  });

  it('classifies claude-desktop entrypoint as interactive Claude harness', () => {
    withProjectsDir('s.jsonl', [
      makeUser('hi', '2025-06-15T10:00:00Z', { entrypoint: 'claude-desktop' }),
      makeAssistant('hello', '2025-06-15T10:00:01Z', { input_tokens: 10, output_tokens: 5 }),
    ], (projectsDir) => {
      const session = parseClaudeSessions(projectsDir)[0].sessions[0];
      expect(session.harness).toBe('Claude');
      expect(session.launcherKind).toBe('interactive');
    });
  });

  it('classifies sdk-ts entrypoint as programmatic Claude harness', () => {
    withProjectsDir('s.jsonl', [
      makeUser('hi', '2025-06-15T10:00:00Z', { entrypoint: 'sdk-ts' }),
      makeAssistant('hello', '2025-06-15T10:00:01Z', { input_tokens: 10, output_tokens: 5 }),
    ], (projectsDir) => {
      const session = parseClaudeSessions(projectsDir)[0].sessions[0];
      expect(session.harness).toBe('Claude');
      expect(session.launcherKind).toBe('programmatic');
      expect(session.entrypoint).toBe('sdk-ts');
    });
  });

  it('defaults missing entrypoint to programmatic Claude harness', () => {
    withProjectsDir('s.jsonl', [
      makeUser('hi'),  // no entrypoint field at all
      makeAssistant('hello', '2025-06-15T10:00:01Z', { input_tokens: 10, output_tokens: 5 }),
    ], (projectsDir) => {
      const session = parseClaudeSessions(projectsDir)[0].sessions[0];
      expect(session.harness).toBe('Claude');
      expect(session.launcherKind).toBe('programmatic');
      expect(session.entrypoint).toBeUndefined();
    });
  });

  it('defaults unknown entrypoint to programmatic (allow-list discipline)', () => {
    withProjectsDir('s.jsonl', [
      makeUser('hi', '2025-06-15T10:00:00Z', { entrypoint: 'some-future-launcher' }),
      makeAssistant('hello', '2025-06-15T10:00:01Z', { input_tokens: 10, output_tokens: 5 }),
    ], (projectsDir) => {
      const session = parseClaudeSessions(projectsDir)[0].sessions[0];
      expect(session.harness).toBe('Claude');
      expect(session.launcherKind).toBe('programmatic');
      expect(session.entrypoint).toBe('some-future-launcher');
    });
  });

  it('merges subagent files into the parent session, sorted by timestamp', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-subagent-test-'));
    const projectsDir = path.join(root, 'projects');
    const projDir = path.join(projectsDir, '-Users-me-proj');
    const subDir = path.join(projDir, 'parent-sess', 'subagents');
    fs.mkdirSync(subDir, { recursive: true });

    // Parent session at top-level
    fs.writeFileSync(
      path.join(projDir, 'parent-sess.jsonl'),
      [
        makeUser('parent prompt', '2025-06-15T10:00:00Z',
          { sessionId: 'parent-sess', entrypoint: 'sdk-ts' }),
        makeAssistant('parent reply', '2025-06-15T10:00:01Z',
          { input_tokens: 100, output_tokens: 20 }),
      ].map(l => JSON.stringify(l)).join('\n'),
      'utf-8',
    );

    // Subagent file (later timestamp) should be merged in but appear after parent request
    fs.writeFileSync(
      path.join(subDir, 'agent-1.jsonl'),
      [
        makeUser('subagent task', '2025-06-15T10:00:30Z',
          { sessionId: 'agent-1', entrypoint: 'sdk-ts' }),
        makeAssistant('subagent reply', '2025-06-15T10:00:31Z',
          { input_tokens: 50, output_tokens: 10 }),
      ].map(l => JSON.stringify(l)).join('\n'),
      'utf-8',
    );

    try {
      const result = parseClaudeSessions(projectsDir);
      expect(result).toHaveLength(1);
      const sessions = result[0].sessions;
      // Only ONE session — subagent merged into parent, not standalone
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe('parent-sess');
      // The subagent prompt was written by Claude, not the user: it folds into
      // the parent turn that was running at the time instead of adding a request.
      expect(sessions[0].requests).toHaveLength(1);
      expect(sessions[0].requests[0].messageText).toContain('parent prompt');
      expect(sessions[0].requestCount).toBe(1);
      // Its tokens still count, added onto the parent turn.
      expect(sessions[0].requests[0].promptTokens).toBe(150);
      expect(sessions[0].requests[0].completionTokens).toBe(30);
      // lastMessageDate extends to the subagent's last assistant timestamp
      expect(sessions[0].lastMessageDate).toBe(new Date('2025-06-15T10:00:31Z').getTime());
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('emits orphan subagent (no parent session) as standalone Claude', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-orphan-test-'));
    const projectsDir = path.join(root, 'projects');
    const projDir = path.join(projectsDir, '-Users-me-proj');
    const subDir = path.join(projDir, 'orphan-sess', 'subagents');
    fs.mkdirSync(subDir, { recursive: true });

    // No parent file — only the subagent under orphan-sess/subagents/
    fs.writeFileSync(
      path.join(subDir, 'agent-1.jsonl'),
      [
        makeUser('orphan task', '2025-06-15T10:00:00Z',
          { sessionId: 'agent-1', entrypoint: 'sdk-ts' }),
        makeAssistant('orphan reply', '2025-06-15T10:00:01Z',
          { input_tokens: 50, output_tokens: 10 }),
      ].map(l => JSON.stringify(l)).join('\n'),
      'utf-8',
    );

    try {
      const result = parseClaudeSessions(projectsDir);
      expect(result).toHaveLength(1);
      const sessions = result[0].sessions;
      expect(sessions).toHaveLength(1);
      // Orphan session takes the parent dir name as its sessionId
      expect(sessions[0].sessionId).toBe('orphan-sess');
      expect(sessions[0].harness).toBe('Claude');
      expect(sessions[0].launcherKind).toBe('programmatic');
      expect(sessions[0].requests).toHaveLength(1);
      expect(sessions[0].requests[0].messageText).toContain('orphan task');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ---- workspace name resolution with spaces ----

  it('resolves workspace name when path contains a folder with spaces', { timeout: 30_000 }, () => {
    // Create a real directory tree with a space in a folder name.
    // longTmpDir() resolves Windows 8.3 short names so the encoded path
    // uses long names that match readdirSync output.
    const tmpBase = fs.mkdtempSync(path.join(longTmpDir(), 'claude-ws-'));
    const spaceParent = path.join(tmpBase, 'My Folder');
    const targetDir = path.join(spaceParent, 'proj');
    fs.mkdirSync(targetDir, { recursive: true });

    // Compute the encoded directory name that Claude Code would produce:
    // lowercase drive letter, then replace :, \, /, and whitespace with -
    const encodedDirName = targetDir
      .replace(/^([a-zA-Z])(?=:)/, d => d.toLowerCase())
      .replace(/[:\\/\s]/g, '-');

    const root = fs.mkdtempSync(path.join(longTmpDir(), 'claude-proj-'));
    const projectsDir = path.join(root, 'projects');
    const projDir = path.join(projectsDir, encodedDirName);
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(
      path.join(projDir, 's.jsonl'),
      [makeUser('hello'), makeAssistant('hi')].map(l => JSON.stringify(l)).join('\n'),
    );

    try {
      const result = parseClaudeSessions(projectsDir);
      expect(result).toHaveLength(1);
      expect(result[0].workspaceName).toBe('proj');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it('resolves workspace name when path has space-hyphen-space (OneDrive style)', () => {
    // Simulates paths like C:\Users\me\OneDrive - Microsoft\Documents\proj
    const tmpBase = fs.mkdtempSync(path.join(longTmpDir(), 'claude-od-'));
    const oneDriveDir = path.join(tmpBase, 'OneDrive - Microsoft');
    const docsDir = path.join(oneDriveDir, 'Documents');
    const targetDir = path.join(docsDir, 'myapp');
    fs.mkdirSync(targetDir, { recursive: true });

    const encodedDirName = targetDir
      .replace(/^([a-zA-Z])(?=:)/, d => d.toLowerCase())
      .replace(/[:\\/\s]/g, '-');

    const root = fs.mkdtempSync(path.join(longTmpDir(), 'claude-proj-'));
    const projectsDir = path.join(root, 'projects');
    const projDir = path.join(projectsDir, encodedDirName);
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(
      path.join(projDir, 's.jsonl'),
      [makeUser('hello'), makeAssistant('world')].map(l => JSON.stringify(l)).join('\n'),
    );

    try {
      const result = parseClaudeSessions(projectsDir);
      expect(result).toHaveLength(1);
      expect(result[0].workspaceName).toBe('myapp');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it('resolves workspace name through symlinked directories (OneDrive reparse points)', () => {
    // On Windows, "OneDrive - Microsoft" is a reparse point that readdirSync
    // reports as a symlink rather than a directory.  The resolution algorithm
    // must follow symlinks to resolve the project name correctly.
    const tmpBase = fs.mkdtempSync(path.join(longTmpDir(), 'claude-sym-'));
    const realDir = path.join(tmpBase, 'real-onedrive');
    const docsDir = path.join(realDir, 'Documents');
    const targetDir = path.join(docsDir, 'myapp');
    fs.mkdirSync(targetDir, { recursive: true });

    // Create a symlink (junction on Windows) with a space-hyphen-space name
    const symlinkDir = path.join(tmpBase, 'OneDrive - Microsoft');
    if (process.platform === 'win32') {
      fs.symlinkSync(realDir, symlinkDir, 'junction');
    } else {
      fs.symlinkSync(realDir, symlinkDir);
    }

    // The encoded path goes through the symlink, not the real directory
    const symlinkTargetDir = path.join(symlinkDir, 'Documents', 'myapp');
    const encodedDirName = symlinkTargetDir
      .replace(/^([a-zA-Z])(?=:)/, d => d.toLowerCase())
      .replace(/[:\\/\s]/g, '-');

    const root = fs.mkdtempSync(path.join(longTmpDir(), 'claude-proj-'));
    const projectsDir = path.join(root, 'projects');
    const projDir = path.join(projectsDir, encodedDirName);
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(
      path.join(projDir, 's.jsonl'),
      [makeUser('hello'), makeAssistant('world')].map(l => JSON.stringify(l)).join('\n'),
    );

    try {
      const result = parseClaudeSessions(projectsDir);
      expect(result).toHaveLength(1);
      expect(result[0].workspaceName).toBe('myapp');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it('extracts skillsUsed from Read tool calls targeting SKILL.md files', () => {
    const assistantWithSkillRead = {
      type: 'assistant',
      timestamp: '2025-06-15T10:00:02Z',
      sessionId: 'sess-1',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4',
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: '/home/user/.claude/skills/investigate/SKILL.md' } },
          { type: 'tool_use', name: 'Read', input: { file_path: '/home/user/.claude/skills/browse/SKILL.md' } },
          { type: 'tool_use', name: 'Read', input: { file_path: '/home/user/project/src/main.ts' } },
          { type: 'text', text: 'I read the skill files.' },
        ],
        usage: { input_tokens: 500, output_tokens: 100 },
      },
    };

    withProjectsDir('s.jsonl', [
      makeUser('investigate this bug'),
      assistantWithSkillRead,
    ], (projectsDir) => {
      const session = parseClaudeSessions(projectsDir)[0].sessions[0];
      expect(session.requests).toHaveLength(1);
      expect(session.requests[0].skillsUsed).toContain('investigate');
      expect(session.requests[0].skillsUsed).toContain('browse');
      expect(session.requests[0].skillsUsed).toHaveLength(2);
    });
  });

  it('extracts skillsUsed from Skill tool calls', () => {
    const assistantWithSkillTool = {
      type: 'assistant',
      timestamp: '2025-06-15T10:00:02Z',
      sessionId: 'sess-1',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4',
        content: [
          { type: 'tool_use', name: 'Skill', input: { skill: 'office-hours', args: 'brainstorm my idea' } },
          { type: 'text', text: 'Running office-hours skill.' },
        ],
        usage: { input_tokens: 500, output_tokens: 100 },
      },
    };

    withProjectsDir('s.jsonl', [
      makeUser('brainstorm this'),
      assistantWithSkillTool,
    ], (projectsDir) => {
      const session = parseClaudeSessions(projectsDir)[0].sessions[0];
      expect(session.requests).toHaveLength(1);
      expect(session.requests[0].skillsUsed).toContain('office-hours');
      expect(session.requests[0].skillsUsed).toHaveLength(1);
      expect(session.requests[0].toolsUsed).toContain('Skill');
    });
  });

  it('deduplicates skills from Skill tool and Read-based detection', () => {
    const assistantWithBoth = {
      type: 'assistant',
      timestamp: '2025-06-15T10:00:02Z',
      sessionId: 'sess-1',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4',
        content: [
          { type: 'tool_use', name: 'Skill', input: { skill: 'investigate', args: 'debug this' } },
          { type: 'tool_use', name: 'Read', input: { file_path: '/home/user/.claude/skills/investigate/SKILL.md' } },
          { type: 'text', text: 'Investigating.' },
        ],
        usage: { input_tokens: 500, output_tokens: 100 },
      },
    };

    withProjectsDir('s.jsonl', [
      makeUser('debug this'),
      assistantWithBoth,
    ], (projectsDir) => {
      const session = parseClaudeSessions(projectsDir)[0].sessions[0];
      expect(session.requests[0].skillsUsed).toContain('investigate');
      expect(session.requests[0].skillsUsed).toHaveLength(1);
    });
  });

  it('stores the Claude session cwd as workspaceRootPath', () => {
    // The cwd recorded on user records is the project root. Surfacing it as
    // workspaceRootPath lets config-health / SDLC workspace scans resolve the
    // repo for Claude sessions, the same way the Codex parser already does.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cwd-test-'));
    withProjectsDir('s.jsonl', [
      makeUser('hello', '2025-06-15T10:00:00Z', { cwd }),
      makeAssistant('hi there'),
    ], (projectsDir) => {
      const session = parseClaudeSessions(projectsDir)[0].sessions[0];
      expect(session.workspaceRootPath).toBe(cwd);
    });
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

/** Assistant line for one content block of an API response; several share one message.id. */
function makeCall(id: string, model: string, usage: Record<string, unknown>, ts = '2025-06-15T10:00:02Z', content: object[] = [{ type: 'text', text: 'ok' }]): object {
  return { type: 'assistant', timestamp: ts, sessionId: 'sess-1', message: { id, role: 'assistant', model, content, usage, stop_reason: 'end_turn' } };
}

/** Parse one transcript and return its only session (fails the test when there isn't exactly one). */
function parseOne(lines: object[]): ReturnType<typeof parseClaudeSessions>[number]['sessions'][number] {
  let session: ReturnType<typeof parseClaudeSessions>[number]['sessions'][number] | undefined;
  withProjectsDir('s.jsonl', lines, projectsDir => {
    const sessions = parseClaudeSessions(projectsDir).flatMap(workspace => workspace.sessions);
    expect(sessions).toHaveLength(1);                              // One transcript → one session.
    session = sessions[0];
  });
  return session!;
}

describe('Claude parity: usage, cost and signals', () => {
  it('counts usage once per message.id even when the response spans several lines', () => {
    const usage = { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 };
    const session = parseOne([
      makeUser('hi'),
      makeCall('msg_1', 'claude-opus-5-5', usage, '2025-06-15T10:00:01Z', [{ type: 'thinking', thinking: '' }]), // Same response,
      makeCall('msg_1', 'claude-opus-5-5', usage, '2025-06-15T10:00:02Z'),                                        // second block.
    ]);
    const request = session.requests[0];
    expect(request.promptTokens).toBe(1010);                       // Not 2020: duplicate line ignored.
    expect(request.completionTokens).toBe(100);
    expect(request.contextTokens).toBe(1010);
    // Opus 5.5: 10 × $4 + 100 × $20 + 1000 × $0.20, per million tokens.
    expect(request.costUSD).toBeCloseTo((10 * 4 + 100 * 20 + 1000 * 0.2) / 1e6, 12);
  });

  it('reports context size from the last call and billing input across all calls', () => {
    const session = parseOne([
      makeUser('do it'),
      makeCall('msg_1', 'claude-sonnet-5', { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 100 }),
      makeCall('msg_2', 'claude-sonnet-5', { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 200 }),
    ]);
    expect(session.requests[0].promptTokens).toBe(310);           // 105 + 205 billed.
    expect(session.requests[0].contextTokens).toBe(205);          // Window holds only the last call.
  });

  it('marks cost unknown (null) when a call uses a model with no list price', () => {
    const session = parseOne([makeUser('hi'), makeCall('msg_1', 'claude-unknown-9', { input_tokens: 1, output_tokens: 1 })]);
    expect(session.requests[0].costUSD).toBeNull();
  });

  it('reads the last cost-state into a per-model report, merging [1m] variants', () => {
    const session = parseOne([
      makeUser('hi'),
      makeCall('msg_1', 'claude-opus-5-5', { input_tokens: 1, output_tokens: 1 }),
      { type: 'cost-state', sessionId: 'sess-1', totalCostUSD: 1, hasUnknownModelCost: false, modelUsage: {} },
      { type: 'cost-state', sessionId: 'sess-1', totalCostUSD: 3, hasUnknownModelCost: false, modelUsage: {
        'claude-opus-5-5[1m]': { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, thinkingTokens: 0, costUSD: 1.5 },
        'claude-opus-5-5': { inputTokens: 1, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, thinkingTokens: 0, costUSD: 0.5 },
        'claude-haiku-5-5': { inputTokens: 9, outputTokens: 9, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, thinkingTokens: 0, costUSD: 1 },
      } },
    ]);
    expect(session.harnessCostReport?.totalCostUSD).toBe(3);      // Last cost-state wins.
    expect(session.harnessCostReport?.models['claude-opus-5.5'].costUSD).toBe(2);
    expect(session.harnessCostReport?.models['claude-opus-5.5'].inputTokens).toBe(2);
    expect(session.harnessCostReport?.models['claude-haiku-5.5'].costUSD).toBe(1);
  });

  it('turns a typed slash command into a request and absorbs its skill body', () => {
    const session = parseOne([
      makeUser('<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>PR 7</command-args>'),
      makeUser('Base directory for this skill: ...', '2025-06-15T10:00:00Z', { isMeta: true }),
      makeCall('msg_1', 'claude-sonnet-5', { input_tokens: 1, output_tokens: 1 }),
    ]);
    expect(session.requests).toHaveLength(1);                      // Body did not become its own request.
    expect(session.requests[0].slashCommand).toBe('review');
    expect(session.requests[0].messageText).toBe('/review PR 7');
  });

  it('ignores local-only commands that never reach the model', () => {
    const session = parseOne([
      makeUser('<command-name>/model</command-name>'),
      makeUser('<local-command-stdout>Set model</local-command-stdout>'),
      makeUser('real prompt', '2025-06-15T10:01:00Z'),
      makeCall('msg_1', 'claude-sonnet-5', { input_tokens: 1, output_tokens: 1 }, '2025-06-15T10:01:01Z'),
    ]);
    expect(session.requests.map(r => r.messageText)).toEqual(['real prompt']);
  });

  it('records interrupts, plan mode, @file mentions and CLAUDE.md loads', () => {
    const session = parseOne([
      { type: 'attachment', sessionId: 'sess-1', attachment: { type: 'instructions', files: [{ path: '/p/CLAUDE.md', type: 'Project', content: 'x'.repeat(40) }] } },
      makeUser('plan this @src/a.ts', '2025-06-15T10:00:00Z', { permissionMode: 'plan' }),
      { type: 'attachment', sessionId: 'sess-1', attachment: { type: 'file', filename: '/p/src/a.ts' } },
      makeCall('msg_1', 'claude-sonnet-5', { input_tokens: 1, output_tokens: 1 }),
      makeUser('[Request interrupted by user]'),
    ]);
    const request = session.requests[0];
    expect(request.agentMode).toBe('plan');
    expect(request.isCanceled).toBe(true);
    expect(request.variableKinds.file).toBe(1);
    expect(request.referencedFiles).toContain('/p/src/a.ts');
    expect(request.customInstructions).toEqual(['/p/CLAUDE.md']);
    expect(session.customInstructionsBytes).toBe(40);
  });

  it('attaches a between-turn compaction to the next request', () => {
    const session = parseOne([
      makeUser('one'),
      makeCall('msg_1', 'claude-sonnet-5', { input_tokens: 1, output_tokens: 1 }),
      { type: 'system', subtype: 'compact_boundary', sessionId: 'sess-1', compactMetadata: { trigger: 'auto', preTokens: 180000, durationMs: 900 } },
      makeUser('two', '2025-06-15T10:05:00Z'),
      makeCall('msg_2', 'claude-sonnet-5', { input_tokens: 1, output_tokens: 1 }, '2025-06-15T10:05:01Z'),
    ]);
    expect(session.requests[0].compaction).toBeNull();
    expect(session.requests[1].compaction).toMatchObject({ mode: 'full', contextLengthBefore: 180000, outcome: 'auto' });
  });

  it('builds a todo snapshot from TaskCreate and TaskUpdate', () => {
    const session = parseOne([
      makeUser('work'),
      makeCall('msg_1', 'claude-sonnet-5', { input_tokens: 1, output_tokens: 1 }, '2025-06-15T10:00:02Z', [
        { type: 'tool_use', id: 't1', name: 'TaskCreate', input: { subject: 'A', description: '', activeForm: '' } },
        { type: 'tool_use', id: 't2', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } },
      ]),
      { type: 'user', sessionId: 'sess-1', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'ok' }, { type: 'tool_result', tool_use_id: 't2', content: 'ok' },
      ] } },
    ]);
    expect(session.requests[0].todoSnapshot).toEqual([{ id: 1, title: 'A', status: 'completed' }]);
  });
});

describe('claudeCallCostUSD', () => {
  it('prices 5-minute and 1-hour cache writes separately', () => {
    const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 3_000_000,
      cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 2_000_000 } };
    expect(claudeCallCostUSD('claude-opus-5-5', usage)).toBeCloseTo(5 + 2 * 8, 9); // $5 + 2 × $8.
  });

  it('applies fast mode, US-only inference and web search charges', () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 0, speed: 'fast', inference_geo: 'us', server_tool_use: { web_search_requests: 2 } };
    expect(claudeCallCostUSD('claude-opus-5-5', usage)).toBeCloseTo(8 * 1.1 + 0.02, 9);
  });

  it('switches Haiku 5.5 to long-prompt rates above 100k prompt tokens', () => {
    expect(claudeCallCostUSD('claude-haiku-5-5', { input_tokens: 100_000, output_tokens: 0 })).toBeCloseTo(0.01, 9);
    expect(claudeCallCostUSD('claude-haiku-5-5', { input_tokens: 100_001, output_tokens: 0 })).toBeCloseTo(100_001 * 0.5 / 1e6, 9);
  });

  it('returns null for unknown models instead of guessing', () => {
    expect(claudeCallCostUSD('gpt-5.5', { input_tokens: 1 })).toBeNull();
  });
});
