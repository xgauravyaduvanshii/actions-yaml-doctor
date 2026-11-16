import { didYouMean } from '../suggest.js';
import type { Finding, ParsedWorkflow } from '../parse.js';

export const TOP_LEVEL_KEYS = new Set([
  'name', 'run-name', 'on', 'env', 'defaults', 'concurrency', 'permissions', 'jobs',
]);

export const ON_TRIGGER_KEYS = new Set([
  'push', 'pull_request', 'pull_request_target', 'workflow_dispatch',
  'workflow_call', 'schedule', 'release', 'issues', 'issue_comment',
  'create', 'delete', 'fork', 'gollum', 'page_build', 'public',
  'status', 'watch', 'workflow_run', 'merge_group',
]);

export const ON_EVENT_KEYS = new Set([
  'branches', 'branches-ignore', 'paths', 'paths-ignore', 'tags',
  'tags-ignore', 'types', 'inputs', 'secrets', 'outputs', 'cron',
  'workflows', 'activity-types',
]);

export const JOB_KEYS = new Set([
  'name', 'needs', 'if', 'runs-on', 'environment', 'concurrency',
  'outputs', 'env', 'defaults', 'permissions', 'strategy', 'container',
  'services', 'timeout-minutes', 'steps', 'uses', 'with', 'secrets',
  'continue-on-error',
]);

export const STEP_KEYS = new Set([
  'name', 'id', 'if', 'uses', 'run', 'with', 'env', 'working-directory',
  'shell', 'continue-on-error', 'timeout-minutes',
]);

export const RUNNER_LABELS = new Set([
  'ubuntu-latest', 'ubuntu-24.04', 'ubuntu-22.04', 'ubuntu-20.04',
  'windows-latest', 'windows-2025', 'windows-2022', 'windows-2019',
  'macos-latest', 'macos-15', 'macos-14', 'macos-13',
  'self-hosted',
]);

/**
 * Safe, unambiguous key fixes only. A fix is listed here only when the
 * wrong key has exactly one plausible meaning and renaming it cannot
 * change what the workflow does.
 */
export const SAFE_KEY_FIXES: Record<string, string> = {
  branch: 'branches',
  'run-on': 'runs-on',
  step: 'steps',
  use: 'uses',
  job: 'jobs',
};

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
  const safeFix = SAFE_KEY_FIXES[key];
  return {
    file: parsed.file,
    line: lineOf(parsed, path ? `${path}.${key}` : key),
    rule: 'unknown-key',
    severity: 'error',
    message: `Unknown key '${key}' in ${where}.`,
    suggestion: suggestion ? `Did you mean '${suggestion}'?` : undefined,
    fix: safeFix ? { from: key, to: safeFix } : undefined,
  };
}

function checkRunner(parsed: ParsedWorkflow, jobPath: string, runsOn: unknown): Finding[] {
  const findings: Finding[] = [];
  const line = lineOf(parsed, `${jobPath}.runs-on`);
  const labels = Array.isArray(runsOn) ? runsOn : [runsOn];
  for (const label of labels) {
    if (typeof label !== 'string') {
      findings.push({
        file: parsed.file, line, rule: 'invalid-runner', severity: 'error',
        message: `'runs-on' must be a runner label (a string), not ${typeof label}.`,
      });
      continue;
    }
    if (label.includes('${{')) continue; // Expression runner — cannot check statically.
    if (RUNNER_LABELS.has(label) || label.startsWith('self-hosted')) continue;
    const suggestion = didYouMean(label, RUNNER_LABELS);
    findings.push({
      file: parsed.file, line, rule: 'invalid-runner', severity: 'error',
      message: `'${label}' is not a known GitHub-hosted runner label.`,
      suggestion: suggestion
        ? `Did you mean '${suggestion}'? Common labels: ubuntu-latest, windows-latest, macos-latest.`
        : 'Common labels: ubuntu-latest, windows-latest, macos-latest.',
    });
  }
  return findings;
}

export function checkKeys(parsed: ParsedWorkflow): Finding[] {
  const findings: Finding[] = [];
  const data = parsed.data as Record<string, unknown>;
  if (!isRecord(data)) return findings;

  for (const key of Object.keys(data)) {
    const finding = unknownKey(parsed, '', key, TOP_LEVEL_KEYS, 'the workflow');
    if (finding) findings.push(finding);
  }

  // --- `on:` triggers -------------------------------------------------
  const on = data.on;
  if (on === undefined) {
    findings.push({
      file: parsed.file, line: 1, rule: 'missing-trigger', severity: 'error',
      message: "This workflow has no 'on' trigger, so it will never run.",
      suggestion: "Add e.g. 'on:\n  push:\n    branches: [main]'.",
    });
  } else if (typeof on === 'string') {
    if (!ON_TRIGGER_KEYS.has(on)) {
      const suggestion = didYouMean(on, ON_TRIGGER_KEYS);
      findings.push({
        file: parsed.file, line: lineOf(parsed, 'on'), rule: 'unknown-key', severity: 'error',
        message: `Unknown trigger '${on}'.`,
        suggestion: suggestion ? `Did you mean '${suggestion}'?` : undefined,
      });
    }
  } else if (isRecord(on)) {
    for (const trigger of Object.keys(on)) {
      const finding = unknownKey(parsed, 'on', trigger, ON_TRIGGER_KEYS, "'on'");
      if (finding) findings.push(finding);
      const event = on[trigger];
      if (isRecord(event)) {
        for (const key of Object.keys(event)) {
          const sub = unknownKey(parsed, `on.${trigger}`, key, ON_EVENT_KEYS, `'on.${trigger}'`);
          if (sub) findings.push(sub);
        }
      }
    }
  } else if (Array.isArray(on)) {
    for (const trigger of on) {
      if (typeof trigger === 'string' && !ON_TRIGGER_KEYS.has(trigger)) {
        const suggestion = didYouMean(trigger, ON_TRIGGER_KEYS);
        findings.push({
          file: parsed.file, line: lineOf(parsed, 'on'), rule: 'unknown-key', severity: 'error',
          message: `Unknown trigger '${trigger}'.`,
          suggestion: suggestion ? `Did you mean '${suggestion}'?` : undefined,
        });
      }
    }
  }

  // --- jobs -----------------------------------------------------------
  const jobs = data.jobs;
  if (jobs === undefined) {
    findings.push({
      file: parsed.file, line: 1, rule: 'missing-jobs', severity: 'error',
      message: "This workflow has no 'jobs', so there is nothing to run.",
    });
    return findings;
  }
  if (!isRecord(jobs) || Object.keys(jobs).length === 0) {
    findings.push({
      file: parsed.file, line: lineOf(parsed, 'jobs'), rule: 'missing-jobs', severity: 'error',
      message: "'jobs' is empty — a workflow needs at least one job.",
    });
    return findings;
  }

  for (const [jobId, job] of Object.entries(jobs)) {
    const jobPath = `jobs.${jobId}`;
    if (!isRecord(job)) {
      findings.push({
        file: parsed.file, line: lineOf(parsed, jobPath), rule: 'invalid-job', severity: 'error',
        message: `Job '${jobId}' must be a mapping of keys like 'runs-on' and 'steps'.`,
      });
      continue;
    }
    for (const key of Object.keys(job)) {
      const finding = unknownKey(parsed, jobPath, key, JOB_KEYS, `job '${jobId}'`);
      if (finding) findings.push(finding);
    }
    const isReusableCall = typeof job.uses === 'string';
    if (!isReusableCall) {
      if (job['runs-on'] === undefined) {
        findings.push({
          file: parsed.file, line: lineOf(parsed, jobPath), rule: 'missing-runs-on', severity: 'error',
          message: `Job '${jobId}' has no 'runs-on', so GitHub does not know which machine to run it on.`,
          suggestion: "Add e.g. 'runs-on: ubuntu-latest'.",
        });
      } else {
        findings.push(...checkRunner(parsed, jobPath, job['runs-on']));
      }
      if (job.steps === undefined) {
        findings.push({
          file: parsed.file, line: lineOf(parsed, jobPath), rule: 'missing-steps', severity: 'error',
          message: `Job '${jobId}' has no 'steps', so it would run and do nothing.`,
          suggestion: "Add at least one step, e.g. '- uses: actions/checkout@v4'.",
        });
      } else if (!Array.isArray(job.steps) || job.steps.length === 0) {
        findings.push({
          file: parsed.file, line: lineOf(parsed, `${jobPath}.steps`), rule: 'missing-steps', severity: 'error',
          message: `Job '${jobId}' has an empty 'steps' list.`,
        });
      } else {
        job.steps.forEach((step, index) => {
          const stepPath = `${jobPath}.steps[${index}]`;
          if (!isRecord(step)) {
            findings.push({
              file: parsed.file, line: lineOf(parsed, stepPath), rule: 'invalid-step', severity: 'error',
              message: `Step ${index + 1} in job '${jobId}' must be a mapping like '- uses: …' or '- run: …'.`,
            });
            return;
          }
          for (const key of Object.keys(step)) {
            const finding = unknownKey(parsed, stepPath, key, STEP_KEYS, `a step in job '${jobId}'`);
            if (finding) findings.push(finding);
          }
          const hasUses = typeof step.uses === 'string';
          const hasRun = typeof step.run === 'string';
          if (!hasUses && !hasRun) {
            findings.push({
              file: parsed.file, line: lineOf(parsed, stepPath), rule: 'missing-step-action', severity: 'error',
              message: `Step ${index + 1} in job '${jobId}' has neither 'uses' nor 'run', so it does nothing.`,
            });
          }
          if (hasUses && hasRun) {
            findings.push({
              file: parsed.file, line: lineOf(parsed, stepPath), rule: 'step-uses-and-run', severity: 'warning',
              message: `Step ${index + 1} in job '${jobId}' has both 'uses' and 'run' — GitHub runs the action and ignores 'run'.`,
            });
          }
        });
      }
    }
  }
  return findings;
}
