import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAccounts, redactAll, vaultStore, type GitProbe } from "../src/accounts.js";
import { OtpCodes } from "../src/otpclient.js";
import type { TaplineHost } from "../src/server.js";
import { btn, flushExploreMaps, input, setupExplore, type ExWorld } from "./explore-helpers.js";
import type { FakeApp } from "./helpers.js";
import { repairRig, textOf } from "./repair-helpers.js";

// PR 13 security review, Codex cycle 4 (R6): the texts a run typed are a source of the SAME matcher as the vault's values and the
// one-time codes, so a typed prefix never splits a longer vault value. All values are made up.

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

async function vaultWith(username: string): Promise<Awaited<ReturnType<typeof loadAccounts>>> {
  const dir = mkdtempSync(join(tmpdir(), "tapline-typed-r6-"));
  dirs.push(dir);
  const file = join(dir, "vault.json");
  writeFileSync(file, JSON.stringify({ version: 2, vault: { tester: { kind: "account", username, password: "hunter-2-horse-battery" } } }));
  const loaded = await loadAccounts(file, OUTSIDE);
  if (loaded.store === null) throw new Error("vault not loaded");
  return loaded;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe("R6: typed texts and vault values are matched together", () => {
  const SECRET = "jane.quill@example.test";

  it("repair: a typed prefix of a vault username never splits it (answer, audit, .repair.md)", async () => {
    const loaded = await vaultWith(SECRET);
    const r = await repairRig(hosts, apps, dirs, {
      tools: { accounts: loaded },
      world: (w: ExWorld) => {
        const home = w.screens["home"];
        if (home === undefined) throw new Error("no home");
        home.elements = [input("email-field", "Email"), btn("open-settings", "Open jane quill at example dot test"), btn("open-trips", "Trips")];
      },
    });
    r.script("signin", [
      { tool: "type_text", target: { id: "email-field" }, text: "jane" },
      { tool: "tap", target: { label: `Open ${SECRET}` }, expect: { id: "notify-switch" } },
    ]);
    const answer = textOf(await r.s.tools.replay({ name: "signin", repair: "apply" }));
    expect(answer).toContain("with 1 repair");
    const audit = JSON.stringify(r.lines.filter((line) => line.kind === "repair"));
    const md = r.read("signin.repair.md");
    for (const text of [answer, audit, md]) {
      expect(text).not.toContain(".quill");
      expect(text).not.toContain("example.test");
      expect(text).not.toContain("${typed}.quill");
    }
    expect(`${answer}${audit}${md}`).toContain("<tester's username>");
  });

  it("explore: the report and the map hold no fragment of a vault value that starts with the typed text", async () => {
    const vaultValue = "test@example.com.vaultcopy";
    const loaded = await vaultWith(vaultValue);
    if (loaded.store === null) throw new Error("vault not loaded");
    const s = await setupExplore(hosts, apps, dirs, {
      hostOptions: { redact: loaded.store.redact },
      tools: { accounts: loaded },
      policy: { version: 1, confirm: [], block: [], explore: { submit: ["save-profile"] } },
      world: (w) => {
        w.errorOn["save-profile"] = `Request failed for ${vaultValue}: 500`;
      },
    });
    await s.tools.explore({ fill: "test-data" });
    expect(s.world.typed.map((t) => t.text)).toContain("test@example.com");
    await s.registry.flushAll();
    const runs = readdirSync(s.exploreDir).sort();
    const folder = join(s.exploreDir, runs[runs.length - 1] as string);
    const files = filesUnder(folder).filter((f) => !f.endsWith(".jpg"));
    files.push(join(s.folder, "map.json"));
    let sawFinding = false;
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toContain("vaultcopy");
      expect(text, file).not.toContain("${typed}.vault");
      if (text.includes("<tester's username>")) sawFinding = true;
    }
    expect(sawFinding).toBe(true);
  });

  const typed = (values: string[]) => ({ values, token: "${typed}" });
  const store = (username: string) => vaultStore({ version: 2, vault: { tester: { kind: "account", username, password: "hunter-2-horse-battery" } } });

  it("a vault value that contains the typed text: the whole value wins", () => {
    const out = redactAll(store("abc-shared-secret-xyz"), new OtpCodes(), "see abc-shared-secret-xyz and abc end", typed(["abc"]));
    expect(out).toBe("see <tester's username> and ${typed} end");
  });

  it("typed text that contains a vault value: the whole typed text wins", () => {
    const out = redactAll(store("shared-secret"), new OtpCodes(), "x prefix-shared-secret-suffix y shared-secret z", typed(["prefix-shared-secret-suffix"]));
    expect(out).toBe("x ${typed} y <tester's username> z");
  });

  it("a one-time code, a vault value and a typed text overlap in one pass", () => {
    const codes = new OtpCodes();
    codes.register("731928");
    const out = redactAll(store("jane.quill@example.test"), codes, "jane.quill@example.test 731928 jane", typed(["jane"]));
    expect(out).toBe("<tester's username> <one-time code> ${typed}");
  });

  it("without a vault, typed texts alone still scrub", () => {
    expect(redactAll(null, new OtpCodes(), "hello jane there", typed(["jane"]))).toBe("hello ${typed} there");
  });

  it("a typed text registered later is matched (the matcher is rebuilt), and 200 KB over 50 accounts stays fast", () => {
    const vault: Record<string, { kind: "account"; username: string; password: string }> = {};
    for (let i = 0; i < 50; i++) vault[`acct${i}`] = { kind: "account", username: `user-name-${i}-abcdef`, password: `pass-word-${i}-ghijkl-XYZ` };
    const st = vaultStore({ version: 2, vault });
    const codes = new OtpCodes();
    const text = `${"The quick brown fox jumps over the lazy dog 12345. ".repeat(4000)} leak pass-word-7-ghijkl-XYZ and user-name-3-abcdef and later`;
    let list = ["fox"];
    expect(redactAll(st, codes, "a fox b", typed(list))).toBe("a ${typed} b");
    expect(redactAll(st, codes, "a later b", typed(list))).toBe("a later b");
    list = [...list, "later"];
    expect(redactAll(st, codes, "a later b", typed(list))).toBe("a ${typed} b");
    redactAll(st, codes, text, typed(list));
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      const out = redactAll(st, codes, text, typed(list));
      times.push(Math.round(performance.now() - t));
      expect(out).not.toContain("ghijkl");
      expect(out).toContain("<acct3's username>");
    }
    console.log(`typed scrub timings (ms): ${times.join(", ")}`);
    expect(Math.min(...times)).toBeLessThan(600);
  });
});
