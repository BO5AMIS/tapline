import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { accountStore } from "../src/accounts.js";
import { callTool } from "../src/dispatch.js";
import { Dialogs, OK_ALLOW, OK_FIELD, type ElicitAnswer, type ElicitClient } from "../src/elicit.js";
import type { MapFile, MapRoad } from "../src/mapfile.js";
import type { PolicyFile } from "../src/policy.js";
import type { TaplineHost } from "../src/server.js";
import { baseMap, button, note, road, setupDrive, textOf, flushDriveMaps, type El, type Setup, type World } from "./drive-helpers.js";
import type { FakeApp } from "./helpers.js";

// `drive` with test accounts loaded (PR 9 fixes A and B): the policy and the guard use the raw element the app's dry run
// resolves, while everything shown (answers, logs, the map, session_report, dialogs) stays scrubbed. Every value is fake.
// The account's password is the word "Delete", so a scrubbed label and a raw one differ.

const PASSWORD = "Delete";
const store = accountStore({ version: 1, accounts: { tester2: { username: "tester2@example.com", password: PASSWORD, apps: ["com.example.wayfare"] } } });

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  await flushDriveMaps();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

type Kind = "tap" | "long_press" | "toggle";
const NEEDS: Record<Kind, string> = { tap: "press", long_press: "longPress", toggle: "toggle" };
const INNER: Record<Kind, string> = { tap: "press", long_press: "longPress", toggle: "toggle" };

const CONFIRM: PolicyFile = { version: 1, confirm: ["delete"], block: [] };
const BLOCK: PolicyFile = { version: 1, confirm: [], block: [PASSWORD] };
const OPEN: PolicyFile = { version: 1, confirm: [], block: [] };

const withRoads = (...roads: MapRoad[]): MapFile => ({ ...baseMap(), roads });
const roadOf = (tool: Kind, target: Record<string, string>, names: Record<string, string>): MapRoad => ({ ...road("settings", "trips_id", "del", "x"), move: { tool, target }, names });
const deleteEl = (kind: Kind, label = PASSWORD): El => ({ ...button("e1", "del", label), actions: [NEEDS[kind]] });

/** A client that records what it was asked and answers at once (allow), or waits for the test to answer. */
function client(mode: "allow" | "hold"): { client: ElicitClient; messages: string[]; held: Array<(a: ElicitAnswer) => void> } {
  const messages: string[] = [];
  const held: Array<(a: ElicitAnswer) => void> = [];
  return {
    messages,
    held,
    client: {
      canShowForm: () => true,
      elicit: (message, _schema, signal) =>
        new Promise<ElicitAnswer>((resolve, reject) => {
          messages.push(message);
          if (mode === "allow") resolve({ action: "accept", content: { [OK_FIELD]: OK_ALLOW } });
          else {
            held.push(resolve);
            signal.addEventListener("abort", () => reject(new Error("closed")), { once: true });
          }
        }),
    },
  };
}

interface Rig {
  s: Setup;
  logDir: string;
  messages: string[];
  held: Array<(a: ElicitAnswer) => void>;
}

async function rig(options: { policy: PolicyFile; map: MapFile; world: (w: World) => void; ask?: "allow" | "hold" | "none"; withMove?: boolean }): Promise<Rig> {
  const logDir = mkdtempSync(join(tmpdir(), "tapline-drive-accounts-log-"));
  dirs.push(logDir);
  const asked = client(options.ask === "hold" ? "hold" : "allow");
  const s = await setupDrive(hosts, apps, dirs, {
    map: options.map,
    policy: options.policy,
    world: options.world,
    ...(options.withMove === false ? { capabilities: ["tree", "press", "logs", "dryRun", "place", "places"] } : {}),
    tools: { accounts: { store }, logDir, ...(options.ask === "none" ? {} : { dialogs: new Dialogs(asked.client, {}) }) },
  });
  // setupDrive starts a plain host; turn the accounts' scrubbing on, as `startHost({ redact })` does for the real one.
  const host = hosts[hosts.length - 1] as unknown as { redact: ((text: string) => string) | undefined };
  host.redact = store.redact;
  return { s, logDir, messages: asked.messages, held: asked.held };
}

const drive = (r: Rig, args: Record<string, unknown> = { to: "trips_id", by: "taps" }) => callTool(r.s.tools, "drive", args);

/** Touches that were really made (dry runs are the host looking), including the ones inside a `move`. */
const touches = (r: Rig): Array<{ method: string; guard?: Record<string, unknown> }> =>
  r.s.app.requests.flatMap((req) => {
    const params = (req.params ?? {}) as Record<string, unknown>;
    if (req.method === "move") {
      const inner = (params["params"] ?? {}) as Record<string, unknown>;
      return inner["dryRun"] === true ? [] : [{ method: String(params["method"]), ...(params["guard"] !== undefined ? { guard: params["guard"] as Record<string, unknown> } : {}) }];
    }
    return ["press", "longPress", "toggle"].includes(req.method) && params["dryRun"] !== true ? [{ method: req.method }] : [];
  });

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(readFileSync(path, "utf8"));
  }
  return out;
}

/** Everything an agent or a reader of the disk could see: the answer, the action and call logs, the map, the report, the dialogs. */
async function outward(r: Rig, answer: string): Promise<string> {
  await r.s.registry.flushAll();
  return [answer, textOf(r.s.tools.sessionReport({})), ...filesUnder(r.logDir), ...filesUnder(r.s.folder), ...r.messages].join("\n");
}

const oneButton = (kind: Kind, label = PASSWORD) => (w: World): void => {
  w.elements.settings = [deleteEl(kind, label)];
  w.goes["settings|del"] = "trips";
};

describe("a password that is a policy word (drive, accounts loaded)", () => {
  it("a recipient labelled like the password asks for the OK, and is not pressed without it", async () => {
    // No person to ask here: the call has no OK to give.
    const bare = await rig({ policy: CONFIRM, map: withRoads(roadOf("tap", { id: "del" }, { id: "del" })), world: oneButton("tap"), ask: "none" });
    const refused = await drive(bare);
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("needs_confirmation");
    expect(touches(bare)).toHaveLength(0);
    expect(bare.s.world.screen).toBe("settings");
    expect(await outward(bare, textOf(refused))).not.toContain(PASSWORD);
    // With a person who allows: it asks, then moves.
    const r = await rig({ policy: CONFIRM, map: withRoads(roadOf("tap", { id: "del" }, { id: "del" })), world: oneButton("tap") });
    const allowed = await drive(r);
    expect(allowed.isError).not.toBe(true);
    expect(r.messages.length).toBeGreaterThan(0);
    expect(touches(r)).toHaveLength(1);
    expect(r.s.world.screen).toBe("trips");
  });

  it("a block word equal to the password blocks the drive, and nothing shows the word", async () => {
    const r = await rig({ policy: BLOCK, map: withRoads(roadOf("tap", { id: "del" }, { id: "del" })), world: oneButton("tap") });
    const answer = await drive(r);
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toContain("blocked");
    expect(touches(r)).toHaveLength(0);
    expect(r.messages).toHaveLength(0);
    expect(r.s.world.screen).toBe("settings");
    expect(await outward(r, textOf(answer))).not.toContain(PASSWORD);
  });
});

describe("the guard carries the raw label; nothing outward does", () => {
  it("with the move request: the app sees Delete, the answer, logs, map and report do not", async () => {
    const r = await rig({ policy: CONFIRM, map: withRoads(roadOf("tap", { id: "del" }, { id: "del" })), world: oneButton("tap") });
    const answer = await drive(r);
    expect(answer.isError).not.toBe(true);
    const made = touches(r);
    expect(made).toHaveLength(1);
    expect(made[0]?.guard).toEqual({ id: "del", label: PASSWORD, text: PASSWORD, role: "button" });
    expect(r.s.world.screen).toBe("trips");
    expect(await outward(r, textOf(answer))).not.toContain(PASSWORD);
  });

  it("with no policy words at all the guard is still the raw fingerprint", async () => {
    const r = await rig({ policy: OPEN, map: withRoads(roadOf("tap", { id: "del" }, { id: "del" })), world: oneButton("tap") });
    const answer = await drive(r);
    expect(answer.isError).not.toBe(true);
    expect(touches(r)[0]?.guard).toEqual({ id: "del", label: PASSWORD, text: PASSWORD, role: "button" });
    expect(await outward(r, textOf(answer))).not.toContain(PASSWORD);
  });

  it("without the move request: the plain press is made after the OK, and nothing shows the password", async () => {
    const r = await rig({ policy: CONFIRM, map: withRoads(roadOf("tap", { id: "del" }, { id: "del" })), world: oneButton("tap"), withMove: false });
    const answer = await drive(r);
    expect(answer.isError).not.toBe(true);
    expect(r.messages.length).toBeGreaterThan(0);
    expect(touches(r)).toEqual([{ method: "press" }]);
    expect(await outward(r, textOf(answer))).not.toContain(PASSWORD);
  });
});

describe("all three action kinds", () => {
  const kinds: Kind[] = ["tap", "long_press", "toggle"];

  it.each(kinds)("a %s road to a recipient labelled like the password: the OK is asked, the raw guard goes with it", async (kind) => {
    const r = await rig({ policy: CONFIRM, map: withRoads(roadOf(kind, { id: "del" }, { id: "del" })), world: oneButton(kind) });
    const answer = await drive(r);
    expect(answer.isError).not.toBe(true);
    expect(r.messages.length).toBeGreaterThan(0);
    const made = touches(r);
    expect(made).toHaveLength(1);
    expect(made[0]?.method).toBe(INNER[kind]);
    expect(made[0]?.guard).toEqual({ id: "del", label: PASSWORD, text: PASSWORD, role: "button" });
    expect(await outward(r, textOf(answer))).not.toContain(PASSWORD);
  });

  it.each(kinds)("a %s road is not made without the OK", async (kind) => {
    // A dialog that is never answered: the person's OK doesn't come, so the touch must not be made.
    const r = await rig({ policy: CONFIRM, map: withRoads(roadOf(kind, { id: "del" }, { id: "del" })), world: oneButton(kind), ask: "hold" });
    const call = drive(r);
    for (let i = 0; i < 200 && r.held.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(r.held).toHaveLength(1);
    r.held[0]?.({ action: "decline" });
    const answer = await call;
    expect(answer.isError).toBe(true);
    expect(touches(r)).toHaveLength(0);
    expect(r.s.world.screen).toBe("settings");
    expect(await outward(r, textOf(answer))).not.toContain(PASSWORD);
  });

  it.each(kinds)("a %s road with a blocked password word is refused", async (kind) => {
    const r = await rig({ policy: BLOCK, map: withRoads(roadOf(kind, { id: "del" }, { id: "del" })), world: oneButton(kind) });
    const answer = await drive(r);
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toContain("blocked");
    expect(touches(r)).toHaveLength(0);
  });
});

describe("a recipient that is the parent of the named child", () => {
  // The road names the text "Continue"; the app puts it inside a Pressable labelled "Delete account" (the password is "Delete").
  const refactored = (w: World, pressed: string[]): void => {
    w.elements.settings = [{ ...note("e9", "Continue"), actions: [] }];
    w.parents = { e9: button("e8", "account-delete", "Delete account") };
    w.goes["settings|account-delete"] = "trips";
    w.onPress = (id) => pressed.push(id);
  };
  const textRoad = (): MapRoad => roadOf("tap", { text: "Continue" }, { text: "Continue" });

  it("without the OK: asked for, the destructive handler never runs, no password in what is shown", async () => {
    const pressed: string[] = [];
    const r = await rig({ policy: CONFIRM, map: withRoads(textRoad()), world: (w) => refactored(w, pressed), ask: "hold" });
    const call = drive(r);
    for (let i = 0; i < 200 && r.held.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(r.held).toHaveLength(1);
    r.held[0]?.({ action: "decline" });
    const answer = await call;
    expect(answer.isError).toBe(true);
    expect(pressed).toEqual([]);
    expect(touches(r)).toHaveLength(0);
    expect(await outward(r, textOf(answer))).not.toContain(PASSWORD);
  });

  it("a blocked word reaches the parent and refuses", async () => {
    const pressed: string[] = [];
    const r = await rig({ policy: { version: 1, confirm: [], block: ["delete account"] }, map: withRoads(textRoad()), world: (w) => refactored(w, pressed) });
    const answer = await drive(r);
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toContain("blocked");
    expect(pressed).toEqual([]);
  });

  it("after the OK the guard is the parent's raw fingerprint, so the app accepts it", async () => {
    const pressed: string[] = [];
    const r = await rig({ policy: CONFIRM, map: withRoads(textRoad()), world: (w) => refactored(w, pressed) });
    const answer = await drive(r);
    expect(answer.isError).not.toBe(true);
    expect(touches(r)[0]?.guard).toEqual({ id: "account-delete", label: "Delete account", text: "Delete account", role: "button" });
    expect(pressed).toEqual(["account-delete"]);
    expect(await outward(r, textOf(answer))).not.toContain(PASSWORD);
  });
});

describe("a target that changes during the wait for the OK", () => {
  // The second label scrubs to the same text as the first: only the raw data tells them apart.
  it.each(["Save trip", "<tester2's password>"])("becoming %s is refused, and nothing is touched", async (changed) => {
    const r = await rig({ policy: CONFIRM, map: withRoads(roadOf("tap", { id: "del" }, { id: "del" })), world: oneButton("tap"), ask: "hold" });
    const call = drive(r);
    for (let i = 0; i < 200 && r.held.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(r.held).toHaveLength(1);
    r.s.world.elements.settings = [deleteEl("tap", changed)];
    r.held[0]?.({ action: "accept", content: { [OK_FIELD]: OK_ALLOW } });
    const answer = await call;
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toContain("the screen changed while waiting for the OK");
    expect(touches(r)).toHaveLength(0);
    expect(r.s.world.screen).toBe("settings");
    expect(await outward(r, textOf(answer))).not.toContain(PASSWORD);
  });
});
