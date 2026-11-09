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
    expect(formatElement(tree.elements[2]!)).toBe('e3 button "Log in" id=login-button @24,610 354x48 [tap, longPress]');
  });

  it("omits empty fields", () => {
    expect(formatElement(tree.elements[0]!)).toBe('e1 Text "Welcome back" @24,120 200x32');
  });

  it("shows value, label when it differs, disabled and checked", () => {
    expect(formatElement(tree.elements[1]!)).toBe(
      'e2 TextInput "Email" id=email value="me@example.com" @24,200 354x44 [type]',
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

describe("element lines (AGENT-TOOLS §3.3)", () => {
  const base = {
    ref: "e3",
    type: "Pressable",
    role: null as string | null,
    text: "Log in",
    label: null,
    testID: "login",
    value: null,
    disabled: false,
    selected: false,
    checked: null,
    frame: { x: 24, y: 610, width: 354, height: 48 },
    actions: ["press", "longPress"],
  };

  it("shows id=, lowercase shared roles, and tap", () => {
    expect(formatElement({ ...base, role: "button" })).toBe('e3 button "Log in" id=login @24,610 354x48 [tap, longPress]');
  });

  it.each([
    ["textfield", "input"],
    ["search", "input"],
    ["textbox", "input"],
    ["scrollview", "scroll"],
    ["imagebutton", "button"],
    ["togglebutton", "button"],
    ["adjustable", "slider"],
    ["img", "image"],
    ["summary", "text"],
    ["header", "header"],
    ["radio", "radio"],
    ["Tab", "tab"],
    ["constructor", "constructor"],
  ])("role %s reads as %s", (from, to) => {
    expect(formatElement({ ...base, role: from }).split(" ")[1]).toBe(to);
  });

  it("falls back to the component name when there's no role", () => {
    expect(formatElement({ ...base, role: null, type: "FancyThing" }).split(" ")[1]).toBe("FancyThing");
  });

  it("lists type without submit, and scroll and toggle as they are", () => {
    expect(formatElement({ ...base, role: "textfield", actions: ["type", "submit"] })).toMatch(/\[type\]$/);
    expect(formatElement({ ...base, role: "switch", actions: ["toggle"] })).toMatch(/\[toggle\]$/);
    expect(formatElement({ ...base, role: "scrollview", actions: ["scroll"] })).toMatch(/\[scroll\]$/);
  });

  it("leaves the action list out when only submit is offered", () => {
    expect(formatElement({ ...base, actions: ["submit"] })).not.toContain("[");
  });
});

describe("the header (AGENT-TOOLS §3.2)", () => {
  it("starts with the screen line, then the app, with no session id", () => {
    const text = formatTree(
      { screen: { width: 440, height: 956, scale: 3 }, elements: [], route: { names: ["(tabs)", "today"], params: {} } },
      { name: "Demo", id: "com.example.demo" },
    );
    expect(text.split("\n").slice(0, 3)).toEqual([
      "Screen 440x956 pt @3x · 0 elements",
      "App: Demo (com.example.demo)",
      "Route: (tabs) › today",
    ]);
  });

  it("lists up to 200 elements, then says how many more", () => {
    const elements = Array.from({ length: 205 }, (_, i) => ({
      ref: `e${i + 1}`,
      type: "Text",
      role: "text",
      text: `Row ${i}`,
    }));
    const text = formatTree({ screen: { width: 440, height: 956, scale: 3 }, elements });
    expect(text).toContain("Screen 440x956 pt @3x · 205 elements");
    expect(text).toContain('e200 text "Row 199"');
    expect(text).not.toContain("e201 ");
    expect(text.trimEnd().endsWith("(+5 more below; scroll)")).toBe(true);
  });
});

describe("formatTree", () => {
  it("has a header with the screen size and one line per element", () => {
    const lines = formatTree(tree).split("\n");
    expect(lines[0]).toBe("Screen 402x874 pt @3x · 4 elements");
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
    ).toBe('e9 tab "Nutrition" [tap]');
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
