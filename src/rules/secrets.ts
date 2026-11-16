import { didYouMean } from '../suggest.js';
import type { Finding, ParsedWorkflow } from '../parse.js';

/** Secrets that always exist in GitHub Actions and never need declaring. */
export const BUILTIN_SECRETS = new Set(['GITHUB_TOKEN']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Secret names this workflow itself declares (workflow_call secrets). */
export function declaredSecrets(data: unknown): string[] {
  if (!isRecord(data)) return [];
  const on = data.on;
  if (!isRecord(on)) return [];
  const call = on.workflow_call;
  if (!isRecord(call)) return [];
  const secrets = call.secrets;
  if (!isRecord(secrets)) return [];
  return Object.keys(secrets);
}

export function checkSecrets(parsed: ParsedWorkflow, knownSecrets: string[]): Finding[] {
  const findings: Finding[] = [];
  const known = new Set([...BUILTIN_SECRETS, ...declaredSecrets(parsed.data), ...knownSecrets]);
  // Without any known names there is nothing to compare against, so a
  // typo check would only produce false positives. Still flag empty refs.
  const canCheckTypos = known.size > BUILTIN_SECRETS.size;

  for (const scalar of parsed.scalars) {
    const text = scalar.value;
    const bracket = /secrets\[['"]([^'"]*)['"]\]/g;
    const dot = /secrets\.([A-Za-z_][A-Za-z0-9_]*)/g;
    const emptyDot = /secrets\.(?![A-Za-z_])/g;

    let match: RegExpExecArray | null;
    while ((match = dot.exec(text)) !== null) {
      const name = match[1];
      if (BUILTIN_SECRETS.has(name)) continue;
      if (!canCheckTypos) continue;
      if (known.has(name)) continue;
      const suggestion = didYouMean(name, known);
      findings.push({
        file: parsed.file, line: scalar.line, column: scalar.column,
        rule: 'unknown-secret', severity: 'error',
        message: `Secret 'secrets.${name}' is not in the list of known secrets.`,
        suggestion: suggestion
          ? `Did you mean 'secrets.${suggestion}'?`
          : 'Check the spelling — secret names are case-sensitive.',
      });
    }
    while ((match = bracket.exec(text)) !== null) {
      const name = match[1];
      if (name === '' || BUILTIN_SECRETS.has(name) || known.has(name) || !canCheckTypos) continue;
      const suggestion = didYouMean(name, known);
      findings.push({
        file: parsed.file, line: scalar.line, column: scalar.column,
        rule: 'unknown-secret', severity: 'error',
        message: `Secret 'secrets.${name}' is not in the list of known secrets.`,
        suggestion: suggestion ? `Did you mean 'secrets.${suggestion}'?` : undefined,
      });
    }
    if (emptyDot.test(text)) {
      findings.push({
        file: parsed.file, line: scalar.line, column: scalar.column,
        rule: 'empty-secret', severity: 'error',
        message: "'secrets.' has no secret name after the dot.",
        suggestion: "Write e.g. 'secrets.DEPLOY_TOKEN'.",
      });
    }
  }
  return findings;
}
