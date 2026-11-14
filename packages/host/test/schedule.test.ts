import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  REGISTER_SCRIPT,
  UNREGISTER_SCRIPT,
  newFilesSince,
  parseAt,
  readScheduleFile,
  resolveWith,
  scheduleAdd,
  scheduleList,
  scheduleRemove,
  schedulePath,
  type ProcResult,
  type ScheduleDeps,
} from "../src/schedule.js";

// AGENT-TOOLS 1.14 §22.1: the schedule file, `schedule add|list|remove` and the Task Scheduler call (never a real task: a fake runner).

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "tapline-schedule-"));
  dirs.push(dir);
  return dir;
};

const NOW = new Date(2026, 10, 14, 8, 0, 0);
type Call = { command: string; args: string[]; env: Record<string, string> };

function rig(platform: NodeJS.Platform = "win32", result: ProcResult = { code: 0, stdout: "", stderr: "" }): { deps: ScheduleDeps; calls: Call[]; dir: string; cwd: string } {
  const dir = tmp();
  const cwd = tmp();
  const calls: Call[] = [];
  const deps: ScheduleDeps = {
    configDir: dir,
    platform,
    now: () => NOW,
    cwd,
    run: async (command, args, env) => {
      calls.push({ command, args, env });
      return result;
    },
    entry: { exe: "C:\\Program Files\\nodejs\\node.exe", script: "C:\\Users\\me\\npm\\node_modules\\tapline-host\\dist\\bin.js" },
  };
  return { deps, calls, dir, cwd };
}

describe("parseAt", () => {
  it("reads the three forms of §22.1", () => {
    expect(parseAt("09:00 daily")).toEqual({ kind: "daily", hour: 9, minute: 0 });
    expect(parseAt("7:30 weekdays")).toEqual({ kind: "weekdays", hour: 7, minute: 30 });
    const once = parseAt("2026-11-20T09:00:00Z");
    expect(once?.kind).toBe("once");
    expect(parseAt("2026-11-20T09:00")?.kind).toBe("once");
    expect(parseAt("2028-02-29T09:00")?.kind).toBe("once"); // a leap day is real
    expect(parseAt("2026-12-31T23:59:59Z")?.kind).toBe("once");
  });
  it("refuses anything else", () => {
    for (const bad of ["25:00 daily", "09:60 daily", "09:00", "09:00 weekly", "tomorrow", "2026-11-20", "2026-13-40T99:00", "2026-02-30T09:00", "2026-04-31T09:00", "2025-02-29T09:00", "2026-11-20T24:00", "2026-11-20T09:60", "2026-11-20T09:00:60", "2026-00-10T09:00", "2026-11-00T09:00"]) expect(parseAt(bad)).toBeNull();
  });
});

describe("schedule add", () => {
  it("writes the file in the spec's format with absolute paths and registers one wake-to-run task", async () => {
    const { deps, calls, dir, cwd } = rig();
    writeFileSync(join(cwd, "policy.json"), "{}");
    writeFileSync(join(cwd, "vault.json"), "{}");
    const done = await scheduleAdd(
      { route: "post_update", at: "09:00 daily", with: ["caption=@captions.txt", "tag=morning"], policy: "policy.json", accounts: "vault.json", maps: "maps" },
      deps,
    );
    expect(done.code).toBe(0);
    const file = JSON.parse(readFileSync(schedulePath(dir, "post_update"), "utf8"));
    expect(file).toEqual({
      version: 1,
      tool: "tapline",
      route: "post_update",
      with: { caption: "@captions.txt", tag: "morning" },
      at: "09:00 daily",
      trigger: null,
      policy: join(cwd, "policy.json"),
      accounts: join(cwd, "vault.json"),
      maps: join(cwd, "maps"),
    });
    expect(Object.keys(file)).toEqual(["version", "tool", "route", "with", "at", "trigger", "policy", "accounts", "maps"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", REGISTER_SCRIPT],
      env: {
        TAPLINE_TASK_EXE: "C:\\Program Files\\nodejs\\node.exe",
        TAPLINE_TASK_SCRIPT: "C:\\Users\\me\\npm\\node_modules\\tapline-host\\dist\\bin.js",
        TAPLINE_TASK_NAME: "post_update",
        TAPLINE_TASK_SUFFIX: "",
        TAPLINE_TASK_KIND: "daily",
        TAPLINE_TASK_AT: "09:00",
        TAPLINE_TASK_FULL: "Tapline schedule post_update",
      },
    });
    // time schedules wake the PC; the once-a-minute file check never does (a laptop with a file trigger could not stay asleep)
    expect(REGISTER_SCRIPT).not.toMatch(/SettingsSet[^\n]*-WakeToRun/);
    expect(REGISTER_SCRIPT).toContain("if ($env:TAPLINE_TASK_KIND -ne 'watch') { $settings.WakeToRun = $true }");
    expect(REGISTER_SCRIPT).toContain("Register-ScheduledTask");
  });

  it("the success message says which one happens: a time schedule wakes the PC, a file trigger does not (PR 12 CodeRabbit)", async () => {
    const { deps, cwd } = rig();
    mkdirSync(join(cwd, "inbox"));
    const timed = await scheduleAdd({ route: "r", name: "timed", at: "09:00 daily" }, deps);
    expect(timed.text).toMatch(/wakes the PC to run it/);
    expect(timed.text).not.toMatch(/does not wake/);
    const watch = await scheduleAdd({ route: "r", name: "watch", onFile: "inbox" }, deps);
    expect(watch.text).toMatch(/checks the folder every minute and does not wake the PC/);
    expect(watch.text).not.toMatch(/wakes the PC to run it/);
  });

  it("the docs say the same: time schedules wake the PC, file-trigger checks do not", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    for (const file of ["README.md", join("docs", "setup.md"), join("packages", "host", "src", "schedule.ts")]) {
      const text = readFileSync(join(root, file), "utf8");
      expect(text, file).not.toMatch(/Task Scheduler task that wakes the PC and runs/);
      expect(text, file).toMatch(/does not wake the PC|never wakes the PC/);
    }
  });

  it("passes no user value through the script text: it is a constant and the values ride in the environment", async () => {
    const { deps, calls } = rig();
    await scheduleAdd({ route: "r", name: "n'; calc; '", at: "09:00 daily" }, deps);
    expect(calls).toHaveLength(0); // a name with quotes isn't a name at all
    const ok = await scheduleAdd({ route: "r", name: "my.name-1", at: "07:15 weekdays" }, deps);
    expect(ok.code).toBe(0);
    expect(calls[0]?.args[5]).toBe(REGISTER_SCRIPT);
    expect(calls[0]?.args.join(" ")).not.toContain("my.name-1");
    expect(calls[0]?.env["TAPLINE_TASK_KIND"]).toBe("weekdays");
    expect(calls[0]?.env["TAPLINE_TASK_AT"]).toBe("07:15");
  });

  it("a single run registers its local time; a file trigger registers a one-minute check", async () => {
    const { deps, calls, cwd } = rig();
    await scheduleAdd({ route: "once", at: "2026-11-20T09:30:00" }, deps);
    expect(calls[0]?.env["TAPLINE_TASK_KIND"]).toBe("once");
    expect(calls[0]?.env["TAPLINE_TASK_AT"]).toBe("2026-11-20T09:30:00");
    mkdirSync(join(cwd, "inbox"));
    const watch = await scheduleAdd({ route: "inbox_route", name: "inbox", onFile: "inbox" }, deps);
    expect(watch.code).toBe(0);
    expect(calls[1]?.env["TAPLINE_TASK_KIND"]).toBe("watch");
    expect(calls[1]?.env["TAPLINE_TASK_SUFFIX"]).toBe(" --check-trigger");
    expect(calls[1]?.env["TAPLINE_TASK_NAME"]).toBe("inbox");
  });

  it("a file trigger is saved as an absolute folder; the name defaults to the route's", async () => {
    const { deps, dir, cwd } = rig();
    mkdirSync(join(cwd, "drop"));
    await scheduleAdd({ route: "r1", onFile: "drop" }, deps);
    expect(JSON.parse(readFileSync(schedulePath(dir, "r1"), "utf8"))).toMatchObject({ at: null, trigger: { file: join(cwd, "drop") } });
  });

  it("refuses a notification trigger as Tapwright's, and leaves nothing behind", async () => {
    const { deps, calls, dir } = rig();
    const done = await scheduleAdd({ route: "r", onNotification: "com.instagram.ios" }, deps);
    expect(done.code).toBe(2);
    expect(done.text).toContain("Tapwright's");
    expect(calls).toHaveLength(0);
    expect(existsSync(schedulePath(dir, "r"))).toBe(false);
  });

  it("needs exactly one of --at and --on-file, a good time, and good --with pairs", async () => {
    const { deps, calls } = rig();
    expect((await scheduleAdd({ route: "r" }, deps)).code).toBe(2);
    expect((await scheduleAdd({ route: "r", at: "09:00 daily", onFile: "." }, deps)).code).toBe(2);
    expect((await scheduleAdd({ route: "r", at: "whenever" }, deps)).text).toContain("--at");
    expect((await scheduleAdd({ route: "r", at: "2026-11-01T09:00:00" }, deps)).text).toContain("already passed");
    expect((await scheduleAdd({ route: "r", at: "09:00 daily", with: ["nokey"] }, deps)).text).toContain("--with");
    expect((await scheduleAdd({ route: "r", at: "09:00 daily", with: ["a=1", "a=2"] }, deps)).text).toContain("twice");
    expect((await scheduleAdd({ route: undefined, at: "09:00 daily" }, deps)).text).toContain("Usage");
    expect((await scheduleAdd({ route: "r", at: "09:00 daily", policy: "missing.json" }, deps)).text).toContain("doesn't exist");
    expect(calls).toHaveLength(0);
  });

  it("refuses a second schedule of the same name", async () => {
    const { deps, calls } = rig();
    await scheduleAdd({ route: "r", at: "09:00 daily" }, deps);
    const again = await scheduleAdd({ route: "r", at: "10:00 daily" }, deps);
    expect(again.code).toBe(2);
    expect(again.text).toContain("already a schedule");
    expect(calls).toHaveLength(1);
  });

  it("keeps no file when Task Scheduler refuses the task", async () => {
    const { deps, dir } = rig("win32", { code: 1, stdout: "", stderr: "Register-ScheduledTask : Access is denied.\nmore" });
    const done = await scheduleAdd({ route: "r", at: "09:00 daily" }, deps);
    expect(done.code).toBe(1);
    expect(done.text).toContain("Access is denied.");
    expect(done.text).toContain("No schedule was saved.");
    expect(existsSync(schedulePath(dir, "r"))).toBe(false);
  });

  it("on another system saves the file, registers nothing and says how to start it", async () => {
    const { deps, calls, dir } = rig("darwin");
    const done = await scheduleAdd({ route: "r", at: "09:00 daily" }, deps);
    expect(done.code).toBe(0);
    expect(done.text).toContain("only on Windows");
    expect(done.text).toContain("tapline run-schedule r");
    expect(calls).toHaveLength(0);
    expect(existsSync(schedulePath(dir, "r"))).toBe(true);
  });

  it("notes an @file value that isn't there yet", async () => {
    const { deps } = rig();
    const done = await scheduleAdd({ route: "r", at: "09:00 daily", with: ["caption=@captions.txt"] }, deps);
    expect(done.text).toContain("captions.txt");
    expect(done.text).toContain("isn't there yet");
  });
});

describe("schedule list and remove", () => {
  it("lists what is saved, and says so when nothing is", async () => {
    const { deps, dir } = rig();
    expect(scheduleList(dir).text).toContain("No schedules");
    await scheduleAdd({ route: "post_update", at: "09:00 daily", with: ["caption=@c.txt"] }, deps);
    writeFileSync(join(dir, "schedules", "broken.json"), "{ nope");
    const text = scheduleList(dir).text;
    expect(text).toContain("post_update: route post_update, 09:00 daily; with caption");
    expect(text).toContain("broken: unreadable");
  });

  it("removes the task, then the file", async () => {
    const { deps, calls, dir } = rig();
    await scheduleAdd({ route: "r", at: "09:00 daily" }, deps);
    calls.length = 0;
    const done = await scheduleRemove("r", deps);
    expect(done.code).toBe(0);
    expect(calls).toEqual([
      {
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", UNREGISTER_SCRIPT],
        env: { TAPLINE_TASK_FULL: "Tapline schedule r" },
      },
    ]);
    expect(existsSync(schedulePath(dir, "r"))).toBe(false);
  });

  it("keeps the file when the task can't be removed, so it can be tried again", async () => {
    const { deps, dir } = rig();
    await scheduleAdd({ route: "r", at: "09:00 daily" }, deps);
    const failing: ScheduleDeps = { ...deps, run: async () => ({ code: 1, stdout: "", stderr: "denied" }) };
    const done = await scheduleRemove("r", failing);
    expect(done.code).toBe(1);
    expect(existsSync(schedulePath(dir, "r"))).toBe(true);
  });

  it("an unknown name is an error; a bad name never reaches the runner", async () => {
    const { deps, calls } = rig("darwin");
    expect((await scheduleRemove("nope", deps)).code).toBe(1);
    expect((await scheduleRemove("a b", deps)).code).toBe(2);
    expect((await scheduleRemove(undefined, deps)).code).toBe(2);
    expect(calls).toHaveLength(0);
  });
});

describe("the schedule file", () => {
  it("round-trips through add and read, with a relative path resolved against the file's folder", () => {
    const dir = tmp();
    const path = join(dir, "s.json");
    writeFileSync(path, JSON.stringify({ version: 1, tool: "tapline", route: "r", with: { a: "b" }, at: "09:00 daily", trigger: null, policy: "p.json", accounts: null }));
    const read = readScheduleFile(path);
    expect(read).toEqual({
      ok: true,
      schedule: { version: 1, tool: "tapline", route: "r", with: { a: "b" }, at: "09:00 daily", trigger: null, policy: join(dir, "p.json"), accounts: null, maps: null },
    });
  });

  it("refuses another tool's schedule, a notification trigger, both or neither of at and trigger, and a bad time", () => {
    const dir = tmp();
    const write = (body: Record<string, unknown>): string => {
      const path = join(dir, `${Math.random().toString(16).slice(2)}.json`);
      writeFileSync(path, JSON.stringify({ version: 1, tool: "tapline", route: "r", ...body }));
      return path;
    };
    const msg = (path: string): string => {
      const read = readScheduleFile(path);
      return read.ok ? "ok" : read.message;
    };
    expect(msg(write({ tool: "tapwright", at: "09:00 daily" }))).toContain("only its own");
    expect(msg(write({ trigger: { notification: "com.x" } }))).toContain("only Tapwright");
    expect(msg(write({ at: "09:00 daily", trigger: { file: "x" } }))).toContain("exactly one");
    expect(msg(write({}))).toContain("exactly one");
    expect(msg(write({ at: "later" }))).toContain('"at"');
    expect(msg(join(dir, "none.json"))).toContain("couldn't read");
  });

  it("@file values are the text of that file, relative to the schedule file's folder, read at run time", () => {
    const dir = tmp();
    writeFileSync(join(dir, "captions.txt"), "Good morning\r\n");
    writeFileSync(join(dir, "multi.txt"), "line one\nline two\n");
    const resolved = resolveWith({ caption: "@captions.txt", body: "@multi.txt", plain: "hello", at: "@", abs: `@${join(dir, "captions.txt")}` }, dir);
    expect(resolved).toEqual({ ok: true, values: { caption: "Good morning", body: "line one\nline two", plain: "hello", at: "@", abs: "Good morning" } });
    const missing = resolveWith({ caption: "@nope.txt" }, dir);
    expect(missing.ok).toBe(false);
  });
});

describe("newFilesSince", () => {
  it("finds the files that appeared after a time, oldest first, and leaves dotfiles out", () => {
    const dir = tmp();
    writeFileSync(join(dir, "old.txt"), "x");
    utimesSync(join(dir, "old.txt"), new Date(2026, 0, 1), new Date(2026, 0, 1));
    writeFileSync(join(dir, "b.txt"), "x");
    utimesSync(join(dir, "b.txt"), new Date(2026, 5, 2), new Date(2026, 5, 2));
    writeFileSync(join(dir, "a.txt"), "x");
    utimesSync(join(dir, "a.txt"), new Date(2026, 5, 1), new Date(2026, 5, 1));
    writeFileSync(join(dir, ".hidden"), "x");
    const found = newFilesSince(dir, new Date(2026, 4, 1).getTime());
    expect(found.files.filter((f) => f !== ".hidden")).toEqual(["a.txt", "b.txt"]);
    expect(found.files).not.toContain(".hidden");
    expect(found.newest).toBe(new Date(2026, 5, 2).getTime());
    expect(newFilesSince(join(dir, "missing"), 5)).toEqual({ files: [], newest: 5 });
  });
});
