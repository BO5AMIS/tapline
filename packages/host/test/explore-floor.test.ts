import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { loadAccounts, type GitProbe } from "../src/accounts.js";
import { FLOOR_WORDS, exploreSettings, floorSubject, floorVerdict, isListedSubmit, isSecretField, protectedPlaceWord, submitWord, type FloorRules } from "../src/explorefloor.js";
import type { GrantBook } from "../src/grants.js";
import { NO_POLICY, loadPolicy, type PolicyFile } from "../src/policy.js";
import type { TaplineHost } from "../src/server.js";
import { APP } from "./drive-helpers.js";
import { btn, flushExploreMaps, icon, input, label, setupExplore, toggle, type ExploreSetup, type ExploreSetupOptions } from "./explore-helpers.js";
import type { FakeApp } from "./helpers.js";

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await flushExploreMaps();
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
const setup = (options: ExploreSetupOptions = {}): Promise<ExploreSetup> => setupExplore(hosts, apps, dirs, options);
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "tapline-explore-t-"));
  dirs.push(dir);
  return dir;
};
const NONE: FloorRules = { policy: [], skip: [], submit: [] };

/** Every file under a folder, by relative path. */
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
const reportOf = (s: ExploreSetup) => JSON.parse(readFileSync(join(lastRun(s), "report.json"), "utf8")) as { skipped: Array<{ place: string; sig: string; why: string; word?: string }>; notes: string[]; stopped: string; findings: Array<{ kind: string; path: Array<Record<string, unknown>>; got: string; repro: string | null }> };
const skipOf = (s: ExploreSetup, sig: string): { why: string; word?: string } | undefined => reportOf(s).skipped.find((entry) => entry.sig === sig);

describe("the skip floor (§25.5): the rules", () => {
  it("covers the built-in confirm words, the reach-others words and the never-grantable words", () => {
    for (const word of ["Delete", "Remove", "Sign out", "Log out", "Erase", "Buy", "Purchase", "Subscribe", "Pay", "Send", "Post", "Publish", "Reply", "Comment", "Report", "Block", "Checkout", "Delete account", "Donate"]) {
      expect(FLOOR_WORDS).toContain(word);
      expect(floorVerdict({ label: `${word} now`, text: null, testID: null }, NONE)?.why).toBe("floor");
    }
    expect(floorVerdict({ label: "Credit card", testID: null }, NONE)?.why).toBe("floor");
  });

  it("matches whole words, ignoring case, on the element's own label or text only", () => {
    expect(floorVerdict({ label: "DELETE trip", testID: null }, NONE)?.word).toBe("Delete");
    expect(floorVerdict({ text: "Please sign out here", testID: null }, NONE)?.word).toBe("Sign out");
    expect(floorVerdict({ label: "Deleted items", testID: null }, NONE)).toBeNull();
    expect(floorVerdict({ label: "Postcard", testID: null }, NONE)).toBeNull();
    // An id is never matched for an element that has a label (§11.1 is unchanged).
    expect(floorVerdict({ label: "Open", testID: "delete-row" }, NONE)).toBeNull();
  });

  it("matches an icon-only element on its id split into words (§25.5)", () => {
    expect(floorVerdict({ testID: "delete-row" }, NONE)).toEqual({ why: "floor", word: "Delete" });
    expect(floorVerdict({ testID: "deleteRowButton" }, NONE)).toEqual({ why: "floor", word: "Delete" });
    expect(floorVerdict({ testID: "sign_out_icon" }, NONE)).toEqual({ why: "floor", word: "Sign out" });
    expect(floorVerdict({ testID: "chevron-right" }, NONE)).toBeNull();
    expect(floorSubject({ label: "", text: "", testID: "pay-now" })).toEqual({ label: "pay now" });
    expect(floorSubject({ label: "Pay", testID: "x" })).toEqual({ label: "Pay", text: "" });
  });

  it("adds the policy file's words, a user's skip list and the app's own mark, and never takes any away", () => {
    const rules: FloorRules = { policy: ["Archive"], skip: ["Rename"], submit: [] };
    expect(floorVerdict({ label: "Archive", testID: null }, rules)).toEqual({ why: "policy", word: "Archive" });
    expect(floorVerdict({ label: "Rename", testID: null }, rules)).toEqual({ why: "skip_list", word: "Rename" });
    expect(floorVerdict({ label: "Open", testID: null, exploreSkip: true }, rules)).toEqual({ why: "app_mark" });
    // The floor is checked first: a policy that lists a built-in word still gives `floor`.
    expect(floorVerdict({ label: "Delete", testID: null }, { policy: ["Delete"], skip: ["Delete"], submit: [] })?.why).toBe("floor");
    expect(floorVerdict({ label: "Open", testID: null }, rules)).toBeNull();
  });

  it("reads `explore` in a policy file of any version, forgivingly", () => {
    const dir = tmp();
    const file = join(dir, "policy.json");
    writeFileSync(file, JSON.stringify({ version: 1, explore: { skip: ["Archive", 3], submit: ["save-profile"], other: true } }));
    expect(exploreSettings(loadPolicy(file))).toEqual({ skip: ["Archive"], submit: ["save-profile"] });
    writeFileSync(file, JSON.stringify({ version: 2, confirm: [], explore: "nonsense" }));
    expect(exploreSettings(loadPolicy(file))).toEqual({ skip: [], submit: [] });
    expect(exploreSettings(NO_POLICY)).toEqual({ skip: [], submit: [] });
  });

  it("knows a control that may submit, a listed one, a protected place and a secret field", () => {
    for (const word of ["Save", "Submit", "Continue", "Sign in", "Log in", "Sign up", "Register", "Create", "Confirm", "Apply", "Update", "Share"]) expect(submitWord({ label: word, testID: null })).toBe(word);
    expect(submitWord({ label: "Saved", testID: null })).toBeNull();
    expect(isListedSubmit({ testID: "save-profile" }, { policy: [], skip: [], submit: ["save-profile"] })).toBe(true);
    expect(isListedSubmit({ testID: "save-profile" }, NONE)).toBe(false);
    expect(protectedPlaceWord("settings_account", ["settings", "account"])).toBe("account");
    expect(protectedPlaceWord("privacy", undefined)).toBe("privacy");
    expect(protectedPlaceWord("settings", ["settings"])).toBeNull();
    for (const field of [{ testID: "password" }, { label: "Card number" }, { testID: "cvv-input" }, { placeholder: "PIN" }]) expect(isSecretField(field)).toBe(true);
    expect(isSecretField({ testID: "name", label: "Name" })).toBe(false);
  });
});

describe("explore never touches what the floor covers (§25.5)", () => {
  it("presses none of the Delete, Sign out, Pay, Send, Report and Block buttons, nor an icon-only delete-row, and lists them as skipped", async () => {
    const s = await setup();
    await s.tools.explore({});
    for (const id of ["delete-all", "sign-out", "delete-row", "pay-now", "send-note", "report-user", "block-user"]) expect(s.world.pressed).not.toContain(id);
    expect(skipOf(s, "id:sign-out")).toEqual({ place: "home", sig: "id:sign-out", why: "floor", word: "Sign out" });
    expect(skipOf(s, "id:delete-row")).toMatchObject({ why: "floor", word: "Delete" });
    expect(skipOf(s, "id:pay-now")).toMatchObject({ why: "floor", word: "Pay" });
    await s.registry.flushAll();
    expect(s.file().places["home"]?.explored?.actions.find((a) => a.sig === "id:delete-all")).toMatchObject({ result: "skipped", why: "floor", word: "Delete" });
    // A skipped element is no finding.
    expect(reportOf(s).findings).toEqual([]);
  });

  it("is not lowered by a policy file with \"confirm\": [] or by --no-policy", async () => {
    for (const policy of [{ version: 1, confirm: [], block: [] } satisfies PolicyFile, NO_POLICY]) {
      const s = await setup({ policy });
      await s.tools.explore({});
      expect(s.world.pressed).not.toContain("delete-all");
      expect(s.world.pressed).not.toContain("sign-out");
      expect(skipOf(s, "id:delete-all")?.why).toBe("floor");
    }
  });

  it("adds the policy file's words (global and the app's), the user's skip list and the app's mark, with the right `why`", async () => {
    const s = await setup({
      policy: { version: 2, confirm: ["Language"], block: [], apps: { [APP.id]: { confirm: ["Language"], block: ["About"] } }, explore: { skip: ["Help"] } },
      world: (w) => {
        const language = w.screens["language"];
        if (language !== undefined) language.elements = [btn("pick-english", "English", { exploreSkip: true })];
        w.screens["settings"]?.elements.push(btn("open-help", "Help"));
      },
    });
    await s.tools.explore({});
    expect(s.world.pressed).not.toContain("open-language");
    expect(s.world.pressed).not.toContain("reset-switch-label");
    expect(s.world.pressed).not.toContain("open-help");
    expect(skipOf(s, "id:open-language")).toEqual({ place: "settings", sig: "id:open-language", why: "policy", word: "Language" });
    expect(skipOf(s, "id:reset-switch-label")).toMatchObject({ why: "policy", word: "About" });
    expect(skipOf(s, "id:open-help")).toMatchObject({ why: "skip_list", word: "Help" });
  });

  it("never touches an element the app marks with the skip prop", async () => {
    const s = await setup({
      world: (w) => {
        w.screens["settings"]?.elements.push(btn("sparkle", "Sparkle", { exploreSkip: true }));
      },
    });
    await s.tools.explore({});
    expect(s.world.pressed).not.toContain("sparkle");
    expect(skipOf(s, "id:sparkle")).toEqual({ place: "settings", sig: "id:sparkle", why: "app_mark" });
  });

  it("checks the floor again at every touch: a saved skip allows nothing, and a new policy word counts at once", async () => {
    const s = await setup();
    await s.tools.explore({});
    await s.registry.flushAll();
    // A map that says `open-language` was tried and is fine; the policy now names Language: a fresh place, nothing is tried again, nothing is touched.
    s.world.pressed.length = 0;
    const again = await s.tools.explore({});
    expect(again.isError).not.toBe(true);
    expect(s.world.pressed).toEqual([]);
    const second = await setup({ policy: { version: 1, confirm: ["Language"], block: [] } });
    await second.tools.explore({});
    expect(second.world.pressed).not.toContain("open-language");
  });

  it("stops a touch whose real recipient carries a floor or policy word, and skips it as a policy skip", async () => {
    const s = await setup({
      policy: { version: 1, confirm: ["Archive"], block: [] },
      world: (w) => {
        // The control named "Open" hands its touch to a parent labelled Archive; another to an icon-only trash button.
        w.screens["home"]?.elements.push(btn("open-archive", "Open"), btn("open-bin", "Bin"));
        w.recipient["open-archive"] = btn("archive-parent", "Archive");
        w.recipient["open-bin"] = icon("delete-bin");
      },
    });
    await s.tools.explore({});
    expect(s.world.pressed).not.toContain("open-archive");
    expect(s.world.pressed).not.toContain("open-bin");
    expect(skipOf(s, "id:open-archive")).toMatchObject({ why: "policy", word: "Archive" });
    expect(skipOf(s, "id:open-bin")).toMatchObject({ why: "policy", word: "Delete" });
    expect(reportOf(s).findings).toEqual([]);
  });

  it("looks at no grant, counts no use and shows no dialog and no live-view request (§25.5)", async () => {
    let decided = 0;
    let asked = 0;
    const grants = { decide: async () => { decided += 1; return { kind: "ask", asked: [], notes: [] }; }, stillCovers: async () => { decided += 1; return true; }, inspect: async () => ({ refused: [], broken: null }) } as unknown as GrantBook;
    const dialogs = { available: () => true, askOk: async () => { asked += 1; return "allow"; }, askDraft: async () => { asked += 1; return "allow"; } };
    const s = await setup({
      policy: { version: 1, confirm: ["Archive"], block: [] },
      tools: { grants, dialogs: dialogs as unknown as NonNullable<ExploreSetupOptions["tools"]>["dialogs"] },
      world: (w) => {
        w.screens["home"]?.elements.push(btn("open-archive", "Open"));
        w.recipient["open-archive"] = btn("archive-parent", "Archive");
      },
    });
    await s.tools.explore({});
    expect(decided).toBe(0);
    expect(asked).toBe(0);
    expect(s.world.pressed).not.toContain("open-archive");
    expect(s.tools.confirmations.open()).toEqual([]);
  });

  it("saves a place whose name says account, privacy or security, and does not expand it", async () => {
    const s = await setup({
      world: (w) => {
        w.screens["account"] = { route: ["settings", "account"], parent: "settings", elements: [btn("rename", "Rename"), btn("about-me", "About me")] };
        w.screens["settings"]?.elements.push(btn("open-account", "Profile"));
        w.goes["settings|open-account"] = "account";
      },
    });
    await s.tools.explore({});
    expect(s.world.pressed).toContain("open-account");
    expect(s.world.pressed).not.toContain("rename");
    expect(s.world.pressed).not.toContain("about-me");
    expect(skipOf(s, "id:rename")).toMatchObject({ place: "account", why: "floor", word: "account" });
    expect(reportOf(s).notes.join("\n")).toContain("an account, privacy or security place (account) is saved and not expanded");
  });
});

describe("explore: typing and fill (§25.6)", () => {
  it("never types with fill: none, and only reads an input", async () => {
    const s = await setup();
    await s.tools.explore({});
    expect(s.world.typed).toEqual([]);
    expect(s.world.asked).not.toContain("type");
  });

  it("with test-data types only into fields the app marks safe, fake values only, never a password or a card", async () => {
    const s = await setup({
      world: (w) => {
        w.screens["form"]?.elements.push(input("password-test-safe", "Backup word"), input("card-number-test-safe", "Number"), input("pin-test-safe", "Code"));
      },
    });
    await s.tools.explore({ fill: "test-data" });
    expect(s.world.typed).toEqual([
      { id: "name-test-safe", text: "Test" },
      { id: "email-test-safe", text: "test@example.com" },
    ]);
    // Nothing is typed in a field with no marker, and no submit is ever passed.
    expect(s.world.typed.map((t) => t.id)).not.toContain("nickname");
    expect(s.world.typed.map((t) => t.id)).not.toContain("password");
  });

  it("types a fake value into a field the SDK prop marks, and a vault value by reference only from an entry marked explore", async () => {
    const dir = tmp();
    const file = join(dir, "vault.json");
    writeFileSync(file, JSON.stringify({ version: 2, vault: { home: { kind: "address", street: "12 Test Lane", city: "Testville", explore: true }, tester: { kind: "account", username: "ex-user-4821", password: "ex-pass-7734", explore: true }, plain: { kind: "address", street: "99 Hidden Road" } } }));
    const OUTSIDE: GitProbe = { insideWorkTree: async () => false, ignored: async () => false };
    const loaded = await loadAccounts(file, OUTSIDE);
    if (loaded.store === null) throw new Error("vault not loaded");
    const s = await setup({
      hostOptions: { redact: loaded.store.redact },
      tools: { accounts: loaded },
      world: (w) => {
        w.screens["form"]?.elements.push(
          input("nick", "Nick", { exploreFill: true }),
          input("street", "Street", { exploreFill: "vault:home.street" }),
          input("hidden-street", "Other street", { exploreFill: "vault:plain.street" }),
          input("pw", "Login word", { exploreFill: "vault:tester.password" }),
          input("fx", "Fixture", { exploreFill: "fixture:sample_trip" }),
        );
      },
    });
    await s.tools.explore({ fill: "test-data" });
    const typed = Object.fromEntries(s.world.typed.map((t) => [t.id, t.text]));
    expect(typed["nick"]).toBe("Test");
    expect(typed["street"]).toBe("12 Test Lane");
    expect(typed["hidden-street"]).toBeUndefined();
    expect(typed["pw"]).toBeUndefined();
    expect(typed["fx"]).toBeUndefined();
    // The vault value never reaches a file of the run, the map or a repro.
    for (const file of filesUnder(lastRun(s))) expect(readFileSync(join(lastRun(s), file), "utf8")).not.toContain("12 Test Lane");
    await s.registry.flushAll();
    expect(readFileSync(join(s.folder, "map.json"), "utf8")).not.toContain("12 Test Lane");
  });

  it("keeps nothing it typed: a finding's path shows ${typed}, and no file holds the text (§25.6, §27.1)", async () => {
    const s = await setup({
      world: (w) => {
        w.errorOn["save-profile"] = "save failed";
      },
      policy: { version: 2, confirm: [], block: [], explore: { submit: ["save-profile"] } },
    });
    await s.tools.explore({ fill: "test-data" });
    const report = reportOf(s);
    const finding = report.findings.find((f) => f.kind === "js_error");
    expect(finding?.path.map((step) => step["tool"])).toEqual(["tap", "type_text", "type_text", "tap"]);
    expect(finding?.path.filter((step) => step["tool"] === "type_text").map((step) => step["text"])).toEqual(["${typed}", "${typed}"]);
    const repro = JSON.parse(readFileSync(join(lastRun(s), finding?.repro as string), "utf8")) as { version: number; variables: string[]; start: string };
    expect(repro).toMatchObject({ format: "agent-tools-script", version: 2, start: "home", variables: ["typed"] });
    for (const file of filesUnder(lastRun(s))) expect(readFileSync(join(lastRun(s), file), "utf8")).not.toContain("test@example.com");
    await s.registry.flushAll();
    expect(readFileSync(join(s.folder, "map.json"), "utf8")).not.toContain("test@example.com");
  });
});

describe("explore: submitting (§25.7)", () => {
  it("skips a control that may submit on a screen with a text input, unless its id is in the policy's submit list", async () => {
    const s = await setup();
    await s.tools.explore({});
    expect(s.world.pressed).not.toContain("save-profile");
    expect(skipOf(s, "id:save-profile")).toEqual({ place: "form", sig: "id:save-profile", why: "may_submit", word: "Save" });
    const listed = await setup({ policy: { version: 1, confirm: [], block: [], explore: { submit: ["save-profile"] } } as PolicyFile });
    await listed.tools.explore({});
    expect(listed.world.pressed).toContain("save-profile");
  });

  it("lets the floor win over the submit list: a listed control that says Post is never touched", async () => {
    const s = await setup({
      policy: { version: 1, confirm: [], block: [], explore: { submit: ["save-profile", "post-profile"] } } as PolicyFile,
      world: (w) => {
        w.screens["form"]?.elements.push(btn("post-profile", "Save and Post"));
      },
    });
    await s.tools.explore({});
    expect(s.world.pressed).toContain("save-profile");
    expect(s.world.pressed).not.toContain("post-profile");
    expect(skipOf(s, "id:post-profile")).toMatchObject({ why: "floor", word: "Post" });
  });

  it("on a screen where it typed, makes no move but back and the controls in submit", async () => {
    const s = await setup({
      policy: { version: 1, confirm: [], block: [], explore: { submit: ["save-profile"] } } as PolicyFile,
      world: (w) => {
        w.screens["form"]?.elements.push(btn("later", "Later"));
        w.onPress = (id) => {
          if (id === "save-profile") expect(s.world.typed.length).toBe(2);
        };
      },
    });
    await s.tools.explore({ fill: "test-data" });
    expect(s.world.typed).toHaveLength(2);
    expect(s.world.pressed).toContain("save-profile");
    expect(s.world.pressed).toContain("later");
  });
});

describe("explore: toggles (§25.7)", () => {
  it("flips a toggle and flips it back, and reads the value again", async () => {
    const s = await setup();
    await s.tools.explore({});
    expect(s.world.toggles["notify-switch"]).toBe(false);
    expect(s.world.pressed.filter((id) => id === "notify-switch")).toHaveLength(2);
    await s.registry.flushAll();
    expect(s.file().places["settings"]?.explored?.actions.find((a) => a.sig === "id:notify-switch")?.result).toBe("same");
  });

  it("puts a toggle that was on back to on", async () => {
    const s = await setup({
      world: (w) => {
        w.toggles["notify-switch"] = true;
        const el = w.screens["settings"]?.elements[0];
        if (el !== undefined) el.checked = true;
      },
    });
    await s.tools.explore({});
    expect(s.world.toggles["notify-switch"]).toBe(true);
  });

  it("never flips a toggle with a floor word, and doesn't flip one whose value can't be read", async () => {
    const s = await setup({
      world: (w) => {
        const settings = w.screens["settings"];
        settings?.elements.push(toggle("delete-data-switch", "Delete my data", { checked: false }), { id: "mystery-switch", label: "Mystery", role: "switch", type: "Switch", actions: ["toggle"] });
        w.toggles["delete-data-switch"] = false;
      },
    });
    await s.tools.explore({});
    expect(s.world.pressed).not.toContain("delete-data-switch");
    expect(s.world.pressed).not.toContain("mystery-switch");
    expect(skipOf(s, "id:delete-data-switch")).toMatchObject({ why: "floor", word: "Delete" });
    expect(reportOf(s).notes.join("\n")).toContain("id:mystery-switch is a toggle whose value can't be read");
  });

  it("stops the run when a flip can't be shown to be restored, and names the toggle", async () => {
    const s = await setup({
      world: (w) => {
        w.stuckToggles.add("notify-switch");
      },
    });
    const answer = await s.tools.explore({});
    expect(answer.isError).not.toBe(true);
    expect(textOf(answer)).toContain("Stopped: a toggle could not be set back (id=notify-switch).");
    expect(reportOf(s).stopped).toBe("toggle_not_restored");
    expect(s.world.toggles["notify-switch"]).toBe(true);
  });
});

describe("explore: staying inside the app (§25.7)", () => {
  it("records a link out as a dead_end finding and goes on once the app is back", async () => {
    const s = await setup({
      tools: { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20))), exploreGraceMs: 2000 },
      world: (w) => {
        w.screens["home"]?.elements.push(btn("open-docs", "Docs"));
        w.leaveOn.add("open-docs");
        w.comeBackMs = 40;
      },
    });
    const answer = await s.tools.explore({});
    expect(textOf(answer)).toContain("Findings: 1 dead_end.");
    const report = reportOf(s);
    const finding = report.findings.find((f) => f.kind === "dead_end");
    expect(finding?.got).toBe("the move left the app");
    await s.registry.flushAll();
    expect(s.file().places["home"]?.explored?.actions.find((a) => a.sig === "id:open-docs")?.result).toBe("left");
    // The search went on after it: the other places were explored.
    expect(Object.keys(s.file().places)).toEqual(expect.arrayContaining(["settings", "trips", "form"]));
    expect(report.stopped).toBe("frontier_empty");
  });

  it("ends the run when the app never comes back (Stopped: the app is closed)", async () => {
    const s = await setup({
      world: (w) => {
        w.screens["home"]?.elements.unshift(btn("open-docs", "Docs"));
        w.leaveOn.add("open-docs");
      },
    });
    const answer = await s.tools.explore({});
    expect(textOf(answer)).toContain("Stopped: the app is closed.");
    expect(reportOf(s).stopped).toBe("app_closed");
  });

  it("never allows a system permission prompt: it stops the branch, says so, and the app is reset", async () => {
    const s = await setup({
      world: (w) => {
        w.screens["settings"]?.elements.push(btn("ask-notify", "Notify me"));
        w.alertOn.add("ask-notify");
      },
    });
    const answer = await s.tools.explore({});
    expect(answer.isError).not.toBe(true);
    const report = reportOf(s);
    // Not a finding.
    expect(report.findings).toEqual([]);
    expect(report.notes.join("\n")).toMatch(/a system alert stopped the branch at settings: a person has to answer it \(it is never allowed\)/);
    expect(s.world.reloads).toBeGreaterThanOrEqual(1);
    expect(report.stopped).toBe("frontier_empty");
  });
});
