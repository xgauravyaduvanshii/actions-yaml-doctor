import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checkWorkflow } from '../src/parse.js';
import { didYouMean, levenshtein } from '../src/suggest.js';
import { applyFixes } from '../src/cli.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const dir = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(dir, 'fixtures', name), 'utf8');
const rules = (findings: ReturnType<typeof checkWorkflow>) => findings.map((f) => f.rule);

describe('suggest', () => {
  it('levenshtein: identical is 0, one typo is 1', () => {
    expect(levenshtein('branches', 'branches')).toBe(0);
    expect(levenshtein('branch', 'branches')).toBe(2);
    expect(levenshtein('runs-on', 'run-on')).toBe(1);
  });

  it('didYouMean suggests the closest key and returns null for gibberish', () => {
    expect(didYouMean('branch', ['branches', 'tags', 'types'])).toBe('branches');
    expect(didYouMean('run-on', ['runs-on', 'steps', 'uses'])).toBe('runs-on');
    expect(didYouMean('zzzzqqq', ['branches', 'runs-on'])).toBeNull();
  });
});

describe('good workflow', () => {
  it('passes with no errors — only the two unpinned-action warnings for its @v4 tags', () => {
    const findings = checkWorkflow(fixture('good.yml'), 'good.yml');
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
    const unpinned = findings.filter((f) => f.rule === 'action-unpinned');
    expect(unpinned).toHaveLength(2); // actions/checkout@v4, actions/setup-node@v4
    expect(unpinned.every((f) => f.severity === 'warning')).toBe(true);
  });
});

describe('syntax errors', () => {
  it('reports a yaml-syntax error with a line number', () => {
    const findings = checkWorkflow(fixture('broken-syntax.yml'), 'broken-syntax.yml');
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.every((f) => f.rule === 'yaml-syntax')).toBe(true);
    expect(findings[0].line).toBeGreaterThanOrEqual(1);
    expect(findings[0].severity).toBe('error');
  });
});

describe('schema / keys', () => {
  it('flags branch -> branches with a fix, run-on, invalid runner, runn, and missing steps', () => {
    const findings = checkWorkflow(fixture('broken-keys.yml'), 'broken-keys.yml');
    expect(rules(findings)).toContain('unknown-key');
    expect(rules(findings)).toContain('missing-runs-on');
    expect(rules(findings)).toContain('invalid-runner');
    expect(rules(findings)).toContain('missing-steps');

    const branch = findings.find((f) => f.message.includes("'branch'"));
    expect(branch?.suggestion).toContain('branches');
    expect(branch?.fix).toEqual({ from: 'branch', to: 'branches' });

    const runOn = findings.find((f) => f.message.includes("'run-on'"));
    expect(runOn?.suggestion).toContain('runs-on');
    expect(runOn?.fix).toEqual({ from: 'run-on', to: 'runs-on' });

    const runner = findings.find((f) => f.rule === 'invalid-runner');
    expect(runner?.message).toContain('windows-95');
  });

  it('flags a workflow with no trigger and no jobs', () => {
    const findings = checkWorkflow('name: Empty\n', 'empty.yml');
    expect(rules(findings)).toContain('missing-trigger');
    expect(rules(findings)).toContain('missing-jobs');
  });

  it('flags a step with neither uses nor run', () => {
    const text = 'on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Nothing\n';
    const findings = checkWorkflow(text, 'x.yml');
    expect(rules(findings)).toContain('missing-step-action');
  });
});

describe('expressions', () => {
  it('flags unclosed, empty and unknown-context expressions, not valid ones', () => {
    const findings = checkWorkflow(fixture('broken-expressions.yml'), 'broken-expressions.yml');
    expect(rules(findings)).toContain('unbalanced-expression');
    expect(rules(findings)).toContain('empty-expression');
    expect(rules(findings)).toContain('unknown-expression-context');
    const unknown = findings.find((f) => f.rule === 'unknown-expression-context');
    expect(unknown?.message).toContain('foo');
    // The valid '${{ github.ref_name }}' step must not produce a finding.
    expect(findings.filter((f) => f.message.includes('ref_name'))).toEqual([]);
  });
});

describe('secrets', () => {
  it('suggests the right secret for typos and passes the correct name', () => {
    const findings = checkWorkflow(fixture('broken-secrets.yml'), 'broken-secrets.yml', {
      knownSecrets: ['DEPLOY_TOKEN', 'API_KEY'],
    });
    const typos = findings.filter((f) => f.rule === 'unknown-secret');
    expect(typos).toHaveLength(2);
    expect(typos[0].suggestion).toContain('DEPLOY_TOKEN');
    expect(typos[1].suggestion).toContain('API_KEY');
    expect(findings.some((f) => f.message.includes('DEPLOY_TOKEN') && f.rule === 'unknown-secret' && !f.suggestion?.includes('DEPLOY_TOKEN'))).toBe(false);
  });

  it('does not flag secrets when no known list is given (no false positives)', () => {
    const findings = checkWorkflow(fixture('broken-secrets.yml'), 'broken-secrets.yml');
    expect(findings.filter((f) => f.rule === 'unknown-secret')).toEqual([]);
  });

  it('never flags the built-in GITHUB_TOKEN', () => {
    const findings = checkWorkflow(fixture('good.yml'), 'good.yml', { knownSecrets: [] });
    expect(findings.filter((f) => f.rule === 'unknown-secret')).toEqual([]);
  });
});

describe('reusable workflows', () => {
  it('flags missing required input, wrong boolean type, bad choice and unknown input', () => {
    const findings = checkWorkflow(fixture('broken-reusable.yml'), join(dir, 'fixtures', 'broken-reusable.yml'));
    expect(rules(findings)).toContain('reusable-missing-input');
    expect(rules(findings)).toContain('reusable-wrong-type');
    expect(rules(findings)).toContain('reusable-unknown-input');
    const missing = findings.find((f) => f.rule === 'reusable-missing-input');
    expect(missing?.message).toContain('environment');
    const wrongType = findings.find((f) => f.rule === 'reusable-wrong-type' && f.message.includes('deploy'));
    expect(wrongType?.message).toContain('boolean');
    const badChoice = findings.find((f) => f.rule === 'reusable-wrong-type' && f.message.includes('region'));
    expect(badChoice?.message).toContain('us-east-1');
  });

  it('flags a workflow_call input with no type', () => {
    const text = 'on:\n  workflow_call:\n    inputs:\n      thing:\n        required: true\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n';
    const findings = checkWorkflow(text, 'called.yml');
    expect(rules(findings)).toContain('reusable-input-no-type');
  });
});

describe('--fix', () => {
  it('fixes only safe key renames and leaves the rest as findings', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'actions-doctor-'));
    try {
      const file = join(tmp, 'w.yml');
      writeFileSync(file, fixture('broken-keys.yml'));
      const before = checkWorkflow(readFileSync(file, 'utf8'), file);
      const fixed = applyFixes(file, before);
      expect(fixed).toBe(2); // branch -> branches, run-on -> runs-on
      const afterText = readFileSync(file, 'utf8');
      expect(afterText).toContain('branches: [main]');
      expect(afterText).toContain('runs-on: windows-95');
      const after = checkWorkflow(afterText, file);
      // The invalid runner and missing steps are NOT auto-fixed.
      expect(rules(after)).toContain('invalid-runner');
      expect(rules(after)).toContain('missing-steps');
      expect(after.some((f) => f.message.includes("'branch'"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
