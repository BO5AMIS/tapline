import { readFileSync } from "node:fs";
import { join } from "node:path";
import { asWords, matchWord, type PolicyFile } from "./policy.js";
import type { BugMeta } from "./bug.js";
import { bugAnswer, makeBug, readRunFinding, reproducedAnswer, shownPath, type BugContext } from "./bugreport.js";
import { BugGateError, BugStore, isBugId, type BugCheck } from "./bugstore.js";
import { FLOOR_WORDS, exploreLists } from "./explorefloor.js";
import type { MapFile } from "./mapfile.js";

// `tapline bug ...` (AGENT-TOOLS 1.16 §29.3, "The CLI"): the bug report from a terminal. It needs no phone and no host.
//   tapline bug <report folder> <finding id> [--verify N] [--with-picture]
//   tapline bug list [--app ID]
//   tapline bug <bug id>                       shows one
//   tapline bug verify <bug id> [--verify N]   the reproduction check: not available in this version
//   tapline bug export <bug id> --to issue|zip ...   the export: not available in this version
// `from: "now"` and `from: "failure"` need the live session: use the thin call, `tapline call bug_report '{…}'`.
// Exit codes: 0 a bug was made or updated and it reproduced or wasn't checked; 1 it was made and didn't reproduce (`0 of N`);
// 2 it couldn't be made, or a person, a pause or a refusal stopped it.

export interface BugFlags {
  verify?: string | undefined;
  "with-picture"?: boolean | undefined;
  app?: string | undefined;
  to?: string | undefined;
  repo?: string | undefined;
  public?: boolean | undefined;
  yes?: boolean | undefined;
}

export interface BugCliDeps {
  /** The reproduction check (§29.4): a hook for the next piece of work. Unset: `--verify` and `bug verify` are refused. */
  check?: BugCheck;
  /** `~/.tapline/bugs`, or a folder of a test. */
  bugsDir: string;
  /** The vault's redaction (the accounts file), else none (§29.6). */
  redact: (text: string) => string;
  /** The app's map from the maps folder, or undefined. */
  map: (app: string) => MapFile | undefined;
  policy: PolicyFile;
  out(text: string): void;
  err(text: string): void;
}

export const BUG_USAGE = [
  "Usage: tapline bug <report folder> <finding id> [--verify N] [--with-picture]",
  "       tapline bug list [--app ID]",
  "       tapline bug <bug id>",
  "       tapline bug verify <bug id> [--verify N]",
  "       tapline bug export <bug id> --to issue --repo owner/name [--public] [--with-picture] [--yes] | --to zip",
].join("\n");

const NO_VERIFY = "verify (the reproduction check) isn't available in this version.";
const NO_EXPORT = "export isn't available in this version.";

/** `--verify N`: a whole number from 0 to 10; absent is 0 here (a check needs a phone). */
function verifyCount(raw: string | undefined): number | { error: string } {
  if (raw === undefined) return 0;
  const n = raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : { error: `--verify is a whole number from 0 to 10, not "${raw}"` };
}

function contextOf(deps: BugCliDeps, store: BugStore): BugContext {
  return {
    store,
    redact: deps.redact,
    placeKey: (app, place) => (place === null ? null : (deps.map(app)?.places[place]?.key ?? null)),
    roads: (app) => deps.map(app)?.roads ?? [],
    needsPerson: (app, step) => {
      const target = step.target;
      const subject = target?.label ?? target?.text ?? (target?.id !== undefined ? asWords(target.id) : undefined);
      if (subject === undefined) return false;
      const lists = exploreLists(deps.policy, { id: app, name: app });
      return matchWord([...FLOOR_WORDS, ...lists.confirm, ...lists.block], { label: subject }) !== null;
    },
  };
}

/** The list of §29.3: per app, newest first, with counts. */
export function bugListText(store: BugStore, redact: (text: string) => string, app?: string): string {
  const rows = store.list(app);
  if (rows.length === 0) return "No bugs kept.";
  const lines: string[] = [];
  let current: string | null = null;
  for (const row of rows) {
    if (row.app !== current) {
      lines.push(row.app);
      current = row.app;
    }
    lines.push(`  ${row.id}  ${row.title}   seen ${row.count}, last ${row.last.slice(0, 10)}, ${row.reproduced}`);
  }
  return redact(lines.join("\n"));
}

/** 0: it reproduced or wasn't checked; 1: it didn't reproduce (`0 of N`) (§29.3). */
function exitOf(meta: BugMeta): number {
  const r = meta.reproduced;
  return !("checked" in r) && r.n === 0 ? 1 : 0;
}

/** Runs `tapline bug`. Everything it needs comes in `deps`, so each case runs without a phone. */
export async function runBug(positionals: string[], flags: BugFlags, deps: BugCliDeps): Promise<number> {
  const [first, second, third] = positionals;
  const refuse = (message: string): number => {
    deps.err(deps.redact(message));
    return 2;
  };
  if (first === undefined) return refuse(BUG_USAGE);
  const verify = verifyCount(flags.verify);
  if (typeof verify === "object") return refuse(verify.error);
  const store = new BugStore(deps.bugsDir);

  if (first === "list") {
    deps.out(bugListText(store, deps.redact, flags.app));
    return 0;
  }
  if (first === "verify") {
    if (second === undefined || !isBugId(second)) return refuse(BUG_USAGE);
    if (deps.check === undefined) return refuse(NO_VERIFY);
    const found = store.locate(second);
    if (found === null) return refuse(`no bug ${second}; the bugs kept are in ${shownPath(store.base)}.`);
    const reproduced = await deps.check({ app: found.app, id: second, dir: found.stored.dir, finding: found.stored.finding, meta: found.stored.meta }, verify > 0 ? verify : 3, { reset: "own" });
    const meta = store.recordCheck(found.app, second, reproduced, deps.redact) ?? found.stored.meta;
    deps.out(deps.redact(reproducedAnswer({ meta }, true)));
    return exitOf(meta);
  }
  if (first === "export") return refuse(second === undefined ? BUG_USAGE : NO_EXPORT);
  if (isBugId(first) && second === undefined) {
    const found = store.locate(first);
    if (found === null) return refuse(`no bug ${first}; the bugs kept are in ${shownPath(store.base)}.`);
    deps.out(deps.redact([readFileSync(join(found.stored.dir, "report.md"), "utf8").trimEnd(), "", `Folder: ${shownPath(found.stored.dir)}`].join("\n")));
    return 0;
  }
  if (second === undefined || third !== undefined) return refuse(BUG_USAGE);
  if (verify > 0 && deps.check === undefined) return refuse(NO_VERIFY);

  const read = readRunFinding(first, second);
  if (!read.ok) return refuse(`${read.code}: ${read.message}`);
  try {
    const made = makeBug(contextOf(deps, store), {
      finding: read.finding,
      how: "explore",
      sourceKey: `${read.run}/${read.finding.id}`,
      run: read.run,
      script: read.script,
      picture: read.picture,
      withPicture: flags["with-picture"] === true,
      notChecked: read.finding.kind === "unreachable" ? "an unreachable place has no steps" : "no check was asked for",
    });
    let meta = made.meta;
    if (verify > 0 && deps.check !== undefined) {
      const reproduced = await deps.check({ app: made.finding.app, id: meta.id, dir: made.dir, finding: made.finding, meta }, verify, { reset: "own" });
      meta = store.recordCheck(made.finding.app, meta.id, reproduced, deps.redact) ?? meta;
    }
    deps.out(bugAnswer({ ...made, meta }, deps.redact, { reasonShown: true }));
    return exitOf(meta);
  } catch (error) {
    if (error instanceof BugGateError) return refuse(`bug report refused: ${error.message} Nothing was written.`);
    return refuse(`the bug report couldn't be made: ${error instanceof Error ? error.message : String(error)}`);
  }
}
