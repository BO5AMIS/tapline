/**
 * AGENT-TOOLS 1.13 §11.3: the host's own dialog for a person's OK, through MCP elicitation. The dialog is drawn by
 * the host and answered by the person; nothing the model writes can answer it.
 */

export const OK_FIELD = "answer";
export const OK_ALLOW = "Allow once";
export const OK_DENY = "Don't allow";

/** The one form field: required, no default, so a host that accepts an empty form still can't produce an allow. */
export interface ElicitSchema {
  type: "object";
  properties: Record<string, { type: "string"; title: string; enum: string[] }>;
  required: string[];
}

export const OK_SCHEMA: ElicitSchema = {
  type: "object",
  properties: { [OK_FIELD]: { type: "string", title: "Allow this touch?", enum: [OK_ALLOW, OK_DENY] } },
  required: [OK_FIELD],
};

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

export type OkAnswer = "allow" | "deny" | "aborted";

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
    const run = (): Promise<OkAnswer> => this.ask(caption, signal);
    const result = this.tail.then(run, run);
    this.tail = result;
    return result;
  }

  private async ask(caption: string, signal: AbortSignal | undefined): Promise<OkAnswer> {
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
      const answer = await Promise.race([client.elicit(caption, OK_SCHEMA, own.signal), gone]);
      if (answer === "aborted" || own.signal.aborted) return "aborted";
      return answer.action === "accept" && answer.content?.[OK_FIELD] === OK_ALLOW ? "allow" : "deny";
    } catch {
      // An error is Don't allow, unless it came from our own abort.
      return own.signal.aborted ? "aborted" : "deny";
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    }
  }
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
