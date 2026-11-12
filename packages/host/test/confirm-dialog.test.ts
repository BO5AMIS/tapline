import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionLogEntry } from "../src/actionlog.js";
import { Confirmations, type ConfirmEvent } from "../src/confirm.js";
import { okLine } from "../src/journey.js";
import { analyze, buildCalls, formatReport } from "../src/report.js";
import { Dialogs, OK_ALLOW, OK_DENY, OK_FIELD, type ElicitAnswer, type ElicitClient } from "../src/elicit.js";
import type { PolicyFile } from "../src/policy.js";
import { RUN_TIMEOUT_MS } from "../src/run.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

// AGENT-TOOLS 1.13 §11.3: a person's OK in the host's dialog (J1). The call waits; the first answer wins.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
const pause = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Shown {
  message: string;
  signal: AbortSignal;
}

/** A host that shows dialogs: the test answers them, or the abort closes them. */
class FakeDialogClient implements ElicitClient {
  readonly shown: Shown[] = [];
  private readonly open: Array<(answer: ElicitAnswer) => void> = [];
  constructor(private readonly form = true) {}
  canShowForm(): boolean {
    return this.form;
  }
  elicit(message: string, _schema: unknown, signal: AbortSignal): Promise<ElicitAnswer> {
    this.shown.push({ message, signal });
    return new Promise<ElicitAnswer>((resolve, reject) => {
      this.open.push(resolve);
      signal.addEventListener("abort", () => reject(new Error("closed")), { once: true });
    });
  }
  async shownCount(count: number): Promise<void> {
    for (let i = 0; i < 400 && this.shown.length < count; i++) await pause(5);
    expect(this.shown.length).toBeGreaterThanOrEqual(count);
  }
  answer(answer: ElicitAnswer): void {
    this.open.shift()?.(answer);
  }
  allow(): void {
    this.answer({ action: "accept", content: { [OK_FIELD]: OK_ALLOW } });
  }
}

const DELETE = { ref: "e12", type: "Pressable", role: "button", testID: "delete-trip", text: "Delete trip", frame: { x: 115, y: 620, width: 200, height: 40 }, actions: ["press"] };
const SAVE = { ref: "e3", type: "Pressable", role: "button", testID: "save", text: "Save", frame: { x: 24, y: 610, width: 354, height: 48 }, actions: ["press"] };
const CLOSE_ACCOUNT = { ref: "e20", type: "Pressable", role: "button", testID: "close-account", text: "Delete account", frame: { x: 0, y: 0, width: 100, height: 40 }, actions: ["press"] };
const SIGN_OUT = { ref: "e21", type: "Pressable", role: "button", testID: "sign-out", text: "Sign out", frame: { x: 0, y: 50, width: 100, height: 40 }, actions: ["press"] };

interface Setup {
  app: FakeApp;
  tools: TaplineTools;
  confirmations: Confirmations;
  client: FakeDialogClient;
  events: ConfirmEvent[];
  /** What a tap on "Delete trip" now finds (the screen changed while waiting). */
  screen: { delete: typeof DELETE };
  logDir: string;
}

async function setup(
  options: { policy?: PolicyFile; dialog?: boolean; disabled?: boolean; confirmations?: Confirmations; elements?: Array<typeof DELETE> } = {},
): Promise<Setup> {
  const { host, port } = await startHost();
  hosts.push(host);
  const screen = { delete: DELETE };
  const elements = options.elements ?? [SAVE, DELETE, CLOSE_ACCOUNT, SIGN_OUT];
  const find = (params: unknown): typeof DELETE | undefined => {
    const target = (params as { target?: { testID?: string; text?: string } }).target;
    const found = elements.find((e) => (target?.testID !== undefined && e.testID === target.testID) || (target?.text !== undefined && e.text === target.text));
    return found?.testID === "delete-trip" ? screen.delete : found;
  };
  const handler = (req: IncomingRequest): Reply => {
    if (req.method === "tree") return { ok: true, result: { screen: { width: 430, height: 932 }, elements } };
    if (req.method === "press" || req.method === "longPress" || req.method === "toggle") {
      const element = find(req.params);
      if (element === undefined) return { ok: false, error: { code: "not_found", message: "No element matches" } };
      return { ok: true, result: { element, point: { x: element.frame.x + element.frame.width / 2, y: element.frame.y + element.frame.height / 2 } } };
    }
    return { ok: true, result: {} };
  };
  const { app } = await FakeApp.connect(port, {}, handler);
  apps.push(app);
  const confirmations = options.confirmations ?? new Confirmations();
  const client = new FakeDialogClient(options.dialog !== false);
  const logDir = mkdtempSync(join(tmpdir(), "tapline-okdialog-"));
  dirs.push(logDir);
  const tools = new TaplineTools(host, {
    connect: { url: "", name: "Dev PC" },
    confirmations,
    logDir,
    dialogs: new Dialogs(client, { ...(options.disabled === true ? { disabled: true } : {}) }),
    ...(options.policy ? { policy: options.policy } : {}),
  });
  const events: ConfirmEvent[] = [];
  confirmations.onEvent((e) => events.push(e));
  return { app, tools, confirmations, client, events, screen, logDir };
}

const presses = (app: FakeApp): number => app.requests.filter((r) => r.method === "press").length;

describe("a person's OK in the host's dialog (§11.3)", () => {
  it("a call waits for the dialog and acts on allow; the note says (in chat)", async () => {
    const { app, tools, client, events } = await setup();
    const call = tools.tap({ target: { id: "delete-trip" }, look: false });
    await client.shownCount(1);
    expect(client.shown[0]?.message).toBe('Allow: tap "Delete trip" in Demo? (policy word "Delete")');
    expect(presses(app)).toBe(0);
    client.allow();
    const answer = await call;
    expect(answer.isError).not.toBe(true);
    expect(textOf(answer)).toBe('Tapped e12 button "Delete trip" id=delete-trip.\nNote: allowed by a person (in chat).');
    expect(presses(app)).toBe(1);
    // the live view's request closes, saying who answered
    const closed = events.find((e) => e.type === "confirm_closed");
    expect(closed).toMatchObject({ type: "confirm_closed", allow: true, by: "chat" });
  });

  it("the live view answers first: the dialog is aborted, the note says (in the live view)", async () => {
    const { app, tools, client, confirmations, events } = await setup();
    const call = tools.tap({ target: { id: "delete-trip" }, look: false });
    await client.shownCount(1);
    const asked = events.find((e) => e.type === "confirm");
    if (asked?.type !== "confirm") throw new Error("the live view wasn't asked");
    confirmations.answer(asked.id, true);
    const answer = await call;
    expect(textOf(answer)).toBe('Tapped e12 button "Delete trip" id=delete-trip.\nNote: allowed by a person (in the live view).');
    expect(client.shown[0]?.signal.aborted).toBe(true);
    // a late answer in the dialog says nothing and allows nothing
    client.allow();
    await pause(10);
    expect(presses(app)).toBe(1);
  });

  it("Don't allow gives the declined error, and the same touch asks no one for 60 s", async () => {
    const { app, tools, client } = await setup();
    const call = tools.tap({ target: { id: "delete-trip" }, look: false });
    await client.shownCount(1);
    client.answer({ action: "accept", content: { [OK_FIELD]: OK_DENY } });
    const declined = await call;
    expect(declined.isError).toBe(true);
    expect(textOf(declined)).toBe(
      `Error not_allowed: needs_confirmation: button "Delete trip" needs a person's OK (policy word "Delete"). They declined. Don't ask again by repeating the call: ask your user what they want.`,
    );
    const again = await tools.tap({ target: { id: "delete-trip" }, look: false });
    expect(textOf(again)).toMatch(/they declined it just now\. Don't ask again/);
    expect(client.shown).toHaveLength(1);
    expect(presses(app)).toBe(0);
  });

  it("a dialog the person cancelled is a refusal too", async () => {
    const { tools, client } = await setup();
    const call = tools.tap({ target: { id: "delete-trip" }, look: false });
    await client.shownCount(1);
    client.answer({ action: "cancel" });
    expect(textOf(await call)).toMatch(/^Error not_allowed: needs_confirmation: .* They declined\./);
  });

  it("an expiry says Nobody answered.", async () => {
    // The wait is the request's own life; a short one stands for the 120 s.
    const { app, tools, client } = await setup({ confirmations: new Confirmations(undefined, 60) });
    const answer = await tools.tap({ target: { id: "delete-trip" }, look: false });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toBe(
      `Error not_allowed: needs_confirmation: button "Delete trip" needs a person's OK (policy word "Delete"). Nobody answered. Ask your user, or repeat the call to ask again.`,
    );
    expect(client.shown[0]?.signal.aborted).toBe(true);
    expect(presses(app)).toBe(0);
  });

  it("the screen changed while waiting: the exact not_allowed line, nothing touched", async () => {
    const { app, tools, client, screen } = await setup();
    const call = tools.tap({ target: { id: "delete-trip" }, look: false });
    await client.shownCount(1);
    // the same id now says something else
    screen.delete = { ...DELETE, text: "Delete account forever" };
    client.allow();
    const answer = await call;
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toBe("Error not_allowed: needs_confirmation: the screen changed while waiting for the OK; ask again.");
    expect(presses(app)).toBe(0);
    // the OK is used up: a retry asks again
    const retry = tools.tap({ target: { id: "delete-trip" }, look: false });
    await client.shownCount(2);
    client.answer({ action: "decline" });
    await retry;
  });

  it("a different element at the same target is not allowed", async () => {
    const { app, tools, client, screen } = await setup();
    const call = tools.tap({ target: { id: "delete-trip" }, look: false });
    await client.shownCount(1);
    screen.delete = { ...DELETE, testID: "delete-other", ref: "e99" };
    client.allow();
    expect(textOf(await call)).toBe("Error not_allowed: needs_confirmation: the screen changed while waiting for the OK; ask again.");
    expect(presses(app)).toBe(0);
  });

  it("a blocked word never opens a dialog", async () => {
    const policy: PolicyFile = { version: 1, confirm: ["Delete"], block: ["Delete account"] };
    const { tools, client, events } = await setup({ policy });
    const answer = await tools.tap({ target: { id: "close-account" }, look: false });
    expect(textOf(answer)).toMatch(/^Error not_allowed: blocked: /);
    expect(client.shown).toHaveLength(0);
    expect(events.filter((e) => e.type === "confirm")).toHaveLength(0);
  });

  it("a host with no dialog answers needs_confirmation at once, as before; the retry's note says the live view", async () => {
    const { app, tools, confirmations, events } = await setup({ dialog: false });
    const refused = await tools.tap({ target: { id: "delete-trip" }, look: false });
    expect(textOf(refused)).toBe(
      `Error not_allowed: needs_confirmation: button "Delete trip" needs a person's OK (policy word "Delete"). The live view asks them now; when they allow it, make the same call again. If nobody is watching, ask your user.`,
    );
    const asked = events[0];
    if (asked?.type !== "confirm") throw new Error("no request");
    confirmations.answer(asked.id, true);
    const allowed = await tools.tap({ target: { id: "delete-trip" }, look: false });
    expect(textOf(allowed)).toBe('Tapped e12 button "Delete trip" id=delete-trip.\nNote: allowed by a person (in the live view).');
    expect(presses(app)).toBe(1);
  });

  it("--no-dialog is the same as a host with no dialog", async () => {
    const { tools, client } = await setup({ disabled: true });
    const refused = await tools.tap({ target: { id: "delete-trip" }, look: false });
    expect(textOf(refused)).toMatch(/The live view asks them now/);
    expect(client.shown).toHaveLength(0);
  });

  it("an OK covers that element only, and only once", async () => {
    const { app, tools, client } = await setup();
    const first = tools.tap({ target: { id: "delete-trip" }, look: false });
    await client.shownCount(1);
    client.allow();
    expect(textOf(await first)).toMatch(/allowed by a person \(in chat\)/);
    // another element with a policy word asks its own question
    const second = tools.tap({ target: { id: "sign-out" }, look: false });
    await client.shownCount(2);
    expect(client.shown[1]?.message).toBe('Allow: tap "Sign out" in Demo? (policy word "Sign out")');
    client.answer({ action: "decline" });
    await second;
    // the same element again: the used-up OK asks again
    const third = tools.tap({ target: { id: "delete-trip" }, look: false });
    await client.shownCount(3);
    client.answer({ action: "decline" });
    await third;
    expect(presses(app)).toBe(1);
  });

  it("run stops at a declined step, and the wait is not counted toward the 120 s", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // The request's own clock stays put, so only run's clock sees the long wait.
    const { app, tools, client } = await setup({ confirmations: new Confirmations(() => 0) });
    const call = tools.run({ steps: [{ tool: "tap", target: { id: "delete-trip" }, look: false }, { tool: "tap", target: { id: "save" }, look: false }] } as never);
    await client.shownCount(1);
    vi.setSystemTime(Date.now() + RUN_TIMEOUT_MS + 1000);
    client.allow();
    const done = await call;
    expect(done.isError).not.toBe(true);
    expect(textOf(done)).not.toMatch(/ran longer/);
    expect(presses(app)).toBe(2);

    const declined = tools.run({ steps: [{ tool: "tap", target: { id: "sign-out" }, look: false }, { tool: "tap", target: { id: "save" }, look: false }] } as never);
    await client.shownCount(2);
    client.answer({ action: "decline" });
    const stopped = await declined;
    expect(stopped.isError).toBe(true);
    expect(textOf(stopped)).toMatch(/needs_confirmation/);
    expect(presses(app)).toBe(2);
  });

  it("the action log says where the OK came from", async () => {
    const { tools, client, logDir } = await setup();
    const call = tools.tap({ target: { id: "delete-trip" }, look: false });
    await client.shownCount(1);
    client.allow();
    await call;
    const files = readdirSync(logDir).filter((f) => f.startsWith("actions-"));
    const lines = files.flatMap((f) => readFileSync(join(logDir, f), "utf8").split("\n").filter((l) => l !== "")).map((l) => JSON.parse(l) as Record<string, unknown>);
    const tap = lines.find((l) => l["tool"] === "tap" && l["ok"] === true);
    expect(tap).toMatchObject({ confirmed: true, confirmed_by: "chat" });
  });
});

describe("where each OK came from, on record (§11.3)", () => {
  const entry = (call: number, extra: Partial<ActionLogEntry> = {}): ActionLogEntry => ({
    t: new Date(1_700_000_000_000 + call * 1000).toISOString(),
    source: "tapline",
    by: "agent",
    tool: "tap",
    ok: true,
    session: "s1",
    call,
    ...extra,
  });

  it("session_report has an Approvals line, and none when no OK was used", () => {
    const text = formatReport(analyze(buildCalls([entry(1, { confirmed: true, confirmed_by: "chat" }), entry(2, { confirmed: true, confirmed_by: "live view" }), entry(3, { confirmed: true, confirmed_by: "chat" }), entry(4)])));
    expect(text.split("\n")).toContain("Approvals: 2 in chat, 1 in the live view.");
    expect(formatReport(analyze(buildCalls([entry(1)])))).not.toMatch(/Approvals/);
  });

  it("a journey report names it", () => {
    expect(okLine(["chat"])).toBe("A person's OK was used once: 1 in chat.");
    expect(okLine(["chat", "live view", "live view"])).toBe("A person's OK was used 3 times: 1 in chat, 2 in the live view.");
  });
});
