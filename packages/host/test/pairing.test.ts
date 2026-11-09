import { describe, expect, it } from "vitest";
import { PAIR_CODE_TTL_MS, createPairCode, forgetLink, pairingLink, verifyPairCode } from "../src/pairing.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const NOW = 1_800_000_000_000;

describe("pairing codes", () => {
  it("accepts a fresh code made with the same token", () => {
    const code = createPairCode(TOKEN, NOW);
    expect(code).toMatch(/^[0-9a-z]+-[0-9a-f]{20}$/);
    expect(verifyPairCode(TOKEN, code, NOW + 1000)).toBe(true);
  });

  it("lasts ten minutes", () => {
    expect(PAIR_CODE_TTL_MS).toBe(10 * 60 * 1000);
    const code = createPairCode(TOKEN, NOW);
    expect(verifyPairCode(TOKEN, code, NOW + PAIR_CODE_TTL_MS - 1)).toBe(true);
    expect(verifyPairCode(TOKEN, code, NOW + PAIR_CODE_TTL_MS + 1)).toBe(false);
  });

  it("rejects a code made with another token", () => {
    const code = createPairCode("ffffffffffffffffffffffffffffffff", NOW);
    expect(verifyPairCode(TOKEN, code, NOW)).toBe(false);
  });

  it("rejects a code whose expiry was changed", () => {
    const code = createPairCode(TOKEN, NOW);
    const [, mac] = code.split("-");
    const later = (NOW + PAIR_CODE_TTL_MS * 5).toString(36);
    expect(verifyPairCode(TOKEN, `${later}-${mac ?? ""}`, NOW + PAIR_CODE_TTL_MS * 2)).toBe(false);
  });

  it("rejects malformed codes", () => {
    for (const bad of ["", "abc", "zz-zz", "-", `${NOW.toString(36)}-`, "a-b-c"]) {
      expect(verifyPairCode(TOKEN, bad, NOW)).toBe(false);
    }
  });
});

describe("links", () => {
  it("builds <scheme>://tapline/pair with the url, code and computer name encoded", () => {
    const link = pairingLink({ scheme: "myapp", url: "ws://100.64.0.1:7211/", code: "abc-123", name: "Dev PC" });
    expect(link).toBe("myapp://tapline/pair?url=ws%3A%2F%2F100.64.0.1%3A7211%2F&code=abc-123&name=Dev%20PC");
  });

  it("accepts a scheme written with :// and builds the forget link", () => {
    expect(pairingLink({ scheme: "myapp://", url: "ws://h:1/", code: "c", name: "n" })).toMatch(/^myapp:\/\/tapline\/pair\?/);
    expect(forgetLink("myapp")).toBe("myapp://tapline/forget");
  });

  it("rejects a scheme that is not a valid URL scheme", () => {
    for (const bad of ["", "my app", "1app", "http", "https"]) {
      expect(() => pairingLink({ scheme: bad, url: "ws://h:1/", code: "c", name: "n" })).toThrow(/scheme/);
    }
  });
});
