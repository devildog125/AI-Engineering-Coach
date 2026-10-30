/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* ---- AI Skill Triage ---- */
export type TriageVerdict = 'strong' | 'maybe' | 'skip';

export interface TriagedCluster {
  id: string;
  label: string;
  verdict: TriageVerdict;
  reason: string;
  suggestedSkillName: string | null;
}

export interface SkillTriageResult {
  triaged: TriagedCluster[];
}

/* ---- Skill catalogs: awesome-copilot and Anthropic's skills repo ---- */
export type CatalogItemKind = 'skill' | 'agent' | 'instruction' | 'hook';

/** Which catalog an item came from; decides how it is fetched and installed. */
export type CatalogSource = 'awesome-copilot' | 'anthropic';

export interface CatalogItem {
  kind: CatalogItemKind;
  id: string;
  title: string;
  description: string;
  category: string;
  path: string;
  url: string;
  /** Catalog the item came from (missing on older cached results = awesome-copilot). */
  source?: CatalogSource;
  /** Short license label shown before install, e.g. "Apache-2.0" or "Proprietary". */
  license?: string;
  /** True when the license is not open source: install needs an explicit second click. */
  proprietary?: boolean;
  /** True when a Claude Code skill with this name is already installed (personal or plugin). */
  installed?: boolean;
  relevanceScore: number;
  matchReasons: string[];
}

export interface CatalogDiscoverResult {
  items: CatalogItem[];
  totalScanned: number;
}

export interface CatalogTriageResult {
  items: CatalogItem[];
}
