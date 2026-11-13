import { describe, expect, it } from "vitest";
import { alertNotes, alertSignature, formatChanges, formatElement, formatLogs, formatOffScreenAfterList, formatTree } from "../src/format.js";
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
    expect(formatElement(tree.elements[3]!)).toBe('e4 switch "Remember me" disabled checked=true @330,301 51x31');
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

describe("changes off screen (AGENT-TOOLS v1.6)", () => {
  const STATE = { ref: "", type: "Text", role: null, testID: "lab-state", text: "taps=1 row=30", frame: { x: 16, y: -900, width: 398, height: 68 } };
  const base = { sameRoute: true, added: [], removed: [], changed: [], moved: [] };

  it("lists them without a ref, marked off screen, with the old value", () => {
    const block = formatChanges({ ...tree, changes: { ...base, offScreen: [{ element: STATE, was: { text: "taps=1 row=-" } }] } });
    expect(block).toBe(
      ['Same screen. Changes:', '~ text "taps=1 row=30" id=lab-state (off screen; was "taps=1 row=-")'].join("\n"),
    );
  });

  it("counts the ones beyond five", () => {
    const block = formatChanges({
      ...tree,
      changes: { ...base, offScreen: [{ element: STATE, was: { text: "x" } }], offScreenMore: 2 },
    });
    expect(block?.split("\n").at(-1)).toBe("~ 2 more changed off screen");
  });

  it("several fields are named, as on screen", () => {
    const sw = { ref: "", type: "Switch", role: "switch", label: "Notify", checked: true, disabled: false, frame: { x: 16, y: 1200, width: 60, height: 32 } };
    const block = formatChanges({ ...tree, changes: { ...base, offScreen: [{ element: sw, was: { checked: false, disabled: true } }] } });
    expect(block?.split("\n")[1]).toBe('~ switch "Notify" checked=true (off screen; was checked=false, disabled=true)');
  });

  it("with nothing on screen or off it: No visible change.", () => {
    expect(formatChanges({ ...tree, changes: base })).toBe("Same screen. Changes:\nNo visible change.");
  });
});

describe("a cut never splits a character", () => {
  it("leaves an emoji across the 200th place out whole, and counts it", () => {
    const text = `${"a".repeat(199)}😀${"b".repeat(10)}`;
    expect(formatElement({ ref: "e9", text })).toBe(`e9 "${"a".repeat(199)}…(+12)"`);
    expect(formatElement({ ref: "e9", text: `${"a".repeat(198)}😀` })).toBe(`e9 "${"a".repeat(198)}😀"`);
  });
});

describe("off-screen changes after a full list", () => {
  const STATE = { ref: "", type: "Text", role: null, testID: "lab-state", text: "row=5", frame: { x: 16, y: -900, width: 398, height: 68 } };
  const changes = { sameRoute: true, added: [], removed: [], changed: [], moved: [], offScreen: [{ element: STATE, was: { text: "row=-" } }], offScreenMore: 1 };

  it("gives the same lines when most of the same screen changed", () => {
    expect(formatOffScreenAfterList({ ...tree, changes })).toEqual([
      "Changes off screen:",
      '~ text "row=5" id=lab-state (off screen; was "row=-")',
      "~ 1 more changed off screen",
    ]);
  });

  it("gives nothing on another screen, with nothing listed, or without changes", () => {
    expect(formatOffScreenAfterList({ ...tree, changes: { ...changes, sameRoute: false } })).toEqual([]);
    expect(formatOffScreenAfterList({ ...tree, elements: [], changes })).toEqual([]);
    expect(formatOffScreenAfterList(tree)).toEqual([]);
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
    expect(formatElement({ ...base, role: "button", actions: ["toggle"] })).toMatch(/\[toggle\]$/);
    expect(formatElement({ ...base, role: "button", actions: ["scroll"] })).toMatch(/\[scroll\]$/);
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
    expect(lines[2]).toBe("Alert: \"Delete workout?\" \"This can't be undone.\" [Cancel] [Delete (destructive)]");
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

  describe("an alert's message (AGENT-TOOLS 1.14 §3.2)", () => {
    const alertOf = (message: string | null) => ({
      ...tree,
      alerts: [{ kind: "alert" as const, title: "Allow notifications?", message, buttons: [{ text: "Allow", style: "default" as const }], standIn: false }],
    });
    const alertLine = (t: TreeResult): string | undefined => formatTree(t).split("\n").find((line) => line.startsWith("Alert:"));

    it("reads Alert: \"<title>\" \"<message>\" [Button], JSON-quoted with whitespace flattened", () => {
      expect(alertLine(alertOf('Wayfare would\n  like to "send" you notifications.'))).toBe(
        'Alert: "Allow notifications?" "Wayfare would like to \\"send\\" you notifications." [Allow]',
      );
    });

    it("is left out when empty or missing, which gives the form without a message", () => {
      expect(alertLine(alertOf(null))).toBe('Alert: "Allow notifications?" [Allow]');
      expect(alertLine(alertOf(""))).toBe('Alert: "Allow notifications?" [Allow]');
      expect(alertLine(alertOf("   \n "))).toBe('Alert: "Allow notifications?" [Allow]');
    });

    it("is cut like element text at 200 characters, ending …(+N)", () => {
      const line = alertLine(alertOf("x".repeat(257)));
      expect(line).toBe(`Alert: "Allow notifications?" "${"x".repeat(200)}…(+57)" [Allow]`);
    });

    it("is not cut at 200 characters or fewer", () => {
      expect(alertLine(alertOf("y".repeat(200)))).toContain(`"${"y".repeat(200)}" [Allow]`);
    });

    it("stays in a change block's header with its message", () => {
      const changes = formatChanges({ ...alertOf("Body."), changes: { sameRoute: true, added: [], removed: [], changed: [], moved: [] } });
      expect(changes).toContain('Alert: "Allow notifications?" "Body." [Allow]');
    });

    it("a message-only change is a change of the alert: no 'No visible change.'", () => {
      const t = { ...alertOf("New body."), changes: { sameRoute: true, added: [], removed: [], changed: [], moved: [] } };
      expect(formatChanges(t)).toContain("No visible change.");
      const said = formatChanges(t, { alertChanged: true });
      expect(said).not.toContain("No visible change.");
      expect(said?.split("\n").slice(0, 2)).toEqual(["Same screen. Changes:", 'Alert: "Allow notifications?" "New body." [Allow]']);
      expect(alertSignature(alertOf("A"))).not.toBe(alertSignature(alertOf("B")));
      expect(alertSignature(alertOf("A"))).toBe(alertSignature(alertOf("A")));
    });
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

  it("Keyboard: shown in a list's header while it is up, between the alert and the network lines", () => {
    const up = {
      ...tree,
      keyboard: true,
      alerts: [{ kind: "alert" as const, title: "Hi", message: null, buttons: [], standIn: true }],
      network: { inFlight: 1 },
    };
    const lines = formatTree(up).split("\n");
    const at = lines.indexOf("Keyboard: shown");
    expect(lines[at - 1]).toMatch(/^Alert: "Hi"/);
    expect(lines[at + 1]).toBe("Network: 1 request in flight");
    expect(formatTree(tree)).not.toContain("Keyboard:");
  });

  it("a change block says Keyboard: shown or hidden only when it came or went, and that is a change", () => {
    const same = { sameRoute: true, added: [], removed: [], changed: [], moved: [] };
    expect(formatChanges({ ...tree, keyboard: true, changes: { ...same, keyboard: "shown" as const } })).toBe(
      "Same screen. Changes:\nKeyboard: shown",
    );
    expect(formatChanges({ ...tree, changes: { ...same, keyboard: "hidden" as const } })).toBe("Same screen. Changes:\nKeyboard: hidden");
    // Still up, as before: nothing to say about it.
    expect(formatChanges({ ...tree, keyboard: true, changes: same })).toBe("Same screen. Changes:\nNo visible change.");
  });

  it("an alert closing alone is a change, not 'No visible change'", () => {
    const t = { ...tree, changes: { sameRoute: true, added: [], removed: [], changed: [], moved: [] } };
    expect(formatChanges(t, { alertGone: true })).toBe("Same screen. Changes:\nAlert: gone");
  });

  it("shows a native tab without a position", () => {
    expect(
      formatElement({ ref: "e9", type: "Tab", role: "tab", text: "Nutrition", frame: null, actions: ["press"], selected: false }),
    ).toBe('e9 tab "Nutrition"');
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

  it("shows an empty input's placeholder instead of a value, and a typed value as once a placeholder (AGENT-TOOLS v1.7)", () => {
    const empty = { ref: "e3", type: "TextInput", role: "textfield", label: "Name", text: "", value: "", placeholder: "Alex Morgan", testID: "name", actions: ["press", "type"], frame: null };
    expect(formatElement(empty)).toBe('e3 input "Name" id=name placeholder="Alex Morgan"');
    // a value and a placeholder are never both shown
    expect(formatElement({ ...empty, value: "Sam", placeholder: "Alex Morgan" })).not.toContain("placeholder=");
    const t = withChanges(3, { ...none, changed: [{ ref: "e3", was: { value: "", placeholder: "Alex Morgan" } }] });
    t.elements[2] = { ...empty, value: "abc", placeholder: undefined };
    expect(formatChanges(t)).toBe('Same screen. Changes:\n~ e3 input "Name" id=name value="abc" (was placeholder "Alex Morgan")');
    // cleared again: the old value is what it was; the placeholder coming back isn't news
    const cleared = withChanges(3, { ...none, changed: [{ ref: "e3", was: { value: "abc" } }] });
    cleared.elements[2] = empty;
    expect(formatChanges(cleared)).toContain('placeholder="Alex Morgan" (was "abc")');
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
  it("renders local time, level and message", () => {
    const out = formatLogs([{ level: "warn", message: "careful", ts: new Date(2026, 0, 1, 12, 30, 5, 7).getTime() }]);
    expect(out).toBe("12:30:05.007 warning careful");
  });
  it("maps levels and keeps an entry on one line, cut at 300 characters", () => {
    const ts = new Date(2026, 0, 1, 9, 0, 0, 0).getTime();
    expect(formatLogs([{ level: "log", message: "a", ts }])).toBe("09:00:00.000 info a");
    expect(formatLogs([{ level: "info", message: "fatal one", fatal: true, ts }])).toBe("09:00:00.000 error fatal one");
    expect(formatLogs([{ level: "error", message: "TypeError: x", stack: "at A (a.js:1)\nat B (b.js:2)", ts }])).toBe(
      "09:00:00.000 error TypeError: x | at A (a.js:1) | at B (b.js:2)",
    );
    const long = formatLogs([{ level: "log", message: "x".repeat(357), ts }]);
    expect(long).toBe(`09:00:00.000 info ${"x".repeat(300)}…(+57)`);
  });
  it("handles an empty list", () => {
    expect(formatLogs([])).toBe("(no log lines)");
  });
});

describe("shorter answers (AGENT-TOOLS 1.8 §13)", () => {
  it("leaves out the actions a role implies and keeps any other set", async () => {
    const { formatElement } = await import("../src/format.js");
    expect(formatElement({ ref: "e4", role: "button", text: "Save", actions: ["press"] })).toBe('e4 button "Save"');
    expect(formatElement({ ref: "e5", role: "textfield", label: "Email", actions: ["press", "type"] })).toBe('e5 input "Email"');
    expect(formatElement({ ref: "e6", type: "Switch", label: "Wi-Fi", checked: false, actions: ["toggle"] })).toBe('e6 switch "Wi-Fi" checked=false');
    expect(formatElement({ ref: "e7", role: "button", text: "Save", actions: ["press", "longPress"] })).toBe('e7 button "Save" [tap, longPress]');
    expect(formatElement({ ref: "e9", role: "text", text: "Help", actions: ["press"] })).toBe('e9 text "Help" [tap]');
  });

  it("cuts a long old value to what changed, with 12 characters each side; 40 or less stays whole", async () => {
    const { shortWas } = await import("../src/format.js");
    const old = "pressed=- typed= typed2= switch=off taps=2 long=0 slow=0 anim=off sheet=closed alert=none";
    expect(shortWas(old, old.replace("typed= ", "typed=hello "))).toBe("…sed=- typed= typed2= swi…");
    expect(shortWas("Total: 12 items in your basket, delivery on Thursday 14 May", "Total: 12 items in your basket, delivery on Friday 15 May")).toBe("…delivery on Thursday 14 May");
    expect(shortWas("3 trips planned for the spring, 2 of them shared with friends", "4 trips planned for the spring, 2 of them shared with friends")).toBe("3 trips plann…");
    expect(shortWas("Tap me 17", "Tap me 20")).toBe("Tap me 17");
  });
});
