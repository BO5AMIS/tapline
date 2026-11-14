import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAccounts, substituteAccount, type GitProbe } from "../src/accounts.js";
import { exploreArgs } from "../src/explorecmd.js";
import type { TaplineHost } from "../src/server.js";
import { APP } from "./drive-helpers.js";
import { EXPLORE_CAPS, flushExploreMaps, input, setupExplore, type ExploreSetup, type ExploreSetupOptions } from "./explore-helpers.js";
import type { FakeApp } from "./helpers.js";

// AGENT-TOOLS 1.16 section 20.1, 25.2, 25.6, 28.4: the vault kind `fixture`, plain test data that `fill` and the SDK prop can type.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await flushExploreMaps();
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const OUTSIDE: GitProbe = { insideWorkTree: async () => false, ignored: async () => false };
const CAPS = [...EXPLORE_CAPS, "typeKind"];

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "tapline-fixture-"));
  dirs.push(dir);
  return dir;
};

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

const DESTINATION = "Lisbon-Alfama-Tram-28-Route";
const NOTE = "bring-the-blue-umbrella-please";

async function withVault(vault: Record<string, unknown>, options: ExploreSetupOptions = {}): Promise<ExploreSetup> {
  const file = join(tmp(), "vault.json");
  writeFileSync(file, JSON.stringify({ version: 2, vault }));
  const loaded = await loadAccounts(file, OUTSIDE);
  if (loaded.store === null) throw new Error(`vault not loaded: ${"blocked" in loaded ? loaded.blocked : ""}`);
  return setupExplore(hosts, apps, dirs, {
    capabilities: CAPS,
    ...options,
    hostOptions: { redact: loaded.store.redact, ...options.hostOptions },
    tools: { accounts: loaded, ...options.tools },
  });
}

const trip = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ trip_data: { kind: "fixture", destination: DESTINATION, party_size: "2", memo: NOTE, explore: true, ...extra } });

/** Every file of the run and the map must hold none of the values, any 12-character piece of them, or their usual encodings. */
async function expectNoneIn(s: ExploreSetup, values: string[]): Promise<void> {
  const forms = (value: string): string[] => [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), Buffer.from(value).toString("base64")];
  const pieces = (value: string): string[] => (value.length < 12 ? [] : Array.from({ length: value.length - 11 }, (_, n) => value.slice(n, n + 12)));
  const run = lastRun(s);
  await s.registry.flushAll();
  const files = [...filesUnder(run).filter((f) => !f.endsWith(".jpg")).map((f) => join(run, f)), join(s.folder, "map.json")];
  expect(files.length).toBeGreaterThan(2);
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const value of values) for (const form of [...forms(value), ...pieces(value)]) expect(text, `${file} holds ${form}`).not.toContain(form);
  }
}

describe("the fixture kind loads (section 20.1)", () => {
  it("is plain data with any fields; its fields are typed by reference, and the old kinds still load", async () => {
    const file = join(tmp(), "vault.json");
    writeFileSync(file, JSON.stringify({ version: 2, vault: { ...trip(), home: { kind: "address", street: "12 Test Lane" } } }));
    const loaded = await loadAccounts(file, OUTSIDE);
    if (loaded.store === null) throw new Error("vault not loaded");
    expect(loaded.store.names().sort()).toEqual(["home", "trip_data"]);
    expect(loaded.store.kindOf("trip_data")).toBe("fixture");
    expect(loaded.store.exploreMarked?.("trip_data")).toBe(true);
    const typed = substituteAccount("${vault.trip_data.destination}", loaded.store, undefined, APP.id);
    expect(typed).toMatchObject({ ok: true, text: DESTINATION, use: { name: "trip_data", kind: "fixture", field: "destination" } });
    const missing = substituteAccount("${vault.trip_data.nothing}", loaded.store, undefined, APP.id);
    expect(missing).toMatchObject({ ok: false, code: "bad_params" });
    expect(JSON.stringify(missing)).not.toContain(DESTINATION);
  });

  it("shows as its placeholder wherever redaction puts one, and a field name must be ASCII letters, digits and _", async () => {
    const file = join(tmp(), "vault.json");
    writeFileSync(file, JSON.stringify({ version: 2, vault: trip() }));
    const loaded = await loadAccounts(file, OUTSIDE);
    if (loaded.store === null) throw new Error("vault not loaded");
    expect(loaded.store.redact(`going to ${DESTINATION} soon`)).toBe("going to <trip_data's destination> soon");
    const bad = join(tmp(), "bad.json");
    writeFileSync(bad, JSON.stringify({ version: 2, vault: { t: { kind: "fixture", "bad-name": "x-value" } } }));
    await expect(loadAccounts(bad, OUTSIDE)).rejects.toThrow(/a fixture's field names use ASCII letters, digits and '_'/);
  });
});

describe("explore types a fixture (section 25.6)", () => {
  const form = (w: Parameters<NonNullable<ExploreSetupOptions["world"]>>[0]): void => {
    w.screens["form"]?.elements.push(
      input("dest", "Where to", { exploreFill: "fixture:trip_data.destination" }),
      input("party", "Party", { exploreFill: "fixture:trip_data.party_size" }),
      input("old-form", "Old form", { exploreFill: "fixture:trip_data" }),
      input("no-field", "No field", { exploreFill: "fixture:trip_data.nothing" }),
      input("pw", "Login word", { exploreFill: "fixture:trip_data.destination", secure: true }),
      input("card-number", "Card number", { exploreFill: "fixture:trip_data.destination" }),
    );
  };

  it("by the SDK prop value fixture:<name>.<field>, as the reference the ordinary path resolves", async () => {
    const s = await withVault(trip(), { world: form });
    await s.tools.explore({ fill: "test-data" });
    const typed = Object.fromEntries(s.world.typed.map((t) => [t.id, t.text]));
    expect(typed["dest"]).toBe(DESTINATION);
    expect(typed["party"]).toBe("2");
    // the old form (no field), a field the fixture hasn't, a secure field and a card field are never typed
    expect(typed["old-form"]).toBeUndefined();
    expect(typed["no-field"]).toBeUndefined();
    expect(typed["pw"]).toBeUndefined();
    expect(typed["card-number"]).toBeUndefined();
    // the app is told the field is plain text, so a secure field would be refused there too
    expect(s.world.typeParams.find((t) => t.id === "dest")?.kind).toBe("plain");
  });

  it("by fill: fixture:<name>.<field> for a field marked only by its id, while the SDK prop wins on its own field", async () => {
    const s = await withVault(trip(), {
      world: (w) => {
        w.screens["form"]?.elements.push(input("trip-test-safe", "Trip"), input("other", "Other", { exploreFill: "fixture:trip_data.party_size" }));
      },
    });
    await s.tools.explore({ fill: "fixture:trip_data.destination" });
    const typed = Object.fromEntries(s.world.typed.map((t) => [t.id, t.text]));
    expect(typed["trip-test-safe"]).toBe(DESTINATION);
    expect(typed["other"]).toBe("2");
    // the id-marked fields of the base world get the fixture field instead of a fake value
    expect(typed["name-test-safe"]).toBe(DESTINATION);
    expect(typed["email-test-safe"]).toBe(DESTINATION);
    // nothing without a marker
    expect(typed["nickname"]).toBeUndefined();
  });

  it("a field marked only by its id gets a fake value under test-data, as before", async () => {
    const s = await withVault(trip());
    await s.tools.explore({ fill: "test-data" });
    const typed = Object.fromEntries(s.world.typed.map((t) => [t.id, t.text]));
    expect(typed["name-test-safe"]).toBe("Test");
    expect(typed["email-test-safe"]).toBe("test@example.com");
  });

  it("is refused without \"explore\": true, by the prop and by the call", async () => {
    const s = await withVault(trip({ explore: undefined }), { world: form });
    await s.tools.explore({ fill: "test-data" });
    const typed = Object.fromEntries(s.world.typed.map((t) => [t.id, t.text]));
    expect(typed["dest"]).toBeUndefined();
    expect(typed["party"]).toBeUndefined();
    const refused = await s.tools.explore({ fill: "fixture:trip_data.destination" });
    expect(refused.isError).toBe(true);
    const said = refused.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(said).toContain('fixture "trip_data" isn\'t marked "explore": true');
    expect(said).not.toContain(DESTINATION);
    expect(s.world.typed.map((t) => t.id)).not.toContain("trip-test-safe");
  });

  it("is refused by the call for a missing fixture, a missing field and a vault entry of another kind", async () => {
    const s = await withVault({ ...trip(), home: { kind: "address", street: "12 Test Lane", explore: true } });
    for (const fill of ["fixture:nope.destination", "fixture:trip_data.nothing", "fixture:home.street"]) {
      const refused = await s.tools.explore({ fill });
      expect(refused.isError, fill).toBe(true);
    }
    expect(s.world.typed).toEqual([]);
  });

  it("is refused into a secure field, and a password field is named in the answer when an agent types it", async () => {
    const s = await withVault(trip(), {
      world: (w) => {
        w.screens["home"]?.elements.push(input("secret-box", "Secret box", { secure: true }));
      },
    });
    const answer = await s.tools.typeText({ target: { id: "secret-box" }, text: "${vault.trip_data.destination}" });
    expect(answer.isError).toBe(true);
    const said = answer.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(said).toMatch(/a fixture goes only into a text field; (e\d+|the field) is a password field/);
    expect(s.world.typed).toEqual([]);
    expect(said).not.toContain(DESTINATION);
  });

  it("an older app without typeKind can't be trusted to keep a fixture out of a password field", async () => {
    const s = await withVault(trip(), { capabilities: EXPLORE_CAPS });
    const answer = await s.tools.typeText({ target: { id: "name-test-safe" }, text: "${vault.trip_data.destination}" });
    expect(answer.isError).toBe(true);
    expect(s.world.typed).toEqual([]);
  });
});

describe("a fixture value is never in plain text in any file (section 20.3)", () => {
  it("not in the report, the findings, the repro scripts or the map: no value, no encoding, no 12-character piece", async () => {
    const s = await withVault(trip(), {
      world: (w) => {
        w.screens["form"]?.elements.push(input("dest", "Where to", { exploreFill: "fixture:trip_data.destination" }), input("memo", "Memo", { exploreFill: "fixture:trip_data.memo" }));
        // an error that quotes what was typed, and a screen that shows it
        w.errorOn["save-profile"] = `save failed for ${DESTINATION} (${NOTE}) and ${encodeURIComponent(DESTINATION)}`;
      },
      policy: { version: 2, confirm: [], block: [], explore: { submit: ["save-profile"] } },
    });
    await s.tools.explore({ fill: "test-data" });
    expect(s.world.typed.find((t) => t.id === "dest")?.text).toBe(DESTINATION);
    expect(s.world.typed.find((t) => t.id === "memo")?.text).toBe(NOTE);
    await expectNoneIn(s, [DESTINATION, NOTE]);
    const report = readFileSync(join(lastRun(s), "report.json"), "utf8");
    expect(report).toContain("save failed for");
    expect(report).toContain("<trip_data's destination>");
  });
});

describe("the call and the command line take fixture:<name>.<field>", () => {
  it("--fill accepts it and refuses a malformed one", () => {
    expect(exploreArgs({ fill: "fixture:trip_data.destination" })).toEqual({ args: { fill: "fixture:trip_data.destination" } });
    expect(exploreArgs({ fill: "fixture:trip_data" })).toMatchObject({ error: expect.stringContaining("--fill") });
    expect(exploreArgs({ fill: "test-data" })).toEqual({ args: { fill: "test-data" } });
  });
});
