import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { accountStore } from "../src/accounts.js";
import { callTool } from "../src/dispatch.js";
import { CANT_NOW, DONE_FIELD, Dialogs, OK_ALLOW, OK_FIELD, type ElicitAnswer, type ElicitClient } from "../src/elicit.js";
import type { MapFile, MapRoad } from "../src/mapfile.js";
import type { TaplineHost } from "../src/server.js";
import { baseMap, button, note, place, road, setupDrive, textOf, type El, type Setup, type SetupOptions, flushDriveMaps } from "./drive-helpers.js";
import type { FakeApp } from "./helpers.js";

// The safety review of the first drive commit (1.6 task 15): rows, link words, blame, nothing moved, moments, cancel, the guard.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  await flushDriveMaps();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const setup = (options: SetupOptions = {}): Promise<Setup> => setupDrive(hosts, apps, dirs, options);
const withRoads = (...roads: MapRoad[]): MapFile => ({ ...baseMap(), roads });
const drive = (s: Setup, args: Record<string, unknown>) => callTool(s.tools, "drive", args);
const asRow = (element: El, testID?: string): El => ({ ...element, row: true, ...(testID !== undefined ? { testID } : {}) });
const withoutId = (element: El): El => {
  const { testID: _gone, ...rest } = element;
  return rest;
};

describe("a row is never repaired to by its text", () => {
  it("a row with an id is repaired to by the id alone: no label or text reaches the map", async () => {
    const s = await setup({ world: (w) => { w.screen = "general"; w.elements.general = [asRow(button("e3", "lang-row-7", "Language"))]; w.goes["general|lang-row-7"] = "language"; } });
    const answer = await drive(s, { to: "language" });
    expect(answer.isError).not.toBe(true);
    expect(textOf(answer)).toContain("Road repaired: id=lang-row-7 (was id=language-row).");
    await s.registry.flushAll();
    const repaired = s.file().roads.find((r) => r.from === "general");
    expect(repaired?.move.target).toEqual({ id: "lang-row-7" });
    expect(repaired?.names).toEqual({ id: "lang-row-7" });
  });

  it("a row with no id is refused: off_route, nothing pressed, and the map keeps the old road", async () => {
    const s = await setup({ world: (w) => { w.screen = "general"; w.elements.general = [asRow(withoutId(button("e3", "x", "Language")))]; } });
    const answer = await drive(s, { to: "language" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error off_route: stopped at step 1 of 1 \(tap "Language"\): it isn't on this screen/);
    expect(s.count("move") + s.count("press")).toBe(0);
  });
});

describe("a jump's link words go through the policy", () => {
  const orders = (): MapFile => {
    const map = baseMap();
    map.places["trips_id"] = place(["trips", "[id]"], "wayfare://orders/[id]/cancel");
    return map;
  };
  const jump = { to: "trips_id", with: { id: "42" } };

  it("a blocked word stops the jump before its request", async () => {
    const s = await setup({ map: orders(), policy: { version: 1, confirm: [], block: ["cancel"] }, world: (w) => (w.links["wayfare://orders/42/cancel"] = "trips") });
    const answer = await drive(s, jump);
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error not_allowed: blocked: /);
    expect(s.count("move") + s.made("openURL")).toBe(0);
  });

  it("a flagged word needs a person's OK: no dialog stops it, a dialog asks and then goes", async () => {
    const policy = { version: 1 as const, confirm: ["cancel"], block: [] as string[] };
    const none = await setup({ map: orders(), policy, world: (w) => (w.links["wayfare://orders/42/cancel"] = "trips") });
    const stopped = await drive(none, jump);
    expect(textOf(stopped)).toMatch(/^Error not_allowed: needs_confirmation: /);
    expect(none.made("openURL")).toBe(0);
    const answers: Array<(a: ElicitAnswer) => void> = [];
    const client: ElicitClient = {
      canShowForm: () => true,
      elicit: (_m, _s, signal) =>
        new Promise<ElicitAnswer>((resolve, reject) => {
          answers.push(resolve);
          signal.addEventListener("abort", () => reject(new Error("closed")), { once: true });
        }),
    };
    const asked = await setup({ map: orders(), policy, tools: { dialogs: new Dialogs(client, {}) }, world: (w) => (w.links["wayfare://orders/42/cancel"] = "trips") });
    const call = drive(asked, jump);
    for (let i = 0; i < 200 && answers.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(asked.made("openURL")).toBe(0);
    answers[0]?.({ action: "accept", content: { [OK_FIELD]: OK_ALLOW } });
    const answer = await call;
    expect(answer.isError).not.toBe(true);
    expect(textOf(answer)).toContain("Note: allowed by a person (in chat).");
    expect(asked.made("openURL")).toBe(1);
  });

  it("an open_url road checks the same way", async () => {
    const link: MapRoad = { ...road("settings", "language", "x", "x"), move: { tool: "open_url", url: "wayfare://orders/[id]/cancel" }, names: {} };
    const map = withRoads(link);
    const s = await setup({ map, policy: { version: 1, confirm: [], block: ["cancel"] }, world: (w) => (w.links["wayfare://orders/42/cancel"] = "language") });
    const answer = await drive(s, { to: "language", by: "taps", with: { id: "42" } });
    expect(textOf(answer)).toMatch(/^Error not_allowed: blocked: /);
    expect(s.made("openURL")).toBe(0);
  });
});

describe("only a missing target or an arrival elsewhere blames a road", () => {
  const failedOf = (s: Setup): number[] => s.file().roads.map((r) => r.failed);
  it("not_found blames the road", async () => {
    const s = await setup({ world: (w) => (w.moveError = { code: "not_found", message: "not_found: nothing matches" }) });
    await drive(s, { to: "language" });
    await s.registry.flushAll();
    expect(failedOf(s)).toContain(1);
  });

  it("ambiguous, another not_actionable reason, covered and stale blame nobody", async () => {
    for (const error of [
      { code: "ambiguous", message: "ambiguous: 2 match" },
      { code: "not_actionable", message: "disabled: it is disabled" },
      { code: "stale", message: "stale: another element" },
    ]) {
      const s = await setup({ world: (w) => (w.moveError = error) });
      const answer = await drive(s, { to: "language" });
      expect(textOf(answer)).toMatch(/^Error off_route: /);
      await s.registry.flushAll();
      expect(failedOf(s).every((n) => n === 0)).toBe(true);
    }
    const covered = await setup({ world: (w) => (w.nextState = "covered") });
    const answer = await drive(covered, { to: "language" });
    expect(textOf(answer)).toMatch(/^Error off_route: stopped at step 2 of 2 \(tap "Language"\): it's covered by something on the screen\./);
    await covered.registry.flushAll();
    expect(failedOf(covered).every((n) => n === 0)).toBe(true);
  });
});

describe("nothing moved", () => {
  it("an arrival where it started stops with off_route, and does not try the same road again", async () => {
    const s = await setup({ world: (w) => (w.landOnce = "settings") });
    const answer = await drive(s, { to: "language" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error off_route: stopped at step 1 of 2 \(tap "General"\): the screen didn't change\. Now at: settings \(known\)\. Done: 1 move\./);
    expect(s.count("move")).toBe(1);
  });

  it("a jump that missed with by link is not jumped again", async () => {
    const map = baseMap();
    map.places["language"] = place(["settings", "general", "language"], "wayfare://language");
    const s = await setup({ map });
    const answer = await drive(s, { to: "language", by: "link" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toContain("it didn't lead where the road says");
    expect(s.made("openURL")).toBe(1);
  });

  it("a drive that drops nothing says nothing of dropping", async () => {
    const s = await setup({ world: (w) => (w.landOnce = "settings") });
    expect(textOf(await drive(s, { to: "language" }))).not.toContain("dropped");
  });
});

describe("a drive is a batch for needs-a-person moments", () => {
  it("an app in the background answers in a batch's form, naming the step", async () => {
    const s = await setup({ world: (w) => (w.moveError = { code: "in_background", message: "The app is in the background; open it." }) });
    const answer = await drive(s, { to: "language" });
    expect(textOf(answer)).toMatch(/^Error in_background: Ran 0 of 2 steps; stopped at step 1 \(tap "General"\): The app is in the background; open it\./);
  });

  it("an alert over the next target is a moment, not off_route, and a decline says so", async () => {
    const shown: string[] = [];
    const client: ElicitClient = {
      canShowForm: () => true,
      elicit: (message) => {
        shown.push(message);
        return Promise.resolve({ action: "accept", content: { [DONE_FIELD]: CANT_NOW } });
      },
    };
    const alert = { kind: "alert", title: "Allow notifications?", message: null, buttons: [{ text: "OK", style: "default" }], standIn: false };
    const s = await setup({ tools: { dialogs: new Dialogs(client, {}) }, world: (w) => { w.nextState = "covered"; w.alerts = [alert]; } });
    const answer = await drive(s, { to: "language" });
    const said = textOf(answer);
    expect(said).toMatch(/^Error not_actionable: Ran 1 of 2 steps; stopped at step 2 \(tap "Language"\): behind_alert: An alert is open/);
    expect(said).not.toContain("off_route");
    expect(shown.length).toBe(1);
    expect(said).toContain("They can't now. Ask your user what to do.");
    // A drive never runs again: only the first move was made.
    expect(s.count("move")).toBe(1);
  });
});

describe("a cancelled call stops between moves", () => {
  it("drive stops at the top of the next move with Done: n moves", async () => {
    const abort = new AbortController();
    const s = await setup({ world: (w) => (w.onPress = () => abort.abort()) });
    const answer = await s.tools.withCall(abort.signal, () => drive(s, { to: "language" }));
    expect(textOf(answer)).toBe("Error cancelled: the call was cancelled. Done: 1 move. Nothing else was touched.");
    expect(s.count("move")).toBe(1);
  });

  it("run stops between steps too", async () => {
    const abort = new AbortController();
    const s = await setup({ world: (w) => { w.onPress = () => abort.abort(); w.screen = "settings"; } });
    const steps = [{ tool: "tap", target: { id: "general-row" } }, { tool: "tap", target: { id: "language-row" } }];
    const answer = await s.tools.withCall(abort.signal, () => callTool(s.tools, "run", { steps }));
    expect(textOf(answer)).toMatch(/^Error cancelled: Ran 1 of 2 steps; stopped at step 2 /);
    expect(s.count("press")).toBe(1);
  });
});

describe("the guard and the wait for a person", () => {
  it("the phone resolves another element than the host checked: stale stops it, and nothing is touched", async () => {
    const s = await setup({ world: (w) => (w.swapTo = "delete-trip") });
    const answer = await drive(s, { to: "language" });
    expect(textOf(answer)).toMatch(/^Error off_route: stopped at step 1 of 2 \(tap "General"\): it is another element now than the one the policy checked\./);
    expect(s.world.screen).toBe("settings");
  });

  it("the element is read again after a wait: a change during the wait stops the touch", async () => {
    const answers: Array<(a: ElicitAnswer) => void> = [];
    const client: ElicitClient = {
      canShowForm: () => true,
      elicit: (_m, _s, signal) =>
        new Promise<ElicitAnswer>((resolve, reject) => {
          answers.push(resolve);
          signal.addEventListener("abort", () => reject(new Error("closed")), { once: true });
        }),
    };
    const map = withRoads(road("settings", "trips_id", "delete-trip", "Delete trip"));
    const s = await setup({ map, policy: { version: 1, confirm: ["delete"], block: [] }, tools: { dialogs: new Dialogs(client, {}) } });
    const call = drive(s, { to: "trips_id", by: "taps" });
    for (let i = 0; i < 200 && answers.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    // While the person decides, the button becomes another one under the same id.
    s.world.elements.settings = [button("e2", "delete-trip", "Save trip")];
    answers[0]?.({ action: "accept", content: { [OK_FIELD]: OK_ALLOW } });
    const answer = await call;
    expect(textOf(answer)).toContain("the screen changed while waiting for the OK");
    expect(s.count("move") + s.count("press")).toBe(0);
  });
});

describe("the policy runs on the element that receives the press (PR 9 review, P1)", () => {
  // A saved road names the text "Continue"; an app refactor put it inside a Pressable labelled "Delete account".
  const refactored = (w: Parameters<NonNullable<SetupOptions["world"]>>[0], pressed: string[]): void => {
    const child: El = { ...note("e9", "Continue"), actions: [] };
    w.elements.settings = [child];
    w.parents = { e9: button("e8", "account-delete", "Delete account") };
    w.goes["settings|account-delete"] = "trips";
    w.onPress = (id) => pressed.push(id);
  };
  const textRoad: MapRoad = { ...road("settings", "trips_id", "x", "Continue"), move: { tool: "tap", target: { text: "Continue" } }, names: { text: "Continue" } };

  it("with the move request: asks for the OK and never runs the destructive handler", async () => {
    const pressed: string[] = [];
    const s = await setup({ map: withRoads(textRoad), policy: { version: 1, confirm: ["delete"], block: [] }, world: (w) => refactored(w, pressed) });
    const answer = await drive(s, { to: "trips_id", by: "taps" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toContain("needs_confirmation");
    expect(textOf(answer)).toContain("Delete account");
    expect(pressed).toEqual([]);
    expect(s.world.screen).toBe("settings");
  });

  it("without the move request: the same, by the plain press", async () => {
    const pressed: string[] = [];
    const s = await setup({ map: withRoads(textRoad), capabilities: ["tree", "press", "logs", "dryRun", "place", "places"], policy: { version: 1, confirm: ["delete"], block: [] }, world: (w) => refactored(w, pressed) });
    const answer = await drive(s, { to: "trips_id", by: "taps" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toContain("needs_confirmation");
    expect(pressed).toEqual([]);
  });

  it("a blocked parent is refused outright", async () => {
    const pressed: string[] = [];
    const s = await setup({ map: withRoads(textRoad), policy: { version: 1, confirm: [], block: ["delete"] }, world: (w) => refactored(w, pressed) });
    const answer = await drive(s, { to: "trips_id", by: "taps" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toContain("blocked");
    expect(pressed).toEqual([]);
  });
});

describe("long_press and toggle roads", () => {
  it("are driven as their own moves and counted as moves", async () => {
    const long: MapRoad = { ...road("settings", "general", "general-row", "General"), move: { tool: "long_press", target: { id: "general-row" } } };
    const toggle: MapRoad = { ...road("general", "language", "language-row", "Language"), move: { tool: "toggle", target: { id: "language-row" } } };
    const s = await setup({ map: withRoads(long, toggle) });
    const answer = await drive(s, { to: "language" });
    expect(textOf(answer).split("\n")[0]).toBe("Arrived at language by 2 moves in 0.0 s (settings > general > language).");
    const inner = s.app.requests.filter((r) => r.method === "move").map((r) => (r.params as { method: string }).method);
    expect(inner).toEqual(["longPress", "toggle"]);
  });
});

describe("a typed account value in a drive", () => {
  it("never appears in an answer, the action log or the map", async () => {
    const password = "fake-pass-9137";
    const store = accountStore({ version: 1, accounts: { tester2: { username: "tester2@example.com", password, apps: ["com.example.wayfare"] } } });
    const logDir = mkdtempSync(join(tmpdir(), "tapline-drive-log-"));
    dirs.push(logDir);
    const file = JSON.stringify({
      format: "agent-tools-script",
      version: 2,
      app: "com.example.wayfare",
      name: "login",
      start: "settings",
      variables: ["account"],
      steps: [
        { tool: "type_text", target: { id: "email" }, text: "${account.username}" },
        { tool: "type_text", target: { id: "password" }, text: "${account.password}" },
      ],
    });
    const s = await setup({
      map: { ...baseMap(), routes: { login: "routes/login.json" } },
      tools: { accounts: { store }, logDir },
      hello: { capabilities: ["tree", "press", "type", "typeKind", "logs", "dryRun", "place", "places", "move"] },
      world: (w) => {
        w.elements.settings.push({ ref: "e20", type: "TextInput", role: "input", testID: "email", frame: button("x", "x", "x").frame, actions: ["type"] }, { ref: "e21", type: "TextInput", role: "input", testID: "password", frame: button("x", "x", "x").frame, actions: ["type"] });
      },
    });
    writeFileSync(join(s.folder, "routes", "login.json"), file);
    const answer = await drive(s, { route: "login", account: "tester2" });
    expect(answer.isError).not.toBe(true);
    // The phone was given the value; nothing the agent can read, and nothing on disk, holds the password.
    expect(s.app.requests.some((r) => r.method === "type" && JSON.stringify(r.params).includes(password))).toBe(true);
    await s.registry.flushAll();
    const everything = [textOf(answer)];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else everything.push(readFileSync(path, "utf8"));
      }
    };
    walk(logDir);
    walk(s.folder);
    expect(everything.join("\n")).not.toContain(password);
    expect(note("e0", "x").role).toBe("text");
  });
});
