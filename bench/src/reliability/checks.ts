/**
 * The reliability checks as data (docs/QUALITY-BAR.md R1-R5). The driver in suite.ts runs them;
 * to add a check, add a row here.
 */

export type Target = { id: string } | { text: string };

export interface Call {
  tool: string;
  args: Record<string, unknown>;
}

/** A call plus what to bring into view first and which state it must produce. */
export interface StateCall {
  tool: string;
  /** `{id}` or `{text}`; becomes the `target` argument. */
  target?: Target;
  args?: Record<string, unknown>;
  /** The id to bring into view first (default: the target's id); null: don't. */
  bring?: string | null;
  /** Calls to make first (for example scroll to the end). */
  before?: Call[];
  /** Parts of lab-state that must show afterwards. */
  expect?: string[];
}

const scrollTo = (to: "start" | "end"): Call => ({
  tool: "scroll",
  args: { target: { id: "lab-scroll" }, to, look: false },
});

/* ---------- R1 / R2: the right element, no false refusals ---------- */

export interface ActStep extends StateCall {
  name: string;
  /** Tap straight after the previous step, with no look in between. */
  immediate?: boolean;
  /** The alert flow: the answer's `Alert:` line decides how it is answered. */
  alert?: boolean;
  /** Close the keyboard afterwards (a tap outside the field), as a person would before the next step. */
  closeKeyboard?: boolean;
}

const tap = (id: string): Pick<ActStep, "tool" | "target"> => ({ tool: "tap", target: { id } });

export const R1_STEPS: ActStep[] = [
  { name: "tap lab-taps", ...tap("lab-taps"), expect: ["taps=1"] },
  { name: "tap lab-save", ...tap("lab-save"), expect: ["pressed=save"] },
  { name: "tap lab-dup-2 by id", ...tap("lab-dup-2"), expect: ["pressed=dup-2"] },
  {
    name: "type into lab-input",
    tool: "type_text",
    target: { id: "lab-input" },
    args: { text: "abc" },
    expect: ["typed=abc"],
    closeKeyboard: true,
  },
  {
    name: "type into lab-input-2",
    tool: "type_text",
    target: { id: "lab-input-2" },
    args: { text: "xyz" },
    expect: ["typed2=xyz", "typed=abc"],
    closeKeyboard: true,
  },
  {
    name: "toggle lab-switch",
    tool: "toggle",
    target: { id: "lab-switch" },
    args: { value: true },
    expect: ["switch=on"],
  },
  { name: "long press lab-long", tool: "long_press", target: { id: "lab-long" }, expect: ["long=1"] },
  { name: "tap lab-edge-tl", ...tap("lab-edge-tl"), expect: ["pressed=edge-tl"] },
  { name: "tap lab-edge-br", ...tap("lab-edge-br"), expect: ["pressed=edge-br"] },
  {
    name: "tap text Row 3",
    tool: "tap",
    target: { text: "Row 3" },
    bring: "lab-row-3",
    expect: ["row=3"],
  },
  // From the top, so lab-save is on screen for the "at once" tap after the sheet closes.
  { name: "open the sheet", ...tap("lab-open-sheet"), before: [scrollTo("start")], expect: ["sheet=open"] },
  { name: "tap lab-sheet-button", ...tap("lab-sheet-button"), bring: null, expect: ["pressed=sheet-button"] },
  { name: "close the sheet", ...tap("lab-sheet-close"), bring: null, expect: ["sheet=closed"] },
  {
    name: "tap lab-save right after the sheet closed",
    ...tap("lab-save"),
    bring: null,
    immediate: true,
    expect: ["pressed=save"],
  },
  {
    // From the start: the tool scrolls the off-screen target into view and taps it (AGENT-TOOLS 1.13.1 item 3).
    name: "tap lab-bottom from the top: the tool scrolls to it and taps",
    ...tap("lab-bottom"),
    bring: null,
    before: [scrollTo("start")],
    expect: ["pressed=bottom"],
  },
  { name: "tap lab-alert, answer it", ...tap("lab-alert"), alert: true, expect: ["alert=ok"] },
];

/* ---------- R3: never silently something else ---------- */

export interface RefuseCheck {
  name: string;
  target: Target;
  bring?: string | null;
  before?: Call[];
  /** Reasons that count (the message starts with one of them). */
  reasons: string[];
  /** The lab-state value a wrong action would set; it must not show. */
  notPressed: string;
  /** Needs the tool's `alert` (the OS draws the UI in the way). */
  needsAlert?: boolean;
  /** Calls that put the lab in the state to test (each may expect state). */
  setup?: StateCall[];
  /** Calls that put the lab back. */
  teardown?: StateCall[];
  /** After the check, close an OS share sheet with the tool's means. */
  dismissShare?: boolean;
  /** Note for `not_found` instead of `not_actionable`. */
  notFoundNote?: string;
}

export const R3_CHECKS: RefuseCheck[] = [
  { name: "tap lab-disabled", target: { id: "lab-disabled" }, reasons: ["disabled"], notPressed: "disabled" },
  { name: "tap lab-covered", target: { id: "lab-covered" }, reasons: ["covered"], notPressed: "covered" },
  {
    // A button the lab's fixed header covers; no scroll can bring it out (AGENT-TOOLS 1.13.1 item 3).
    name: "tap lab-behind-bar, which no scroll can reach",
    target: { id: "lab-behind-bar" },
    bring: null,
    before: [scrollTo("start")],
    reasons: ["off_screen", "covered"],
    notPressed: "behind-bar",
  },
  {
    name: "tap lab-save behind the sheet",
    target: { id: "lab-save" },
    bring: null,
    reasons: ["covered"],
    notPressed: "save",
    setup: [{ ...tap("lab-open-sheet"), expect: ["sheet=open"] }],
    teardown: [{ ...tap("lab-sheet-close"), bring: null, expect: ["sheet=closed"] }],
    notFoundNote: "not_found instead of not_actionable (AGENT-TOOLS v1.4)",
  },
  {
    name: "tap lab-under-header",
    target: { id: "lab-under-header" },
    reasons: ["covered", "under_tab_bar"],
    notPressed: "under-header",
  },
  {
    name: "tap lab-save behind a native alert",
    target: { id: "lab-save" },
    reasons: ["behind_alert"],
    notPressed: "save",
    needsAlert: true,
    setup: [tapCall("lab-native-alert")],
    teardown: [
      { tool: "alert", args: { action: "dismiss" }, bring: null, expect: ["alert=native-cancel"] },
    ],
  },
  {
    name: "tap lab-save behind the share sheet",
    target: { id: "lab-save" },
    bring: null,
    reasons: ["covered", "behind_alert"],
    notPressed: "save",
    needsAlert: true,
    setup: [{ ...tapCall("lab-share"), expect: ["shared=opened"] }],
    dismissShare: true,
  },
];

function tapCall(id: string): StateCall {
  return { tool: "tap", target: { id } };
}

/** R3 is skipped for the OS-drawn cases when the tool has no `alert`. */
export const NO_ALERT_NOTE = "skipped: the tool can't dismiss OS-drawn UI (native alert, share sheet)";

/* ---------- R5: no silent guesses ---------- */

export const R5_CHECK = {
  name: "tap text Duplicate",
  target: { text: "Duplicate" } as Target,
  /** Values a silent guess would set. */
  notPressed: ["dup-1", "dup-2"],
};

/* ---------- R4: viewer input ---------- */

export type GridPoint =
  | { kind: "center"; id: string }
  | { kind: "gap"; above: string; below: string; xOf: string };

export interface GridCheck {
  name: string;
  point: GridPoint;
  /** pressed value the tap must set; absent: the state must stay as it was. */
  pressed?: string;
  /** For "unchanged" points: the value a wrong landing would set. */
  notPressed?: string;
  /** Open the sheet with the tool first, close it with the tool afterwards. */
  inSheet?: boolean;
}

export const R4_GRID: GridCheck[] = [
  { name: "viewer tap on lab-save", point: { kind: "center", id: "lab-save" }, pressed: "save" },
  { name: "viewer tap on lab-edge-tl", point: { kind: "center", id: "lab-edge-tl" }, pressed: "edge-tl" },
  { name: "viewer tap on lab-edge-br", point: { kind: "center", id: "lab-edge-br" }, pressed: "edge-br" },
  { name: "viewer tap on lab-covered (overlay takes it)", point: { kind: "center", id: "lab-covered" }, notPressed: "covered" },
  {
    name: "viewer tap on lab-under-header (the bar takes it)",
    point: { kind: "center", id: "lab-under-header" },
    notPressed: "under-header",
  },
  {
    name: "viewer tap on empty space",
    point: { kind: "gap", above: "lab-save", below: "lab-dup-1", xOf: "lab-save" },
    notPressed: "dup-1",
  },
  {
    name: "viewer tap on lab-sheet-button in the sheet",
    point: { kind: "center", id: "lab-sheet-button" },
    pressed: "sheet-button",
    inSheet: true,
  },
];

/* ---------- R6: drops end clearly ---------- */

export const R6_CHECK = {
  name: "the app freezes for 20 s",
  step: "freeze the app for 20 s",
  freezeId: "lab-freeze",
  /** The lab has no freeze fixture: R6 stays "not measured". */
  noFixtureNote: "R6: the lab has no lab-freeze fixture",
  /** Answers that end a call on a frozen app clearly (besides success, for the freezing tap). */
  clearCodes: ["not_answering", "timeout", "reconnecting"],
};

/** Shown for R6 when the lab has no freeze fixture, or the suite did not get that far. */
export const R6_NOT_MEASURED =
  "not measured by the runner: needs the lab's lab-freeze fixture (blocks the app for 20 s)";

/* ---------- R6-R8: not measured here ---------- */

export const NOT_MEASURED: { id: string; notes: string }[] = [
  { id: "R6", notes: R6_NOT_MEASURED },
  { id: "R7", notes: "not measured by the runner: needs the app's logs and the phone's crash list (pymobiledevice3 crash ls)" },
  { id: "R8", notes: "this suite with link: \"3g\" in the config (Network Link Conditioner on); not a separate run" },
];
