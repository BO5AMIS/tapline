import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAccounts, type GitProbe } from "../src/accounts.js";
import { runDoctor, type CheckResult, type DoctorDeps } from "../src/doctor.js";
import { protectVaultFile, type Dpapi, type Keychain, type VaultDeps } from "../src/vault.js";

// AGENT-TOOLS 1.16.1 §20.1 (Limits): 256 characters a value, 3 for a secret field once decoded, 64 values a file (32 accounts in
// version 1), plain fields that may be shorter and aren't redacted, and a file that breaks a limit loads nothing. Every value is made up.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "tapline-vlimits-"));
  dirs.push(dir);
  return dir;
};
const OUTSIDE: GitProbe = { insideWorkTree: async () => false, ignored: async () => false };

function write(body: unknown): string {
  const file = join(tmp(), "vault.json");
  writeFileSync(file, JSON.stringify(body));
  return file;
}
const v2 = (vault: Record<string, unknown>): unknown => ({ version: 2, vault });

/** The error a load ends in, or null when it loaded. */
async function breach(body: unknown): Promise<string | null> {
  try {
    await loadAccounts(write(body), OUTSIDE);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("value length", () => {
  it("256 characters pass and 257 are refused, naming the entry and the field", async () => {
    expect(await breach(v2({ home: { kind: "address", street: "s".repeat(256) } }))).toBeNull();
    expect(await breach(v2({ me: { kind: "note", text: "n".repeat(256) } }))).toBeNull();
    const message = await breach(v2({ home: { kind: "address", street: "s".repeat(257) } }));
    expect(message).toContain("home's street is longer than 256 characters");
    expect(message).not.toContain("sss");
    expect(await breach(v2({ me: { kind: "note", text: "n".repeat(257) } }))).toContain("me's text is longer than 256");
  });

  it("counts the value as written: 256 escaped characters pass, 257 don't, though they decode shorter", async () => {
    expect(await breach(v2({ me: { kind: "note", text: "%41".repeat(85) + "x" } }))).toBeNull(); // 256 as written
    expect(await breach(v2({ me: { kind: "note", text: "%41".repeat(85) + "xy" } }))).toContain("longer than 256");
  });

  it("an empty value is refused", async () => {
    expect(await breach(v2({ home: { kind: "address", street: "" } }))).toContain("home's street is empty");
    expect(await breach(v2({ t: { kind: "fixture", a: "" } }))).toContain("t's a is empty");
  });

  it("a value still escaped after the decoding work limit is refused", async () => {
    // nine layers of "%25": more passes than the work limit allows
    let nested = "%41";
    for (let layer = 0; layer < 9; layer++) nested = nested.replace(/%/g, "%25");
    const message = await breach(v2({ me: { kind: "note", text: nested } }));
    expect(message).toContain("me's text is still escaped after the decoding work limit");
    expect(message).not.toContain("%25%25");
    // six layers are within the limit; three of them decode to "AAA"
    let ok = "%41";
    for (let layer = 0; layer < 5; layer++) ok = ok.replace(/%/g, "%25");
    expect(await breach(v2({ me: { kind: "note", text: `${ok}${ok}${ok}` } }))).toBeNull();
  });
});

describe("secret fields", () => {
  it("need 3 characters once decoded: 2 are refused, 3 pass", async () => {
    expect(await breach(v2({ tester2: { kind: "account", username: "ab" } }))).toContain("tester2's username must have at least 3 characters once decoded");
    expect(await breach(v2({ tester2: { kind: "account", password: "abc" } }))).toBeNull();
    // %41%42%43 is 9 characters as written and 3 once decoded; %41%42 is 6 and 2
    expect(await breach(v2({ tester2: { kind: "account", password: "%41%42%43" } }))).toBeNull();
    expect(await breach(v2({ tester2: { kind: "account", password: "%41%42" } }))).toContain("tester2's password must have at least 3 characters once decoded");
  });

  it("every secret field of every kind has the minimum", async () => {
    const short = "ab";
    for (const [kind, field] of [["card", "number"], ["card", "expiry"], ["card", "cvc"], ["identity", "phone"], ["identity", "email"], ["identity", "birthday"], ["note", "text"]] as const) {
      const message = await breach(v2({ x: { kind, [field]: short } }));
      expect(message, `${kind}.${field}`).toContain(`x's ${field} must have at least 3 characters once decoded`);
    }
  });

  it("are refused with a direction mark, a backslash at an end, or untrimmed", async () => {
    expect(await breach(v2({ t: { kind: "account", password: "abc‎def" } }))).toContain("t's password must not hold direction marks");
    expect(await breach(v2({ t: { kind: "account", password: "abc\\u200edef" } }))).toContain("direction marks");
    expect(await breach(v2({ t: { kind: "account", password: "abcdef\\" } }))).toContain("t's password must not start or end with a backslash");
    expect(await breach(v2({ t: { kind: "account", password: "\\abcdef" } }))).toContain("backslash");
    expect(await breach(v2({ t: { kind: "account", password: " abcdef" } }))).toContain("t's password must not start or end with whitespace");
    expect(await breach(v2({ t: { kind: "account", password: "abcdef\n" } }))).toContain("whitespace");
    expect(await breach(v2({ t: { kind: "account", password: "abc def" } }))).toBeNull();
  });

  it("also hold for a version 1 account", async () => {
    expect(await breach({ version: 1, accounts: { a: { username: "ab", password: "abcdef" } } })).toContain("a's username must have at least 3 characters once decoded");
    expect(await breach({ version: 1, accounts: { a: { username: "abc", password: "abcdef", passcode: "1" } } })).toBeNull();
  });
});

describe("plain fields", () => {
  it("may be shorter than 3 characters: typed, but not redacted", async () => {
    const file = write(v2({ home: { kind: "address", street: "Elm St 4", country: "UK", city: "%41" }, me: { kind: "identity", name: "Al", email: "al.fake@example.test" }, t: { kind: "fixture", size: "2" }, phone: { kind: "phone", passcode: "7" } }));
    const loaded = await loadAccounts(file, OUTSIDE);
    const store = loaded.store;
    if (store === null) throw new Error("expected a store");
    const typed = (name: string, field: string): string | undefined => {
      const got = store.resolveEntry(name, field, "com.example.app");
      return got.ok ? got.value : undefined;
    };
    expect(typed("home", "country")).toBe("UK");
    expect(typed("me", "name")).toBe("Al");
    expect(typed("t", "size")).toBe("2");
    const text = "Based in UK, Al has 2 seats at A and 7";
    expect(store.redact(text)).toBe(text);
    // 3 characters as written, 1 once decoded: not redacted either
    expect(store.redact("the letter A and %41")).toBe("the letter A and %41");
    // the longer values beside them still are
    expect(store.redact("he wrote al.fake@example.test")).toBe("he wrote <me's email>");
    expect(store.redact("at Elm St 4")).toBe("at <home's street>");
  });

  it("are still held to 256 characters", async () => {
    expect(await breach(v2({ home: { kind: "address", country: "c".repeat(257) } }))).toContain("home's country is longer than 256");
    expect(await breach(v2({ t: { kind: "fixture", a: "x".repeat(257) } }))).toContain("t's a is longer than 256");
  });
});

describe("counts", () => {
  const notes = (count: number): Record<string, unknown> => Object.fromEntries(Array.from({ length: count }, (_, i) => [`n${i}`, { kind: "note", text: `fake note ${i}` }]));

  it("a version 2 file holds 64 values and refuses 65, naming the count and no value", async () => {
    expect(await breach(v2(notes(64)))).toBeNull();
    const message = await breach(v2(notes(65)));
    expect(message).toContain("it holds more than 64 values; a vault file holds at most 64 (split it)");
    expect(message).not.toContain("fake note");
  });

  it("counts every redactable value of every kind, but not short plain ones and not the phone entry's", async () => {
    const base = notes(60);
    const extra = { home: { kind: "address", street: "Elm St 4", city: "Ab", country: "UK", postcode: "12345" }, phone: { kind: "phone", passcode: "123456" } };
    // 60 notes + street + postcode = 62: city and country are under 3 characters and the passcode isn't counted
    expect(await breach(v2({ ...base, ...extra }))).toBeNull();
    // two fixtures fields more reach 64
    expect(await breach(v2({ ...base, ...extra, t: { kind: "fixture", a: "aaa", b: "bbb" } }))).toBeNull();
    expect(await breach(v2({ ...base, ...extra, t: { kind: "fixture", a: "aaa", b: "bbb", c: "ccc" } }))).toContain("more than 64 values");
    expect(await breach(v2({ ...base, ...extra, t: { kind: "fixture", a: "aaa", b: "bbb", c: "cc" } }))).toBeNull();
  });

  it("a version 1 file holds 32 accounts and refuses 33", async () => {
    const accounts = (count: number): unknown => ({ version: 1, accounts: Object.fromEntries(Array.from({ length: count }, (_, i) => [`a${i}`, { username: `user-${i}-fake`, password: `pass-${i}-fake` }])) });
    expect(await breach(accounts(32))).toBeNull();
    expect(await breach(accounts(33))).toContain("more than 32 accounts; a version 1 vault file holds at most 32 (split it)");
  });
});

describe("a breach loads nothing", () => {
  it("no entry is used, and the message names the entry and the field and never a value", async () => {
    const secret = "pw-fake-9137-xyz";
    const body = v2({ good: { kind: "account", username: "good-user-fake", password: secret }, bad: { kind: "note", text: "n".repeat(300) } });
    const file = write(body);
    let loaded = false;
    let message = "";
    try {
      await loadAccounts(file, OUTSIDE);
      loaded = true;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(loaded).toBe(false);
    expect(message).toContain("bad's text is longer than 256 characters");
    expect(message).toContain("none of it is used");
    expect(message).not.toContain(secret);
    expect(message).not.toContain("nnnn");
  });
});

describe("doctor and protect", () => {
  const BASE: Partial<DoctorDeps> = {
    run: async () => ({ code: -1, stdout: "", stderr: "" }),
    platform: "linux",
    nodeVersion: "20.11.0",
    env: { TAPLINE_HOME: "/fake/.tapline" },
    fileExists: () => true,
    portFree: async () => true,
    lanIps: () => ["192.168.1.20"],
    hostDir: null,
    gitStatus: async () => null,
  };
  const check = (results: CheckResult[]): CheckResult | undefined => results.find((r) => r.name === "Test accounts");

  it("doctor fails with the same words and no value", async () => {
    const file = write(v2({ tester2: { kind: "account", username: "tester2@example.test", password: "ab" } }));
    const found = check(await runDoctor({ ...BASE, accountsFile: file, gitProbe: OUTSIDE }));
    expect(found?.status).toBe("fail");
    expect(found?.detail).toContain("tester2's password must have at least 3 characters once decoded");
    expect(found?.detail).not.toContain("tester2@example.test");
  });

  it("doctor says the count", async () => {
    const vault = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`n${i}`, { kind: "note", text: `fake note ${i}` }]));
    const found = check(await runDoctor({ ...BASE, accountsFile: write(v2(vault)), gitProbe: OUTSIDE }));
    expect(found?.status).toBe("fail");
    expect(found?.detail).toContain("more than 64 values");
  });

  function fakeDeps(): VaultDeps & { stored: string[] } {
    const stored: string[] = [];
    const dpapi: Dpapi = {
      async protect(data) {
        stored.push(data.toString("utf8"));
        return Buffer.from(data);
      },
      async unprotect(blob) {
        return Buffer.from(blob);
      },
    };
    const keychain: Keychain = {
      async read() {
        return null;
      },
      async write() {
        throw new Error("not used");
      },
    };
    return { platform: "win32", dpapi, keychain, stored };
  }

  it("protect refuses a file that breaks a limit, leaves it plain and quotes no value", async () => {
    const cases: Array<[string, unknown, string]> = [
      ["length", v2({ home: { kind: "address", street: "s".repeat(257) } }), "home's street is longer than 256"],
      ["secret", v2({ t: { kind: "account", password: "ab" } }), "t's password must have at least 3 characters once decoded"],
      ["v2 count", v2(Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`n${i}`, { kind: "note", text: `fake note ${i}` }]))), "more than 64 values"],
      ["v1 count", { version: 1, accounts: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`a${i}`, { username: `user-${i}-fake`, password: `pass-${i}-fake` }])) }, "more than 32 accounts"],
    ];
    for (const [label, body, expected] of cases) {
      const file = write(body);
      const before = readFileSync(file, "utf8");
      const deps = fakeDeps();
      const done = await protectVaultFile(file, deps);
      expect(done.ok, label).toBe(false);
      const message = (done as { message: string }).message;
      expect(message, label).toContain(expected);
      expect(message, label).not.toContain("sssss");
      expect(message, label).not.toContain("fake note");
      expect(deps.stored, label).toEqual([]);
      expect(readFileSync(file, "utf8"), label).toBe(before);
    }
  });

  it("protect still protects a file within the limits", async () => {
    const file = write(v2({ home: { kind: "address", street: "s".repeat(256), country: "UK" } }));
    const deps = fakeDeps();
    expect((await protectVaultFile(file, deps)).ok).toBe(true);
    expect(deps.stored).toHaveLength(1);
  });
});
