/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Level Up: tabbed page for learning, achievements, SDLC, and sharing */

import { DateFilter } from '../core/types';
import { rpc, vscode } from './shared';
import { llmAvailable, llmUnavailableNote } from './capabilities';
import { html, render, type ComponentChildren } from './render';
import { SVG } from './svg-icons';
import { renderAchievements } from './page-achievements';
import { renderLearning } from './page-learning';
import { renderSdlc } from './page-sdlc';
import { renderShareCard } from './page-peers';

/** Keys of all Level-Up features */
export const EXPERIMENT_KEYS = [
  'achievements',
  'learning',
  'sdlc',
  'shareCard',
] as const;
export type ExperimentKey = typeof EXPERIMENT_KEYS[number];

interface ExperimentDef {
  key: ExperimentKey;
  title: string;
  icon: ComponentChildren;
  description: string;
  tag: string;
}

const EXPERIMENTS: ExperimentDef[] = [
  {
    key: 'achievements',
    title: 'Achievement System',
    icon: SVG.trophy,
    description: 'Unlock fun milestones on your path to becoming a true AI Engineer. Track how many times you\'ve "rewritten the Linux kernel" in LoC, earn dinosaur badges for using legacy tech, and more.',
    tag: 'Fun',
  },
  {
    key: 'learning',
    title: 'Learning System / Focus Helper',
    icon: SVG.brain,
    description: 'While the AI agent works, sharpen your skills with coding riddles, quizzes, and a personalized skill tree. Earn a Snake game reward after a 5-answer streak. Recommendations from the web included.',
    tag: 'Learn',
  },
  {
    key: 'sdlc',
    title: 'Agentic SDLC Tracker',
    icon: SVG.refresh,
    description: 'Measure how well you leverage the Agentic Software Development Life Cycle: agent-powered reviews, cloud agents for issue delegation, AI triage workflows, and more.',
    tag: 'Process',
  },
  {
    key: 'shareCard',
    title: 'Share Card',
    icon: SVG.share,
    description: 'Generate a personalized stats card with your streaks, achievements, and AI coding stats. Download as an image to share with your team.',
    tag: 'Social',
  },
];

/** Tab definitions — order determines display order; Learning first */
const LAB_TABS: { id: string; label: string; icon: ComponentChildren; experiment: ExperimentKey; badgeId?: string; render: (c: HTMLElement, f: DateFilter) => Promise<void> }[] = [
  { id: 'learning',     label: 'Learning',     icon: SVG.brain,    experiment: 'learning',       badgeId: 'lu-badge-learning',     render: renderLearning },
  { id: 'achievements', label: 'Achievements', icon: SVG.trophy,   experiment: 'achievements',   badgeId: 'lu-badge-achievements', render: renderAchievements },
  { id: 'sdlc',         label: 'SDLC',         icon: SVG.refresh,  experiment: 'sdlc',           badgeId: 'lu-badge-sdlc',         render: renderSdlc },
  { id: 'share',        label: 'Share',        icon: SVG.share,    experiment: 'shareCard',      render: renderShareCard },
];

/** Read current feature state from vscode webview state — all enabled by default */
export function getExperiments(): Record<ExperimentKey, boolean> {
  const state = vscode.getState() as Record<string, unknown> | null;
  const saved = (state?.experiments ?? {}) as Record<string, boolean>;
  const result: Record<string, boolean> = {};
  for (const key of EXPERIMENT_KEYS) {
    result[key] = saved[key] !== false; // default true
  }
  return result as Record<ExperimentKey, boolean>;
}

export function setExperiment(key: ExperimentKey, enabled: boolean): void {
  const state = (vscode.getState() as Record<string, unknown>) ?? {};
  const experiments = { ...(state.experiments as Record<string, boolean> ?? {}), [key]: enabled };
  vscode.setState({ ...state, experiments });
}

export function isExperimentEnabled(key: ExperimentKey): boolean {
  return getExperiments()[key];
}

/** Remember the active lab tab across renders */
function getActiveLabTab(): string {
  const state = vscode.getState() as Record<string, unknown> | null;
  return (state?.activeLabTab as string) || 'learning';
}

function setActiveLabTab(id: string): void {
  const state = (vscode.getState() as Record<string, unknown>) ?? {};
  vscode.setState({ ...state, activeLabTab: id });
}

/* ── Render ───────────────────────────────────────────────────────── */

export async function renderLevelUp(container: HTMLElement, filter: DateFilter): Promise<void> {
  const experiments = getExperiments();
  let activeTab = getActiveLabTab();
  // Ensure the remembered tab is valid
  if (!LAB_TABS.find(t => t.id === activeTab)) activeTab = 'learning';

  render(html`
    <div class="experiments-page">
      <div class="lab-tab-bar">
        ${LAB_TABS.map(tab => {
          const on = experiments[tab.experiment];
          return html`<button class=${'lab-tab' + (tab.id === activeTab ? ' lab-tab-active' : '') + (on ? '' : ' lab-tab-disabled')} data-lab-tab=${tab.id}>
            <span class="lab-tab-icon">${tab.icon}</span>
            <span class="lab-tab-label">${tab.label}</span>
            ${!on ? html`<span class="lab-tab-badge">OFF</span>` : (tab.badgeId ? html`<span class="lab-tab-count" id=${tab.badgeId}></span>` : null)}
          </button>`;
        })}
      </div>
      <div id="lab-tab-content"></div>
    </div>
  `, container);

  const tabContent = container.querySelector('#lab-tab-content') as HTMLElement;

  async function renderTab(tabId: string): Promise<void> {
    const tab = LAB_TABS.find(t => t.id === tabId)!;
    const isEnabled = experiments[tab.experiment];

    // Update active states
    for (const btn of container.querySelectorAll('.lab-tab')) {
      btn.classList.toggle('lab-tab-active', (btn as HTMLElement).dataset.labTab === tabId);
    }

    if (tab.id === 'learning' && !llmAvailable()) {
      // Learning is the one tab that calls the language model; the data tabs work without one.
      render(html`<div class="lab-enable-prompt"><p>Learning needs a language model. ${llmUnavailableNote()}</p></div>`, tabContent);
      return;
    }
    if (isEnabled) {
      render(null, tabContent);
      await tab.render(tabContent, filter);
    } else {
      const exp = EXPERIMENTS.find(e => e.key === tab.experiment)!;
      render(html`
        <div class="lab-enable-prompt">
          <div class="experiment-card" data-experiment=${exp.key}>
            <div class="experiment-card-header">
              <span class="experiment-icon">${exp.icon}</span>
              <span class="experiment-tag">${exp.tag}</span>
            </div>
            <div class="experiment-card-body">
              <h3 class="experiment-title">${exp.title}</h3>
              <p class="experiment-desc">${exp.description}</p>
            </div>
            <div class="experiment-card-footer">
              <label class="experiment-toggle">
                <input type="checkbox" data-key=${exp.key} />
                <span class="toggle-slider"></span>
                <span class="toggle-label">Disabled</span>
              </label>
            </div>
          </div>
        </div>
      `, tabContent);

      tabContent.querySelector<HTMLInputElement>('input[data-key]')?.addEventListener('change', (e) => {
        void (async () => {
          const input = e.target as HTMLInputElement;
          const key = input.dataset.key as ExperimentKey;
          setExperiment(key, true);
          experiments[key] = true;

          const tabBtn = container.querySelector<HTMLElement>(`.lab-tab[data-lab-tab="${tabId}"]`);
          if (tabBtn) {
            tabBtn.classList.remove('lab-tab-disabled');
            const badge = tabBtn.querySelector<HTMLElement>('.lab-tab-badge');
            badge?.remove();
          }

          window.dispatchEvent(new CustomEvent('experiments-changed'));
          await renderTab(tabId);
        })();
      });
    }
  }

  // Wire tab clicks
  for (const btn of container.querySelectorAll<HTMLButtonElement>('.lab-tab')) {
    btn.addEventListener('click', () => {
      void (async () => {
        const tabId = btn.dataset.labTab;
        if (!tabId) return;
        setActiveLabTab(tabId);
        activeTab = tabId;
        await renderTab(tabId);
      })();
    });
  }

  // Render initial tab
  await renderTab(activeTab);

  // Populate tab badge counts (best-effort, fire-and-forget)
  refreshTabBadges(filter);
}

/** Populate numeric badges on sub-tabs */
function refreshTabBadges(filter: DateFilter): void {
  // Learning: number of solved quizzes
  const ls = vscode.getState() as Record<string, unknown> | null;
  const solved = ((ls?.learningState as Record<string, unknown>)?.solved as number) ?? 0;
  setBadgeText('lu-badge-learning', solved);

  // Achievements: count unlocked
  const achState = ((ls?.achievementState as Record<string, unknown>)?.unlockDates ?? {}) as Record<string, number>;
  const unlocked = Object.keys(achState).length;
  setBadgeText('lu-badge-achievements', unlocked);

  // SDLC: count of SDLC-relevant MCP servers detected (best-effort async)
  rpc<{ mcpServers: { isSdlcRelevant: boolean }[] }>('getSdlcToolAnalysis', filter as Record<string, unknown>).then(d => {
    const relevant = d.mcpServers.filter(s => s.isSdlcRelevant).length;
    setBadgeText('lu-badge-sdlc', relevant);
  }).catch(() => {/* best-effort */});
}

function setBadgeText(id: string, value: string | number): void {
  const el = document.getElementById(id);
  if (!el) return;
  if (!value || value === 0) { el.style.display = 'none'; return; }
  el.textContent = String(value);
  el.style.display = '';
}

/** Navigate to a specific lab tab. Call before navigating to the Level Up page. */
export function setLabTab(tabId: string): void {
  setActiveLabTab(tabId);
}
