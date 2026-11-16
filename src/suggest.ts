/** Levenshtein distance + "did you mean" suggestions. */

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Return the closest candidate to `input`, or null when nothing is close
 * enough to suggest confidently. The threshold scales with length so a
 * 3-letter typo is not matched against a 20-letter key.
 */
export function didYouMean(input: string, candidates: Iterable<string>): string | null {
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = levenshtein(input, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  if (best === null) return null;
  const maxDistance = Math.max(2, Math.floor(best.length / 3));
  return bestDistance <= maxDistance && bestDistance > 0 ? best : null;
}
