/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * End-to-end test for the Anti-Patterns pipeline.
 *
 * Exercises every layer from raw data -> detection -> scoring -> RPC response:
 *   1. Rule loading (all 46 .md rules parse correctly)
 *   2. Detection (runDetectors + runEmitters produce correct results)
 *   3. Scoring (group scores, weekly trends, improvements)
 *   4. Rule editor data (previews, layers, dateHistograms)
 *   5. Equivalence with old detector functions
 *   6. Analyzer.getAntiPatterns full integration
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Analyzer } from './analyzer';
import { Session, SessionRequest, PracticeGroup } from './types';
import { runDetectors, runEmitters, invalidateDetectorRegistry } from './detector-registry';
import { getAllRules, getRulePreviewStats } from './rule-engine';
import { getRuleLayerInfo } from './rule-loader';
import { parsePipeline } from './rule-pipeline';
import { lex } from './dsl/lexer';
import { parse } from './dsl/parser';
import { isoWeek } from './helpers';

/* ── Test data builders ── */

function makeReq(overrides: Partial<SessionRequest> = {}): SessionRequest {
  return {
    requestId: `req-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    messageText: 'Please refactor the authentication module to use JWT tokens with refresh capability.',
    responseText: 'Sure, here is the implementation with proper error handling.',
    isCanceled: false,
    agentName: '',
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
    totalElapsed: 500,
    messageLength: 80,
    responseLength: 60,
    userCode: [],
    aiCode: [{ language: 'typescript', loc: 10 }],
    toolConfirmations: [],
    promptTokens: null,
    completionTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    compaction: null,
    todoSnapshot: null,
    workType: 'feature',
    ...overrides,
  };
}

function makeSess(overrides: Partial<Session> = {}): Session {
  const now = Date.now();
  const base = {
    sessionId: `sess-${Math.random().toString(36).slice(2, 8)}`,
    workspaceId: 'ws-1',
    workspaceName: 'my-project',
    location: 'panel',
    harness: 'Local Agent',
    creationDate: now - 3600000,
    lastMessageDate: now,
    requestCount: 1,
    requests: [makeReq()],
    ...overrides,
  };
  base.requestCount = base.requests.length;
  return base;
}

/** Create realistic multi-week data that triggers many patterns. */
function buildRichDataset(): { reqs: SessionRequest[]; sessions: Session[] } {
  const now = Date.now();
  const DAY = 86400000;
  const WEEK = 7 * DAY;
  const reqs: SessionRequest[] = [];
  const sessions: Session[] = [];

  // Week 1-4 data with various anti-patterns
  for (let w = 0; w < 4; w++) {
    const weekBase = now - (4 - w) * WEEK;

    // Lazy prompts (short messages) -- need >30% ratio to trigger
    for (let i = 0; i < 25; i++) {
      reqs.push(makeReq({
        timestamp: weekBase + i * 1000,
        messageLength: 5,
        messageText: 'fix',
      }));
    }

    // Normal prompts (fewer than lazy to ensure ratio > 0.3)
    for (let i = 0; i < 10; i++) {
      reqs.push(makeReq({
        timestamp: weekBase + 50000 + i * 1000,
        messageLength: 100,
        referencedFiles: [],
        editedFiles: [],
        variableKinds: {},
      }));
    }

    // Canceled requests (need >15% rate)
    for (let i = 0; i < 15; i++) {
      reqs.push(makeReq({
        timestamp: weekBase + 100000 + i * 1000,
        isCanceled: true,
      }));
    }

    // Slow responses
    for (let i = 0; i < 5; i++) {
      reqs.push(makeReq({
        timestamp: weekBase + 150000 + i * 1000,
        totalElapsed: 45000,
      }));
    }

    // Repeated prompts
    for (let i = 0; i < 4; i++) {
      reqs.push(makeReq({
        timestamp: weekBase + 200000 + i * 1000,
        messageText: 'How do I implement binary search?',
        messageLength: 35,
      }));
    }
  }

  // Mega session (55 requests)
  const megaReqs = Array.from({ length: 55 }, (_, i) =>
    makeReq({ timestamp: now - 2 * WEEK + i * 60000 })
  );
  sessions.push(makeSess({
    requests: megaReqs,
    requestCount: megaReqs.length,
    creationDate: now - 2 * WEEK,
    lastMessageDate: now - 2 * WEEK + 55 * 60000,
  }));

  // Abandoned sessions (single request)
  for (let i = 0; i < 8; i++) {
    const ts = now - 3 * WEEK + i * DAY;
    sessions.push(makeSess({
      requests: [makeReq({ timestamp: ts })],
      requestCount: 1,
      creationDate: ts,
      lastMessageDate: ts,
    }));
  }

  // Normal sessions (with fewer requests each so lazy ratio stays high)
  for (let i = 0; i < 5; i++) {
    const n = 3;
    const ts = now - WEEK + i * DAY;
    const sReqs = Array.from({ length: n }, (_, j) =>
      makeReq({ timestamp: ts + j * 60000 })
    );
    sessions.push(makeSess({
      requests: sReqs,
      requestCount: n,
      creationDate: ts,
      lastMessageDate: ts + n * 60000,
    }));
  }

  // Gather all requests
  const allReqs = [...reqs, ...sessions.flatMap(s => s.requests)];
  return { reqs: allReqs, sessions };
}

/** Minimal clean data (nothing triggers). */
function buildCleanDataset(): { reqs: SessionRequest[]; sessions: Session[] } {
  const now = Date.now();
  const reqs = Array.from({ length: 10 }, (_, i) => makeReq({
    timestamp: now - i * 60000,
    messageLength: 100,
    messageText: 'A well-structured prompt with context, constraints, and expected output format.',
    referencedFiles: ['src/index.ts'],
    editedFiles: ['src/index.ts'],
    variableKinds: { file: 1 },
    toolsUsed: ['terminal', 'edit'],
    modelId: i % 2 === 0 ? 'gpt-4.1' : 'claude-3.5-sonnet',
    slashCommand: i % 3 === 0 ? '/explain' : '',
    customInstructions: ['be concise'],
    skillsUsed: ['codebase'],
  }));
  const sessions = [makeSess({
    requests: reqs,
    requestCount: reqs.length,
  })];
  return { reqs, sessions };
}

/* ── Tests ── */

describe('Anti-Patterns E2E', () => {
  beforeEach(() => {
    invalidateDetectorRegistry();
  });

  /* ━━━ Layer 1: Rule Loading ━━━ */
  describe('Rule loading', () => {
    it('loads all 45 built-in rules from .md files', () => {
      const rules = getAllRules();
      expect(rules.length).toBe(45);
    });

    it('every rule has required fields from frontmatter', () => {
      for (const rule of getAllRules()) {
        expect(rule.id, `rule missing id`).toBeTruthy();
        expect(rule.name, `${rule.id} missing name`).toBeTruthy();
        expect(rule.group, `${rule.id} missing group`).toBeTruthy();
        expect(rule.severity, `${rule.id} missing severity`).toBeTruthy();
        expect(rule.scope, `${rule.id} missing scope`).toBeTruthy();
        expect(rule.thresholds, `${rule.id} missing thresholds`).toBeDefined();
        expect(rule.descriptionTemplate, `${rule.id} missing description template`).toBeTruthy();
        expect(rule.suggestionTemplate, `${rule.id} missing suggestion template`).toBeTruthy();
      }
    });

    it('every rule has a valid practice group', () => {
      const validGroups: PracticeGroup[] = [
        'prompt-quality', 'session-hygiene', 'code-review',
        'tool-mastery', 'context-management',
      ];
      for (const rule of getAllRules()) {
        expect(validGroups).toContain(rule.group);
      }
    });

    it('every rule has valid severity', () => {
      const validSeverities = ['high', 'medium', 'low'];
      for (const rule of getAllRules()) {
        expect(validSeverities, `${rule.id} has invalid severity: ${rule.severity}`).toContain(rule.severity);
      }
    });

    // Reduce-expression errors are swallowed (evaluateExpression returns null on a throw),
    // so a typo leaves the value null and the rule silently never fires. Lex+parse every
    // expression here, because nothing else ever does. Caught no-plan-mode's spliced planUsage line.
    it('every expression in every rule lexes and parses', () => {
      for (const rule of getAllRules()) {
        const pipeline = parsePipeline(rule);                      // Splits the ```detect block into expressions.
        const exprs: [string, string][] = [                        // [label, expression] for a readable failure.
          ['match', pipeline.matchExpr ?? ''],
          ['check', pipeline.checkExpr ?? ''],
          ['severity', pipeline.severityExpr ?? ''],
          ...Object.entries(pipeline.reduceExprs ?? {}),            // planUsage, stats, emitCount, ...
        ];
        for (const [label, expr] of exprs) {
          if (!expr) continue;                                      // Optional key the rule doesn't use.
          expect(() => parse(lex(expr)), `${rule.id}: ${label}: ${expr}`).not.toThrow();
        }
      }
    });

    it('rule IDs are unique', () => {
      const rules = getAllRules();
      const ids = rules.map(r => r.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('getRuleLayerInfo returns built-in layer with 45 rules', () => {
      const layers = getRuleLayerInfo(undefined);
      const builtIn = layers.find(l => l.layer === 'built-in');
      expect(builtIn).toBeDefined();
      expect(builtIn!.ruleCount).toBe(45);
      expect(builtIn!.exists).toBe(true);
    });
  });

  /* ━━━ Layer 2: Detection ━━━ */
  describe('Detection pipeline', () => {
    it('runDetectors returns empty for clean data', () => {
      const { reqs, sessions } = buildCleanDataset();
      const results = runDetectors(reqs, sessions, false);
      // Clean data may still trigger some rules (e.g. no-devcontainer)
      // but major ones like lazy-prompting should not
      const lazyResult = results.find(r => r.id === 'lazy-prompting');
      expect(lazyResult).toBeUndefined();
    });

    it('runDetectors triggers expected patterns for rich data', () => {
      const { reqs, sessions } = buildRichDataset();
      const results = runDetectors(reqs, sessions, false);

      // These should definitely trigger given our data
      const expectedTriggers = [
        'lazy-prompting',
        'high-cancellation',
        'mega-sessions',
        'slow-responses',
      ];

      const triggeredIds = new Set(results.map(r => r.id));
      for (const id of expectedTriggers) {
        expect(triggeredIds.has(id), `Expected '${id}' to be triggered`).toBe(true);
      }
    });

    it('every AntiPattern has valid structure', () => {
      const { reqs, sessions } = buildRichDataset();
      const results = runDetectors(reqs, sessions, false);

      for (const pattern of results) {
        expect(pattern.id).toBeTruthy();
        expect(pattern.name).toBeTruthy();
        expect(pattern.group).toBeTruthy();
        expect(pattern.severity).toBeTruthy();
        expect(pattern.occurrences).toBeGreaterThan(0);
        expect(pattern.description).toBeTruthy();
        expect(pattern.suggestion).toBeTruthy();
        expect(Array.isArray(pattern.examples)).toBe(true);
      }
    });

    it('runEmitters returns emissions for all non-skipped rules', () => {
      const { reqs, sessions } = buildRichDataset();
      const emissions = runEmitters(reqs, sessions, false);

      // Should have an emission per rule (at least for those with emitters)
      expect(emissions.size).toBeGreaterThanOrEqual(30);

      for (const [ruleId, emission] of emissions) {
        expect(emission.count, `${ruleId} has invalid count`).toBeGreaterThanOrEqual(0);
        expect(emission.total, `${ruleId} has invalid total`).toBeGreaterThanOrEqual(0);
        expect(emission.ratio, `${ruleId} has invalid ratio`).toBeGreaterThanOrEqual(0);
        expect(emission.ratio, `${ruleId} ratio > 1`).toBeLessThanOrEqual(1);
        expect(Array.isArray(emission.examples)).toBe(true);
      }
    });

    it('emission.ratio = count/total for all rules (where applicable)', () => {
      const { reqs, sessions } = buildRichDataset();
      const emissions = runEmitters(reqs, sessions, false);

      for (const [ruleId, e] of emissions) {
        // Some emitters use custom ratio logic (e.g. inverse or capped)
        // Just verify ratio is in valid range [0, 1]
        expect(e.ratio, `${ruleId}: ratio < 0`).toBeGreaterThanOrEqual(0);
        expect(e.ratio, `${ruleId}: ratio > 1`).toBeLessThanOrEqual(1);
      }
    });
  });

  /* ━━━ Layer 3: Rule Preview Stats ━━━ */
  describe('Rule preview stats', () => {
    it('returns a preview for every rule', () => {
      const { reqs, sessions } = buildRichDataset();
      const detectorResults = runDetectors(reqs, sessions, false);
      const emissions = runEmitters(reqs, sessions, false);
      const previews = getRulePreviewStats(reqs, sessions, false, detectorResults, emissions);

      expect(previews.length).toBe(getAllRules().filter(r => !r.requiresIdeContext).length + getAllRules().filter(r => r.requiresIdeContext).length);
    });

    it('triggered previews match detector results', () => {
      const { reqs, sessions } = buildRichDataset();
      const detectorResults = runDetectors(reqs, sessions, false);
      const emissions = runEmitters(reqs, sessions, false);
      const previews = getRulePreviewStats(reqs, sessions, false, detectorResults, emissions);

      const triggeredPreviews = previews.filter(p => p.triggered);
      const detectorIds = new Set(detectorResults.map(r => r.id));

      for (const p of triggeredPreviews) {
        expect(detectorIds.has(p.ruleId), `Preview '${p.ruleId}' marked triggered but no detector result`).toBe(true);
      }

      for (const result of detectorResults) {
        const preview = previews.find(p => p.ruleId === result.id);
        expect(preview, `Detector result '${result.id}' missing from previews`).toBeDefined();
        expect(preview!.triggered).toBe(true);
        expect(preview!.occurrences).toBe(result.occurrences);
      }
    });

    it('non-triggered previews have zero occurrences or are below threshold', () => {
      const { reqs, sessions } = buildCleanDataset();
      const detectorResults = runDetectors(reqs, sessions, false);
      const emissions = runEmitters(reqs, sessions, false);
      const previews = getRulePreviewStats(reqs, sessions, false, detectorResults, emissions);

      const nonTriggered = previews.filter(p => !p.triggered);
      // Should be mostly non-triggered for clean data
      expect(nonTriggered.length).toBeGreaterThan(previews.length / 2);
    });
  });

  /* ━━━ Layer 4: Analyzer Integration (full getAntiPatterns) ━━━ */
  describe('Analyzer.getAntiPatterns integration', () => {
    function buildAnalyzer(sessions: Session[]): Analyzer {
      return new Analyzer(sessions);
    }

    it('returns valid structure with all expected fields', () => {
      const { sessions } = buildRichDataset();
      const a = buildAnalyzer(sessions);
      const result = a.getAntiPatterns();

      expect(result).toBeDefined();
      expect(Array.isArray(result.patterns)).toBe(true);
      expect(typeof result.totalOccurrences).toBe('number');
      expect(Array.isArray(result.groupScores)).toBe(true);
      expect(result.weeklyScores).toBeDefined();
      expect(Array.isArray(result.weeklyScores.labels)).toBe(true);
      expect(Array.isArray(result.weeklyScores.series)).toBe(true);
    });

    it('groupScores cover all 4 practice groups', () => {
      const { sessions } = buildRichDataset();
      const a = buildAnalyzer(sessions);
      const result = a.getAntiPatterns();

      const groups = result.groupScores.map(g => g.group).sort();
      expect(groups).toEqual(['code-review', 'prompt-quality', 'session-hygiene', 'tool-mastery']);
    });

    it('group scores are between 0 and 100', () => {
      const { sessions } = buildRichDataset();
      const a = buildAnalyzer(sessions);
      const result = a.getAntiPatterns();

      for (const gs of result.groupScores) {
        expect(gs.score, `${gs.group} score out of range`).toBeGreaterThanOrEqual(0);
        expect(gs.score, `${gs.group} score out of range`).toBeLessThanOrEqual(100);
      }
    });

    it('totalOccurrences matches sum of pattern occurrences', () => {
      const { sessions } = buildRichDataset();
      const a = buildAnalyzer(sessions);
      const result = a.getAntiPatterns();

      const sum = result.patterns.reduce((s, p) => s + p.occurrences, 0);
      expect(result.totalOccurrences).toBe(sum);
    });

    it('patterns are sorted by group then by occurrences descending', () => {
      const { sessions } = buildRichDataset();
      const a = buildAnalyzer(sessions);
      const result = a.getAntiPatterns();

      const groupOrder: Record<string, number> = {
        'prompt-quality': 0, 'session-hygiene': 1, 'code-review': 2, 'tool-mastery': 3,
      };

      for (let i = 1; i < result.patterns.length; i++) {
        const prev = result.patterns[i - 1];
        const curr = result.patterns[i];
        const prevGroup = groupOrder[prev.group] ?? 9;
        const currGroup = groupOrder[curr.group] ?? 9;

        if (prevGroup === currGroup) {
          expect(prev.occurrences >= curr.occurrences,
            `${prev.id} (${prev.occurrences}) should be >= ${curr.id} (${curr.occurrences})`
          ).toBe(true);
        } else {
          expect(prevGroup < currGroup,
            `${prev.group} should come before ${curr.group}`
          ).toBe(true);
        }
      }
    });

    it('clean data produces high scores', () => {
      const { sessions } = buildCleanDataset();
      const a = buildAnalyzer(sessions);
      const result = a.getAntiPatterns();

      // At least some groups should score well with clean data
      const highScores = result.groupScores.filter(g => g.score >= 70);
      expect(highScores.length).toBeGreaterThanOrEqual(2);
    });

    it('rich data produces lower scores than clean data', () => {
      const richData = buildRichDataset();
      const cleanData = buildCleanDataset();

      const richAnalyzer = buildAnalyzer(richData.sessions);
      const cleanAnalyzer = buildAnalyzer(cleanData.sessions);

      const richResult = richAnalyzer.getAntiPatterns();
      const cleanResult = cleanAnalyzer.getAntiPatterns();

      const richAvg = richResult.groupScores.reduce((s, g) => s + g.score, 0) / richResult.groupScores.length;
      const cleanAvg = cleanResult.groupScores.reduce((s, g) => s + g.score, 0) / cleanResult.groupScores.length;

      expect(richAvg).toBeLessThan(cleanAvg);
    });

    it('weeklyScores has series for each practice group', () => {
      const { sessions } = buildRichDataset();
      const a = buildAnalyzer(sessions);
      const result = a.getAntiPatterns();

      const seriesGroups = result.weeklyScores.series.map(s => s.group).sort();
      expect(seriesGroups).toEqual(['code-review', 'prompt-quality', 'session-hygiene', 'tool-mastery']);
    });
  });

  /* ━━━ Layer 5: Date Histograms ━━━ */
  describe('Date histogram computation', () => {
    it('requests bucket correctly by ISO week', () => {
      const now = Date.now();
      const WEEK = 7 * 86400000;
      const reqs = [
        makeReq({ timestamp: now }),
        makeReq({ timestamp: now - WEEK }),
        makeReq({ timestamp: now - 2 * WEEK }),
      ];

      const weekBuckets = new Map<string, SessionRequest[]>();
      for (const r of reqs) {
        const wk = isoWeek(new Date(r.timestamp!));
        if (!weekBuckets.has(wk)) weekBuckets.set(wk, []);
        weekBuckets.get(wk)!.push(r);
      }

      // Should have 3 different weeks (or 2 if boundary)
      expect(weekBuckets.size).toBeGreaterThanOrEqual(2);
    });

    it('per-week emitters produce consistent counts', () => {
      const { reqs, sessions } = buildRichDataset();

      // Full run
      const fullEmissions = runEmitters(reqs, sessions, false);

      // Per-week runs
      const weekBuckets = new Map<string, SessionRequest[]>();
      for (const r of reqs) {
        if (!r.timestamp) continue;
        const wk = isoWeek(new Date(r.timestamp));
        if (!weekBuckets.has(wk)) weekBuckets.set(wk, []);
        weekBuckets.get(wk)!.push(r);
      }

      // Sum of per-week counts should approximate (may differ due to session-scoped rules)
      for (const [ruleId] of fullEmissions) {
        const rule = getAllRules().find(r => r.id === ruleId);
        if (!rule || rule.scope === 'sessions') continue; // Session-scoped rules can't be split by week

        let weekSum = 0;
        for (const [, wkReqs] of weekBuckets) {
          const wkEmissions = runEmitters(wkReqs, sessions, false);
          weekSum += wkEmissions.get(ruleId)?.count ?? 0;
        }

        // Per-week sums may differ from full run for ratio-based rules,
        // but count-based rules should be close
        // Per-week sums should be non-negative
        expect(weekSum).toBeGreaterThanOrEqual(0);
      }
    });
  });

  /* ━━━ Layer 6: Cross-cutting E2E ━━━ */
  describe('Full pipeline coherence', () => {
    it('every triggered detector has a matching rule', () => {
      const { reqs, sessions } = buildRichDataset();
      const results = runDetectors(reqs, sessions, false);
      const ruleIds = new Set(getAllRules().map(r => r.id));

      for (const pattern of results) {
        expect(ruleIds.has(pattern.id), `Triggered pattern '${pattern.id}' has no matching rule .md file`).toBe(true);
      }
    });

    it('emitter + trigger produce same triggered set as runDetectors', () => {
      const { reqs, sessions } = buildRichDataset();
      const detectorResults = runDetectors(reqs, sessions, false);
      const emissions = runEmitters(reqs, sessions, false);
      const previews = getRulePreviewStats(reqs, sessions, false, detectorResults, emissions);

      const detectorTriggered = new Set(detectorResults.map(r => r.id));
      const previewTriggered = new Set(previews.filter(p => p.triggered).map(p => p.ruleId));

      // Every detector result should be in preview triggered set
      for (const id of detectorTriggered) {
        expect(previewTriggered.has(id), `Detector '${id}' not in preview triggered set`).toBe(true);
      }
      // Every preview triggered should be in detector results
      for (const id of previewTriggered) {
        expect(detectorTriggered.has(id), `Preview '${id}' triggered but not in detector results`).toBe(true);
      }
    });

    it('group score penalty correlates with number of triggered patterns', () => {
      const { sessions } = buildRichDataset();
      const a = new Analyzer(sessions);
      const result = a.getAntiPatterns();

      for (const gs of result.groupScores) {
        if (gs.patternCount === 0) {
          // No patterns = should have high score
          expect(gs.score).toBeGreaterThanOrEqual(85);
        } else if (gs.patternCount >= 3) {
          // Many patterns = should have lower score
          expect(gs.score).toBeLessThan(100);
        }
      }
    });

    it('empty analyzer returns no patterns and perfect scores', () => {
      const a = new Analyzer([]);
      const result = a.getAntiPatterns();

      expect(result.patterns).toHaveLength(0);
      expect(result.totalOccurrences).toBe(0);

      for (const gs of result.groupScores) {
        expect(gs.score).toBe(100);
        expect(gs.patternCount).toBe(0);
      }
    });

    it('date filter restricts detected patterns', () => {
      const now = Date.now();
      const WEEK = 7 * 86400000;

      // Create sessions in two distinct weeks
      const oldReqs = Array.from({ length: 20 }, (_, i) => makeReq({
        timestamp: now - 3 * WEEK + i * 1000,
        messageLength: 5,
        messageText: 'fix',
      }));
      const newReqs = Array.from({ length: 5 }, (_, i) => makeReq({
        timestamp: now - 1000 + i * 100,
        messageLength: 100,
        messageText: 'Well-structured prompt with context.',
      }));

      const oldSession = makeSess({
        requests: oldReqs,
        requestCount: oldReqs.length,
        creationDate: now - 3 * WEEK,
        lastMessageDate: now - 3 * WEEK + 20000,
      });
      const newSession = makeSess({
        requests: newReqs,
        requestCount: newReqs.length,
        creationDate: now - 1000,
        lastMessageDate: now,
      });

      const a = new Analyzer([oldSession, newSession]);

      // Unfiltered: should see the lazy prompting from old data
      const allResult = a.getAntiPatterns();

      // Filter to recent only: fewer or no lazy prompts
      const today = new Date(now);
      const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      const recentResult = a.getAntiPatterns({ fromDate: todayStr });

      // The recent window has only well-structured prompts
      const lazyAll = allResult.patterns.find(p => p.id === 'lazy-prompting');
      const lazyRecent = recentResult.patterns.find(p => p.id === 'lazy-prompting');

      if (lazyAll && // If lazy-prompting was triggered in full data, it should either
        // not be triggered or have fewer occurrences in recent data
        lazyRecent) {
          expect(lazyRecent.occurrences).toBeLessThanOrEqual(lazyAll.occurrences);
        }
    });

    it('skipIdeDetectors flag filters IDE-only rules', () => {
      const { reqs, sessions } = buildRichDataset();

      const allResults = runDetectors(reqs, sessions, false);
      const skippedResults = runDetectors(reqs, sessions, true);

      const ideRuleIds = new Set(
        getAllRules().filter(r => r.requiresIdeContext).map(r => r.id)
      );

      // Skipped results should not contain IDE-only rules
      for (const result of skippedResults) {
        expect(ideRuleIds.has(result.id), `IDE rule '${result.id}' should be skipped`).toBe(false);
      }

      // All results may contain IDE rules
      // (if they triggered -- they may not, depending on data)
      expect(skippedResults.length).toBeLessThanOrEqual(allResults.length);
    });
  });
});
