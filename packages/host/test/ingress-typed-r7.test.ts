import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ingressRedactor, loadAccounts, vaultStore, type GitProbe } from "../src/accounts.js";
import { OtpCodes } from "../src/otpclient.js";
import type { TaplineHost } from "../src/server.js";
import { btn, flushExploreMaps, input, setupExplore, type ExWorld } from "./explore-helpers.js";
import { FakeApp, startHost } from "./helpers.js";
import { repairRig, textOf } from "./repair-helpers.js";

// PR 13 security review, Codex cycle 5 (R7): the host's ingress redaction (every reply and event the app sends) uses the same
// combined matcher as the downstream scrubbers, with the active run's typed texts as a source, so a typed value that overlaps a
// vault value is matched whole against the original text. These tests run with the host's redaction ON. All values are made up.

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

type Loaded = Awaited<ReturnType<typeof loadAccounts>>;

async function vaultWith(username: string): Promise<Loaded> {
  const dir = mkdtempSync(join(tmpdir(), "tapline-ingress-r7-"));
  dirs.push(dir);
  const file = join(dir, "vault.json");
  writeFileSync(file, JSON.stringify({ version: 2, vault: { tester: { kind: "account", username, password: "hunter-2-horse-battery" } } }));
  const loaded = await loadAccounts(file, OUTSIDE);
  if (loaded.store === null) throw new Error("vault not loaded");
  return loaded;
}

/** The host option the real runtime builds: vault, codes and the active run's typed texts in one matcher. */
function ingress(loaded: Loaded): { redact: ReturnType<typeof ingressRedactor> } {
  const store = loaded.store;
  return { redact: ingressRedactor(() => store, new OtpCodes()) };
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/** A text that was altered by a vault match inside a typed value shows one of these. */
function expectClean(label: string, text: string, forbidden: string[]): void {
  for (const piece of forbidden) expect(text, `${label}: ${piece}`).not.toContain(piece);
}

async function repairCase(vaultUser: string, typedText: string, forbidden: string[]): Promise<void> {
  const loaded = await vaultWith(vaultUser);
  const r = await repairRig(hosts, apps, dirs, {
    hostOptions: ingress(loaded),
    tools: { accounts: loaded },
    world: (w: ExWorld) => {
      const home = w.screens["home"];
      if (home === undefined) throw new Error("no home");
      home.elements = [input("email-field", "Email"), btn("open-settings", `Open ${typedText}`), btn("open-trips", "Trips")];
    },
  });
  r.script("signin", [
    { tool: "type_text", target: { id: "email-field" }, text: typedText },
    { tool: "tap", target: { id: "open-settings-btn" }, expect: { id: "notify-switch" } },
  ]);
  const answer = textOf(await r.s.tools.replay({ name: "signin", repair: "apply" }));
  expect(answer).toContain("with 1 repair");
  const audit = JSON.stringify(r.lines.filter((line) => line.kind === "repair"));
  const md = r.read("signin.repair.md");
  const maps = filesUnder(r.s.folder).map((file) => readFileSync(file, "utf8"));
  for (const [label, text] of [["answer", answer], ["audit", audit], [".repair.md", md], ...maps.map((m): [string, string] => ["map", m])] as Array<[string, string]>) {
    expectClean(label, text, forbidden);
  }
  expect(md).toContain("${typed}");
}

async function exploreCase(vaultUser: string, typedText: string, forbidden: string[]): Promise<void> {
  const loaded = await vaultWith(vaultUser);
  const s = await setupExplore(hosts, apps, dirs, {
    hostOptions: ingress(loaded),
    tools: { accounts: loaded },
    policy: { version: 1, confirm: [], block: [], explore: { submit: ["save-profile"] } },
    world: (w) => {
      w.errorOn["save-profile"] = `Request failed for ${typedText}: 500`;
    },
  });
  await s.tools.explore({ fill: "test-data" });
  expect(s.world.typed.map((t) => t.text)).toContain(typedText);
  await s.registry.flushAll();
  const runs = readdirSync(s.exploreDir).sort();
  const folder = join(s.exploreDir, runs[runs.length - 1] as string);
  const files = filesUnder(folder).filter((f) => !f.endsWith(".jpg"));
  files.push(join(s.folder, "map.json"));
  expect(files.some((f) => f.endsWith("report.md"))).toBe(true);
  expect(files.some((f) => f.endsWith("report.json"))).toBe(true);
  let sawPlaceholder = false;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    expectClean(file, text, forbidden);
    if (text.includes("${typed}")) sawPlaceholder = true;
  }
  expect(sawPlaceholder).toBe(true);
}

describe("R7: ingress redaction matches vault values, codes and typed texts together", () => {
  it("repair: a typed email that contains the vault username (the reported repro)", async () => {
    await repairCase("jane", "jane.quill@example.test", [".quill", "example.test", "<tester's username>.quill", "@example"]);
  });

  it("repair: a vault username that contains the typed text", async () => {
    await repairCase("jane.quill@example.test", "jane.quill", ["example.test", "@example", "${typed}@"]);
  });

  it("explore: a typed email that contains the vault username (the reported repro)", async () => {
    await exploreCase("ample", "test@example.com", ["test@ex", "@example", "example.com", "<tester's username>.com"]);
  });

  it("explore: a vault username that contains the typed text", async () => {
    await exploreCase("test@example.com.vaultcopy", "test@example.com", ["vaultcopy", "${typed}.vault"]);
  });

  it("the typed list is cumulative for the session: a value stays scrubbed after its run ends, also in a reply that arrives after end", async () => {
    const loaded = await vaultWith("jane");
    const { host, port } = await startHost(ingress(loaded));
    hosts.push(host);
    const scrub = (text: string): string => host.redactOut(text);
    expect(scrub("a jane.quill@example.test b")).toBe("a <tester's username>.quill@example.test b");
    const run = host.typedRun();
    run.add("jane.quill@example.test");
    expect(scrub("a jane.quill@example.test b")).toBe("a ${typed} b");
    run.end();
    run.end();
    expect(scrub("a jane.quill@example.test b")).toBe("a ${typed} b");
    // A real reply from a connected app, requested after the run ended.
    const { app } = await FakeApp.connect(port, {}, () => ({ ok: true, result: { stack: "at x (jane.quill@example.test)", note: "jane.quill@example.test" } }));
    apps.push(app);
    const answer = await host.request("anything");
    expect(JSON.stringify(answer)).not.toContain("quill");
    expect(answer).toEqual({ stack: "at x (${typed})", note: "${typed}" });
  });

  it("200 accumulated typed texts: a 200 KB scrub over 50 accounts stays under 300 ms warm", () => {
    const vault: Record<string, { kind: "account"; username: string; password: string }> = {};
    for (let i = 0; i < 50; i++) vault[`acct${i}`] = { kind: "account", username: `user-name-${i}-abcdef`, password: `pass-word-${i}-ghijkl-XYZ` };
    const store = vaultStore({ version: 2, vault });
    const redact = ingressRedactor(() => store, new OtpCodes());
    const source = { values: Array.from({ length: 200 }, (_, i) => `typed-text-${i}-qwerty`), token: "${typed}" };
    const text = `${"The quick brown fox jumps over the lazy dog 12345. ".repeat(4000)} leak pass-word-7-ghijkl-XYZ and typed-text-150-qwerty`;
    redact(text, source);
    const times: number[] = [];
    for (let k = 0; k < 3; k++) {
      const t = performance.now();
      const out = redact(text, source);
      times.push(Math.round(performance.now() - t));
      expect(out).not.toContain("ghijkl");
      expect(out).not.toContain("qwerty");
    }
    console.log(`200 typed values + 50 accounts, 200 KB (ms): ${times.join(", ")}`);
    expect(Math.min(...times)).toBeLessThan(300);
  });
});
