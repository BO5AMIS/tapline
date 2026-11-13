import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { accountStore } from "../src/accounts.js";
import { cheapestWay } from "../src/mapcmd.js";
import { loadMap, type MapRoad } from "../src/mapfile.js";
import { AppMap } from "../src/places.js";
import { escapeLiteral, loadRoute, routeEdges, routeSlug, runRoute, saveRoute, substituteSteps, substituteVariables, type RouteContext } from "../src/routes.js";
import { readScript, sharedScriptSchema, type SharedScriptV2 } from "../src/script.js";
import type { Step } from "../src/run.js";

// AGENT-TOOLS 1.13 §18.5 and §9.4: script version 2, variables, and where a route is kept.

const dirs: string[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "tapline-routes-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const APP = { id: "com.example.wayfare", name: "Wayfare" };

const signIn: SharedScriptV2 = {
  format: "agent-tools-script",
  version: 2,
  app: "com.example.wayfare",
  name: "sign_in",
  start: "welcome",
  end: "home",
  variables: ["account"],
  steps: [
    { tool: "tap", target: { text: "Continue" } },
    { tool: "type_text", target: { id: "email" }, text: "${account.username}" },
    { tool: "type_text", target: { id: "password" }, text: "${account.password}" },
    { tool: "tap", target: { text: "Not now" }, optional: true },
    { tool: "wait_for", text: "Home" },
  ],
};

describe("script version 2", () => {
  it("version 1 files still parse and replay", () => {
    const v1 = { format: "agent-tools-script", version: 1, name: "old", app: "com.example.wayfare", fresh: true, steps: [{ tool: "tap", target: { id: "go" } }] };
    const read = readScript(JSON.stringify(v1));
    expect(read).not.toBeNull();
    expect(read?.version).toBe(1);
    expect(read?.steps).toEqual(v1.steps);
    // The file from before 1.1 still reads too.
    const legacy = { version: 1, name: "older", app: { name: "Wayfare" }, recordedAt: "2026-01-01", steps: [{ method: "press", params: { target: { testID: "go" } } }] };
    expect(readScript(JSON.stringify(legacy))?.steps).toEqual([{ tool: "tap", target: { id: "go" } }]);
  });

  it("reads start, end and variables from a version 2 file", () => {
    const read = readScript(JSON.stringify(signIn));
    expect(read?.version).toBe(2);
    expect(read).toMatchObject({ start: "welcome", end: "home", variables: ["account"] });
  });

  it("refuses a version 3 file, and a variable name that isn't a name", () => {
    expect(readScript(JSON.stringify({ ...signIn, version: 3 }))).toBeNull();
    expect(sharedScriptSchema.safeParse({ ...signIn, variables: ["a b"] }).success).toBe(false);
  });

  it("if and optional survive a round trip", () => {
    const steps: Step[] = [
      { tool: "tap", target: { text: "Not now" }, optional: true },
      { tool: "tap", target: { text: "Skip" }, if: { text: "Welcome" } },
      { tool: "tap", target: { text: "Retry" }, if: { text: "Loading", gone: true } },
    ];
    const read = readScript(JSON.stringify({ ...signIn, steps }));
    expect(read?.steps).toEqual(steps);
  });
});

describe("route names", () => {
  it("a route name is reduced to [A-Za-z0-9._-]", () => {
    expect(routeSlug("sign_in")).toBe("sign_in");
    expect(routeSlug("Sign in / now!")).toBe("Sign_in_now");
    expect(routeSlug("../../evil")).toBe("evil");
    expect(routeSlug("a.b-c_9")).toBe("a.b-c_9");
    expect(routeSlug("x".repeat(80))).toHaveLength(60);
    expect(routeSlug("***")).toBeNull();
    // Windows device names can't be files, with or without an extension; trailing dots go.
    expect(routeSlug("con")).toBe("_con");
    expect(routeSlug("NUL.txt")).toBe("_NUL.txt");
    expect(routeSlug("com1")).toBe("_com1");
    expect(routeSlug("lpt9.json")).toBe("_lpt9.json");
    expect(routeSlug("console")).toBe("console");
    expect(routeSlug("trip...")).toBe("trip");
    expect(routeSlug("trip. . ")).toBe("trip");
    expect(routeSlug("x".repeat(59) + "...")).toBe("x".repeat(59));
    expect(routeSlug("..")).toBeNull();
  });
});

describe("variables", () => {
  const typed = (text: string): Step => ({ tool: "type_text", target: { id: "city" }, text });

  it("substitute fills a variable", () => {
    const done = substituteVariables(typed("${city}"), { city: "Paris" });
    expect(done).toEqual({ ok: true, step: typed("Paris") });
  });

  it("fills a variable inside a target and an expectation too", () => {
    const step: Step = { tool: "tap", target: { text: "Trip to ${city}" }, expect: { text: "${city} trip" } };
    const done = substituteVariables(step, { city: "Rome" });
    expect(done).toEqual({ ok: true, step: { tool: "tap", target: { text: "Trip to Rome" }, expect: { text: "Rome trip" } } });
  });

  it("refuses a missing variable with bad_params naming it", () => {
    const done = substituteVariables(typed("${city}"), {});
    expect(done.ok).toBe(false);
    if (!done.ok) {
      expect(done.code).toBe("bad_params");
      expect(done.message).toContain("city");
    }
  });

  it("$${ round trips: what escapeLiteral writes, substitute reads back", () => {
    expect(escapeLiteral("cost ${x}")).toBe("cost $${x}");
    expect(escapeLiteral("plain")).toBe("plain");
    const done = substituteVariables(typed(escapeLiteral("cost ${x} and ${y}")), {});
    expect(done).toEqual({ ok: true, step: typed("cost ${x} and ${y}") });
  });

  it("a literal $${account. never becomes an account placeholder after filling", () => {
    const whole = substituteVariables(typed("$${account.password}"), {});
    expect(whole.ok).toBe(false);
    const joined = substituteVariables(typed(escapeLiteral("cost ${x} and ${account.password}")), {});
    expect(joined.ok).toBe(false);
    // A value split across a literal and a variable is the same case.
    const split = substituteVariables(typed("$${account.${part}}"), { part: "password" });
    expect(split.ok).toBe(false);
    // The real placeholder, whole, still passes unchanged.
    expect(substituteVariables(typed("${account.password}"), {}).ok).toBe(true);
  });

  it("with the route's variables, a value for a name it doesn't list, and a token it doesn't list, are refused", () => {
    const extra = substituteVariables(typed("${city}"), { city: "Paris", other: "x" }, undefined, ["city"]);
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.message).toContain("other");
    const token = substituteVariables(typed("${city}"), { city: "Paris" }, undefined, ["place"]);
    expect(token.ok).toBe(false);
    if (!token.ok) expect(token.message).toContain("city");
    expect(substituteVariables(typed("${city}"), { city: "Paris" }, undefined, ["city"]).ok).toBe(true);
    // The account placeholder needs no listing.
    expect(substituteVariables(typed("${account.username}"), {}, undefined, []).ok).toBe(true);
  });

  it("an account value in a route stays whole-text and stays a placeholder", () => {
    const whole = substituteVariables(typed("${account.password}"), {});
    expect(whole).toEqual({ ok: true, step: typed("${account.password}") });
    const joined = substituteVariables(typed("hi ${account.password}"), {});
    expect(joined.ok).toBe(false);
    if (!joined.ok) expect(joined.message).toBe("an account value is the whole text of a step, not part of one.");
    // A variable can't bring one in either.
    const smuggled = substituteVariables(typed("${city}"), { city: "x ${account.password}" });
    expect(smuggled.ok).toBe(false);
  });

  it("with an accounts store, a field an account doesn't have is refused before anything runs", () => {
    const store = accountStore({ version: 1, accounts: { tester2: { username: "tester2@example.com", password: "fake-pass-9137" } } });
    expect(substituteVariables(typed("${account.username}"), {}, store).ok).toBe(true);
    const passcode = substituteVariables(typed("${account.passcode}"), {}, store);
    expect(passcode.ok).toBe(false);
  });

  it("substituteSteps names the step that can't be filled", () => {
    const done = substituteSteps([{ tool: "tap", target: { id: "go" } }, typed("${city}")], {});
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.message).toMatch(/^step 2: .*city/);
  });
});

describe("saving a route", () => {
  const open = (dir: string): AppMap => new AppMap({ id: APP.id, name: APP.name, version: "1.0.0", build: "1" }, { dir, writeGapMs: 0 });

  it("routes/<name>.json is written under the map folder and registered in map.routes", async () => {
    const dir = tmp();
    const map = open(dir);
    await saveRoute(dir, signIn, map);
    expect(JSON.parse(readFileSync(join(dir, "routes", "sign_in.json"), "utf8"))).toEqual(signIn);
    expect(loadMap(dir, APP.id).map.routes).toEqual({ sign_in: "routes/sign_in.json" });
    expect(map.data().routes).toEqual({ sign_in: "routes/sign_in.json" });
  });

  it("registers in the file even with no open map", async () => {
    const dir = tmp();
    await saveRoute(dir, signIn);
    expect(loadMap(dir, APP.id).map.routes).toEqual({ sign_in: "routes/sign_in.json" });
  });

  it("reduces the name, in the file name, the registry and the file", async () => {
    const dir = tmp();
    await saveRoute(dir, { ...signIn, name: "Sign in!" });
    expect(Object.keys(loadMap(dir, APP.id).map.routes)).toEqual(["Sign_in"]);
    expect(loadRoute(dir, "Sign_in")?.name).toBe("Sign_in");
  });

  it("loadRoute reads it back, and answers null for an unknown name or a file that isn't a route", async () => {
    const dir = tmp();
    await saveRoute(dir, signIn);
    expect(loadRoute(dir, "sign_in")).toEqual(signIn);
    expect(loadRoute(dir, "nobody")).toBeNull();
  });

  it("saving again replaces the route of that name", async () => {
    const dir = tmp();
    await saveRoute(dir, signIn);
    await saveRoute(dir, { ...signIn, end: "settings" });
    expect(loadRoute(dir, "sign_in")?.end).toBe("settings");
    expect(Object.keys(loadMap(dir, APP.id).map.routes)).toEqual(["sign_in"]);
  });
});

describe("running a route", () => {
  interface Fake {
    ctx: RouteContext<string>;
    ran: Step[][];
    drove: string[];
  }
  const fake = (here: string | null, drive?: boolean): Fake => {
    const ran: Step[][] = [];
    const drove: string[] = [];
    const ctx: RouteContext<string> = {
      here: () => Promise.resolve(here),
      runSteps: (steps) => {
        ran.push(steps);
        return Promise.resolve("answer");
      },
      ...(drive === true
        ? {
            driveTo: (place: string) => {
              drove.push(place);
              return Promise.resolve({ ok: true as const });
            },
          }
        : {}),
    };
    return { ctx, ran, drove };
  };
  const named: SharedScriptV2 = { ...signIn, variables: ["city"], steps: [{ tool: "type_text", target: { id: "city" }, text: "${city}" }] };

  it("runs the steps, filled, when the app is at the start", async () => {
    const { ctx, ran } = fake("welcome");
    const out = await runRoute(named, { city: "Paris" }, ctx);
    expect(out).toEqual({ kind: "ran", answer: "answer" });
    expect(ran[0]).toEqual([{ tool: "type_text", target: { id: "city" }, text: "Paris" }]);
  });

  it("refuses a missing variable before it touches anything", async () => {
    const { ctx, ran } = fake("welcome");
    const out = await runRoute(named, {}, ctx);
    expect(out.kind).toBe("refused");
    if (out.kind === "refused") {
      expect(out.code).toBe("bad_params");
      expect(out.message).toContain("city");
    }
    expect(ran).toEqual([]);
  });

  it("with the app elsewhere and no driver yet, answers unsupported and touches nothing", async () => {
    const { ctx, ran } = fake("settings");
    const out = await runRoute(signIn, {}, ctx);
    expect(out).toMatchObject({ kind: "refused", code: "unsupported" });
    if (out.kind === "refused") expect(out.message).toContain("welcome");
    expect(ran).toEqual([]);
  });

  it("with the app's place unknown, it says so", async () => {
    const { ctx } = fake(null);
    const out = await runRoute(signIn, {}, ctx);
    expect(out).toMatchObject({ kind: "refused", code: "unsupported" });
  });

  it("drives to the start first when a driver is given", async () => {
    const { ctx, ran, drove } = fake("settings", true);
    const out = await runRoute(signIn, {}, ctx);
    expect(out.kind).toBe("ran");
    expect(drove).toEqual(["welcome"]);
    expect(ran).toHaveLength(1);
  });

  it("a route with no start runs from wherever the app is", async () => {
    const { ctx, ran } = fake("settings");
    const { start: _start, ...noStart } = signIn;
    expect((await runRoute(noStart, {}, ctx)).kind).toBe("ran");
    expect(ran).toHaveLength(1);
  });
});

describe("a route as a way", () => {
  const road = (from: string, to: string, by = "tapline"): MapRoad => ({
    from,
    to,
    move: { tool: "tap", target: { text: to } },
    by,
    seen: 1,
    failed: 0,
    ms: 10,
    last: "2026-11-01T00:00:00.000Z",
    build: "1.0.0 (1)",
  });

  it("is one road from start to end, one move per step", async () => {
    const dir = tmp();
    const map = new AppMap({ id: APP.id, name: APP.name, version: "1.0.0", build: "1" }, { dir, writeGapMs: 0 });
    await saveRoute(dir, signIn, map);
    expect(routeEdges(map)).toEqual([{ route: "sign_in", from: "welcome", to: "home", moves: 5, last: expect.any(String) }]);
  });

  it("leaves out a route that needs a value from the agent (a variable other than account) or has no start or end", async () => {
    const dir = tmp();
    const map = new AppMap({ id: APP.id, name: APP.name, version: "1.0.0", build: "1" }, { dir, writeGapMs: 0 });
    await saveRoute(dir, { ...signIn, name: "needs_city", variables: ["city"] });
    await saveRoute(dir, { ...signIn, name: "no_end", end: undefined });
    await map.flush();
    const reloaded = new AppMap({ id: APP.id, name: APP.name, version: "1.0.0", build: "1" }, { dir, writeGapMs: 0 });
    expect(routeEdges(reloaded)).toEqual([]);
  });

  it("cheapestWay takes a route when it is the only way, and counts its steps", () => {
    const edges = [{ route: "sign_in", from: "welcome", to: "home", moves: 5, last: "2026-11-01T00:00:00.000Z" }];
    const way = cheapestWay([], "welcome", "home", () => true, edges);
    expect(way).toEqual(edges);
  });

  it("prefers two roads over a five-step route, and the route over an unproven long road chain", () => {
    const edges = [{ route: "sign_in", from: "welcome", to: "home", moves: 5, last: "2026-11-01T00:00:00.000Z" }];
    const roads = [road("welcome", "mid"), road("mid", "home")];
    expect(cheapestWay(roads, "welcome", "home", () => true, edges)).toEqual(roads);
    const slow = [road("welcome", "a"), road("a", "b"), road("b", "c"), road("c", "home")];
    expect(cheapestWay(slow, "welcome", "home", () => false, edges)).toEqual(edges);
  });
});
