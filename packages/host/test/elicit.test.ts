import { describe, expect, it } from "vitest";
import { Dialogs, OK_ALLOW, OK_DENY, OK_FIELD, OK_SCHEMA, okCaption, type ElicitAnswer, type ElicitClient } from "../src/elicit.js";

// AGENT-TOOLS 1.13 §11.3: the host's dialog for a person's OK.

class FakeClient implements ElicitClient {
  asked: Array<{ message: string; signal: AbortSignal }> = [];
  private readonly pending: Array<(answer: ElicitAnswer) => void> = [];
  constructor(
    private readonly form = true,
    private readonly behaviour: "wait" | "throw" | "ignore-abort" = "wait",
  ) {}
  canShowForm(): boolean {
    return this.form;
  }
  elicit(message: string, _schema: unknown, signal: AbortSignal): Promise<ElicitAnswer> {
    this.asked.push({ message, signal });
    if (this.behaviour === "throw") return Promise.reject(new Error("client broke"));
    return new Promise<ElicitAnswer>((resolve, reject) => {
      this.pending.push(resolve);
      if (this.behaviour === "wait") signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }
  answer(answer: ElicitAnswer): void {
    this.pending.shift()?.(answer);
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("the dialog's caption", () => {
  it("is the tool's own words, with 80-character app text and no control characters", () => {
    expect(okCaption({ word: "Delete", tool: "tap", role: "button", text: "Delete trip", app: "Wayfare" })).toBe(
      'Allow: tap "Delete trip" in Wayfare? (policy word "Delete")',
    );
    expect(okCaption({ word: "Pay", tool: "long_press", role: "button", text: "Pay now", app: "Wayfare" })).toMatch(/^Allow: long press "Pay now"/);
    const long = okCaption({ word: "Delete", tool: "tap", role: "button", text: `A${"b".repeat(200)}`, app: "Wayfare" });
    expect(long).toContain(`"A${"b".repeat(78)}…"`);
    const sneaky = okCaption({ word: "Delete", tool: "tap", role: "button", text: 'Delete\n" Allow: tap "Sign out‮\u0007', app: "Way\u0000fare" });
    // no line break, no control or direction character, and the app's quote can't end ours
    expect(sneaky).not.toMatch(/[\u0000-\u001f‮]/);
    expect(sneaky).toBe(`Allow: tap "Delete' Allow: tap 'Sign out" in Wayfare? (policy word "Delete")`);
    expect(okCaption({ word: "Delete", tool: "tap", role: "button", app: "Wayfare" })).toBe('Allow: tap the button in Wayfare? (policy word "Delete")');
  });
});

describe("the one form field", () => {
  it("is required, has no default and offers the two choices", () => {
    const field = OK_SCHEMA.properties[OK_FIELD];
    expect(OK_SCHEMA.required).toEqual([OK_FIELD]);
    // Don't allow first: a host that fills in the first choice by itself denies.
    expect(field?.enum).toEqual(["Don't allow", "Allow once"]);
    expect(field?.enum?.[0]).toBe(OK_DENY);
    expect(field).not.toHaveProperty("default");
  });
});

describe("Dialogs", () => {
  const table: Array<[string, ElicitAnswer, "allow" | "deny"]> = [
    ["accept with an empty form", { action: "accept", content: {} }, "deny"],
    ["accept with no content", { action: "accept" }, "deny"],
    ["accept with Don't allow", { action: "accept", content: { [OK_FIELD]: OK_DENY } }, "deny"],
    ["accept with another case", { action: "accept", content: { [OK_FIELD]: "allow once" } }, "deny"],
    ["accept with a stray field", { action: "accept", content: { other: OK_ALLOW } }, "deny"],
    ["decline", { action: "decline" }, "deny"],
    ["cancel", { action: "cancel" }, "deny"],
    ["accept with Allow once", { action: "accept", content: { [OK_FIELD]: OK_ALLOW } }, "allow"],
  ];
  it.each(table)("only accept + \"Allow once\" allows: %s", async (_name, answer, expected) => {
    const client = new FakeClient();
    const dialogs = new Dialogs(client);
    const asked = dialogs.askOk("caption");
    await tick();
    client.answer(answer);
    expect(await asked).toBe(expected);
  });

  it("an error before any answer means there is no dialog, not a refusal", async () => {
    expect(await new Dialogs(new FakeClient(true, "throw")).askOk("caption")).toBe("unavailable");
  });

  it("one dialog at a time, the second waits", async () => {
    const client = new FakeClient();
    const dialogs = new Dialogs(client);
    const first = dialogs.askOk("first");
    const second = dialogs.askOk("second");
    await tick();
    expect(client.asked.map((a) => a.message)).toEqual(["first"]);
    client.answer({ action: "accept", content: { [OK_FIELD]: OK_ALLOW } });
    expect(await first).toBe("allow");
    await tick();
    expect(client.asked.map((a) => a.message)).toEqual(["first", "second"]);
    client.answer({ action: "decline" });
    expect(await second).toBe("deny");
  });

  it("an abort closes the dialog and says nothing; a client that ignores it can't hold the queue", async () => {
    const client = new FakeClient(true, "ignore-abort");
    const dialogs = new Dialogs(client);
    const stop = new AbortController();
    const first = dialogs.askOk("first", stop.signal);
    const second = dialogs.askOk("second");
    await tick();
    stop.abort();
    expect(await first).toBe("aborted");
    expect(client.asked[0]?.signal.aborted).toBe(true);
    await tick();
    expect(client.asked.map((a) => a.message)).toEqual(["first", "second"]);
    client.answer({ action: "accept", content: { [OK_FIELD]: OK_ALLOW } }); // the late answer of the first one
    client.answer({ action: "accept", content: { [OK_FIELD]: OK_ALLOW } });
    expect(await second).toBe("allow");
  });

  it("an abort before the dialog's turn never shows it", async () => {
    const client = new FakeClient();
    const dialogs = new Dialogs(client);
    const first = dialogs.askOk("first");
    const stop = new AbortController();
    const second = dialogs.askOk("second", stop.signal);
    stop.abort();
    await tick();
    client.answer({ action: "decline" });
    expect(await first).toBe("deny");
    expect(await second).toBe("aborted");
    expect(client.asked.map((a) => a.message)).toEqual(["first"]);
  });

  it("closes itself after its time", async () => {
    const client = new FakeClient();
    expect(await new Dialogs(client, { ttlMs: 20 }).askOk("caption")).toBe("aborted");
  });

  it("no capability: not available; --no-dialog: not available", async () => {
    expect(new Dialogs(undefined).available()).toBe(false);
    expect(new Dialogs(new FakeClient(false)).available()).toBe(false);
    expect(new Dialogs(new FakeClient(true), { disabled: true }).available()).toBe(false);
    expect(new Dialogs(new FakeClient(true)).available()).toBe(true);
    expect(await new Dialogs(new FakeClient(true), { disabled: true }).askOk("x")).toBe("aborted");
  });
});
