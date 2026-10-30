/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigAnalyzer } from './analyzer-config';
import type { ConfigFileInfo, Session, SessionRequest, Workspace } from './types';
import * as helpers from './config-health-helpers';

vi.mock('./config-health-helpers', () => ({
  resolveWorkspaceRoot: vi.fn(() => '/fake/root'),
  isCloudPath: vi.fn(() => false),
  scanConfigFiles: vi.fn(() => []),
  scanPersonalSkillFiles: vi.fn(() => []),
  analyzeHookCoverage: vi.fn(() => null),
  computeProgressiveDisclosureScore: vi.fn(() => 50),
  computeInstructionQualityScore: vi.fn(() => 60),
  generateWorkspaceSuggestions: vi.fn(() => []),
  safeFileExists: vi.fn(() => false),
  buildFileTree: vi.fn(() => []),
  readSnippet: vi.fn(() => ''),
}));

const resolveWorkspaceRootMock = vi.mocked(helpers.resolveWorkspaceRoot);
const scanConfigFilesMock = vi.mocked(helpers.scanConfigFiles);
const scanPersonalSkillFilesMock = vi.mocked(helpers.scanPersonalSkillFiles);
const analyzeHookCoverageMock = vi.mocked(helpers.analyzeHookCoverage);
const computeProgressiveDisclosureScoreMock = vi.mocked(helpers.computeProgressiveDisclosureScore);
const computeInstructionQualityScoreMock = vi.mocked(helpers.computeInstructionQualityScore);
const generateWorkspaceSuggestionsMock = vi.mocked(helpers.generateWorkspaceSuggestions);
const safeFileExistsMock = vi.mocked(helpers.safeFileExists);
const buildFileTreeMock = vi.mocked(helpers.buildFileTree);
const readSnippetMock = vi.mocked(helpers.readSnippet);

const ONE_DAY = 24 * 60 * 60 * 1000;

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'sess-1',
    workspaceId: 'ws-1',
    workspaceName: 'TestProject',
    harness: 'VS Code',
    requests: [],
    requestCount: 0,
    creationDate: Date.now(),
    lastMessageDate: Date.now(),
    ...overrides,
  } as Session;
}

function makeRequest(overrides: Partial<SessionRequest> = {}): SessionRequest {
  return {
    requestId: 'req-1',
    messageLength: 50,
    responseLength: 200,
    messageText: 'test',
    responseText: 'response',
    referencedFiles: [],
    customInstructions: [],
    skillsUsed: [],
    toolsUsed: [],
    variableKinds: {},
    agentMode: 'agent',
    modelId: 'gpt-4',
    isCanceled: false,
    editedFiles: [],
    timestamp: Date.now(),
    totalElapsed: 1000,
    ...overrides,
  } as unknown as SessionRequest;
}

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    name: 'TestProject',
    path: '/fake/root/ws-1',
    ...overrides,
  } as Workspace;
}

function makeConfigFile(overrides: Partial<ConfigFileInfo> = {}): ConfigFileInfo {
  return {
    relativePath: '.github/copilot-instructions.md',
    kind: 'instruction',
    lines: 10,
    chars: 100,
    isMarkdown: true,
    markdownIssues: [],
    sizeVerdict: 'compact',
    lastModified: Date.now(),
    ...overrides,
  };
}

function makeRequests(count: number, factory?: (index: number) => Partial<SessionRequest>): SessionRequest[] {
  return Array.from({ length: count }, (_, index) => makeRequest({
    requestId: `req-${index + 1}`,
    timestamp: Date.now() + index,
    ...(factory?.(index) ?? {}),
  }));
}

function makeAnalyzer(sessions: Session[] = [], workspaces: Workspace[] = []): ConfigAnalyzer {
  return new ConfigAnalyzer(
    sessions,
    new Map(),
    new Map(workspaces.map(workspace => [workspace.id, workspace])),
  );
}

beforeEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  resolveWorkspaceRootMock.mockImplementation((wsId, ws) => ws.path ?? `/fake/root/${wsId}`);
  scanConfigFilesMock.mockImplementation(() => []);
  scanPersonalSkillFilesMock.mockImplementation(() => []);
  analyzeHookCoverageMock.mockImplementation(() => null);
  computeProgressiveDisclosureScoreMock.mockImplementation(() => 50);
  computeInstructionQualityScoreMock.mockImplementation(() => 60);
  generateWorkspaceSuggestionsMock.mockImplementation(() => []);
  safeFileExistsMock.mockImplementation(() => false);
  buildFileTreeMock.mockImplementation(() => '');
  readSnippetMock.mockImplementation(() => '');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ConfigAnalyzer', () => {
  it('creates ConfigAnalyzer with sessions and workspaces', () => {
    const session = makeSession({ requestCount: 60, requests: [makeRequest()] });
    const workspace = makeWorkspace();

    const analyzer = makeAnalyzer([session], [workspace]);

    expect(analyzer).toBeInstanceOf(ConfigAnalyzer);
    expect(typeof analyzer.getConfigHealth).toBe('function');
  });

  it('returns a valid empty data structure when there are no sessions', () => {
    const result = makeAnalyzer([], []).getConfigHealth();

    expect(result).toEqual({
      workspaces: [],
      overallScore: 0,
      agenticReadiness: { score: 0, signals: [] },
      contextProvisionByHarness: {},
      suggestions: [],
      contextAntiPatterns: [],
    });
  });

  it('returns workspace health for workspaces represented in active sessions', () => {
    const sessions = [
      makeSession({ sessionId: 'sess-1', workspaceId: 'ws-1', workspaceName: 'Alpha', requestCount: 60, requests: [makeRequest()] }),
      makeSession({ sessionId: 'sess-2', workspaceId: 'ws-2', workspaceName: 'Beta', requestCount: 75, requests: [makeRequest({ requestId: 'req-2' })] }),
    ];
    const workspaces = [
      makeWorkspace({ id: 'ws-1', name: 'Alpha', path: '/fake/root/ws-1' }),
      makeWorkspace({ id: 'ws-2', name: 'Beta', path: '/fake/root/ws-2' }),
    ];

    const result = makeAnalyzer(sessions, workspaces).getConfigHealth();

    expect(result.workspaces.map(workspace => workspace.workspaceId)).toEqual(['ws-2', 'ws-1']);
    expect(result.workspaces.map(workspace => workspace.workspaceName)).toEqual(['Beta', 'Alpha']);
  });

  it('maps config file kinds and helper scores into workspace health', () => {
    const configFiles = [
      makeConfigFile({ relativePath: 'CLAUDE.md', kind: 'claude-md' }),
      makeConfigFile({ relativePath: '.github/prompts/fix.prompt.md', kind: 'prompt' }),
      makeConfigFile({ relativePath: '.github/agents/reviewer.md', kind: 'agent' }),
      makeConfigFile({ relativePath: '.github/skills/review/SKILL.md', kind: 'skill' }),
    ];
    scanConfigFilesMock.mockReturnValue(configFiles);
    analyzeHookCoverageMock.mockReturnValue({
      hasPreToolUse: true,
      hasPostToolUse: true,
      hasSessionStart: false,
      hasPermissionRequest: false,
      totalHooks: 2,
      hookEvents: ['PreToolUse', 'PostToolUse'],
    });
    computeProgressiveDisclosureScoreMock.mockReturnValue(77);
    computeInstructionQualityScoreMock.mockReturnValue(88);
    generateWorkspaceSuggestionsMock.mockReturnValue(['Add more examples']);

    const result = makeAnalyzer(
      [makeSession({ workspaceId: 'claude-ws-1', workspaceName: 'ClaudeProject', requestCount: 60, requests: [makeRequest()] })],
      [makeWorkspace({ id: 'claude-ws-1', name: 'ClaudeProject', path: '/fake/root/claude-ws-1' })],
    ).getConfigHealth();

    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces[0]).toMatchObject({
      workspaceId: 'claude-ws-1',
      hasInstructions: true,
      hasPrompts: true,
      hasAgents: true,
      hasSkills: true,
      hasHooks: true,
      progressiveDisclosureScore: 77,
      instructionQualityScore: 88,
      suggestions: ['Add more examples'],
    });
    expect(result.workspaces[0].hookCoverage?.totalHooks).toBe(2);
  });

  it('computes the overall score from config, provision, and quality scores', () => {
    computeProgressiveDisclosureScoreMock.mockReturnValue(80);
    computeInstructionQualityScoreMock.mockReturnValue(60);

    const session = makeSession({
      requestCount: 60,
      requests: [makeRequest({
        referencedFiles: ['src/index.ts'],
        customInstructions: ['follow tests'],
        skillsUsed: ['review'],
        toolsUsed: ['grep'],
      })],
    });

    const result = makeAnalyzer([session], [makeWorkspace()]).getConfigHealth();

    expect(result.contextProvisionByHarness['VS Code'].score).toBe(100);
    expect(result.overallScore).toBe(82);
  });

  it('skips inactive workspaces with fewer than 50 requests', () => {
    const result = makeAnalyzer(
      [
        makeSession({ workspaceId: 'ws-1', workspaceName: 'Small', requestCount: 49, requests: [makeRequest()] }),
        makeSession({ workspaceId: 'ws-2', workspaceName: 'Large', requestCount: 50, requests: [makeRequest({ requestId: 'req-2' })] }),
      ],
      [
        makeWorkspace({ id: 'ws-1', name: 'Small', path: '/fake/root/ws-1' }),
        makeWorkspace({ id: 'ws-2', name: 'Large', path: '/fake/root/ws-2' }),
      ],
    ).getConfigHealth();

    expect(result.workspaces.map(workspace => workspace.workspaceId)).toEqual(['ws-2']);
  });

  it('skips workspaces whose last activity is older than the default cutoff', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-30T00:00:00Z'));

    const oldTs = new Date('2024-09-01T00:00:00Z').getTime();
    const recentTs = new Date('2025-01-25T00:00:00Z').getTime();
    const result = makeAnalyzer(
      [
        makeSession({ workspaceId: 'ws-1', workspaceName: 'Old', creationDate: oldTs, lastMessageDate: oldTs, requestCount: 80, requests: [makeRequest({ timestamp: oldTs })] }),
        makeSession({ workspaceId: 'ws-2', workspaceName: 'Recent', creationDate: recentTs, lastMessageDate: recentTs, requestCount: 80, requests: [makeRequest({ requestId: 'req-2', timestamp: recentTs })] }),
      ],
      [
        makeWorkspace({ id: 'ws-1', name: 'Old', path: '/fake/root/ws-1' }),
        makeWorkspace({ id: 'ws-2', name: 'Recent', path: '/fake/root/ws-2' }),
      ],
    ).getConfigHealth();

    expect(result.workspaces.map(workspace => workspace.workspaceId)).toEqual(['ws-2']);
  });

  it('keeps low-activity workspaces when filtered by workspaceId', () => {
    const result = makeAnalyzer(
      [makeSession({ workspaceId: 'ws-1', workspaceName: 'Small', requestCount: 10, requests: [makeRequest()] })],
      [makeWorkspace({ id: 'ws-1', name: 'Small', path: '/fake/root/ws-1' })],
    ).getConfigHealth({ workspaceId: 'ws-1' });

    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces[0].workspaceId).toBe('ws-1');
  });

  it('filters workspace health by workspace id', () => {
    const sessions = [
      makeSession({ workspaceId: 'ws-1', workspaceName: 'Alpha', requestCount: 60, requests: [makeRequest()] }),
      makeSession({ workspaceId: 'ws-2', workspaceName: 'Beta', requestCount: 60, requests: [makeRequest({ requestId: 'req-2' })] }),
    ];
    const workspaces = [
      makeWorkspace({ id: 'ws-1', name: 'Alpha', path: '/fake/root/ws-1' }),
      makeWorkspace({ id: 'ws-2', name: 'Beta', path: '/fake/root/ws-2' }),
    ];

    const result = makeAnalyzer(sessions, workspaces).getConfigHealth({ workspaceId: 'ws-2' });

    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces[0].workspaceId).toBe('ws-2');
  });

  it('filters workspace health by workspace name alias', () => {
    const result = makeAnalyzer(
      [
        makeSession({ workspaceId: 'ws-1', workspaceName: 'Alpha', requestCount: 60, requests: [makeRequest()] }),
        makeSession({ workspaceId: 'ws-2', workspaceName: 'Beta', requestCount: 60, requests: [makeRequest({ requestId: 'req-2' })] }),
      ],
      [
        makeWorkspace({ id: 'ws-1', name: 'Alpha', path: '/fake/root/ws-1' }),
        makeWorkspace({ id: 'ws-2', name: 'Beta', path: '/fake/root/ws-2' }),
      ],
    ).getConfigHealth({ workspaceId: 'Beta' });

    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces[0].workspaceId).toBe('ws-2');
  });

  it('filters workspace health and context provision by harness', () => {
    const result = makeAnalyzer(
      [
        makeSession({ workspaceId: 'ws-1', workspaceName: 'Alpha', harness: 'VS Code', requestCount: 60, requests: [makeRequest()] }),
        makeSession({ workspaceId: 'ws-2', workspaceName: 'Beta', harness: 'Claude Code', requestCount: 60, requests: [makeRequest({ requestId: 'req-2' })] }),
      ],
      [
        makeWorkspace({ id: 'ws-1', name: 'Alpha', path: '/fake/root/ws-1' }),
        makeWorkspace({ id: 'ws-2', name: 'Beta', path: '/fake/root/ws-2' }),
      ],
    ).getConfigHealth({ harness: 'Claude Code' });

    expect(result.workspaces.map(workspace => workspace.workspaceId)).toEqual(['ws-2']);
    expect(Object.keys(result.contextProvisionByHarness)).toEqual(['Claude Code']);
  });

  it('scores context provision metrics per harness', () => {
    const requests = [
      makeRequest({
        requestId: 'req-1',
        referencedFiles: ['src/a.ts'],
        customInstructions: ['follow the test style'],
        skillsUsed: ['review'],
        toolsUsed: ['grep'],
        variableKinds: { file: 1 },
        messageLength: 100,
        responseLength: 200,
        agentMode: 'agent',
      }),
      makeRequest({
        requestId: 'req-2',
        messageLength: 50,
        responseLength: 100,
        isCanceled: true,
        agentMode: 'chat',
      }),
    ];

    const result = makeAnalyzer(
      [makeSession({ requestCount: 60, requests })],
      [makeWorkspace()],
    ).getConfigHealth();

    expect(result.contextProvisionByHarness['VS Code']).toMatchObject({
      totalRequests: 2,
      withFileRefs: 1,
      withCustomInstructions: 1,
      withSkills: 1,
      withTools: 1,
      avgContextItems: 2,
      totalSessions: 1,
      avgRequestsPerSession: 2,
      avgPromptLength: 75,
      avgResponseLength: 150,
      cancelRate: 50,
      agentModeRate: 50,
      score: 50,
    });
    expect(result.contextProvisionByHarness['VS Code'].modeDistribution).toEqual([
      { mode: 'agent', count: 1 },
      { mode: 'chat', count: 1 },
    ]);
    expect(result.contextProvisionByHarness['VS Code'].topModels).toEqual([{ model: 'gpt-4', count: 2 }]);
    expect(result.contextProvisionByHarness['VS Code'].topTools).toEqual([{ tool: 'grep', count: 1 }]);
    expect(result.contextProvisionByHarness['VS Code'].topReferencedFiles).toEqual([{ file: 'src/a.ts', count: 1 }]);
  });

  it('separates context provision by harness type', () => {
    const result = makeAnalyzer(
      [
        makeSession({ harness: 'VS Code', workspaceId: 'ws-1', requestCount: 60, requests: [makeRequest({ requestId: 'req-1', referencedFiles: ['a.ts'] })] }),
        makeSession({ harness: 'Claude Code', workspaceId: 'ws-2', workspaceName: 'Claude', requestCount: 60, requests: [makeRequest({ requestId: 'req-2', customInstructions: ['stay concise'] })] }),
      ],
      [
        makeWorkspace({ id: 'ws-1', name: 'VS', path: '/fake/root/ws-1' }),
        makeWorkspace({ id: 'ws-2', name: 'Claude', path: '/fake/root/ws-2' }),
      ],
    ).getConfigHealth();

    expect(result.contextProvisionByHarness['VS Code'].totalRequests).toBe(1);
    expect(result.contextProvisionByHarness['Claude Code'].totalRequests).toBe(1);
  });

  it('limits context provision to the selected workspace filter', () => {
    const result = makeAnalyzer(
      [
        makeSession({ workspaceId: 'ws-1', workspaceName: 'Alpha', requestCount: 60, requests: [makeRequest({ requestId: 'req-1', referencedFiles: ['a.ts'] })] }),
        makeSession({ workspaceId: 'ws-2', workspaceName: 'Beta', requestCount: 60, requests: [makeRequest({ requestId: 'req-2' }), makeRequest({ requestId: 'req-3' })] }),
      ],
      [
        makeWorkspace({ id: 'ws-1', name: 'Alpha', path: '/fake/root/ws-1' }),
        makeWorkspace({ id: 'ws-2', name: 'Beta', path: '/fake/root/ws-2' }),
      ],
    ).getConfigHealth({ workspaceId: 'ws-1' });

    expect(result.contextProvisionByHarness['VS Code'].totalRequests).toBe(1);
  });

  it('computes agentic readiness signals from workspace config presence', () => {
    scanConfigFilesMock.mockReturnValue([
      makeConfigFile({ kind: 'instruction' }),
      makeConfigFile({ relativePath: '.github/prompts/fix.prompt.md', kind: 'prompt' }),
      makeConfigFile({ relativePath: '.github/agents/reviewer.md', kind: 'agent' }),
      makeConfigFile({ relativePath: '.github/skills/review/SKILL.md', kind: 'skill' }),
    ]);
    analyzeHookCoverageMock.mockReturnValue({
      hasPreToolUse: true,
      hasPostToolUse: false,
      hasSessionStart: false,
      hasPermissionRequest: false,
      totalHooks: 1,
      hookEvents: ['PreToolUse'],
    });
    safeFileExistsMock.mockImplementation(filePath => filePath.includes('.devcontainer') || filePath.includes('mcp.json'));

    const result = makeAnalyzer(
      [makeSession({ workspaceId: 'claude-ws-1', requestCount: 60, requests: [makeRequest()] })],
      [makeWorkspace({ id: 'claude-ws-1', path: '/fake/root/claude-ws-1' })],
    ).getConfigHealth();

    expect(result.agenticReadiness.score).toBe(100);
    expect(result.agenticReadiness.signals.every(signal => signal.present)).toBe(true);
  });

  it('counts personal skill files toward agentic readiness', () => {
    scanConfigFilesMock.mockReturnValue([makeConfigFile({ kind: 'instruction' })]);
    scanPersonalSkillFilesMock.mockReturnValue([makeConfigFile({ relativePath: '~/.agents/skill/SKILL.md', kind: 'skill' })]);

    const result = makeAnalyzer(
      [makeSession({ requestCount: 60, requests: [makeRequest()] })],
      [makeWorkspace()],
    ).getConfigHealth();

    const skillsSignal = result.agenticReadiness.signals.find(signal => signal.id === 'skills');
    expect(skillsSignal?.present).toBe(true);
    expect(skillsSignal?.detail).toContain('personal custom skill file');
  });

  it('marks freshness as missing when a workspace has stale or absent context', () => {
    scanConfigFilesMock.mockReturnValue([]);

    const result = makeAnalyzer(
      [makeSession({ requestCount: 120, requests: [makeRequest()] })],
      [makeWorkspace()],
    ).getConfigHealth();

    const freshnessSignal = result.agenticReadiness.signals.find(signal => signal.id === 'freshness');
    expect(result.workspaces[0].staleContext).toBe(true);
    expect(freshnessSignal?.present).toBe(false);
  });

  it('generates an anti-pattern for active workspaces without context files', () => {
    scanConfigFilesMock.mockReturnValue([]);

    const result = makeAnalyzer(
      [makeSession({ workspaceName: 'NoContext', requestCount: 120, requests: [makeRequest()] })],
      [makeWorkspace({ name: 'NoContext' })],
    ).getConfigHealth();

    const pattern = result.contextAntiPatterns.find(item => item.id === 'no-context-files');
    expect(pattern).toBeDefined();
    expect(pattern?.occurrences).toBe(1);
    expect(pattern?.examples).toEqual(['NoContext (120 requests, VS Code)']);
  });

  it('generates a low-context-provision anti-pattern for weak harness context', () => {
    const requests = makeRequests(50);
    const result = makeAnalyzer(
      [makeSession({ requestCount: 60, requests })],
      [makeWorkspace()],
    ).getConfigHealth();

    const pattern = result.contextAntiPatterns.find(item => item.id === 'low-context-provision-vs-code');
    expect(result.contextProvisionByHarness['VS Code'].score).toBe(0);
    expect(pattern).toBeDefined();
    expect(pattern?.occurrences).toBe(50);
    expect(pattern?.severity).toBe('medium');
  });

  it('generates a stale-context-files anti-pattern for old config files', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-30T00:00:00Z'));
    scanConfigFilesMock.mockReturnValue([
      makeConfigFile({ lastModified: Date.now() - 20 * ONE_DAY }),
    ]);

    const now = Date.now();
    const result = makeAnalyzer(
      [makeSession({ requestCount: 80, creationDate: now, lastMessageDate: now, requests: [makeRequest({ timestamp: now })] })],
      [makeWorkspace()],
    ).getConfigHealth();

    const pattern = result.contextAntiPatterns.find(item => item.id === 'stale-context-files');
    expect(pattern).toBeDefined();
    expect(pattern?.examples).toEqual(['TestProject: context files 20 days old']);
  });

  it('deduplicates workspaces that resolve to the same root path', () => {
    const result = makeAnalyzer(
      [
        makeSession({ workspaceId: 'ws-1', workspaceName: 'Alpha', requestCount: 60, requests: [makeRequest({ requestId: 'req-1' })] }),
        makeSession({ workspaceId: 'ws-2', workspaceName: 'Beta', requestCount: 80, requests: [makeRequest({ requestId: 'req-2' })] }),
      ],
      [
        makeWorkspace({ id: 'ws-1', name: 'Alpha', path: '/shared/root' }),
        makeWorkspace({ id: 'ws-2', name: 'Beta', path: '/shared/root' }),
      ],
    ).getConfigHealth();

    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces[0].requestCount).toBe(140);
    expect(result.workspaces[0].sessionCount).toBe(2);
  });

  it('merges harness names and keeps the latest activity when deduplicating', () => {
    const olderTs = Date.now() - ONE_DAY;
    const newerTs = Date.now();
    const result = makeAnalyzer(
      [
        makeSession({ workspaceId: 'ws-1', workspaceName: 'Alpha', harness: 'VS Code', requestCount: 70, creationDate: olderTs, lastMessageDate: olderTs, requests: [makeRequest({ requestId: 'req-1', timestamp: olderTs })] }),
        makeSession({ workspaceId: 'ws-2', workspaceName: 'Beta', harness: 'Claude Code', requestCount: 60, creationDate: newerTs, lastMessageDate: newerTs, requests: [makeRequest({ requestId: 'req-2', timestamp: newerTs })] }),
      ],
      [
        makeWorkspace({ id: 'ws-1', name: 'Alpha', path: '/shared/root' }),
        makeWorkspace({ id: 'ws-2', name: 'Beta', path: '/shared/root' }),
      ],
    ).getConfigHealth();

    expect(result.workspaces[0].harness).toBe('VS Code, Claude Code');
    expect(result.workspaces[0].lastActivity).toBe(newerTs);
  });

  it('keeps both harnesses\' suggestions and the Claude hook coverage when deduplicating', () => {
    generateWorkspaceSuggestionsMock.mockImplementation((_f, _h, isClaude) => isClaude ? ['claude tip'] : ['copilot tip']);
    analyzeHookCoverageMock.mockImplementation(() => ({ hasPreToolUse: true, hasPostToolUse: false, hasSessionStart: false, hasPermissionRequest: false, totalHooks: 1, hookEvents: ['PreToolUse'] }));
    const result = makeAnalyzer(
      [
        makeSession({ workspaceId: 'ws-1', workspaceName: 'Alpha', harness: 'VS Code', requestCount: 70, requests: [makeRequest({ requestId: 'req-1' })] }),
        makeSession({ workspaceId: 'claude-2', workspaceName: 'Alpha', harness: 'Claude', requestCount: 60, requests: [makeRequest({ requestId: 'req-2' })] }),
      ],
      [
        makeWorkspace({ id: 'ws-1', name: 'Alpha', path: '/shared/root' }),
        makeWorkspace({ id: 'claude-2', name: 'Alpha', path: '/shared/root' }),
      ],
    ).getConfigHealth();

    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces[0].suggestions).toEqual(['copilot tip', 'claude tip']); // Neither harness's advice is dropped.
    expect(result.workspaces[0].hookCoverage).not.toBeNull();                       // Hooks come from the Claude entry.
  });

  it('workspace activity honours the harness filter and reports the dominant harness', () => {
    const sessions = [
      makeSession({ sessionId: 's1', workspaceId: 'ws-1', harness: 'Local Agent', requestCount: 60, requests: makeRequests(60) }),
      makeSession({ sessionId: 's2', workspaceId: 'ws-1', harness: 'Claude', requestCount: 60, requests: makeRequests(60) }),
      makeSession({ sessionId: 's3', workspaceId: 'ws-1', harness: 'Claude', requestCount: 60, requests: makeRequests(60) }),
    ];
    const all = makeAnalyzer(sessions, [makeWorkspace()]).getConfigHealth();
    expect(all.workspaces[0].harness).toBe('Claude');              // Two of three sessions, not the first seen.
    expect(all.workspaces[0].sessionCount).toBe(3);
    const onlyLocal = makeAnalyzer(sessions, [makeWorkspace()]).getConfigHealth({ harness: 'Local Agent' });
    expect(onlyLocal.workspaces[0].sessionCount).toBe(1);          // The filter now reaches activity counts.
  });

  it('flags config files as stale when they are older than 14 days and activity is newer', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-30T00:00:00Z'));
    const modifiedAt = Date.now() - 30 * ONE_DAY;
    scanConfigFilesMock.mockReturnValue([makeConfigFile({ lastModified: modifiedAt })]);

    const now = Date.now();
    const result = makeAnalyzer(
      [makeSession({ requestCount: 70, creationDate: now, lastMessageDate: now, requests: [makeRequest({ timestamp: now })] })],
      [makeWorkspace()],
    ).getConfigHealth();

    expect(result.workspaces[0].staleContext).toBe(true);
    expect(result.workspaces[0].staleDays).toBe(30);
  });

  it('marks very active workspaces with no config files as stale', () => {
    scanConfigFilesMock.mockReturnValue([]);

    const result = makeAnalyzer(
      [makeSession({ requestCount: 100, requests: [makeRequest()] })],
      [makeWorkspace()],
    ).getConfigHealth();

    expect(result.workspaces[0].staleContext).toBe(true);
    expect(result.workspaces[0].staleDays).toBeNull();
  });

  it('does not flag context as stale when files were updated recently', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-30T00:00:00Z'));
    scanConfigFilesMock.mockReturnValue([
      makeConfigFile({ lastModified: Date.now() - 7 * ONE_DAY }),
    ]);

    const now = Date.now();
    const result = makeAnalyzer(
      [makeSession({ requestCount: 70, creationDate: now, lastMessageDate: now, requests: [makeRequest({ timestamp: now })] })],
      [makeWorkspace()],
    ).getConfigHealth();

    expect(result.workspaces[0].staleContext).toBe(false);
    expect(result.workspaces[0].staleDays).toBeNull();
  });

  it('does not skip workspaces whose resolved root is a cloud path', () => {
    const result = makeAnalyzer(
      [makeSession({ requestCount: 60, requests: [makeRequest()] })],
      [makeWorkspace()],
    ).getConfigHealth();

    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces[0].workspaceId).toBe('ws-1');
  });
});
