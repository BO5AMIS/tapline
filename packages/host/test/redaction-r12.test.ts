import { describe, expect, it } from "vitest";
import { vaultStore } from "../src/accounts.js";

// PR 12 Codex cycle 5, finding 4: an encoded prefix is a match only when the text is really cut there. Twelve ENCODED characters carry
// too little distinguishing text (`https%253A%252F%252Fp` is `https://p`), so unrelated text that shares them stays as it is.

function storeOf(values: Record<string, string>): (text: string) => string {
  const vault: Record<string, { kind: "note"; text: string }> = {};
  for (const [name, text] of Object.entries(values)) vault[name] = { kind: "note", text };
  return vaultStore({ version: 2, vault } as Parameters<typeof vaultStore>[0]).redact;
}

const SECRET = "https://private.example/secret-token";
const once = (v: string): string => encodeURIComponent(v);
const twice = (v: string): string => encodeURIComponent(encodeURIComponent(v));

const leak = (out: string, fragment: string): boolean => {
  for (let i = 0; i + 12 <= fragment.length; i++) if (out.includes(fragment.slice(i, i + 12))) return true;
  return false;
};

describe("an encoded prefix is scrubbed only where the text is really cut", () => {
  const redact = storeOf({ s: SECRET });

  it("a public URL, double-percent-encoded, passes through unchanged", () => {
    const text = `see ${twice("https://public.example/help")} now`;
    expect(redact(text)).toBe(text);
    expect(redact(twice("https://public.example/help"))).toBe(twice("https://public.example/help"));
  });

  it("the same URL once-encoded and plain also passes through unchanged", () => {
    for (const text of [once("https://public.example/help"), "https://public.example/help", `x ${once("https://public.example/help")}&y=1`]) {
      expect(redact(text)).toBe(text);
    }
  });

  it("a real truncation of the secret is still scrubbed, at the end of the text, before a cut marker and before a delimiter", () => {
    for (const encode of [(v: string) => v, once, twice]) {
      const encoded = encode(SECRET);
      for (let cut = 12; cut <= encoded.length; cut++) {
        const fragment = encoded.slice(0, cut);
        for (const text of [fragment, `${fragment}…`, `${fragment}…(+${encoded.length - cut})`, `[${fragment}] end`, `${fragment}...`]) {
          const out = redact(text);
          expect(leak(out, fragment), `${JSON.stringify(text)} -> ${JSON.stringify(out)}`).toBe(false);
        }
      }
    }
  });

  it("a short decoded prefix followed by text that contradicts the secret is not a truncation", () => {
    const fragment = twice(SECRET).slice(0, 21); // https%253A%252F%252Fp = "https://p"
    const text = `${fragment}ublic.example%252Fhelp`;
    expect(redact(text)).toBe(text);
  });

  it("a prefix of 12 decoded characters is still scrubbed whatever follows", () => {
    const out = redact("x https://private-and-more y");
    expect(out).not.toContain("https://priv");
  });
});
