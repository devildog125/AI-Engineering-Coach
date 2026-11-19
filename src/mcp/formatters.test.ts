/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { Analyzer } from '../core/analyzer';
import { formatWorkflows } from './formatters';

describe('formatWorkflows', () => {
  it('passes the cluster cancel rate through as the percent the analyzer already computed', () => {
    // analyzer-workflows returns cancelRate as a 0–100 whole number; the formatter must not rescale it.
    const cluster = {
      id: 'c1', label: 'fix tests', canonicalPrompt: 'fix the failing tests', occurrences: 4, sessions: 3,
      workspaces: ['ws'], harnesses: ['Claude'], cancelRate: 25, skillDraft: '',
    };
    const analyzer = {
      getWorkflowOptimization: () => ({ clusters: [cluster], totalRepetitions: 4, estimatedTimeSavedMins: 10, topWorkspaces: [] }),
    } as unknown as Analyzer; // Stub: only the one method the formatter calls.

    expect(formatWorkflows(analyzer).topClusters[0].cancelRate).toBe(25);
  });
});
