import type { LogEntry, TreeElement, TreeResult } from "./protocol.js";

/** How much of a text a line shows (AGENT-TOOLS v1.5). */
const MAX_TEXT = 200;

/**
 * Text as a line shows it: whitespace flattened, cut at `max` characters. A cut ends with how much is
 * missing, `…(+57)`; `more` is what the app had already left out.
 */
function clip(text: string, max = MAX_TEXT, more = 0): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const shown = flat.length > max ? flat.slice(0, max) : flat;
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

/** One compact line for an element, e.g. `e3 button "Log in" id=login-button @24,610 354x48 [tap, longPress]`. */
export function formatElement(element: TreeElement, options: { actions?: boolean } = {}): string {
  // An element that isn't on the list (one that changed off screen) has no ref.
  const parts: string[] = element.ref !== "" ? [element.ref] : [];
  const kind = roleOf(element);
  if (kind !== null) parts.push(kind);

  const text = element.text ?? "";
  const label = element.label ?? "";
  if (text !== "") parts.push(quoteText(element));
  else if (label !== "") parts.push(quote(label));
  if (text !== "" && label !== "" && label.toLowerCase() !== text.toLowerCase()) {
    parts.push(`label=${quote(label)}`);
  }
  if (element.testID !== null && element.testID !== undefined && element.testID !== "") {
    parts.push(`id=${element.testID}`);
  }
  if (element.value !== null && element.value !== undefined && element.value !== "") {
    parts.push(`value=${formatValue(element.value)}`);
  }
  if (element.disabled === true) parts.push("disabled");
  if (element.selected === true) parts.push("selected");
  if (element.checked !== null && element.checked !== undefined) parts.push(`checked=${String(element.checked)}`);
  if (element.frame !== null && element.frame !== undefined) {
    const f = element.frame;
    parts.push(`@${Math.round(f.x)},${Math.round(f.y)}`, `${Math.round(f.width)}x${Math.round(f.height)}`);
  }
  const actions = options.actions === false ? [] : actionsOf(element);
  if (actions.length > 0) parts.push(`[${actions.join(", ")}]`);
  return parts.join(" ");
}

/** Very short element description for action results, e.g. `e3 button "Log in"`. */
export function describeElement(element: TreeElement): string {
  const parts: string[] = [element.ref];
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
export function formatTree(tree: TreeResult, app?: { name: string; id?: string }): string {
  const screen = tree.screen;
  const size = screen
    ? `${Math.round(screen.width)}x${Math.round(screen.height)} pt${screen.scale !== undefined ? ` @${screen.scale}x` : ""}`
    : "unknown size";
  const count = tree.elements.length;
  const lines = [`Screen ${size} · ${count} element${count === 1 ? "" : "s"}${formatOffScreen(tree.offScreen)}`];
  if (app !== undefined) lines.push(`App: ${app.name}${app.id !== undefined ? ` (${app.id})` : ""}`);
  const route = formatRoute(tree.route);
  if (route !== null) lines.push(route);
  lines.push(...formatStatus(tree));
  if (count === 0) return [...lines, "(nothing visible; the app may still be loading)"].join("\n");
  lines.push(...tree.elements.slice(0, MAX_ELEMENTS).map((element) => formatElement(element)));
  if (count > MAX_ELEMENTS) lines.push(`(+${count - MAX_ELEMENTS} more below; scroll)`);
  return lines.join("\n");
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
function describeGone(element: TreeElement): string {
  const kind = roleOf(element);
  const text = element.text ?? "";
  const label = element.label ?? "";
  const id = element.testID ?? "";
  const rest = text !== "" ? quoteText(element) : label !== "" ? quote(label) : id !== "" ? `id=${id}` : "";
  const line = [kind, rest].filter((part) => part !== null && part !== "").join(" ");
  return line !== "" ? line : "element";
}

/** An old value as it would have been shown: positions as `@x,y WxH`, other values as in an element line. */
function formatWas(key: string, value: unknown): string {
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
  return formatValue(value);
}

/** Most moved elements listed one by one; more read as a scroll. */
const MAX_MOVED_LINES = 5;

/**
 * Only what changed since the previous list, or null when the screen changed too much (another
 * route, or most elements new or gone) and the full list reads better.
 */
export function formatChanges(tree: TreeResult, options: { alertGone?: boolean } = {}): string | null {
  const changes = tree.changes;
  if (changes === undefined || !changes.sameRoute) return null;
  const count = tree.elements.length;
  // An empty tree is not "the same screen": the app vanished, so show the full list (and its note).
  if (count === 0) return null;
  const churn = changes.added.length + changes.removed.length + changes.changed.length;
  if (churn > Math.max(8, count / 2)) return null;

  const byRef = new Map(tree.elements.map((element) => [element.ref, element]));
  // Header lines come first (§3.1). An alert open in the previous answer and not now is "gone".
  const header = formatStatus(tree);
  const alertGone = options.alertGone === true && (tree.alerts ?? []).length === 0;
  if (alertGone) header.unshift("Alert: gone");
  const lines = ["Same screen. Changes:", ...header];
  const statusLines = lines.length;
  for (const ref of changes.added) {
    const element = byRef.get(ref);
    if (element !== undefined) lines.push(`+ ${formatElement(element)}`);
  }
  for (const element of changes.removed) lines.push(`- ${describeGone(element)}`);
  // One changed field reads `"old"`; several read `text="old", value="old"`.
  const before = (was: Record<string, unknown>): string => {
    const entries = Object.entries(was);
    const [only] = entries;
    return entries.length === 1 && only !== undefined
      ? formatWas(only[0], only[1])
      : entries.map(([key, value]) => `${key}=${formatWas(key, value)}`).join(", ");
  };
  for (const { ref, was } of changes.changed) {
    const element = byRef.get(ref);
    if (element === undefined) continue;
    lines.push(`~ ${formatElement(element)} (was ${before(was)})`);
  }
  // What changed out of view (v1.6): the tap worked, its effect just isn't on screen.
  for (const { element, was } of changes.offScreen ?? []) {
    lines.push(`~ ${formatElement({ ...element, ref: "" })} (off screen; was ${before(was)})`);
  }
  const more = changes.offScreenMore ?? 0;
  if (more > 0) lines.push(`~ ${more} more changed off screen`);
  if (changes.moved.length > MAX_MOVED_LINES) {
    lines.push(`↕ ${changes.moved.length} elements moved`);
  } else {
    for (const ref of changes.moved) {
      const element = byRef.get(ref);
      if (element !== undefined) lines.push(`↕ ${formatElement(element)}`);
    }
  }
  // A closed alert is itself a change.
  if (lines.length === statusLines && !alertGone) lines.push("No visible change.");
  return lines.join("\n");
}

/** Lines for open alerts and requests in flight: things that block or explain the screen. */
export function formatStatus(tree: TreeResult): string[] {
  const lines: string[] = [];
  for (const alert of tree.alerts ?? []) {
    const buttons = alert.buttons
      .map((button) => `[${clip(button.text, 40)}${button.style === "destructive" ? " (destructive)" : ""}]`)
      .join(" ");
    const message = alert.message !== null && alert.message !== "" ? ` ${clip(alert.message, 160)}` : "";
    lines.push(`${alert.kind === "prompt" ? "Prompt" : "Alert"}: ${quote(alert.title)}${message} ${buttons}`);
  }
  const busy = tree.network?.inFlight ?? 0;
  if (busy > 0) lines.push(`Network: ${busy} request${busy === 1 ? "" : "s"} in flight`);
  return lines;
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

/** Log entries as `HH:MM:SS.mmm level message` lines. */
export function formatLogs(entries: LogEntry[]): string {
  if (entries.length === 0) return "(no log lines)";
  return entries
    .map((entry) => {
      const when = entry.ts !== undefined ? new Date(entry.ts).toISOString().slice(11, 23) : "--:--:--.---";
      const fatal = entry.fatal === true ? " FATAL" : "";
      const stack = entry.stack !== undefined && entry.stack !== "" ? `\n${entry.stack}` : "";
      return `${when} ${entry.level ?? "log"}${fatal} ${entry.message}${stack}`;
    })
    .join("\n");
}
