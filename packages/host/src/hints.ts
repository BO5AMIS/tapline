/**
 * AGENT-TOOLS 1.17 §30.3: the `Hint:` line. At most one per answer, after the notes; the same hint once per session;
 * never on a refusal for safety. The decisions are pure; `HintBook` keeps what a session has seen.
 */

export type HintId = "error" | "way" | "form" | "picture" | "long";

/** When two apply in one answer, the first of these shows; the other may show on a later answer. */
const ORDER: readonly HintId[] = ["error", "way", "form", "picture", "long"];

/** The call from which a task counts as long. */
export const LONG_TASK_CALLS = 20;

/** Tools that act on the app one step at a time, and can answer with the changes. */
const ACTIONS: ReadonlySet<string> = new Set(["tap", "long_press", "type_text", "toggle", "scroll", "swipe", "back", "open_url", "app_command"]);
/** The touches that can take the app to another place (the logged `way` of the session report). */
const TOUCHES: ReadonlySet<string> = new Set(["tap", "long_press", "toggle", "back", "open_url", "swipe"]);
/** Tools whose answer shows a new screen as a full list. */
const FORM_TOOLS: ReadonlySet<string> = new Set([...ACTIONS, "drive", "run"]);

/** What one answer shows, for choosing a hint. */
export interface HintFacts {
  /** The app logged an error (or crashed) and `logs` hasn't been read since. */
  error: boolean;
  /** The place a known way of 3 or more taps ended at. */
  way: string | null;
  /** A form opened. */
  form: boolean;
  /** A picture was asked that the text answer made unneeded. */
  picture: boolean;
  /** This session's calls so far, this one included. */
  calls: number;
}

export function hintLine(id: HintId, facts: HintFacts): string {
  switch (id) {
    case "error":
      return "Hint: the app logged an error: `logs` shows it.";
    case "way":
      return `Hint: this way is known: \`drive {"to": ${JSON.stringify(facts.way ?? "")}}\` reaches ${facts.way ?? ""} in one call.`;
    case "form":
      return "Hint: fill the fields and save in one `run`, with an `expect` on the save step.";
    case "picture":
      return "Hint: the text answer had the changes; ask for a screenshot only to judge how something looks.";
    case "long":
      return "Hint: on a long task, the main session can hand the driving to one small, fast agent; if you are that agent, carry on.";
  }
}

function applies(id: HintId, facts: HintFacts): boolean {
  switch (id) {
    case "error":
      return facts.error;
    case "way":
      return facts.way !== null;
    case "form":
      return facts.form;
    case "picture":
      return facts.picture;
    case "long":
      return facts.calls >= LONG_TASK_CALLS;
  }
}

/** The first hint that applies and hasn't been shown, in the order error, way, form, picture, long. */
export function pickHint(facts: HintFacts, shown: ReadonlySet<HintId>): HintId | null {
  return ORDER.find((id) => !shown.has(id) && applies(id, facts)) ?? null;
}

/** A refusal for safety (a person's OK needed, a blocked word, a pause, a declined OK): no hint goes on it. */
export function isSafetyRefusal(text: string, isError: boolean): boolean {
  if (!isError) return false;
  return /^Error (not_allowed|paused)\b/.test(text) || /needs_confirmation|They declined|They can't now/.test(text);
}

/** The answer carries the changes or a full list. */
export function hadChanges(text: string): boolean {
  return /^(Same screen\. Changes:|Screen \d)/m.test(text);
}

/** A new screen (a full list) with 2 or more inputs and a button. */
export function formOpened(text: string): boolean {
  if (!/^Screen \d/m.test(text)) return false;
  const inputs = text.match(/^e\d+ input\b/gm)?.length ?? 0;
  return inputs >= 2 && /^e\d+ button\b/m.test(text);
}

/** The app's own crash note in an answer. */
const CRASH_NOTE = /^Note: the app crashed/m;

/** Where a touch led and whether the map already held a proven road there. */
export interface Way {
  from: string;
  to: string;
  known: boolean;
}

/** What one outermost call tells the book. */
export interface CallFacts {
  tool: string;
  args: Record<string, unknown>;
  text: string;
  isError: boolean;
  /** The `seq` of every error-level line the app's log holds. */
  errorSeqs: readonly number[];
  /** For `logs`: the `seq` of the error-level lines its answer delivered (what the agent actually read). */
  delivered: readonly number[];
  /** Where this call's touch led (from the road recording), if it did. */
  way: Way | undefined;
  /** The agent's outermost calls so far in this session, this one included (counted for every tool). */
  calls: number;
  /** Whether a name may be printed (a vault value, a code or a typed text never is). */
  printable: (name: string) => boolean;
}

interface SessionState {
  shown: Set<HintId>;
  /** Error lines the agent was given by `logs`. */
  readErrors: Set<number>;
  /** A crash note was seen in an answer and `logs` hasn't delivered an error since. */
  errorSticky: boolean;
  /** The touches in a row that each began where the one before ended, every road known. */
  streak: { to: string; count: number } | null;
  /** The call before was an action whose answer had the changes. */
  prevListed: boolean;
}

/** What a session has been told, and what it has seen, to choose the one hint of an answer. */
export class HintBook {
  private readonly sessions = new Map<string, SessionState>();

  constructor(private readonly baseline: number) {}

  private stateOf(key: string): SessionState {
    let state = this.sessions.get(key);
    if (state === undefined) {
      state = { shown: new Set(), readErrors: new Set(), errorSticky: false, streak: null, prevListed: false };
      this.sessions.set(key, state);
    }
    return state;
  }

  /** Takes one finished call of the session; returns the `Hint:` line to end its answer with, or null. */
  note(key: string, call: CallFacts): string | null {
    const s = this.stateOf(key);
    const { tool, args, text, isError } = call;
    const ok = !isError;
    const dry = args["dry_run"] === true;

    if (tool === "logs") {
      for (const seq of call.delivered) s.readErrors.add(seq);
      if (call.delivered.length > 0) s.errorSticky = false;
    } else if (CRASH_NOTE.test(text)) s.errorSticky = true;
    const unread = call.errorSeqs.some((seq) => seq > this.baseline && !s.readErrors.has(seq));

    // A known way: a touch that began where the one before ended, over a road the map held. A look between doesn't break it.
    if (TOUCHES.has(tool)) {
      const way = call.way;
      if (!ok || way === undefined || !way.known) s.streak = null;
      else s.streak = s.streak !== null && s.streak.to === way.from ? { to: way.to, count: s.streak.count + 1 } : { to: way.to, count: 1 };
    } else if (tool !== "look") s.streak = null;

    const listed = ok && !dry && hadChanges(text);
    // A look sends a screenshot unless it says `screenshot: false`.
    const askedPicture = tool === "look" ? args["screenshot"] !== false : args["screenshot"] === true;
    const picture = ok && !dry && ((ACTIONS.has(tool) && args["screenshot"] === true && args["look"] !== false && listed) || (tool === "look" && askedPicture && s.prevListed));
    s.prevListed = (ACTIONS.has(tool) || tool === "run") && listed;

    if (isSafetyRefusal(text, isError)) return null;
    const facts: HintFacts = {
      error: (s.errorSticky || unread) && tool !== "logs",
      way: s.streak !== null && s.streak.count >= 3 && call.printable(s.streak.to) ? s.streak.to : null,
      form: ok && !dry && FORM_TOOLS.has(tool) && formOpened(text),
      picture,
      calls: call.calls,
    };
    const id = pickHint(facts, s.shown);
    if (id === null) return null;
    s.shown.add(id);
    return hintLine(id, facts);
  }
}
