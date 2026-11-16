import { LineCounter, parseDocument, isMap, isSeq, isScalar } from 'yaml';
import type { Document, Node } from 'yaml';
import { checkKeys } from './rules/keys.js';
import { checkExpressions } from './rules/expressions.js';
import { checkSecrets } from './rules/secrets.js';
import { checkReusable } from './rules/reusable.js';

export type Severity = 'error' | 'warning';

export interface Finding {
  file: string;
  line: number;
  column?: number;
  rule: string;
  severity: Severity;
  message: string;
  /** Plain-English suggestion, e.g. "Did you mean 'branches'?". */
  suggestion?: string;
  /**
   * A safe, unambiguous automatic fix, if one exists.
   * `{ from, to }` means: on this finding's line, replace the key `from`
   * with `to`. Only set for fixes that cannot change meaning.
   */
  fix?: { from: string; to: string };
}

export interface ScalarEntry {
  path: string;
  value: string;
  line: number;
  column: number;
}

export interface ParsedWorkflow {
  file: string;
  text: string;
  /** Parsed JS value, or null when the YAML could not be parsed at all. */
  data: unknown;
  /** Syntax errors, already turned into findings (empty when valid). */
  parseErrors: Finding[];
  /** Line of each mapping key, keyed by dotted path, e.g. `jobs.build.runs-on`. */
  keyLines: Map<string, number>;
  /** Every string scalar in the file, with its line/column. */
  scalars: ScalarEntry[];
  doc: Document | null;
}

/** YAML 1.1 booleans (`on` / `y` / `yes`) can arrive as real booleans. */
function normalizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      // `on:` is parsed as boolean `true` by some YAML schemas.
      const fixedKey = key === 'true' ? 'on' : key === 'false' ? 'off' : key;
      out[fixedKey] = normalizeKeys(entry);
    }
    return out;
  }
  return value;
}

function collectPositions(doc: Document, lineCounter: LineCounter, parsed: ParsedWorkflow): void {
  const visit = (node: Node | null, path: string): void => {
    if (!node) return;
    if (isMap(node)) {
      for (const item of node.items) {
        const keyNode = item.key as Node | null;
        const keyText = isScalar(keyNode) ? String(keyNode.value) : '';
        const childPath = path ? `${path}.${keyText}` : keyText;
        if (keyNode && keyNode.range) {
          const pos = lineCounter.linePos(keyNode.range[0]);
          parsed.keyLines.set(childPath, pos.line);
        }
        visit(item.value as Node | null, childPath);
      }
      return;
    }
    if (isSeq(node)) {
      node.items.forEach((child, index) => {
        const childNode = child as Node | null;
        if (childNode && childNode.range) {
          const pos = lineCounter.linePos(childNode.range[0]);
          parsed.keyLines.set(`${path}[${index}]`, pos.line);
        }
        visit(childNode, `${path}[${index}]`);
      });
      return;
    }
    if (isScalar(node) && typeof node.value === 'string' && node.range) {
      const pos = lineCounter.linePos(node.range[0]);
      parsed.scalars.push({ path, value: node.value, line: pos.line, column: pos.col });
    }
  };
  visit(doc.contents as Node | null, '');
}

export function parseWorkflow(text: string, file: string): ParsedWorkflow {
  const lineCounter = new LineCounter();
  const parsed: ParsedWorkflow = {
    file,
    text,
    data: null,
    parseErrors: [],
    keyLines: new Map(),
    scalars: [],
    doc: null,
  };
  let doc: Document;
  try {
    doc = parseDocument(text, { lineCounter });
  } catch (error) {
    parsed.parseErrors.push({
      file,
      line: 1,
      rule: 'yaml-syntax',
      severity: 'error',
      message: `This file is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    });
    return parsed;
  }
  parsed.doc = doc;
  for (const error of doc.errors) {
    const pos = error.linePos && error.linePos[0]
      ? { line: error.linePos[0].line, col: error.linePos[0].col }
      : { line: 1, col: 1 };
    parsed.parseErrors.push({
      file,
      line: pos.line,
      column: pos.col,
      rule: 'yaml-syntax',
      severity: 'error',
      message: `YAML syntax error: ${error.message}`,
    });
  }
  if (parsed.parseErrors.length === 0) {
    try {
      parsed.data = normalizeKeys(doc.toJS());
    } catch {
      parsed.data = null;
    }
    collectPositions(doc, lineCounter, parsed);
  }
  return parsed;
}

export interface CheckOptions {
  /** Secret names known to exist (from --secrets, env, or the workflow itself). */
  knownSecrets?: string[];
}

/**
 * Run every rule over one workflow file. Returns findings sorted by line.
 * Syntax errors short-circuit: nothing else can be trusted after them.
 */
export function checkWorkflow(text: string, file: string, options: CheckOptions = {}): Finding[] {
  const parsed = parseWorkflow(text, file);
  if (parsed.parseErrors.length > 0) return parsed.parseErrors;
  if (parsed.data === null || typeof parsed.data !== 'object') {
    return [{
      file,
      line: 1,
      rule: 'empty-workflow',
      severity: 'error',
      message: 'This workflow file is empty or does not contain a YAML mapping.',
    }];
  }
  const findings = [
    ...checkKeys(parsed),
    ...checkExpressions(parsed),
    ...checkSecrets(parsed, options.knownSecrets ?? []),
    ...checkReusable(parsed),
  ];
  return findings.sort((a, b) => a.line - b.line || (a.column ?? 0) - (b.column ?? 0));
}
