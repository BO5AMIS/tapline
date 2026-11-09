import type { LogEntry, TreeElement, TreeResult } from "./protocol.js";

const MAX_TEXT = 80;

function clip(text: string, max = MAX_TEXT): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function quote(text: string): string {
  return JSON.stringify(clip(text));
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

export function roleOf(element: Pick<TreeElement, "role" | "type">): string | null {
  const role = element.role;
  if (role !== null && role !== undefined && role !== "") {
    const lower = role.toLowerCase();
    return ROLE_ALIASES.get(lower) ?? lower;
  }
  const type = element.type;
  return type !== null && type !== undefined && type !== "" ? type : null;
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
export function formatElement(element: TreeElement): string {
  const parts: string[] = [element.ref];
  const kind = roleOf(element);
  if (kind !== null) parts.push(kind);

  const text = element.text ?? "";
  const label = element.label ?? "";
  if (text !== "") parts.push(quote(text));
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
  const actions = actionsOf(element);
  if (actions.length > 0) parts.push(`[${actions.join(", ")}]`);
  return parts.join(" ");
}

/** Very short element description for action results, e.g. `e3 button "Log in"`. */
export function describeElement(element: TreeElement): string {
  const parts: string[] = [element.ref];
  const kind = roleOf(element);
  if (kind !== null) parts.push(kind);
  const text = element.text ?? "";
  const name = text !== "" ? text : (element.label ?? "");
  if (name !== "") parts.push(quote(name));
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
  const lines = [`Screen ${size} · ${count} element${count === 1 ? "" : "s"}`];
  if (app !== undefined) lines.push(`App: ${app.name}${app.id !== undefined ? ` (${app.id})` : ""}`);
  const route = formatRoute(tree.route);
  if (route !== null) lines.push(route);
  lines.push(...formatStatus(tree));
  if (count === 0) return [...lines, "(nothing visible; the app may still be loading)"].join("\n");
  lines.push(...tree.elements.slice(0, MAX_ELEMENTS).map(formatElement));
  if (count > MAX_ELEMENTS) lines.push(`(+${count - MAX_ELEMENTS} more below; scroll)`);
  return lines.join("\n");
}

/** Most moved elements listed one by one; more read as a scroll. */
const MAX_MOVED_LINES = 5;

/**
 * Only what changed since the previous list, or null when the screen changed too much (another
 * route, or most elements new or gone) and the full list reads better.
 */
export function formatChanges(tree: TreeResult): string | null {
  const changes = tree.changes;
  if (changes === undefined || !changes.sameRoute) return null;
  const count = tree.elements.length;
  const churn = changes.added.length + changes.removed.length + changes.changed.length;
  if (churn > Math.max(8, count / 2)) return null;

  const byRef = new Map(tree.elements.map((element) => [element.ref, element]));
  const lines = [
    `Screen - ${count} element${count === 1 ? "" : "s"}, same screen. Changes since the last list:`,
    ...formatStatus(tree),
  ];
  const statusLines = lines.length;
  for (const ref of changes.added) {
    const element = byRef.get(ref);
    if (element !== undefined) lines.push(`+ ${formatElement(element)}`);
  }
  for (const element of changes.removed) lines.push(`- ${formatElement(element).replace(/^\S+ /, "")}`);
  for (const { ref, was } of changes.changed) {
    const element = byRef.get(ref);
    if (element === undefined) continue;
    const before = Object.entries(was).map(([key, value]) => `${key}=${formatValue(value)}`);
    lines.push(`~ ${formatElement(element)} (was ${before.join(", ")})`);
  }
  if (changes.moved.length > MAX_MOVED_LINES) {
    lines.push(`↕ ${changes.moved.length} elements moved (a scroll or a layout change)`);
  } else {
    for (const ref of changes.moved) {
      const element = byRef.get(ref);
      if (element !== undefined) lines.push(`↕ ${formatElement(element)}`);
    }
  }
  if (lines.length === statusLines) lines.push("No visible change.");
  lines.push("(Unchanged elements keep their refs; call look for the full list.)");
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
    const how = alert.standIn
      ? "(Tapline's stand-in: press its buttons like any element)"
      : "(an OS alert: Tapline can't press it; ask the user to tap one)";
    lines.push(`${alert.kind === "prompt" ? "Prompt" : "Alert"}: ${quote(alert.title)}${message} ${buttons} ${how}`);
  }
  const busy = tree.network?.inFlight ?? 0;
  if (busy > 0) lines.push(`Network: ${busy} request${busy === 1 ? "" : "s"} in flight`);
  return lines;
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
