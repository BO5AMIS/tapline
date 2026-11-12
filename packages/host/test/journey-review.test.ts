import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlQueue } from "../src/control.js";
import { formatTree } from "../src/format.js";
import { Journey, withoutUrlSecrets } from "../src/journey.js";
import type { PolicyFile } from "../src/policy.js";
import { treeResultSchema } from "../src/protocol.js";
import { FakeApp, type IncomingRequest } from "./helpers.js";
import { HOME, SCREEN, rig, textOf, type Rig, type RigOptions } from "./journeyhelpers.js";

// PR #7 review round (CodeRabbit and Codex): journey lifecycle, capture identity, embedded taps, link secrets.

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
});
const make = async (options: RigOptions = {}): Promise<Rig> => {
  const r = await rig(options);
  rigs.push(r);
  return r;
};
const begin = (r: Rig, extra: Record<string, unknown> = {}) => r.tools.journey({ start: true, goal: "log two eggs", persona: "a first-timer", ...extra });
const folderOf = (said: string): string => /Report: (.+)$/m.exec(said)?.[1] ?? "";
const presses = (app: FakeApp): IncomingRequest[] => app.requests.filter((q) => q.method === "press" && (q.params as { dryRun?: boolean }).dryRun !== true);

describe("link secrets in a journey (Codex review of d2b6097)", () => {
  it("cuts the query, the fragment and token-like segments from scheme:/ and scheme: links", () => {
    expect(withoutUrlSecrets("opened com.example.app:/oauth2redirect?code=SECRET#id_token=SECRET2")).toBe("opened com.example.app:/oauth2redirect?…#…");
    expect(withoutUrlSecrets("myapp:login?token=SECRET")).toBe("myapp:login?…");
    expect(withoutUrlSecrets("myapp:/reset/9f8e7d6c5b4a3210ffee")).toBe("myapp:/reset/…");
    expect(withoutUrlSecrets("myapp:cb#access_token=SECRET.")).toBe("myapp:cb#….");
    // the long form keeps working
    expect(withoutUrlSecrets("myapp://login?token=SECRET")).toBe("myapp://login?…");
    expect(withoutUrlSecrets("https://user:pw@example.com:8080/magic?token=S")).toBe("https://example.com:8080/magic?…");
  });

  it("leaves ordinary text alone", () => {
    for (const plain of ["at 10:30 it opened", "Note: nothing changed", "Error not_found: nothing on screen", "ratio 3:2", "Tapped e3 button \"Log in\".", "mailto:someone", "step 2: done"]) {
      expect(withoutUrlSecrets(plain)).toBe(plain);
    }
  });

  it("keeps them out of steps, shortcuts and the report, for an allowed link, a refused one and run steps", async () => {
    const r = await make();
    await begin(r, { allow: ["open_url"] });
    await r.tools.openUrl({ url: "com.example.app:/oauth2redirect?code=SECRET1#id_token=SECRET2", look: false });
    await r.tools.openUrl({ url: "myapp:login?token=SECRET3", look: false });
    await r.tools.run({ steps: [{ tool: "open_url", url: "myapp:reset?code=SECRET4" }], look: false });
    const state = r.tools.currentJourney()?.state;
    expect(state?.shortcuts.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify({ steps: state?.steps, shortcuts: state?.shortcuts })).not.toContain("SECRET");
    const said = textOf(await r.tools.journey({ stop: true, reached: true }));
    expect(said).not.toContain("SECRET");
    const folder = folderOf(said);
    for (const file of ["report.md", "report.html"]) expect(readFileSync(join(folder, file), "utf8")).not.toContain("SECRET");

    const refused = await make();
    await begin(refused);
    await refused.tools.openUrl({ url: "myapp:login?token=SECRET5" });
    await refused.tools.run({ steps: [{ tool: "open_url", url: "myapp:/cb?code=SECRET6#x=SECRET7" }], look: false });
    const stopped = textOf(await refused.tools.journey({ stop: true, reached: false }));
    expect(stopped).not.toContain("SECRET");
    for (const file of ["report.md", "report.html"]) expect(readFileSync(join(folderOf(stopped), file), "utf8")).not.toContain("SECRET");
  });
});

describe("journey start and stop lifecycle (finding 3)", () => {
  it("two starts at once: only one proceeds", async () => {
    const r = await make();
    const [a, b] = await Promise.all([begin(r, { conditions: { network: "3g" } }), begin(r, { conditions: { network: "3g" } })]);
    const refused = [a, b].filter((x) => x.isError === true);
    expect(refused).toHaveLength(1);
    expect(textOf(refused[0] ?? a)).toMatch(/^Error busy: a journey is still starting/);
    expect(r.app.requests.filter((q) => q.method === "command")).toHaveLength(1);
  });

  it("a stop while the start still runs answers busy, and the journey stops normally after", async () => {
    const r = await make();
    const starting = begin(r, { conditions: { network: "3g" } });
    const early = await r.tools.journey({ stop: true, reached: true });
    expect(early.isError).toBe(true);
    expect(textOf(early)).toMatch(/^Error busy: the journey is still starting/);
    expect((await starting).isError).not.toBe(true);
    expect((await r.tools.journey({ stop: true, reached: true })).isError).not.toBe(true);
    expect((await begin(r)).isError).not.toBe(true);
  });

  it("network stress goes to the journey's app, never to another app selected since", async () => {
    const r = await make();
    await begin(r);
    const other = await FakeApp.connect(r.host.boundPort() ?? 0, { app: { name: "Other", id: "com.example.other", version: "1.0.0", build: "1" } }, () => ({ ok: true, result: {} }));
    try {
      r.host.select(other.session);
      await r.tools.journey({ stress: { kind: "network", mode: "offline" } });
      const commands = (app: FakeApp): unknown[] => app.requests.filter((q) => q.method === "command").map((q) => q.params);
      expect(commands(other.app)).toEqual([]);
      expect(commands(r.app)).toContainEqual({ name: "network", args: { mode: "offline" } });
      await r.tools.journey({ stop: true, reached: true });
      expect(commands(other.app)).toEqual([]);
      expect(commands(r.app).at(-1)).toEqual({ name: "network", args: { mode: "normal" } });
    } finally {
      other.app.ws.terminate();
    }
  });

  it("no new start while a stop is still cleaning up", async () => {
    const r = await make();
    await begin(r, { conditions: { network: "3g" } });
    const stopping = r.tools.journey({ stop: true, reached: true });
    const early = await begin(r);
    expect(early.isError).toBe(true);
    expect(textOf(early)).toMatch(/^Error busy: a journey is still stopping/);
    await stopping;
    expect((await begin(r)).isError).not.toBe(true);
  });
});

describe("batch steps record their destination screen (finding 2)", () => {
  it("a tap into settings and back inside one run counts both screens and the wrong turn", async () => {
    const r = await make();
    await begin(r);
    await r.tools.run({ steps: [{ tool: "tap", target: { text: "Settings" } }, { tool: "back" }], look: false });
    const state = r.tools.currentJourney()?.state;
    expect(state?.screens.map((s) => s.route.join("/"))).toEqual(["home", "settings"]);
    expect(state?.measures.screensEntered).toBe(3);
    expect(state?.measures.wrongTurns).toBe(1);
    expect(state?.steps.map((s) => s.screen)).toEqual([2, 1]);
  });
});

describe("the capture goes only to the journey's app (finding 4)", () => {
  it("a screenshot is not taken from another app that was chosen during the peek", async () => {
    let swap: (() => void) | undefined;
    const r = await make({
      onRequest: (req) => {
        if (req.method === "tree" && (req.params as { peek?: boolean } | undefined)?.peek === true && swap !== undefined) {
          const run = swap;
          swap = undefined;
          run();
        }
        return undefined;
      },
    });
    await begin(r);
    const first = r.host.current();
    if (first === undefined) throw new Error("no app");
    const other = await FakeApp.connect(r.host.boundPort() ?? 0, { app: { name: "Other", id: "com.example.other", version: "1", build: "1" }, capabilities: ["tree", "press", "screenshot"] }, (req) =>
      req.method === "tree" ? { ok: true, result: { screen: SCREEN, elements: HOME, route: { names: ["other"] } } } : { ok: true, result: { mime: "image/jpeg", data: "", width: 1, height: 1 } },
    );
    r.apps.push(other.app);
    r.host.select(first.id);
    swap = () => r.host.select(other.session);
    await r.tools.tap({ target: { text: "Settings" }, look: false });
    expect(other.app.requests.filter((q) => q.method === "screenshot")).toEqual([]);
    expect(other.app.requests.filter((q) => q.method === "tree")).toEqual([]);
  });
});

describe("double tap: the policy check is inside the queued action (finding 5)", () => {
  it("what is under the target is resolved in the agent's turn, right before the press", async () => {
    let blockNow = false;
    class Flip extends ControlQueue {
      override async runAgent<T>(fn: () => Promise<T>): Promise<T> {
        blockNow = true; // a person's queued action changes the control before the agent's turn
        return super.runAgent(fn);
      }
    }
    const r = await make({
      capabilities: ["tree", "press", "screenshot", "dryRun"],
      tools: { control: new Flip(), policy: { version: 1, confirm: [], block: ["Add"] } },
      onRequest: (req) => {
        if (req.method === "press" && (req.params as { dryRun?: boolean }).dryRun === true) {
          return { ok: true, result: { dryRun: true, element: blockNow ? HOME[2] : HOME[0] } };
        }
        return undefined;
      },
    });
    await begin(r);
    const refused = await r.tools.journey({ stress: { kind: "double_tap", target: { text: "Add egg" } } });
    expect(textOf(refused)).toMatch(/^Error not_allowed: blocked: .*Add egg.* is blocked by the policy/);
    expect(presses(r.app)).toHaveLength(0);
  });
});

describe("embedded taps keep the user's eyes (finding 7)", () => {
  it("filmstrip and performance send noScroll in a journey, and not outside one", async () => {
    const r = await make();
    await r.tools.filmstrip({ tap: { text: "Settings" }, frames: 1 });
    expect(presses(r.app).at(-1)?.params).not.toHaveProperty("noScroll");
    await begin(r);
    await r.tools.filmstrip({ tap: { text: "Settings" }, frames: 1 });
    expect(presses(r.app).at(-1)?.params).toMatchObject({ noScroll: true });
    await r.tools.performance({ tap: { text: "Settings" }, seconds: 1 });
    expect(presses(r.app).at(-1)?.params).toMatchObject({ noScroll: true });
  });
});

describe("evidence is the journey app's own (minor items)", () => {
  const other = async (r: Rig) => {
    const c = await FakeApp.connect(r.host.boundPort() ?? 0, { app: { name: "Other", id: "com.example.other", version: "1", build: "1" } }, () => ({ ok: true, result: {} }));
    r.apps.push(c.app);
    const info = r.host.sessions().find((s) => s.id === c.session);
    if (info === undefined) throw new Error("no other session");
    return info;
  };

  it("another app's picker skip is not this journey's", async () => {
    const r = await make();
    await begin(r);
    r.host.emit("pickerSkipped", await other(r), 2);
    const md = readFileSync(join(folderOf(textOf(await r.tools.journey({ stop: true, reached: true }))), "report.md"), "utf8");
    expect(md).not.toContain("picker skipped");
  });

  it("another app leaving the front does not count for a background moment", async () => {
    const r = await make();
    await begin(r);
    await r.tools.journey({ stress: { kind: "background" } });
    r.host.emit("appState", await other(r), "background");
    const early = await r.tools.journey({ stress: { kind: "background" }, done: true });
    expect(textOf(early)).toMatch(/^Error bad_params: The app never left the front/);
  });

  it("a reload that brings no new session is no relaunch", async () => {
    const r = await make({ tools: { reloadWaitMs: 200 }, onRequest: (req) => (req.method === "reload" ? { ok: true, result: {} } : undefined) });
    await begin(r);
    const answer = await r.tools.journey({ stress: { kind: "relaunch" } });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/has not come back as a new session/);
    expect(r.tools.currentJourney()?.state.stress).toEqual([]);
  });

  it("a screen that can't be told apart is not reported as survived", async () => {
    const r = await make({ onRequest: (req) => (req.method === "tree" ? { ok: true, result: { screen: SCREEN, elements: HOME } } : undefined) });
    await begin(r);
    await r.tools.tap({ target: { text: "Add egg" } });
    const said = textOf(await r.tools.journey({ stress: { kind: "network", mode: "normal" }, survives: { goal_step: "1" } }));
    expect(said).not.toContain("it survived");
    expect(said).not.toContain("didn't survive");
    expect(r.tools.currentJourney()?.state.stress[0]?.survived).toBeNull();
  });

  it("no picture right after a password was typed, whichever call asks for it", async () => {
    const r = await make({ onRequest: (req) => (req.method === "type" ? { ok: true, result: { element: HOME[3], value: "", secure: true, settledMs: 50 } } : undefined) });
    await begin(r);
    const shots = (): number => r.app.requests.filter((q) => q.method === "screenshot").length;
    await r.tools.typeText({ target: { text: "Your name" }, text: "hunter2", look: false });
    const before = shots();
    await r.tools.tap({ target: { text: "Settings" }, look: false });
    expect(shots()).toBe(before);
  });
});

describe("hesitation counts ux_check as a read (minor)", () => {
  it("a look and a ux_check in a row is one hesitation", () => {
    const j = new Journey({ goal: "g" }, () => 0);
    const read = (tool: string): void => j.record({ tool, ok: true, text: "", at: 0, ms: 0 }, j.pre());
    read("look");
    read("ux_check");
    expect(j.state.measures.hesitations).toBe(1);
    const k = new Journey({ goal: "g" }, () => 0);
    k.record({ tool: "ux_check", ok: true, text: "", at: 0, ms: 0 }, k.pre());
    k.record({ tool: "ux_check", ok: true, text: "", at: 0, ms: 0 }, k.pre());
    expect(k.state.measures.hesitations).toBe(1);
  });
});

describe("a user's eyes get no Route line (minor)", () => {
  const tree = treeResultSchema.parse({ screen: SCREEN, elements: HOME, route: { names: ["home"] } });
  it("the agent's list has it, a user's has not", () => {
    expect(formatTree(tree, { name: "Demo" })).toContain("Route: home");
    expect(formatTree(tree, { name: "Demo" }, { eyes: true })).not.toContain("Route:");
  });
});

describe("a stopped journey's report folder still exists after the stop (sanity)", () => {
  it("writes the report", async () => {
    const r = await make();
    await begin(r);
    const folder = folderOf(textOf(await r.tools.journey({ stop: true, reached: true })));
    expect(existsSync(join(folder, "report.md"))).toBe(true);
    expect(readdirSync(folder).length).toBeGreaterThan(0);
  });
});

describe("Codex follow-ups on f533e29 (items 2 and 4)", () => {
  it("never takes a drive path for a link, in either slash style, with legal # characters", () => {
    for (const path of [
      String.raw`saved C:\Users\Sam#1\.tapline\journeys\2026-goal`,
      "saved C:/Users/Sam#1/.tapline/journeys/20261113T153000123456789/frames",
      String.raw`d:\work#2\a?b\c`,
    ]) {
      expect(withoutUrlSecrets(path)).toBe(path);
    }
    // real links beside a path are still cut
    expect(withoutUrlSecrets("C:/a/b opened myapp:/cb?code=X and https://example.com/p?token=Y")).toBe("C:/a/b opened myapp:/cb?… and https://example.com/p?…");
    expect(withoutUrlSecrets("myapp:login?token=X")).toBe("myapp:login?…");
  });

  const secureRig = (): Promise<Rig> => make({ onRequest: (req) => (req.method === "type" ? { ok: true, result: { element: HOME[3], value: "", secure: true, settledMs: 50 } } : undefined) });
  const shotsOf = (r: Rig): number => r.app.requests.filter((q) => q.method === "screenshot").length;

  it("secure typing before the journey starts keeps the start's first frame out of the report", async () => {
    const r = await secureRig();
    await r.tools.typeText({ target: { text: "Your name" }, text: "hunter2", look: false });
    await begin(r);
    expect(shotsOf(r)).toBe(0);
    r.advance(2000);
    await r.tools.tap({ target: { text: "Settings" }, look: false });
    expect(shotsOf(r)).toBeGreaterThan(0);
  });

  it("a default look in the window leaves the picture out and says why; a second later it has one", async () => {
    for (const inJourney of [false, true]) {
      const r = await secureRig();
      if (inJourney) await begin(r);
      await r.tools.typeText({ target: { text: "Your name" }, text: "hunter2", look: false });
      const before = shotsOf(r);
      const quiet = await r.tools.look();
      expect(quiet.content.some((block) => block.type === "image")).toBe(false);
      expect(textOf(quiet)).toMatch(/^Note: no screenshot: a password field was typed into a moment ago/m);
      expect(shotsOf(r)).toBe(before);
      r.advance(2000);
      const later = await r.tools.look();
      expect(later.content.some((block) => block.type === "image")).toBe(true);
      expect(textOf(later)).not.toContain("a password field was typed");
    }
  });
});

describe("CodeRabbit follow-ups on PR #7", () => {
  const otherApp = { name: "Other", id: "com.example.other", version: "1.0.0", build: "1" };
  const stressNetwork = async (policy: PolicyFile) => {
    const r = await make({ tools: { policy } });
    await begin(r);
    const other = await FakeApp.connect(r.host.boundPort() ?? 0, { app: otherApp }, () => ({ ok: true, result: {} }));
    r.apps.push(other.app);
    r.host.select(other.session);
    return { r, answer: await r.tools.journey({ stress: { kind: "network", mode: "offline" } }) };
  };

  it("network stress is checked against the journey's app, not the selected one", async () => {
    const { r, answer } = await stressNetwork({ version: 1, confirm: [], block: [], apps: { "com.example.demo": { confirm: [], block: ["network"] } } });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/blocks network for Demo/);
    expect(r.app.requests.filter((q) => q.method === "command")).toEqual([]);
  });

  it("and a block on the selected app alone does not stop the journey's app", async () => {
    const { r, answer } = await stressNetwork({ version: 1, confirm: [], block: [], apps: { "com.example.other": { confirm: [], block: ["network"] } } });
    expect(answer.isError).not.toBe(true);
    expect(r.app.requests.filter((q) => q.method === "command").map((q) => q.params)).toContainEqual({ name: "network", args: { mode: "offline" } });
  });

  it("a stop while the start reads its first screen answers busy; the start then finishes and a later stop works", async () => {
    let held: number | undefined;
    let arm = false;
    const r = await make({
      onRequest: (req) => {
        const peek = (req.params as { peek?: boolean } | undefined)?.peek === true;
        if (req.method === "tree" && !peek && arm) {
          arm = false;
          held = req.id;
          return "ignore";
        }
        return undefined;
      },
    });
    arm = true;
    const starting = begin(r);
    await vi.waitFor(() => expect(held).toBeDefined());
    // journeyRun is set by now: only the busy hold keeps the stop out
    expect(r.tools.currentJourney()).toBeDefined();
    const early = await r.tools.journey({ stop: true, reached: true });
    expect(early.isError).toBe(true);
    expect(textOf(early)).toMatch(/^Error busy: the journey is still starting/);
    r.app.send({ type: "response", id: held, ok: true, result: { screen: SCREEN, elements: HOME, route: { names: ["home"] } } });
    expect((await starting).isError).not.toBe(true);
    expect((await r.tools.journey({ stop: true, reached: true })).isError).not.toBe(true);
  });
});
