import { labAppOf, LeftLabError } from "../guard.js";
import { resetLab } from "../lab.js";
import type { ToolSession } from "../mcp.js";
import type { CheckRow, ResultRow } from "../scorecard.js";
import type { Link } from "../targets.js";
import { NOT_MEASURED } from "./checks.js";
import {
  R6_DEFAULTS,
  runR1,
  runR3,
  runR5,
  runR6,
  type CheckGroup,
  type Env,
  type Outcome,
  type R6Options,
} from "./driver.js";
import { hasAlertTool } from "./helpers.js";
import { runR4 } from "./viewerInput.js";

/**
 * Besides the fields here, the R6 times in ms (`Partial<R6Options>`): `freezeMs` how long the lab's
 * freeze blocks the app (20000), `recoverMs` the wait after it (2000), `callLimitMs` the limit for a
 * call during the freeze (20000), `afterLimitMs` the limit for the look after it (5000).
 */
export interface ReliabilityOptions extends Partial<R6Options> {
  /** Runs of the whole suite (default 3: a single miss in any run fails the row). */
  runs: number;
  link: Link;
  /** The agent's idle wait after a person's viewer input, ms (default 3500). */
  idleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** The R6 times with their defaults. */
function r6Options(opts: ReliabilityOptions): R6Options {
  return {
    freezeMs: opts.freezeMs ?? R6_DEFAULTS.freezeMs,
    recoverMs: opts.recoverMs ?? R6_DEFAULTS.recoverMs,
    callLimitMs: opts.callLimitMs ?? R6_DEFAULTS.callLimitMs,
    afterLimitMs: opts.afterLimitMs ?? R6_DEFAULTS.afterLimitMs,
  };
}

/** Skip notes that belong to R6's row (they start with `R6:`) and the rest, for R3's row. */
function splitSkipNotes(notes: string[]): { r6: string[]; rest: string[] } {
  return { r6: notes.filter((n) => n.startsWith("R6:")), rest: notes.filter((n) => !n.startsWith("R6:")) };
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const MAX_NOTES = 12;

/** One row from the outcomes of a group: checks, misses, and a note per miss with its run. */
export function checkRow(
  id: CheckGroup,
  outcomes: { run: number; outcome: Outcome }[],
  extraNotes: string[] = [],
): CheckRow {
  const mine = outcomes.filter((o) => o.outcome.id === id);
  const missed = mine.filter((o) => !o.outcome.ok);
  const lines = missed.map(
    (o) => `run ${o.run}: ${o.outcome.name}${o.outcome.note ? ` -> ${o.outcome.note}` : ""}`,
  );
  const shown = lines.slice(0, MAX_NOTES);
  if (lines.length > MAX_NOTES) shown.push(`(+${lines.length - MAX_NOTES} more misses)`);
  const notes = [...shown, ...extraNotes].join("; ");
  return {
    id,
    checks: mine.length,
    misses: missed.length,
    pass: missed.length === 0 && mine.length > 0,
    ...(notes ? { notes } : {}),
  };
}

/**
 * Reliability suite R1-R6 on the lab, `runs` times; R7 and R8 (and R6 when the lab has no `lab-freeze`)
 * as rows with `pass: null`.
 */
export async function runReliability(tool: ToolSession, opts: ReliabilityOptions): Promise<ResultRow[]> {
  const sleep = opts.sleep ?? realSleep;
  const idleMs = opts.idleMs ?? 3500;
  const labApp = labAppOf(tool);
  const env: Env = {
    tool,
    hasAlert: await hasAlertTool(tool),
    sleep,
    skipNotes: new Set(),
    ...(labApp !== undefined ? { labApp } : {}),
  };
  const r6opts = r6Options(opts);
  const all: { run: number; outcome: Outcome }[] = [];
  let left = false;
  try {
    for (let run = 1; run <= opts.runs; run++) {
      env.run = run;
      const add = (os: Outcome[]): void => {
        for (const outcome of os) all.push({ run, outcome });
      };
      await resetLab(tool);
      add(await runR1(env));
      await resetLab(tool);
      add(await runR3(env, false));
      add([await runR5(env)]);
      const r6 = await runR6(env, r6opts);
      if (r6) add([r6]);
      add(await runR3(env, true));
      await resetLab(tool);
      add(await runR4(env, idleMs));
    }
  } catch (e) {
    left = e instanceof LeftLabError;
    throw e;
  } finally {
    // Never reset (touch) once the phone left the lab's app.
    if (!left) await resetLab(tool).catch(() => undefined);
  }
  const { r6: r6Notes, rest: skipNotes } = splitSkipNotes([...env.skipNotes]);
  const r6Measured = all.some((o) => o.outcome.id === "R6");
  return [
    checkRow("R1", all),
    checkRow("R2", all),
    checkRow("R3", all, skipNotes),
    checkRow("R4", all),
    checkRow("R5", all),
    ...(r6Measured ? [checkRow("R6", all, r6Notes)] : []),
    ...NOT_MEASURED.filter((n) => !(r6Measured && n.id === "R6")).map(
      (n): CheckRow => ({
        id: n.id,
        checks: 0,
        misses: 0,
        pass: null,
        notes: n.id === "R6" ? [n.notes, ...r6Notes].join("; ") : n.notes,
      }),
    ),
  ];
}
