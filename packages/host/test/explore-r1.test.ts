import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exploreLists, protectedPlaceWord, recipientVerdict, screenTitles } from "../src/explorefloor.js";
import type { MapFile } from "../src/mapfile.js";
import type { PolicyFile } from "../src/policy.js";
import type { TaplineHost } from "../src/server.js";
import { APP, place } from "./drive-helpers.js";
import { EXPLORE_CAPS, btn, flushExploreMaps, input, setupExplore, type ExEl, type ExploreSetup, type ExploreSetupOptions } from "./explore-helpers.js";
import type { FakeApp } from "./helpers.js";

// PR 13 security review, round 1: explore's safety floor holds at every dispatched move (routes, drive legs, typing), the floor
// covers inputs and the real recipient, app overrides don't lower it, protected places read the live title, and typed text is redacted.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await flushExploreMaps();
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const setup = (options: ExploreSetupOptions = {}): Promise<ExploreSetup> => setupExplore(hosts, apps, dirs, options);

function filesUnder(dir: string, prefix = ""): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path, `${prefix}${name}/`) : [`${prefix}${name}`];
  });
}
const lastRun = (s: ExploreSetup): string => {
  const appDir = join(s.exploreDir, APP.id);
  return join(appDir, readdirSync(appDir).sort().at(-1) as string);
};
const reportOf = (s: ExploreSetup) =>
  JSON.parse(readFileSync(join(lastRun(s), "report.json"), "utf8")) as { skipped: Array<{ place: string; sig: string; why: string; word?: string }>; notes: string[]; stopped: string; findings: Array<{ kind: string; got: string }> };
const skipOf = (s: ExploreSetup, sig: string): { why: string; word?: string } | undefined => reportOf(s).skipped.find((entry) => entry.sig === sig);
const header = (text: string): ExEl => ({ text, role: "header", type: "Text", actions: [] });

const routeMap = (): MapFile => ({
  format: "agent-tools-map",
  version: 1,
  app: APP.id,
  places: { home: place(["home"]), settings: place(["settings"]) },
  roads: [],
  routes: { go: "routes/go.json" },
  reflexes: [],
});

describe("R1 finding 1: saved routes, drive legs and typing obey explore's rules at every move", () => {
  it("a saved route that types into a password with submit, then taps on, is refused by explore and goes over no budget", async () => {
    const s = await setup({
      map: routeMap(),
      world: (w) => {
        w.screens["home"]?.elements.push(input("password", "Password"));
      },
    });
    writeFileSync(
      join(s.folder, "routes", "go.json"),
      JSON.stringify({
        format: "agent-tools-script",
        version: 2,
        app: APP.id,
        name: "go",
        start: "home",
        end: "settings",
        steps: [
          { tool: "type_text", target: { id: "password" }, text: "hunter2-route", submit: true },
          { tool: "tap", target: { id: "open-trips" } },
          { tool: "tap", target: { id: "open-settings" } },
        ],
      }),
    );
    await s.tools.explore({ from: "settings", fill: "none", steps: 1 });
    expect(s.world.typed).toEqual([]);
    expect(s.world.asked).not.toContain("type");
    // The budget is one step: no second move is sent, even inside a drive.
    expect(s.world.pressed.length).toBeLessThanOrEqual(1);
    expect(s.world.asked.filter((m) => m === "press" || m === "type" || m === "scroll" || m === "back").length).toBeLessThanOrEqual(1);
  });

  it("counts every move of a drive against the steps budget", async () => {
    const s = await setup({ map: routeMap() });
    writeFileSync(
      join(s.folder, "routes", "go.json"),
      JSON.stringify({
        format: "agent-tools-script",
        version: 2,
        app: APP.id,
        name: "go",
        start: "home",
        end: "settings",
        steps: [{ tool: "tap", target: { id: "open-form" } }, { tool: "back" }, { tool: "tap", target: { id: "open-trips" } }, { tool: "back" }, { tool: "tap", target: { id: "open-settings" } }],
      }),
    );
    await s.tools.explore({ from: "settings", steps: 2 });
    expect(s.world.asked.filter((m) => m === "press" || m === "back").length).toBeLessThanOrEqual(2);
  });
});

describe("R1 finding 2: fill obeys skip marks and sends the plain-field guard", () => {
  it("never types into an input the app marks exploreSkip, and records the skip", async () => {
    const s = await setup({
      world: (w) => {
        const form = w.screens["form"]?.elements;
        if (form !== undefined) form[0] = input("name-test-safe", "Name", { exploreSkip: true });
      },
    });
    await s.tools.explore({ fill: "test-data" });
    expect(s.world.typed.map((t) => t.id)).not.toContain("name-test-safe");
    expect(s.world.typed.map((t) => t.id)).toContain("email-test-safe");
    expect(skipOf(s, "id:name-test-safe")).toMatchObject({ why: "app_mark" });
  });

  it("sends kind plain with every typed value, so a secure field refuses it, and never submits", async () => {
    const s = await setup({
      world: (w) => {
        w.screens["form"]?.elements.push(input("code-test-safe", "Code", { secure: true }));
      },
    });
    await s.tools.explore({ fill: "test-data" });
    expect(s.world.typed.map((t) => t.id)).not.toContain("code-test-safe");
    expect(s.world.typed.map((t) => t.id)).toContain("name-test-safe");
    expect(s.world.typeParams.length).toBeGreaterThan(0);
    for (const sent of s.world.typeParams) {
      expect(sent.kind).toBe("plain");
      expect(sent.submit).toBe(false);
    }
  });

  it("types nowhere when the app can't answer a dry run (secureness unknown)", async () => {
    const s = await setup({ capabilities: EXPLORE_CAPS.filter((c) => c !== "dryRun") });
    await s.tools.explore({ fill: "test-data" });
    expect(s.world.typed).toEqual([]);
  });
});

describe("R1 finding 3: the real recipient is checked against the whole floor", () => {
  it("skips an Open control whose dry run resolves to an exploreSkip parent", async () => {
    const s = await setup({
      world: (w) => {
        w.screens["home"]?.elements.push(btn("open-guarded", "Open"));
        w.recipient["open-guarded"] = btn("guard-parent", "Parent", { exploreSkip: true });
      },
    });
    await s.tools.explore({});
    expect(s.world.pressed).not.toContain("open-guarded");
    expect(skipOf(s, "id:open-guarded")).toMatchObject({ why: "app_mark" });
  });

  it("skips an Open control on a screen with an input when it resolves to Submit", async () => {
    const s = await setup({
      world: (w) => {
        w.screens["form"]?.elements.push(btn("open-sub", "Open"));
        w.recipient["open-sub"] = btn("sub-parent", "Submit");
      },
    });
    await s.tools.explore({});
    expect(s.world.pressed).not.toContain("open-sub");
    expect(skipOf(s, "id:open-sub")).toMatchObject({ why: "may_submit", word: "Submit" });
  });

  it("skips a control that resolves to a password field or a card field", async () => {
    const s = await setup({
      world: (w) => {
        w.screens["home"]?.elements.push(btn("open-pw", "Open"), btn("open-card", "Show"));
        w.recipient["open-pw"] = input("password", "Password");
        w.recipient["open-card"] = input("card-field", "Number", { placeholder: "Card number" });
      },
    });
    await s.tools.explore({});
    expect(s.world.pressed).not.toContain("open-pw");
    expect(s.world.pressed).not.toContain("open-card");
  });
});

describe("R1 finding 4: an app override never lowers the floor", () => {
  it("skips Archive when the global policy lists it and the app's own lists are empty", async () => {
    const s = await setup({
      policy: { version: 1, confirm: ["Archive"], block: [], apps: { [APP.id]: { confirm: [], block: [] } } },
      world: (w) => {
        w.screens["home"]?.elements.push(btn("archive-it", "Archive"));
      },
    });
    await s.tools.explore({});
    expect(s.world.pressed).not.toContain("archive-it");
    expect(skipOf(s, "id:archive-it")).toMatchObject({ why: "policy", word: "Archive" });
  });

  it("keeps an ordinary tap's replacement semantics outside explore", async () => {
    const s = await setup({
      policy: { version: 1, confirm: ["Archive"], block: [], apps: { [APP.id]: { confirm: [], block: [] } } },
      world: (w) => {
        w.screens["home"]?.elements.push(btn("archive-it", "Archive"));
      },
    });
    const answer = await s.tools.tap({ target: { id: "archive-it" } });
    expect(answer.isError).not.toBe(true);
    expect(s.world.pressed).toContain("archive-it");
  });
});

describe("R1 finding 5: protected places also read the live screen title", () => {
  it("protects settings/profile when the screen's title says Account", async () => {
    const s = await setup({
      world: (w) => {
        w.screens["profile"] = { route: ["settings", "profile"], parent: "settings", elements: [header("Account"), btn("rename", "Rename")] };
        w.screens["settings"]?.elements.push(btn("open-profile", "Profile"));
        w.goes["settings|open-profile"] = "profile";
      },
    });
    await s.tools.explore({});
    expect(s.world.pressed).toContain("open-profile");
    expect(s.world.pressed).not.toContain("rename");
    expect(skipOf(s, "id:rename")).toMatchObject({ why: "floor", word: "account" });
    expect(reportOf(s).notes.join("\n")).toContain("is saved and not expanded");
  });
});

describe("R1: the pure rules", () => {
  it("reads the live titles for a protected place, and takes only header elements as titles", () => {
    expect(protectedPlaceWord("profile", ["settings", "profile"])).toBeNull();
    expect(protectedPlaceWord("profile", ["settings", "profile"], ["Account"])).toBe("account");
    expect(protectedPlaceWord("profile", undefined, ["Privacy & Security"])).toBe("privacy");
    expect(screenTitles([{ role: "header", text: "Account" }, { role: "text", text: "Billing" }, { role: "header", label: "Wallet" }])).toEqual(["Account", "Wallet"]);
  });

  it("unions the global and the app's lists, and an app's empty lists lower nothing", () => {
    const policy: PolicyFile = { version: 1, confirm: ["Archive"], block: ["Wipe"], apps: { [APP.id]: { confirm: ["Mute"], block: [] } } };
    expect(exploreLists(policy, APP)).toEqual({ confirm: ["Archive", "Mute"], block: ["Wipe"] });
    expect(exploreLists({ version: 1, confirm: ["Archive"], block: [], apps: { [APP.id]: { confirm: [], block: [] } } }, APP).confirm).toEqual(["Archive"]);
  });

  it("checks a recipient against the marks, secret fields and the submit rule", () => {
    const rules = { policy: [], skip: [], submit: ["go"] };
    expect(recipientVerdict({ label: "Parent", testID: "p", exploreSkip: true }, rules, false)).toEqual({ why: "app_mark" });
    expect(recipientVerdict({ role: "input", label: "Card number", testID: "c" }, rules, false)).toMatchObject({ why: "floor" });
    expect(recipientVerdict({ role: "input", label: "Nickname", placeholder: "Secret word", testID: "n" }, rules, false)).toMatchObject({ why: "floor" });
    expect(recipientVerdict({ label: "Submit", testID: "s" }, rules, true)).toEqual({ why: "may_submit", word: "Submit" });
    expect(recipientVerdict({ label: "Submit", testID: "s" }, rules, false)).toBeNull();
    expect(recipientVerdict({ label: "Submit", testID: "go" }, rules, true)).toBeNull();
  });
});

describe("R1 finding 6: typed text never survives in findings, logs, the report or the map", () => {
  it("redacts a typed email an app error echoes", async () => {
    const s = await setup({
      policy: { version: 1, confirm: [], block: [], explore: { submit: ["save-profile"] } },
      world: (w) => {
        w.errorOn["save-profile"] = "Request failed for test@example.com: 500";
      },
    });
    await s.tools.explore({ fill: "test-data" });
    expect(s.world.typed.map((t) => t.text)).toContain("test@example.com");
    expect(reportOf(s).findings.some((f) => f.kind === "js_error")).toBe(true);
    await s.registry.flushAll();
    for (const file of filesUnder(lastRun(s))) expect(readFileSync(join(lastRun(s), file), "utf8")).not.toContain("test@example.com");
    expect(readFileSync(join(s.folder, "map.json"), "utf8")).not.toContain("test@example.com");
  });
});
