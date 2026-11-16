import { didYouMean } from '../suggest.js';
import { STEP_KEYS } from './keys.js';
import type { Finding, ParsedWorkflow } from '../parse.js';

export const COMPOSITE_TOP_KEYS = new Set([
  'name', 'author', 'description', 'inputs', 'outputs', 'runs', 'branding',
]);

export const COMPOSITE_INPUT_KEYS = new Set([
  'description', 'required', 'default', 'deprecationMessage',
]);

export const COMPOSITE_OUTPUT_KEYS = new Set(['description', 'value']);

export const COMPOSITE_RUN_KEYS = new Set([
  'using', 'steps', 'pre', 'post', 'pre-if', 'post-if',
]);

/** Top-level keys valid in a non-composite (`node20` / `docker`) action file. */
export const ACTION_TOP_KEYS = new Set([
  ...COMPOSITE_TOP_KEYS, 'icon', 'color',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function lineOf(parsed: ParsedWorkflow, path: string, fallback = 1): number {
  return parsed.keyLines.get(path) ?? fallback;
}

function unknownKey(
  parsed: ParsedWorkflow,
  path: string,
  key: string,
  known: Set<string>,
  where: string,
): Finding | null {
  if (known.has(key)) return null;
  const suggestion = didYouMean(key, known);
  return {
    file: parsed.file,
    line: lineOf(parsed, path ? `${path}.${key}` : key),
    rule: 'unknown-key',
    severity: 'error',
    message: `Unknown key '${key}' in ${where}.`,
    suggestion: suggestion ? `Did you mean '${suggestion}'?` : undefined,
  };
}

/** True when this file is a GitHub Action definition (`action.yml`), not a
 * workflow: it has a top-level `runs:` mapping and no `on:` / `jobs:`. */
export function isActionFile(data: unknown): boolean {
  if (!isRecord(data)) return false;
  return isRecord(data.runs) && data.on === undefined && data.jobs === undefined;
}

export function isCompositeAction(data: unknown): boolean {
  if (!isRecord(data) || !isRecord(data.runs)) return false;
  return data.runs.using === 'composite';
}

function checkInputsOutputs(parsed: ParsedWorkflow, data: Record<string, unknown>): Finding[] {
  const findings: Finding[] = [];

  const inputs = data.inputs;
  if (inputs !== undefined) {
    if (!isRecord(inputs)) {
      findings.push({
        file: parsed.file, line: lineOf(parsed, 'inputs'), rule: 'invalid-inputs',
        severity: 'error', message: "'inputs' must be a mapping of input names to their definitions.",
      });
    } else {
      for (const [name, spec] of Object.entries(inputs)) {
        const path = `inputs.${name}`;
        if (!isRecord(spec)) {
          findings.push({
            file: parsed.file, line: lineOf(parsed, path), rule: 'composite-input-no-description',
            severity: 'error', message: `Input '${name}' has no definition — every input needs at least a 'description'.`,
          });
          continue;
        }
        for (const key of Object.keys(spec)) {
          const finding = unknownKey(parsed, path, key, COMPOSITE_INPUT_KEYS, `input '${name}'`);
          if (finding) findings.push(finding);
        }
        if (typeof spec.description !== 'string' || spec.description.trim() === '') {
          findings.push({
            file: parsed.file, line: lineOf(parsed, path), rule: 'composite-input-no-description',
            severity: 'error', message: `Input '${name}' has no 'description' — describe what the caller should pass in.`,
          });
        }
      }
    }
  }

  const outputs = data.outputs;
  if (outputs !== undefined) {
    if (!isRecord(outputs)) {
      findings.push({
        file: parsed.file, line: lineOf(parsed, 'outputs'), rule: 'invalid-outputs',
        severity: 'error', message: "'outputs' must be a mapping of output names to their definitions.",
      });
    } else {
      for (const [name, spec] of Object.entries(outputs)) {
        const path = `outputs.${name}`;
        if (!isRecord(spec)) {
          findings.push({
            file: parsed.file, line: lineOf(parsed, path), rule: 'composite-output-no-value',
            severity: 'error', message: `Output '${name}' has no definition — every output needs a 'description' and a 'value'.`,
          });
          continue;
        }
        for (const key of Object.keys(spec)) {
          const finding = unknownKey(parsed, path, key, COMPOSITE_OUTPUT_KEYS, `output '${name}'`);
          if (finding) findings.push(finding);
        }
        if (typeof spec.description !== 'string' || spec.description.trim() === '') {
          findings.push({
            file: parsed.file, line: lineOf(parsed, path), rule: 'composite-output-no-description',
            severity: 'error', message: `Output '${name}' has no 'description' — describe what this output contains.`,
          });
        }
        if (spec.value === undefined) {
          findings.push({
            file: parsed.file, line: lineOf(parsed, path), rule: 'composite-output-no-value',
            severity: 'error', message: `Output '${name}' has no 'value' — point it at a step output, e.g. '\${{ steps.build.outputs.result }}'.`,
          });
        }
      }
    }
  }
  return findings;
}

/**
 * Check an action definition file (`action.yml`). For `using: composite`
 * the `runs.steps` list is checked with the same step rules as workflows
 * (unknown step keys, a step with neither `uses` nor `run`); for
 * `node20` / `docker` actions only the shared inputs/outputs checks apply,
 * since those have no steps to check.
 */
export function checkActionFile(parsed: ParsedWorkflow): Finding[] {
  const findings: Finding[] = [];
  const data = parsed.data as Record<string, unknown>;
  if (!isRecord(data)) return findings;

  const composite = isCompositeAction(data);
  const knownTop = composite ? COMPOSITE_TOP_KEYS : ACTION_TOP_KEYS;
  for (const key of Object.keys(data)) {
    const finding = unknownKey(parsed, '', key, knownTop, 'the action');
    if (finding) findings.push(finding);
  }

  if (typeof data.name !== 'string' || data.name.trim() === '') {
    findings.push({
      file: parsed.file, line: 1, rule: 'missing-name', severity: 'error',
      message: "This action has no 'name' — give it a short name, e.g. 'name: My action'.",
    });
  }
  if (typeof data.description !== 'string' || data.description.trim() === '') {
    findings.push({
      file: parsed.file, line: 1, rule: 'missing-description', severity: 'error',
      message: "This action has no 'description' — describe what it does; the description shows wherever the action is listed.",
    });
  }

  findings.push(...checkInputsOutputs(parsed, data));

  const runs = data.runs;
  if (!isRecord(runs)) {
    findings.push({
      file: parsed.file, line: 1, rule: 'missing-runs', severity: 'error',
      message: "This action has no 'runs' — an action needs 'runs:' with 'using:' and its steps or entry point.",
    });
    return findings;
  }
  for (const key of Object.keys(runs)) {
    const finding = unknownKey(parsed, 'runs', key, COMPOSITE_RUN_KEYS, "'runs'");
    if (finding) findings.push(finding);
  }
  if (typeof runs.using !== 'string' || runs.using.trim() === '') {
    findings.push({
      file: parsed.file, line: lineOf(parsed, 'runs'), rule: 'invalid-runs-using', severity: 'error',
      message: "'runs.using' is missing — for a composite action it must be 'composite'.",
    });
    return findings;
  }
  if (!composite) return findings; // node20 / docker: no steps to check.

  const steps = runs.steps;
  if (steps === undefined) {
    findings.push({
      file: parsed.file, line: lineOf(parsed, 'runs'), rule: 'missing-steps', severity: 'error',
      message: "This composite action has no 'runs.steps', so it would run and do nothing.",
    });
    return findings;
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    findings.push({
      file: parsed.file, line: lineOf(parsed, 'runs.steps'), rule: 'missing-steps', severity: 'error',
      message: "This composite action has an empty 'runs.steps' list.",
    });
    return findings;
  }
  steps.forEach((step, index) => {
    const stepPath = `runs.steps[${index}]`;
    if (!isRecord(step)) {
      findings.push({
        file: parsed.file, line: lineOf(parsed, stepPath), rule: 'invalid-step', severity: 'error',
        message: `Step ${index + 1} in this composite action must be a mapping like '- uses: …' or '- run: …'.`,
      });
      return;
    }
    for (const key of Object.keys(step)) {
      const finding = unknownKey(parsed, stepPath, key, STEP_KEYS, 'a step in this composite action');
      if (finding) findings.push(finding);
    }
    const hasUses = typeof step.uses === 'string';
    const hasRun = typeof step.run === 'string';
    if (!hasUses && !hasRun) {
      findings.push({
        file: parsed.file, line: lineOf(parsed, stepPath), rule: 'missing-step-action', severity: 'error',
        message: `Step ${index + 1} in this composite action has neither 'uses' nor 'run', so it does nothing.`,
      });
    }
    if (hasUses && hasRun) {
      findings.push({
        file: parsed.file, line: lineOf(parsed, stepPath), rule: 'step-uses-and-run', severity: 'warning',
        message: `Step ${index + 1} in this composite action has both 'uses' and 'run' — GitHub runs the action and ignores 'run'.`,
      });
    }
  });
  return findings;
}
