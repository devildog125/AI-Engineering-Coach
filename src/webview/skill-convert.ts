/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Copilot → Claude Code skill conversion (frontmatter half)
 *
 * Why this module exists: awesome-copilot skills carry Copilot-only frontmatter
 * (`applyTo`, Copilot `tools` lists, chat `mode`) and sometimes no valid `name`.
 * Claude Code loads a skill from `name` + `description` and ignores or rejects the rest.
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
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
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
