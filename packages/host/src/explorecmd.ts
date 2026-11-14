import { fixtureRef, type ExploreFill } from "./explore.js";
import type { StopReason } from "./explorereport.js";
import { createRuntime, type RuntimeOptions } from "./runtime.js";
import { APP_WAIT_MS, BUSY_POLL_MS, BUSY_WAIT_MS } from "./runschedule.js";
import type { ToolArgs } from "./tools.js";

// `tapline explore` (AGENT-TOOLS 1.15 §25.2, "Without an agent"): the same search from the command line, with the same report.
//   tapline explore [--minutes N] [--steps N] [--depth N] [--from PLACE] [--focus PLACE] [--fill test-data] [--continue] [--account NAME]
// plus the flags a server takes (--policy, --accounts, --maps). Exit code 0: it ended and found nothing. 1: it ended with findings,
// a crash included. 2: it couldn't start (no phone, no app, a bad flag), or a person or a pause stopped it before the end (the
// report is still written). When the phone is busy it waits up to 10 minutes (§22.3), then answers `skipped: the phone was in use`.

/** What the command line gave, as `parseArgs` read it. */
export interface ExploreFlags {
  minutes?: string | undefined;
  steps?: string | undefined;
  depth?: string | undefined;
  from?: string | undefined;
  focus?: string | undefined;
  fill?: string | undefined;
  continue?: boolean | undefined;
  account?: string | undefined;
  wait?: string | undefined;
}

/** What a run of `explore` came to, for the exit code. */
export interface ExploreCliResult {
  text: string;
  /** The call was refused before it began (a bad value, no app, no map). */
  refused: boolean;
  findings: number;
  stopped: StopReason | null;
}

/** A host the app is connected to, as the command line needs it (a fake one in tests). */
export interface ExploreCliHost {
  /** Says what ran the search, `its own host`. */
  via: string;
  /** True when the app is connected, waiting up to `waitMs` for it. */
  appOpen(waitMs: number): Promise<boolean>;
  /** True while an agent or a person is driving the phone. */
  inUse(): boolean | Promise<boolean>;
  explore(args: ToolArgs<"explore">): Promise<ExploreCliResult>;
  close(): Promise<void>;
}

export interface ExploreCliDeps {
  connect(): Promise<ExploreCliHost>;
  clock(): number;
  sleep(ms: number): Promise<void>;
  out(text: string): void;
  err(text: string): void;
  /** How long it waits for the app to connect (default 60 s). */
  appWaitMs?: number;
  /** How long it waits for a busy phone (default 10 minutes). */
  busyWaitMs?: number;
}

export const SKIPPED_IN_USE = "skipped: the phone was in use";

/** Stops that are not a normal end: a person or a pause (exit 2). */
const PERSON_STOPS: ReadonlySet<StopReason> = new Set(["paused", "busy", "locked"]);
/** Stops that end the run on a problem the report names, with no finding of their own (exit 1). */
const TROUBLE_STOPS: ReadonlySet<StopReason> = new Set(["crash", "toggle_not_restored", "cant_get_back", "app_closed"]);

/** The call's arguments from the flags, or what is wrong with them. A value out of range is the tool's to refuse. */
export function exploreArgs(flags: ExploreFlags): { args: ToolArgs<"explore"> } | { error: string } {
  const args: ToolArgs<"explore"> = {};
  for (const name of ["minutes", "steps", "depth"] as const) {
    const raw = flags[name];
    if (raw === undefined) continue;
    const value = raw.trim() === "" ? Number.NaN : Number(raw);
    if (!Number.isFinite(value)) return { error: `--${name} is a number, not "${raw}"` };
    args[name] = value;
  }
  if (flags.fill !== undefined) {
    if (flags.fill !== "none" && flags.fill !== "test-data" && fixtureRef(flags.fill) === null) return { error: `--fill is "none", "test-data" or "fixture:<name>.<field>", not "${flags.fill}"` };
    args.fill = flags.fill as ExploreFill;
  }
  for (const name of ["from", "focus", "account"] as const) {
    const raw = flags[name];
    if (raw === undefined) continue;
    if (raw.trim() === "") return { error: `--${name} needs a name` };
    args[name] = raw;
  }
  if (flags.continue === true) args.continue = true;
  return { args };
}

/** The exit code of a finished run (see the top of this file). */
export function exitCodeOf(result: ExploreCliResult): number {
  if (result.refused) return 2;
  if (result.stopped !== null && PERSON_STOPS.has(result.stopped)) return 2;
  if (result.findings > 0) return 1;
  return result.stopped !== null && TROUBLE_STOPS.has(result.stopped) ? 1 : 0;
}

/** Runs `tapline explore`. The host, the clock and the sleeping are injected, so every case runs without a phone. */
export async function runExplore(flags: ExploreFlags, deps: ExploreCliDeps): Promise<number> {
  const wait = flags.wait === undefined ? (deps.appWaitMs ?? APP_WAIT_MS) / 1000 : Number(flags.wait);
  if (!(wait > 0) || !Number.isFinite(wait)) {
    deps.err("--wait is in seconds, above 0 and finite");
    return 2;
  }
  const parsed = exploreArgs(flags);
  if ("error" in parsed) {
    deps.err(parsed.error);
    return 2;
  }
  let host: ExploreCliHost;
  try {
    host = await deps.connect();
  } catch (error) {
    deps.err(`explore couldn't start: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  try {
    deps.out(`Waiting up to ${Math.round(wait)} s for the app to connect (open it on the phone)…`);
    if (!(await host.appOpen(wait * 1000))) {
      deps.err("The app didn't connect. Is it open, on the same Wi-Fi as this computer?");
      return 2;
    }
    // The phone is busy while a person or an agent drives it: wait up to 10 minutes, then do nothing (§22.3).
    const deadline = deps.clock() + (deps.busyWaitMs ?? BUSY_WAIT_MS);
    while (await host.inUse()) {
      const left = deadline - deps.clock();
      if (left <= 0) {
        deps.err(SKIPPED_IN_USE);
        return 2;
      }
      await deps.sleep(Math.min(BUSY_POLL_MS, left));
    }
    const result = await host.explore(parsed.args);
    const code = exitCodeOf(result);
    (code === 2 ? deps.err : deps.out)(result.text);
    return code;
  } finally {
    await host.close().catch(() => undefined);
  }
}

/**
 * A host of its own with the app connected to it (the app finds it as it finds a `tapline host`), taking the server's flags: the policy,
 * the accounts and the maps. Not tested against a phone; runExplore is tested with a fake host.
 */
export async function ownExploreHost(options: RuntimeOptions): Promise<ExploreCliHost> {
  const runtime = await createRuntime({ ...options, screenshots: "file", log: () => undefined });
  const tools = runtime.toolsFor("explore");
  return {
    via: "its own host",
    appOpen: async (waitMs) => {
      const until = Date.now() + waitMs;
      while (runtime.host.current() === undefined && Date.now() < until) await new Promise<void>((resolve) => setTimeout(resolve, 250));
      return runtime.host.current() !== undefined;
    },
    inUse: () => runtime.phoneInUse(),
    explore: async (args) => {
      const ran = await tools.withCall(undefined, () => tools.exploreRun(args));
      const text = ran.answer.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
      return { text, refused: ran.outcome === undefined, findings: ran.outcome?.report.findings.length ?? 0, stopped: ran.outcome?.report.stopped ?? null };
    },
    close: () => runtime.close(),
  };
}
