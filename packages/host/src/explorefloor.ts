import { PAYMENT_WORDS, ACCOUNT_WORDS, REACH_WORDS } from "./grants.js";
import type { SkipWhy } from "./mapfile.js";
import { DEFAULT_CONFIRM, asWords, matchWord, type PolicyFile } from "./policy.js";
import type { TreeElement } from "./protocol.js";

// The skip floor of `explore` (AGENT-TOOLS 1.15 §25.5): what the explorer never touches. The floor is checked afresh at every
// touch; a saved skip in the map never allows anything (§28.3). Pure functions, so every rule has a test.

/** The words of §21.3 that reach other people, and `Report` and `Block` (§25.5 item 2). */
export const REACH_OTHERS_WORDS: readonly string[] = [...REACH_WORDS, "Report", "Block"];

/**
 * A card is never touched either (§19.2): a control that asks for one. The vault's card fields are never typed by the explorer.
 * Words, whole and case-folded, as every policy word.
 */
export const CARD_WORDS: readonly string[] = ["Card number", "Credit card", "Debit card", "Add card", "CVV", "CVC"];

/** The built-in floor (§25.5 items 1 to 3): the built-in `confirm` words, the reach-others words and the never-grantable words. */
export const FLOOR_WORDS: readonly string[] = [...new Set([...DEFAULT_CONFIRM, ...REACH_OTHERS_WORDS, ...PAYMENT_WORDS, ...ACCOUNT_WORDS, ...CARD_WORDS])];

/** A control that may submit a form, on a screen that has a text input (§25.7). */
export const SUBMIT_WORDS: readonly string[] = ["Save", "Submit", "Continue", "Sign in", "Log in", "Sign up", "Register", "Create", "Confirm", "Apply", "Update", "Share"];

/** A place whose name says it is an account, privacy or security setting (§19.2): saved, never expanded. */
export const PROTECTED_PLACE_WORDS: readonly string[] = ["account", "accounts", "privacy", "security", "password", "passwords", "wallet", "payment", "payments", "billing"];

/** What a policy file's `"explore"` key holds (§25.5, §25.7). A key of the wrong shape is ignored, never an error. */
export interface ExploreSettings {
  /** Words a user adds to the floor (matched as in §11.1). */
  skip: string[];
  /** Ids of controls the explorer may tap on a screen where it types (§25.7). */
  submit: string[];
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : []);

/** The `explore` key of the policy file, read forgivingly: only what is a list of strings counts. */
export function exploreSettings(policy: PolicyFile): ExploreSettings {
  const raw: unknown = policy.explore;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { skip: [], submit: [] };
  const own = raw as Record<string, unknown>;
  return { skip: strings(own["skip"]), submit: strings(own["submit"]) };
}

/**
 * The policy's lists as explore reads them (§25.5): the union of the global lists and the app's own, never the app's alone. An app's
 * lists replace the global ones for an ordinary touch; for the floor they can only add (`"confirm": []` lowers nothing).
 */
export function exploreLists(policy: PolicyFile, app: { id?: string; name: string } | undefined): { confirm: string[]; block: string[] } {
  const own = app === undefined ? undefined : (policy.apps?.[app.id ?? ""] ?? policy.apps?.[app.name]);
  return {
    confirm: [...new Set([...(policy.confirm ?? []), ...(own?.confirm ?? [])])],
    block: [...new Set([...(policy.block ?? []), ...(own?.block ?? [])])],
  };
}

/** The words the floor matches, by where they came from. `policy` is the file's `confirm` and `block` for this app. */
export interface FloorRules {
  policy: string[];
  skip: string[];
  submit: string[];
}

export interface FloorHit {
  why: SkipWhy;
  word?: string;
}

/**
 * What the floor's words are matched against: the element's own label and text; for an element with neither (an icon button),
 * its id split into words, so `delete-row` counts as `Delete` (§25.5). This is for the explorer only: the policy never matches an id.
 */
export function floorSubject(element: Pick<TreeElement, "label" | "text" | "testID">): { label?: string; text?: string } {
  const label = element.label ?? "";
  const text = element.text ?? "";
  if (label.trim() === "" && text.trim() === "") {
    const id = element.testID ?? "";
    return id.trim() === "" ? {} : { label: asWords(id) };
  }
  return { label, text };
}

/** Why an element is never touched, or null. The floor is checked first, then the policy words, then the user's skip list, then the app's own mark. */
export function floorVerdict(element: Pick<TreeElement, "label" | "text" | "testID" | "exploreSkip">, rules: FloorRules): FloorHit | null {
  const subject = floorSubject(element);
  const floor = matchWord([...FLOOR_WORDS], subject);
  if (floor !== null) return { why: "floor", word: floor };
  const policy = matchWord(rules.policy, subject);
  if (policy !== null) return { why: "policy", word: policy };
  const skip = matchWord(rules.skip, subject);
  if (skip !== null) return { why: "skip_list", word: skip };
  if (element.exploreSkip === true) return { why: "app_mark" };
  return null;
}

/**
 * The whole floor for the element that really receives a touch (§25.5), checked right before it: the verdict of `floorVerdict`
 * (floor words, policy, skip list, the app's mark, inherited ones included), then a card or password field, then the submit rule
 * on a screen that has a text input (§25.7).
 */
export function recipientVerdict(element: Pick<TreeElement, "label" | "text" | "testID" | "exploreSkip" | "role" | "placeholder">, rules: FloorRules, screenHasInput: boolean): FloorHit | null {
  const hit = floorVerdict(element, rules);
  if (hit !== null) return hit;
  if (element.role === "input" && isSecretField(element)) return { why: "floor", word: "password" };
  const word = submitWord(element);
  if (word !== null && !isListedSubmit(element, rules) && screenHasInput) return { why: "may_submit", word };
  return null;
}

/** The submit word an element carries (whole word, ignoring case), or null. */
export function submitWord(element: Pick<TreeElement, "label" | "text" | "testID">): string | null {
  return matchWord([...SUBMIT_WORDS], floorSubject(element));
}

/** A control the explorer may tap on a screen where it types: its id is in the policy file's `explore.submit` (§25.7). */
export function isListedSubmit(element: Pick<TreeElement, "testID">, rules: FloorRules): boolean {
  return typeof element.testID === "string" && element.testID !== "" && rules.submit.includes(element.testID);
}

/**
 * The words that title the screen as it is now: the text of its header elements (§25.5). A stored name can be generic, so the live
 * title protects a place too.
 */
export function screenTitles(elements: readonly Pick<TreeElement, "role" | "label" | "text">[]): string[] {
  return elements.filter((el) => el.role === "header").flatMap((el) => [el.text ?? "", el.label ?? ""]).filter((piece) => piece.trim() !== "");
}

/**
 * The word of a protected place (account, privacy, security) in a place's name, its route and the live screen's title, or null
 * (§19.2). `titles` also carries a name a person gave the place.
 */
export function protectedPlaceWord(name: string, route: readonly string[] | undefined, titles: readonly string[] = []): string | null {
  const pieces = [name, ...(route ?? []), ...titles].flatMap((piece) => asWords(piece).toLowerCase().split(/[^a-z0-9]+/));
  return pieces.find((piece) => PROTECTED_PLACE_WORDS.includes(piece)) ?? null;
}

/** Words in an input's id, label or placeholder that make it a field the explorer never types in (§25.6): a password or a card. */
const SECRET_FIELD_WORDS: readonly string[] = ["password", "passcode", "pin", "card", "cvv", "cvc", "expiry", "ssn", "secret", "token"];

export function isSecretField(element: Pick<TreeElement, "label" | "text" | "testID" | "placeholder">): boolean {
  const said = [element.testID ?? "", element.label ?? "", element.placeholder ?? ""].map(asWords).join(" ");
  return matchWord([...SECRET_FIELD_WORDS], { label: said }) !== null;
}
