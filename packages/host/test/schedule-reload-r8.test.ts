import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiAnswer } from "../src/api.js";
import { createRuntime, HOST_FACTS_TOOL, type HostFacts, type Runtime } from "../src/runtime.js";
import { factHasher, factsMismatch } from "../src/schedulehost.js";
import type { Schedule } from "../src/schedule.js";
import type { Keychain, VaultDeps } from "../src/vault.js";

// PR 12 Codex cycle 3, finding 4 (AGENT-TOOLS 1.14 §22.3): a host that is asked for its facts first reloads its policy, vault and maps
// from disk into its live state and reports hashes of what is now LOADED; the schedule hashes what it would load and refuses on any
// difference. Every value is made up; every folder is a temp folder; the keychain is a fake.

const dirs: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const vaultJson = (apps: string[]): string =>
  JSON.stringify({ version: 2, vault: { tester: { kind: "account", username: "qa-user-name-1", password: "Pa55-word-for-test", apps } } });

/** A fake keychain whose single item the test can change: the stub file on disk never changes. */
function fakeKeychain(): { deps: VaultDeps; set(json: string | null): void } {
  let current: string | null = null;
  const keychain: Keychain = {
    async read() {
      return current;
    },
    async write(_account, json) {
      current = json;
    },
  };
  return {
    deps: { platform: "darwin", dpapi: { protect: async (d) => Buffer.from(d), unprotect: async (b) => Buffer.from(b) }, keychain },
    set: (json) => {
      current = json;
    },
  };
}

interface World {
  home: string;
  env: NodeJS.ProcessEnv;
  policy: string;
  accounts: string;
  maps: string;
  runtime: Runtime;
  keychain: ReturnType<typeof fakeKeychain>;
}

async function start(): Promise<World> {
  const home = mkdtempSync(join(tmpdir(), "tapline-reload-"));
  dirs.push(home);
  const policy = join(home, "policy.json");
  const accounts = join(home, "accounts.json");
  const maps = join(home, "maps");
  mkdirSync(maps);
  writeFileSync(policy, JSON.stringify({ version: 2, block: ["Archive"] }));
  // a vault protected in the keychain: the file on disk is only a marker
  writeFileSync(accounts, JSON.stringify({ version: 2, protected: "keychain" }));
  const keychain = fakeKeychain();
  keychain.set(vaultJson(["com.example.a"]));
  const env = { TAPLINE_HOME: home };
  const runtime = await createRuntime({ port: 0, host: "127.0.0.1", env, log: () => undefined, api: true, policy, accounts, maps, vaultDeps: keychain.deps });
  runtimes.push(runtime);
  return { home, env, policy, accounts, maps, runtime, keychain };
}

async function factsOf(w: World): Promise<{ isError: boolean; text: string; facts: HostFacts | null }> {
  const response = await fetch(`http://127.0.0.1:${w.runtime.port}/api/${HOST_FACTS_TOOL}`, {
    method: "POST",
    headers: { authorization: `Bearer ${w.runtime.config.token}`, "x-agent-client": "schedule-x" },
    body: "{}",
  });
  const answer = (await response.json()) as ApiAnswer;
  const text = answer.text ?? "";
  return { isError: answer.isError === true, text, facts: answer.isError === true ? null : (JSON.parse(text) as HostFacts) };
}

const scheduleOf = (w: World): Schedule => ({
  version: 1,
  tool: "tapline",
  route: "post_update",
  with: {},
  at: "09:00 daily",
  trigger: null,
  policy: w.policy,
  accounts: w.accounts,
  maps: w.maps,
});

describe("a host reloads before it reports its facts (finding 4)", () => {
  it("a protected vault whose per-app permission changed: the marker file is the same bytes, the host's cached credentials are replaced, and the old facts are refused", async () => {
    const w = await start();
    const hasher = factHasher(w.env, w.keychain.deps);
    const first = await factsOf(w);
    expect(first.facts).not.toBeNull();
    expect(await factsMismatch(scheduleOf(w), first.facts, w.env, hasher)).toBeNull();
    // the vault now lets the entry go to another app; nothing on disk changed
    w.keychain.set(vaultJson(["com.example.a", "com.example.b"]));
    // facts as the host reported them before the change no longer match what the schedule would load
    expect(await factsMismatch(scheduleOf(w), first.facts, w.env, hasher)).toMatch(/accounts/);
    // asked again, the host reloads (decrypting again) and the live state is the new vault
    const second = await factsOf(w);
    expect(second.facts?.accountsHash).not.toBe(first.facts?.accountsHash);
    const resolved = w.runtime.live.accounts()?.store?.resolve("tester", "password", "com.example.b");
    expect(resolved?.ok).toBe(true);
    expect(await factsMismatch(scheduleOf(w), second.facts, w.env, hasher)).toBeNull();
    // and a permission taken away is gone from the live vault too
    w.keychain.set(vaultJson(["com.example.a"]));
    await factsOf(w);
    expect(w.runtime.live.accounts()?.store?.resolve("tester", "password", "com.example.b")?.ok).toBe(false);
  });

  it("the vault hash is an HMAC under the host token: no value hash, nothing that confirms a guess", async () => {
    const w = await start();
    const { facts } = await factsOf(w);
    expect(facts?.accountsHash).toMatch(/^[0-9a-f]{64}$/);
    const text = JSON.stringify(facts);
    expect(text).not.toContain("Pa55");
    expect(text).not.toContain("qa-user");
    // a plain sha256 of the vault's canonical JSON is not what is reported
    const { createHash } = await import("node:crypto");
    expect(facts?.accountsHash).not.toBe(createHash("sha256").update(vaultJson(["com.example.a"])).digest("hex"));
  });

  it("a policy edited on disk is loaded again: the live policy has the new block word and the hashes agree", async () => {
    const w = await start();
    const hasher = factHasher(w.env, w.keychain.deps);
    await factsOf(w);
    writeFileSync(w.policy, JSON.stringify({ version: 2, block: ["Archive", "Delete"] }));
    const { facts } = await factsOf(w);
    expect(w.runtime.live.policy().block).toContain("Delete");
    expect(await factsMismatch(scheduleOf(w), facts, w.env, hasher)).toBeNull();
  });

  it("a reflex deleted from the map on disk is gone from the host's live map, and then the hashes match", async () => {
    const w = await start();
    const hasher = factHasher(w.env, w.keychain.deps);
    const dir = join(w.maps, "com.example.app");
    mkdirSync(dir);
    const map = (reflexes: unknown[]): string =>
      JSON.stringify({ format: "agent-tools-map", version: 1, app: "com.example.app", places: {}, roads: [], routes: {}, reflexes });
    const reflex = { name: "rate", when: { text: "Rate this app" }, do: { tool: "tap", target: { text: "Not now" } } };
    // the host holds this map (as it does once it has driven the app)
    await factsOf(w);
    writeFileSync(join(dir, "map.json"), map([reflex]));
    const withReflex = await factsOf(w);
    expect(w.runtime.maps.forApp({ id: "com.example.app", name: "App" })?.data().reflexes.map((r) => r.name)).toEqual(["rate"]);
    expect(await factsMismatch(scheduleOf(w), withReflex.facts, w.env, hasher)).toBeNull();
    // the person deletes it on disk
    writeFileSync(join(dir, "map.json"), map([]));
    // the old facts certify a map that is gone
    expect(await factsMismatch(scheduleOf(w), withReflex.facts, w.env, hasher)).toMatch(/maps/);
    const after = await factsOf(w);
    expect(w.runtime.maps.forApp({ id: "com.example.app", name: "App" })?.data().reflexes).toEqual([]);
    expect(after.facts?.mapsHash).not.toBe(withReflex.facts?.mapsHash);
    expect(await factsMismatch(scheduleOf(w), after.facts, w.env, hasher)).toBeNull();
  });

  it("a vault that can't be read now makes the facts an error, and nothing is reused", async () => {
    const w = await start();
    const hasher = factHasher(w.env, w.keychain.deps);
    const good = await factsOf(w);
    w.keychain.set(null);
    const bad = await factsOf(w);
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/^Error /);
    expect(bad.text).not.toContain("Pa55");
    // the schedule can't decrypt it either: even the earlier facts are not accepted
    expect(await factsMismatch(scheduleOf(w), good.facts, w.env, hasher)).toMatch(/accounts/);
    expect(await factsMismatch(scheduleOf(w), null, w.env, hasher)).toMatch(/can't be read/);
  });

  it("a policy file that no longer loads makes the facts an error", async () => {
    const w = await start();
    await factsOf(w);
    writeFileSync(w.policy, "{ not json");
    const bad = await factsOf(w);
    expect(bad.isError).toBe(true);
  });
});
