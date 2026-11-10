export type Link = "good" | "3g";

export type Target = { median: number; p95: number } | { max: number };

/** Speed targets from docs/QUALITY-BAR.md, in seconds. */
const TABLE: Record<string, Record<Link, Target>> = {
  S1: { good: { median: 0.7, p95: 1.2 }, "3g": { median: 1.5, p95: 2.5 } },
  S2: { good: { median: 0.5, p95: 1.0 }, "3g": { median: 1.5, p95: 3.0 } },
  S3: { good: { median: 0.8, p95: 1.5 }, "3g": { median: 2.5, p95: 4.0 } },
  S4: { good: { max: 3 }, "3g": { max: 6 } },
  S5: { good: { max: 5 }, "3g": { max: 8 } },
  V1: { good: { median: 0.3, p95: 0.5 }, "3g": { median: 1.0, p95: 2.0 } },
  /** V7.s1: the agent's tap while the viewer streams has S1's bar. */
  "V7.s1": { good: { median: 0.7, p95: 1.2 }, "3g": { median: 1.5, p95: 2.5 } },
};

/** Looks up a target by full row id, then by parent: a sub-row such as `S1.type` carries `S1`'s. */
export function targetFor(id: string, link: Link): Target {
  const base = id.split(".")[0] ?? id;
  const row = TABLE[id] ?? TABLE[base];
  if (!row) throw new Error(`No target for ${id}`);
  return row[link];
}

export function isMax(t: Target): t is { max: number } {
  return "max" in t;
}

/** A single-value target: at least `min`, or at most `max`. */
export type ValueTarget = { min: number } | { max: number };

export function isMinTarget(t: ValueTarget): t is { min: number } {
  return "min" in t;
}

/**
 * Viewer targets from docs/QUALITY-BAR.md (V table) for the single-value rows. `null` means the
 * bar only asks for a report on that link. Looked up by full id first (V5.sharp), then by parent id
 * (V3.look carries V3's target).
 */
const VALUE_TABLE: Record<string, Record<Link, ValueTarget | null>> = {
  V2: { good: { min: 15 }, "3g": { min: 2 } },
  V3: { good: { max: 0.25 }, "3g": { max: 2 } },
  V4: { good: { max: 0.15 }, "3g": { max: 1.0 } },
  "V5.sharp": { good: { min: 2.0 }, "3g": { min: 2.0 } },
  "V5.balanced": { good: { min: 1.5 }, "3g": { min: 1.5 } },
  "V5.light": { good: { min: 0.75 }, "3g": { min: 0.75 } },
  "V7.kbps": { good: null, "3g": { max: 33 } },
};

export function valueTargetFor(id: string, link: Link): ValueTarget | null {
  const row = VALUE_TABLE[id] ?? VALUE_TABLE[id.split(".")[0] ?? id];
  if (!row) throw new Error(`No target for ${id}`);
  return row[link];
}
