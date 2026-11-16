import type { Finding, ParsedWorkflow } from '../parse.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Collect every `matrix.<key>` (and `matrix['<key>']`) reference inside one
 * job's own scalars, excluding the `strategy.matrix` definition itself —
 * defining a key is not using it.
 */
function matrixReferences(parsed: ParsedWorkflow, jobId: string): Set<string> {
  const used = new Set<string>();
  const prefix = `jobs.${jobId}.`;
  const matrixDefPrefix = `jobs.${jobId}.strategy.matrix`;
  const dotRe = /matrix\.([A-Za-z_][A-Za-z0-9_-]*)/g;
  const bracketRe = /matrix\[['"]([^'"]+)['"]\]/g;
  for (const scalar of parsed.scalars) {
    if (!scalar.path.startsWith(prefix)) continue;
    if (scalar.path.startsWith(matrixDefPrefix)) continue;
    let match: RegExpExecArray | null;
    while ((match = dotRe.exec(scalar.value)) !== null) used.add(match[1]);
    while ((match = bracketRe.exec(scalar.value)) !== null) used.add(match[1]);
  }
  return used;
}

export function checkMatrix(parsed: ParsedWorkflow): Finding[] {
  const findings: Finding[] = [];
  const data = parsed.data as Record<string, unknown>;
  if (!isRecord(data) || !isRecord(data.jobs)) return findings;

  for (const [jobId, job] of Object.entries(data.jobs)) {
    if (!isRecord(job)) continue;
    // A reusable-workflow call has no strategy of its own to check.
    if (typeof job.uses === 'string') continue;
    const strategy = job.strategy;
    if (!isRecord(strategy)) continue;
    const matrix = strategy.matrix;
    if (matrix === undefined) continue;

    const matrixPath = `jobs.${jobId}.strategy.matrix`;
    const matrixLine = parsed.keyLines.get(matrixPath) ?? 1;
    if (!isRecord(matrix)) {
      findings.push({
        file: parsed.file, line: matrixLine, rule: 'matrix-invalid', severity: 'error',
        message: `Job '${jobId}': 'strategy.matrix' must be a mapping of keys to lists, e.g. 'os: [ubuntu-latest, windows-latest]'.`,
      });
      continue;
    }

    const keys = Object.keys(matrix).filter((k) => k !== 'include' && k !== 'exclude');
    if (keys.length === 0) {
      findings.push({
        file: parsed.file, line: matrixLine, rule: 'matrix-empty', severity: 'error',
        message: `Job '${jobId}': 'strategy.matrix' has no keys — a matrix with nothing in it runs nothing.`,
      });
    }

    for (const key of keys) {
      const line = parsed.keyLines.get(`${matrixPath}.${key}`) ?? matrixLine;
      const value = matrix[key];
      if (Array.isArray(value)) {
        if (value.length === 0) {
          findings.push({
            file: parsed.file, line, rule: 'matrix-empty', severity: 'error',
            message: `Job '${jobId}': matrix key '${key}' has an empty list — the job would have no combinations to run.`,
            suggestion: `Give '${key}' at least one value, or remove it from the matrix.`,
          });
        }
      } else {
        findings.push({
          file: parsed.file, line, rule: 'matrix-invalid', severity: 'error',
          message: `Job '${jobId}': matrix key '${key}' must be a list of values, but got '${String(value)}'.`,
          suggestion: `Write e.g. '${key}: [${String(value)}]'.`,
        });
      }
    }

    // include / exclude must be lists of mappings.
    for (const special of ['include', 'exclude'] as const) {
      const value = matrix[special];
      if (value === undefined) continue;
      const line = parsed.keyLines.get(`${matrixPath}.${special}`) ?? matrixLine;
      if (!Array.isArray(value) || value.some((entry) => !isRecord(entry))) {
        findings.push({
          file: parsed.file, line, rule: 'matrix-invalid', severity: 'error',
          message: `Job '${jobId}': 'strategy.matrix.${special}' must be a list of mappings, e.g. '- os: ubuntu-latest'.`,
        });
      }
    }

    // Unused keys: defined in the matrix but never referenced as
    // `${{ matrix.<key> }}` anywhere in this job.
    const used = matrixReferences(parsed, jobId);
    for (const key of keys) {
      if (used.has(key)) continue;
      findings.push({
        file: parsed.file, line: parsed.keyLines.get(`${matrixPath}.${key}`) ?? matrixLine,
        rule: 'matrix-unused-key', severity: 'warning',
        message: `Job '${jobId}': matrix key '${key}' is defined but never used as '\${{ matrix.${key} }}' anywhere in this job.`,
        suggestion: `Remove '${key}' from the matrix, or use it in 'runs-on', a step's 'run' / 'with' / 'if', or the job's environment.`,
      });
    }
  }
  return findings;
}
