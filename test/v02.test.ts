import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checkWorkflow } from '../src/parse.js';

const dir = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(dir, 'fixtures', name), 'utf8');
const rules = (findings: ReturnType<typeof checkWorkflow>) => findings.map((f) => f.rule);
const errors = (findings: ReturnType<typeof checkWorkflow>) =>
  findings.filter((f) => f.severity === 'error');

describe('v0.2.0 — action versions', () => {
  it('flags mutable refs, a missing ref and an outdated major, but not a full SHA', () => {
    const findings = checkWorkflow(fixture('broken-actions.yml'), 'broken-actions.yml');
    const unpinned = findings.filter((f) => f.rule === 'action-unpinned');
    // checkout@v3, setup-node@main, build-push-action@v6, cache (no ref)
    expect(unpinned).toHaveLength(4);
    const outdated = findings.filter((f) => f.rule === 'action-outdated');
    expect(outdated).toHaveLength(1);
    expect(outdated[0].message).toContain('actions/checkout@v3');
    expect(outdated[0].suggestion).toContain('v4');
    // The full-SHA upload-artifact step must produce no action finding.
    expect(findings.filter((f) => f.message.includes('upload-artifact'))).toEqual([]);
  });

  it('passes a workflow whose actions are all SHA-pinned', () => {
    const text = [
      'on: push',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      '      - run: echo hi',
      '',
    ].join('\n');
    expect(checkWorkflow(text, 'sha.yml')).toEqual([]);
  });

  it('does not flag local, docker:// or reusable-workflow uses as actions', () => {
    const text = [
      'on: push',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: ./local-action',
      '      - uses: docker://alpine:3.19',
      '      - run: echo hi',
      '',
    ].join('\n');
    const findings = checkWorkflow(text, 'local.yml');
    expect(findings.filter((f) => f.rule.startsWith('action-'))).toEqual([]);
  });

  it('the ignore marker suppresses unpinned but not outdated findings', () => {
    const text = [
      '# actions-doctor: ignore action-unpinned',
      'on: push',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v3',
      '      - uses: actions/setup-node@v4',
      '',
    ].join('\n');
    const findings = checkWorkflow(text, 'ignored.yml');
    expect(findings.filter((f) => f.rule === 'action-unpinned')).toEqual([]);
    expect(findings.filter((f) => f.rule === 'action-outdated')).toHaveLength(1);
  });
});

describe('v0.2.0 — matrix validation', () => {
  it('flags an empty list, a non-list value and an unused key, not used keys', () => {
    const findings = checkWorkflow(fixture('broken-matrix.yml'), 'broken-matrix.yml');
    expect(rules(findings)).toContain('matrix-empty');
    expect(rules(findings)).toContain('matrix-invalid');
    expect(rules(findings)).toContain('matrix-unused-key');

    const empty = findings.find((f) => f.rule === 'matrix-empty');
    expect(empty?.message).toContain('python');
    const invalid = findings.find((f) => f.rule === 'matrix-invalid');
    expect(invalid?.message).toContain('arch');
    const unused = findings.filter((f) => f.rule === 'matrix-unused-key');
    // arch (a non-list value) and unused-key are never referenced; os, node
    // and python are used, so they get no unused finding.
    expect(unused).toHaveLength(2);
    expect(unused.some((f) => f.message.includes("'unused-key'"))).toBe(true);
    expect(unused.some((f) => f.message.includes("'arch'"))).toBe(true);
    expect(unused.every((f) => f.severity === 'warning')).toBe(true);
  });

  it('passes a matrix whose keys are all referenced', () => {
    const text = [
      'on: push',
      'jobs:',
      '  test:',
      '    runs-on: ${{ matrix.os }}',
      '    strategy:',
      '      matrix:',
      '        os: [ubuntu-latest]',
      '        node: [\'20\']',
      '    steps:',
      '      - uses: actions/checkout@a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      '      - run: echo ${{ matrix.node }}',
      '',
    ].join('\n');
    const findings = checkWorkflow(text, 'matrix-good.yml');
    expect(findings.filter((f) => f.rule.startsWith('matrix-'))).toEqual([]);
  });

  it('flags a non-mapping matrix', () => {
    const text = [
      'on: push',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    strategy:',
      '      matrix: [ubuntu-latest]',
      '    steps:',
      '      - run: echo hi',
      '',
    ].join('\n');
    expect(rules(checkWorkflow(text, 'm.yml'))).toContain('matrix-invalid');
  });
});

describe('v0.2.0 — composite actions', () => {
  it('passes a well-formed composite action with no findings', () => {
    expect(checkWorkflow(fixture('good-composite.yml'), 'good-composite.yml')).toEqual([]);
  });

  it('flags a missing description, unknown keys, input/output problems and a bad step', () => {
    const findings = checkWorkflow(fixture('broken-composite.yml'), 'broken-composite.yml');
    expect(rules(findings)).toContain('missing-description');
    expect(rules(findings)).toContain('unknown-key');
    expect(rules(findings)).toContain('composite-input-no-description');
    expect(rules(findings)).toContain('composite-output-no-description');
    expect(rules(findings)).toContain('missing-step-action');
    // The checkout@v3 step is also checked by the action-version rules.
    expect(rules(findings)).toContain('action-unpinned');
    expect(rules(findings)).toContain('action-outdated');

    const topKey = findings.find((f) => f.message.includes("'bogus-top'"));
    expect(topKey?.rule).toBe('unknown-key');
    const badInput = findings.find((f) => f.rule === 'unknown-key' && f.message.includes("'bogus'"));
    expect(badInput?.message).toContain("input 'bad-input'");
    expect(errors(findings).length).toBeGreaterThanOrEqual(5);
  });

  it('flags a composite action with no runs.steps', () => {
    const text = [
      'name: Empty composite',
      'description: Does nothing.',
      'runs:',
      '  using: composite',
      '',
    ].join('\n');
    expect(rules(checkWorkflow(text, 'action.yml'))).toContain('missing-steps');
  });

  it('does not treat a composite action file as a workflow (no missing on/jobs)', () => {
    const findings = checkWorkflow(fixture('good-composite.yml'), 'action.yml');
    expect(rules(findings)).not.toContain('missing-trigger');
    expect(rules(findings)).not.toContain('missing-jobs');
  });
});
