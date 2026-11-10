import type { CallResult, ToolSession } from "./mcp.js";

/**
 * Keeps the runner's touches inside the lab's app. A tool that drives the phone with real touches
 * (Tapwright) can reach another app when the lab loses the foreground or an OS sheet covers it; the
 * runner must never send a touch there.
 */

/** The value of an answer's `App:` header line, or null when it has none. */
export function appOf(text: string): string | null {
  const m = /^App: (.+)$/m.exec(text);
  return m?.[1] ? m[1].trim() : null;
}

/** The run must stop: the phone is no longer on the lab's app. The other app is never named. */
export class LeftLabError extends Error {
  constructor(detail: string) {
    super(`Stopped: ${detail}. The run stopped so that no touch reaches another app.`);
    this.name = "LeftLabError";
  }
}

/** Rethrows a LeftLabError; anything else is the caller's to note. */
export function rethrowIfLeft(e: unknown): void {
  if (e instanceof LeftLabError) throw e;
}

/** Calls that touch the phone. `look`, `wait_for`, `open_url`, `viewer` don't. */
const TOUCHING = new Set([
  "tap",
  "long_press",
  "toggle",
  "type_text",
  "scroll",
  "swipe",
  "drag",
  "alert",
  "back",
]);

/** True when the call's target is a lab element by id: in another app it can only be not_found. */
function labIdTarget(args: Record<string, unknown>): boolean {
  const t = args.target;
  if (typeof t !== "object" || t === null || !("id" in t)) return false;
  const id: unknown = t.id;
  return typeof id === "string" && id.startsWith("lab-");
}

/** Throws when the answer names another app or says the app went to the background. */
export function checkAnswer(r: CallResult, labApp: string): void {
  const app = appOf(r.text);
  if (app !== null && app !== labApp) throw new LeftLabError("an answer's App: line names another app");
  if (/^\s*Error in_background\b/.test(r.text)) throw new LeftLabError("the lab's app went to the background");
}

/**
 * True when an `App:` value is iOS's own UI drawn over the app (a notification banner, say): the
 * Home screen's bundle id, as in Tapwright's `App: Home screen (com.apple.springboard)`. Naming it
 * is fine: it's iOS, not one of the user's apps.
 */
export function isSystemUi(app: string): boolean {
  return /\(com\.apple\.springboard\)$/.test(app.trim());
}

/** How long the guard waits for the lab's app to come back from iOS's own UI, and how often it looks. */
export const SYSTEM_UI_WAIT_MS = 10_000;
export const SYSTEM_UI_POLL_MS = 500;

export interface GuardOptions {
  waitMs?: number;
  pollMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface GuardedTool extends ToolSession {
  /** The lab app's `App:` value every answer must keep. */
  readonly labApp: string;
  /** Names the step and sample in progress (e.g. `S1.scroll[7]`) for the stop message; undefined clears it. */
  setStep(step: string | undefined): void;
  /** The step and sample set last, if any. */
  readonly step: string | undefined;
}

function isGuarded(tool: ToolSession): tool is GuardedTool {
  return "labApp" in tool && "setStep" in tool;
}

/** Tells a guarded tool which step and sample run now; does nothing for an unguarded one. */
export function setStep(tool: ToolSession, step: string | undefined): void {
  if (isGuarded(tool)) tool.setStep(step);
}

/** The step a guarded tool was told last; undefined for an unguarded one. */
export function stepOf(tool: ToolSession): string | undefined {
  return isGuarded(tool) ? tool.step : undefined;
}

/**
 * Wraps the tool so the run stops as soon as the phone leaves the lab's app:
 * - every answer with an `App:` line must name `labApp`; `Error in_background` stops too;
 * - an answer naming iOS's own UI (a banner over the lab) stops nothing at once: the guard sends no
 *   touch, looks every `pollMs` until the lab's app is back in front (then the run goes on) or
 *   `waitMs` have passed (then it stops). A look's answer is replaced by the fresh look; any answer
 *   that named iOS's UI comes back with `interrupted` set, so timings can leave it out;
 * - a touching call without a lab id target (text, point, `alert`, `back`) gets a `look` first, so a
 *   touch is never sent blind.
 * Timing is unchanged: the result is the touching call's own, with its own `ms`.
 */
export function guardApp(tool: ToolSession, labApp: string, opts: GuardOptions = {}): GuardedTool {
  const waitMs = opts.waitMs ?? SYSTEM_UI_WAIT_MS;
  const pollMs = opts.pollMs ?? SYSTEM_UI_POLL_MS;
  const sleep = opts.sleep ?? realSleep;
  // Once stopped, no touching call reaches the tool again (cleanup code included).
  let stopped: LeftLabError | null = null;
  let step: string | undefined;
  const stop = (detail: string): LeftLabError => {
    stopped = new LeftLabError(detail);
    return stopped;
  };
  const where = (name: string): string => (step ? `at ${step}, the answer to ${name}` : `the answer to ${name}`);
  const inBackground = (text: string): boolean => /^\s*Error in_background\b/.test(text);

  /**
   * Throws when the answer leaves the lab. Returns null when it's on the lab, or the fresh look on
   * the lab after iOS's own UI went away.
   */
  async function vet(r: CallResult, name: string): Promise<CallResult | null> {
    if (inBackground(r.text)) throw stop(`${where(name)} says the lab's app went to the background`);
    const app = appOf(r.text);
    if (app === null || app === labApp) return null;
    if (!isSystemUi(app)) throw stop(`${where(name)} names another app`);
    for (let waited = 0; waited < waitMs; waited += pollMs) {
      await sleep(pollMs);
      const look = await tool.call("look", { screenshot: false });
      if (inBackground(look.text)) throw stop(`${where(name)} named ${app}; then the lab's app went to the background`);
      const now = appOf(look.text);
      if (now === labApp) return look;
      if (now !== null && !isSystemUi(now)) throw stop(`${where(name)} named ${app}; then a look named another app`);
    }
    throw stop(`${where(name)} named ${app}, and it stayed in front for ${waitMs / 1000} s`);
  }

  return {
    labApp,
    setStep(next) {
      step = next;
    },
    get step() {
      return step;
    },
    async call(name, args): Promise<CallResult> {
      const touching = TOUCHING.has(name);
      if (touching && stopped) throw stopped;
      if (touching && !labIdTarget(args)) {
        const look = await tool.call("look", { screenshot: false });
        const back = await vet(look, `the look before a ${name}`);
        if (appOf((back ?? look).text) === null) {
          throw stop(`the look before a ${name} has no App: line, so the app can't be confirmed`);
        }
      }
      let r = await tool.call(name, args);
      const back = await vet(r, name);
      if (back !== null) {
        // A look is only a reading: the fresh one stands in for it. Any other answer stays its own.
        r = { ...(name === "look" ? back : r), interrupted: "iOS's own UI was in front" };
      }
      // An app that didn't answer the touch won't answer a look either: nothing to confirm, and the look
      // would only add its own wait to the call.
      const unanswered = /^\s*Error (?:not_answering|timeout|reconnecting)\b/.test(r.text);
      if (touching && r.isError && !unanswered) {
        // A refused touch (a lab id not found, say) may mean the phone is elsewhere: confirm the app.
        const look = await tool.call("look", { screenshot: false });
        await vet(look, `the look after a refused ${name}`);
      }
      return r;
    },
    ...(tool.listTools ? { listTools: () => tool.listTools?.() ?? Promise.resolve([]) } : {}),
  };
}

/** The lab app a guarded tool keeps to; undefined for an unguarded one (tests). */
export function labAppOf(tool: ToolSession): string | undefined {
  return "labApp" in tool && typeof tool.labApp === "string" ? tool.labApp : undefined;
}

/**
 * Before a person's tap through the viewer (`/ws`), which the tool turns into a real touch: the look
 * taken just before must name the lab's app. Without a known lab app (unguarded tool) it passes.
 */
export function checkBeforeViewerTap(labApp: string | undefined, lookText: string): void {
  if (labApp === undefined) return;
  const app = appOf(lookText);
  if (app === null) throw new LeftLabError("the look before a viewer tap has no App: line");
  if (app !== labApp) throw new LeftLabError("the look before a viewer tap names another app");
}

/** Reads the lab app's `App:` value with a look; throws when the look has none. */
export async function learnLabApp(tool: ToolSession): Promise<string> {
  const look = await tool.call("look", { screenshot: false });
  const app = appOf(look.text);
  if (app === null) {
    throw new Error("the look on the lab has no App: line; the runner needs it to keep touches inside the lab's app");
  }
  return app;
}
