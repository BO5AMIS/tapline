/**
 * AGENT-TOOLS 1.13 §11.3: the host's own dialog for a person's OK, through MCP elicitation. The dialog is drawn by
 * the host and answered by the person; nothing the model writes can answer it.
 */

export const OK_FIELD = "answer";
export const OK_ALLOW = "Allow once";
export const OK_DENY = "Don't allow";

/**
 * The one form field: required, no default, so a host that accepts an empty form still can't produce an allow.
 * Don't allow comes first, so a host that fills in the first choice by itself denies.
 */
export interface ElicitSchema {
  type: "object";
  properties: Record<string, { type: "string"; title: string; enum: string[]; default?: string }>;
  required: string[];
}

export const OK_SCHEMA: ElicitSchema = {
  type: "object",
  properties: { [OK_FIELD]: { type: "string", title: "Allow this touch?", enum: [OK_DENY, OK_ALLOW] } },
  required: [OK_FIELD],
};

/** AGENT-TOOLS 1.13 §11.5: the one field of a needs-a-person dialog. Can't now is first, as Don't allow is for an OK. */
export const DONE_FIELD = "answer";
export const DONE = "Done";
export const CANT_NOW = "Can't now";

export const DONE_SCHEMA: ElicitSchema = {
  type: "object",
  properties: { [DONE_FIELD]: { type: "string", title: "Has it been done?", enum: [CANT_NOW, DONE] } },
  required: [DONE_FIELD],
};

/** AGENT-TOOLS 1.14 §19.6: the grant's question. One required field, no default; Don't allow first, as for an OK. */
export const GRANT_FIELD = "answer";
export const GRANT_ALLOW = "Allow";
export const GRANT_DENY = "Don't allow";
export const GRANT_SCHEMA: ElicitSchema = {
  type: "object",
  properties: { [GRANT_FIELD]: { type: "string", title: "Allow this grant?", enum: [GRANT_DENY, GRANT_ALLOW] } },
  required: [GRANT_FIELD],
};

/** §19.6: the separate second question for a word that reaches other people. It defaults to No; only Yes lifts drafts-only. */
export const DRAFTS_FIELD = "answer";
export const DRAFTS_YES = "Yes";
export const DRAFTS_NO = "No";
export const DRAFTS_QUESTION = "Send these without showing you each one first?";
export const DRAFTS_SCHEMA: ElicitSchema = {
  type: "object",
  properties: { [DRAFTS_FIELD]: { type: "string", title: "Send without showing drafts?", enum: [DRAFTS_NO, DRAFTS_YES], default: DRAFTS_NO } },
  required: [DRAFTS_FIELD],
};

/**
 * AGENT-TOOLS 1.14 §21.3: the draft's question. One required field, no default; the refusal comes first, as for an OK, so a
 * host that fills in the first choice by itself doesn't send. The choices carry the policy word: `Post` and `Don't post`.
 */
export const DRAFT_FIELD = "answer";
export const DRAFT_MAX = 500;

/** The policy word as the choices and the caption say it: cleaned, first letter capital. */
export function draftWord(word: string): string {
  const clean = plainText(word, 30);
  const first = [...clean][0];
  return first === undefined ? "Send" : first.toUpperCase() + clean.slice(first.length);
}

/** `Post` and `Don't post`. */
export function draftChoices(word: string): { send: string; dont: string } {
  const send = draftWord(word);
  const first = [...send][0] ?? "";
  return { send, dont: `Don't ${first.toLowerCase()}${send.slice(first.length)}` };
}

export function draftSchema(word: string): ElicitSchema {
  const { send, dont } = draftChoices(word);
  return { type: "object", properties: { [DRAFT_FIELD]: { type: "string", title: "Send this draft?", enum: [dont, send] } }, required: [DRAFT_FIELD] };
}

export interface ElicitAnswer {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

export interface ElicitClient {
  /** True when the client said at initialize that it can show a form dialog. */
  canShowForm(): boolean;
  elicit(message: string, schema: ElicitSchema, signal: AbortSignal): Promise<ElicitAnswer>;
}

/** A person's OK is asked for up to this long, as long as the live view's request lives (§11.3). */
export const DIALOG_TTL_MS = 120_000;

/** `unavailable`: the client answered an error before any choice (for example method not found): there is no dialog. */
export type OkAnswer = "allow" | "deny" | "aborted" | "unavailable";

export class Dialogs {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly disabled: boolean;
  private readonly ttlMs: number;

  constructor(
    private readonly client: ElicitClient | undefined,
    options: { disabled?: boolean; ttlMs?: number } = {},
  ) {
    this.disabled = options.disabled === true;
    this.ttlMs = options.ttlMs ?? DIALOG_TTL_MS;
  }

  /** False with `--no-dialog`, with no client, or when the client can't show a form. */
  available(): boolean {
    return !this.disabled && this.client !== undefined && this.client.canShowForm();
  }

  /**
   * Asks the person. One dialog at a time: a second request waits behind the first. `aborted` when the signal
   * fired (the live view answered first) or the time ran out; only an accepted "Allow once" is `allow`.
   */
  askOk(caption: string, signal?: AbortSignal): Promise<OkAnswer> {
    return this.queued(async () => {
      const answer = await this.ask(caption, OK_SCHEMA, signal);
      if (answer === "aborted" || answer === "unavailable") return answer;
      return answer.action === "accept" && answer.content?.[OK_FIELD] === OK_ALLOW ? "allow" : "deny";
    });
  }

  /**
   * §11.5: tells the person what to do and waits for Done. Only an accepted "Done" is `done`; Can't now, a decline and
   * a cancel are `cant`. `aborted` and `unavailable` are as for `askOk`.
   */
  askDone(message: string, signal?: AbortSignal): Promise<DoneAnswer> {
    return this.queued(async () => {
      const answer = await this.ask(message, DONE_SCHEMA, signal);
      if (answer === "aborted" || answer === "unavailable") return answer;
      return answer.action === "accept" && answer.content?.[DONE_FIELD] === DONE ? "done" : "cant";
    });
  }

  /**
   * §21.3: a draft shown before the touch that sends it. Only an accepted `<Word>` is `allow`; `Don't <word>`, a decline, a cancel
   * and an error are `deny` (an error before any choice is `unavailable`, as for `askOk`).
   */
  askDraft(caption: string, word: string, signal?: AbortSignal): Promise<OkAnswer> {
    return this.queued(async () => {
      const answer = await this.ask(caption, draftSchema(word), signal);
      if (answer === "aborted" || answer === "unavailable") return answer;
      return answer.action === "accept" && answer.content?.[DRAFT_FIELD] === draftChoices(word).send ? "allow" : "deny";
    });
  }

  /** §19.6: the grant's question. Only an accepted "Allow" is `allow`; anything else is `deny`. */
  askGrant(caption: string, signal?: AbortSignal): Promise<OkAnswer> {
    return this.queued(async () => {
      const answer = await this.ask(caption, GRANT_SCHEMA, signal);
      if (answer === "aborted" || answer === "unavailable") return answer;
      return answer.action === "accept" && answer.content?.[GRANT_FIELD] === GRANT_ALLOW ? "allow" : "deny";
    });
  }

  /** §19.6: the drafts question. Only an accepted "Yes" is `allow`; No, a decline, a cancel and an error are `deny`. */
  askLiftDrafts(signal?: AbortSignal): Promise<OkAnswer> {
    return this.queued(async () => {
      const answer = await this.ask(DRAFTS_QUESTION, DRAFTS_SCHEMA, signal);
      if (answer === "aborted") return "aborted";
      if (answer === "unavailable") return "deny";
      return answer.action === "accept" && answer.content?.[DRAFTS_FIELD] === DRAFTS_YES ? "allow" : "deny";
    });
  }

  private queued<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run, run);
    this.tail = result;
    return result;
  }

  private async ask(message: string, schema: ElicitSchema, signal: AbortSignal | undefined): Promise<ElicitAnswer | "aborted" | "unavailable"> {
    const client = this.client;
    if (client === undefined || !this.available() || signal?.aborted === true) return "aborted";
    const own = new AbortController();
    const stop = (): void => own.abort();
    signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, this.ttlMs);
    timer.unref?.();
    // A client that ignores the abort must not hold the queue: the race ends the wait itself.
    const gone = new Promise<"aborted">((resolve) => own.signal.addEventListener("abort", () => resolve("aborted"), { once: true }));
    try {
      const answer = await Promise.race([client.elicit(message, schema, own.signal), gone]);
      return answer === "aborted" || own.signal.aborted ? "aborted" : answer;
    } catch {
      // An error before any answer means this client has no dialog; a real decline or cancel is a result, not an error.
      return own.signal.aborted ? "aborted" : "unavailable";
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    }
  }
}

/** Read again later: the signal may have fired since the first look. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export type DoneAnswer ="done" | "cant" | "aborted" | "unavailable";

/** What `askDone` (the helper) tells its caller. `cleared` also covers the person saying Done: the caller checks again. */
export type MomentOutcome = "cleared" | "cant" | "expired" | "cancelled" | "no_dialog";

/**
 * AGENT-TOOLS 1.13 §11.5: one needs-a-person moment. Tells the person through the dialog and waits until `cleared()`
 * is true (then closes its own dialog), the person says Done (`cleared`: the caller checks the screen again) or
 * Can't now, or the time runs out. Nothing a model writes can answer it. No dialog at all: `no_dialog`, at once.
 */
export async function askDone(
  dialogs: Dialogs,
  message: string,
  cleared: () => Promise<boolean> | boolean,
  options: { ttlMs?: number; pollMs?: number; signal?: AbortSignal } = {},
): Promise<MomentOutcome> {
  if (!dialogs.available()) return "no_dialog";
  const signal = options.signal;
  if (signal?.aborted === true) return "cancelled";
  const check = async (): Promise<boolean> => {
    try {
      return await cleared();
    } catch {
      return false;
    }
  };
  const first = await check();
  // The caller may have cancelled while the first check ran.
  if (isAborted(signal)) return "cancelled";
  if (first) return "cleared";
  const own = new AbortController();
  const stopOwn = (): void => own.abort();
  signal?.addEventListener("abort", stopOwn, { once: true });
  let outcome: MomentOutcome | undefined;
  const finish = (value: MomentOutcome): void => {
    if (outcome === undefined) outcome = value;
    own.abort();
  };
  const ended = new Promise<void>((resolve) => own.signal.addEventListener("abort", () => resolve(), { once: true }));
  const timer = setTimeout(() => finish("expired"), options.ttlMs ?? DIALOG_TTL_MS);
  timer.unref?.();
  let polling = false;
  const poll = setInterval(() => {
    if (polling || outcome !== undefined) return;
    polling = true;
    void check().then((now) => {
      polling = false;
      if (now) finish("cleared");
    });
  }, options.pollMs ?? 500);
  poll.unref?.();
  void dialogs.askDone(message, own.signal).then((answer) => {
    if (answer === "done") finish("cleared");
    else if (answer === "cant") finish("cant");
    else if (answer === "unavailable") finish("no_dialog");
  });
  await ended;
  clearTimeout(timer);
  clearInterval(poll);
  signal?.removeEventListener("abort", stopOwn);
  return outcome ?? (isAborted(signal) ? "cancelled" : "expired");
}

const NOT_SHOWN = new RegExp("[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]", "g");

/** App text as the dialog may show it: no control characters, no quote that could end ours, cut to 80 characters. */
export function plainText(value: string, max = 80): string {
  const clean = value.replace(NOT_SHOWN, "").replace(/"/g, "'").trim();
  const letters = [...clean];
  return letters.length > max ? `${letters.slice(0, max - 1).join("")}…` : clean;
}

const VERBS: Record<string, string> = { tap: "tap", long_press: "long press", toggle: "toggle", swipe: "swipe" };

/**
 * The question, in the tool's own words: the policy word, the tool, the element's quoted text (or its role) and the
 * app. Text from the app is cut and cleaned, so it can't write the question (§11.3).
 * `Allow: tap "Delete trip" in Wayfare? (policy word "Delete")`
 */
export function okCaption(v: { word: string; tool: string; role: string; text?: string; app: string }): string {
  const verb = VERBS[v.tool] ?? v.tool.replace(/_/g, " ");
  const text = v.text === undefined ? "" : plainText(v.text);
  const what = text !== "" ? `"${text}"` : `the ${plainText(v.role, 30) || "element"}`;
  const app = plainText(v.app) || "the app";
  return `Allow: ${verb} ${what} in ${app}? (policy word "${plainText(v.word)}")`;
}

/**
 * §21.3: a draft's text as the dialog shows it: line breaks as spaces, no control character, no quote that could end the question,
 * cut at 500 characters with `…(+N)`. Vault and account values are redacted by the caller, before the cut, so one that straddles it
 * can't show its start.
 */
export function cutDraft(value: string, max = DRAFT_MAX): string {
  const clean = value.replace(/[\r\n\t]+/g, " ").replace(NOT_SHOWN, "").replace(/"/g, "'").trim();
  const letters = [...clean];
  return letters.length > max ? `${letters.slice(0, max).join("")}…(+${letters.length - max})` : clean;
}

/** §21.3: `Post this in Instagram? "…"`. The word is the policy word that matched. */
export function draftCaption(v: { word: string; app: string; text: string }): string {
  return `${draftWord(v.word)} this in ${plainText(v.app) || "the app"}? "${cutDraft(v.text)}"`;
}
