export interface Summary {
  n: number;
  median: number;
  p95: number;
  min: number;
  max: number;
}

/** Nearest-rank percentile of an ascending array: the value at ceil(p*n)-1. */
function rank(sorted: number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i] ?? Number.NaN;
}

/** Summary by nearest-rank (median = p50, so an even count gives the lower middle). Non-finite samples are dropped. */
export function summarize(samples: number[]): Summary {
  const s = samples.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (s.length === 0) {
    return { n: 0, median: Number.NaN, p95: Number.NaN, min: Number.NaN, max: Number.NaN };
  }
  return {
    n: s.length,
    median: rank(s, 0.5),
    p95: rank(s, 0.95),
    min: s[0] ?? Number.NaN,
    max: s[s.length - 1] ?? Number.NaN,
  };
}
