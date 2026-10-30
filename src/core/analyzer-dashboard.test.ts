/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest';
import { DashboardAnalyzer } from './analyzer-dashboard';
import { Session, SessionRequest } from './types/session-types';

function makeRequest(overrides: Partial<SessionRequest> = {}): SessionRequest {
  return {
    requestId: 'req-' + Math.random().toString(36).slice(2, 8),
    timestamp: Date.now(),
    messageText: 'test message',
    responseText: 'test response',
    isCanceled: false,
    agentName: 'Copilot',
    agentMode: 'chat',
    modelId: 'gpt-4.1',
    toolsUsed: [],
    editedFiles: [],
    referencedFiles: [],
    slashCommand: '',
    variableKinds: {},
    customInstructions: [],
    skillsUsed: [],
    firstProgress: 100,
    totalElapsed: 2000,
    messageLength: 12,
    responseLength: 13,
    userCode: [],
    aiCode: [{ language: 'typescript', loc: 10 }],
    toolConfirmations: [],
    promptTokens: null,
    completionTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    compaction: null,
    todoSnapshot: null,
    workType: 'other',
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  const now = Date.now();
  const base: Session = {
    sessionId: 'sess-' + Math.random().toString(36).slice(2, 8),
    workspaceId: 'ws-1',
    workspaceName: 'my-project',
    location: '/projects/my-project',
    harness: 'Local Agent',
    creationDate: now - 3600000,
    lastMessageDate: now,
    requestCount: 1,
    requests: [makeRequest()],
    ...overrides,
  };
  base.requestCount = base.requests.length;
  return base;
}

function createAnalyzer(sessions: Session[]): DashboardAnalyzer {
  return new DashboardAnalyzer(sessions, new Map());
}

describe('DashboardAnalyzer', () => {
  describe('getStats', () => {
    it('returns correct totals', () => {
      const sessions = [
        makeSession({ sessionId: 's1', workspaceName: 'a', requests: [makeRequest(), makeRequest()] }),
        makeSession({ sessionId: 's2', workspaceName: 'b' }),
      ];
      const analyzer = createAnalyzer(sessions);
      const stats = analyzer.getStats();
      expect(stats.totalSessions).toBe(2);
      expect(stats.totalWorkspaces).toBe(2);
      expect(stats.totalRequests).toBe(3);
    });

    it('counts cancelled requests and distinct models and tools across sessions', () => {
      const sessions = [
        makeSession({ sessionId: 's1', requests: [
          makeRequest({ isCanceled: true, modelId: 'gpt-4.1', toolsUsed: ['Read', 'Edit'] }),
          makeRequest({ modelId: 'claude-sonnet', toolsUsed: ['Edit', 'Bash'] }),
        ] }),
        makeSession({ sessionId: 's2', requests: [makeRequest({ modelId: '', toolsUsed: [] })] }), // Blank model is not a model.
      ];
      const stats = createAnalyzer(sessions).getStats();
      expect(stats.totalCanceled).toBe(1);
      expect(stats.uniqueModels).toBe(2);
      expect(stats.uniqueTools).toBe(3);
    });

    it('handles empty input', () => {
      const analyzer = createAnalyzer([]);
      const stats = analyzer.getStats();
      expect(stats.totalSessions).toBe(0);
    });
  });

  describe('getWorkspaces', () => {
    it('returns unique workspaces', () => {
      const now = Date.now();
      const sessions = [
        makeSession({ workspaceName: 'proj-a', requests: [makeRequest({ timestamp: now })], lastMessageDate: now }),
        makeSession({ workspaceName: 'proj-a', requests: [makeRequest({ timestamp: now - 1000 })], lastMessageDate: now - 1000 }),
        makeSession({ workspaceName: 'proj-b', requests: [makeRequest({ timestamp: now - 2000 })], lastMessageDate: now - 2000 }),
      ];
      const analyzer = createAnalyzer(sessions);
      const ws = analyzer.getWorkspaces();
      const names = new Set(ws.map(w => w.name));
      expect(names.size).toBe(2);
    });

    it('marks recent workspaces', () => {
      const now = Date.now();
      const sessions = [
        makeSession({ workspaceName: 'recent-project', requests: [makeRequest({ timestamp: now })], lastMessageDate: now }),
      ];
      const analyzer = createAnalyzer(sessions);
      const ws = analyzer.getWorkspaces();
      expect(ws.some(w => w.recent)).toBe(true);
    });

    it('includes harnesses per workspace', () => {
      const now = Date.now();
      const sessions = [
        makeSession({ workspaceName: 'proj', harness: 'Local Agent', lastMessageDate: now }),
        makeSession({ workspaceName: 'proj', harness: 'Claude', lastMessageDate: now }),
      ];
      const analyzer = createAnalyzer(sessions);
      const ws = analyzer.getWorkspaces();
      const proj = ws.find(w => w.name === 'proj');
      expect(proj?.harnesses).toContain('Local Agent');
      expect(proj?.harnesses).toContain('Claude');
    });
  });

  describe('getHarnesses', () => {
    it('returns unique harnesses sorted', () => {
      const sessions = [
        makeSession({ harness: 'Local Agent' }),
        makeSession({ harness: 'Claude' }),
        makeSession({ harness: 'Local Agent' }),
      ];
      const analyzer = createAnalyzer(sessions);
      const harnesses = analyzer.getHarnesses();
      expect(harnesses).toEqual(['Claude', 'Local Agent']);
    });
  });

  describe('getHarnessBreakdown', () => {
    it('returns breakdown by harness', () => {
      const now = Date.now();
      const sessions = [
        makeSession({ harness: 'Local Agent', requests: [makeRequest({ timestamp: now }), makeRequest({ timestamp: now + 1000 })], lastMessageDate: now }),
        makeSession({ harness: 'Claude', requests: [makeRequest({ timestamp: now })], lastMessageDate: now }),
      ];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getHarnessBreakdown();
      expect(result.labels).toContain('Local Agent');
      expect(result.labels).toContain('Claude');
      expect(result.sessions.length).toBe(2);
      expect(result.requests.length).toBe(2);
    });
  });

  describe('getDailyActivity', () => {
    it('returns empty for no sessions', () => {
      const analyzer = createAnalyzer([]);
      const result = analyzer.getDailyActivity();
      expect(result.labels).toEqual([]);
      expect(result.values).toEqual([]);
    });

    it('groups activity by day', () => {
      const day1 = new Date('2024-03-15T10:00:00').getTime();
      const day2 = new Date('2024-03-16T10:00:00').getTime();
      const sessions = [
        makeSession({
          requests: [
            makeRequest({ timestamp: day1 }),
            makeRequest({ timestamp: day1 + 60000 }),
          ],
          lastMessageDate: day1 + 60000,
        }),
        makeSession({
          requests: [makeRequest({ timestamp: day2 })],
          lastMessageDate: day2,
        }),
      ];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getDailyActivity();
      expect(result.labels).toHaveLength(2);
      expect(result.values[0]).toBe(2); // 2 reqs on day 1
      expect(result.values[1]).toBe(1); // 1 req on day 2
    });

    it('tracks LOC per day', () => {
      const day1 = new Date('2024-03-15T10:00:00').getTime();
      const sessions = [
        makeSession({
          requests: [makeRequest({ timestamp: day1, aiCode: [{ language: 'ts', loc: 25 }] })],
          lastMessageDate: day1,
        }),
      ];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getDailyActivity();
      expect(result.loc[0]).toBe(25);
    });

    it('breaks down by harness', () => {
      const day1 = new Date('2024-03-15T10:00:00').getTime();
      const sessions = [
        makeSession({ harness: 'Local Agent', requests: [makeRequest({ timestamp: day1 })], lastMessageDate: day1 }),
        makeSession({ harness: 'Claude', requests: [makeRequest({ timestamp: day1 })], lastMessageDate: day1 }),
      ];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getDailyActivity();
      expect(result.byHarness.length).toBe(2);
    });
  });

  describe('getWorkspaceBreakdown', () => {
    it('returns top workspaces by request count', () => {
      const now = Date.now();
      const sessions = [
        makeSession({ workspaceName: 'big-project', requests: [makeRequest({ timestamp: now }), makeRequest({ timestamp: now + 1000 }), makeRequest({ timestamp: now + 2000 })], lastMessageDate: now }),
        makeSession({ workspaceName: 'small-project', requests: [makeRequest({ timestamp: now })], lastMessageDate: now }),
      ];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getWorkspaceBreakdown();
      expect(result.labels[0]).toBe('big-project');
      expect(result.values[0]).toBe(3);
    });
  });

  describe('getHourlyDistribution', () => {
    it('returns 24-hour distribution', () => {
      const ts = new Date('2024-03-15T14:30:00').getTime();
      const sessions = [
        makeSession({
          requests: [makeRequest({ timestamp: ts })],
          lastMessageDate: ts,
        }),
      ];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getHourlyDistribution();
      expect(result.hours).toHaveLength(24);
      expect(result.hours[14]).toBe(1);
    });

    it('breaks down by work type', () => {
      const ts = new Date('2024-03-15T10:00:00').getTime();
      const sessions = [
        makeSession({
          requests: [makeRequest({ timestamp: ts, workType: 'feature' })],
          lastMessageDate: ts,
        }),
      ];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getHourlyDistribution();
      expect(result.byType).toHaveProperty('feature');
    });
  });

  describe('getHeatmap', () => {
    it('returns 7x24 grid', () => {
      const ts = new Date('2024-03-15T14:30:00').getTime(); // Friday
      const sessions = [
        makeSession({
          requests: [makeRequest({ timestamp: ts })],
          lastMessageDate: ts,
        }),
      ];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getHeatmap();
      expect(result.heatmap).toHaveLength(7);
      expect(result.heatmap[0]).toHaveLength(24);
      // Friday = day 5
      expect(result.heatmap[5][14]).toBe(1);
    });

    it('includes focus heatmap', () => {
      const ts = new Date('2024-03-15T14:00:00').getTime();
      const sessions = [
        makeSession({
          requests: [
            makeRequest({ timestamp: ts }),
            makeRequest({ timestamp: ts + 60000 }),
          ],
          lastMessageDate: ts + 60000,
        }),
      ];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getHeatmap();
      expect(result.focusHeatmap).toHaveLength(7);
    });
  });

  describe('getCalendarActivity', () => {
    it('returns empty for no data', () => {
      const analyzer = createAnalyzer([]);
      const result = analyzer.getCalendarActivity();
      expect(result.days).toEqual([]);
      expect(result.maxRequests).toBe(0);
    });

    it('computes per-day activity with focus score', () => {
      const ts = new Date('2024-03-15T10:00:00').getTime();
      const sessions = [
        makeSession({
          requests: [
            makeRequest({ timestamp: ts }),
            makeRequest({ timestamp: ts + 300000 }), // 5 min later
            makeRequest({ timestamp: ts + 600000 }), // 10 min later
          ],
          lastMessageDate: ts + 600000,
        }),
      ];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getCalendarActivity();
      expect(result.days).toHaveLength(1);
      expect(result.days[0].requests).toBe(3);
      expect(result.days[0].focusScore).toBeGreaterThan(0);
      expect(result.maxRequests).toBe(3);
    });
  });

  describe('getHarnessComparison', () => {
    it('returns comparison data for multiple harnesses', () => {
      const ts = new Date('2024-03-15T10:00:00').getTime();
      const sessions = [
        makeSession({ harness: 'Local Agent', requests: [makeRequest({ timestamp: ts }), makeRequest({ timestamp: ts + 1000 })], lastMessageDate: ts }),
        makeSession({ harness: 'Claude', requests: [makeRequest({ timestamp: ts })], lastMessageDate: ts }),
      ];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getHarnessComparison();
      expect(result.harnesses).toHaveLength(2);
      expect(result.harnesses[0].requests).toBeGreaterThanOrEqual(1);
      expect(result.dailyByHarness.labels.length).toBeGreaterThan(0);
    });

    it('computes per-harness metrics', () => {
      const ts = new Date('2024-03-15T10:00:00').getTime();
      const sessions = [
        makeSession({
          harness: 'Local Agent',
          requests: [
            makeRequest({ timestamp: ts, modelId: 'gpt-4.1', totalElapsed: 5000, responseLength: 200 }),
          ],
          lastMessageDate: ts,
        }),
      ];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getHarnessComparison();
      const item = result.harnesses[0];
      expect(item.harness).toBe('Local Agent');
      expect(item.avgElapsed).toBe(5000);
      expect(item.avgResponseLength).toBe(200);
      expect(item.topModels.length).toBeGreaterThan(0);
    });
  });

  describe('getParserCoverage', () => {
    it('returns field coverage matrix', () => {
      const ts = new Date('2024-03-15T10:00:00').getTime();
      const sessions = [
        makeSession({
          harness: 'Local Agent',
          requests: [makeRequest({ timestamp: ts, modelId: 'gpt-4.1' })],
          lastMessageDate: ts,
        }),
      ];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getParserCoverage();
      expect(result.fields.length).toBeGreaterThan(0);
      expect(result.harnesses).toContain('Local Agent');
      expect(result.matrix['modelId']['Local Agent'].populated).toBe(1);
    });
  });

  describe('getParserPreview', () => {
    it('returns preview samples per harness', () => {
      const ts = new Date('2024-03-15T10:00:00').getTime();
      const sessions = [
        makeSession({
          harness: 'Local Agent',
          requests: [makeRequest({ timestamp: ts, modelId: 'gpt-4.1' })],
          lastMessageDate: ts,
        }),
      ];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getParserPreview();
      expect(result.samples).toHaveLength(1);
      expect(result.samples[0].harness).toBe('Local Agent');
      expect(result.samples[0].fields['modelId'].populated).toBe(true);
    });

    it('respects focusField parameter', () => {
      const ts = new Date('2024-03-15T10:00:00').getTime();
      const sessions = [
        makeSession({
          harness: 'Local Agent',
          requests: [
            makeRequest({ timestamp: ts, modelId: '' }),
            makeRequest({ timestamp: ts + 1000, modelId: 'gpt-4.1' }),
          ],
          lastMessageDate: ts + 1000,
        }),
      ];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getParserPreview('modelId');
      expect(result.samples[0].fields['modelId'].populated).toBe(true);
    });
  });

  describe('getProjectOverview (not on DashboardAnalyzer)', () => {
    // getProjectOverview is on PatternsAnalyzer, tested in analyzer-patterns.test.ts
    it('placeholder - covered in patterns tests', () => {
      expect(true).toBe(true);
    });
  });
});
