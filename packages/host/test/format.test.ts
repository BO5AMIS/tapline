import { describe, expect, it } from "vitest";
import { formatChanges, formatElement, formatLogs, formatTree } from "../src/format.js";
import type { TreeResult } from "../src/protocol.js";

const tree: TreeResult = {
  screen: { width: 402, height: 874, scale: 3 },
  elements: [
    { ref: "e1", type: "Text", role: null, text: "Welcome back", frame: { x: 24, y: 120, width: 200, height: 32 } },
    {
      ref: "e2",
      type: "TextInput",
      role: null,
      testID: "email",
      label: "Email",
      text: "",
      value: "me@example.com",
      frame: { x: 24, y: 200, width: 354, height: 44 },
      actions: ["type", "submit"],
      disabled: false,
    },
    {
      ref: "e3",
      type: "Pressable",
      role: "button",
      testID: "login-button",
      label: "Log in",
      text: "Log in",
      value: null,
      frame: { x: 24, y: 610, width: 354, height: 48 },
      actions: ["press", "longPress"],
      disabled: false,
      selected: false,
      checked: null,
    },
    {
      ref: "e4",
      type: "Switch",
      role: "switch",
      label: "Remember me",
      frame: { x: 330.4, y: 300.6, width: 51, height: 31 },
      actions: ["toggle"],
      checked: true,
      disabled: true,
    },
  ],
};

describe("formatElement", () => {
  it("renders the documented example line", () => {
    expect(formatElement(tree.elements[2]!)).toBe('e3 button "Log in" testID=login-button @24,610 354x48 [press, longPress]');
  });

  it("omits empty fields", () => {
    expect(formatElement(tree.elements[0]!)).toBe('e1 Text "Welcome back" @24,120 200x32');
  });

  it("shows value, label when it differs, disabled and checked", () => {
    expect(formatElement(tree.elements[1]!)).toBe(
      'e2 TextInput "Email" testID=email value="me@example.com" @24,200 354x44 [type, submit]',
    );
    expect(formatElement(tree.elements[3]!)).toBe('e4 switch "Remember me" disabled checked=true @330,301 51x31 [toggle]');
  });

  it("clips very long text and flattens whitespace", () => {
    const line = formatElement({ ref: "e9", text: `a\n${"b".repeat(200)}` });
    expect(line.length).toBeLessThan(100);
    expect(line).toContain("…");
    expect(line).not.toContain("\n");
  });
});

describe("formatTree", () => {
  it("has a header with the screen size and one line per element", () => {
    const lines = formatTree(tree).split("\n");
    expect(lines[0]).toBe("Screen 402x874 @3x (points) - 4 elements");
    expect(lines).toHaveLength(5);
  });

  it("is deterministic", () => {
    expect(formatTree(tree)).toBe(formatTree(structuredClone(tree)));
  });

  it("explains an empty screen", () => {
    expect(formatTree({ screen: { width: 100, height: 200 }, elements: [] })).toContain("nothing visible");
  });

  it("names the focused screen on the second line, with simple params", () => {
    const lines = formatTree({
      ...tree,
      route: { names: ["(tabs)", "nutrition"], params: { day: "2026-11-09", count: 3 } },
    }).split("\n");
    expect(lines[1]).toBe('Route: (tabs) › nutrition (day="2026-11-09", count=3)');
    expect(lines).toHaveLength(6);
    expect(formatTree({ ...tree, route: { names: ["home"] } }).split("\n")[1]).toBe("Route: home");
  });

  it("shows open alerts and requests in flight under the header, in full lists and change lists", () => {
    const withStatus = {
      ...tree,
      route: { names: ["workouts"] },
      alerts: [
        {
          kind: "alert" as const,
          title: "Delete workout?",
          message: "This can't be undone.",
          buttons: [
            { text: "Cancel", style: "cancel" as const },
            { text: "Delete", style: "destructive" as const },
          ],
          standIn: false,
        },
      ],
      network: { inFlight: 2 },
    };
    const lines = formatTree(withStatus).split("\n");
    expect(lines[1]).toBe("Route: workouts");
    expect(lines[2]).toBe(
      "Alert: \"Delete workout?\" This can't be undone. [Cancel] [Delete (destructive)] (an OS alert: Tapline can't press it; ask the user to tap one)",
    );
    expect(lines[3]).toBe("Network: 2 requests in flight");

    const standIn = formatTree({ ...withStatus, alerts: [{ ...withStatus.alerts[0]!, standIn: true }], network: undefined });
    expect(standIn).toContain("(Tapline's stand-in: press its buttons like any element)");
    expect(standIn).not.toContain("Network:");

    const changes = formatChanges({
      ...withStatus,
      changes: { sameRoute: true, added: [], removed: [], changed: [], moved: [] },
    });
    expect(changes).toContain('Alert: "Delete workout?"');
    expect(changes).toContain("Network: 2 requests in flight");
  });

  it("shows a native tab without a position", () => {
    expect(
      formatElement({ ref: "e9", type: "Tab", role: "tab", text: "Nutrition", frame: null, actions: ["press"], selected: false }),
    ).toBe('e9 tab "Nutrition" [press]');
  });
});

describe("formatLogs", () => {
  it("renders time, level and message", () => {
    const out = formatLogs([{ level: "warn", message: "careful", ts: Date.UTC(2026, 0, 1, 12, 30, 5, 7) }]);
    expect(out).toBe("12:30:05.007 warn careful");
  });
  it("handles an empty list", () => {
    expect(formatLogs([])).toBe("(no log lines)");
  });
});
