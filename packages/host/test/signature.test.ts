import { describe, expect, it } from "vitest";
import { namedTarget, positionBucket, sharedIndex, signatureOf, signaturesOf, tierOf, type NamedElement } from "../src/signature.js";

// AGENT-TOOLS 1.15 §25.3: the action signature.

const screen = { width: 400, height: 800 };
const at = (x: number, y: number, width = 40, height = 40): { x: number; y: number; width: number; height: number } => ({ x, y, width, height });

describe("position bucket", () => {
  it("is the centre on a 4 by 8 grid, from 0 at the top left", () => {
    expect(positionBucket(at(0, 0, 10, 10), screen)).toBe("c0r0");
    // centre (120, 620): column 1 (100 to 200), row 6 (600 to 700)
    expect(positionBucket(at(100, 600, 40, 40), screen)).toBe("c1r6");
    expect(positionBucket(at(380, 780, 20, 20), screen)).toBe("c3r7");
  });
  it("takes the centre, not the corner", () => {
    // corner is in column 0, centre (150) in column 1
    expect(positionBucket(at(90, 0, 120, 10), screen)).toBe("c1r0");
  });
  it("keeps an element past the edge on the grid", () => {
    expect(positionBucket(at(500, 900, 10, 10), screen)).toBe("c3r7");
    expect(positionBucket(at(-100, -100, 10, 10), screen)).toBe("c0r0");
  });
  it("is null without a usable screen", () => {
    expect(positionBucket(at(0, 0), null)).toBeNull();
    expect(positionBucket(at(0, 0), { width: 0, height: 800 })).toBeNull();
  });
});

describe("signature tiers", () => {
  it("1: id wins over everything", () => {
    expect(signatureOf({ testID: "save", label: "Save", text: "Save", role: "button", frame: at(0, 0) }, { screen })).toBe("id:save");
  });
  it("2: label when there is no id", () => {
    expect(signatureOf({ label: "Save", text: "Done", role: "button" }, { screen })).toBe("label:Save");
  });
  it("3: text when there is no id or label", () => {
    expect(signatureOf({ text: "Done", role: "button" }, { screen })).toBe("text:Done");
  });
  it("4: role and bucket when there are no names", () => {
    expect(signatureOf({ role: "button", frame: at(100, 600) }, { screen })).toBe("role:button@c1r6");
  });
  it("an empty string is no name", () => {
    expect(signatureOf({ testID: "", label: "", text: "Go" }, { screen })).toBe("text:Go");
  });
  it("is null for an element with nothing to name it by, and never uses a point", () => {
    expect(signatureOf({ role: "button" }, { screen })).toBeNull();
    expect(signatureOf({ frame: at(0, 0) }, { screen })).toBeNull();
    expect(signatureOf({ role: "button", frame: at(0, 0) }, {})).toBeNull();
  });
  it("tierOf names the tier", () => {
    expect(tierOf({ testID: "a" })).toBe("id");
    expect(tierOf({ label: "a" })).toBe("label");
    expect(tierOf({ text: "a" })).toBe("text");
    expect(tierOf({ role: "button", frame: at(0, 0) }, { screen })).toBe("role");
    expect(tierOf({ role: "button" })).toBeNull();
    expect(tierOf({ text: "a", row: true })).toBeNull();
  });
});

describe("signature text", () => {
  it("is cut at 80 characters", () => {
    const sig = signatureOf({ text: "x".repeat(200) }, {});
    expect(sig).toBe(`text:${"x".repeat(80)}`);
  });
  it("is redacted before it is cut", () => {
    const redact = (t: string): string => t.replace("hunter2", "<password>");
    expect(signatureOf({ label: "Hello hunter2" }, { redact })).toBe("label:Hello <password>");
  });
  it("never splits a character in two", () => {
    const sig = signatureOf({ text: "😀".repeat(100) }, {}) ?? "";
    expect(Array.from(sig.slice("text:".length))).toHaveLength(80);
  });
  it("keeps the id as it is", () => {
    expect(signatureOf({ testID: "a".repeat(100) }, {})).toBe(`id:${"a".repeat(100)}`);
  });
});

describe("shared names and rows", () => {
  it("ends #index (0-based) when several elements share the name", () => {
    const list: NamedElement[] = [{ text: "More", frame: at(0, 0) }, { text: "Less" }, { text: "More", frame: at(0, 100) }];
    expect(sharedIndex(list[0] as NamedElement, list)).toBe(0);
    expect(sharedIndex(list[2] as NamedElement, list)).toBe(1);
    expect(sharedIndex(list[1] as NamedElement, list)).toBeUndefined();
    expect(signaturesOf(list, { screen })).toEqual(["text:More#0", "text:Less", "text:More#1"]);
  });
  it("matches labels ignoring case, as a label target does", () => {
    const list: NamedElement[] = [{ label: "Close" }, { label: "close" }];
    expect(signaturesOf(list, {})).toEqual(["label:Close#0", "label:close#1"]);
  });
  it("shares a role-and-bucket name only inside one bucket", () => {
    const list: NamedElement[] = [
      { role: "button", frame: at(100, 600) },
      { role: "button", frame: at(110, 610) },
      { role: "button", frame: at(300, 600) },
    ];
    expect(signaturesOf(list, { screen })).toEqual(["role:button@c1r6#0", "role:button@c1r6#1", "role:button@c3r6"]);
  });
  it("names a row by its list and number, never by its text", () => {
    const row: NamedElement = { text: "Private trip to Doha", row: true, testID: "trip-1" };
    expect(signatureOf(row, { row: { list: "id:trips", n: 2 } })).toBe("row:id:trips#2");
    expect(signatureOf(row, {})).toBeNull();
    expect(signatureOf(row, { row: { list: "id:trips", n: 0 } })).toBeNull();
  });
  it("a row's list signature may itself end in an index", () => {
    expect(signatureOf({ row: true }, { row: { list: "role:list@c0r2#1", n: 1 } })).toBe("row:role:list@c0r2#1#1");
  });
  it("the role tier takes the first-read frame for scroll content", () => {
    const element: NamedElement = { role: "button", frame: at(100, 900) };
    expect(signatureOf(element, { screen, frame: at(100, 100) })).toBe("role:button@c1r1");
  });
});

describe("namedTarget (what record saves)", () => {
  it("is testID, else label, else text", () => {
    expect(namedTarget({ testID: "a", label: "b", text: "c" })).toEqual({ testID: "a" });
    expect(namedTarget({ label: "b", text: "c" })).toEqual({ label: "b" });
    expect(namedTarget({ text: "c" })).toEqual({ text: "c" });
    expect(namedTarget({ testID: null, label: "", text: null })).toBeNull();
  });
});

describe("PR 13 CodeRabbit: indexes follow the signature as it is kept", () => {
  it("two labels that share their first 80 characters get indexes", () => {
    const prefix = "x".repeat(80);
    const a: NamedElement = { label: `${prefix} one`, role: "button" };
    const b: NamedElement = { label: `${prefix} two`, role: "button" };
    const sigs = signaturesOf([a, b], { screen });
    expect(sigs[0]).not.toBeNull();
    expect(sigs[0]).not.toBe(sigs[1]);
  });

  it("two role-only elements whose supplied frames share a bucket but whose own frames differ get indexes", () => {
    const a: NamedElement = { role: "button", frame: at(0, 0) };
    const b: NamedElement = { role: "button", frame: at(300, 700) };
    const same = at(10, 10);
    const sigs = signaturesOf([a, b], { screen, frameOf: () => same });
    expect(sigs[0]).not.toBe(sigs[1]);
  });

  it("a redacted text that collapses two texts gets indexes", () => {
    const a: NamedElement = { text: "secret-1", role: "text" };
    const b: NamedElement = { text: "secret-2", role: "text" };
    const sigs = signaturesOf([a, b], { screen, redact: () => "hidden" });
    expect(sigs[0]).not.toBe(sigs[1]);
  });

  it("an element with a name of its own still has none appended", () => {
    const sigs = signaturesOf([{ label: "Save", role: "button" }, { label: "Cancel", role: "button" }], { screen });
    expect(sigs).toEqual(["label:Save", "label:Cancel"]);
  });
});
