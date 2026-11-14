import { describe, expect, it } from "vitest";
import { vaultStore } from "../src/accounts.js";

// PR 12 Codex cycle 4, finding 1 (AGENT-TOOLS 1.14 §20.3): a secret that holds a literal `%41` and a quote must be scrubbed when its
// encoded prefix is cut, however it was encoded. Decoding turns the literal `%41` into `A` and destroys the one reading that matches,
// so the encoded forms are also searched for directly in the raw text. Every value is made up.

function storeOf(values: Record<string, string>): (text: string) => string {
  const vault: Record<string, { kind: "note"; text: string }> = {};
  for (const [name, text] of Object.entries(values)) vault[name] = { kind: "note", text };
  return vaultStore({ version: 2, vault } as Parameters<typeof vaultStore>[0]).redact;
}

const SECRET = 'abc%41DEF"ghi-jkl-more-secret';

const json = (v: string): string => JSON.stringify(v).slice(1, -1);
const jsonAscii = (v: string): string => json(v).replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
const pctUpper = (v: string): string => encodeURIComponent(v);
const pctLower = (v: string): string => encodeURIComponent(v).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
const form = (v: string): string => encodeURIComponent(v).replace(/%20/g, "+");
const html = (v: string): string => [...v].map((c) => (c === "&" ? "&amp;" : c === '"' ? "&quot;" : c === "<" ? "&lt;" : /[a-z0-9]/i.test(c) ? c : `&#${c.codePointAt(0)};`)).join("");

const SINGLE: Record<string, (v: string) => string> = { raw: (v) => v, json, jsonAscii, pctUpper, pctLower, form, html };
const FAMILY: Record<string, (v: string) => string> = { json, pct: pctUpper, pctLower, form, html };

function combos(): Array<[string, (v: string) => string]> {
  const names = Object.keys(FAMILY);
  const out: Array<[string, (v: string) => string]> = [];
  for (const a of names) {
    for (const b of names) {
      out.push([`${a}>${b}`, (v) => (FAMILY[b] as (x: string) => string)((FAMILY[a] as (x: string) => string)(v))]);
    }
  }
  for (const [x, y, z] of [["json", "pct", "html"], ["html", "json", "pct"], ["json", "json", "pct"], ["pct", "json", "html"], ["html", "pct", "json"], ["json", "html", "pct"]] as const) {
    out.push([`${x}>${y}>${z}`, (v) => (FAMILY[z] as (q: string) => string)((FAMILY[y] as (q: string) => string)((FAMILY[x] as (q: string) => string)(v)))]);
  }
  return out;
}

/** A run of 12 characters of the cut fragment that survives is a leak. */
function leak(out: string, fragment: string): string | null {
  for (let i = 0; i + 12 <= fragment.length; i++) if (out.includes(fragment.slice(i, i + 12))) return fragment.slice(i, i + 12);
  return null;
}

function check(redact: (text: string) => string, encode: (v: string) => string, value: string): string[] {
  const failures: string[] = [];
  const encoded = encode(value);
  for (let cut = 12; cut <= encoded.length; cut++) {
    const fragment = encoded.slice(0, cut);
    const out = redact(`row [${fragment}] end`);
    const found = leak(out, fragment);
    if (found !== null) failures.push(`cut ${cut} of ${JSON.stringify(encoded)} leaked ${JSON.stringify(found)}: ${out}`);
  }
  return failures;
}

describe("encoded forms are matched directly in the raw text", () => {
  const redact = storeOf({ s: SECRET });
  for (const [name, encode] of Object.entries(SINGLE)) {
    it(`the secret cut at every point from 12 characters, ${name}`, () => {
      expect(check(redact, encode, SECRET)).toEqual([]);
    });
  }
  it("the secret cut at every point, in every pair and triple of encodings", () => {
    const failures: string[] = [];
    for (const [name, encode] of combos()) for (const f of check(redact, encode, SECRET)) failures.push(`${name}: ${f}`);
    expect(failures).toEqual([]);
  });

  it("the whole secret, once encoded, is scrubbed", () => {
    for (const [name, encode] of Object.entries(SINGLE)) expect(redact(`x ${encode(SECRET)} y`), name).not.toContain("secret");
  });

  const literals = ["100%\\\"&+#-ab-secret-qq", "p%25&amp;+#\\\\-more-secret-zz", "a#b+c&d%e\\f\"g-extra-secret-tail"];
  for (const value of literals) {
    it(`a value that holds % \\ " & + # literally: ${value}`, () => {
      const r = storeOf({ v: value });
      const failures: string[] = [];
      for (const [name, encode] of [...Object.entries(SINGLE), ...combos()]) for (const f of check(r, encode, value)) failures.push(`${name}: ${f}`);
      expect(failures).toEqual([]);
    });
  }

  it("leftmost-longest still holds when another value overlaps the encoded cut", () => {
    const r = storeOf({ a: SECRET, b: "jkl-more-secret-and-then-some" });
    const out = r(`x ${json(SECRET)} ${json(SECRET).slice(0, 16)} y`);
    expect(out).not.toMatch(/abc%41DEF/);
    expect(out).not.toContain("more-secret");
  });

  it("text that holds no secret is left alone", () => {
    expect(storeOf({ s: SECRET })("nothing here, just 100% ordinary text with \"quotes\" & more")).toBe("nothing here, just 100% ordinary text with \"quotes\" & more");
  });
});
