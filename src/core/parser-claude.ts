/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Claude session parser
 *
 * Data layout (macOS):
 *   ~/.claude/projects/<encoded-project-path>/<session-uuid>.jsonl
 *
 * Each .jsonl file is a session. Lines have { type: 'user'|'assistant'|'queue-operation'|'last-prompt', ... }
 *
 * user lines:   message.content[].text, timestamp, cwd, sessionId, version, gitBranch
 * assistant lines: message.content[] with type 'thinking'|'text'|'tool_use',
 *                  message.model, message.usage, timestamp
 *
 * One API response is written as several assistant lines (one per content
 * block) that all repeat the same `message.id` and `usage`. Usage is therefore
 * counted once per `message.id`, never once per line.
 *
 * Other lines the parser reads: `attachment` (CLAUDE.md loads, @file mentions),
 * `system` (compaction boundaries, API errors), `api-request` (reasoning effort)
 * and `cost-state` (Claude Code's own cost total, which also covers background
 * calls the transcript never shows).
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { CompactionEvent, HarnessCostReport, ModelUsage, Session, SessionRequest, TodoItem } from './types';
import { assertTrustedPath, readFileSafe, createRequest, createSession, detectDevcontainerFromRequests, extractSkillNameFromPath } from './parser-shared';
import { canonicalizeReasoningEffort, extractReasoningEffortFromModelId, normalizeModel } from './helpers';
import { claudeCallCostUSD } from './claude-pricing';
import { warnCore } from './log';
import { EditLoc, EditLocIndex } from './edit-loc-diff';
import {
  FileEditLocMap,
  mergeRequestEditLoc,
  recordContentReplacement,
  recordCreatedContent,
} from './edit-tool-diff';
import { recordedInvestigation, recordedWebDomains } from './curiosity-activity';
import { imageReferencesFromContent, type ImageReference, type ImageRequestMatch } from './image-data';
import type { SessionSource } from './cache';
import { forEachJsonlLine } from './parser-vscode-files';

interface ClaudeContentBlock {
  type: string;
  id?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
}

interface ClaudeMessage {
  /** API response id; shared by every line written for the same response. */
  id?: string;
  role?: string;
  model?: string;
  content?: ClaudeContentBlock[] | string;
  usage?: Record<string, unknown>;
  stop_reason?: string;
}

interface ClaudeLine {
  type: string;
  uuid?: string;
  parentUuid?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  /** Set from CLAUDE_CODE_ENTRYPOINT env var at launch time. Known values:
   *  cli, sdk-ts, sdk-py, sdk-cli, mcp, claude-code-github-action,
   *  claude-desktop, local-agent. Used to classify the session as
   *  interactive (cli, claude-desktop) vs programmatic (everything else). */
  entrypoint?: string;
  /** True on subagent lines (`<sessionId>/subagents/agent-*.jsonl` files).
   *  Carried through so callers can roll subagent requests up into the
   *  parent session rather than treating them as standalone sessions. */
  isSidechain?: boolean;
  isMeta?: boolean;
  /** Set on the turn that replays a compacted conversation summary. */
  isCompactSummary?: boolean;
  /** Subagent identifier on `subagents/` files. Present alongside
   *  `isSidechain: true`. Not used for billing math; surfaced for diagnostics. */
  agentId?: string;
  message?: ClaudeMessage;
  /** Kind of `system` line (`compact_boundary`, `api_error`, `local_command`, ...). */
  subtype?: string;
  /** Permission mode in force when the user sent this prompt (`plan`, `acceptEdits`, `auto`, `default`, `bypassPermissions`). */
  permissionMode?: string;
  /** Payload of `attachment` lines: CLAUDE.md loads, @file mentions, reminders. */
  attachment?: Record<string, unknown>;
  /** Payload of `system/compact_boundary` lines. */
  compactMetadata?: Record<string, unknown>;
  /** Structured result on tool_result user lines; carries `agentId` for subagent launches. */
  toolUseResult?: unknown;
  /** `api-request` lines: request parameters, including `output_config.effort`. */
  params?: Record<string, unknown>;
  /** `cost-state` lines: Claude Code's running cost total for the session. */
  totalCostUSD?: number;
  /** `cost-state` lines: true when Claude Code could not price a model. */
  hasUnknownModelCost?: boolean;
  /** `cost-state` lines: per-model token and cost totals. */
  modelUsage?: Record<string, unknown>;
}

/** Allow-list of `entrypoint` values that indicate the user launched Claude
 *  Code interactively. Anything outside this set (sdk-ts, sdk-py, mcp,
 *  claude-code-github-action, local-agent, unknown, missing) is treated as
 *  programmatic — i.e. spawned by another tool. Defaulting unknown values to
 *  programmatic is the safer choice: it keeps standalone Claude usage
 *  conservative (under-attributed rather than over-attributed). */
const INTERACTIVE_ENTRYPOINTS: ReadonlySet<string> = new Set(['cli', 'claude-desktop']);

function classifyLauncher(entrypoint: string | undefined): 'interactive' | 'programmatic' {
  return entrypoint && INTERACTIVE_ENTRYPOINTS.has(entrypoint) ? 'interactive' : 'programmatic';
}

function harnessForLauncher(_launcherKind: 'interactive' | 'programmatic'): string {
  return 'Claude';
}

interface ClaudeAssistantData {
  nextIndex: number;
  lastTs: number | null;
  assistantTexts: string[];
  toolsUsed: string[];
  editedFiles: string[];
  referencedFiles: string[];
  skillsUsed: string[];
  model: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  /** Context size of the last API call in the turn (input + cache read + cache write). */
  lastCallContextTokens: number;
  /** Sum of per-call list prices; null once any call uses an unpriced model. */
  costUSD: number | null;
  /** Number of distinct API calls (unique message.id) in the turn. */
  assistantCount: number;
  /** Normalized model ids of every real API call in the turn. */
  callModels: Set<string>;
  /** Timestamp of the first assistant line, for time-to-first-response. */
  firstAssistantTs: number | null;
  /** True when the user interrupted this turn (Esc). */
  canceled: boolean;
  /** True when Claude Code logged an API error during this turn. */
  apiError: boolean;
  /** Files and folders the user @-mentioned in the prompt. */
  fileMentions: string[];
  /** CLAUDE.md / memory files loaded during this turn: path → size in characters. */
  instructionFiles: Map<string, number>;
  /** Compaction followed by more model calls in this turn: it happened during this turn. */
  compaction: CompactionEvent | null;
  /** Compaction after the turn's last call: it was triggered by the next prompt. */
  trailingCompaction: CompactionEvent | null;
  /** Reasoning effort requested from the API (`output_config.effort`), last seen in the turn. */
  effort: string | null;
  /** Subagent ids launched by this turn (from Agent/Task tool results). */
  subagentIds: string[];
  /** Task/todo tool calls in order, applied to the session's running task list. */
  todoOps: ClaudeContentBlock[];
  editLocs: FileEditLocMap;
  answerEvidence: 'final' | 'legacy' | 'missing';
  investigationDelegations: ('research' | 'explore')[];
  webDomains: string[];
}

const CLAUDE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'MultiEditTool']);
const CLAUDE_READ_FILE_TOOLS = new Set(['Read', 'View']);
const CLAUDE_READ_PATH_TOOLS = new Set(['Glob', 'LS', 'Find']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isClaudeContentBlock(value: unknown): value is ClaudeContentBlock {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.id !== undefined && typeof value.id !== 'string') return false;
  if (value.text !== undefined && typeof value.text !== 'string') return false;
  if (value.name !== undefined && typeof value.name !== 'string') return false;
  if (value.input !== undefined && value.input !== null && !isRecord(value.input)) return false;
  if (value.tool_use_id !== undefined && typeof value.tool_use_id !== 'string') return false;
  if (value.is_error !== undefined && typeof value.is_error !== 'boolean') return false;
  return true;
}

function isClaudeMessage(value: unknown): value is ClaudeMessage {
  if (!isRecord(value)) return false;
  if (value.id !== undefined && typeof value.id !== 'string') return false;
  if (value.role !== undefined && typeof value.role !== 'string') return false;
  if (value.model !== undefined && typeof value.model !== 'string') return false;
  if (value.content !== undefined) {
    const content = value.content;
    if (typeof content !== 'string' && (!Array.isArray(content) || !content.every(isClaudeContentBlock))) {
      return false;
    }
  }
  if (value.usage !== undefined && !isRecord(value.usage)) return false;
  return true;
}

function isClaudeLine(value: unknown): value is ClaudeLine {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.uuid !== undefined && typeof value.uuid !== 'string' && typeof value.uuid !== 'number') return false;
  if (value.parentUuid !== undefined && value.parentUuid !== null && typeof value.parentUuid !== 'string' && typeof value.parentUuid !== 'number') return false;
  if (value.sessionId !== undefined && typeof value.sessionId !== 'string') return false;
  if (value.timestamp !== undefined && typeof value.timestamp !== 'string' && typeof value.timestamp !== 'number') return false;
  if (value.cwd !== undefined && typeof value.cwd !== 'string') return false;
  if (value.version !== undefined && typeof value.version !== 'string') return false;
  if (value.gitBranch !== undefined && typeof value.gitBranch !== 'string') return false;
  if (value.entrypoint !== undefined && typeof value.entrypoint !== 'string') return false;
  if (value.isSidechain !== undefined && typeof value.isSidechain !== 'boolean') return false;
  if (value.isMeta !== undefined && typeof value.isMeta !== 'boolean') return false;
  if (value.isCompactSummary !== undefined && typeof value.isCompactSummary !== 'boolean') return false;
  if (value.agentId !== undefined && typeof value.agentId !== 'string') return false;
  if (value.message !== undefined && !isClaudeMessage(value.message)) return false;
  // Optional side-channel fields: a wrong type drops the field, not the whole line.
  for (const key of ['subtype', 'permissionMode'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') delete value[key];
  }
  for (const key of ['attachment', 'compactMetadata', 'params', 'modelUsage'] as const) {
    if (value[key] !== undefined && !isRecord(value[key])) delete value[key];
  }
  if (value.totalCostUSD !== undefined && typeof value.totalCostUSD !== 'number') delete value.totalCostUSD;
  return true;
}

function parseClaudeLine(rawLine: string): ClaudeLine | null {
  try {
    const parsed: unknown = JSON.parse(rawLine);
    if (!isClaudeLine(parsed)) return null;
    const record = parsed as unknown as Record<string, unknown>;
    if (typeof record.uuid === 'number') record.uuid = String(record.uuid);
    if (typeof record.parentUuid === 'number') record.parentUuid = String(record.parentUuid);
    if (typeof record.timestamp === 'number') record.timestamp = new Date(record.timestamp).toISOString();
    return parsed;
  } catch {
    return null;
  }
}

function parseClaudeLines(raw: string): ClaudeLine[] {
  const lines: ClaudeLine[] = [];
  for (const rawLine of raw.split('\n')) {
    if (!rawLine.trim()) continue;
    const parsed = parseClaudeLine(rawLine);
    if (parsed) lines.push(parsed);
  }
  return lines;
}

function toContentArray(content: ClaudeContentBlock[] | string | undefined): ClaudeContentBlock[] {
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

function userHasText(line: ClaudeLine): boolean {
  const content = line.message?.content;
  let text: string;
  if (typeof content === 'string') {
    text = content.trim();
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block.type === 'text' && block.text) parts.push(block.text);
    }
    text = parts.join('\n').trim();
  } else {
    return false;
  }
  if (text.length === 0) return countClaudeImages(line) > 0;
  // Claude wraps slash-command input/output in <command-...> / <local-command-...> tags
  if (/^<(local-)?command-/.test(text)) return false;
  // Interrupt markers are auto-injected when the user cancels a tool call
  if (text.startsWith('[Request interrupted')) return false;
  return true;
}

/** Raw text of a user line, joined across text blocks.
 *  @returns the text, or '' for non-text content
 *  Exists so command and interrupt detection read the same text userHasText does. */
function rawUserText(line: ClaudeLine): string {
  const content = line.message?.content;                           // String or block array.
  if (typeof content === 'string') return content.trim();          // Plain string form.
  return toContentArray(content)
    .filter(block => block.type === 'text' && block.text)          // Only text blocks carry the prompt.
    .map(block => block.text)
    .join('\n')
    .trim();
}

/** Slash command a user typed, from Claude Code's `<command-name>/x</command-name>` wrapper.
 *  @returns the command name without the leading slash (matches Copilot's `slashCommand`), or null
 *  Exists because command lines were previously dropped, so Claude never got credit for slash commands. */
function claudeCommandName(line: ClaudeLine): string | null {
  if (line.type !== 'user' || line.isMeta) return null;            // Commands are typed by the user.
  const text = rawUserText(line);                                  // Wrapper text, e.g. <command-name>/review</command-name>.
  if (!text.startsWith('<command-')) return null;                  // Local-command output starts with <local-command-.
  const match = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/.exec(text); // Name inside the wrapper.
  return match ? match[1] : null;                                  // e.g. 'review'.
}

/** Arguments typed after a slash command, from `<command-args>`.
 *  @returns the argument text, or '' when none */
function claudeCommandArgs(line: ClaudeLine): string {
  const match = /<command-args>([\s\S]*?)<\/command-args>/.exec(rawUserText(line)); // Free text after the command.
  return match ? match[1].trim() : '';
}

/** True when this line starts a new user turn: a typed prompt or a typed slash command.
 *  Exists so every loop that splits turns uses the same boundary. */
function isTurnStart(line: ClaudeLine): boolean {
  return line.type === 'user' && (userHasText(line) || claudeCommandName(line) !== null);
}

/** True for the marker Claude Code writes when the user presses Esc mid-response. */
function isInterruptMarker(line: ClaudeLine): boolean {
  return line.type === 'user' && rawUserText(line).startsWith('[Request interrupted'); // Covers "... by user" and "... for tool use".
}

function getTimestamp(timestamp?: string): number | null {
  return timestamp ? new Date(timestamp).getTime() : null;
}

function getNumberField(record: Record<string, unknown> | undefined, key: string): number {
  const value = record?.[key];
  return typeof value === 'number' ? value : 0;
}

function getInputPath(input: Record<string, unknown> | undefined, key: string): string | null {
  const value = input?.[key];
  return typeof value === 'string' ? value : null;
}

function getClaudeUserText(line: ClaudeLine): string {
  return toContentArray(line.message?.content)
    .filter(block => block.type === 'text')
    .map(block => block.text || '')
    .join('\n');
}

function countClaudeImages(line: ClaudeLine): number {
  return imageReferencesFromContent(line.message?.content).length;
}

function claudeTranscriptKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return createHash('sha256').update(process.platform === 'win32' ? resolved.toLowerCase() : resolved).digest('hex').slice(0, 32);
}

function claudeRequestId(line: ClaudeLine, sessionId: string, requestIndex: number, transcriptKey: string): string {
  return line.uuid || `${line.sessionId ?? sessionId}:claude:${transcriptKey}:${requestIndex}`;
}

export function extractClaudeImageReferences(
  filePath: string,
  requestId: string,
  match?: ImageRequestMatch,
): { images: ImageReference[]; workspaceRootPath?: string } {
  let sessionId = path.basename(filePath, '.jsonl');
  const transcriptKey = claudeTranscriptKey(filePath);
  let firstLine = true;
  let requestIndex = 0;
  let workspaceRootPath: string | undefined;
  let images: ImageReference[] = [];
  let found = false;
  let done = false;
  forEachJsonlLine(filePath, raw => {
    if (!firstLine && !raw.includes('"user"')) return;
    const line = parseClaudeLine(raw);
    if (!line) return;
    if (firstLine) {
      sessionId = line.sessionId || sessionId;
      firstLine = false;
    }
    if (line.type !== 'user' || !userHasText(line)) return;
    if (!workspaceRootPath && line.cwd) workspaceRootPath = line.cwd;
    const id = claudeRequestId(line, sessionId, requestIndex, transcriptKey);
    requestIndex++;
    if (!found && (match?.userEventId ? line.uuid === match.userEventId : id === requestId)) {
      images = imageReferencesFromContent(line.message?.content);
      if (line.cwd) workspaceRootPath = line.cwd;
      found = true;
    }
    const needsRoot = images.some(image => image.path && !path.isAbsolute(image.path) && !/^[a-z][a-z0-9+.-]*:/i.test(image.path));
    done = found && (workspaceRootPath !== undefined || !needsRoot);
  }, () => done);
  return { images, workspaceRootPath };
}

function applyClaudeToolBlock(
  block: ClaudeContentBlock,
  data: Pick<ClaudeAssistantData, 'toolsUsed' | 'editedFiles' | 'referencedFiles' | 'skillsUsed' | 'editLocs' | 'investigationDelegations' | 'webDomains'>,
  failed: boolean,
): void {
  if (block.type !== 'tool_use' || !block.name) return;

  data.toolsUsed.push(block.name);
  data.webDomains.push(...recordedWebDomains(block.name, block.input));
  const role = recordedInvestigation(block.name, block.input);
  if (role && !data.investigationDelegations.includes(role)) data.investigationDelegations.push(role);
  if (failed) return;

  // Claude Code's Skill tool: { name: 'Skill', input: { skill: '<name>', args: '...' } }
  if (block.name === 'Skill') {
    const skillName = getInputPath(block.input, 'skill')?.trim();
    if (skillName && !skillName.includes('ai_toolkit')) data.skillsUsed.push(skillName);
    return;
  }
  if (CLAUDE_WRITE_TOOLS.has(block.name)) {
    const filePath = getInputPath(block.input, 'file_path');
    if (filePath) {
      data.editedFiles.push(filePath);
      if (block.name === 'Write') {
        const content = getInputPath(block.input, 'content');
        if (content !== null) recordCreatedContent(data.editLocs, filePath, content);
      } else if (block.name === 'Edit') {
        const previous = getInputPath(block.input, 'old_string')
          ?? getInputPath(block.input, 'old_str')
          ?? '';
        const next = getInputPath(block.input, 'new_string')
          ?? getInputPath(block.input, 'new_str')
          ?? '';
        if (previous || next) recordContentReplacement(data.editLocs, filePath, previous, next);
      } else if (Array.isArray(block.input?.edits)) {
        for (const rawEdit of block.input.edits) {
          if (!isRecord(rawEdit)) continue;
          const previous = getInputPath(rawEdit, 'old_string')
            ?? getInputPath(rawEdit, 'old_str')
            ?? '';
          const next = getInputPath(rawEdit, 'new_string')
            ?? getInputPath(rawEdit, 'new_str')
            ?? '';
          if (previous || next) recordContentReplacement(data.editLocs, filePath, previous, next);
        }
      }
    }
    return;
  }

  if (CLAUDE_READ_FILE_TOOLS.has(block.name)) {
    const filePath = getInputPath(block.input, 'file_path');
    if (filePath) data.referencedFiles.push(filePath);
    return;
  }

  if (CLAUDE_READ_PATH_TOOLS.has(block.name)) {
    const targetPath = getInputPath(block.input, 'path');
    if (targetPath) data.referencedFiles.push(targetPath);
  }
}

function collectClaudeToolResults(
  lines: ClaudeLine[],
  startIndex: number,
  isCommandTurn = false,
): { completed: Set<string>; failed: Set<string> } {
  const completed = new Set<string>();
  const failed = new Set<string>();
  let seenAssistant = false;                                       // Command bodies only come before the first reply.
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    if (line.type === 'assistant') seenAssistant = true;
    // Same turn boundary as collectClaudeAssistantData, including command-body absorption.
    if (isTurnStart(line) && !(isCommandTurn && line.isMeta === true && !seenAssistant)) break;
    if (line.type !== 'user') continue;
    for (const block of toContentArray(line.message?.content)) {
      if (block.type !== 'tool_result' || !block.tool_use_id) continue;
      completed.add(block.tool_use_id);
      if (block.is_error === true) failed.add(block.tool_use_id);
    }
  }
  return { completed, failed };
}

/** One deduplicated API call: the model and the usage reported for its message.id. */
interface ClaudeApiCall {
  model: string;
  usage: Record<string, unknown> | undefined;
}

/** Model id Claude Code writes for client-side placeholder messages (no API call, no cost). */
const SYNTHETIC_MODEL = '<synthetic>';
/** Tools that write or update the session's task list. */
const CLAUDE_TODO_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate']);
/** Attachment kinds that record a user @-mention of a file or folder. */
const CLAUDE_MENTION_ATTACHMENTS = new Set(['file', 'directory']);

/** Instruction files carried by an `attachment` line (`instructions` and `nested_memory`).
 *  @returns path → size in characters; empty for other attachments
 *  Exists so CLAUDE.md usage counts as custom instructions, as copilot-instructions.md does for Copilot. */
export function claudeInstructionFiles(line: ClaudeLine): Map<string, number> {
  const out = new Map<string, number>();                          // path → characters loaded.
  const attachment = line.attachment;
  if (line.type !== 'attachment' || !attachment) return out;      // Only attachment lines carry these.
  if (attachment.type === 'instructions' && Array.isArray(attachment.files)) {
    // Session-start load: one entry per CLAUDE.md / rules file in scope.
    for (const file of attachment.files) {
      if (!isRecord(file) || typeof file.path !== 'string') continue;        // Skip malformed entries.
      out.set(file.path, typeof file.content === 'string' ? file.content.length : 0); // Size drives instruction-bloat.
    }
  } else if (attachment.type === 'nested_memory' && typeof attachment.path === 'string') {
    // Mid-session load of a nested CLAUDE.md when Claude enters a subfolder.
    const content = isRecord(attachment.content) ? attachment.content.content : undefined;
    out.set(attachment.path, typeof content === 'string' ? content.length : 0);
  }
  return out;
}

/** Compaction event from a `system/compact_boundary` line, mapped to the shared CompactionEvent shape.
 *  @returns the event, or null for other lines
 *  Exists so Claude compactions feed the context-management analysis (previously always empty). */
function claudeCompaction(line: ClaudeLine): CompactionEvent | null {
  if (line.type !== 'system' || line.subtype !== 'compact_boundary') return null; // Only boundary lines.
  const meta = line.compactMetadata;                               // trigger, preTokens, durationMs, postTokens.
  return {
    mode: 'full',                                                  // Claude always summarizes the whole conversation.
    numRounds: 0,                                                  // Not recorded by Claude Code.
    numRoundsSinceLastSummarization: 0,                            // Not recorded by Claude Code.
    contextLengthBefore: getNumberField(meta, 'preTokens'),        // Context size that triggered compaction.
    durationMs: getNumberField(meta, 'durationMs'),                // Time spent summarizing.
    model: '',                                                     // Summarizer model is not recorded.
    outcome: typeof meta?.trigger === 'string' ? meta.trigger : 'unknown', // 'auto' or 'manual' (/compact).
  };
}

/** Sum deduplicated API calls into token totals, context size and list-price cost.
 *  @param calls message.id → call, in first-seen order
 *  @param lastCallKey key of the most recent call (its context size is the turn's context size)
 *  Exists because summing per line double-counts: one response spans several lines. */
function totalClaudeCalls(data: ClaudeAssistantData, calls: Map<string, ClaudeApiCall>, lastCallKey: string | null): void {
  for (const [key, call] of calls) {
    if (call.model === SYNTHETIC_MODEL) continue;                  // Client-side placeholder: no tokens, no cost.
    data.callModels.add(normalizeModel(call.model));               // Every model the transcript actually priced.
    const usage = call.usage;
    const cacheRead = getNumberField(usage, 'cache_read_input_tokens');
    const cacheWrite = getNumberField(usage, 'cache_creation_input_tokens');
    const callInput = getNumberField(usage, 'input_tokens') + cacheRead + cacheWrite; // Total prompt size of this call.
    data.totalInputTokens += callInput;                            // Cumulative input across calls (billing).
    data.totalOutputTokens += getNumberField(usage, 'output_tokens');
    data.totalCacheReadTokens += cacheRead;
    data.totalCacheWriteTokens += cacheWrite;
    if (key === lastCallKey) data.lastCallContextTokens = callInput; // Last call = how full the context window got.
    if (!usage || data.costUSD === null) continue;                 // No usage, or cost already unknown.
    const callCost = claudeCallCostUSD(call.model, usage);         // Exact list price of this call.
    data.costUSD = callCost === null ? null : data.costUSD + callCost; // One unpriced call makes the turn's cost unknown.
  }
}

/** Collect everything Claude did between one user turn and the next.
 *  @param lines all parsed lines of the transcript
 *  @param startIndex index just after the turn's user line
 *  @param lastTs latest timestamp seen so far in the session
 *  @returns per-turn data plus `nextIndex`, the index of the next turn start
 *  Exists to turn Claude's line-per-block log into one request per user turn. */
function collectClaudeAssistantData(lines: ClaudeLine[], startIndex: number, lastTs: number | null, isCommandTurn = false): ClaudeAssistantData {
  const data: ClaudeAssistantData = {
    nextIndex: startIndex,
    lastTs,
    assistantTexts: [],
    toolsUsed: [],
    editedFiles: [],
    referencedFiles: [],
    skillsUsed: [],
    model: '',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    lastCallContextTokens: 0,
    costUSD: 0,
    assistantCount: 0,
    callModels: new Set(),
    firstAssistantTs: null,
    canceled: false,
    apiError: false,
    fileMentions: [],
    instructionFiles: new Map(),
    compaction: null,
    trailingCompaction: null,
    effort: null,
    subagentIds: [],
    todoOps: [],
    editLocs: new Map(),
    answerEvidence: 'missing',
    investigationDelegations: [],
    webDomains: [],
  };

  const toolResults = collectClaudeToolResults(lines, startIndex, isCommandTurn);
  const calls = new Map<string, ClaudeApiCall>();                  // message.id → call; dedupes repeated usage.
  let lastCallKey: string | null = null;                           // Most recent call, for context size.
  let i = startIndex;
  while (i < lines.length) {
    const next = lines[i];
    // A command's expanded skill/prompt body (isMeta, before any reply) belongs to the command turn.
    const isCommandBody = isCommandTurn && next.isMeta === true && calls.size === 0;
    if (isTurnStart(next) && !isCommandBody) break;                // Next prompt or command ends this turn.
    if (isInterruptMarker(next)) data.canceled = true;             // User pressed Esc during this turn.
    // Subagent launches report their agentId on the tool_result line.
    const agentId = isRecord(next.toolUseResult) ? next.toolUseResult.agentId : undefined;
    if (typeof agentId === 'string' && !data.subagentIds.includes(agentId)) data.subagentIds.push(agentId);
    // Attachments: @file mentions and instruction (CLAUDE.md) loads.
    const attachmentType = next.attachment?.type;
    if (next.type === 'attachment' && typeof attachmentType === 'string' && CLAUDE_MENTION_ATTACHMENTS.has(attachmentType)) {
      const mention = next.attachment?.filename ?? next.attachment?.path; // Files use `filename`, folders `path`.
      if (typeof mention === 'string') data.fileMentions.push(mention);
    }
    for (const [filePath, size] of claudeInstructionFiles(next)) data.instructionFiles.set(filePath, size);
    // A compaction belongs to this turn only if the model is called again after it.
    data.trailingCompaction = claudeCompaction(next) ?? data.trailingCompaction;
    if (next.type === 'system' && next.subtype === 'api_error') data.apiError = true; // Retries or failure.
    // Requested reasoning effort travels on the api-request line before each call.
    const outputConfig = next.type === 'api-request' && isRecord(next.params?.output_config) ? next.params.output_config : undefined;
    if (typeof outputConfig?.effort === 'string') data.effort = outputConfig.effort;
    if (next.type === 'assistant') {
      const blocks = toContentArray(next.message?.content);
      const hasText = blocks.some(block => block.type === 'text' && block.text?.trim());
      data.answerEvidence = hasText && next.message?.stop_reason === 'end_turn' ? 'final'
        : hasText && next.message?.stop_reason == null && !blocks.some(block => block.type === 'tool_use') ? 'legacy' : 'missing';
      const assistantTs = getTimestamp(next.timestamp);
      if (assistantTs && (!data.lastTs || assistantTs > data.lastTs)) data.lastTs = assistantTs;
      if (assistantTs && !data.firstAssistantTs) data.firstAssistantTs = assistantTs; // Time to first response.
      const model = next.message?.model ?? '';
      if (!data.model && model && model !== SYNTHETIC_MODEL) data.model = model; // Placeholders are not a model choice.

      // Every line of one response repeats its usage: keep one entry per message.id.
      const callKey = next.message?.id ?? `line-${i}`;             // Lines without an id are distinct calls.
      calls.set(callKey, { model, usage: next.message?.usage });   // Later lines overwrite with the same final usage.
      if (data.trailingCompaction) {
        data.compaction = data.trailingCompaction;                 // A call followed it: it happened mid-turn.
        data.trailingCompaction = null;
      }
      lastCallKey = callKey;

      for (const block of blocks) {
        if (block.type === 'text' && block.text) {
          data.assistantTexts.push(block.text);
          continue;
        }
        const incomplete = !!block.id && !toolResults.completed.has(block.id);
        const failed = incomplete || (!!block.id && toolResults.failed.has(block.id));
        applyClaudeToolBlock(block, data, failed);
        if (!failed && block.type === 'tool_use' && block.name && CLAUDE_TODO_TOOLS.has(block.name)) {
          data.todoOps.push(block);                                // Applied to the session task list later.
        }
        // Extract code content from write tools so extractCodeBlocks() can count LoC.
        // Claude Write uses `content`; current Edit uses `new_string` (legacy logs used `new_str`).
        if (!failed && block.type === 'tool_use' && block.name && CLAUDE_WRITE_TOOLS.has(block.name) && block.input) {
          const filePath = getInputPath(block.input, 'file_path');
          const code = typeof block.input.content === 'string' ? block.input.content
            : typeof block.input.new_string === 'string' ? block.input.new_string
              : typeof block.input.new_str === 'string' ? block.input.new_str
              : null;
          if (code && filePath) {
            const ext = filePath.split('.').pop() || 'unknown';
            data.assistantTexts.push(`\`\`\`${ext}\n${code}\n\`\`\``);
          }
        }
      }
    }
    i++;
  }

  data.assistantCount = [...calls.values()].filter(call => call.model !== SYNTHETIC_MODEL).length; // Real API calls only.
  totalClaudeCalls(data, calls, lastCallKey);                      // Tokens and cost, once per call.
  data.nextIndex = i;
  return data;
}

export function findClaudeDirs(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dirs: string[] = [];
  const projectsDir = path.join(home, '.claude', 'projects');
  if (fs.existsSync(projectsDir)) dirs.push(projectsDir);
  return dirs;
}

/** Encode a single filesystem component the way Claude Code does:
 *  replace whitespace with hyphens. Path separators never appear in a single
 *  component name, and colons are not handled here because Windows component
 *  names cannot contain them. */
function encodeComponentForMatch(name: string): string {
  return name.replace(/\s/g, '-');
}

/**
 * Resolve an encoded Claude project directory name back to the real folder name.
 *
 * Claude encodes workspace paths by replacing `/`, `\`, `:`, and whitespace
 * with `-`.  For example `c--dev-AI-Engineering-Coach` represents
 * `C:\dev\AI-Engineering-Coach`.  Because the encoding is lossy (hyphens, spaces,
 * and path separators all become `-`) we resolve the name by listing each
 * directory level and matching entries against the remaining encoded string.
 *
 * @param encoded  The encoded project directory name.
 * @param _projectsDir  The `.claude/projects` directory containing this project.
 */
function projectNameFromEncoded(encoded: string, _projectsDir: string): string {
  const segments = encoded.split('-');
  let root: string;
  let startIdx: number;

  // Windows drive: encoded starts with "<letter>--..." → "X:\\"
  if (segments.length >= 2 && /^[a-zA-Z]$/.test(segments[0]) && segments[1] === '') {
    root = `${segments[0]}:\\`;
    startIdx = 2;
  // Unix-style absolute path: encoded starts with "-..." → "/"
  } else if (segments[0] === '') {
    root = '/';
    startIdx = 1;
  } else {
    return encoded;  // unexpected format
  }

  // Join remaining segments back into the encoded tail so we can match
  // against directory entries whose names may contain spaces or hyphens.
  const remaining = segments.slice(startIdx).join('-');
  let resolved = root;
  let offset = 0;

  while (offset < remaining.length) {
    let dirEntries: { name: string; encoded: string }[];
    try {
      dirEntries = fs.readdirSync(resolved, { withFileTypes: true })
        .filter(e => e.isDirectory() || e.isSymbolicLink())
        .map(e => ({ name: e.name, encoded: encodeComponentForMatch(e.name) }))
        // Longest encoded form first — greedy match avoids splitting names
        // that contain hyphens (e.g. `AI-Engineering-Coach`).
        .sort((a, b) => b.encoded.length - a.encoded.length);
    } catch {
      break;
    }

    const rest = remaining.slice(offset);
    let found = false;
    for (const entry of dirEntries) {
      if (rest === entry.encoded) {
        // Exact match — last component
        resolved = path.join(resolved, entry.name);
        offset = remaining.length;
        found = true;
        break;
      }
      if (rest.startsWith(entry.encoded + '-')) {
        resolved = path.join(resolved, entry.name);
        offset += entry.encoded.length + 1;
        found = true;
        break;
      }
    }

    if (!found) {
      // Can't resolve further — take the rest as one segment
      resolved = path.join(resolved, rest);
      break;
    }
  }

  return path.basename(resolved);
}

/** Latest request that started at or before `ts`: the turn that was running then.
 *  @returns that request, or undefined when `ts` is unknown or precedes every request */
function requestActiveAt(requests: SessionRequest[], ts: number | null): SessionRequest | undefined {
  if (ts == null) return undefined;                                // Cannot place an untimed request.
  let owner: SessionRequest | undefined;
  for (const request of requests) {
    if (request.timestamp != null && request.timestamp <= ts && (!owner || request.timestamp >= (owner.timestamp ?? 0))) {
      owner = request;                                             // Latest turn that had already started.
    }
  }
  return owner;
}

/** Add two nullable token counts, keeping null only when both are null. */
function addTokens(a: number | null, b: number | null): number | null {
  return a == null && b == null ? null : (a ?? 0) + (b ?? 0);
}

/** Fold one subagent request into the parent request that launched it.
 *  @param owner the parent session's request (mutated)
 *  @param sub a request parsed from the subagent transcript
 *  @param editLocIndex per-request edit line counts; the subagent's entry moves to the owner
 *  Exists so request counts reflect what the user typed while tokens, cost and edits stay complete. */
function mergeSubagentRequest(owner: SessionRequest, sub: SessionRequest, editLocIndex?: EditLocIndex): void {
  // Tokens: billing totals add up; context size stays the parent's (subagents have their own window).
  owner.promptTokens = addTokens(owner.promptTokens, sub.promptTokens);
  owner.completionTokens = addTokens(owner.completionTokens, sub.completionTokens);
  owner.cacheReadTokens = addTokens(owner.cacheReadTokens, sub.cacheReadTokens);
  owner.cacheWriteTokens = addTokens(owner.cacheWriteTokens, sub.cacheWriteTokens);
  // Cost: unknown on either side makes the total unknown; undefined means "not priced at all".
  if (sub.costUSD !== undefined) {
    owner.costUSD = owner.costUSD === null || sub.costUSD === null ? null : (owner.costUSD ?? 0) + sub.costUSD;
  }
  // Activity: what the subagent did counts towards the user's turn.
  owner.toolsUsed.push(...sub.toolsUsed);
  owner.aiCode.push(...sub.aiCode);                                // AI-written code feeds LoC output stats.
  owner.editedFiles = [...new Set([...owner.editedFiles, ...sub.editedFiles])];
  owner.referencedFiles = [...new Set([...owner.referencedFiles, ...sub.referencedFiles])];
  owner.skillsUsed = [...new Set([...owner.skillsUsed, ...sub.skillsUsed])];
  owner.webDomains = [...new Set([...(owner.webDomains ?? []), ...(sub.webDomains ?? [])])];
  owner.investigationDelegations = [...new Set([...(owner.investigationDelegations ?? []), ...(sub.investigationDelegations ?? [])])];
  // Edit line counts are indexed by request id: move the subagent's onto the owner.
  const subLocs = editLocIndex?.get(sub.requestId);
  if (editLocIndex && subLocs) {
    const ownerLocs = editLocIndex.get(owner.requestId) ?? new Map<string, EditLoc>();
    for (const [file, loc] of subLocs) {
      const prev = ownerLocs.get(file);                            // Same file edited by parent and subagent.
      ownerLocs.set(file, { added: (prev?.added ?? 0) + loc.added, removed: (prev?.removed ?? 0) + loc.removed });
    }
    editLocIndex.set(owner.requestId, ownerLocs);
    editLocIndex.delete(sub.requestId);                            // No orphan entry for a request that no longer exists.
  }
}

function parseClaudeProjectSessions(
  projectsDir: string,
  dirName: string,
  editLocIndex?: EditLocIndex,
  sessionSourceIndex?: Map<string, SessionSource>,
): { sessions: Session[]; workspaceId: string; workspaceName: string } | null {
  const projPath = path.join(projectsDir, dirName);
  const workspaceId = `claude-${dirName}`;
  const workspaceName = projectNameFromEncoded(dirName, projectsDir);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projPath, { withFileTypes: true });
  } catch {
    return null;
  }

  // Pass 1: parse parent sessions from top-level .jsonl files. Index them by
  // sessionId so subagent files (in `<sessionId>/subagents/agent-*.jsonl`)
  // can be merged into the right parent in pass 2.
  const sessionsById = new Map<string, Session>();
  const sessions: Session[] = [];
  const sessionFiles = new Map<string, string[]>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const filePath = path.join(projPath, entry.name);
    const session = parseClaudeSessionFile(filePath, workspaceId, workspaceName, editLocIndex);
    if (!session) continue;
    sessions.push(session);
    sessionsById.set(session.sessionId, session);
    sessionFiles.set(session.sessionId, [filePath]);
  }

  // Pass 2: walk `<sessionId>/subagents/agent-*.jsonl` directories. Each
  // subagent file is a fan-out of work the parent session orchestrated; we
  // merge its requests into the parent rather than emitting it as its own
  // session. Orphans (subagent dir whose parent session is missing) become
  // standalone programmatic sessions — they're still GHCP-spawned work.
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const subagentDir = path.join(projPath, entry.name, 'subagents');
    let subagentEntries: fs.Dirent[];
    try {
      subagentEntries = fs.readdirSync(subagentDir, { withFileTypes: true });
    } catch {
      continue; // no subagents/ folder under this session — fine
    }

    const parent = sessionsById.get(entry.name);
    const orphanRequests: SessionRequest[] = [];
    let orphanFirstTs: number | null = null;
    let orphanLastTs: number | null = null;
    let orphanEntrypoint: string | undefined;

    for (const subEntry of subagentEntries) {
      if (!subEntry.isFile() || !subEntry.name.endsWith('.jsonl')) continue;
      const filePath = path.join(subagentDir, subEntry.name);
      const subSession = parseClaudeSessionFile(filePath, workspaceId, workspaceName, editLocIndex);
      if (!subSession) continue;
      const sourceId = parent?.sessionId ?? entry.name;
      const files = sessionFiles.get(sourceId) ?? [];
      files.push(filePath);
      sessionFiles.set(sourceId, files);

      if (parent) {
        // Fold subagent work into the parent request that launched it: the
        // subagent's prompt was written by Claude, not typed by the user, so it
        // must not count as a separate request. Its tokens, cost, tools and
        // edits still belong to the user's turn (Copilot reports subagents the same way).
        const agentId = /^agent-(.+)\.jsonl$/.exec(subEntry.name)?.[1]; // File name carries the agent id.
        for (const r of subSession.requests) {
          const owner = (agentId ? subagentOwners.get(parent)?.get(agentId) : undefined)
            ?? requestActiveAt(parent.requests, r.timestamp);      // Older logs lack the id: use the turn running at that time.
          if (owner) mergeSubagentRequest(owner, r, editLocIndex);
          else parent.requests.push(r);                            // Nothing to attach to: keep it visible rather than drop it.
        }
        // Subagent calls are priced per call too: their models are not background.
        const parentModels = sessionCallModels.get(parent) ?? new Set<string>();
        for (const model of sessionCallModels.get(subSession) ?? []) parentModels.add(model);
        sessionCallModels.set(parent, parentModels);
        finalizeBackgroundModels(parent);
        // Extend parent's last-message timestamp if the subagent ran longer.
        if (subSession.lastMessageDate &&
            (!parent.lastMessageDate || subSession.lastMessageDate > parent.lastMessageDate)) {
          parent.lastMessageDate = subSession.lastMessageDate;
        }
      } else {
        for (const r of subSession.requests) orphanRequests.push(r);
        if (subSession.creationDate &&
            (!orphanFirstTs || subSession.creationDate < orphanFirstTs)) {
          orphanFirstTs = subSession.creationDate;
        }
        if (subSession.lastMessageDate &&
            (!orphanLastTs || subSession.lastMessageDate > orphanLastTs)) {
          orphanLastTs = subSession.lastMessageDate;
        }
        if (!orphanEntrypoint && subSession.entrypoint) orphanEntrypoint = subSession.entrypoint;
      }
    }

    if (parent) continue;

    if (orphanRequests.length > 0) {
      warnCore('parser-claude', `subagent dir without parent session: ${entry.name}`, {
        requestCount: orphanRequests.length,
      });
      orphanRequests.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
      const launcherKind: 'interactive' | 'programmatic' = 'programmatic';
      const orphan = createSession({
        sessionId: entry.name,
        workspaceId,
        workspaceName,
        location: 'terminal',
        harness: harnessForLauncher(launcherKind),
        creationDate: orphanFirstTs,
        lastMessageDate: orphanLastTs,
        requests: orphanRequests,
        launcherKind,
        entrypoint: orphanEntrypoint,
      });
      sessions.push(orphan);
    }
  }

  // Final pass: re-sort merged parent sessions' requests by timestamp and
  // refresh the cached requestCount.
  for (const session of sessions) {
    if (session.requests.length > 1) {
      session.requests.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    }
    session.requestCount = session.requests.length;
    const files = sessionFiles.get(session.sessionId);
    if (files?.length) {
      sessionSourceIndex?.set(session.sessionId, {
        kind: 'claude-jsonl',
        filePath: files[0],
        additionalFilePaths: files.slice(1),
        workspaceId,
        workspaceName,
        workspaceRootPath: session.workspaceRootPath,
        harness: session.harness,
      });
    }
  }

  return sessions.length > 0 ? { sessions, workspaceId, workspaceName } : null;
}

export function parseClaudeSessions(
  projectsDir: string,
  editLocIndex?: EditLocIndex,
  sessionSourceIndex?: Map<string, SessionSource>,
): { sessions: Session[]; workspaceId: string; workspaceName: string }[] {
  const results: { sessions: Session[]; workspaceId: string; workspaceName: string }[] = [];

  let projectDirs: fs.Dirent[];
  try {
    projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter(e => e.isDirectory());
  } catch {
    return results;
  }

  for (const projDir of projectDirs) {
    const result = parseClaudeProjectSessions(projectsDir, projDir.name, editLocIndex, sessionSourceIndex);
    if (result) results.push(result);
  }

  return results;
}

export async function parseClaudeSessionsAsync(
  projectsDir: string,
  onProject?: (idx: number, total: number, name: string) => void,
  editLocIndex?: EditLocIndex,
  sessionSourceIndex?: Map<string, SessionSource>,
): Promise<{ sessions: Session[]; workspaceId: string; workspaceName: string }[]> {
  const results: { sessions: Session[]; workspaceId: string; workspaceName: string }[] = [];

  let projectDirs: string[];
  try {
    projectDirs = (await fs.promises.readdir(projectsDir, { withFileTypes: true }))
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    return results;
  }

  for (let i = 0; i < projectDirs.length; i++) {
    const dirName = projectDirs[i];
    const workspaceName = projectNameFromEncoded(dirName, projectsDir);

    if (onProject) onProject(i + 1, projectDirs.length, workspaceName);

    const result = parseClaudeProjectSessions(projectsDir, dirName, editLocIndex, sessionSourceIndex);
    if (result) results.push(result);

    // Yield every 5 projects so the event loop stays responsive
    if (i % 5 === 0) await new Promise<void>(r => setTimeout(r, 0));
  }

  return results;
}

function updateClaudeTimestampRange(
  ts: number | null,
  firstTs: number | null,
  lastTs: number | null,
): { firstTs: number | null; lastTs: number | null } {
  if (!ts) return { firstTs, lastTs };
  return {
    firstTs: !firstTs || ts < firstTs ? ts : firstTs,
    lastTs: !lastTs || ts > lastTs ? ts : lastTs,
  };
}

function extractSkillsFromRefs(referencedFiles: string[]): string[] {
  const skills = new Set<string>();
  for (const ref of referencedFiles) {
    const name = extractSkillNameFromPath(ref);
    if (name) skills.add(name);
  }
  return [...skills];
}

/** Session-level state carried from one turn to the next while parsing a transcript. */
interface ClaudeSessionState {
  /** Instruction files loaded so far: path → characters. CLAUDE.md stays in context for the rest of the session. */
  instructions: Map<string, number>;
  /** Running task list keyed by task id, built from TodoWrite / TaskCreate / TaskUpdate calls. */
  tasks: Map<number, TodoItem>;
  /** Compaction seen between turns, attached to the next request. */
  pendingCompaction: CompactionEvent | null;
}

/** Claude task status → the shared TodoItem status. */
function todoStatus(raw: unknown): TodoItem['status'] {
  if (raw === 'completed') return 'completed';                     // Done.
  if (raw === 'in_progress') return 'in-progress';                 // Being worked on.
  return 'not-started';                                            // 'pending' or unknown.
}

/** Apply this turn's task tool calls to the running task list.
 *  @returns a snapshot of the list, or null when the turn touched no tasks (matches Copilot semantics)
 *  Exists so Claude task lists appear in the context timeline like Copilot's manage_todo_list. */
function applyClaudeTodoOps(tasks: Map<number, TodoItem>, ops: ClaudeContentBlock[]): TodoItem[] | null {
  if (ops.length === 0) return null;                               // Snapshot only when tasks changed.
  for (const op of ops) {
    const input = op.input ?? {};
    if (op.name === 'TodoWrite' && Array.isArray(input.todos)) {
      // TodoWrite (older Claude Code) replaces the whole list each call.
      tasks.clear();
      input.todos.forEach((todo, index) => {
        if (!isRecord(todo)) return;                               // Skip malformed entries.
        const title = typeof todo.content === 'string' ? todo.content : '';
        tasks.set(index + 1, { id: index + 1, title, status: todoStatus(todo.status) });
      });
    } else if (op.name === 'TaskCreate') {
      // TaskCreate: Claude assigns sequential ids per session, so the next id is size + 1.
      const id = tasks.size + 1;
      const title = typeof input.subject === 'string' ? input.subject : '';
      tasks.set(id, { id, title, status: 'not-started' });
    } else if (op.name === 'TaskUpdate') {
      // TaskUpdate: change one task's status (and title when given).
      const id = Number(input.taskId);
      const existing = tasks.get(id);
      if (!existing) continue;                                     // Task created before the transcript starts.
      if (input.status !== undefined) existing.status = todoStatus(input.status);
      if (typeof input.subject === 'string') existing.title = input.subject;
    }
  }
  return [...tasks.values()].map(task => ({ ...task }));           // Copy so later turns don't mutate this snapshot.
}

/** Map Claude's permission mode to the shared agentMode vocabulary.
 *  @returns 'plan' for plan mode (also when the turn exited plan mode), otherwise 'agent'
 *  Exists so plan-mode rules see Claude's real mode instead of a hard-coded 'agent'. */
function claudeAgentMode(line: ClaudeLine, toolsUsed: string[]): string {
  if (line.permissionMode === 'plan' || toolsUsed.includes('ExitPlanMode')) return 'plan'; // Planning turn.
  return 'agent';                                                  // Every other Claude mode can act.
}

function buildClaudeRequest(
  line: ClaudeLine,
  assistantData: ClaudeAssistantData,
  userTs: number | null,
  requestId: string,
  state: ClaudeSessionState,
  isLastTurn: boolean,
  editLocIndex?: EditLocIndex,
): SessionRequest {
  const hasAnyTokens = assistantData.assistantCount > 0;
  const imageCount = countClaudeImages(line);
  const mentions = [...new Set(assistantData.fileMentions)];      // User @-mentions, deduped.
  const uniqueRefs = [...new Set([...mentions, ...assistantData.referencedFiles])];
  const skills = new Set(assistantData.skillsUsed);
  for (const name of extractSkillsFromRefs(uniqueRefs)) skills.add(name);
  // Variable kinds mirror Copilot's #file / image attachments.
  const variableKinds: Record<string, number> = {};
  if (imageCount > 0) variableKinds.image = imageCount;
  if (mentions.length > 0) variableKinds.file = mentions.length;
  // Typed slash commands become "/name args" so message text reads like what the user typed.
  const command = claudeCommandName(line);
  const messageText = command ? `/${command} ${claudeCommandArgs(line)}`.trim() : getClaudeUserText(line);
  // Instruction files loaded during this turn stay in context for later turns too.
  for (const [filePath, size] of assistantData.instructionFiles) state.instructions.set(filePath, size);
  const compaction = assistantData.compaction ?? state.pendingCompaction; // Between-turn compaction lands on the next request.
  state.pendingCompaction = assistantData.trailingCompaction;      // Compaction after our last call goes to the next prompt.
  // A turn without any API call either failed, was interrupted, or is still running.
  const endState: SessionRequest['endState'] = hasAnyTokens ? undefined
    : assistantData.apiError || assistantData.canceled ? 'errored'
      : isLastTurn ? 'pending' : undefined;
  const request = createRequest({
    requestId,
    userEventId: line.uuid,
    answerEvidence: assistantData.answerEvidence,
    timestamp: userTs,
    messageText,
    responseText: assistantData.assistantTexts.join('\n'),
    isCanceled: assistantData.canceled,
    agentName: 'Claude',
    agentMode: claudeAgentMode(line, assistantData.toolsUsed),
    modelId: assistantData.model,
    slashCommand: command ?? '',
    toolsUsed: assistantData.toolsUsed,
    investigationDelegations: assistantData.investigationDelegations,
    webDomains: [...new Set(assistantData.webDomains)],
    editedFiles: [...new Set(assistantData.editedFiles)],
    referencedFiles: uniqueRefs,
    skillsUsed: [...skills],
    variableKinds,
    customInstructions: [...state.instructions.keys()],            // CLAUDE.md files in context for this turn.
    firstProgress: userTs && assistantData.firstAssistantTs ? assistantData.firstAssistantTs - userTs : null,
    totalElapsed: userTs && assistantData.lastTs ? assistantData.lastTs - userTs : null,
    promptTokens: hasAnyTokens ? assistantData.totalInputTokens : null,      // Cumulative input across calls (billing).
    contextTokens: hasAnyTokens ? assistantData.lastCallContextTokens : null, // Last call's context size (window analysis).
    completionTokens: hasAnyTokens ? assistantData.totalOutputTokens : null,
    cacheReadTokens: assistantData.totalCacheReadTokens > 0 ? assistantData.totalCacheReadTokens : null,
    cacheWriteTokens: assistantData.totalCacheWriteTokens > 0 ? assistantData.totalCacheWriteTokens : null,
    costUSD: hasAnyTokens ? assistantData.costUSD : undefined,    // Exact list price; null = unpriced model.
    compaction,
    todoSnapshot: applyClaudeTodoOps(state.tasks, assistantData.todoOps),
    endState,
    // Requested effort beats the model-name suffix heuristic when Claude Code recorded it.
    reasoningEffort: canonicalizeReasoningEffort(assistantData.effort) ?? extractReasoningEffortFromModelId(assistantData.model),
    curiosity: line.isSidechain || line.isMeta || line.isCompactSummary ? { kind: 'excluded', excerpts: [] } : undefined,
  });
  mergeRequestEditLoc(editLocIndex, requestId, assistantData.editLocs);
  return request;
}

/** Claude Code's own cost report from the last `cost-state` line of a transcript.
 *  @returns the report keyed by normalized model id, or undefined when the transcript has none
 *  Exists because cost-state also covers background calls (titles, summaries) the transcript never shows. */
function claudeCostReport(lines: ClaudeLine[]): HarnessCostReport | undefined {
  // cost-state totals only grow within a transcript, so the last one is the session total.
  const last = [...lines].reverse().find(line => line.type === 'cost-state');
  if (!last || typeof last.totalCostUSD !== 'number') return undefined;
  const models: Record<string, ModelUsage> = {};
  for (const [rawModel, rawUsage] of Object.entries(last.modelUsage ?? {})) {
    if (!isRecord(rawUsage)) continue;                             // Skip malformed entries.
    const key = normalizeModel(rawModel);                          // `claude-opus-5-5[1m]` → `claude-opus-5.5`.
    const prev = models[key];                                      // [1m] and plain variants merge into one model.
    models[key] = {
      inputTokens: (prev?.inputTokens ?? 0) + getNumberField(rawUsage, 'inputTokens'),
      outputTokens: (prev?.outputTokens ?? 0) + getNumberField(rawUsage, 'outputTokens'),
      cacheReadTokens: (prev?.cacheReadTokens ?? 0) + getNumberField(rawUsage, 'cacheReadInputTokens'),
      cacheWriteTokens: (prev?.cacheWriteTokens ?? 0) + getNumberField(rawUsage, 'cacheCreationInputTokens'),
      reasoningTokens: (prev?.reasoningTokens ?? 0) + getNumberField(rawUsage, 'thinkingTokens'),
      costUSD: (prev?.costUSD ?? 0) + getNumberField(rawUsage, 'costUSD'),
    };
  }
  // backgroundModels is filled once subagents are merged, when every transcript model is known.
  return { totalCostUSD: last.totalCostUSD, hasUnknownModelCost: last.hasUnknownModelCost === true, models, backgroundModels: [] };
}

/** Normalized models of every transcript API call per session, including merged subagents. */
const sessionCallModels = new WeakMap<Session, Set<string>>();

/** Mark cost-report models the transcript never called as background-only.
 *  Exists so analyzers add those calls without double-counting models already priced per call. */
function finalizeBackgroundModels(session: Session): void {
  const report = session.harnessCostReport;
  if (!report) return;                                             // No cost-state in this transcript.
  const called = sessionCallModels.get(session) ?? new Set<string>();
  report.backgroundModels = Object.keys(report.models).filter(model => !called.has(model)); // Only hidden calls.
}

/** Subagent ids launched by each request, so subagent transcripts merge into the request that started them. */
const subagentOwners = new WeakMap<Session, Map<string, SessionRequest>>();

export function parseClaudeSessionFile(
  filePath: string,
  wsId: string,
  wsName: string,
  editLocIndex?: EditLocIndex,
): Session | null {
  assertTrustedPath(filePath);
  let raw: string;
  try {
    const content = readFileSafe(filePath);
    if (content === null) return null;
    raw = content;
  } catch {
    return null;
  }

  const lines = parseClaudeLines(raw);
  if (lines.length === 0) return null;

  const sessionId = lines[0].sessionId || path.basename(filePath, '.jsonl');
  const transcriptKey = claudeTranscriptKey(filePath);
  const requests: SessionRequest[] = [];
  const owners = new Map<string, SessionRequest>();               // agentId → request that launched it.
  const callModels = new Set<string>();                            // Every model called in this transcript.
  const state: ClaudeSessionState = { instructions: new Map(), tasks: new Map(), pendingCompaction: null };
  let maxInstructionChars = 0;                                     // Largest always-on instruction load seen.
  let cwd = '';
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let entrypoint: string | undefined;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!isTurnStart(line)) {
      // Between turns: CLAUDE.md loads and compactions still apply to the next request.
      for (const [instructionPath, size] of claudeInstructionFiles(line)) state.instructions.set(instructionPath, size);
      state.pendingCompaction = claudeCompaction(line) ?? state.pendingCompaction;
      i++;
      continue;
    }

    if (!cwd && line.cwd) cwd = line.cwd;
    // Capture the first non-empty entrypoint we see. In practice Claude Code
    // writes it on every user line, but we only need one.
    if (!entrypoint && line.entrypoint) entrypoint = line.entrypoint;
    const userTs = getTimestamp(line.timestamp);
    ({ firstTs, lastTs } = updateClaudeTimestampRange(userTs, firstTs, lastTs));

    const assistantData = collectClaudeAssistantData(lines, i + 1, lastTs, claudeCommandName(line) !== null);
    lastTs = assistantData.lastTs;
    // Local-only commands (/model, /clear, /cost) never reach the model: not a request.
    if (claudeCommandName(line) !== null && assistantData.assistantCount === 0 && !assistantData.canceled) {
      // A manual /compact lands here: keep its compaction for the next real request.
      state.pendingCompaction = assistantData.compaction ?? assistantData.trailingCompaction ?? state.pendingCompaction;
      for (const [instructionPath, size] of assistantData.instructionFiles) state.instructions.set(instructionPath, size);
      i = assistantData.nextIndex;
      continue;
    }
    const requestId = claudeRequestId(line, sessionId, requests.length, transcriptKey);
    const isLastTurn = assistantData.nextIndex >= lines.length;   // An unanswered last turn may still be running.
    const request = buildClaudeRequest(line, assistantData, userTs, requestId, state, isLastTurn, editLocIndex);
    requests.push(request);
    for (const agentId of assistantData.subagentIds) owners.set(agentId, request);
    for (const model of assistantData.callModels) callModels.add(model);
    const instructionChars = [...state.instructions.values()].reduce((sum, size) => sum + size, 0);
    maxInstructionChars = Math.max(maxInstructionChars, instructionChars);
    i = assistantData.nextIndex;
  }

  if (requests.length === 0) return null;

  const launcherKind = classifyLauncher(entrypoint);
  const session = createSession({
    sessionId,
    workspaceId: wsId,
    workspaceName: wsName,
    location: 'terminal',
    harness: harnessForLauncher(launcherKind),
    creationDate: firstTs,
    lastMessageDate: lastTs,
    requests,
    hasDevcontainer: detectDevcontainerFromRequests(requests, cwd),
    workspaceRootPath: cwd || undefined,
    launcherKind,
    entrypoint,
    // Only set when CLAUDE.md was seen, so "unknown" stays distinguishable from "empty".
    customInstructionsBytes: state.instructions.size > 0 ? maxInstructionChars : undefined,
    harnessCostReport: claudeCostReport(lines),
  });
  subagentOwners.set(session, owners);
  sessionCallModels.set(session, callModels);
  finalizeBackgroundModels(session);                               // Provisional; redone after subagent merge.
  return session;
}
