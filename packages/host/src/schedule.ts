import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

/**
 * AGENT-TOOLS 1.14 §22.1: the schedule file and `tapline schedule add|list|remove`. One file per schedule in
 * `~/.tapline/schedules/<name>.json`; on Windows each schedule is a Task Scheduler task that wakes the PC and runs
 * `tapline run-schedule <name>`. The task is registered through an injected runner, so a test sees the exact command.
 */

export const SCHEDULE_NAME = /^[A-Za-z0-9][\w.-]{0,60}$/;
const VARIABLE = /^[A-Za-z_]\w*$/;

const nullablePath = z.string().min(1).nullable().optional();

export const scheduleSchema = z
  .object({
    version: z.literal(1),
    tool: z.string(),
    route: z.string().regex(SCHEDULE_NAME, "route is a saved route's name"),
    with: z.record(z.string(), z.string()).optional(),
    at: z.string().nullable().optional(),
    trigger: z.union([z.object({ file: z.string().min(1) }).strict(), z.object({ notification: z.string().min(1) }).strict()]).nullable().optional(),
    policy: nullablePath,
    accounts: nullablePath,
    maps: nullablePath,
  })
  .passthrough();

export interface Schedule {
  version: 1;
  tool: "tapline";
  route: string;
  with: Record<string, string>;
  at: string | null;
  trigger: { file: string } | null;
  policy: string | null;
  accounts: string | null;
  maps: string | null;
}

export function schedulesDir(configDir: string): string {
  return join(configDir, "schedules");
}

export function schedulePath(configDir: string, name: string): string {
  return join(schedulesDir(configDir), `${name}.json`);
}

// -- `at`

export type ParsedAt =
  | { kind: "daily" | "weekdays"; hour: number; minute: number }
  | { kind: "once"; date: Date };

const RECURRING = /^(\d{1,2}):(\d{2}) (daily|weekdays)$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

/** `HH:MM daily`, `HH:MM weekdays` or an ISO date-time (a single run; no zone means this computer's time). Null when it is none of them. */
export function parseAt(raw: string): ParsedAt | null {
  const recurring = RECURRING.exec(raw.trim());
  if (recurring !== null) {
    const hour = Number(recurring[1]);
    const minute = Number(recurring[2]);
    if (hour > 23 || minute > 59) return null;
    return { kind: recurring[3] as "daily" | "weekdays", hour, minute };
  }
  const text = raw.trim();
  if (!ISO_TIME.test(text)) return null;
  // The text is checked as a calendar date and a clock time: the Date constructor rolls 2026-02-30 over to March 2.
  const [year, month, day, hour, minute, second] = [text.slice(0, 4), text.slice(5, 7), text.slice(8, 10), text.slice(11, 13), text.slice(14, 16), text.slice(17, 19) || "0"].map(Number) as [number, number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : { kind: "once", date };
}

const two = (n: number): string => String(n).padStart(2, "0");

export function clock24(at: { hour: number; minute: number }): string {
  return `${two(at.hour)}:${two(at.minute)}`;
}

/** A date as this computer's local `yyyy-MM-ddTHH:mm:ss`, the form the task registration reads. */
export function localIso(date: Date): string {
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

// -- the file

export type ReadResult = { ok: true; schedule: Schedule } | { ok: false; message: string };

/** Reads and checks a schedule file. A relative `policy`, `accounts`, `maps` or trigger folder is relative to the file's folder. */
export function readScheduleFile(path: string): ReadResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { ok: false, message: `couldn't read ${path}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, message: `${path} isn't JSON` };
  }
  const parsed = scheduleSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, message: `${path} isn't a schedule (version 1): ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`.trim() };
  }
  const file = parsed.data;
  if (file.tool !== "tapline") return { ok: false, message: `${path} is a ${JSON.stringify(file.tool)} schedule; tapline runs only its own (tool "tapline").` };
  const at = file.at ?? null;
  const trigger = file.trigger ?? null;
  if ((at === null) === (trigger === null)) return { ok: false, message: `${path} must set exactly one of "at" and "trigger".` };
  if (trigger !== null && "notification" in trigger) {
    return { ok: false, message: `${path} starts on a notification, which only Tapwright can see; tapline has no notification trigger.` };
  }
  if (at !== null && parseAt(at) === null) {
    return { ok: false, message: `${path}: "at" is HH:MM daily, HH:MM weekdays or an ISO date-time, not ${JSON.stringify(at)}.` };
  }
  const base = dirname(path);
  const own = (value: string | null | undefined): string | null => (value == null ? null : isAbsolute(value) ? value : resolve(base, value));
  return {
    ok: true,
    schedule: {
      version: 1,
      tool: "tapline",
      route: file.route,
      with: file.with ?? {},
      at,
      trigger: trigger !== null && "file" in trigger ? { file: own(trigger.file) as string } : null,
      policy: own(file.policy),
      accounts: own(file.accounts),
      maps: own(file.maps),
    },
  };
}

/** The file as it is written: the spec's key order, `null` for what is unset. */
export function scheduleText(schedule: Schedule): string {
  return `${JSON.stringify(
    {
      version: 1,
      tool: "tapline",
      route: schedule.route,
      with: schedule.with,
      at: schedule.at,
      trigger: schedule.trigger,
      policy: schedule.policy,
      accounts: schedule.accounts,
      maps: schedule.maps,
    },
    null,
    2,
  )}\n`;
}

/**
 * `@file` values (§22.1) become the text of that file, read when a run starts; a relative path is relative to the schedule file's
 * folder. One trailing line ending is dropped (a caption file ends its last line, and that is not part of the caption).
 */
export function resolveWith(values: Record<string, string>, scheduleFolder: string): { ok: true; values: Record<string, string> } | { ok: false; message: string } {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!value.startsWith("@") || value.length === 1) {
      out[key] = value;
      continue;
    }
    const file = isAbsolute(value.slice(1)) ? value.slice(1) : resolve(scheduleFolder, value.slice(1));
    try {
      out[key] = readFileSync(file, "utf8").replace(/\r?\n$/, "");
    } catch {
      return { ok: false, message: `${key}: couldn't read ${value} (${file})` };
    }
  }
  return { ok: true, values: out };
}

// -- the Windows task

export interface ProcResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a program with arguments (never a shell line) and extra environment variables; the registration passes every user value in the environment. */
export type SchedRunner = (command: string, args: string[], env: Record<string, string>) => Promise<ProcResult>;

export function taskName(name: string): string {
  return `Tapline schedule ${name}`;
}

const PS_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"] as const;

/**
 * The registration script. It is a constant: the name, the paths and the time reach it as environment variables, never as text
 * built into the script. The settings' `WakeToRun` is what wakes the PC, set for the time
 * schedules only. A file trigger has no Task Scheduler form, so its task fires every minute and `run-schedule --check-trigger` runs
 * only when a new file has appeared; it never wakes the PC (a laptop would never sleep).
 */
export const REGISTER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$inv = [cultureinfo]::InvariantCulture",
  "$action = New-ScheduledTaskAction -Execute $env:TAPLINE_TASK_EXE -Argument ('\"' + $env:TAPLINE_TASK_SCRIPT + '\" run-schedule ' + $env:TAPLINE_TASK_NAME + $env:TAPLINE_TASK_SUFFIX)",
  "switch ($env:TAPLINE_TASK_KIND) {",
  "  'daily' { $trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::ParseExact($env:TAPLINE_TASK_AT, 'HH:mm', $inv)) }",
  "  'weekdays' { $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At ([datetime]::ParseExact($env:TAPLINE_TASK_AT, 'HH:mm', $inv)) }",
  "  'once' { $trigger = New-ScheduledTaskTrigger -Once -At ([datetime]::ParseExact($env:TAPLINE_TASK_AT, 'yyyy-MM-ddTHH:mm:ss', $inv)) }",
  "  'watch' { $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650) }",
  "  default { throw 'unknown trigger kind' }",
  "}",
  "$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)",
  "if ($env:TAPLINE_TASK_KIND -ne 'watch') { $settings.WakeToRun = $true }",
  "Register-ScheduledTask -TaskName $env:TAPLINE_TASK_FULL -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null",
].join("\n");

export const UNREGISTER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "if (Get-ScheduledTask -TaskName $env:TAPLINE_TASK_FULL -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $env:TAPLINE_TASK_FULL -Confirm:$false }",
].join("\n");

export interface TaskEntry {
  /** The node program that runs the CLI. */
  exe: string;
  /** The CLI's script (bin.js). */
  script: string;
}

export function registerCall(entry: TaskEntry, name: string, schedule: Schedule): { command: string; args: string[]; env: Record<string, string> } {
  const at = schedule.at === null ? null : parseAt(schedule.at);
  const kind = schedule.trigger !== null || at === null ? "watch" : at.kind;
  const when =
    at === null ? "" : at.kind === "once" ? localIso(at.date) : clock24(at);
  return {
    command: "powershell.exe",
    args: [...PS_ARGS, REGISTER_SCRIPT],
    env: {
      TAPLINE_TASK_EXE: entry.exe,
      TAPLINE_TASK_SCRIPT: entry.script,
      TAPLINE_TASK_NAME: name,
      TAPLINE_TASK_SUFFIX: kind === "watch" ? " --check-trigger" : "",
      TAPLINE_TASK_KIND: kind,
      TAPLINE_TASK_AT: when,
      TAPLINE_TASK_FULL: taskName(name),
    },
  };
}

export function unregisterCall(name: string): { command: string; args: string[]; env: Record<string, string> } {
  return { command: "powershell.exe", args: [...PS_ARGS, UNREGISTER_SCRIPT], env: { TAPLINE_TASK_FULL: taskName(name) } };
}

// -- file trigger state

export function triggerStatePath(configDir: string, name: string): string {
  return join(schedulesDir(configDir), `${name}.seen`);
}

/** The files in a folder that appeared after `sinceMs` (by modified time), oldest first, and the newest time seen. Dotfiles are left out. */
export function newFilesSince(folder: string, sinceMs: number): { files: string[]; newest: number } {
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return { files: [], newest: sinceMs };
  }
  const found: Array<{ name: string; t: number }> = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    try {
      const s = statSync(join(folder, name));
      if (s.isFile() && s.mtimeMs > sinceMs) found.push({ name, t: s.mtimeMs });
    } catch {
      // gone meanwhile
    }
  }
  found.sort((a, b) => a.t - b.t);
  return { files: found.map((f) => f.name), newest: found.reduce((m, f) => Math.max(m, f.t), sinceMs) };
}

export function readSeen(configDir: string, name: string): number | null {
  try {
    const n = Number(readFileSync(triggerStatePath(configDir, name), "utf8").trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function writeSeen(configDir: string, name: string, t: number): void {
  try {
    mkdirSync(schedulesDir(configDir), { recursive: true });
    writeFileSync(triggerStatePath(configDir, name), String(t));
  } catch {
    // the next check sees the same files again; a run is never lost for it
  }
}

// -- commands

export interface ScheduleDeps {
  configDir: string;
  platform: NodeJS.Platform;
  now: () => Date;
  cwd: string;
  run: SchedRunner;
  entry: TaskEntry;
}

export interface AddOptions {
  route: string | undefined;
  name?: string | undefined;
  at?: string | undefined;
  with?: string[] | undefined;
  onFile?: string | undefined;
  onNotification?: string | undefined;
  policy?: string | undefined;
  accounts?: string | undefined;
  maps?: string | undefined;
}

type Outcome = { text: string; code: number };

const bad = (text: string): Outcome => ({ text, code: 2 });

const ADD_USAGE =
  'Usage: tapline schedule add <route> --at "09:00 daily" [--with caption=@captions.txt] [--name NAME] [--policy FILE] [--accounts FILE] [--maps DIR]\n' +
  "       tapline schedule add <route> --on-file FOLDER ...";

/** `tapline schedule add`: writes the file, then registers the task. A task that can't be registered leaves no file. */
export async function scheduleAdd(options: AddOptions, deps: ScheduleDeps): Promise<Outcome> {
  if (options.route === undefined) return bad(ADD_USAGE);
  const route = options.route;
  if (!SCHEDULE_NAME.test(route)) return bad(`"${route}" isn't a route's name (letters, digits, '.', '_' and '-').`);
  const name = options.name ?? route;
  if (!SCHEDULE_NAME.test(name)) return bad(`"${name}" isn't a schedule's name (letters, digits, '.', '_' and '-').`);
  if (options.onNotification !== undefined) {
    return bad("A notification trigger is Tapwright's: only tapwright schedule add --on-notification can see another app's notifications. Tapline starts on a time (--at) or on a file (--on-file).");
  }
  if ((options.at === undefined) === (options.onFile === undefined)) return bad(`Give exactly one of --at and --on-file.\n${ADD_USAGE}`);
  let at: string | null = null;
  if (options.at !== undefined) {
    const parsed = parseAt(options.at);
    if (parsed === null) return bad(`--at is "HH:MM daily", "HH:MM weekdays" or an ISO date-time like 2026-11-20T09:00, not ${JSON.stringify(options.at)}.`);
    if (parsed.kind === "once" && parsed.date.getTime() <= deps.now().getTime()) return bad(`--at ${options.at} has already passed; a single run needs a time to come.`);
    at = options.at.trim();
  }
  const values: Record<string, string> = {};
  for (const pair of options.with ?? []) {
    const eq = pair.indexOf("=");
    const key = eq < 1 ? "" : pair.slice(0, eq);
    if (!VARIABLE.test(key)) return bad(`--with is name=value, with a variable name of letters, digits and '_', not ${JSON.stringify(pair)}.`);
    if (key in values) return bad(`--with ${key} is given twice.`);
    values[key] = pair.slice(eq + 1);
  }
  const absolute = (given: string): string => resolve(deps.cwd, given);
  const policy = options.policy === undefined ? null : absolute(options.policy);
  const accounts = options.accounts === undefined ? null : absolute(options.accounts);
  const maps = options.maps === undefined ? null : absolute(options.maps);
  if (policy !== null && !existsSync(policy)) return bad(`--policy ${policy} doesn't exist.`);
  if (accounts !== null && !existsSync(accounts)) return bad(`--accounts ${accounts} doesn't exist.`);
  const folder = options.onFile === undefined ? null : absolute(options.onFile);
  if (folder !== null && !existsSync(folder)) return bad(`--on-file ${folder} isn't a folder that exists.`);

  const path = schedulePath(deps.configDir, name);
  if (existsSync(path)) return bad(`There is already a schedule "${name}". Remove it first: tapline schedule remove ${name}`);
  const schedule: Schedule = { version: 1, tool: "tapline", route, with: values, at, trigger: folder === null ? null : { file: folder }, policy, accounts, maps };
  const notes: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (!value.startsWith("@") || value.length === 1) continue;
    const file = isAbsolute(value.slice(1)) ? value.slice(1) : resolve(schedulesDir(deps.configDir), value.slice(1));
    if (!existsSync(file)) notes.push(`Note: ${key} reads ${file} when the run starts, and it isn't there yet.`);
  }
  const when = at ?? `when a file appears in ${folder}`;
  if (deps.platform !== "win32") {
    // 1.14 says nothing about how another system starts a schedule; the file is saved and run-schedule is the way in.
    writeSchedule(path, schedule);
    if (folder !== null) writeSeen(deps.configDir, name, deps.now().getTime());
    return {
      text: [
        `Saved the schedule "${name}" (${when}) in ${path}.`,
        `Tapline starts schedules itself only on Windows (AGENT-TOOLS 1.14 §22.1 doesn't say how another system does). It is not scheduled on this one: start it from the system's own scheduler (cron, launchd) with: tapline run-schedule ${name}`,
        ...notes,
      ].join("\n"),
      code: 0,
    };
  }
  writeSchedule(path, schedule);
  if (folder !== null) writeSeen(deps.configDir, name, deps.now().getTime());
  const call = registerCall(deps.entry, name, schedule);
  const done = await deps.run(call.command, call.args, call.env).catch((error: unknown): ProcResult => ({ code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));
  if (done.code !== 0) {
    rmSync(path, { force: true });
    rmSync(triggerStatePath(deps.configDir, name), { force: true });
    return { text: `Couldn't register the Task Scheduler task for "${name}": ${firstLine(done.stderr || done.stdout)}\nNo schedule was saved.`, code: 1 };
  }
  return {
    text: [
      `Scheduled "${name}": route ${route}, ${when}. Windows Task Scheduler runs it and wakes the PC (task "${taskName(name)}"); the file is ${path}.`,
      `The phone's app must be open when it runs, or the run is skipped (tapline run-schedule ${name} runs it now).`,
      ...notes,
    ].join("\n"),
    code: 0,
  };
}

function writeSchedule(path: string, schedule: Schedule): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, scheduleText(schedule), { mode: 0o600 });
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0] ?? "";
}

/** `tapline schedule list`: one line per schedule. */
export function scheduleList(configDir: string): Outcome {
  const dir = schedulesDir(configDir);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    names = [];
  }
  if (names.length === 0) return { text: "No schedules. Add one: tapline schedule add <route> --at \"09:00 daily\"", code: 0 };
  const lines: string[] = [];
  for (const file of names.sort()) {
    const name = file.slice(0, -".json".length);
    const read = readScheduleFile(join(dir, file));
    if (!read.ok) {
      lines.push(`${name}: unreadable: ${read.message}`);
      continue;
    }
    const s = read.schedule;
    const variables = Object.keys(s.with);
    lines.push(
      `${name}: route ${s.route}, ${s.at ?? `when a file appears in ${s.trigger?.file ?? "?"}`}` +
        (variables.length > 0 ? `; with ${variables.join(", ")}` : "") +
        (s.policy !== null ? `; policy ${s.policy}` : "") +
        (s.accounts !== null ? `; accounts ${s.accounts}` : "") +
        (s.maps !== null ? `; maps ${s.maps}` : ""),
    );
  }
  return { text: lines.join("\n"), code: 0 };
}

/** `tapline schedule remove NAME`: unregisters the task, then deletes the file. A task that is already gone is not an error. */
export async function scheduleRemove(name: string | undefined, deps: ScheduleDeps): Promise<Outcome> {
  if (name === undefined) return bad("Usage: tapline schedule remove NAME");
  if (!SCHEDULE_NAME.test(name)) return bad(`"${name}" isn't a schedule's name.`);
  const path = schedulePath(deps.configDir, name);
  const exists = existsSync(path);
  if (!exists && deps.platform !== "win32") return { text: `No schedule "${name}".`, code: 1 };
  if (deps.platform === "win32") {
    const call = unregisterCall(name);
    const done = await deps.run(call.command, call.args, call.env).catch((error: unknown): ProcResult => ({ code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));
    if (done.code !== 0) return { text: `Couldn't remove the Task Scheduler task for "${name}": ${firstLine(done.stderr || done.stdout)}\nThe schedule file stays, so you can try again.`, code: 1 };
    if (!exists) return { text: `No schedule file "${name}"; its Task Scheduler task, if there was one, is removed.`, code: 1 };
  }
  rmSync(path, { force: true });
  rmSync(triggerStatePath(deps.configDir, name), { force: true });
  return { text: `Removed the schedule "${name}"${deps.platform === "win32" ? " and its Task Scheduler task" : ""}.`, code: 0 };
}
