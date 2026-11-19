/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';

// tools.ts imports the VS Code API at module load; vitest runs in node, so stub the pieces it touches.
vi.mock('vscode', () => ({
  LanguageModelToolResult: class { constructor(public parts: unknown[]) {} },
  LanguageModelTextPart: class { constructor(public value: string) {} },
  lm: { registerTool: vi.fn() },
}));

import { TOOL_DEFS } from './tools';

/** Harness names the parsers actually emit; the `harness` filter is an exact match on these. */
const EMITTED_HARNESSES = new Set([
  'Local Agent', 'Local Agent (Insiders)', 'Local Agent (Server)', 'Local Agent (Server Insiders)',
  'GitHub Copilot CLI', 'GitHub Copilot App', 'Claude', 'Codex', 'OpenCode', 'Xcode',
]);

describe('tool input schemas', () => {
  it('only lists harness examples that the parsers emit, since the filter is an exact match', () => {
    const descriptions = TOOL_DEFS
      .map(t => (t.inputSchema as { properties?: Record<string, { description?: string }> }).properties?.harness?.description)
      .filter((d): d is string => typeof d === 'string');
    expect(descriptions.length).toBeGreaterThan(0); // Guard: the schema must still expose the harness filter.

    for (const description of descriptions) {
      const examples = [...description.matchAll(/"([^"]+)"/g)].map(m => m[1]); // Quoted names inside the description.
      expect(examples.length).toBeGreaterThan(0);
      for (const example of examples) expect(EMITTED_HARNESSES).toContain(example);
    }
  });
});
