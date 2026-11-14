import { describe, expect, it } from "vitest";
import { vaultStore } from "../src/accounts.js";

// PR 12 review, round 6 (AGENT-TOOLS 1.14 §20.3): partial secrets in every encoding, and overlapping values. Every value is made up.

const LONG = "Zq7-fake long+passphrase&for=tests é 0123456789-abcdefghijklmnop";

function storeOf(values: Record<string, string>): (text: string) => string {
  const vault: Record<string, { kind: "note"; text: string }> = {};
  for (const [name, text] of Object.entries(values)) vault[name] = { kind: "note", text };
  return vaultStore({ version: 2, vault } as Parameters<typeof vaultStore>[0]).redact;
}

const asciiEscaped = (text: string): string =>
  [...text].map((c) => (c.charCodeAt(0) > 127 ? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}` : c)).join("");

const FORMS: Record<string, (value: string) => string> = {
  "percent upper": (v) => encodeURIComponent(v),
  "percent lower": (v) => encodeURIComponent(v).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()),
  "form plus": (v) => encodeURIComponent(v).replace(/%20/g, "+"),
  "json u lower": (v) => asciiEscaped(v),
  "json u upper": (v) => asciiEscaped(v).replace(/\\u([0-9a-f]{4})/g, (_m, h: string) => `\\u${h.toUpperCase()}`),
  "json escaped twice": (v) => asciiEscaped(v).replace(/\\/g, "\\\\"),
  "html entities": (v) => [...v].map((c) => (/[a-z0-9]/i.test(c) ? c : `&#${c.codePointAt(0)};`)).join(""),
  "html hex entities": (v) => [...v].map((c) => (/[a-z0-9]/i.test(c) ? c : `&#x${(c.codePointAt(0) ?? 0).toString(16)};`)).join(""),
  "percent of json": (v) => encodeURIComponent(asciiEscaped(v)),
  "zero width between": (v) => [...v].join("​"),
  "collapsed whitespace": (v) => v.replace(/ /g, "  \n "),
};

/** The characters of the value the text still carries, read as a person would: a run of 12 of them in a row is a leak. */
function leaksPiece(out: string, value: string): string | null {
  for (let i = 0; i + 12 <= value.length; i++) {
    const piece = value.slice(i, i + 12);
    if (out.includes(piece)) return piece;
  }
  return null;
}

/** How many characters of a value a cut fragment still spells once a half-written escape at its end is dropped. */
function decodedLength(fragment: string): number {
  const whole = fragment.replace(/(?:%[0-9a-fA-F]?|\\{1,2}u[0-9a-fA-F]{0,3}|&#x?[0-9a-fA-F]*)$/, "");
  const percent = whole.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    for (let end = run.length; end > 0; end -= 3) {
      try {
        return decodeURIComponent(run.slice(0, end));
      } catch {
        // an incomplete sequence at the end
      }
    }
    return "";
  });
  return percent
    .replace(/\\{1,2}u([0-9a-fA-F]{4})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#([0-9]+);/g, (_m, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/​/g, "")
    .replace(/\s+/g, " ").length;
}

describe("a cut value is scrubbed in every encoding at every cut point (finding 1a)", () => {
  const redact = storeOf({ phrase: LONG });
  for (const [name, form] of Object.entries(FORMS)) {
    it(`${name}: cut anywhere from 12 characters to the whole`, () => {
      const encoded = form(LONG);
      for (let cut = 12; cut <= encoded.length; cut++) {
        const fragment = encoded.slice(0, cut);
        const out = redact(`before |${fragment}| after`);
        const tail = fragment.slice(-8);
        const decodedLen = decodedLength(fragment);
        if (decodedLen < 12) continue;
        expect(out, `${name} cut ${cut}: ${fragment}`).toContain("<phrase's text>");
        expect(out, `${name} cut ${cut}: ${fragment}`).not.toContain(tail);
        expect(out.startsWith("before |"), `${name} cut ${cut}`).toBe(true);
        expect(out.endsWith("| after"), `${name} cut ${cut}`).toBe(true);
      }
    });
  }

  it("the raw value is scrubbed at every cut point too (the old rule still holds)", () => {
    for (let cut = 12; cut <= LONG.length; cut++) {
      const out = redact(`x |${LONG.slice(0, cut)}| y`);
      expect(leaksPiece(out, LONG), `cut ${cut}`).toBeNull();
      expect(out).toContain("<phrase's text>");
    }
  });

  it("eleven characters of any encoding are left alone (below the floor)", () => {
    const fragment = encodeURIComponent(LONG).slice(0, 11);
    expect(redact(`x ${fragment} y`)).toBe(`x ${fragment} y`);
  });
});

describe("overlapping values leave no fragment (finding 1b)", () => {
  it("a short complete secret that starts where a longer secret's cut prefix starts does not win", () => {
    const longer = "Hunter-two-passphrase-ABCDEFGH-0123456789";
    const shorter = "Hunter-two-passph"; // a complete secret, itself a prefix of the longer one
    const redact = storeOf({ longer, shorter });
    const out = redact(`a ${longer.slice(0, 30)} b`);
    expect(out).toBe("a <longer's text> b");
    expect(out).not.toContain("ABCDEFGH");
  });

  it("the complete longer value wins over the shorter one inside it", () => {
    const longer = "Hunter-two-passphrase-ABCDEFGH-0123456789";
    const shorter = "passphrase-ABC";
    const redact = storeOf({ longer, shorter });
    expect(redact(`a ${longer} b`)).toBe("a <longer's text> b");
  });

  it("a secret whose end overlaps the start of another leaves nothing of the second", () => {
    const first = "alpha-secret-value-ONE";
    const second = "value-ONE-and-then-more-text";
    const redact = storeOf({ first, second });
    const out = redact("x alpha-secret-value-ONE-and-then-more-text y");
    expect(out).not.toContain("and-then");
    expect(out).not.toContain("more-text");
    expect(out.startsWith("x ")).toBe(true);
    expect(out.endsWith(" y")).toBe(true);
  });

  it("an encoded longer value cut inside, next to a shorter complete one", () => {
    const longer = "Hunter-two-passphrase-ABCDEFGH-0123456789";
    const shorter = "Hunter-two-passph";
    const redact = storeOf({ longer, shorter });
    const encoded = encodeURIComponent(longer).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
    for (let cut = 12; cut <= encoded.length; cut++) {
      const out = redact(`a ${encoded.slice(0, cut)} b`);
      expect(leaksPiece(out, longer.slice(12)) ?? null, `cut ${cut}: ${out}`).toBeNull();
    }
  });
});
