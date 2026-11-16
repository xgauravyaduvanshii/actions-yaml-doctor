import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseWorkflow } from '../parse.js';
import type { Finding, ParsedWorkflow } from '../parse.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export interface ReusableInput {
  type?: string;
  required?: boolean;
  default?: unknown;
  options?: string[];
}

function workflowCallInputs(data: unknown): Record<string, ReusableInput> {
  if (!isRecord(data)) return {};
  const on = data.on;
  if (!isRecord(on)) return {};
  const call = on.workflow_call;
  if (!isRecord(call) || !isRecord(call.inputs)) return {};
  const out: Record<string, ReusableInput> = {};
  for (const [name, spec] of Object.entries(call.inputs)) {
    out[name] = isRecord(spec)
      ? { type: typeof spec.type === 'string' ? spec.type : undefined, required: spec.required === true, default: spec.default, options: Array.isArray(spec.options) ? spec.options.map(String) : undefined }
      : {};
  }
  return out;
}

/** Resolve a `uses:` value to a local file, if it is a local reusable workflow. */
export function resolveReusableFile(callerFile: string, uses: string): string | null {
  if (!uses.startsWith('./') && !uses.startsWith('../')) return null;
  const withoutRef = uses.split('@')[0];
  const candidates = [
    resolve(dirname(callerFile), withoutRef),
    resolve(dirname(callerFile), withoutRef.replace(/^\.\//, '')),
    resolve(process.cwd(), '.github', 'workflows', withoutRef.replace(/^\.\//, '')),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function checkType(parsed: ParsedWorkflow, jobId: string, input: string, expected: string | undefined, value: unknown): Finding | null {
  if (expected === undefined) return null;
  const line = parsed.keyLines.get(`jobs.${jobId}.with.${input}`) ?? 1;
  const text = String(value);
  if (expected === 'boolean' && !['true', 'false'].includes(text.toLowerCase())) {
    return {
      file: parsed.file, line, rule: 'reusable-wrong-type', severity: 'error',
      message: `Input '${input}' for the reusable workflow must be a boolean ('true'/'false'), but got '${text}'.`,
    };
  }
  if (expected === 'number' && Number.isNaN(Number(text))) {
    return {
      file: parsed.file, line, rule: 'reusable-wrong-type', severity: 'error',
      message: `Input '${input}' for the reusable workflow must be a number, but got '${text}'.`,
    };
  }
  return null;
}

export function checkReusable(parsed: ParsedWorkflow): Finding[] {
  const findings: Finding[] = [];
  const data = parsed.data as Record<string, unknown>;
  if (!isRecord(data)) return findings;

  // A reusable workflow itself: its workflow_call inputs must be well-formed.
  const ownInputs = workflowCallInputs(data);
  for (const [name, spec] of Object.entries(ownInputs)) {
    const line = parsed.keyLines.get(`on.workflow_call.inputs.${name}`) ?? 1;
    if (spec.type === undefined) {
      findings.push({
        file: parsed.file, line, rule: 'reusable-input-no-type', severity: 'error',
        message: `workflow_call input '${name}' has no 'type' — every reusable input needs one (boolean, number, string or choice).`,
      });
    } else if (!['boolean', 'number', 'string', 'choice'].includes(spec.type)) {
      findings.push({
        file: parsed.file, line, rule: 'reusable-input-no-type', severity: 'error',
        message: `workflow_call input '${name}' has type '${spec.type}', which is not a valid input type.`,
        suggestion: 'Valid types: boolean, number, string, choice.',
      });
    }
    if (spec.type === 'choice' && (!spec.options || spec.options.length === 0)) {
      findings.push({
        file: parsed.file, line, rule: 'reusable-input-no-type', severity: 'error',
        message: `workflow_call input '${name}' is a 'choice' input but has no 'options' list.`,
      });
    }
  }

  // Callers: jobs that `uses:` a reusable workflow.
  const jobs = data.jobs;
  if (!isRecord(jobs)) return findings;
  for (const [jobId, job] of Object.entries(jobs)) {
    if (!isRecord(job) || typeof job.uses !== 'string') continue;
    const uses = job.uses as string;
    if (!uses.includes('.github/workflows/') && !uses.endsWith('.yml') && !uses.endsWith('.yaml')) continue;
    if (uses.startsWith('actions/') || uses.startsWith('docker://')) continue;

    const localFile = resolveReusableFile(parsed.file, uses);
    if (localFile === null) {
      if (uses.startsWith('./') || uses.startsWith('../')) {
        findings.push({
          file: parsed.file,
          line: parsed.keyLines.get(`jobs.${jobId}.uses`) ?? 1,
          rule: 'reusable-not-found', severity: 'warning',
          message: `Reusable workflow '${uses}' was not found locally, so its inputs could not be checked.`,
        });
      }
      // Remote `owner/repo/.github/workflows/…@ref` — cannot check offline.
      continue;
    }
    let callee: ParsedWorkflow;
    try {
      callee = parseWorkflow(readFileSync(localFile, 'utf8'), localFile);
    } catch {
      continue;
    }
    if (callee.parseErrors.length > 0) continue;
    const expected = workflowCallInputs(callee.data);
    const withInputs = isRecord(job.with) ? job.with : {};
    for (const [name, spec] of Object.entries(expected)) {
      if (!(name in withInputs) && spec.required === true && spec.default === undefined) {
        findings.push({
          file: parsed.file,
          line: parsed.keyLines.get(`jobs.${jobId}.uses`) ?? 1,
          rule: 'reusable-missing-input', severity: 'error',
          message: `Job '${jobId}' calls a reusable workflow that requires input '${name}', but it is not passed in 'with'.`,
        });
      }
    }
    for (const [name, value] of Object.entries(withInputs)) {
      const line = parsed.keyLines.get(`jobs.${jobId}.with.${name}`) ?? 1;
      const spec = expected[name];
      if (!spec) {
        findings.push({
          file: parsed.file, line, rule: 'reusable-unknown-input', severity: 'error',
          message: `Job '${jobId}' passes input '${name}' to a reusable workflow that does not declare it.`,
          suggestion: `Declared inputs: ${Object.keys(expected).join(', ') || '(none)'}.`,
        });
        continue;
      }
      const typeFinding = checkType(parsed, jobId, name, spec.type, value);
      if (typeFinding) findings.push(typeFinding);
      if (spec.type === 'choice' && spec.options && !spec.options.includes(String(value))) {
        findings.push({
          file: parsed.file, line, rule: 'reusable-wrong-type', severity: 'error',
          message: `Input '${name}' must be one of ${spec.options.map((o) => `'${o}'`).join(', ')}, but got '${String(value)}'.`,
        });
      }
    }
  }
  return findings;
}
