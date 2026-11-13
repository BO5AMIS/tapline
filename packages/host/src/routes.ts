import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AccountStore } from "./accounts.js";
import { loadMap, readRouteSync, saveMap, saveRouteFile } from "./mapfile.js";
import type { AppMap } from "./places.js";
import type { Step } from "./run.js";
import { sharedScriptV2Schema, type SharedScriptV2 } from "./script.js";

// Routes (AGENT-TOOLS 1.13 §18.5, §9.4): a script in version 2 that starts at a place, with variables. A route lives in
// the map folder's `routes/` and is listed in the map's `routes`. Nothing here stores a value taken from a screen: a
// variable is a name, its value comes with the call, and an account's value stays a placeholder (§18.6).

const ROUTE_NAME_MAX = 60;

/** A route's name reduced to the characters a file name may keep (letters, digits, '.', '_', '-'); null when nothing is left. */
export function routeSlug(raw: string): string | null {
  const reduced = raw
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, ROUTE_NAME_MAX)
    .replace(/_+$/, "");
  return reduced === "" ? null : reduced;
}

// -- variables

/** `${name}` or `${account.field}`; `$${` is a literal `${`. ASCII names only. */
const TOKEN = /\$\$\{|\$\{([A-Za-z_]\w*(?:\.\w+)?)\}/g;
const WHOLE_ACCOUNT = /^\$\{account\.\w+\}$/;
const ACCOUNT_BRIEF = "an account value is the whole text of a step, not part of one.";

/** Typed text written so a replay reads it back as it was: a literal `${` becomes `$${`. */
export function escapeLiteral(text: string): string {
  // A function, since `$$` in a replacement string means one `$`.
  return text.replaceAll("${", () => "$${");
}

/** The text a step keeps for a variable. */
export function variablePlaceholder(name: string): string {
  return `\${${name}}`;
}

export type Substituted = { ok: true; step: Step } | { ok: false; code: "bad_params"; message: string };

class Refusal extends Error {}

function fillText(text: string, values: Record<string, string>): string {
  return text.replace(TOKEN, (match: string, name: string | undefined) => {
    if (name === undefined) return "${";
    // An account's value is typed by the tool when the step runs; it stays a placeholder here.
    if (name.startsWith("account.")) return match;
    if (!Object.hasOwn(values, name)) throw new Refusal(`no value given for the variable "${name}".`);
    const value = values[name] as string;
    if (value.includes("${account.")) throw new Refusal(`the value of "${name}" can't hold an account placeholder; name the account instead.`);
    return value;
  });
}

function fillValue(value: unknown, values: Record<string, string>): unknown {
  if (typeof value === "string") return fillText(value, values);
  if (Array.isArray(value)) return value.map((item) => fillValue(item, values));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillValue(item, values)]));
  }
  return value;
}

/** An account placeholder in a typed step's text must be the whole text, and a field an account has. */
function checkAccountText(text: string, accounts: AccountStore | undefined): void {
  const found = [...text.matchAll(TOKEN)].filter((m) => m[1]?.startsWith("account.") === true);
  if (found.length === 0) return;
  if (!WHOLE_ACCOUNT.test(text)) throw new Refusal(ACCOUNT_BRIEF);
  const field = (found[0]?.[1] ?? "").slice("account.".length);
  if (accounts !== undefined && field !== "username" && field !== "password") {
    throw new Refusal(`\${account.${field}} isn't a value an account has; use \${account.username} or \${account.password}.`);
  }
}

/**
 * The step with its variables filled and its `$${` made `${`. A variable with no value is refused, naming it. An account
 * placeholder stays as it is (the tool types the value later), and only as the whole text of a `type_text`.
 */
export function substituteVariables(step: Step, values: Record<string, string>, accounts?: AccountStore): Substituted {
  try {
    const text = (step as Record<string, unknown>)["text"];
    if (step.tool === "type_text" && typeof text === "string") checkAccountText(text, accounts);
    const filled = Object.fromEntries(Object.entries(step).map(([key, value]) => [key, key === "tool" ? value : fillValue(value, values)]));
    return { ok: true, step: filled as Step };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, code: "bad_params", message: error.message };
    throw error;
  }
}

/** Every step filled, or the first refusal with its step number. */
export function substituteSteps(steps: Step[], values: Record<string, string>, accounts?: AccountStore): { ok: true; steps: Step[] } | { ok: false; code: "bad_params"; message: string } {
  const done: Step[] = [];
  for (const [i, step] of steps.entries()) {
    const filled = substituteVariables(step, values, accounts);
    if (!filled.ok) return { ok: false, code: "bad_params", message: `step ${i + 1}: ${filled.message}` };
    done.push(filled.step);
  }
  return { ok: true, steps: done };
}

// -- recording

/** A variable's name for `type_text`'s `as`: a plain name, and not `account` (that names a test account). A message, or null. */
export function variableProblem(name: string): string | null {
  if (!/^[A-Za-z_]\w*$/.test(name)) return `as names a variable with letters, digits and '_'; "${name}" isn't one.`;
  if (name === "account") return 'as can\'t be "account": that name is for a test account (type ${account.username} with account).';
  return null;
}

/** What a typed step keeps in a route: `as` makes its text a variable, and an account's text stays its placeholder. */
export function routeTyped(params: Record<string, unknown>): { params: Record<string, unknown>; placeholder: boolean; variable?: string; account: boolean } {
  const { as, ...rest } = params;
  if (typeof as === "string") return { params: { ...rest, text: variablePlaceholder(as) }, placeholder: true, variable: as, account: false };
  const account = typeof rest["text"] === "string" && rest["text"].includes("${account.");
  return { params: rest, placeholder: account, account };
}

function escapeValue(value: unknown): unknown {
  if (typeof value === "string") return escapeLiteral(value);
  if (Array.isArray(value)) return value.map(escapeValue);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, escapeValue(item)]));
  return value;
}

/** A recorded step's params with every literal `${` escaped, except the text that is a variable or an account's placeholder. */
export function escapeParams(params: Record<string, unknown>, keepText: boolean): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [key, keepText && key === "text" ? value : escapeValue(value)]));
}

export function routeScript(input: { name: string; app: string; start?: string | undefined; end?: string | undefined; steps: Step[]; variables: Iterable<string> }): SharedScriptV2 {
  const variables = [...new Set(input.variables)];
  return {
    format: "agent-tools-script",
    version: 2,
    app: input.app,
    name: input.name,
    ...(input.start !== undefined ? { start: input.start } : {}),
    ...(input.end !== undefined ? { end: input.end } : {}),
    ...(variables.length > 0 ? { variables } : {}),
    steps: input.steps,
  };
}

// -- storage

const relativeOf = (slug: string): string => `routes/${slug}.json`;

/**
 * Writes `<map folder>/routes/<name>.json` and lists it in the map's `routes`. The name is reduced (`routeSlug`); a route
 * with that name is replaced. With the app's open `map` the change goes through it, else straight into the file.
 * Answers the path written. Throws with the reason when the file or the map can't be written.
 */
export async function saveRoute(dir: string, script: SharedScriptV2, map?: AppMap): Promise<string> {
  const name = routeSlug(script.name);
  if (name === null) throw new Error(`"${script.name}" can't name a route; use letters, digits, '.', '_' and '-'.`);
  const relative = relativeOf(name);
  await saveRouteFile(dir, relative, `${JSON.stringify({ ...script, name }, null, 2)}\n`);
  if (map !== undefined) {
    map.addRoute(name, relative);
    await map.flush();
    const failed = map.lastError();
    if (failed !== null) throw new Error(`the map file wasn't written (${failed})`);
  } else {
    const loaded = loadMap(dir, script.app ?? "");
    if (loaded.status === "unreadable") throw new Error("the map file is unreadable and was left alone");
    loaded.map.routes[name] = relative;
    await saveMap(dir, loaded.map);
  }
  return join(dir, relative);
}

/** The map's `routes` (name to file) as the file holds them, whichever app wrote it; empty when it can't be read. */
function registeredRoutes(dir: string): Record<string, string> {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dir, "map.json"), "utf8"));
    const routes = typeof raw === "object" && raw !== null ? (raw as { routes?: unknown }).routes : undefined;
    if (typeof routes !== "object" || routes === null) return {};
    return Object.fromEntries(Object.entries(routes).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

/** Where a route of that name is kept in the app's map folder (its full path), or null when the map has none. */
export function routePathOf(map: AppMap, name: string): string | null {
  const routes = map.data().routes;
  const key = Object.hasOwn(routes, name) ? name : routeSlug(name);
  const relative = key === null || !Object.hasOwn(routes, key) ? undefined : routes[key];
  return relative === undefined ? null : join(map.folder(), relative);
}

/** The route of that name from the map folder, or null (unknown, or a file that isn't a version 2 script). */
export function loadRoute(dir: string, name: string): SharedScriptV2 | null {
  const routes = registeredRoutes(dir);
  const key = Object.hasOwn(routes, name) ? name : routeSlug(name);
  const relative = key === null || !Object.hasOwn(routes, key) ? undefined : routes[key];
  if (relative === undefined) return null;
  const file = readRouteSync(dir, relative);
  const parsed = file === null ? null : sharedScriptV2Schema.safeParse(file);
  return parsed?.success === true ? parsed.data : null;
}

// -- a route as a way (§18.5: one road from start to end, one move per step)

export interface RouteEdge {
  route: string;
  from: string;
  to: string;
  moves: number;
  last: string;
}

/**
 * The saved routes `drive {"to"}` may plan through: those with a start and an end that differ, and no variable but the
 * test account (a plan has no value to give a variable).
 */
export function routeEdges(map: AppMap): RouteEdge[] {
  const edges: RouteEdge[] = [];
  for (const [route, relative] of Object.entries(map.data().routes)) {
    const file = readRouteSync(map.folder(), relative);
    const parsed = file === null ? null : sharedScriptV2Schema.safeParse(file);
    if (parsed?.success !== true) continue;
    const { start, end, variables = [], steps } = parsed.data;
    if (start === undefined || end === undefined || start === end || steps.length === 0) continue;
    if (variables.some((variable) => variable !== "account")) continue;
    let last = new Date(0).toISOString();
    try {
      last = statSync(join(map.folder(), relative)).mtime.toISOString();
    } catch {
      // The file is read already; a clock is only a tie-break.
    }
    edges.push({ route, from: start, to: end, moves: steps.length, last });
  }
  return edges;
}

// -- running

export interface RouteContext<R> {
  /** The name of the place the app is at; null when it can't be read. */
  here(): Promise<string | null>;
  /** Task 15 (`drive`) supplies this: take the app to a place by link or roads. Until then a route runs only from its start. */
  driveTo?(place: string): Promise<{ ok: true } | { ok: false; message: string }>;
  /** Runs steps the way `run` does and answers its answer. */
  runSteps(steps: Step[]): Promise<R>;
}

export type RouteOutcome<R> = { kind: "ran"; answer: R } | { kind: "refused"; code: "bad_params" | "unsupported" | "off_route"; message: string };

export interface RouteRunner {
  run<R>(route: SharedScriptV2, values: Record<string, string>, ctx: RouteContext<R>, accounts?: AccountStore): Promise<RouteOutcome<R>>;
}

/**
 * Runs a route (§18.5): fills its variables, takes the app to `start` when it is elsewhere, then runs the steps. Nothing is
 * touched when a variable has no value or the app can't be taken to the start.
 */
export async function runRoute<R>(route: SharedScriptV2, values: Record<string, string>, ctx: RouteContext<R>, accounts?: AccountStore): Promise<RouteOutcome<R>> {
  const filled = substituteSteps(route.steps, values, accounts);
  if (!filled.ok) return { kind: "refused", code: filled.code, message: filled.message };
  if (route.start !== undefined) {
    const here = await ctx.here();
    if (here !== route.start) {
      if (ctx.driveTo === undefined) {
        const where = here === null ? "the app's place isn't known" : `the app is at ${here}`;
        return { kind: "refused", code: "unsupported", message: `the route "${route.name}" starts at ${route.start}, and ${where}. Go to ${route.start} first, then run it again.` };
      }
      const driven = await ctx.driveTo(route.start);
      if (!driven.ok) return { kind: "refused", code: "off_route", message: driven.message };
    }
  }
  return { kind: "ran", answer: await ctx.runSteps(filled.steps) };
}

export const routeRunner: RouteRunner = { run: runRoute };
