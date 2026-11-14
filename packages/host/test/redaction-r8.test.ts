import { describe, expect, it } from "vitest";
import { vaultStore } from "../src/accounts.js";

// PR 12 Codex cycle 3 (AGENT-TOOLS 1.14 §20.3): every encoding layer is decoded to a fixpoint, each decoded character keeps its own
// span in the original text, and decoding is linear. Every value is made up.

function storeOf(values: Record<string, string>): (text: string) => string {
  const vault: Record<string, { kind: "note"; text: string }> = {};
  for (const [name, text] of Object.entries(values)) vault[name] = { kind: "note", text };
  return vaultStore({ version: 2, vault } as Parameters<typeof vaultStore>[0]).redact;
}

type Layer = "html" | "json" | "percent" | "form";
type Style = "full" | "light";

const alnum = (c: string): boolean => /[a-z0-9]/i.test(c);
const hex4 = (c: string): string => c.charCodeAt(0).toString(16).padStart(4, "0");

function encodeLayer(text: string, layer: Layer, style: Style): string {
  switch (layer) {
    case "html":
      return style === "full"
        ? [...text].map((c) => (alnum(c) ? c : `&#${c.codePointAt(0)};`)).join("")
        : text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    case "json":
      return style === "full"
        ? [...text].map((c) => (alnum(c) ? c : c.charCodeAt(0) > 0xffff ? c : `\\u${hex4(c)}`)).join("")
        : JSON.stringify(text).slice(1, -1);
    case "percent":
      return style === "full" ? [...text].map((c) => (alnum(c) ? c : [...Buffer.from(c)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join(""))).join("") : encodeURIComponent(text);
    case "form":
      return encodeURIComponent(text).replace(/%20/g, "+");
  }
}

const LAYERS: Layer[] = ["html", "json", "percent", "form"];

/** Every ordered choice of 2 to 4 different layers. */
function orders(): Layer[][] {
  const out: Layer[][] = [];
  const walk = (chosen: Layer[]): void => {
    if (chosen.length >= 2) out.push(chosen);
    if (chosen.length === 4) return;
    for (const layer of LAYERS) if (!chosen.includes(layer)) walk([...chosen, layer]);
  };
  walk([]);
  return out;
}

const VALUE = 'Zq7-fake "Long"+pass&word é 0123456789xyz';
// cut points (a cut that ends in a space is trimmed by the scrubber anyway, so those are skipped)
const CUTS = [12, 14, 20, 28, VALUE.length];

describe("layered encodings are decoded to a fixpoint (finding 1)", () => {
  const all = orders();
  it("covers 60 orders of 2 to 4 layers", () => {
    expect(all.length).toBe(12 + 24 + 24);
  });

  for (const style of ["full", "light"] as const) {
    for (const order of all) {
      it(`${style}: ${order.join(" then ")}: a value cut at several points is scrubbed whole`, () => {
        const redact = storeOf({ pw: VALUE });
        for (const cut of CUTS) {
          const piece = VALUE.slice(0, cut);
          if (!alnum(piece.at(-1) ?? " ")) continue;
          const encoded = order.reduce((text, layer) => encodeLayer(text, layer, style), piece);
          const expected = redact(`before ${piece} after`);
          expect(expected).not.toContain(piece.slice(0, 12));
          expect(redact(`before ${encoded} after`), `cut ${cut}: ${encoded}`).toBe(expected);
        }
      });
    }
  }

  it("a short value (under the prefix length) is scrubbed whole through four layers", () => {
    const short = 'Ab 9"+&x';
    const redact = storeOf({ pw: short });
    const encoded = (["html", "json", "percent", "form"] as const).reduce((text, layer) => encodeLayer(text, layer, "light"), short);
    expect(redact(`k=${encoded};`)).toBe(redact(`k=${short};`));
    expect(redact(`k=${encoded};`)).not.toContain("Ab");
  });

  it("the work is bounded: a deep chain of layers is still read", () => {
    const redact = storeOf({ pw: VALUE });
    let text = VALUE;
    for (let i = 0; i < 6; i++) text = encodeLayer(text, "percent", "full");
    expect(redact(`x ${text} y`)).toBe(redact(`x ${VALUE} y`));
  });
});

describe("each decoded character keeps its own span (finding 2)", () => {
  it("a secret inside a long percent-encoded string removes only the secret's encoded bytes", () => {
    const redact = storeOf({ pw: "Zq7-fake-secret-value-1234" });
    const before = "Caf%C3%A9%20au%20lait%20%C3%A9t%C3%A9%20";
    const after = "%20%C3%A0%20la%20carte%20%E2%82%AC%20and%20more%20%C3%BC";
    const out = redact(before + encodeURIComponent("Zq7-fake-secret-value-1234") + after);
    expect(out.startsWith(before)).toBe(true);
    expect(out.endsWith(after)).toBe(true);
    expect(out).not.toContain("Zq7");
    expect(out.length).toBeLessThan(before.length + after.length + 40);
  });

  it("a multi-byte percent sequence maps to its own bytes: the neighbours next to the secret survive", () => {
    const redact = storeOf({ pw: "Zq7-fake-secret-value-1234" });
    const out = redact("%C3%A9%C3%A9" + "Zq7%2Dfake%2Dsecret%2Dvalue%2D1234" + "%E2%82%AC%E2%82%AC");
    expect(out.startsWith("%C3%A9%C3%A9")).toBe(true);
    expect(out.endsWith("%E2%82%AC%E2%82%AC")).toBe(true);
  });
});

describe("decoding is linear (finding 3)", () => {
  const redact = storeOf({ pw: "Zq7-fake-secret-value-1234", other: "another-fake-value-5678" });
  // Generous for a slow CI machine (locally it is well under 200 ms): the old decoder took 0.73 s for 12 KB and 3 s for 24 KB.
  const BOUND_MS = 1000;
  const cases: Record<string, string> = {
    "%FF repeated": "%FF".repeat(70_000),
    "a broken \\u repeated": "\\u12".repeat(50_000),
    "&# without an end": "&#".repeat(100_000),
    "a % that never completes": "%4".repeat(100_000),
    "mixed junk": "%FF\\u1&#x&amp&#".repeat(13_000),
    "valid escapes everywhere": "%41%C3%A9\\u0041&#65;".repeat(10_000),
  };
  for (const [name, text] of Object.entries(cases)) {
    it(`${name} (200 KB) is scrubbed fast`, () => {
      const started = performance.now();
      const out = redact(text);
      const took = performance.now() - started;
      expect(took).toBeLessThan(BOUND_MS);
      expect(out.length).toBeGreaterThan(0);
    });
  }
});
