import type { Finding, ParsedWorkflow } from '../parse.js';

/** Contexts GitHub Actions expressions may start with. */
export const EXPRESSION_CONTEXTS = new Set([
  'github', 'env', 'secrets', 'vars', 'inputs', 'needs', 'steps',
  'matrix', 'job', 'runner', 'strategy',
]);

/** Functions allowed at the start of an expression. */
export const EXPRESSION_FUNCTIONS = new Set([
  'contains', 'startsWith', 'endsWith', 'format', 'join', 'toJSON',
  'fromJSON', 'hashFiles', 'success', 'failure', 'always', 'cancelled',
]);

export function checkExpressions(parsed: ParsedWorkflow): Finding[] {
  const findings: Finding[] = [];
  for (const scalar of parsed.scalars) {
    const text = scalar.value;
    let searchFrom = 0;
    for (;;) {
      const start = text.indexOf('${{', searchFrom);
      if (start === -1) break;
      const close = text.indexOf('}}', start + 3);
      if (close === -1) {
        findings.push({
          file: parsed.file, line: scalar.line, column: scalar.column,
          rule: 'unbalanced-expression', severity: 'error',
          message: `Expression starting at '${text.slice(start, start + 20)}…' is missing its closing '}}'.`,
          suggestion: "Expressions look like '${{ github.ref }}' — every '${{' needs a matching '}}'.",
        });
        break;
      }
      const inner = text.slice(start + 3, close).trim();
      if (inner === '') {
        findings.push({
          file: parsed.file, line: scalar.line, column: scalar.column,
          rule: 'empty-expression', severity: 'error',
          message: "Empty expression '${{ }}' — it needs something inside, e.g. '${{ github.ref }}'.",
        });
      } else {
        // Root token: first identifier before '.', '[', ' ', '(' or '!'.
        const root = inner.replace(/^!\s*/, '').split(/[.[\s(]/)[0] ?? '';
        if (root && !EXPRESSION_CONTEXTS.has(root) && !EXPRESSION_FUNCTIONS.has(root)) {
          findings.push({
            file: parsed.file, line: scalar.line, column: scalar.column,
            rule: 'unknown-expression-context', severity: 'error',
            message: `Unknown expression context '${root}' in '\${{ ${inner} }}'.`,
            suggestion: "Known contexts: github, env, secrets, vars, inputs, needs, steps, matrix, job, runner, strategy.",
          });
        }
      }
      searchFrom = close + 2;
    }
    // A lone '${{' with no value at all is caught above; a stray '}}' is a
    // likely copy-paste error too.
    if (!text.includes('${{') && text.includes('}}')) {
      findings.push({
        file: parsed.file, line: scalar.line, column: scalar.column,
        rule: 'unbalanced-expression', severity: 'warning',
        message: `This text contains '}}' but no '\${{' — it is probably a leftover from an edited expression.`,
      });
    }
  }
  return findings;
}
