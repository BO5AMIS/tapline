import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { accountStore } from "../src/accounts.js";
import { callTool } from "../src/dispatch.js";
import { Dialogs, OK_ALLOW, OK_FIELD, type ElicitAnswer, type ElicitClient } from "../src/elicit.js";
import type { MapFile } from "../src/mapfile.js";
import type { TaplineHost } from "../src/server.js";
import { baseMap, road, setupDrive, textOf, ALL_CAPS, type Setup, type SetupOptions } from "./drive-helpers.js";
import type { FakeApp } from "./helpers.js";

// AGENT-TOOLS 1.13 §18.4 and F7: moves pipelined on the phone, the policy checked in the host before each one.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const setup = (options: SetupOptions = {}): Promise<Setup> => setupDrive(hosts, apps, dirs, options);
const withRoads = (...roads: MapFile["roads"]): MapFile => ({ ...baseMap(), roads });
const moves = (s: Setup): Array<{ method: string; params: Record<string, unknown>; guard?: Record<string, string>; next?: { target: Record<string, unknown>; capMs: number } }> =>
  s.app.requests.filter((r) => r.method === "move").map((r) => r.params as never);

describe("drive: pipelined moves", () => {
  it("with the move capability each move is one request, and the first is checked against one tree read", async () => {
    const s = await setup();
    const answer = await callTool(s.tools, "drive", { to: "language" });
    expect(answer.isError).not.toBe(true);
    expect(s.count("move")).toBe(2);
    expect(s.count("press")).toBe(0);
    // One read before the first move, then only the moves; the last read builds the answer's screen.
    expect(s.methods().filter((m) => m !== "place" && m !== "places")).toEqual(["tree", "move", "move", "tree"]);
    expect(s.app.dryRuns.length).toBe(0);
    const [first, second] = moves(s);
    expect(first?.method).toBe("press");
    expect(first?.params).toEqual({ target: { testID: "general-row" } });
    // The second move's target is asked for with the first, as `next`, with the road's own time times 3 (at least 2 s).
    expect(first?.next).toEqual({ target: { testID: "language-row" }, capMs: 2000 });
    expect(second?.next).toBeUndefined();
  });

  it("the policy is checked on next.element before the next move is sent", async () => {
    const map = withRoads(road("settings", "general", "general-row", "General"), road("general", "trips_id", "delete-trip", "Delete trip"));
    const s = await setup({
      map,
      policy: { version: 1, confirm: [], block: ["delete"] },
      world: (w) => {
        w.elements.general = [{ ...w.elements.settings[1]! }];
        w.goes["general|delete-trip"] = "trips";
      },
    });
    const answer = await callTool(s.tools, "drive", { to: "trips_id", by: "taps" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error not_allowed: blocked: /);
    expect(textOf(answer)).toContain("Done: 1 move. Nothing else was touched.");
    // The Delete button was never pressed: only the first move's request went out.
    expect(s.count("move")).toBe(1);
    expect(s.world.screen).toBe("general");
  });

  it("a flagged next element waits for the host's dialog and then goes on", async () => {
    const answers: Array<(a: ElicitAnswer) => void> = [];
    const shown: string[] = [];
    const client: ElicitClient = {
      canShowForm: () => true,
      elicit: (message, _schema, signal) => {
        shown.push(message);
        return new Promise<ElicitAnswer>((resolve, reject) => {
          answers.push(resolve);
          signal.addEventListener("abort", () => reject(new Error("closed")), { once: true });
        });
      },
    };
    const map = withRoads(road("settings", "general", "general-row", "General"), road("general", "trips_id", "delete-trip", "Delete trip"));
    const s = await setup({
      map,
      policy: { version: 1, confirm: ["delete"], block: [] },
      tools: { dialogs: new Dialogs(client, {}) },
      world: (w) => {
        w.elements.general = [{ ...w.elements.settings[1]! }];
        w.goes["general|delete-trip"] = "trips";
      },
    });
    const call = callTool(s.tools, "drive", { to: "trips_id", by: "taps" });
    for (let i = 0; i < 200 && shown.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(shown[0]).toBe('Allow: tap "Delete trip" in Wayfare? (policy word "delete")');
    expect(s.count("move")).toBe(1);
    answers[0]?.({ action: "accept", content: { [OK_FIELD]: OK_ALLOW } });
    const answer = await call;
    expect(answer.isError).not.toBe(true);
    expect(textOf(answer)).toContain("Note: allowed by a person (in chat).");
    expect(s.count("move")).toBe(2);
  });

  it("guard is sent with what the policy checked, and a stale answer stops safely", async () => {
    const s = await setup({ world: (w) => (w.moveError = { code: "stale", message: "stale: the target is another element now than the one the policy checked; look again." }) });
    const answer = await callTool(s.tools, "drive", { to: "language" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error off_route: stopped at step 1 of 2 \(tap "General"\): it is another element now than the one the policy checked\. Now at: settings \(known\)\. Done: 0 moves\. Nothing else was touched\./);
    expect(textOf(answer)).not.toContain("Arrived");
    const [first] = moves(s);
    expect(first?.guard).toEqual({ id: "general-row", label: "General", text: "General" });
    // The road isn't blamed for a stale target.
    expect(s.file().roads.every((r) => r.failed === 0)).toBe(true);
  });

  it("the second move carries the guard of next.element", async () => {
    const s = await setup();
    await callTool(s.tools, "drive", { to: "language" });
    expect(moves(s)[1]?.guard).toEqual({ id: "language-row", label: "Language", text: "Language" });
  });

  it("without the capability it falls back and gives the same answer, with the same checks", async () => {
    const plain = await setup();
    const withMove = await setup();
    const fallback = await setup({ capabilities: ALL_CAPS.filter((c) => c !== "move") });
    const a = textOf(await callTool(withMove.tools, "drive", { to: "language" })).split("\n").slice(0, 2);
    const b = textOf(await callTool(fallback.tools, "drive", { to: "language" })).split("\n").slice(0, 2);
    expect(b).toEqual(a);
    expect(fallback.count("move")).toBe(0);
    expect(fallback.count("press")).toBe(2);
    expect(plain.count("press")).toBe(0);
    // The policy still runs before each touch: the dry run resolves the target.
    const flagged = await setup({ capabilities: ALL_CAPS.filter((c) => c !== "move"), policy: { version: 1, confirm: [], block: ["general"] } });
    const stopped = await callTool(flagged.tools, "drive", { to: "language" });
    expect(textOf(stopped)).toMatch(/^Error not_allowed: blocked: /);
    expect(flagged.count("press")).toBe(0);
  });

  it("no request carries a password or typed text", async () => {
    const store = accountStore({ version: 1, accounts: { tester2: { username: "tester2@example.com", password: "fake-pass-9137" } } });
    const s = await setup({ tools: { accounts: { store } } });
    await callTool(s.tools, "drive", { to: "language", with: { id: "42" } });
    const sent = JSON.stringify(s.app.requests);
    expect(sent).not.toContain("fake-pass-9137");
    expect(sent).not.toContain("tester2@example.com");
    expect(s.methods()).not.toContain("type");
    expect(s.methods().every((m) => ["tree", "place", "places", "move"].includes(m))).toBe(true);
  });

  it("when the next target is missing after a move, the drive repairs or stops, never presses blind", async () => {
    const s = await setup({ world: (w) => (w.elements.general = [{ ...w.elements.general[0]!, testID: "other", text: "Something else", label: "Something else" }]) });
    const answer = await callTool(s.tools, "drive", { to: "language" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toContain("it isn't on this screen");
    expect(s.count("move")).toBe(1);
  });
});
