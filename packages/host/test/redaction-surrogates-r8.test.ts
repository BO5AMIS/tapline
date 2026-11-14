import { rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ingressRedactor, loadAccounts, redactAll, safeEncode, safeHead, variantsOf, vaultStore, wellFormed, type GitProbe } from "../src/accounts.js";
import { OtpCodes } from "../src/otpclient.js";
import { REDACTION_FAILED, type TaplineHost } from "../src/server.js";
import { flushExploreMaps, input, type ExWorld } from "./explore-helpers.js";
import { FakeApp, startHost } from "./helpers.js";
import { repairRig, textOf } from "./repair-helpers.js";

// PR 13 security review, Codex cycle 6 (R8): a typed value that ends in an emoji right at a cut boundary made the redactor throw
// (`URIError`) inside the WebSocket handler and end the host. Cuts never split a surrogate pair, every encoding is total, and a
// redactor that throws at ingress hides the text instead of ending the host or returning it raw. All values are made up.

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
const HIGH = "\ud83d";
const LOW = "\ude00";
const EMOJI = "\u{1F600}";
const TYPED = "${typed}";

function typedOf(...values: string[]): { values: string[]; token: string } {
  return { values, token: TYPED };
}

function emptyRedactor(vault: Record<string, string> = {}): ReturnType<typeof ingressRedactor> {
  const entries: Record<string, { kind: "account"; username: string; password: string }> = {};
  for (const [name, username] of Object.entries(vault)) entries[name] = { kind: "account", username, password: "hunter-2-horse-battery" };
  const store = vaultStore({ version: 2, vault: entries });
  return ingressRedactor(() => store, new OtpCodes());
}

describe("R8: cuts never split a surrogate pair and encodings are total", () => {
  it("safeHead backs off before a split pair and is exact elsewhere", () => {
    const text = `${"a".repeat(11)}${EMOJI}tail`;
    expect(safeHead(text, 12)).toBe("a".repeat(11));
    expect(safeHead(text, 13)).toBe(`${"a".repeat(11)}${EMOJI}`);
    expect(safeHead(text, 5)).toBe("aaaaa");
    expect(safeHead("short", 12)).toBe("short");
    expect(safeHead(`${HIGH}x`, 1)).toBe(HIGH);
  });

  it("safeEncode never throws and writes a lone surrogate as %EF%BF%BD", () => {
    expect(safeEncode(`a${HIGH}`)).toBe("a%EF%BF%BD");
    expect(safeEncode(`${LOW}b`)).toBe("%EF%BF%BDb");
    expect(safeEncode(`${HIGH}${LOW}`)).toBe("%F0%9F%98%80");
    expect(safeEncode(`${LOW}${HIGH}`)).toBe("%EF%BF%BD%EF%BF%BD");
  });

  it("variantsOf does not throw for a value cut at 200 inside an emoji, or holding lone surrogates", () => {
    expect(() => variantsOf("a".repeat(199) + EMOJI)).not.toThrow();
    expect(() => variantsOf(`x${HIGH}y${LOW}z`)).not.toThrow();
    expect(() => variantsOf(HIGH)).not.toThrow();
    for (const form of variantsOf("a".repeat(199) + EMOJI)) expect(form.length).toBeGreaterThan(0);
  });

  it("the exact reproduction: replay one type_text of 199 letters and an emoji, redaction on, the host survives", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tapline-r8-"));
    dirs.push(dir);
    const file = join(dir, "vault.json");
    writeFileSync(file, JSON.stringify({ version: 2, vault: { tester: { kind: "account", username: "jane", password: "hunter-2-horse-battery" } } }));
    const loaded = await loadAccounts(file, OUTSIDE);
    if (loaded.store === null) throw new Error("vault not loaded");
    const store = loaded.store;
    const typed = "a".repeat(199) + EMOJI;
    // The screen must hold the input, or the step never types (review, cycle 7): keep the world to check what was typed.
    let world: ExWorld | null = null;
    const r = await repairRig(hosts, apps, dirs, {
      hostOptions: { redact: ingressRedactor(() => store, new OtpCodes()) },
      tools: { accounts: loaded },
      world: (w) => {
        world = w;
        w.screens[w.screen]?.elements.push(input("email-field", "Email"));
      },
    });
    r.script("emoji", [{ tool: "type_text", target: { id: "email-field" }, text: typed }]);
    const answer = textOf(await r.s.tools.replay({ name: "emoji" }));
    expect(answer).not.toContain("No input matches");
    expect(answer).not.toMatch(/Ran 0 of 1/);
    // the app received the whole text, emoji included
    expect((world as ExWorld | null)?.typed.some((t) => t.id === "email-field" && t.text === typed)).toBe(true);
    expect(answer).not.toContain("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    // still up and still scrubbing after the run: the echo is scrubbed, and the host answers another replay
    expect(r.s.host.redactOut(`x ${typed} y`)).not.toContain("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const again = textOf(await r.s.tools.replay({ name: "emoji" }));
    expect(again).not.toContain("No input matches");
  });

  it("lone high and low surrogates in a typed value, a vault value and app text are all handled", () => {
    const values = [`kkkkkk${HIGH}`, `${LOW}kkkkkk`, `abcd${HIGH}efgh${LOW}ijkl`, `${HIGH}`, `${LOW}${HIGH}`, `longvalue${LOW}${HIGH}longer`];
    for (const value of values) {
      const redact = emptyRedactor({ tester: `vault-${value}-name` });
      for (const text of [`say ${value} now`, `${HIGH}${LOW}${HIGH}`, `${LOW}`, `vault-${value}-name`, encodeURIComponent("ok") + safeEncode(value)]) {
        expect(() => redact(text, typedOf(value, `typed ${value} value`))).not.toThrow();
      }
      if (value.length >= 6) {
        expect(redactAll(null, new OtpCodes(), `say ${value} now`, typedOf(value))).toContain(TYPED);
        // as the app's text arrives over UTF-8: the lone surrogate is U+FFFD
        expect(redactAll(null, new OtpCodes(), `say ${wellFormed(value)} now`, typedOf(value))).toContain(TYPED);
        expect(redact(`vault-${value}-name`, typedOf())).not.toContain("vault-");
        expect(redact(`vault-${wellFormed(value)}-name`, typedOf())).not.toContain("vault-");
      }
    }
  });

  for (const boundary of [12, 64, 200, 300]) {
    it(`an emoji straddling the cut at ${boundary} is hidden whole, as typed text and as a vault value, and nothing throws`, () => {
      for (const lead of [boundary - 1, boundary]) {
        const value = `${"q".repeat(lead)}${EMOJI}${"z".repeat(5)}`;
        const secret = `${"q".repeat(lead)}${EMOJI}`;
        const typed = emptyRedactor();
        const out = typed(`before ${value} after`, typedOf(value));
        expect(out).toBe(`before ${TYPED} after`);
        expect(typed(`cut ${value.slice(0, boundary)} end`, typedOf(value))).not.toContain("qqqqqqqqqqqq");
        // percent and JSON forms of the same value
        for (const form of [safeEncode(value), JSON.stringify(value).slice(1, -1), encodeURIComponent(value)]) {
          expect(typed(`x ${form} y`, typedOf(value))).not.toContain("qqqqqqqqqqqq");
        }
        const vault = emptyRedactor({ tester: value });
        expect(vault(`x ${value} y`, typedOf())).not.toContain("qqqqqqqqqqqq");
        expect(vault(`x ${secret} y`, typedOf())).not.toContain("qqqqqqqqqqqq");
        // a text that holds the value cut in the middle of the pair (what a code-unit cut leaves)
        expect(() => vault(`x ${value.slice(0, lead + 1)} y`, typedOf(value))).not.toThrow();
      }
    });
  }

  it("a redactor that throws at ingress: the host stays up, the text becomes the placeholder and is never returned raw", async () => {
    const warnings: string[] = [];
    let throwNow = false;
    const { host, port } = await startHost({
      redact: (text) => {
        if (throwNow) throw new URIError("URI malformed");
        return text;
      },
    });
    hosts.push(host);
    host.on("warning", (message) => warnings.push(message));
    const { app } = await FakeApp.connect(port, {}, () => ({ ok: true, result: { note: "secret-value-123", nested: ["secret-value-123"] } }));
    apps.push(app);
    expect(await host.request("anything")).toEqual({ note: "secret-value-123", nested: ["secret-value-123"] });
    throwNow = true;
    const answer = await host.request("anything");
    expect(JSON.stringify(answer)).not.toContain("secret-value-123");
    expect(JSON.stringify(answer)).toContain(REDACTION_FAILED);
    expect(host.redactOut("secret-value-123")).toBe(REDACTION_FAILED);
    expect(warnings.some((w) => w.includes("Redaction failed") && !w.includes("secret-value-123"))).toBe(true);
    // the connection is alive and answers again once the redactor works
    throwNow = false;
    expect(await host.request("anything")).toEqual({ note: "secret-value-123", nested: ["secret-value-123"] });
  });

  it("a redactor that throws on an event or an error answer does not end the host either", async () => {
    let throwNow = true;
    const { host, port } = await startHost({
      redact: (text) => {
        if (throwNow) throw new Error("boom secret-value-123");
        return text;
      },
    });
    hosts.push(host);
    const { app } = await FakeApp.connect(port, {}, () => ({ ok: false, error: { code: "internal", message: "failed for secret-value-123" } }));
    apps.push(app);
    const error = await host.request("anything").then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error).not.toBeNull();
    // the failed text is never returned: the error keeps no word of the app's message
    expect(error?.message).not.toContain("secret-value-123");
    expect(JSON.stringify({ message: error?.message, ...(error as object) })).not.toContain("secret-value-123");
    throwNow = false;
    expect(host.redactOut("fine")).toBe("fine");
  });

  it("200 typed values, 50 accounts and a 200 KB text stay under 300 ms, with emoji values among them", () => {
    const vault: Record<string, { kind: "account"; username: string; password: string }> = {};
    for (let i = 0; i < 50; i++) vault[`acct${i}`] = { kind: "account", username: `user-name-${i}-abcdef`, password: `pass-word-${i}-ghijkl-XYZ` };
    const store = vaultStore({ version: 2, vault });
    const redact = ingressRedactor(() => store, new OtpCodes());
    const values = Array.from({ length: 200 }, (_, i) => (i % 10 === 0 ? `${"w".repeat(10 + (i % 3))}${EMOJI}-typed-${i}` : `typed-text-${i}-qwerty`));
    const source = typedOf(...values);
    const text = `${"The quick brown fox jumps over the lazy dog 12345. ".repeat(4000)} leak pass-word-7-ghijkl-XYZ and typed-text-151-qwerty`;
    redact(text, source);
    const times: number[] = [];
    for (let k = 0; k < 3; k++) {
      const t = performance.now();
      const out = redact(text, source);
      times.push(Math.round(performance.now() - t));
      expect(out).not.toContain("ghijkl");
      expect(out).not.toContain("qwerty");
    }
    expect(Math.min(...times)).toBeLessThan(300);
  });
});
