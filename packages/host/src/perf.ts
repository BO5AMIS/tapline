import { z } from "zod";
import { UNDER_KEYS, UNDER_NOT_MEASURED } from "./run.js";

/**
 * AGENT-TOOLS §15.3 `performance`, Tapline's answer: the app's numbers (`perfStop`) in the shared shape, and the
 * limits a `performance` step may carry in `expect.under`.
 */

/** What the app's `perfStop` answers. */
export const perfResultSchema = z.object({
  seconds: z.number(),
  frames: z.number(),
  fps: z.number(),
  fpsLowest: z.number(),
  drops: z.number(),
  busyMs: z.number(),
  heapMb: z.number().optional(),
  heapPeakMb: z.number().optional(),
  renders: z.array(z.object({ name: z.string(), ms: z.number(), count: z.number() })).optional(),
});
export type PerfResult = z.infer<typeof perfResultSchema>;

/** One finished measurement: the app's numbers, and for `launch` how long the reload took. */
export interface PerfMeasure {
  result: PerfResult;
  /** Seconds from the reload request to the first settled screen (launch only). */
  launchS?: number;
}

/** The answer's lines after the first: the numbers, the slowest renders (development builds), what wasn't measured. */
export function formatPerfLines(r: PerfResult): string[] {
  const parts: string[] = [];
  if (r.heapMb !== undefined) {
    parts.push(`JS heap ${Math.round(r.heapMb)} MB${r.heapPeakMb !== undefined ? ` (peak ${Math.round(r.heapPeakMb)})` : ""}.`);
  }
  parts.push(
    `JS frames ${Math.round(r.fps)} fps (lowest ${Math.round(r.fpsLowest)}); ${r.drops} drop${r.drops === 1 ? "" : "s"} over 50 ms; JS thread busy at most ${Math.round(r.busyMs)} ms.`,
  );
  const lines = [parts.join(" ")];
  if (r.renders !== undefined) {
    lines.push(
      r.renders.length === 0
        ? "Slowest renders: none over 1 ms."
        : `Slowest renders: ${r.renders.map((c) => `${c.name} ${Math.round(c.ms)} ms${c.count > 1 ? ` (${c.count} times)` : ""}`).join(", ")}.`,
    );
  }
  lines.push("Not measured here: CPU, process memory.");
  return lines;
}

/** The first line of the answer. `tap` names the tap the agent asked for, when there was one. */
export function perfFirstLine(m: PerfMeasure, tap?: string): string {
  if (m.launchS !== undefined) {
    return `Reloaded in ${m.launchS.toFixed(2)} s (to the first settled screen; JavaScript only, not a cold start).`;
  }
  const seconds = m.result.seconds.toFixed(1);
  return tap === undefined ? `Measured ${seconds} s.` : `Measured ${seconds} s, from just before the tap on ${tap}.`;
}

/** Whether `under` is something a step may carry: the keys it names that aren't limits, else null. */
export function badUnderKeys(under: Record<string, number>): string[] {
  const known = new Set<string>(UNDER_KEYS);
  return Object.keys(under).filter((key) => !known.has(key));
}

/**
 * Checks a measurement against `under` (§15.3): `fps_min` against the lowest sample, the others are maximums.
 * `missed` lists every limit that wasn't kept; `notes` the limits that couldn't be checked (no `Note:` prefix).
 */
export function checkUnder(under: Record<string, number>, m: PerfMeasure): { missed: string[]; notes: string[] } {
  const missed: string[] = [];
  const notes: string[] = [];
  const r = m.result;
  for (const key of UNDER_KEYS) {
    const limit = under[key];
    if (limit === undefined) continue;
    if ((UNDER_NOT_MEASURED as readonly string[]).includes(key)) {
      notes.push(`${key} isn't measured by Tapline; not checked.`);
      continue;
    }
    switch (key) {
      case "launch_s":
        if (m.launchS === undefined) notes.push("launch_s only applies to a launch step; not checked.");
        else if (m.launchS > limit) missed.push(`reloaded in ${m.launchS.toFixed(1)} s, over ${limit.toFixed(1)} s`);
        break;
      case "js_heap_mb":
        if (r.heapPeakMb === undefined) notes.push("js_heap_mb couldn't be read in this app (no Hermes heap numbers); not checked.");
        else if (r.heapPeakMb > limit) missed.push(`JS heap peaked at ${Math.round(r.heapPeakMb)} MB, over ${limit} MB`);
        break;
      case "fps_min":
        if (r.fpsLowest < limit) missed.push(`lowest ${Math.round(r.fpsLowest)} fps, under ${limit}`);
        break;
      case "drops":
        if (r.drops > limit) missed.push(`${r.drops} drop${r.drops === 1 ? "" : "s"}, over ${limit}`);
        break;
      case "busy_ms":
        if (r.busyMs > limit) missed.push(`JS thread busy ${Math.round(r.busyMs)} ms, over ${limit} ms`);
        break;
      default:
        break;
    }
  }
  return { missed, notes };
}
