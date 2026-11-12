import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlQueue } from "../src/control.js";
import type { PolicyFile } from "../src/policy.js";
import type { SessionInfo } from "../src/server.js";
import { HOME, reloadable, rig, textOf, type Rig, type RigOptions } from "./journeyhelpers.js";

// AGENT-TOOLS 1.12 §17.4: stress moments during a journey, and what must survive them.

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
});
const make = async (options: RigOptions = {}): Promise<Rig> => {
  const r = await rig(options);
  rigs.push(r);
  return r;
};
const begin = (r: Rig) => r.tools.journey({ start: true, goal: "log two eggs", persona: "a first-timer" });
const networkCalls = (r: Rig): unknown[] => r.app.requests.filter((q) => q.method === "command").map((q) => q.params);
const isDry = (params: unknown): boolean => (params as { dryRun?: boolean }).dryRun === true;
/** The connected app's session, for events a person's moment leaves behind. */
const sessionOf = (r: Rig): SessionInfo => {
  const session = r.host.current();
  if (session === undefined) throw new Error("no app connected");
  return session;
};

describe("stress: network", () => {
  it("starts the 1.4 condition mid-flow and checks what must survive", async () => {
    const r = await make();
    await begin(r);
    const answer = await r.tools.journey({ stress: { kind: "network", mode: "offline" }, survives: { text: "2 eggs" } });
    expect(answer.isError).not.toBe(true);
    expect(textOf(answer)).toBe('Stress: network offline; it survived: text "2 eggs" is still in the field.');
    expect(networkCalls(r)).toEqual([{ name: "network", args: { mode: "offline" } }]);
  });

  it("says it didn't survive, and the report files it as a high finding", async () => {
    const r = await make();
    await begin(r);
    const answer = textOf(await r.tools.journey({ stress: { kind: "network", mode: "3g" }, survives: { text: "9 eggs" } }));
    expect(answer).toBe('Stress: network 3g; it didn\'t survive: text "9 eggs" is not on screen any more.');
    const stopped = textOf(await r.tools.journey({ stop: true, reached: true }));
    expect(stopped.split("\n")[1]).toMatch(/^Findings: 1 high\./);
    const folder = /Report: (.+)$/m.exec(stopped)?.[1] ?? "";
    const md = readFileSync(join(folder, "report.md"), "utf8");
    expect(md).toContain("## Stress moments");
    expect(md).toContain("- Stress: network 3g; it didn't survive");
    expect(md).toContain("[high] stress");
    expect(r.tools.finishedJourney()?.stress).toMatchObject([{ kind: "network", survived: false }]);
  });

  it("checks nothing without survives, and says so", async () => {
    const r = await make();
    await begin(r);
    expect(textOf(await r.tools.journey({ stress: { kind: "network", mode: "lossy" } }))).toBe("Stress: network lossy; nothing was checked (no survives given).");
    expect(r.tools.currentJourney()?.state.stress[0]?.survived).toBeNull();
  });

  it("needs a mode, and the policy can block it", async () => {
    const r = await make({ tools: { policy: { version: 1, confirm: [], block: ["network"] } as PolicyFile } });
    await begin(r);
    expect(textOf(await r.tools.journey({ stress: { kind: "network" } }))).toMatch(/^Error bad_params: stress network needs mode/);
    const blocked = await r.tools.journey({ stress: { kind: "network", mode: "offline" } });
    expect(blocked.isError).toBe(true);
    expect(textOf(blocked)).toMatch(/^Error not_allowed: network offline wasn't applied: blocked: the safety policy blocks network here/);
    expect(networkCalls(r)).toEqual([]);
    expect(r.tools.currentJourney()?.state.stress).toEqual([]);
  });

  it("puts the network back to normal at the stop even when the report folder couldn't be made", async () => {
    // A file where the journeys folder should be: the recorder can't start, the journey still runs.
    const blocker = join(tmpdir(), `tapline-not-a-folder-${process.pid}-${Date.now()}`);
    writeFileSync(blocker, "x");
    try {
      const r = await make({ tools: { journeysDir: join(blocker, "journeys") } });
      await begin(r);
      await r.tools.journey({ stress: { kind: "network", mode: "offline" } });
      const stopped = textOf(await r.tools.journey({ stop: true, reached: true }));
      expect(stopped).toContain("Undone: network is normal again.");
      expect(networkCalls(r)).toEqual([
        { name: "network", args: { mode: "offline" } },
        { name: "network", args: { mode: "normal" } },
      ]);
    } finally {
      rmSync(blocker, { force: true });
    }
  });

  it("puts the network back to normal at the stop", async () => {
    const r = await make();
    await begin(r);
    await r.tools.journey({ stress: { kind: "network", mode: "offline" } });
    const stopped = textOf(await r.tools.journey({ stop: true, reached: true }));
    expect(stopped).toContain("Undone: network is normal again.");
    expect(networkCalls(r)).toEqual([
      { name: "network", args: { mode: "offline" } },
      { name: "network", args: { mode: "normal" } },
    ]);
  });
});

describe("stress: double_tap", () => {
  it("asks the app for both taps in one request, 80 ms apart, and checks what must survive", async () => {
    const r = await make({ capabilities: ["tree", "press", "screenshot", "dryRun"] });
    await begin(r);
    const answer = textOf(await r.tools.journey({ stress: { kind: "double_tap", target: { text: "Add egg" } }, survives: { text: "2 eggs" } }));
    expect(answer.split("\n")[0]).toBe('Stress: double_tap on "Add egg"; it survived: text "2 eggs" is still in the field.');
    expect(answer.split("\n")[1]).toBe("Both taps went through, 80 ms apart.");
    const presses = r.app.requests.filter((q) => q.method === "press" && !isDry(q.params));
    expect(presses).toHaveLength(1);
    expect(presses[0]?.params).toMatchObject({ target: { text: "Add egg" }, again: 80 });
    // one stress moment, not two taps of the journey
    expect(r.tools.currentJourney()?.state.measures.taps).toBe(0);
    expect(r.tools.currentJourney()?.state.stress).toHaveLength(1);
  });

  it("keeps the 80 ms with the live view's control queue on (the real server)", async () => {
    const r = await make({ capabilities: ["tree", "press", "screenshot", "dryRun"], tools: { control: new ControlQueue() } });
    await begin(r);
    const answer = textOf(await r.tools.journey({ stress: { kind: "double_tap", target: { text: "Add egg" } } }));
    expect(answer.split("\n")[1]).toBe("Both taps went through, 80 ms apart.");
    expect(r.app.requests.filter((q) => q.method === "press" && !isDry(q.params))).toHaveLength(1);
  });

  it("says when the app guarded against the second tap", async () => {
    const r = await make({
      capabilities: ["tree", "press", "screenshot", "dryRun"],
      onRequest: (req) =>
        req.method === "press" && !isDry(req.params)
          ? { ok: true, result: { element: { ref: "e3", role: "button", text: "Add egg" }, second: { done: false, reason: "disabled", afterMs: 81 }, settledMs: 100 } }
          : undefined,
    });
    await begin(r);
    const answer = textOf(await r.tools.journey({ stress: { kind: "double_tap", target: { text: "Add egg" } } }));
    expect(answer.split("\n")[1]).toBe("The first tap went through; the second, 81 ms later, didn't land (disabled).");
  });

  it("refuses to claim a double tap when the app made only one (an older SDK)", async () => {
    const r = await make({
      capabilities: ["tree", "press", "screenshot", "dryRun"],
      onRequest: (req) => (req.method === "press" && !isDry(req.params) ? { ok: true, result: { element: { ref: "e3", role: "button", text: "Add egg" }, settledMs: 100 } } : undefined),
    });
    await begin(r);
    const answer = await r.tools.journey({ stress: { kind: "double_tap", target: { text: "Add egg" } } });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/the app made only the first tap \(a double tap in one request needs react-native-tapline 1\.5 or later/);
    expect(r.tools.currentJourney()?.state.stress).toEqual([]);
  });

  it("is refused when the policy would ask a person's OK for the target: one OK never covers two touches", async () => {
    const r = await make({ capabilities: ["tree", "press", "screenshot", "dryRun"], tools: { policy: { version: 1, confirm: ["Add"], block: [] } } });
    await begin(r);
    const refused = await r.tools.journey({ stress: { kind: "double_tap", target: { text: "Add egg" } } });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/^Error not_allowed: needs_confirmation: double_tap on .*Add egg.* is refused: it needs a person's OK \(policy word "Add"\), and one OK never covers two touches\./);
    expect(r.app.requests.filter((q) => q.method === "press")).toHaveLength(0);
    expect(r.tools.currentJourney()?.state.stress).toEqual([]);
  });

  it("is refused when the policy blocks the target", async () => {
    const r = await make({ capabilities: ["tree", "press", "screenshot", "dryRun"], tools: { policy: { version: 1, confirm: [], block: ["Add"] } } });
    await begin(r);
    const refused = await r.tools.journey({ stress: { kind: "double_tap", target: { text: "Add egg" } } });
    expect(textOf(refused)).toMatch(/^Error not_allowed: blocked: .*Add egg.* is blocked by the policy/);
    expect(r.app.requests.filter((q) => q.method === "press")).toHaveLength(0);
  });

  it("needs a target, and only double_tap takes one", async () => {
    const r = await make();
    await begin(r);
    expect(textOf(await r.tools.journey({ stress: { kind: "double_tap" } }))).toMatch(/^Error bad_params: stress double_tap needs a target/);
    expect(textOf(await r.tools.journey({ stress: { kind: "double_tap", target: { text: "a", ref: "e1" } } }))).toMatch(/^Error bad_params: stress double_tap needs a target/);
    expect(textOf(await r.tools.journey({ stress: { kind: "network", mode: "offline", target: { text: "a" } } }))).toMatch(/^Error bad_params: target goes with stress double_tap/);
    expect(textOf(await r.tools.journey({ stress: { kind: "background", mode: "offline" } }))).toMatch(/^Error bad_params: mode goes with stress network/);
  });

  it("reports a touch that could not be made as that, not as a stress result", async () => {
    const r = await make({ tools: { policy: { version: 1, confirm: [], block: [] } } });
    await begin(r);
    const answer = await r.tools.journey({ stress: { kind: "double_tap", target: { text: "Covered" } } });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Stress: double_tap on "Covered" didn't happen as asked: Error not_actionable/);
    expect(r.tools.currentJourney()?.state.stress).toEqual([]);
  });
});

describe("stress: relaunch", () => {
  it("in a development build it is a reload, said as what it is", async () => {
    let rg: Rig | undefined;
    const r = await make({ onRequest: (req) => (rg === undefined ? undefined : reloadable(() => rg as Rig)(req)) });
    rg = r;
    await begin(r);
    const answer = textOf(await r.tools.journey({ stress: { kind: "relaunch" }, survives: { text: "2 eggs" } }));
    expect(answer).toBe('Stress: relaunch (reload, not a relaunch); it survived: text "2 eggs" is still in the field.');
    expect(r.apps).toHaveLength(2);
  });

  it("in any other build it needs a person, then done checks survives", async () => {
    const r = await make({ onRequest: (req) => (req.method === "reload" ? { ok: false, error: { code: "unsupported", message: "reload is only available in development builds" } } : undefined) });
    await begin(r);
    const asked = textOf(await r.tools.journey({ stress: { kind: "relaunch" }, survives: { text: "2 eggs" } }));
    expect(asked.split("\n")[0]).toBe("Stress: relaunch needs a person: close the app and open it again, then say done.");
    expect(r.tools.currentJourney()?.state.stress).toEqual([]);
    // done is checked: no new connection yet, so it isn't counted
    const early = await r.tools.journey({ stress: { kind: "relaunch" }, done: true });
    expect(textOf(early)).toMatch(/^Error bad_params: The app hasn't started again since the moment was asked/);
    r.host.emit("connect", sessionOf(r));
    const done = textOf(await r.tools.journey({ stress: { kind: "relaunch" }, done: true }));
    expect(done).toBe('Stress: relaunch; it survived: text "2 eggs" is still in the field.');
  });
});

describe("stress: background and rotate need a person", () => {
  it("background asks, and done checks survives", async () => {
    const r = await make();
    await begin(r);
    const asked = textOf(await r.tools.journey({ stress: { kind: "background" }, survives: { text: "2 eggs" } }));
    expect(asked.split("\n")[0]).toBe("Stress: background needs a person: switch to another app and back, then say done.");
    expect(asked).toContain('journey { stress: { kind: "background" }, done: true }');
    expect(r.app.requests.filter((q) => q.method !== "tree" && q.method !== "screenshot")).toEqual([]); // nothing was faked in the app
    // done on the agent's word alone isn't counted: the app never left the front
    const early = await r.tools.journey({ stress: { kind: "background" }, done: true });
    expect(textOf(early)).toBe("Error bad_params: The app never left the front since the moment was asked, so it can't be counted. Ask the person again, then say done.");
    r.host.emit("appState", sessionOf(r), "background");
    r.host.emit("appState", sessionOf(r), "active");
    const done = textOf(await r.tools.journey({ stress: { kind: "background" }, done: true }));
    expect(done).toBe('Stress: background; it survived: text "2 eggs" is still in the field.');
    expect(r.tools.currentJourney()?.state.stress).toMatchObject([{ kind: "background", survived: true }]);
  });

  it("rotate asks the same way, and done can bring its own survives", async () => {
    const r = await make();
    await begin(r);
    expect(textOf(await r.tools.journey({ stress: { kind: "rotate" } })).split("\n")[0]).toBe("Stress: rotate needs a person: turn the phone and keep it turned, then say done.");
    expect(textOf(await r.tools.journey({ stress: { kind: "rotate" }, done: true }))).toMatch(/^Error bad_params: The screen is still 402x874 pt, as when the moment was asked: say done while the phone is turned\./);
    r.world.rotated = true;
    const done = textOf(await r.tools.journey({ stress: { kind: "rotate" }, done: true, survives: { text: "0 eggs" } }));
    expect(done).toBe('Stress: rotate; it didn\'t survive: text "0 eggs" is not on screen any more.');
  });

  it("done with nothing waiting is bad_params; done without stress too", async () => {
    const r = await make();
    await begin(r);
    expect(textOf(await r.tools.journey({ stress: { kind: "background" }, done: true }))).toMatch(/^Error bad_params: no background moment is waiting for a person/);
    expect(textOf(await r.tools.journey({ done: true }))).toMatch(/^Error bad_params: survives and done go with stress/);
    expect(textOf(await r.tools.journey({ survives: { text: "x" } }))).toMatch(/^Error bad_params: survives and done go with stress/);
  });

  it("a moment that waits is forgotten when the journey stops", async () => {
    const r = await make();
    await begin(r);
    await r.tools.journey({ stress: { kind: "background" } });
    await r.tools.journey({ stop: true, reached: true });
    await begin(r);
    expect(textOf(await r.tools.journey({ stress: { kind: "background" }, done: true }))).toMatch(/^Error bad_params: no background moment is waiting/);
  });

  it("an app that is gone after the person's moment did not survive", async () => {
    const r = await make();
    await begin(r);
    await r.tools.journey({ stress: { kind: "background" }, survives: { text: "2 eggs" } });
    r.app.ws.terminate();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const done = textOf(await r.tools.journey({ stress: { kind: "background" }, done: true }));
    expect(done).toBe("Stress: background; it didn't survive: the app isn't connected any more.");
  });
});

describe("survives", () => {
  it("text is found in a field or elsewhere on screen", async () => {
    const r = await make();
    await begin(r);
    expect(textOf(await r.tools.journey({ stress: { kind: "network", mode: "normal" }, survives: { text: "Add egg" } }))).toBe('Stress: network normal; it survived: text "Add egg" is still on screen.');
    expect(HOME.length).toBeGreaterThan(0);
  });

  it("text must be seen: a label only a screen reader hears doesn't count, and in a user's eyes the glass is asked", async () => {
    const trees: unknown[] = [];
    const r = await make({
      onRequest: (req) => {
        if (req.method !== "tree" || (req.params as { peek?: boolean } | undefined)?.peek !== true) return undefined;
        trees.push(req.params);
        return { ok: true, result: { screen: { width: 402, height: 874, scale: 3 }, elements: [{ ref: "e1", role: "button", label: "Saved 2 eggs" }], route: { names: ["home"] } } };
      },
    });
    await begin(r);
    const answer = textOf(await r.tools.journey({ stress: { kind: "network", mode: "normal" }, survives: { text: "2 eggs" } }));
    expect(answer).toBe('Stress: network normal; it didn\'t survive: text "2 eggs" is not on screen any more.');
    expect(trees.at(-1)).toMatchObject({ peek: true, glass: true });
  });

  it("goal_step by number: the screen that step ended on", async () => {
    const r = await make();
    await begin(r);
    await r.tools.tap({ target: { text: "Settings" } });
    const same = textOf(await r.tools.journey({ stress: { kind: "network", mode: "normal" }, survives: { goal_step: "1" } }));
    expect(same).toBe("Stress: network normal; it survived: the app is still on step 1's screen (settings).");
    r.world.route = ["home"];
    const moved = textOf(await r.tools.journey({ stress: { kind: "network", mode: "normal" }, survives: { goal_step: "1" } }));
    expect(moved).toBe("Stress: network normal; it didn't survive: the app is on home, not step 1's screen (settings).");
    expect(textOf(await r.tools.journey({ stress: { kind: "network", mode: "normal" }, survives: { goal_step: "9" } }))).toContain("the journey has no step 9.");
  });

  it("goal_step by name: part of the route", async () => {
    const r = await make();
    await begin(r);
    expect(textOf(await r.tools.journey({ stress: { kind: "network", mode: "normal" }, survives: { goal_step: "Home" } }))).toBe("Stress: network normal; it survived: the app is still on home.");
    expect(textOf(await r.tools.journey({ stress: { kind: "network", mode: "normal" }, survives: { goal_step: "checkout" } }))).toBe('Stress: network normal; it didn\'t survive: the app is on home, not "checkout".');
  });

  it("both together must hold", async () => {
    const r = await make();
    await begin(r);
    const answer = textOf(await r.tools.journey({ stress: { kind: "network", mode: "normal" }, survives: { text: "2 eggs", goal_step: "checkout" } }));
    expect(answer).toContain("didn't survive");
    expect(answer).toContain('text "2 eggs" is still in the field.');
  });
});

describe("the report keeps every stress result", () => {
  it("lists them in the folder with the rest", async () => {
    const r = await make();
    await begin(r);
    await r.tools.journey({ stress: { kind: "network", mode: "offline" }, survives: { text: "2 eggs" } });
    await r.tools.journey({ stress: { kind: "rotate" } });
    r.world.rotated = true;
    await r.tools.journey({ stress: { kind: "rotate" }, done: true, survives: { text: "2 eggs" } });
    const stopped = textOf(await r.tools.journey({ stop: true, reached: true }));
    const folder = /Report: (.+)$/m.exec(stopped)?.[1] ?? "";
    expect(readdirSync(folder)).toContain("report.md");
    const md = readFileSync(join(folder, "report.md"), "utf8");
    expect(md).toContain('- Stress: network offline; it survived: text "2 eggs" is still in the field.');
    expect(md).toContain('- Stress: rotate; it survived: text "2 eggs" is still in the field.');
    expect(stopped.split("\n")[1]).toMatch(/^Findings: none\./);
  });
});
