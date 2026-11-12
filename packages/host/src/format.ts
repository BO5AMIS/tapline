import type { LogEntry, TreeElement, TreeResult } from "./protocol.js";

/** How much of a text a line shows (AGENT-TOOLS v1.5). */
const MAX_TEXT = 200;

/**
 * Text as a line shows it: whitespace flattened, cut at `max` characters. A cut ends with how much is
 * missing, `…(+57)`; `more` is what the app had already left out.
 */
function clip(text: string, max = MAX_TEXT, more = 0): string {
  const flat = text.replace(/\s+/g, " ").trim();
  let shown = flat;
  if (flat.length > max) {
    // Never half a character: a cut that lands inside an emoji's pair stops one unit earlier.
    const last = flat.charCodeAt(max - 1);
    shown = flat.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
  }
  const missing = flat.length - shown.length + more;
  return missing > 0 ? `${shown}…(+${missing})` : shown;
}

function quote(text: string, more = 0): string {
  return JSON.stringify(clip(text, MAX_TEXT, more));
}

/** An element's text in quotes, counting what the app left out of it. */
function quoteText(element: Pick<TreeElement, "text" | "textMore">): string {
  return quote(element.text ?? "", element.textMore ?? 0);
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return quote(value);
  return clip(JSON.stringify(value) ?? String(value));
}

/** AGENT-TOOLS §3.3: one lowercase role vocabulary for both tools. */
const ROLE_ALIASES: ReadonlyMap<string, string> = new Map([
  ["textfield", "input"],
  ["search", "input"],
  ["textbox", "input"],
  ["scrollview", "scroll"],
  ["imagebutton", "button"],
  ["togglebutton", "button"],
  ["adjustable", "slider"],
  ["img", "image"],
  ["summary", "text"],
]);

/** Component types that read as a shared role when the app gives them none (AGENT-TOOLS §3.3). */
const TYPE_ROLES: ReadonlyMap<string, string> = new Map([
  ["Image", "image"],
  ["TextInput", "input"],
  ["Switch", "switch"],
  ["Slider", "slider"],
  ["RNCSlider", "slider"],
  ["Text", "text"],
  ["ScrollView", "scroll"],
  ["FlatList", "scroll"],
  ["SectionList", "scroll"],
  ["VirtualizedList", "scroll"],
]);

/** Pressables, touchables and buttons are `button` only when they take a tap. */
function isPressableType(type: string): boolean {
  return type === "Pressable" || type === "Button" || type.startsWith("Touchable");
}

/**
 * The shared role of an element: its role, else by component type, else `other` (a container with
 * no role). Null only when the app sent neither a role nor a type.
 */
export function roleOf(element: Pick<TreeElement, "role" | "type" | "actions">): string | null {
  const role = element.role;
  if (role !== null && role !== undefined && role !== "") {
    const lower = role.toLowerCase();
    return ROLE_ALIASES.get(lower) ?? lower;
  }
  const type = element.type;
  if (type === null || type === undefined || type === "") return null;
  const byType = TYPE_ROLES.get(type);
  if (byType !== undefined) return byType;
  const taps = (element.actions ?? []).some((action) => action === "press" || action === "tap");
  return isPressableType(type) && taps ? "button" : "other";
}

/** AGENT-TOOLS §3.3: tap, longPress, type, toggle, scroll (submit is part of type). */
export function actionsOf(element: Pick<TreeElement, "actions">): string[] {
  const shown: string[] = [];
  for (const action of element.actions ?? []) {
    const name = action === "press" ? "tap" : action;
    if (name === "submit" || shown.includes(name)) continue;
    shown.push(name);
  }
  return shown;
}

/** AGENT-TOOLS 1.8 §13 rule 4: the actions a role implies, left out of the line. */
const IMPLIED_ACTIONS: ReadonlyMap<string, readonly string[]> = new Map([
  ["button", ["tap"]],
  ["tab", ["tap"]],
  ["link", ["tap"]],
  ["input", ["tap", "type"]],
  ["switch", ["toggle"]],
  ["scroll", ["scroll"]],
]);

function impliedBy(role: string | null, actions: string[]): boolean {
  const implied = role !== null ? IMPLIED_ACTIONS.get(role) : undefined;
  return implied !== undefined && implied.length === actions.length && implied.every((a) => actions.includes(a));
}

/**
 * One compact line for an element, e.g. `e3 button "Log in" id=login-button @24,610 354x48` (a button's
 * `[tap]` goes without saying; other actions are listed, `[tap, longPress]`). `frame: false` leaves the
 * position and size out; `actions: false` the actions.
 */
export function formatElement(element: TreeElement, options: { actions?: boolean; frame?: boolean; eyes?: boolean } = {}): string {
  // An element that isn't on the list (one that changed off screen) has no ref.
  const parts: string[] = element.ref !== "" ? [element.ref] : [];
  const kind = roleOf(element);
  if (kind !== null) parts.push(kind);

  const text = element.text ?? "";
  const label = element.label ?? "";
  if (options.eyes === true) {
    parts.push(...userEyesName(kind, text, label, quoteText(element)));
  } else {
    if (text !== "") parts.push(quoteText(element));
    else if (label !== "") parts.push(quote(label));
    if (text !== "" && label !== "" && label.toLowerCase() !== text.toLowerCase()) {
      parts.push(`label=${quote(label)}`);
    }
    if (element.testID !== null && element.testID !== undefined && element.testID !== "") {
      parts.push(`id=${element.testID}`);
    }
  }
  if (element.value !== null && element.value !== undefined && element.value !== "") {
    parts.push(`value=${formatValue(element.value)}`);
  } else if (typeof element.placeholder === "string" && element.placeholder !== "") {
    // AGENT-TOOLS v1.7: an empty input shows its placeholder, never as a value
    parts.push(`placeholder=${formatValue(element.placeholder)}`);
  }
  if (element.disabled === true) parts.push("disabled");
  if (element.selected === true) parts.push("selected");
  if (element.checked !== null && element.checked !== undefined) parts.push(`checked=${String(element.checked)}`);
  if (options.frame !== false && element.frame !== null && element.frame !== undefined) {
    const f = element.frame;
    parts.push(`@${Math.round(f.x)},${Math.round(f.y)}`, `${Math.round(f.width)}x${Math.round(f.height)}`);
  }
  const actions = options.actions === false ? [] : actionsOf(element);
  if (actions.length > 0 && !impliedBy(kind, actions)) parts.push(`[${actions.join(", ")}]`);
  return parts.join(" ");
}

/**
 * What a person sees of an element's name (AGENT-TOOLS 1.12 §17.1): its visible text. A button, tab or link with none
 * is `(icon only)`, and its accessibility label stands apart as `(VoiceOver: "…")`. Ids never show; a label that is
 * not the visible text is not on the glass (an input's label is left out too: its placeholder shows).
 */
function userEyesName(kind: string | null, text: string, label: string, quotedText: string): string[] {
  if (text !== "") return [quotedText];
  const tappable = kind === "button" || kind === "tab" || kind === "link";
  const parts: string[] = tappable ? ["(icon only)"] : [];
  if (label !== "" && kind !== "input") parts.push(`(VoiceOver: ${quote(label)})`);
  return parts;
}

/** A `~` line's element (§13 rule 2): its position and actions only when they are among what changed. */
function changedLine(element: TreeElement, was: Record<string, unknown>, eyes = false): string {
  return formatElement(element, { frame: "frame" in was, actions: "actions" in was, eyes });
}

/** Rule 3: an old value over 40 characters, cut to what changed plus 12 characters each side. */
export function shortWas(old: string, now: string, keep = 40, context = 12): string {
  const o = [...old];
  const n = [...now];
  if (o.length <= keep) return old;
  let p = 0;
  while (p < o.length && p < n.length && o[p] === n[p]) p++;
  let s = 0;
  while (s < o.length - p && s < n.length - p && o[o.length - 1 - s] === n[n.length - 1 - s]) s++;
  const start = Math.max(0, p - context);
  const end = o.length - Math.max(0, s - context);
  if (start === 0 && end === o.length) return old;
  return `${start > 0 ? "…" : ""}${o.slice(start, end).join("")}${end < o.length ? "…" : ""}`;
}

/** Very short element description for action results, e.g. `e3 button "Log in"`. */
export function describeElement(element: TreeElement): string {
  const parts: string[] = element.ref !== "" ? [element.ref] : [];
  const kind = roleOf(element);
  if (kind !== null) parts.push(kind);
  const text = element.text ?? "";
  const label = element.label ?? "";
  if (text !== "") parts.push(quoteText(element));
  else if (label !== "") parts.push(quote(label));
  else if (element.testID !== null && element.testID !== undefined && element.testID !== "") {
    parts.push(`id=${element.testID}`);
  }
  return parts.join(" ");
}

/** A list shows at most this many elements; the rest read as a scroll. */
const MAX_ELEMENTS = 200;

/**
 * The whole screen as text (AGENT-TOOLS §3.2): the screen line, the app, route, alert and network
 * lines, then one line per element in tree order, up to 200.
 */
export function formatTree(tree: TreeResult, app?: { name: string; id?: string }, options: { eyes?: boolean } = {}): string {
  const eyes = options.eyes === true;
  const screen = tree.screen;
  const size = screen
    ? `${Math.round(screen.width)}x${Math.round(screen.height)} pt${screen.scale !== undefined ? ` @${screen.scale}x` : ""}`
    : "unknown size";
  const count = tree.elements.length;
  const lines = [`Screen ${size} · ${count} element${count === 1 ? "" : "s"}${eyes ? formatGlassMore(tree.glass) : formatOffScreen(tree.offScreen)}`];
  if (app !== undefined) lines.push(`App: ${app.name}${app.id !== undefined ? ` (${app.id})` : ""}`);
  const route = formatRoute(tree.route);
  if (route !== null) lines.push(route);
  lines.push(...formatStatus(tree));
  if (count === 0) return [...lines, "(nothing visible; the app may still be loading)"].join("\n");
  lines.push(...tree.elements.slice(0, MAX_ELEMENTS).map((element) => formatElement(element, { eyes })));
  if (count > MAX_ELEMENTS) lines.push(`(+${count - MAX_ELEMENTS} more below; scroll)`);
  return lines.join("\n");
}

/** In a user's eyes: ` (more below)` only where a view can really scroll further, no counts (AGENT-TOOLS 1.12 §17.1). */
function formatGlassMore(glass: TreeResult["glass"]): string {
  const parts: string[] = [];
  if (glass?.moreBelow === true) parts.push("more below");
  if (glass?.moreAbove === true) parts.push("more above");
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/** What lies off screen, for the screen line: ` (+41 below, +2 above)`, or nothing. Left and right aren't counted. */
function formatOffScreen(offScreen: TreeResult["offScreen"]): string {
  const parts: string[] = [];
  if (offScreen !== null && offScreen !== undefined) {
    if (offScreen.below > 0) parts.push(`+${offScreen.below} below`);
    if (offScreen.above > 0) parts.push(`+${offScreen.above} above`);
  }
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/** A gone element as `<role> "<name>"`. It omits the ref and position on purpose: neither means anything now. */
function describeGone(element: TreeElement, eyes = false): string {
  const kind = roleOf(element);
  const text = element.text ?? "";
  const label = element.label ?? "";
  const id = element.testID ?? "";
  if (eyes) {
    const seen = userEyesName(kind, text, label, quoteText(element)).join(" ");
    return [kind, seen].filter((part) => part !== null && part !== "").join(" ") || "element";
  }
  const rest = text !== "" ? quoteText(element) : label !== "" ? quote(label) : id !== "" ? `id=${id}` : "";
  const line = [kind, rest].filter((part) => part !== null && part !== "").join(" ");
  return line !== "" ? line : "element";
}

/** An old value as it would have been shown: positions as `@x,y WxH`, other values as in an element line, a long text cut to what changed. */
function formatWas(key: string, value: unknown, now?: TreeElement): string {
  if (key === "frame" && typeof value === "object" && value !== null) {
    const { x, y, width, height } = value as Record<string, unknown>;
    if ([x, y, width, height].every((n) => typeof n === "number")) {
      const r = (n: unknown): number => Math.round(n as number);
      return `@${r(x)},${r(y)} ${r(width)}x${r(height)}`;
    }
  }
  if (key === "actions" && Array.isArray(value)) {
    const names = actionsOf({ actions: value.filter((item): item is string => typeof item === "string") });
    return `[${names.join(", ")}]`;
  }
  const current = now !== undefined ? (now as Record<string, unknown>)[key] : undefined;
  if (typeof value === "string" && typeof current === "string") return quote(shortWas(value, current));
  return formatValue(value);
}

/** The old values of a `~` line: one changed field reads `"old"`; several read `text="old", value="old"`. */
function formatBefore(was: Record<string, unknown>, now?: TreeElement): string {
  // AGENT-TOOLS v1.7: a field that was empty reads as its placeholder then: `was placeholder "…"`.
  const placeholder = was["placeholder"];
  if (typeof placeholder === "string" && placeholder !== "" && (was["value"] === "" || was["value"] === null || was["value"] === undefined)) {
    const rest = Object.entries(was).filter(([key]) => key !== "value" && key !== "placeholder");
    const own = `placeholder ${formatValue(placeholder)}`;
    return rest.length === 0 ? own : [own, ...rest.map(([key, value]) => `${key}=${formatWas(key, value, now)}`)].join(", ");
  }
  const entries = Object.entries(was).filter(([key]) => key !== "placeholder");
  const [only] = entries;
  return entries.length === 1 && only !== undefined
    ? formatWas(only[0], only[1], now)
    : entries.map(([key, value]) => `${key}=${formatWas(key, value, now)}`).join(", ");
}

/**
 * What changed out of view (AGENT-TOOLS v1.6): `~ <line without a ref> (off screen; was "…")`, then
 * `~ N more changed off screen`. The tap worked; its effect just isn't on screen.
 */
function formatOffScreenChanges(changes: NonNullable<TreeResult["changes"]>): string[] {
  const lines = (changes.offScreen ?? []).map(
    ({ element, was }) => `~ ${changedLine({ ...element, ref: "" }, was)} (off screen; was ${formatBefore(was, element)})`,
  );
  const more = changes.offScreenMore ?? 0;
  if (more > 0) lines.push(`~ ${more} more changed off screen`);
  return lines;
}

/**
 * The off-screen lines that follow a full list, under `Changes off screen:`. Only for a full list that came because most of the
 * same screen changed: on another screen, or with nothing listed, the old off-screen elements are
 * no baseline to compare with.
 */
export function formatOffScreenAfterList(tree: TreeResult): string[] {
  const changes = tree.changes;
  if (changes === undefined || !changes.sameRoute || tree.elements.length === 0) return [];
  const lines = formatOffScreenChanges(changes);
  // Under a line of their own: after a list of elements, bare `~` lines read like a second, broken block.
  return lines.length > 0 ? ["Changes off screen:", ...lines] : [];
}

/** Most moved elements listed one by one; more read as a scroll. */
const MAX_MOVED_LINES = 5;

/**
 * Only what changed since the previous list, or null when the screen changed too much (another
 * route, or most elements new or gone) and the full list reads better.
 */
export function formatChanges(tree: TreeResult, options: { alertGone?: boolean; eyes?: boolean } = {}): string | null {
  const eyes = options.eyes === true;
  const changes = tree.changes;
  if (changes === undefined || !changes.sameRoute) return null;
  const count = tree.elements.length;
  // An empty tree is not "the same screen": the app vanished, so show the full list (and its note).
  if (count === 0) return null;
  const churn = changes.added.length + changes.removed.length + changes.changed.length;
  if (churn > Math.max(8, count / 2)) return null;

  const byRef = new Map(tree.elements.map((element) => [element.ref, element]));
  // Header lines come first (§3.1). An alert open in the previous answer and not now is "gone"; the
  // keyboard only when it came or went.
  const header = formatStatus(tree, changes.keyboard ?? null);
  const alertGone = options.alertGone === true && (tree.alerts ?? []).length === 0;
  if (alertGone) header.unshift("Alert: gone");
  const lines = ["Same screen. Changes:", ...header];
  const statusLines = lines.length;
  for (const ref of changes.added) {
    const element = byRef.get(ref);
    if (element !== undefined) lines.push(`+ ${formatElement(element, { eyes })}`);
  }
  for (const element of changes.removed) lines.push(`- ${describeGone(element, eyes)}`);
  for (const { ref, was } of changes.changed) {
    const element = byRef.get(ref);
    if (element === undefined) continue;
    // In a user's eyes a label that changed is not on the glass: only what shows is a change.
    const shown = eyes ? Object.fromEntries(Object.entries(was).filter(([key]) => key !== "label")) : was;
    if (eyes && Object.keys(shown).length === 0) continue;
    lines.push(`~ ${changedLine(element, shown, eyes)} (was ${formatBefore(shown, element)})`);
  }
  // What changed out of view is not on the glass, so a user's eyes leave it out.
  if (!eyes) lines.push(...formatOffScreenChanges(changes));
  if (changes.moved.length > MAX_MOVED_LINES) {
    lines.push(`↕ ${changes.moved.length} elements moved`);
  } else {
    for (const ref of changes.moved) {
      const element = byRef.get(ref);
      if (element !== undefined) lines.push(`↕ ${formatElement(element, { eyes })}`);
    }
  }
  // A closed alert is itself a change, and so is the keyboard coming or going.
  if (lines.length === statusLines && !alertGone && changes.keyboard == null) lines.push("No visible change.");
  return lines.join("\n");
}

/**
 * Lines for open alerts, the keyboard and requests in flight: things that block or explain the
 * screen, in §3.2's order. `keyboard` is the keyboard line's word: by default `shown` while it is up
 * (a list's header); a change block passes what changed.
 */
export function formatStatus(tree: TreeResult, keyboard: "shown" | "hidden" | null = tree.keyboard === true ? "shown" : null): string[] {
  const lines: string[] = [];
  for (const alert of tree.alerts ?? []) {
    const buttons = alert.buttons
      .map((button) => `[${clip(button.text, 40)}${button.style === "destructive" ? " (destructive)" : ""}]`)
      .join(" ");
    const message = alert.message !== null && alert.message !== "" ? ` ${clip(alert.message, 160)}` : "";
    lines.push(`${alert.kind === "prompt" ? "Prompt" : "Alert"}: ${quote(alert.title)}${message} ${buttons}`);
  }
  if (keyboard !== null) lines.push(`Keyboard: ${keyboard}`);
  // A condition Tapline put on the requests stays in every header until `normal` (AGENT-TOOLS §16.4).
  const condition = tree.network?.condition;
  if (condition !== undefined) lines.push(networkLine(condition));
  const busy = tree.network?.inFlight ?? 0;
  if (busy > 0) lines.push(`Network: ${busy} request${busy === 1 ? "" : "s"} in flight`);
  return lines;
}

/** `Network: 3g (Tapline).` — the same line the `network` command answers with and every header carries. */
export function networkLine(mode: string): string {
  return `Network: ${mode} (Tapline).`;
}

/** What an open alert means for the agent, as `Note:` lines for the end of the answer (§3.6). */
export function alertNotes(tree: TreeResult): string[] {
  return (tree.alerts ?? []).map((alert) =>
    alert.standIn
      ? "Note: Tapline's stand-in alert: tap its buttons like any element."
      : "Note: an OS alert: Tapline can't tap it; ask the user to tap one, or use Tapwright.",
  );
}

/** `Route: (tabs) › nutrition (day="2026-11-09")`, or null without a route. */
export function formatRoute(route: TreeResult["route"]): string | null {
  if (route === undefined || route.names.length === 0) return null;
  const params = Object.entries(route.params ?? {}).map(([key, value]) => `${key}=${formatValue(value)}`);
  return `Route: ${route.names.join(" › ")}${params.length > 0 ? ` (${clip(params.join(", "), 160)})` : ""}`;
}

export type LogLevelName = "error" | "warning" | "info";
const LEVEL_RANK: Record<LogLevelName, number> = { info: 0, warning: 1, error: 2 };
export const LOG_TEXT_MAX = 300;

/** AGENT-TOOLS §15.1: error (console.error, JS errors, requests 500 and up), warning, or info. */
export function logLevelOf(entry: LogEntry): LogLevelName {
  if (entry.fatal === true) return "error";
  const level = (entry.level ?? "log").toLowerCase();
  if (level === "error" || level === "fatal") return "error";
  if (level === "warn" || level === "warning") return "warning";
  return "info";
}

export function atLeast(entry: LogEntry, level: LogLevelName): boolean {
  return LEVEL_RANK[logLevelOf(entry)] >= LEVEL_RANK[level];
}

/** Local wall-clock time, `HH:MM:SS.mmm`. */
export function clockTime(ts: number, millis = true): string {
  const d = new Date(ts);
  const two = (n: number): string => String(n).padStart(2, "0");
  const base = `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  return millis ? `${base}.${String(d.getMilliseconds()).padStart(3, "0")}` : base;
}

/** An entry's whole text on one line: the message, then its stack when it adds anything. */
export function logText(entry: LogEntry): string {
  const stack = entry.stack !== undefined && entry.stack !== "" && entry.stack !== entry.message ? `\n${entry.stack}` : "";
  return `${entry.message}${stack}`.replace(/\s*\n\s*/g, " | ").trim();
}

/** Log entries as `HH:MM:SS.mmm <level> <text>` lines, text cut at 300 characters with what is missing. */
export function formatLogs(entries: LogEntry[]): string {
  if (entries.length === 0) return "(no log lines)";
  return entries
    .map((entry) => {
      const when = entry.ts !== undefined ? clockTime(entry.ts) : "--:--:--.---";
      const full = logText(entry);
      const shown = full.length > LOG_TEXT_MAX ? `${full.slice(0, LOG_TEXT_MAX)}…(+${full.length - LOG_TEXT_MAX})` : full;
      return `${when} ${logLevelOf(entry)} ${shown}`;
    })
    .join("\n");
}

export interface LogQuery {
  since?: number;
  level?: LogLevelName;
  grep?: string;
  limit?: number;
}

/** Applies `since`, `level`, `grep` and `limit` (the newest), oldest first. */
export function filterLogs(entries: LogEntry[], query: LogQuery): LogEntry[] {
  const needle = query.grep?.toLowerCase();
  const kept = entries.filter(
    (entry) =>
      (query.since === undefined || (entry.ts ?? 0) > query.since) &&
      atLeast(entry, query.level ?? "info") &&
      (needle === undefined || needle === "" || logText(entry).toLowerCase().includes(needle)),
  );
  const limit = query.limit ?? 100;
  return kept.length > limit ? kept.slice(kept.length - limit) : kept;
}

/** The `logs` answer (AGENT-TOOLS §15.1): the lines, or what was asked when there are none, then `Latest:`. */
export function formatLogAnswer(entries: LogEntry[], query: LogQuery, latest: number): string {
  if (entries.length > 0) return `${formatLogs(entries)}\nLatest: ${latest}`;
  const asked: string[] = [];
  if (query.level !== undefined && query.level !== "info") asked.push(`at ${query.level} or above`);
  if (query.grep !== undefined && query.grep !== "") asked.push(`matching "${query.grep}"`);
  if (query.since !== undefined) asked.push(`since ${clockTime(query.since)}`);
  return `No log entries${asked.length > 0 ? ` ${asked.join(", ")}` : ""}.\nLatest: ${latest}`;
}
