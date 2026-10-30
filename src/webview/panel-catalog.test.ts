/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ANTHROPIC_RAW_BASE, CATALOG_BASE, classifyAnthropicLicense, clearCatalogCache, getAnthropicSkillFiles, getCatalogItems, installedClaudeSkillNames } from './panel-catalog';

const SKILLS_URL = `${CATALOG_BASE}/data/skills.json`;
const AGENTS_URL = `${CATALOG_BASE}/data/agents.json`;
const INSTRUCTIONS_URL = `${CATALOG_BASE}/data/instructions.json`;
// Anthropic's repo listing; most tests answer it with an empty tree so only awesome-copilot items appear.
const ANTHROPIC_TREE_URL = 'https://api.github.com/repos/anthropics/skills/git/trees/main?recursive=1';
const ANTHROPIC_TREE_INIT = { redirect: 'error', headers: { Accept: 'application/vnd.github+json' } };

const skill = {
  id: 'testing',
  title: ' Testing Skill ',
  description: ' Run focused tests. ',
  path: 'skills/testing',
  skillFile: 'skills/testing/SKILL.md',
};
const agent = {
  id: 'reviewer',
  title: 'Code Reviewer',
  description: 'Review code.',
  path: 'agents/reviewer.agent.md',
  category: ' Testing ',
};
const instruction = {
  id: 'typescript',
  title: 'TypeScript',
  description: '',
  path: 'instructions/typescript.instructions.md',
};

const feeds = new Map<string, unknown>();
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  clearCatalogCache();
  fetchMock.mockReset();
  feeds.clear();
  feeds.set(SKILLS_URL, { items: [skill], filters: {} });
  feeds.set(AGENTS_URL, { items: [agent] });
  feeds.set(INSTRUCTIONS_URL, { items: [instruction] });
  feeds.set(ANTHROPIC_TREE_URL, { tree: [] });
  fetchMock.mockImplementation(input => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!feeds.has(url)) throw new Error(`Unexpected catalog request: ${url}`);
    const body = feeds.get(url);
    // Plain-text files (SKILL.md, LICENSE.txt) are stored as strings; feeds as JSON.
    return Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body)));
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);
});

afterEach(() => {
  clearCatalogCache();
  vi.restoreAllMocks();
});

describe('community catalog feeds', () => {
  it('normalizes all supported kinds and uses the skill file rather than its directory', async () => {
    const items = await getCatalogItems();
    expect(items).toEqual([
      {
        kind: 'skill', id: 'skill:skills/testing/SKILL.md',
        title: 'Testing Skill', description: 'Run focused tests.', category: '',
        path: 'skills/testing/SKILL.md',
        url: 'https://github.com/github/awesome-copilot/blob/main/skills/testing/SKILL.md',
        source: 'awesome-copilot',
      },
      {
        kind: 'agent', id: 'agent:agents/reviewer.agent.md',
        title: 'Code Reviewer', description: 'Review code.', category: 'Testing',
        path: 'agents/reviewer.agent.md',
        url: 'https://github.com/github/awesome-copilot/blob/main/agents/reviewer.agent.md',
        source: 'awesome-copilot',
      },
      {
        kind: 'instruction', id: 'instruction:instructions/typescript.instructions.md',
        title: 'TypeScript', description: '', category: '',
        path: 'instructions/typescript.instructions.md',
        url: 'https://github.com/github/awesome-copilot/blob/main/instructions/typescript.instructions.md',
        source: 'awesome-copilot',
      },
    ]);
    expect(fetchMock.mock.calls).toEqual([
      [SKILLS_URL, { redirect: 'error' }],
      [AGENTS_URL, { redirect: 'error' }],
      [INSTRUCTIONS_URL, { redirect: 'error' }],
      [ANTHROPIC_TREE_URL, ANTHROPIC_TREE_INIT],
    ]);
  });

  it('shares concurrent requests and caches a successful result until cleared', async () => {
    const [first, second] = await Promise.all([getCatalogItems(), getCatalogItems()]);
    expect(second).toBe(first);
    expect(await getCatalogItems()).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    clearCatalogCache();
    expect(await getCatalogItems()).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it('reports an HTTP failure and allows a later attempt to succeed', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Unavailable', { status: 503 }));
    await expect(getCatalogItems()).rejects.toThrow('Failed to fetch skills catalog: HTTP 503');
    await expect(getCatalogItems()).resolves.toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it('retries a failed network request instead of retaining its rejected promise', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network unavailable'));
    await expect(getCatalogItems()).rejects.toThrow('Network unavailable');
    await expect(getCatalogItems()).resolves.toHaveLength(3);
  });

  it('reports invalid JSON instead of returning an empty catalog', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>Catalog moved</html>'));
    await expect(getCatalogItems()).rejects.toThrow('Invalid skills catalog JSON');
    await expect(getCatalogItems()).resolves.toHaveLength(3);
  });

  it.each([null, [], {}, { items: null }, { items: {} }])('rejects an invalid feed shape: %j', async data => {
    feeds.set(SKILLS_URL, data);
    await expect(getCatalogItems()).rejects.toThrow('Invalid skills catalog format');
  });

  it('reports an empty feed and does not cache the failure', async () => {
    feeds.set(SKILLS_URL, { items: [] });
    await expect(getCatalogItems()).rejects.toThrow('The skills catalog is empty');
    feeds.set(SKILLS_URL, { items: [skill] });
    await expect(getCatalogItems()).resolves.toHaveLength(3);
  });

  it.each([
    null,
    [],
    {},
    { ...skill, title: '' },
    { ...skill, title: ' ' },
    { ...skill, title: 7 },
    { ...skill, description: null },
    { ...skill, category: [] },
  ])('rejects malformed entries instead of silently omitting them: %j', async item => {
    feeds.set(SKILLS_URL, { items: [item] });
    await expect(getCatalogItems()).rejects.toThrow('Invalid skills catalog item 1');
  });

  it.each([
    undefined,
    'skills/testing',
    'agents/testing.md',
    'skills/../testing.md',
    'skills/./testing.md',
    'skills//testing.md',
    'skills\\testing\\SKILL.md',
    'skills/%2e%2e/testing.md',
    'skills/testing.md?download=true',
    'skills/testing.md#section',
    'https://example.com/testing.md',
  ])('rejects invalid install paths: %s', async skillFile => {
    feeds.set(SKILLS_URL, { items: [{ ...skill, skillFile }] });
    await expect(getCatalogItems()).rejects.toThrow('Invalid markdown path in skills catalog item 1');
  });

  it('validates agent and instruction paths as well as skill paths', async () => {
    feeds.set(AGENTS_URL, { items: [{ ...agent, path: 'skills/testing/SKILL.md' }] });
    await expect(getCatalogItems()).rejects.toThrow('Invalid markdown path in agents catalog item 1');
    feeds.set(AGENTS_URL, { items: [agent] });
    feeds.set(INSTRUCTIONS_URL, { items: [{ ...instruction, path: 'instructions/../testing.md' }] });
    await expect(getCatalogItems()).rejects.toThrow('Invalid markdown path in instructions catalog item 1');
  });

  it('keeps the response byte limit for declared and streamed sizes', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', {
      headers: { 'content-length': String(5 * 1024 * 1024 + 1) },
    }));
    await expect(getCatalogItems()).rejects.toThrow('Catalog feed too large');
    fetchMock.mockResolvedValueOnce(new Response(' '.repeat(5 * 1024 * 1024 + 1)));
    await expect(getCatalogItems()).rejects.toThrow('Catalog feed too large');
    await expect(getCatalogItems()).resolves.toHaveLength(3);
  });

  it('does not let a response from before a reload replace the current cache', async () => {
    let finish = (_response: Response) => {};
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    const previous = getCatalogItems();
    clearCatalogCache();
    const current = await getCatalogItems();
    finish(new Response(JSON.stringify({ items: [{ ...skill, title: 'Old skill' }] })));
    expect((await previous)[0].title).toBe('Old skill');
    expect(await getCatalogItems()).toBe(current);
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it('does not let an older failure clear a newer pending request', async () => {
    let fail = (_error: Error) => {};
    let finish = (_response: Response) => {};
    fetchMock.mockImplementationOnce(() => new Promise<Response>((_resolve, reject) => { fail = reject; }));
    const previous = getCatalogItems();
    const rejected = expect(previous).rejects.toThrow('Old request failed');
    clearCatalogCache();
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    const current = getCatalogItems();
    fail(new Error('Old request failed'));
    await rejected;
    const concurrent = getCatalogItems();
    finish(new Response(JSON.stringify({ items: [skill] })));
    const [first, second] = await Promise.all([current, concurrent]);
    expect(first).toBe(second);
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });
});

describe("Anthropic's skills repo", () => {
  /** Serve a one-skill repo: tree listing plus that skill's SKILL.md and LICENSE.txt. */
  function serveAnthropicSkill(license: string, licenseText: string): void {
    feeds.set(ANTHROPIC_TREE_URL, { tree: [
      { type: 'blob', path: 'skills/pdf/SKILL.md' },
      { type: 'blob', path: 'skills/pdf/LICENSE.txt' },
      { type: 'blob', path: 'skills/pdf/scripts/fill.py' },
      { type: 'blob', path: 'skills/../evil/SKILL.md' },        // Unsafe path: must be ignored.
      { type: 'blob', path: 'README.md' },                      // Outside skills/: ignored.
    ] });
    feeds.set(`${ANTHROPIC_RAW_BASE}skills/pdf/SKILL.md`, `---\nname: pdf\ndescription: Work with PDFs.\nlicense: ${license}\n---\nBody`);
    feeds.set(`${ANTHROPIC_RAW_BASE}skills/pdf/LICENSE.txt`, licenseText);
  }

  it('lists each skill with its license and remembers its files for install', async () => {
    serveAnthropicSkill('Complete terms in LICENSE.txt', '   Apache License\n   Version 2.0');
    const items = await getCatalogItems();
    expect(items.find(item => item.source === 'anthropic')).toEqual({
      kind: 'skill', id: 'anthropic:skills/pdf', title: 'pdf', description: 'Work with PDFs.',
      category: 'Anthropic', path: 'skills/pdf/SKILL.md', url: 'https://github.com/anthropics/skills/tree/main/skills/pdf',
      source: 'anthropic', license: 'Apache-2.0', proprietary: false,
    });
    expect(getAnthropicSkillFiles('pdf')).toEqual(['skills/pdf/SKILL.md', 'skills/pdf/LICENSE.txt', 'skills/pdf/scripts/fill.py']);
  });

  it('flags proprietary skills', async () => {
    serveAnthropicSkill('Proprietary. LICENSE.txt has complete terms', 'LICENSE: Use of these materials ...');
    const item = (await getCatalogItems()).find(entry => entry.source === 'anthropic');
    expect(item).toMatchObject({ license: 'Proprietary', proprietary: true });
  });

  it('keeps the awesome-copilot catalog when GitHub is unreachable', async () => {
    feeds.delete(ANTHROPIC_TREE_URL);                           // Mock throws for unknown URLs.
    expect(await getCatalogItems()).toHaveLength(3);
  });

  it('treats unrecognized license text as not open source', () => {
    expect(classifyAnthropicLicense('', 'Custom terms')).toEqual({ license: 'See LICENSE.txt', proprietary: true });
  });
});

describe('installedClaudeSkillNames', () => {
  it('finds personal and plugin skills but ignores the plugin trash', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-home-'));
    const addSkill = (...parts: string[]): void => {
      fs.mkdirSync(path.join(home, '.claude', ...parts), { recursive: true });
      fs.writeFileSync(path.join(home, '.claude', ...parts, 'SKILL.md'), '---\nname: x\n---');
    };
    addSkill('skills', 'Review');                                       // Personal skill.
    addSkill('plugins', 'marketplaces', 'acme', 'skills', 'deploy');    // Plugin skill.
    addSkill('plugins', '.trash', 'old', 'skills', 'gone');             // Uninstalled plugin.
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      expect([...installedClaudeSkillNames()].sort()).toEqual(['deploy', 'review']);
    } finally {
      process.env.HOME = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
