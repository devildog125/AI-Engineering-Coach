/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Copilot → Claude Code conversion for skills, agents and instructions (frontmatter half)
 *
 * Why this module exists: awesome-copilot skills carry Copilot-only frontmatter
 * (`applyTo`, Copilot `tools` lists, chat `mode`) and sometimes no valid `name`.
 * Claude Code loads a skill from `name` + `description` and ignores or rejects the rest.
 *
 * Targets: skills → ~/.claude/skills/<name>/SKILL.md, custom agents → Claude Code
 * subagents (~/.claude/agents/<name>.md), instructions → rules (~/.claude/rules/<name>.md,
 * `applyTo` becoming `paths`). Formats per https://code.claude.com/docs/en/sub-agents
 * and https://code.claude.com/docs/en/memory (checked 2026-10-30).
 *
 * Shape decision: the body rewrite (#file → @path, Copilot tool names → Claude
 * tools) is done by the language model, because it needs judgement. The frontmatter
 * is rebuilt here, deterministically, so a converted skill always loads in Claude
 * Code even if the model's output drifts or the model is unavailable.
 */

/** Claude Code / Agent Skills limits for the two required fields. */
const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
/** Scalar frontmatter keys worth carrying over: Claude Code reads argument-hint and allowed-tools;
 *  license and compatibility are standard Agent Skills fields. Nested `metadata` maps are dropped
 *  because this parser only rebuilds one-line values. */
const KEPT_KEYS = ['license', 'compatibility', 'allowed-tools', 'argument-hint'] as const;

/** Turn any title or name into a valid skill name: lowercase letters, digits and hyphens.
 *  @param raw a title, folder name or existing name
 *  @returns kebab-case name of at most 64 characters, or '' when nothing usable remains */
export function toSkillName(raw: string): string {
  return raw.toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')                                // Spaces, dots, underscores → hyphens.
    .replaceAll(/-+/g, '-')                                        // Collapse runs.
    .replaceAll(/^-|-$/g, '')                                      // No leading/trailing hyphen.
    .slice(0, NAME_MAX)
    .replace(/-$/, '');                                            // Truncation may leave a trailing hyphen.
}

/** Split a SKILL.md into its frontmatter fields and body.
 *  @returns top-level scalar fields (folded `>`/`|` blocks joined into one line) and the body
 *  Exists because skills are untrusted text: no YAML library, only the fields we need. */
export function splitSkillMarkdown(markdown: string): { fields: Record<string, string>; body: string } {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(markdown); // Leading frontmatter block.
  if (!match) return { fields: {}, body: markdown };              // No frontmatter: all body.
  const fields: Record<string, string> = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);       // Top-level key only (no indent).
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^[>|][-+]?$/.test(value) || value === '') {
      // Block scalar or nested value: gather the indented lines that follow.
      const parts: string[] = [];
      // Indented continuation lines, or YAML list items ("- x") that may start at column 0.
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || /^-\s/.test(lines[i + 1]))) parts.push(lines[++i].trim());
      value = parts.join(' ');
    }
    fields[kv[1]] = value.replace(/^(["'])([\s\S]*)\1$/, '$2');    // Drop one layer of surrounding quotes.
  }
  return { fields, body: markdown.slice(match[0].length) };
}

/** Quote a value as a YAML double-quoted string on one line. */
function yamlString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`; // Escapes keep colons and quotes safe.
}

/** Rebuild a SKILL.md with Claude Code–compatible frontmatter.
 *  @param markdown the skill text (original or model-converted)
 *  @param fallbackName used when the skill has no usable `name` (e.g. the catalog title)
 *  @param fallbackDescription used when the skill has no `description` (e.g. the catalog description)
 *  @returns the skill with only name, description, and the optional keys in KEPT_KEYS
 *  Exists so every converted skill loads in Claude Code, whatever the source frontmatter held. */
export function toClaudeSkillMarkdown(markdown: string, fallbackName: string, fallbackDescription: string): string {
  const { fields, body } = splitSkillMarkdown(markdown);
  const name = toSkillName(fields.name || '') || toSkillName(fallbackName) || 'converted-skill';
  // One line, trimmed to the limit; Claude picks skills by this text, so never leave it empty.
  const description = (fields.description || fallbackDescription || `Skill converted from awesome-copilot: ${name}.`)
    .replaceAll(/\s+/g, ' ').trim().slice(0, DESCRIPTION_MAX);
  const lines = ['---', `name: ${name}`, `description: ${yamlString(description)}`];
  for (const key of KEPT_KEYS) {
    if (fields[key]) lines.push(`${key}: ${yamlString(fields[key])}`); // Carried over as-is; everything else is dropped.
  }
  lines.push('---', '');
  return lines.join('\n') + body.replace(/^\s*\n/, '');            // Body starts on the line after the closing ---.
}

/** Parse a frontmatter list written as `[a, 'b']`, `- a - b` (joined block list) or `a, b`.
 *  @returns trimmed, unquoted, non-empty items */
export function parseFrontmatterList(value: string): string[] {
  const inner = value.trim().replace(/^\[([\s\S]*)\]$/, '$1');     // Flow list: drop the brackets.
  // Block list vs comma list; commas inside {a,b} glob braces don't separate items.
  const parts = inner.startsWith('- ') ? inner.split(/(?:^|\s)-\s+/) : inner.split(/,(?![^{]*\})/);
  return parts.map(part => part.trim().replace(/^(["'])([\s\S]*)\1$/, '$2')).filter(Boolean);
}

/** Copilot (VS Code) tool and tool-set names → Claude Code tool names.
 *  Unknown names (MCP servers, IDE-only tools like problems/usages) are dropped. */
// cspell:disable -- keys are lowercased Copilot tool identifiers, not words.
const COPILOT_TO_CLAUDE_TOOLS: Record<string, string[]> = {
  codebase: ['Read', 'Grep', 'Glob'], search: ['Grep', 'Glob'], read: ['Read'], readfile: ['Read'],
  findfiles: ['Glob'], textsearch: ['Grep'], filesearch: ['Glob'],
  edit: ['Edit', 'Write'], editfiles: ['Edit', 'Write'], createfile: ['Write'], new: ['Write'],
  runcommands: ['Bash'], runinterminal: ['Bash'], terminal: ['Bash'], execute: ['Bash'], runtasks: ['Bash'],
  runtests: ['Bash'], terminallastcommand: ['Bash'], terminalselection: ['Bash'], findtestfiles: ['Glob'],
  fetch: ['WebFetch'], fetchwebpage: ['WebFetch'], web: ['WebFetch', 'WebSearch'], websearch: ['WebSearch'],
  agent: ['Agent'], runsubagent: ['Agent'],
};
// cspell:enable

/** Map a Copilot `tools` list to Claude Code tool names.
 *  @returns deduplicated Claude tools; empty when nothing maps (caller then omits `tools` so the
 *  subagent inherits all tools — a list with no valid tool would stop the subagent launching) */
export function mapCopilotTools(tools: string[]): string[] {
  const mapped = new Set<string>();
  for (const tool of tools) {
    // Copilot names can be namespaced ("vscode/runCommands"); compare the last segment, case-insensitively.
    const key = (tool.split('/').pop() ?? '').toLowerCase();
    for (const claudeTool of COPILOT_TO_CLAUDE_TOOLS[key] ?? []) mapped.add(claudeTool);
  }
  return [...mapped];
}

/** Copilot tools with no Claude Code equivalent (IDE-only tools, Copilot MCP names).
 *  Exists so the conversion preview can say what the subagent will not have. */
export function unmappedCopilotTools(tools: string[]): string[] {
  return tools.filter(tool => !COPILOT_TO_CLAUDE_TOOLS[(tool.split('/').pop() ?? '').toLowerCase()]);
}

/** Map a Copilot `model` value to a Claude Code subagent model alias.
 *  @returns opus / sonnet / haiku / fable for Claude models, else undefined (non-Claude models: let Claude Code choose) */
export function mapCopilotModel(model: string): string | undefined {
  return /\b(opus|sonnet|haiku|fable)\b/i.exec(model)?.[1].toLowerCase(); // e.g. "Claude Sonnet 4.5 (copilot)" → sonnet.
}

/** Rebuild a Copilot custom agent (.agent.md) as a Claude Code subagent.
 *  @param markdown the agent text (original or model-converted)
 *  @param fallbackName / fallbackDescription used when the agent lacks them (both are required by Claude Code)
 *  @returns subagent markdown: name, description, and tools / model only when they map to Claude values */
export function toClaudeAgentMarkdown(markdown: string, fallbackName: string, fallbackDescription: string): string {
  const { fields, body } = splitSkillMarkdown(markdown);
  const name = toSkillName(fields.name || '') || toSkillName(fallbackName) || 'converted-agent';
  const description = (fields.description || fallbackDescription || `Subagent converted from awesome-copilot: ${name}.`)
    .replaceAll(/\s+/g, ' ').trim().slice(0, DESCRIPTION_MAX);
  const lines = ['---', `name: ${name}`, `description: ${yamlString(description)}`];
  const tools = mapCopilotTools(parseFrontmatterList(fields.tools ?? ''));
  if (tools.length > 0) lines.push(`tools: ${tools.join(', ')}`);  // Omitted = inherit every tool.
  const model = mapCopilotModel(fields.model ?? '');
  if (model) lines.push(`model: ${model}`);                         // Omitted = Claude Code picks.
  lines.push('---', '');
  return lines.join('\n') + body.replace(/^\s*\n/, '');            // Body is the subagent's system prompt.
}

/** Rebuild a Copilot instructions file (.instructions.md) as a Claude Code rule.
 *  @returns rule markdown with `paths:` from `applyTo`, or no frontmatter when it applies to every file
 *  Exists because Claude Code scopes rules with `paths`, the direct equivalent of Copilot's `applyTo`. */
export function toClaudeRuleMarkdown(markdown: string): string {
  const { fields, body } = splitSkillMarkdown(markdown);
  // "**" / "**/*" mean every file: an unconditional rule needs no frontmatter at all.
  const globs = parseFrontmatterList(fields.applyTo ?? '').filter(glob => glob !== '**' && glob !== '**/*');
  const text = body.replace(/^\s*\n/, '');
  if (globs.length === 0) return text;
  return ['---', 'paths:', ...globs.map(glob => `  - ${yamlString(glob)}`), '---', ''].join('\n') + text;
}

/** Combine the original file's frontmatter with a rewritten body.
 *  Exists so converters always read tools / model / applyTo from the source file: the language
 *  model only rewrites instructions and can't drop the fields the conversion depends on. */
export function withOriginalFrontmatter(original: string, rewritten: string): string {
  const head = /^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/.exec(original)?.[0] ?? ''; // Original frontmatter block.
  return head + splitSkillMarkdown(rewritten).body;                // Rewritten body, its frontmatter discarded.
}
