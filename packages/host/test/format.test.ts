import { describe, expect, it } from "vitest";
import { alertNotes, formatChanges, formatElement, formatLogs, formatTree } from "../src/format.js";
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
    expect(formatElement(tree.elements[0]!)).toBe('e1 text "Welcome back" @24,120 200x32');
  });

  it("shows value, label when it differs, disabled and checked", () => {
    expect(formatElement(tree.elements[1]!)).toBe(
      'e2 input "Email" id=email value="me@example.com" @24,200 354x44 [type]',
    );
    expect(formatElement(tree.elements[3]!)).toBe('e4 switch "Remember me" disabled checked=true @330,301 51x31 [toggle]');
  });

  it("flattens whitespace and shows up to 200 characters whole", () => {
    expect(formatElement({ ref: "e9", text: `a\n  b` })).toBe('e9 "a b"');
    const text = "b".repeat(200);
    expect(formatElement({ ref: "e9", text })).toBe(`e9 "${text}"`);
  });

  it("cuts longer text at 200 characters and says how much is missing", () => {
    expect(formatElement({ ref: "e9", text: "b".repeat(257) })).toBe(`e9 "${"b".repeat(200)}…(+57)"`);
  });

  it("counts what the app had already left out of the text", () => {
    expect(formatElement({ ref: "e9", text: "b".repeat(2000), textMore: 500 })).toBe(`e9 "${"b".repeat(200)}…(+2300)"`);
  });

  it("cuts a long label and a long value the same way", () => {
    expect(formatElement({ ref: "e9", label: "c".repeat(210) })).toBe(`e9 "${"c".repeat(200)}…(+10)"`);
    expect(formatElement({ ref: "e9", type: "TextInput", label: "Notes", value: "d".repeat(203) })).toBe(
      `e9 input "Notes" value="${"d".repeat(200)}…(+3)"`,
    );
  });
});

describe("the screen line counts what is off screen (AGENT-TOOLS v1.5)", () => {
  const first = (result: TreeResult): string => formatTree(result).split("\n")[0] ?? "";

  it("says nothing when nothing is off screen", () => {
    expect(first(tree)).toBe("Screen 402x874 pt @3x · 4 elements");
    expect(first({ ...tree, offScreen: { above: 0, below: 0 } })).toBe("Screen 402x874 pt @3x · 4 elements");
  });

  it("counts below, then above", () => {
    expect(first({ ...tree, offScreen: { above: 2, below: 41 } })).toBe("Screen 402x874 pt @3x · 4 elements (+41 below, +2 above)");
    expect(first({ ...tree, offScreen: { above: 0, below: 41 } })).toBe("Screen 402x874 pt @3x · 4 elements (+41 below)");
    expect(first({ ...tree, offScreen: { above: 2, below: 0 } })).toBe("Screen 402x874 pt @3x · 4 elements (+2 above)");
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

  it.each([
    ["Image", [], "image"],
    ["TextInput", [], "input"],
    ["Switch", [], "switch"],
    ["Slider", [], "slider"],
    ["RNCSlider", [], "slider"],
    ["Text", [], "text"],
    ["ScrollView", [], "scroll"],
    ["FlatList", [], "scroll"],
    ["SectionList", [], "scroll"],
    ["VirtualizedList", [], "scroll"],
    ["Pressable", ["press"], "button"],
    ["TouchableOpacity", ["press"], "button"],
    ["TouchableHighlight", ["press"], "button"],
    ["Button", ["press"], "button"],
    ["Pressable", [], "other"],
    ["Button", [], "other"],
    ["View", [], "other"],
    ["FancyThing", [], "other"],
    ["FancyThing", ["press"], "other"],
  ])("with no role, a %s with actions %j reads as %s", (type, actions, expected) => {
    expect(formatElement({ ...base, role: null, type, actions }).split(" ")[1]).toBe(expected);
  });

  it("falls back to other, not the component name, for a container with no role", () => {
    expect(formatElement({ ...base, role: null, type: "FancyThing", actions: [] })).toMatch(/^e3 other /);
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
    expect(lines[2]).toBe("Alert: \"Delete workout?\" This can't be undone. [Cancel] [Delete (destructive)]");
    expect(lines[3]).toBe("Network: 2 requests in flight");
    // The alert's note is not a header line: it goes at the end of the answer with the other notes.
    expect(formatTree(withStatus)).not.toContain("Note:");
    expect(alertNotes(withStatus)).toEqual([
      "Note: an OS alert: Tapline can't tap it; ask the user to tap one, or use Tapwright.",
    ]);

    const standInTree = { ...withStatus, alerts: [{ ...withStatus.alerts[0]!, standIn: true }], network: undefined };
    const standIn = formatTree(standInTree);
    expect(standIn).not.toContain("Network:");
    expect(standIn).not.toContain("Note:");
    expect(alertNotes(standInTree)).toEqual(["Note: Tapline's stand-in alert: tap its buttons like any element."]);
    expect(alertNotes(tree)).toEqual([]);

    const changes = formatChanges({
      ...withStatus,
      changes: { sameRoute: true, added: [], removed: [], changed: [], moved: [] },
    });
    expect(changes).toContain('Alert: "Delete workout?"');
    expect(changes).toContain("Network: 2 requests in flight");
    expect(changes).not.toContain("Note:");
  });

  it("says Alert: gone in a change block when an alert closed, right after the first line", () => {
    const withNetwork = {
      ...tree,
      network: { inFlight: 1 },
      changes: { sameRoute: true, added: [], removed: [], changed: [{ ref: "e1", was: { text: "Hi" } }], moved: [] },
    };
    expect(formatChanges(withNetwork, { alertGone: true })!.split("\n").slice(0, 3)).toEqual([
      "Same screen. Changes:",
      "Alert: gone",
      "Network: 1 request in flight",
    ]);
    expect(formatChanges(withNetwork)).not.toContain("Alert: gone");
    // An alert that is still open is shown, not "gone".
    const open = { ...withNetwork, alerts: [{ kind: "alert" as const, title: "Hi", message: null, buttons: [], standIn: true }] };
    expect(formatChanges(open, { alertGone: true })).not.toContain("Alert: gone");
  });

  it("an alert closing alone is a change, not 'No visible change'", () => {
    const t = { ...tree, changes: { sameRoute: true, added: [], removed: [], changed: [], moved: [] } };
    expect(formatChanges(t, { alertGone: true })).toBe("Same screen. Changes:\nAlert: gone");
  });

  it("shows a native tab without a position", () => {
    expect(
      formatElement({ ref: "e9", type: "Tab", role: "tab", text: "Nutrition", frame: null, actions: ["press"], selected: false }),
    ).toBe('e9 tab "Nutrition" [tap]');
  });
});

describe("formatChanges (AGENT-TOOLS §3.1)", () => {
  const base = (n: number): TreeResult["elements"] =>
    Array.from({ length: n }, (_, i) => ({
      ref: `e${i + 1}`,
      type: "Text",
      role: "text",
      text: `row ${i + 1}`,
      frame: { x: 0, y: i * 10, width: 100, height: 10 },
    }));
  const withChanges = (n: number, changes: NonNullable<TreeResult["changes"]>): TreeResult => ({
    screen: { width: 402, height: 874, scale: 3 },
    elements: base(n),
    changes,
  });
  const none = { sameRoute: true, added: [], removed: [], changed: [], moved: [] };

  it("says so when nothing changed", () => {
    expect(formatChanges(withChanges(3, none))).toBe("Same screen. Changes:\nNo visible change.");
  });

  it("gives the full list, not changes, when the new tree is empty", () => {
    const gone = { ref: "e1", type: "Text", role: "text", text: "Hello" };
    const t: TreeResult = {
      screen: { width: 402, height: 874, scale: 3 },
      elements: [],
      changes: { ...none, removed: [gone] },
    };
    expect(formatChanges(t)).toBeNull();
    expect(formatTree(t)).toContain("(nothing visible; the app may still be loading)");
  });

  it("shows a single changed field with the old value only", () => {
    const t = withChanges(5, { ...none, changed: [{ ref: "e5", was: { text: "2 items" } }] });
    t.elements[4] = { ref: "e5", type: "Text", role: "text", text: "3 items", frame: null };
    expect(formatChanges(t)).toBe('Same screen. Changes:\n~ e5 text "3 items" (was "2 items")');
  });

  it("shows several changed fields as key=value pairs", () => {
    const t = withChanges(2, { ...none, changed: [{ ref: "e2", was: { text: "a", value: "b" } }] });
    expect(formatChanges(t)).toContain('(was text="a", value="b")');
  });

  it("shows a removed element without ref or position", () => {
    const gone = { ref: "e9", type: "Text", role: "text", text: "Loading", frame: { x: 1, y: 2, width: 3, height: 4 } };
    expect(formatChanges(withChanges(2, { ...none, removed: [gone] }))).toBe('Same screen. Changes:\n- text "Loading"');
  });

  it("never prints an empty gone line", () => {
    const named = { ref: "e8", type: "Text", role: "text", testID: "spinner" };
    const bare = { ref: "e9" };
    const noRole = { ref: "e7", text: "Hi" };
    const out = formatChanges(withChanges(2, { ...none, removed: [named, bare, noRole] }));
    expect(out).toBe('Same screen. Changes:\n- text id=spinner\n- element\n- "Hi"');
  });

  it("shows an old frame as a position, and an old checked as a value", () => {
    const one = withChanges(2, { ...none, changed: [{ ref: "e2", was: { frame: { x: 0, y: 10.4, width: 100, height: 10 } } }] });
    expect(formatChanges(one)).toContain("(was @0,10 100x10)");
    const many = withChanges(2, { ...none, changed: [{ ref: "e2", was: { frame: { x: 0, y: 10, width: 100, height: 10 }, text: "a" } }] });
    expect(formatChanges(many)).toContain('(was frame=@0,10 100x10, text="a")');
    const checked = withChanges(2, { ...none, changed: [{ ref: "e2", was: { checked: false } }] });
    expect(formatChanges(checked)).toContain("(was false)");
  });

  it("shows an old actions list the way element lines do", () => {
    const some = withChanges(2, { ...none, changed: [{ ref: "e2", was: { actions: ["press", "longPress", "submit"] } }] });
    expect(formatChanges(some)).toContain("(was [tap, longPress])");
    const empty = withChanges(2, { ...none, changed: [{ ref: "e2", was: { actions: [] } }] });
    expect(formatChanges(empty)).toContain("(was [])");
    const many = withChanges(2, { ...none, changed: [{ ref: "e2", was: { actions: ["press"], text: "a" } }] });
    expect(formatChanges(many)).toContain('(was actions=[tap], text="a")');
  });

  it("counts many moved elements, and lists a few", () => {
    const many = formatChanges(withChanges(9, { ...none, moved: ["e1", "e2", "e3", "e4", "e5", "e6", "e7"] }));
    expect(many).toBe("Same screen. Changes:\n↕ 7 elements moved");
    const few = formatChanges(withChanges(3, { ...none, moved: ["e1", "e2"] }))?.split("\n");
    expect(few?.slice(1)).toEqual(["↕ e1 text \"row 1\" @0,0 100x10", "↕ e2 text \"row 2\" @0,10 100x10"]);
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
