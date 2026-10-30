/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Universal rule pipeline engine.
 *
 * Compiles a Detection Logic block from a rule .md file into an emitter+trigger
 * pair using declarative DSL directives (`scan:`, `match:`, `aggregate:`,
 * `check:`, `examples:`, `severity:`).
 *
 * Also handles:
 *   - **Inheritance** (`extends:` in frontmatter)
 *   - **Test fixture validation** (`# Tests` section)
 *   - **Pattern/fileType resolution** into the DSL evaluation context
 */

import type { DetectionRule, DetectorEmission, RuleSeverity, Session, SessionRequest } from './types';
import { compileFilter, compileTrigger, evaluateTemplate, evaluateExpression } from './dsl/index';
import { getAllRules } from './rule-engine';
import { warnCore } from './log';

/* ================================================================== */
/*  Pipeline Definition                                               */
/* ================================================================== */

export interface Pipeline {
  scan: 'requests' | 'sessions';
  matchExpr?: string;
  aggregate: 'count' | 'ratio';
  checkExpr?: string;
  examplesTemplate?: string;
  severityExpr?: string;
  reduceExprs?: Record<string, string>;
}

export interface DetectorContext {
  reqs: SessionRequest[];
  sessions: Session[];
  skipIdeDetectors: boolean;
}

/* ================================================================== */
/*  Pipeline Parser                                                   */
/* ================================================================== */

/**
 * Parse the Detection Logic block from a rule's raw markdown source.
 * Returns a Pipeline definition.
 */
function mergeLineContinuations(rawLines: string[]): string[] {
  const lines: string[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    let line = rawLines[i];
    while (line.endsWith('\\') && i + 1 < rawLines.length) {
      line = line.slice(0, -1).trimEnd() + ' ' + rawLines[++i];
    }
    lines.push(line);
  }
  return lines;
}

export function parsePipeline(rule: DetectionRule): Pipeline {
  const block = rule.rawSource.match(/```detect\s*\n([\s\S]*?)```/);
  if (!block) {
    // No detection logic → default pipeline that never triggers
    return { scan: rule.scope === 'sessions' ? 'sessions' : 'requests', aggregate: 'count' };
  }

  const rawLines = block[1].split('\n').map(l => l.trim()).filter(Boolean);
  const lines = mergeLineContinuations(rawLines);
  const pipeline: Pipeline = {
    scan: rule.scope === 'sessions' ? 'sessions' : 'requests',
    aggregate: 'count',
  };

  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const rawKey = line.substring(0, colonIdx).trim();
    const key = rawKey.toLowerCase();
    const value = line.substring(colonIdx + 1).trim();

    switch (key) {
      case 'scan':
        pipeline.scan = value === 'sessions' ? 'sessions' : 'requests';
        break;
      case 'match':
        pipeline.matchExpr = value;
        break;
      case 'aggregate':
        pipeline.aggregate = value === 'ratio' ? 'ratio' : 'count';
        break;
      case 'check':
        pipeline.checkExpr = value;
        break;
      case 'examples':
        pipeline.examplesTemplate = value;
        break;
      case 'severity':
        pipeline.severityExpr = value;
        break;
      default:
        // Any other key:value is treated as a reduce expression (preserve original case)
        if (rawKey && value && key !== 'reduce') {
          if (!pipeline.reduceExprs) pipeline.reduceExprs = {};
          pipeline.reduceExprs[rawKey] = value;
        }
        break;
    }
  }

  return pipeline;
}

/* ================================================================== */
/*  Rule Context Builder                                              */
/* ================================================================== */

/**
 * Build the evaluation context that gets merged into each row when
 * the DSL filter runs. This injects thresholds, patterns, and fileTypes
 * from the rule's frontmatter so expressions can reference them.
 */
function buildRuleContext(rule: DetectionRule): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};

  // thresholds.xxx → thresholds object
  if (rule.thresholds) ctx.thresholds = rule.thresholds;
  // patterns.xxx → patterns object
  if (rule.patterns && Object.keys(rule.patterns).length > 0) ctx.patterns = rule.patterns;
  // fileTypes.xxx → fileTypes object
  if (rule.fileTypes && Object.keys(rule.fileTypes).length > 0) ctx.fileTypes = rule.fileTypes;

  return ctx;
}

/* ================================================================== */
/*  Pipeline Executor                                                 */
/* ================================================================== */

/**
 * Execute a pipeline against data to produce a DetectorEmission.
 */
function buildExamples(
  matched: Record<string, unknown>[],
  pipeline: Pipeline,
  ruleCtx: Record<string, unknown>,
  count: number,
  total: number,
  ratio: number,
  extra: Record<string, unknown>,
): string[] {
  const examples: string[] = [];
  for (const row of matched.slice(0, 3)) {
    if (pipeline.examplesTemplate) {
      const mergedRow = { ...row, ...ruleCtx, count, total, ratio, ...extra };
      examples.push(evaluateTemplate(pipeline.examplesTemplate, mergedRow));
    } else {
      const msgText = row.messageText;
      const wsName = row.workspaceName;
      const msg = typeof msgText === 'string' ? msgText : (typeof wsName === 'string' ? wsName : '');
      if (msg) examples.push(msg.substring(0, 80));
    }
  }
  return examples;
}

/** True for harnesses that carry IDE context (VS Code agent sessions and Xcode).
 *  Exists so every IDE check uses one definition (it was copied in four places). */
export function isIdeHarness(harness: string): boolean {
  return harness.startsWith('Local Agent') || harness === 'Xcode'; // Local Agent, Local Agent (Insiders), Xcode.
}

/** True when an IDE-context rule should judge requests from this harness. */
function ruleAppliesToHarness(rule: DetectionRule, harness: string): boolean {
  return isIdeHarness(harness) || (rule.harnesses?.includes(harness) ?? false); // IDE harnesses plus opt-ins.
}

/** Narrow the detector context to the requests and sessions an IDE-context rule applies to.
 *  @returns the context unchanged for ordinary rules, else one without other harnesses' data
 *  Exists so the "All harnesses" view stops judging Claude/Codex sessions by Copilot-only rules.
 *  Requests whose session is unknown (rule test fixtures) are kept, as before. */
function scopeContextToRule(rule: DetectionRule, ctx: DetectorContext): DetectorContext {
  if (!rule.requiresIdeContext) return ctx;                        // Harness-neutral rule: judge everything.
  const sessions = ctx.sessions.filter(s => ruleAppliesToHarness(rule, s.harness));
  if (sessions.length === ctx.sessions.length) return ctx;         // Nothing to drop.
  // Requests are matched to sessions by id, because callers may pass enriched copies.
  const harnessByRequest = new Map<string, string>();
  for (const s of ctx.sessions) for (const r of s.requests) harnessByRequest.set(r.requestId, s.harness);
  const reqs = ctx.reqs.filter(r => {
    const harness = harnessByRequest.get(r.requestId);
    return harness === undefined || ruleAppliesToHarness(rule, harness); // Unknown session: keep.
  });
  return { ...ctx, reqs, sessions };
}

/** Distinct harnesses of the rows a rule judged.
 *  @returns harness names, or undefined when the rows' sessions are unknown (test fixtures)
 *  Exists so the finding's advice can match the harnesses it is about. */
function rowHarnesses(pipeline: Pipeline, rows: Record<string, unknown>[], ctx: DetectorContext): string[] | undefined {
  const found = new Set<string>();
  if (pipeline.scan === 'sessions') {
    for (const row of rows) if (typeof row.harness === 'string') found.add(row.harness); // Sessions carry their harness.
  } else {
    // Requests don't carry a harness: look it up through their session.
    const harnessByRequest = new Map<string, string>();
    for (const s of ctx.sessions) for (const r of s.requests) harnessByRequest.set(r.requestId, s.harness);
    for (const row of rows) {
      const harness = typeof row.requestId === 'string' ? harnessByRequest.get(row.requestId) : undefined;
      if (harness) found.add(harness);
    }
  }
  return found.size > 0 ? [...found] : undefined;
}

export function executePipeline(
  pipeline: Pipeline,
  rule: DetectionRule,
  rawCtx: DetectorContext,
): DetectorEmission {
  const ctx = scopeContextToRule(rule, rawCtx);                    // IDE rules only see applicable harnesses.
  // ── Declarative pipeline path ──
  const rows: Record<string, unknown>[] = pipeline.scan === 'sessions'
    ? ctx.sessions as unknown as Record<string, unknown>[]
    : ctx.reqs as unknown as Record<string, unknown>[];

  if (rows.length === 0) return EMPTY_EMISSION;

  const ruleCtx = buildRuleContext(rule);

  // Compile match filter
  const matchFn = pipeline.matchExpr
    ? compileFilterWithContext(pipeline.matchExpr, ruleCtx)
    : () => true;

  // Filter rows
  const matched = rows.filter(matchFn);

  // Aggregate
  let count = matched.length;
  let total = rows.length;
  let ratio = total > 0 ? count / total : 0;

  // Evaluate reduce expressions to compute extra fields
  const extra: Record<string, unknown> = {};
  if (pipeline.reduceExprs) {
    const reduceCtx: Record<string, unknown> = {
      ...ruleCtx,
      matched,
      all: rows,
      allReqs: ctx.reqs,
      allSessions: ctx.sessions,
      count,
      total,
      ratio,
      extra,
    };
    for (const [key, expr] of Object.entries(pipeline.reduceExprs)) {
      const val = evaluateExpression(expr, reduceCtx);
      extra[key] = val;
      // Make each computed value available to subsequent expressions
      reduceCtx[key] = val;
      reduceCtx.extra = { ...extra };
    }
  }

  // Override count/total/ratio from reduce expressions (emitCount, emitTotal, emitRatio)
  if (typeof extra.emitCount === 'number') count = extra.emitCount;
  if (typeof extra.emitTotal === 'number') total = extra.emitTotal;
  if (extra.emitCount !== undefined || extra.emitTotal !== undefined) {
    ratio = total > 0 ? count / total : 0;
  }
  if (typeof extra.emitRatio === 'number') ratio = extra.emitRatio;

  // Generate examples
  const examples = buildExamples(matched, pipeline, ruleCtx, count, total, ratio, extra);

  // Dynamic severity
  let dynamicSeverity: RuleSeverity | undefined;
  if (pipeline.severityExpr) {
    try {
      const severityFn = compileTrigger(pipeline.severityExpr);
      if (severityFn({ count, total, ratio, extra })) {
        dynamicSeverity = 'high';
      }
    } catch { /* ignore severity expression errors */ }
  }

  return { count, total, ratio, examples, extra, dynamicSeverity, matchedRows: matched, harnesses: rowHarnesses(pipeline, rows, ctx) };
}

/**
 * Check whether a pipeline's trigger condition is met.
 */
export function checkPipelineTrigger(
  pipeline: Pipeline,
  emission: DetectorEmission,
  rule: DetectionRule,
): boolean {
  if (!pipeline.checkExpr) {
    // Default: trigger if any matches
    return emission.count > 0;
  }

  // Resolve threshold references in the check expression
  let resolved = pipeline.checkExpr;
  if (rule.thresholds) {
    for (const [k, v] of Object.entries(rule.thresholds)) {
      resolved = resolved.replaceAll(`thresholds.${k}`, String(v));
    }
  }

  try {
    const triggerFn = compileTrigger(resolved);
    return triggerFn({
      count: emission.count,
      total: emission.total,
      ratio: emission.ratio,
      extra: emission.extra,
    });
  } catch {
    return emission.count > 0;
  }
}

/* ================================================================== */
/*  Inheritance Resolver                                              */
/* ================================================================== */

/**
 * Resolve rule inheritance. If a rule has `extends: parent-id`, merge
 * the parent's fields (thresholds, patterns, fileTypes, templates) with
 * the child's overrides.
 */
export function resolveInheritance(rule: DetectionRule, visited: Set<string> = new Set()): DetectionRule {
  if (!rule.extendsRule) return rule;

  if (visited.has(rule.id)) {
    warnCore('Pipeline', `Circular inheritance detected: ${[...visited].join(' -> ')} -> ${rule.id}`);
    return rule;
  }
  visited.add(rule.id);

  const allRules = getAllRules();
  const parent = allRules.find(r => r.id === rule.extendsRule);
  if (!parent) {
    warnCore('Pipeline', `Inheritance: parent rule '${rule.extendsRule}' not found for '${rule.id}'`);
    return rule;
  }

  // Resolve parent first (chains supported)
  const resolvedParent = resolveInheritance(parent, visited);

  return {
    ...resolvedParent,
    // Child overrides:
    id: rule.id,
    name: rule.name || resolvedParent.name,
    severity: rule.severity || resolvedParent.severity,
    group: rule.group || resolvedParent.group,
    scope: rule.scope || resolvedParent.scope,
    description: rule.description || resolvedParent.description,
    descriptionTemplate: rule.descriptionTemplate || resolvedParent.descriptionTemplate,
    suggestionTemplate: rule.suggestionTemplate || resolvedParent.suggestionTemplate,
    claudeSuggestionTemplate: rule.claudeSuggestionTemplate || resolvedParent.claudeSuggestionTemplate,
    exampleTemplate: rule.exampleTemplate || resolvedParent.exampleTemplate,
    // Merge thresholds (child wins)
    thresholds: { ...resolvedParent.thresholds, ...rule.thresholds },
    // Merge patterns (child wins per key)
    patterns: { ...resolvedParent.patterns, ...rule.patterns },
    // Merge fileTypes (child wins per key)
    fileTypes: { ...resolvedParent.fileTypes, ...rule.fileTypes },
    // Keep child's detection logic if present
    rawSource: rule.rawSource,
    conditions: rule.conditions.length > 0 ? rule.conditions : resolvedParent.conditions,
    tags: rule.tags.length > 0 ? rule.tags : resolvedParent.tags,
    version: rule.version || resolvedParent.version,
    source: rule.source,
    sourceFilePath: rule.sourceFilePath,
    tests: rule.tests.length > 0 ? rule.tests : resolvedParent.tests,
  };
}

/* ================================================================== */
/*  Helpers                                                           */
/* ================================================================== */

const EMPTY_EMISSION: DetectorEmission = {
  count: 0, total: 0, ratio: 0, examples: [], extra: {},
};

/**
 * Compile a DSL filter expression with rule-level context merged into
 * each row's evaluation scope.
 */
function compileFilterWithContext(
  expr: string,
  ruleCtx: Record<string, unknown>,
): (row: Record<string, unknown>) => boolean {
  // Resolve thresholds.xxx references to literal values
  let resolved = expr;
  const thresholds = ruleCtx.thresholds as Record<string, number> | undefined;
  if (thresholds) {
    for (const [k, v] of Object.entries(thresholds)) {
      resolved = resolved.replaceAll(`thresholds.${k}`, String(v));
    }
  }

  const filterFn = compileFilter(resolved);
  return (row: Record<string, unknown>) => {
    const mergedRow = { ...row, ...ruleCtx };
    return filterFn(mergedRow);
  };
}
