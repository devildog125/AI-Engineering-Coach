/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Claude API pricing for Claude Code sessions
 *
 * Why this module exists: Claude Code transcripts record the full `usage`
 * object of every API call (uncached input, output, 5-minute and 1-hour
 * cache writes, cache reads, speed, inference region, web searches). That is
 * enough to price each call exactly at Anthropic's list rates, which is more
 * precise than the Copilot-oriented `MODEL_TOKEN_RATES` table (one blended
 * cache-write rate, no fast mode, no long-prompt tier).
 *
 * Shape decisions:
 *   - Rates are keyed by `normalizeModel()` output (`claude-opus-5.5`), so the
 *     same normalization used everywhere else in the analyzer applies here.
 *   - Unknown models return `null`, never a guess. Callers surface "unknown
 *     cost" rather than silently pricing at a fallback rate.
 *   - Results are USD at pay-as-you-go API rates. For Pro/Max subscribers this
 *     is an API-equivalent figure, not what they are billed.
 *
 * Source: https://platform.claude.com/docs/en/about-claude/pricing
 * (fetched 2026-10-30). Update this table when Anthropic publishes new models.
 */

import { normalizeModel } from './helpers';

/** USD per million tokens for one Claude model at standard speed. */
interface ClaudeRate {
  /** Uncached input tokens. */
  input: number;
  /** Output tokens (includes thinking tokens, which are billed as output). */
  output: number;
  /** Cache writes with the 5-minute TTL (time-to-live). */
  write5m: number;
  /** Cache writes with the 1-hour TTL. */
  write1h: number;
  /** Cache hits and refreshes. */
  read: number;
}

// Anthropic list prices, USD per MTok, copied from the official pricing page.
const CLAUDE_RATES: Record<string, ClaudeRate> = {
  'claude-fable-5.1':  { input: 10,   output: 50,  write5m: 12.5,  write1h: 20,   read: 0.25 }, // Fable 5.1: cache hit is 0.025x input
  'claude-mythos-5.1': { input: 10,   output: 50,  write5m: 12.5,  write1h: 20,   read: 0.25 }, // Mythos 5.1: same as Fable 5.1
  'claude-fable-5':    { input: 10,   output: 50,  write5m: 12.5,  write1h: 20,   read: 1 },    // Fable 5: standard 0.1x cache hit
  'claude-mythos-5':   { input: 10,   output: 50,  write5m: 12.5,  write1h: 20,   read: 1 },    // Mythos 5: same as Fable 5
  'claude-opus-5.5':   { input: 4,    output: 20,  write5m: 5,     write1h: 8,    read: 0.2 },  // Opus 5.5: cache hit is 0.05x input
  'claude-opus-5':     { input: 5,    output: 25,  write5m: 6.25,  write1h: 10,   read: 0.5 },  // Opus 5
  'claude-opus-4.8':   { input: 5,    output: 25,  write5m: 6.25,  write1h: 10,   read: 0.5 },  // Opus 4.8
  'claude-opus-4.7':   { input: 5,    output: 25,  write5m: 6.25,  write1h: 10,   read: 0.5 },  // Opus 4.7
  'claude-opus-4.6':   { input: 5,    output: 25,  write5m: 6.25,  write1h: 10,   read: 0.5 },  // Opus 4.6
  'claude-opus-4.5':   { input: 5,    output: 25,  write5m: 6.25,  write1h: 10,   read: 0.5 },  // Opus 4.5
  'claude-opus-4.1':   { input: 15,   output: 75,  write5m: 18.75, write1h: 30,   read: 1.5 },  // Opus 4.1
  'claude-opus-4':     { input: 15,   output: 75,  write5m: 18.75, write1h: 30,   read: 1.5 },  // Opus 4
  'claude-sonnet-5.5': { input: 2,    output: 10,  write5m: 2.5,   write1h: 4,    read: 0.1 },  // Sonnet 5.5: cache hit is 0.05x input
  'claude-sonnet-5':   { input: 2,    output: 10,  write5m: 2.5,   write1h: 4,    read: 0.2 },  // Sonnet 5
  'claude-sonnet-4.6': { input: 3,    output: 15,  write5m: 3.75,  write1h: 6,    read: 0.3 },  // Sonnet 4.6
  'claude-sonnet-4.5': { input: 3,    output: 15,  write5m: 3.75,  write1h: 6,    read: 0.3 },  // Sonnet 4.5
  'claude-sonnet-4':   { input: 3,    output: 15,  write5m: 3.75,  write1h: 6,    read: 0.3 },  // Sonnet 4
  'claude-haiku-5.5':  { input: 0.1,  output: 0.5, write5m: 0.125, write1h: 0.2,  read: 0.01 }, // Haiku 5.5, prompts up to 100k tokens
  'claude-haiku-4.5':  { input: 1,    output: 5,   write5m: 1.25,  write1h: 2,    read: 0.1 },  // Haiku 4.5
  'claude-3.5-haiku':  { input: 0.8,  output: 4,   write5m: 1,     write1h: 1.6,  read: 0.08 }, // Haiku 3.5 (API id is claude-3-5-haiku)
};

// Haiku 5.5 charges these higher rates when a single call's prompt exceeds 100k tokens.
const HAIKU_55_LONG_PROMPT: ClaudeRate = { input: 0.5, output: 2.5, write5m: 0.625, write1h: 1, read: 0.05 };
// Prompt-length threshold for the Haiku 5.5 long-prompt tier (input + cache reads + cache writes).
const HAIKU_55_LONG_PROMPT_TOKENS = 100_000;

// Fast-mode input/output prices; cache prices scale by the same factor (multipliers stack).
const FAST_MODE_RATES: Record<string, { input: number; output: number }> = {
  'claude-opus-5.5': { input: 8,  output: 40 }, // Opus 5.5 fast mode
  'claude-opus-5':   { input: 10, output: 50 }, // Opus 5 fast mode (research preview)
  'claude-opus-4.8': { input: 10, output: 50 }, // Opus 4.8 fast mode (research preview)
};

// US-only inference (`inference_geo: "us"`) costs 1.1x on every token category.
const US_INFERENCE_MULTIPLIER = 1.1;
// Server-side web search is billed at $10 per 1,000 searches on top of tokens.
const WEB_SEARCH_USD = 0.01;

/** Read a numeric field from an untyped usage record, treating anything else as 0.
 *  @param record the usage object (or a nested part of it) from the transcript
 *  @param key the field to read
 *  @returns the number, or 0 when missing or not a number
 *  Exists because transcripts are untrusted JSON and older versions omit fields. */
function num(record: Record<string, unknown> | undefined, key: string): number {
  const value = record?.[key];                                    // Raw value as written by Claude Code.
  return typeof value === 'number' && Number.isFinite(value) ? value : 0; // Ignore strings, NaN, null.
}

/** Read a nested object field from an untyped record.
 *  @returns the nested object, or undefined when absent or not an object
 *  Exists so callers can drill into `cache_creation` / `server_tool_use` safely. */
function obj(record: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = record?.[key];                                    // Raw nested value.
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>                             // Plain object: safe to read fields from.
    : undefined;                                                   // Anything else: treat as missing.
}

/** True when this model id has a known Claude list price.
 *  @param modelId raw model id from the transcript (any casing/suffix form)
 *  @returns whether `claudeCallCostUSD` can price calls for this model
 *  Exists so analyzers can distinguish "free" from "unknown price". */
export function hasClaudeRate(modelId: string): boolean {
  return normalizeModel(modelId) in CLAUDE_RATES;                  // Same key normalization as pricing.
}

// Sonnet 4.x input price: the Copilot "1x" model, used as the reference for price-derived tiers.
const TIER_REFERENCE_INPUT_USD = 3;

/** Relative cost tier for a Claude model, on the same scale as Copilot multipliers (Sonnet 4.x = 1).
 *  @param modelId raw or normalized Claude model id
 *  @returns input list price ÷ $3 (Opus 5.5 ≈ 1.33, Sonnet 5 ≈ 0.67, Fable 5.1 ≈ 3.33), or null when unknown
 *  Exists so "premium model" rules work for Claude models Copilot's multiplier table has never listed. */
export function claudePriceTier(modelId: string): number | null {
  const rate = CLAUDE_RATES[normalizeModel(modelId)];              // Same key normalization as pricing.
  return rate ? rate.input / TIER_REFERENCE_INPUT_USD : null;      // Unknown model: no tier.
}

/** Price one Claude API call from its transcript `usage` object.
 *  @param modelId raw `message.model` of the assistant line (e.g. `claude-opus-5-5`)
 *  @param usage the `message.usage` object of that call
 *  @returns cost in USD at list price, or `null` when the model has no known rate
 *  Exists because per-call usage carries everything needed for an exact price
 *  (cache TTL split, fast mode, region, web searches), which per-request
 *  aggregates would lose. */
export function claudeCallCostUSD(modelId: string, usage: Record<string, unknown>): number | null {
  const key = normalizeModel(modelId);                             // e.g. claude-opus-5-5 → claude-opus-5.5
  let rate = CLAUDE_RATES[key];                                    // Standard-speed list price.
  if (!rate) return null;                                          // Unknown model: report unknown, never guess.

  // Token counts for this single call.
  const input = num(usage, 'input_tokens');                        // Uncached input.
  const output = num(usage, 'output_tokens');                      // Output incl. thinking.
  const read = num(usage, 'cache_read_input_tokens');              // Cache hits.
  const cacheCreation = obj(usage, 'cache_creation');              // TTL split, present on current versions.
  const totalWrite = num(usage, 'cache_creation_input_tokens');    // All cache writes regardless of TTL.
  const write1h = num(cacheCreation, 'ephemeral_1h_input_tokens'); // 1-hour writes cost more than 5-minute ones.
  // Older transcripts have no split: treat every write as 5-minute (the API default TTL).
  const write5m = cacheCreation ? num(cacheCreation, 'ephemeral_5m_input_tokens') : totalWrite;

  // Haiku 5.5 switches to higher rates per call once the prompt passes 100k tokens.
  if (key === 'claude-haiku-5.5' && input + read + totalWrite > HAIKU_55_LONG_PROMPT_TOKENS) {
    rate = HAIKU_55_LONG_PROMPT;                                   // Whole call is billed at the long-prompt tier.
  }

  // Fast mode replaces input/output prices; cache prices keep their ratio to input.
  const fast = usage.speed === 'fast' ? FAST_MODE_RATES[key] : undefined;
  if (fast) {
    const factor = fast.input / rate.input;                        // How much pricier input is in fast mode.
    rate = {
      input: fast.input,                                           // Fast-mode input price.
      output: fast.output,                                         // Fast-mode output price.
      write5m: rate.write5m * factor,                              // Cache multipliers stack on top of fast mode.
      write1h: rate.write1h * factor,
      read: rate.read * factor,
    };
  }

  // Sum every billed token category at its own rate (rates are per million tokens).
  let usd = (
    input * rate.input
    + output * rate.output
    + write5m * rate.write5m
    + write1h * rate.write1h
    + read * rate.read
  ) / 1_000_000;

  // US-only inference multiplies all token prices; "global" and "not_available" are standard.
  if (usage.inference_geo === 'us') usd *= US_INFERENCE_MULTIPLIER;

  // Server-side web searches are charged per search, separately from tokens.
  usd += num(obj(usage, 'server_tool_use'), 'web_search_requests') * WEB_SEARCH_USD;
  return usd;                                                      // Exact list-price cost of this call.
}
