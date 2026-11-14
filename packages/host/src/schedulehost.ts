import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { configDir } from "./config.js";
import { loadAccounts } from "./accounts.js";
import { callTool, isToolName } from "./dispatch.js";
import { isBusyAnswer, type CallAnswer, type ScheduleHost } from "./runschedule.js";
import type { ProcResult, SchedRunner, Schedule, TaskEntry } from "./schedule.js";
import { canonicalPath, createRuntime, HOST_FACTS_TOOL, LEASE_TOOL, LEASE_TTL_MS, type HostFacts } from "./runtime.js";
import { runThinCall, type ThinCallIO } from "./thincall.js";
import { hashFile, hashMapsDir } from "./hostfacts.js";

/**
 * The real hosts behind `tapline run-schedule` (AGENT-TOOLS 1.14 §22.2): a `tapline host` that is already running with the app
 * connected (reached by the thin call, with its own policy and vault), else a host of its own that takes the schedule's
 * policy, accounts and maps. Not tested against a phone; runschedule.ts is tested with a fake host.
 */

/** The real `schtasks`/PowerShell runner: a program and its arguments, never a shell line; `env` adds to this process's. */
export const spawnSchedRunner: SchedRunner = (command, args, env) =>
  new Promise<ProcResult>((resolve) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", (error) => resolve({ code: 1, stdout: "", stderr: error.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
  });

/** What the Task Scheduler runs: this node, and the `tapline` entry (bin.js) that sits next to cli.js. */
export function realTaskEntry(): TaskEntry {
  return { exe: process.execPath, script: join(dirname(fileURLToPath(import.meta.url)), "bin.js") };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The host a run checked: its port and instance id, and the lease credential once the run holds the lease. Every later call carries all three. */
export interface ThinPin {
  port: number;
  instance?: string;
  lease?: string;
}

function thinIO(env: NodeJS.ProcessEnv, pin: ThinPin | undefined, signal: AbortSignal | undefined, onHost: (port: number) => void): { io: ThinCallIO; out: string[] } {
  const ports: number[] = [];
  for (let port = 7210; port <= 7219; port++) ports.push(port);
  const out: string[] = [];
  return {
    out,
    io: { out: (t) => void out.push(t), err: () => undefined, env, ppid: process.pid, ports, address: "127.0.0.1", onHost, ...(pin !== undefined ? { pin } : {}), ...(signal !== undefined ? { signal } : {}) },
  };
}

/** What a thin call answers, with the port of the host that took it (the first call of a run learns which host it is talking to). */
export type ThinAnswer = CallAnswer & { port?: number };

/** One thin call to a running host: `null` when none could be reached (exit 3). A pinned call goes to its port only. */
async function thinCall(env: NodeJS.ProcessEnv, client: string, tool: string, args: Record<string, unknown>, pin?: ThinPin, signal?: AbortSignal): Promise<ThinAnswer | null> {
  let port: number | undefined;
  const { io, out } = thinIO(env, pin, signal, (p) => void (port = p));
  const code = await runThinCall([tool, JSON.stringify(args), "--client", client, "--json"], io);
  if (code === 3) return null;
  try {
    const parsed = JSON.parse(out.join("")) as { text?: unknown };
    if (typeof parsed.text === "string") return { text: parsed.text, isError: code !== 0, ...(port !== undefined ? { port } : {}) };
  } catch {
    // a refusal or an unknown outcome has no answer
  }
  return { text: code === 1 ? "Error unknown_outcome: the call was sent but no answer came back." : "Error bad_params: the host refused the call.", isError: true, ...(port !== undefined ? { port } : {}) };
}

/** How the run talks to a running host: one thin call (null when no host could be reached). Replaced in tests. */
export type ThinCaller = (env: NodeJS.ProcessEnv, client: string, tool: string, args: Record<string, unknown>, pin?: ThinPin, signal?: AbortSignal) => Promise<ThinAnswer | null>;

const HEX = /^[0-9a-f]{16,128}$/;

function asFacts(text: string): HostFacts | null {
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== "object" || raw === null) return null;
    const { version, instance, policy, noPolicy, accounts, maps, policyHash, accountsHash, mapsHash } = raw as Record<string, unknown>;
    if (version !== 2 || typeof instance !== "string" || !HEX.test(instance) || typeof noPolicy !== "boolean" || typeof maps !== "string" || typeof mapsHash !== "string") return null;
    if ((policy !== null && typeof policy !== "string") || (accounts !== null && typeof accounts !== "string")) return null;
    if ((policyHash !== null && typeof policyHash !== "string") || (accountsHash !== null && typeof accountsHash !== "string")) return null;
    return { version: 2, instance, policy, noPolicy, accounts, maps, policyHash, accountsHash, mapsHash };
  } catch {
    return null;
  }
}

/** What a run compares the host's loaded hashes with: the files and the maps folder as they are now. Replaced in tests. */
export interface FactHasher {
  file(path: string): string | null;
  maps(dir: string): string;
}
const realHasher: FactHasher = { file: hashFile, maps: hashMapsDir };

/**
 * Why a running host can't carry this schedule, or null when it can (fail closed): the policy must be on and the same file as the
 * schedule's (both the built-in policy when the schedule names none), the accounts file and the maps folder the same, and what the host
 * LOADED must be what the files hold now: it reads its policy and accounts once, so a block word added since is not in force there.
 */
export function factsMismatch(schedule: Schedule, facts: HostFacts | null, env: NodeJS.ProcessEnv = process.env, hasher: FactHasher = realHasher): string | null {
  if (facts === null) return "its policy, accounts and maps can't be read";
  if (facts.noPolicy) return "it runs with --no-policy";
  const same = (wanted: string | null, had: string | null): boolean => (wanted === null ? had === null : had !== null && canonicalPath(wanted) === had);
  if (!same(schedule.policy, facts.policy)) return "it runs with another policy";
  if (!same(schedule.accounts, facts.accounts)) return "it runs with other accounts";
  const maps = schedule.maps ?? join(configDir(env), "maps");
  if (canonicalPath(maps) !== facts.maps) return "it keeps its maps in another folder";
  if (schedule.policy !== null) {
    const now = hasher.file(schedule.policy);
    if (now === null || facts.policyHash === null || now !== facts.policyHash) return "the policy file has changed since the host loaded it";
  }
  if (schedule.accounts !== null) {
    const now = hasher.file(schedule.accounts);
    if (now === null || facts.accountsHash === null || now !== facts.accountsHash) return "the accounts file has changed since the host loaded it";
  }
  if (hasher.maps(maps) !== facts.mapsHash) return "the maps have changed since the host loaded them";
  return null;
}

/** Every reach of the control lease and the facts goes through this. */
const LEASE_RENEW_MS = 15_000;

/** What a run reports when the phone was taken from it mid-run (§22.3: nothing further is run). */
export const LOST_TEXT = "Error lease_lost: the run lost the phone (the host's lease was not renewed, or the host changed); no further step was run.";

/**
 * A running `tapline host` the app is connected to: used only when its settings match the schedule's (`mismatch` says what
 * differs when they don't). The run pins the host it checked (its port and instance id) and sends them with every later call, so
 * a call can never reach another host with other settings; it holds the host's lease, by the credential the host gave it, while
 * it drives. A renewal that fails, or a lease that is lost, stops the run before its next step.
 */
async function runningHost(
  env: NodeJS.ProcessEnv,
  client: string,
  schedule: Schedule,
  thin: ThinCaller,
  hasher: FactHasher,
): Promise<{ host: ScheduleHost } | { host: null; mismatch: string | null }> {
  const first = await thin(env, client, "apps", {});
  if (first === null) return { host: null, mismatch: null };
  if (first.port === undefined) return { host: null, mismatch: "the host's port can't be told" };
  const port = first.port;
  const asked = await thin(env, client, HOST_FACTS_TOOL, {}, { port });
  const facts = asked === null || asked.isError ? null : asFacts(asked.text);
  const mismatch = factsMismatch(schedule, facts, env, hasher);
  if (mismatch !== null || facts === null) return { host: null, mismatch: mismatch ?? "its policy, accounts and maps can't be read" };
  const instance = facts.instance;
  let credential: string | undefined;
  const pinned = (): ThinPin => ({ port, instance, ...(credential !== undefined ? { lease: credential } : {}) });
  const lease = async (action: "acquire" | "renew" | "release"): Promise<boolean> => {
    const answer = await thin(env, client, LEASE_TOOL, { action, ttl_ms: LEASE_TTL_MS }, pinned());
    if (answer === null || answer.isError) return false;
    try {
      const body = JSON.parse(answer.text) as { ok?: unknown; credential?: unknown };
      if (body.ok !== true) return false;
      if (action === "acquire" && typeof body.credential === "string" && HEX.test(body.credential)) credential = body.credential;
      return action !== "acquire" || credential !== undefined;
    } catch {
      return false;
    }
  };
  let held = false;
  let lost = false;
  let beat: ReturnType<typeof setInterval> | undefined;
  let inflight: AbortController | undefined;
  const stopBeat = (): void => {
    if (beat !== undefined) clearInterval(beat);
    beat = undefined;
  };
  const drop = async (): Promise<void> => {
    stopBeat();
    if (!held) return;
    held = false;
    await lease("release");
    credential = undefined;
  };
  // A renewal that fails means the run no longer holds the phone: the call in flight is cut off (the host stops it before its next
  // step) and every later call answers that the run lost the phone.
  const lose = (): void => {
    if (lost) return;
    lost = true;
    stopBeat();
    inflight?.abort();
  };
  const renew = async (): Promise<void> => {
    if (lost || !held) return;
    if (!(await lease("renew"))) lose();
  };
  return {
    host: {
      via: "a running host",
      appOpen: async (waitMs) => {
        const until = Date.now() + waitMs;
        for (;;) {
          const answer = await thin(env, client, "apps", {}, pinned());
          if (answer !== null && answer.text.startsWith("Connected apps:")) return true;
          if (Date.now() >= until) return false;
          await sleep(1000);
        }
      },
      // In use while another agent or a person is on the phone: the run holds the host's lease from the moment it gets it.
      inUse: async () => {
        if (held) return false;
        held = await lease("acquire");
        if (held) {
          beat = setInterval(() => void renew(), LEASE_RENEW_MS);
          beat.unref();
        }
        return !held;
      },
      call: async (tool, args) => {
        if (lost) return { text: LOST_TEXT, isError: true };
        const mine = new AbortController();
        inflight = mine;
        let answer: CallAnswer;
        try {
          answer = (await thin(env, client, tool, args, pinned(), mine.signal)) ?? { text: "Error not_connected: the running host went away.", isError: true };
        } finally {
          if (inflight === mine) inflight = undefined;
        }
        // Another host answered at this port, or the lease went while the call ran: the run stops here, whatever the call said.
        if (lost || /^Error wrong_host:/.test(answer.text)) {
          lose();
          return { text: LOST_TEXT, isError: true };
        }
        // A person came back: give the phone up while the run waits, so other agents aren't held out for minutes.
        if (isBusyAnswer(answer)) await drop();
        return { text: answer.text, isError: answer.isError };
      },
      close: async () => {
        stopBeat();
        await drop();
      },
    },
  };
}

async function ownHost(schedule: Schedule, name: string, env: NodeJS.ProcessEnv, closedNote?: string): Promise<ScheduleHost> {
  const runtime = await createRuntime({
    env,
    screenshots: "file",
    ...(schedule.policy !== null ? { policy: schedule.policy } : {}),
    ...(schedule.accounts !== null ? { accounts: schedule.accounts } : {}),
    ...(schedule.maps !== null ? { maps: schedule.maps } : {}),
    log: () => undefined,
  });
  const tools = runtime.toolsFor(`schedule-${name}`);
  return {
    via: "its own host",
    ...(closedNote !== undefined ? { closedNote } : {}),
    appOpen: async (waitMs) => {
      const until = Date.now() + waitMs;
      while (runtime.host.current() === undefined && Date.now() < until) await sleep(250);
      return runtime.host.current() !== undefined;
    },
    inUse: () => runtime.phoneInUse(),
    call: async (tool, args) => {
      if (!isToolName(tool)) return { text: `Error bad_params: no tool ${tool}.`, isError: true };
      const result = await tools.withCall(new AbortController().signal, () => callTool(tools, tool, args));
      return { text: result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n"), isError: result.isError === true };
    },
    close: () => runtime.close(),
  };
}

export interface ConnectDeps {
  thin?: ThinCaller;
  /** Tests: how the files are hashed for the comparison with what the host loaded. */
  hasher?: FactHasher;
  own?: (schedule: Schedule, name: string, env: NodeJS.ProcessEnv, closedNote?: string) => Promise<ScheduleHost>;
}

/**
 * A host the app is connected to: a running one whose policy, accounts and maps are the schedule's; else one of its own that takes
 * the schedule's files. A running host that differs (or can't say) is never used: the run starts its own, and when the app
 * doesn't connect to it the run skips and says the running host differed.
 */
export async function connectScheduleHost(schedule: Schedule, name: string, env: NodeJS.ProcessEnv = process.env, deps: ConnectDeps = {}): Promise<ScheduleHost> {
  const running = await runningHost(env, `schedule-${name}`, schedule, deps.thin ?? thinCall, deps.hasher ?? realHasher);
  if (running.host !== null) return running.host;
  const own = deps.own ?? ownHost;
  return running.mismatch === null ? await own(schedule, name, env) : await own(schedule, name, env, `the running host differs from the schedule: ${running.mismatch}`);
}

/** The vault's redaction for a schedule's report: the accounts file the schedule names, else nothing to scrub. */
export async function redactorFor(schedule: Schedule): Promise<(text: string) => string> {
  if (schedule.accounts === null) return (text) => text;
  try {
    const loaded = await loadAccounts(schedule.accounts);
    return loaded.store === null ? (text) => text : (text) => loaded.store.redact(text);
  } catch {
    return (text) => text;
  }
}
