import { labAppOf, LeftLabError } from "../guard.js";
import { resetLab } from "../lab.js";
import type { ToolSession } from "../mcp.js";
import type { CheckRow, ResultRow } from "../scorecard.js";
import type { Link } from "../targets.js";
import { NOT_MEASURED } from "./checks.js";
import { runR1, runR3, runR5, type CheckGroup, type Env, type Outcome } from "./driver.js";
import { hasAlertTool } from "./helpers.js";
import { runR4 } from "./viewerInput.js";

export interface ReliabilityOptions {
  /** Runs of the whole suite (default 3: a single miss in any run fails the row). */
  runs: number;
  link: Link;
  /** The agent's idle wait after a person's viewer input, ms (default 3500). */
  idleMs?: number;
  sleep?: (ms: number) => Promise<void>;
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

/** Reliability suite R1-R5 on the lab, `runs` times; R6-R8 as rows with `pass: null`. */
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
  const skipNotes = [...env.skipNotes];
  return [
    checkRow("R1", all),
    checkRow("R2", all),
    checkRow("R3", all, skipNotes),
    checkRow("R4", all),
    checkRow("R5", all),
    ...NOT_MEASURED.map(
      (n): CheckRow => ({ id: n.id, checks: 0, misses: 0, pass: null, notes: n.notes }),
    ),
  ];
}
