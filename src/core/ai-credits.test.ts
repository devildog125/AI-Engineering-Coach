/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Tests for AI Credit analytics — verifies that requests missing native token
 * data (input or output) are excluded from credit math and surfaced via
 * `missing` / `missingPct` instead of being silently approximated. */

import { describe, it, expect } from 'vitest';
import { Analyzer } from './analyzer';
import { Session, SessionRequest, BurndownConfig, ModelUsage  } from './types';
import { createRequest, createSession } from './parser-shared';

const BASE_TS = new Date(2025, 5, 15, 10, 0, 0).getTime();

function req(overrides: Partial<SessionRequest> = {}): SessionRequest {
  return createRequest({
    messageText: 'hello',
    responseText: 'world',
    requestId: overrides.requestId ?? `r-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: overrides.timestamp ?? BASE_TS,
    promptTokens: overrides.promptTokens ?? null,
    completionTokens: overrides.completionTokens ?? null,
    modelId: overrides.modelId ?? 'claude-sonnet-4',
    ...overrides,
  });
}

function sess(requests: SessionRequest[]): Session {
  return createSession({
    sessionId: `s-${Math.random().toString(36).slice(2, 8)}`,
    workspaceId: 'ws-1',
    workspaceName: 'proj',
    // All Claude sessions now use the unified 'Claude' harness.
    harness: 'Claude',
    requests,
  });
}

const burndownConfig: BurndownConfig = {
  sku: 'pro',
  customBudget: 1000,
  month: '2025-06',
};

/* ── getAiCredits: missing-token handling ────────────────────────── */

describe('getAiCredits — missing-token handling', () => {
  it('returns countedRequests=0 and missingPct=100 when no requests have native tokens', () => {
    const sessions = [sess([
      req({ requestId: 'a' }),
      req({ requestId: 'b' }),
      req({ requestId: 'c' }),
    ])];
    const a = new Analyzer(sessions);
    const data = a.getAiCredits();
    expect(data.totalRequests).toBe(3);
    expect(data.countedRequests).toBe(0);
    expect(data.missingPct).toBe(100);
    expect(data.totalCredits).toBe(0);
    expect(data.totalInputTokens).toBe(0);
    expect(data.totalOutputTokens).toBe(0);
  });

  it('counts only requests with both input AND output native tokens (output-only is partial)', () => {
    const sessions = [sess([
      req({ requestId: 'full', promptTokens: 1000, completionTokens: 500 }), // counted
      req({ requestId: 'input-only', promptTokens: 1000 }), // missing (no output)
      req({ requestId: 'output-only', completionTokens: 500 }), // partial (output but no input)
      req({ requestId: 'none' }), // missing
    ])];
    const a = new Analyzer(sessions);
    const data = a.getAiCredits();
    expect(data.totalRequests).toBe(4);
    expect(data.countedRequests).toBe(1);
    expect(data.partialRequests).toBe(1);
    expect(data.pendingRequests).toBe(0);
    expect(data.noDataRequests).toBe(0);
    // missingPct denominator excludes pending+noData; partial counts as covered.
    // finalizable=4, covered=counted+partial=2, missing=2 → 50%.
    expect(data.finalizableRequests).toBe(4);
    expect(data.missingPct).toBe(50);
    expect(data.totalInputTokens).toBe(1000);
    // Headline output total reflects only `complete` rows — keeps it
    // consistent with totalCredits (also complete-only). Partial output
    // is surfaced in the per-model breakdown instead.
    expect(data.totalOutputTokens).toBe(500);
    expect(data.totalCredits).toBeGreaterThan(0);
  });

  it('per-model breakdown reports missingPct independently per model', () => {
    const sessions = [sess([
      req({ requestId: 'a1', modelId: 'claude-sonnet-4', promptTokens: 100, completionTokens: 50 }),
      req({ requestId: 'a2', modelId: 'claude-sonnet-4' }), // missing
      req({ requestId: 'b1', modelId: 'gpt-4o', promptTokens: 200, completionTokens: 100 }),
      req({ requestId: 'b2', modelId: 'gpt-4o', promptTokens: 200, completionTokens: 100 }),
    ])];
    const a = new Analyzer(sessions);
    const data = a.getAiCredits();
    expect(data.costByModel['claude-sonnet-4']).toBeDefined();
    expect(data.costByModel['claude-sonnet-4'].requests).toBe(2);
    expect(data.costByModel['claude-sonnet-4'].countedRequests).toBe(1);
    expect(data.costByModel['claude-sonnet-4'].missingPct).toBe(50);
    expect(data.costByModel['gpt-4o']).toBeDefined();
    expect(data.costByModel['gpt-4o'].countedRequests).toBe(2);
    expect(data.costByModel['gpt-4o'].missingPct).toBe(0);
  });

  it('flags top requests with status enum (complete/missing/partial/pending/no-data)', () => {
    const sessions = [sess([
      req({ requestId: 'r1', promptTokens: 5000, completionTokens: 2500 }),
      req({ requestId: 'r2' }),
    ])];
    const a = new Analyzer(sessions);
    const data = a.getAiCredits();
    // top requests are sorted by credits desc; the missing one has 0 credits.
    const counted = data.topRequests.find(t => t.status === 'complete');
    const missing = data.topRequests.find(t => t.status === 'missing');
    expect(counted).toBeDefined();
    expect(missing).toBeDefined();
    expect(counted!.inputTokens).toBe(5000);
    expect(missing!.credits).toBe(0);
  });

  it('avgCreditsPerRequest divides by counted, not total', () => {
    const sessions = [sess([
      req({ requestId: 'r1', promptTokens: 1000, completionTokens: 500 }),
      req({ requestId: 'r2' }), // missing
    ])];
    const a = new Analyzer(sessions);
    const data = a.getAiCredits();
    // avg = totalCredits / countedRequests = totalCredits / 1
    expect(data.avgCreditsPerRequest).toBe(data.totalCredits);
  });
});

/* ── getAiCreditBurndown: missing-token handling ─────────────────── */

describe('getAiCreditBurndown — missing-token handling', () => {
  it('returns status="no-data" when every request in the period is missing tokens', () => {
    const sessions = [sess([
      req({ requestId: 'a', timestamp: new Date(2025, 5, 5).getTime() }),
      req({ requestId: 'b', timestamp: new Date(2025, 5, 10).getTime() }),
    ])];
    const a = new Analyzer(sessions);
    const data = a.getAiCreditBurndown(burndownConfig);
    expect(data.status).toBe('no-data');
    expect(data.countedRequests).toBe(0);
    expect(data.missingPct).toBe(100);
    expect(data.consumed).toBe(0);
  });

  it('returns status="no-data" with a "no requests" message when the period is empty', () => {
    const a = new Analyzer([]);
    const data = a.getAiCreditBurndown(burndownConfig);
    expect(data.status).toBe('no-data');
    expect(data.totalRequests).toBe(0);
    expect(data.countedRequests).toBe(0);
    expect(data.recommendation).toMatch(/No requests/i);
  });

  it('reports partial missingPct when only some requests have tokens', () => {
    const sessions = [sess([
      req({ requestId: 'r1', timestamp: new Date(2025, 5, 5).getTime(), promptTokens: 1000, completionTokens: 500 }),
      req({ requestId: 'r2', timestamp: new Date(2025, 5, 6).getTime() }), // missing
      req({ requestId: 'r3', timestamp: new Date(2025, 5, 7).getTime(), promptTokens: 1000, completionTokens: 500 }),
      req({ requestId: 'r4', timestamp: new Date(2025, 5, 8).getTime() }), // missing
    ])];
    const a = new Analyzer(sessions);
    const data = a.getAiCreditBurndown(burndownConfig);
    expect(data.totalRequests).toBe(4);
    expect(data.countedRequests).toBe(2);
    expect(data.missingPct).toBe(50);
    expect(data.status).not.toBe('no-data');
    expect(data.consumed).toBeGreaterThan(0);
    // Recommendation should warn that values are a lower bound when data is partial
    expect(data.recommendation).toMatch(/lower bound/i);
  });

  it('treats native zero token counts as present (not missing)', () => {
    // A request that the harness reports as having literally 0 prompt and 0
    // completion tokens (e.g. cancelled / errored upstream) should still be
    // counted as having native data — distinct from `null` (absent).
    const sessions = [sess([
      req({ requestId: 'zero', timestamp: new Date(2025, 5, 5).getTime(), promptTokens: 0, completionTokens: 0 }),
      req({ requestId: 'real', timestamp: new Date(2025, 5, 6).getTime(), promptTokens: 1000, completionTokens: 500 }),
    ])];
    const a = new Analyzer(sessions);
    const data = a.getAiCreditBurndown(burndownConfig);
    expect(data.totalRequests).toBe(2);
    expect(data.countedRequests).toBe(2);
    expect(data.missingPct).toBe(0);
  });

  it('only counts a request when both prompt and completion tokens are present', () => {
    const sessions = [sess([
      req({ requestId: 'partial', timestamp: new Date(2025, 5, 5).getTime(), promptTokens: 1000 }), // missing output
    ])];
    const a = new Analyzer(sessions);
    const data = a.getAiCreditBurndown(burndownConfig);
    expect(data.countedRequests).toBe(0);
    expect(data.status).toBe('no-data');
  });

  it('returns status="pending-only" when every request is in-flight', () => {
    // Active session with no end-state finalization yet → all requests
    // classified as 'pending'. This must surface as a distinct status
    // (not the alarming 'no-data') because the data may yet arrive.
    const session = createSession({
      sessionId: 's-pending',
      workspaceId: 'ws-1',
      workspaceName: 'proj',
      harness: 'Claude',
      requests: [
        createRequest({
          messageText: 'hi', responseText: 'in progress',
          requestId: 'p1', timestamp: new Date(2025, 5, 5).getTime(),
          modelId: 'claude-sonnet-4', endState: 'pending',
        }),
        createRequest({
          messageText: 'hi', responseText: 'in progress',
          requestId: 'p2', timestamp: new Date(2025, 5, 6).getTime(),
          modelId: 'claude-sonnet-4', endState: 'pending',
        }),
      ],
    });
    const data = new Analyzer([session]).getAiCreditBurndown(burndownConfig);
    expect(data.status).toBe('pending-only');
    expect(data.pendingRequests).toBe(2);
    expect(data.countedRequests).toBe(0);
    expect(data.missingPct).toBe(0); // pending excluded from finalizable denominator
    expect(data.recommendation).toMatch(/pending|in-flight|may yet/i);
  });

  it('coverageByDay arrays sum to per-bucket totals and have daysInMonth length', () => {
    const sessions = [sess([
      req({ requestId: 'r1', timestamp: new Date(2025, 5, 5).getTime(),  promptTokens: 100, completionTokens: 50 }),  // complete
      req({ requestId: 'r2', timestamp: new Date(2025, 5, 5).getTime(),  completionTokens: 50 }),                     // partial (output-only)
      req({ requestId: 'r3', timestamp: new Date(2025, 5, 10).getTime() }),                                           // missing
      req({ requestId: 'r4', timestamp: new Date(2025, 5, 10).getTime() }),                                           // missing
    ])];
    const data = new Analyzer(sessions).getAiCreditBurndown(burndownConfig);
    expect(data.coverageByDay).toBeDefined();
    expect(data.coverageByDay.complete).toHaveLength(30); // June has 30 days
    const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
    expect(sum(data.coverageByDay.complete)).toBe(1);
    expect(sum(data.coverageByDay.partial)).toBe(1);
    expect(sum(data.coverageByDay.missing)).toBe(2);
    expect(data.coverageByDay.complete[4]).toBe(1); // day 5 → idx 4
    expect(data.coverageByDay.partial[4]).toBe(1);
    expect(data.coverageByDay.missing[9]).toBe(2);  // day 10 → idx 9
  });

  it('exposes finalizableRequests excluding pending and no-data', () => {
    const sessions = [sess([
      req({ requestId: 'r1', timestamp: new Date(2025, 5, 5).getTime(), promptTokens: 100, completionTokens: 50 }), // complete
      req({ requestId: 'r2', timestamp: new Date(2025, 5, 6).getTime() }), // missing
    ])];
    const data = new Analyzer(sessions).getAiCreditBurndown(burndownConfig);
    expect(data.totalRequests).toBe(2);
    expect(data.finalizableRequests).toBe(2);
    expect(data.countedRequests).toBe(1);
    expect(data.missingPct).toBe(50);
  });
});

/* ── getAiCredits: new bucket semantics ──────────────────────────── */

describe('getAiCredits — new bucket semantics', () => {
  it('exposes finalizableRequests = total - pending - noData', () => {
    const session = createSession({
      sessionId: 's-mix',
      workspaceId: 'ws-1',
      workspaceName: 'proj',
      harness: 'Claude',
      requests: [
        createRequest({ messageText: 'a', responseText: 'b', requestId: 'r1',
          timestamp: BASE_TS, modelId: 'claude-sonnet-4',
          promptTokens: 100, completionTokens: 50 }), // complete
        createRequest({ messageText: 'a', responseText: 'b', requestId: 'r2',
          timestamp: BASE_TS, modelId: 'claude-sonnet-4',
          endState: 'pending' }), // pending
        createRequest({ messageText: 'a', responseText: 'b', requestId: 'r3',
          timestamp: BASE_TS, modelId: 'claude-sonnet-4',
          endState: 'no-data' }), // no-data
        createRequest({ messageText: 'a', responseText: 'b', requestId: 'r4',
          timestamp: BASE_TS, modelId: 'claude-sonnet-4' }), // missing
      ],
    });
    const data = new Analyzer([session]).getAiCredits();
    expect(data.totalRequests).toBe(4);
    expect(data.countedRequests).toBe(1);
    expect(data.pendingRequests).toBe(1);
    expect(data.noDataRequests).toBe(1);
    expect(data.finalizableRequests).toBe(2); // 4 - pending - noData
    expect(data.missingPct).toBe(50);          // (2 - 1 - 0)/2 = 50%
  });

  it('per-model row reports missingPct=0 with N/A semantics when all requests are pending', () => {
    // When a model has only pending/no-data rows, finalizable=0 and missingPct
    // must be 0 — the UI is expected to render "N/A" for that case rather
    // than "0% healthy". We just lock the analytical contract here.
    const session = createSession({
      sessionId: 's-allpending',
      workspaceId: 'ws-1',
      workspaceName: 'proj',
      harness: 'Claude',
      requests: [
        createRequest({ messageText: 'a', responseText: 'b', requestId: 'p1',
          timestamp: BASE_TS, modelId: 'claude-sonnet-4', endState: 'pending' }),
        createRequest({ messageText: 'a', responseText: 'b', requestId: 'p2',
          timestamp: BASE_TS, modelId: 'claude-sonnet-4', endState: 'pending' }),
      ],
    });
    const data = new Analyzer([session]).getAiCredits();
    const row = data.costByModel['claude-sonnet-4'];
    expect(row).toBeDefined();
    expect(row.requests).toBe(2);
    expect(row.countedRequests).toBe(0);
    expect(row.partialRequests).toBe(0);
    expect(row.pendingRequests).toBe(2);
    expect(row.finalizableRequests).toBe(0);
    expect(row.missingPct).toBe(0); // UI keys off finalizable=0 to render N/A
  });

  it('per-model output total includes partial output-only rows', () => {
    const sessions = [sess([
      req({ requestId: 'full',  modelId: 'claude-sonnet-4', promptTokens: 100, completionTokens: 50 }),
      req({ requestId: 'outonly', modelId: 'claude-sonnet-4', completionTokens: 75 }), // partial
    ])];
    const data = new Analyzer(sessions).getAiCredits();
    const row = data.costByModel['claude-sonnet-4'];
    expect(row.requests).toBe(2);
    expect(row.countedRequests).toBe(1);
    expect(row.partialRequests).toBe(1);
    // Output total surfaces both the complete and partial rows so the user
    // sees real generation volume even when input is unknown.
    expect(row.outputTokens).toBe(125);
  });
});

/* ── Cache-token billing ─────────────────────────────────────────── */

describe('cache-token billing', () => {
  it('bills cached tokens at the cached rate (much cheaper than input)', () => {
    // claude-sonnet-4: input $3/M, cached $0.30/M, output $15/M.
    // 1M cached tokens should cost ~ same as 100K input tokens.
    const cachedSession = sess([
      req({ modelId: 'claude-sonnet-4', promptTokens: 1_000_000, completionTokens: 0,
            cacheReadTokens: 1_000_000, cacheWriteTokens: 0 }),
    ]);
    const uncachedSession = sess([
      req({ modelId: 'claude-sonnet-4', promptTokens: 1_000_000, completionTokens: 0 }),
    ]);
    const cachedCredits = new Analyzer([cachedSession]).getAiCredits().totalCredits;
    const uncachedCredits = new Analyzer([uncachedSession]).getAiCredits().totalCredits;
    // Cached should be ~10% of uncached for the same prompt size
    expect(cachedCredits).toBeLessThan(uncachedCredits * 0.2);
    expect(cachedCredits).toBeGreaterThan(0);
  });

  it('bills cache-write at the cacheWrite rate (more expensive than read)', () => {
    // claude-sonnet-4: cached $0.30/M, cacheWrite $3.75/M
    const writeSession = sess([
      req({ modelId: 'claude-sonnet-4', promptTokens: 1_000_000, completionTokens: 0,
            cacheReadTokens: 0, cacheWriteTokens: 1_000_000 }),
    ]);
    const readSession = sess([
      req({ modelId: 'claude-sonnet-4', promptTokens: 1_000_000, completionTokens: 0,
            cacheReadTokens: 1_000_000, cacheWriteTokens: 0 }),
    ]);
    const writeCredits = new Analyzer([writeSession]).getAiCredits().totalCredits;
    const readCredits = new Analyzer([readSession]).getAiCredits().totalCredits;
    expect(writeCredits).toBeGreaterThan(readCredits * 5);
  });

  it('aggregates cache totals separately from uncached input', () => {
    const sessions = [sess([
      req({ modelId: 'claude-sonnet-4', promptTokens: 1000, completionTokens: 200,
            cacheReadTokens: 600, cacheWriteTokens: 100 }),
    ])];
    const data = new Analyzer(sessions).getAiCredits();
    expect(data.totalCacheReadTokens).toBe(600);
    expect(data.totalCacheWriteTokens).toBe(100);
    expect(data.costByModel['claude-sonnet-4'].cacheReadTokens).toBe(600);
    expect(data.costByModel['claude-sonnet-4'].cacheWriteTokens).toBe(100);
    expect(data.costByModel['claude-sonnet-4'].uncachedInputTokens).toBe(300);
    expect(data.costByModel['claude-sonnet-4'].inputTokens).toBe(1000);
  });
});

/* ── Session-level billing (Copilot CLI) ─────────────────────────── */


function cliSess(opts: {
  modelUsage: Record<string, ModelUsage>;
  requests: SessionRequest[];
}): Session {
  return {
    ...createSession({
      sessionId: `cli-${Math.random().toString(36).slice(2, 8)}`,
      workspaceId: 'ws-cli',
      workspaceName: 'cli-proj',
      harness: 'GitHub Copilot CLI',
      requests: opts.requests,
    }),
    modelUsage: opts.modelUsage,
  };
}

describe('session-level billing (Copilot CLI shutdown.modelMetrics)', () => {
  it('uses session-level totals as authoritative billing source when present', () => {
    // Per-request only has output tokens (CLI assistant.message). Session-level
    // has the full input + cached + output totals.
    const requests = [
      req({ requestId: 'r1', timestamp: BASE_TS, modelId: 'gpt-5.5', completionTokens: 100 }),
      req({ requestId: 'r2', timestamp: BASE_TS + 1000, modelId: 'gpt-5.5', completionTokens: 300 }),
    ];
    const sessions = [cliSess({
      modelUsage: {
        'gpt-5.5': {
          inputTokens: 4000, outputTokens: 400,
          cacheReadTokens: 6000, cacheWriteTokens: 0,
        },
      },
      requests,
    })];
    const data = new Analyzer(sessions).getAiCredits();
    expect(data.totalRequests).toBe(2);
    expect(data.countedRequests).toBe(2);
    expect(data.missingPct).toBe(0);
    // Totals should match session-level data (within rounding)
    expect(data.totalInputTokens).toBe(10_000); // 4K uncached + 6K cached
    expect(data.totalCacheReadTokens).toBe(6000);
    expect(data.totalOutputTokens).toBe(400);
    expect(data.totalCredits).toBeGreaterThan(0);
  });

  it('attributes session-level totals to requests proportionally to output tokens', () => {
    const requests = [
      req({ requestId: 'small', timestamp: BASE_TS, modelId: 'gpt-5.5', completionTokens: 100 }),
      req({ requestId: 'big',   timestamp: BASE_TS + 1000, modelId: 'gpt-5.5', completionTokens: 300 }),
    ];
    const sessions = [cliSess({
      modelUsage: { 'gpt-5.5': { inputTokens: 4000, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      requests,
    })];
    const data = new Analyzer(sessions).getAiCredits();
    // The "big" request (75% output share) should dominate top-credits
    expect(data.topRequests[0].preview).toBe(requests[1].messageText.slice(0, 80));
    expect(data.topRequests[0].aggregationKind).toBe('session-aggregated');
    // Big request input share = 75% × 4000 = 3000
    expect(data.topRequests[0].inputTokens).toBe(3000);
  });

  it('clips session-level totals to in-range requests when filter excludes some', () => {
    const requests = [
      req({ requestId: 'in1',  timestamp: new Date(2025, 5, 15).getTime(), modelId: 'gpt-5.5', completionTokens: 100 }),
      req({ requestId: 'in2',  timestamp: new Date(2025, 5, 16).getTime(), modelId: 'gpt-5.5', completionTokens: 100 }),
      req({ requestId: 'out',  timestamp: new Date(2025, 5, 20).getTime(), modelId: 'gpt-5.5', completionTokens: 200 }),
    ];
    const sessions = [cliSess({
      modelUsage: { 'gpt-5.5': { inputTokens: 4000, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      requests,
    })];
    // Filter only the first two requests (their share of output = 200/400 = 50%)
    const data = new Analyzer(sessions).getAiCredits({
      fromDate: '2025-06-15', toDate: '2025-06-16',
    });
    expect(data.totalRequests).toBe(2);
    expect(data.countedRequests).toBe(2);
    // 50% of 4000 input tokens
    expect(data.totalInputTokens).toBe(2000);
    expect(data.totalOutputTokens).toBe(200);
  });

  it('falls back to per-request data when session.modelUsage lacks the request model', () => {
    const requests = [
      req({ requestId: 'gpt',    timestamp: BASE_TS, modelId: 'gpt-5.5', completionTokens: 100 }),
      req({ requestId: 'other',  timestamp: BASE_TS + 1000, modelId: 'gpt-4o',
            promptTokens: 1000, completionTokens: 500 }),
    ];
    // session.modelUsage only has gpt-5.5 — gpt-4o request must use its per-request data.
    const sessions = [cliSess({
      modelUsage: { 'gpt-5.5': { inputTokens: 4000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      requests,
    })];
    const data = new Analyzer(sessions).getAiCredits();
    expect(data.countedRequests).toBe(2);
    expect(data.costByModel['gpt-4o'].inputTokens).toBe(1000);
    expect(data.costByModel['gpt-4o'].outputTokens).toBe(500);
    expect(data.costByModel['gpt-5.5'].inputTokens).toBe(4000);
  });

  it('marks session-aggregated rows in topRequests with aggregationKind', () => {
    const requests = [
      req({ requestId: 'r1', timestamp: BASE_TS, modelId: 'gpt-5.5', completionTokens: 100 }),
    ];
    const sessions = [cliSess({
      modelUsage: { 'gpt-5.5': { inputTokens: 4000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      requests,
    })];
    const data = new Analyzer(sessions).getAiCredits();
    expect(data.topRequests[0].aggregationKind).toBe('session-aggregated');
  });

  it('non-CLI sessions get aggregationKind="exact"', () => {
    const sessions = [sess([
      req({ requestId: 'r1', promptTokens: 1000, completionTokens: 500 }),
    ])];
    const data = new Analyzer(sessions).getAiCredits();
    expect(data.topRequests[0].aggregationKind).toBe('exact');
  });
});

/* ── getAiCredits: dailyTokensByWorkspace ────────────────────────── */

describe('getAiCredits — dailyTokensByWorkspace', () => {
  const DAY1 = new Date(2025, 5, 15, 10, 0, 0).getTime();
  const DAY2 = new Date(2025, 5, 16, 14, 0, 0).getTime();

  function sessWs(wsName: string, requests: SessionRequest[]): Session {
    return createSession({
      sessionId: `s-${Math.random().toString(36).slice(2, 8)}`,
      workspaceId: wsName,
      workspaceName: wsName,
      harness: 'Claude',
      requests,
    });
  }

  it('returns dailyTokensByWorkspace with labels matching daily.labels', () => {
    const sessions = [sessWs('proj-a', [
      req({ requestId: 'r1', timestamp: DAY1, promptTokens: 1000, completionTokens: 500 }),
    ])];
    const data = new Analyzer(sessions).getAiCredits();
    expect(data.dailyTokensByWorkspace).toBeDefined();
    expect(data.dailyTokensByWorkspace.labels).toEqual(data.daily.labels);
  });

  it('accumulates tokens per workspace per day', () => {
    const sessions = [
      sessWs('proj-a', [
        req({ requestId: 'a1', timestamp: DAY1, promptTokens: 1000, completionTokens: 500 }),
        req({ requestId: 'a2', timestamp: DAY2, promptTokens: 2000, completionTokens: 800 }),
      ]),
      sessWs('proj-b', [
        req({ requestId: 'b1', timestamp: DAY1, promptTokens: 3000, completionTokens: 1000 }),
      ]),
    ];
    const data = new Analyzer(sessions).getAiCredits();
    const ws = data.dailyTokensByWorkspace;
    expect(Object.keys(ws.byWorkspace).sort()).toEqual(['proj-a', 'proj-b']);
    // proj-a day1: 1000+500=1500, day2: 2000+800=2800
    const aDay1Idx = ws.labels.indexOf('2025-06-15');
    const aDay2Idx = ws.labels.indexOf('2025-06-16');
    expect(aDay1Idx).toBeGreaterThanOrEqual(0);
    expect(aDay2Idx).toBeGreaterThanOrEqual(0);
    expect(ws.byWorkspace['proj-a'][aDay1Idx]).toBe(1500);
    expect(ws.byWorkspace['proj-a'][aDay2Idx]).toBe(2800);
    // proj-b day1: 3000+1000=4000, day2: 0
    expect(ws.byWorkspace['proj-b'][aDay1Idx]).toBe(4000);
    expect(ws.byWorkspace['proj-b'][aDay2Idx]).toBe(0);
  });

  it('excludes requests without complete billing data', () => {
    const sessions = [sessWs('proj-a', [
      req({ requestId: 'complete', timestamp: DAY1, promptTokens: 1000, completionTokens: 500 }),
      req({ requestId: 'missing', timestamp: DAY1 }), // no tokens
    ])];
    const data = new Analyzer(sessions).getAiCredits();
    const ws = data.dailyTokensByWorkspace;
    const dayIdx = ws.labels.indexOf('2025-06-15');
    // Only the complete request's tokens should appear
    expect(ws.byWorkspace['proj-a'][dayIdx]).toBe(1500);
  });
});

/* ── getAiCredits: Claude Code exact cost and background calls ────── */

describe('getAiCredits — Claude Code list-price cost', () => {
  it('uses the per-request USD cost, marks unknown prices, and adds background calls under their own model', () => {
    const priced = req({ requestId: 'p', modelId: 'claude-opus-5-5', promptTokens: 100, completionTokens: 30, costUSD: 0.5 });
    const unknown = req({ requestId: 'u', modelId: 'claude-new-9', promptTokens: 100, completionTokens: 10, costUSD: null });
    const session = sess([priced, unknown]);
    // Claude Code's own report: Haiku 5.5 was only used by hidden background calls.
    session.harnessCostReport = {
      totalCostUSD: 0.6,
      hasUnknownModelCost: false,
      backgroundModels: ['claude-haiku-5.5'],
      models: { 'claude-haiku-5.5': { inputTokens: 40, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 0.1 } },
    };
    const data = new Analyzer([session]).getAiCredits();
    // $0.50 exact + $0.10 background = 60 credits; the unknown-price request adds nothing.
    expect(data.totalCredits).toBeCloseTo(60, 6);
    expect(data.unpricedRequests).toBe(1);
    expect(data.costByModel['claude-opus-5.5'].credits).toBeCloseTo(50, 6);
    expect(data.costByModel['claude-new-9'].unpricedRequests).toBe(1);
    expect(data.costByModel['claude-haiku-5.5'].credits).toBeCloseTo(10, 6);
    expect(data.costByModel['claude-haiku-5.5'].requests).toBe(0);  // Background calls are not user requests.
  });
});
