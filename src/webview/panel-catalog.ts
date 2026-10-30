/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { readTextWithByteLimit } from './fetch-utils';
import type { CatalogSource } from '../core/types';

export const CATALOG_BASE = 'https://awesome-copilot.github.com';

const CATALOG_FEED_MAX_BYTES = 5 * 1024 * 1024;

const CATALOG_FEEDS = [
  { slug: 'skills', kind: 'skill' },
  { slug: 'agents', kind: 'agent' },
  { slug: 'instructions', kind: 'instruction' },
] as const;

type CatalogFeed = typeof CATALOG_FEEDS[number];

export interface RawCatalogItem {
  kind: 'skill' | 'agent' | 'instruction' | 'hook';
  id: string;
  title: string;
  description: string;
  category: string;
  path: string;
  url: string;
  /** Which catalog the item came from. */
  source: CatalogSource;
  /** Short license label (Anthropic skills only; awesome-copilot is MIT as a repo). */
  license?: string;
  /** True when the license is not open source. */
  proprietary?: boolean;
}

let catalogCache: RawCatalogItem[] | undefined;
let catalogPromise: Promise<RawCatalogItem[]> | undefined;

function isCatalogRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCatalogItem(item: unknown, feed: CatalogFeed, index: number): RawCatalogItem {
  if (!isCatalogRecord(item)
    || typeof item.title !== 'string' || !item.title.trim()
    || typeof item.description !== 'string'
    || (item.category !== undefined && typeof item.category !== 'string')) {
    throw new Error(`Invalid ${feed.slug} catalog item ${index + 1}`);
  }

  const catalogPath = feed.kind === 'skill' ? item.skillFile : item.path;
  if (typeof catalogPath !== 'string'
    || !catalogPath.startsWith(`${feed.slug}/`)
    || !catalogPath.endsWith('.md')
    || !catalogPath.split('/').every(segment => segment !== '.' && segment !== '..' && /^[A-Za-z0-9._-]+$/.test(segment))) {
    throw new Error(`Invalid markdown path in ${feed.slug} catalog item ${index + 1}`);
  }

  return {
    kind: feed.kind,
    id: `${feed.kind}:${catalogPath}`,
    title: item.title.trim(),
    description: item.description.trim(),
    category: typeof item.category === 'string' ? item.category.trim() : '',
    path: catalogPath,
    url: `https://github.com/github/awesome-copilot/blob/main/${catalogPath}`,
    source: 'awesome-copilot',
  };
}

async function fetchCatalogFeed(feed: CatalogFeed): Promise<RawCatalogItem[]> {
  const response = await fetch(`${CATALOG_BASE}/data/${feed.slug}.json`, { redirect: 'error' });
  if (!response.ok) throw new Error(`Failed to fetch ${feed.slug} catalog: HTTP ${response.status}`);
  const text = await readTextWithByteLimit(response, CATALOG_FEED_MAX_BYTES, 'Catalog feed too large');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error: unknown) {
    throw new Error(`Invalid ${feed.slug} catalog JSON`, { cause: error });
  }
  if (!isCatalogRecord(data) || !Array.isArray(data.items)) {
    throw new Error(`Invalid ${feed.slug} catalog format: expected an items array`);
  }
  if (data.items.length === 0) {
    throw new Error(`The ${feed.slug} catalog is empty. The catalog format may have changed.`);
  }
  return data.items.map((item: unknown, index: number) => parseCatalogItem(item, feed, index));
}

/* ---- Anthropic's official skills repo (github.com/anthropics/skills) ---- */

/** Git tree of the repo: one request lists every skill folder and file. */
const ANTHROPIC_TREE_URL = 'https://api.github.com/repos/anthropics/skills/git/trees/main?recursive=1';
/** Raw file host for the repo; every download is checked against this prefix. */
export const ANTHROPIC_RAW_BASE = 'https://raw.githubusercontent.com/anthropics/skills/main/';
const ANTHROPIC_TREE_MAX_BYTES = 5 * 1024 * 1024;                  // Whole-repo tree listing.
const ANTHROPIC_TEXT_MAX_BYTES = 512 * 1024;                       // One SKILL.md or LICENSE.txt.
/** Only `skills/<name>/...` with safe segments; `name` must be a plain folder name. */
const ANTHROPIC_SKILL_PATH = /^skills\/([A-Za-z0-9._-]+)\/(.+)$/;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Files of each Anthropic skill folder (repo-relative paths), filled when the catalog loads. */
const anthropicSkillFiles = new Map<string, string[]>();

/** Files to download when installing an Anthropic skill.
 *  @param skillName folder name under `skills/`
 *  @returns repo-relative file paths, or undefined when the catalog hasn't listed this skill */
export function getAnthropicSkillFiles(skillName: string): string[] | undefined {
  return anthropicSkillFiles.get(skillName);
}

/** Read `key: value` lines from a SKILL.md YAML frontmatter block.
 *  Exists because the catalog only needs name/description/license, not a YAML parser. */
function parseFrontmatterFields(markdown: string): Record<string, string> {
  const match = /^---\s*\n([\s\S]*?)\n---/.exec(markdown);     // Leading frontmatter only.
  const fields: Record<string, string> = {};
  for (const line of (match?.[1] ?? '').split('\n')) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);               // Top-level scalar keys.
    if (kv) fields[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, ''); // Strip simple quotes.
  }
  return fields;
}

/** Classify a skill's license from its frontmatter note and LICENSE.txt text.
 *  @returns a short label and whether it is proprietary; "See LICENSE.txt" when unrecognized
 *  Exists so the user sees the license before installing (some Anthropic skills are not open source). */
export function classifyAnthropicLicense(frontmatterLicense: string, licenseText: string): { license: string; proprietary: boolean } {
  if (/proprietary/i.test(frontmatterLicense) || /^\s*LICENSE:\s*Use of these materials/i.test(licenseText)) {
    return { license: 'Proprietary', proprietary: true };          // Governed by the user's agreement with Anthropic.
  }
  if (/Apache License/i.test(licenseText)) return { license: 'Apache-2.0', proprietary: false };
  if (/MIT License/i.test(licenseText)) return { license: 'MIT', proprietary: false };
  return { license: 'See LICENSE.txt', proprietary: true };        // Unknown terms: treat as not open source.
}

/** Fetch a small text file from the Anthropic repo, or '' when it is missing. */
async function fetchAnthropicText(repoPath: string): Promise<string> {
  const response = await fetch(`${ANTHROPIC_RAW_BASE}${repoPath}`, { redirect: 'error' });
  if (!response.ok) return '';                                     // e.g. a skill without LICENSE.txt.
  return readTextWithByteLimit(response, ANTHROPIC_TEXT_MAX_BYTES, `${repoPath} too large`);
}

/** List Anthropic's official skills with name, description and license.
 *  @returns one catalog item per `skills/<name>/SKILL.md`
 *  Exists so Claude Code users can find official Claude skills next to the Copilot community catalog. */
async function fetchAnthropicSkills(): Promise<RawCatalogItem[]> {
  const response = await fetch(ANTHROPIC_TREE_URL, { redirect: 'error', headers: { Accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error(`Failed to fetch Anthropic skills: HTTP ${response.status}`);
  const tree: unknown = JSON.parse(await readTextWithByteLimit(response, ANTHROPIC_TREE_MAX_BYTES, 'Anthropic skills listing too large'));
  if (!isCatalogRecord(tree) || !Array.isArray(tree.tree)) throw new Error('Invalid Anthropic skills listing');

  // Group file paths by skill folder, keeping only safe paths.
  const files = new Map<string, string[]>();
  for (const entry of tree.tree) {
    if (!isCatalogRecord(entry) || entry.type !== 'blob' || typeof entry.path !== 'string') continue;
    const match = ANTHROPIC_SKILL_PATH.exec(entry.path);
    if (!match || !entry.path.split('/').every(segment => SAFE_PATH_SEGMENT.test(segment))) continue;
    files.set(match[1], [...(files.get(match[1]) ?? []), entry.path]);
  }

  // A folder is a skill only if it has a SKILL.md at its root.
  const skillNames = [...files.keys()].filter(name => files.get(name)!.includes(`skills/${name}/SKILL.md`));
  const items = await Promise.all(skillNames.map(async name => {
    const [skillMd, licenseText] = await Promise.all([
      fetchAnthropicText(`skills/${name}/SKILL.md`),
      fetchAnthropicText(`skills/${name}/LICENSE.txt`),
    ]);
    const fm = parseFrontmatterFields(skillMd);
    const { license, proprietary } = classifyAnthropicLicense(fm.license ?? '', licenseText);
    return {
      kind: 'skill' as const,
      id: `anthropic:skills/${name}`,
      title: fm.name || name,
      description: fm.description ?? '',
      category: 'Anthropic',
      path: `skills/${name}/SKILL.md`,
      url: `https://github.com/anthropics/skills/tree/main/skills/${name}`,
      source: 'anthropic' as const,
      license,
      proprietary,
    };
  }));
  for (const name of skillNames) anthropicSkillFiles.set(name, files.get(name)!); // Remembered for install.
  return items;
}

/** Names of Claude Code skills already installed: personal (~/.claude/skills) and from plugins.
 *  @returns lowercase skill folder names
 *  Exists so the catalog marks skills you already have instead of offering duplicates. */
export function installedClaudeSkillNames(): Set<string> {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const names = new Set<string>();
  if (!home) return names;
  const claudeDir = path.join(home, '.claude');
  const readDirs = (dir: string): fs.Dirent[] => {
    try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } // Missing folder: nothing installed.
  };
  // Personal skills: ~/.claude/skills/<name>/SKILL.md.
  for (const entry of readDirs(path.join(claudeDir, 'skills'))) {
    if (entry.isDirectory() && fs.existsSync(path.join(claudeDir, 'skills', entry.name, 'SKILL.md'))) names.add(entry.name.toLowerCase());
  }
  // Plugin skills: any `skills/<name>/SKILL.md` a few levels under ~/.claude/plugins, except the trash.
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;                                         // Plugin layouts are shallow; bound the scan.
    for (const entry of readDirs(dir)) {
      if (!entry.isDirectory() || entry.name === '.trash' || entry.name === 'node_modules') continue;
      const child = path.join(dir, entry.name);
      if (path.basename(dir) === 'skills' && fs.existsSync(path.join(child, 'SKILL.md'))) names.add(entry.name.toLowerCase());
      else walk(child, depth + 1);
    }
  };
  walk(path.join(claudeDir, 'plugins'), 0);
  return names;
}

export async function getCatalogItems(): Promise<RawCatalogItem[]> {
  if (catalogCache) return catalogCache;
  if (!catalogPromise) {
    const request: Promise<RawCatalogItem[]> = Promise.all([
      Promise.all(CATALOG_FEEDS.map(fetchCatalogFeed)),
      // Anthropic's repo is optional: if GitHub is unreachable or rate-limited, keep the Copilot catalog.
      fetchAnthropicSkills().catch(() => [] as RawCatalogItem[]),
    ])
      .then(([catalogs, anthropic]) => {
        const items = [...catalogs.flat(), ...anthropic];
        // A reload must not let an older request repopulate the cleared cache.
        if (catalogPromise === request) catalogCache = items;
        return items;
      })
      .finally(() => {
        if (catalogPromise === request) catalogPromise = undefined;
      });
    catalogPromise = request;
  }
  return catalogPromise;
}

export function clearCatalogCache(): void {
  catalogCache = undefined;
  catalogPromise = undefined;
}