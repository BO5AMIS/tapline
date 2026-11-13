import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadAccounts } from "./accounts.js";
import { callTool, isToolName } from "./dispatch.js";
import type { CallAnswer, ScheduleHost } from "./runschedule.js";
import type { ProcResult, SchedRunner, Schedule, TaskEntry } from "./schedule.js";
import { createRuntime } from "./runtime.js";
import { runThinCall, type ThinCallIO } from "./thincall.js";

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

function thinIO(env: NodeJS.ProcessEnv): { io: ThinCallIO; out: string[] } {
  const ports: number[] = [];
  for (let port = 7210; port <= 7219; port++) ports.push(port);
  const out: string[] = [];
  return { out, io: { out: (t) => void out.push(t), err: () => undefined, env, ppid: process.pid, ports, address: "127.0.0.1" } };
}

/** One thin call to a running host: `null` when none could be reached (exit 3). */
async function thinCall(env: NodeJS.ProcessEnv, client: string, tool: string, args: Record<string, unknown>): Promise<CallAnswer | null> {
  const { io, out } = thinIO(env);
  const code = await runThinCall([tool, JSON.stringify(args), "--client", client, "--json"], io);
  if (code === 3) return null;
  try {
    const parsed = JSON.parse(out.join("")) as { text?: unknown };
    if (typeof parsed.text === "string") return { text: parsed.text, isError: code !== 0 };
  } catch {
    // a refusal or an unknown outcome has no answer
  }
  return { text: code === 1 ? "Error unknown_outcome: the call was sent but no answer came back." : "Error bad_params: the host refused the call.", isError: true };
}

/** A running `tapline host` the app is connected to, or null. Its policy and vault apply (they are fixed when it starts). */
async function runningHost(env: NodeJS.ProcessEnv, client: string): Promise<ScheduleHost | null> {
  const first = await thinCall(env, client, "apps", {});
  if (first === null) return null;
  return {
    via: "a running host",
    appOpen: async (waitMs) => {
      const until = Date.now() + waitMs;
      for (;;) {
        const answer = await thinCall(env, client, "apps", {});
        if (answer !== null && answer.text.startsWith("Connected apps:")) return true;
        if (Date.now() >= until) return false;
        await sleep(1000);
      }
    },
    inUse: () => false, // a busy answer from its control queue ends a call with `busy`, which the run waits out
    call: async (tool, args) => (await thinCall(env, client, tool, args)) ?? { text: "Error not_connected: the running host went away.", isError: true },
    close: async () => undefined,
  };
}

async function ownHost(schedule: Schedule, name: string, env: NodeJS.ProcessEnv): Promise<ScheduleHost> {
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

/** A host the app is connected to: a running one if there is one, else one of its own. */
export async function connectScheduleHost(schedule: Schedule, name: string, env: NodeJS.ProcessEnv = process.env): Promise<ScheduleHost> {
  const running = await runningHost(env, `schedule-${name}`);
  return running ?? (await ownHost(schedule, name, env));
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
