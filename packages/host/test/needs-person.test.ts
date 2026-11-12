import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { NO_POLICY } from "../src/policy.js";
import { rig as journeyRig, type Rig as JourneyRig } from "./journeyhelpers.js";
import { CANT_NOW, DONE, DONE_FIELD, DONE_SCHEMA, Dialogs, askDone, type ElicitAnswer, type ElicitClient, type ElicitSchema } from "../src/elicit.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

// AGENT-TOOLS 1.13 §11.5: the host's dialog for what only a person can do. It tells them and waits; it never decides.

const pause = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class FakeDialogClient implements ElicitClient {
  readonly shown: Array<{ message: string; schema: ElicitSchema; signal: AbortSignal }> = [];
  private readonly open: Array<{ resolve: (answer: ElicitAnswer) => void; reject: (error: Error) => void }> = [];
  constructor(private readonly form = true) {}
  canShowForm(): boolean {
    return this.form;
  }
  elicit(message: string, schema: ElicitSchema, signal: AbortSignal): Promise<ElicitAnswer> {
    this.shown.push({ message, schema, signal });
    return new Promise<ElicitAnswer>((resolve, reject) => {
      this.open.push({ resolve, reject });
      signal.addEventListener("abort", () => reject(new Error("closed")), { once: true });
    });
  }
  async shownCount(count: number): Promise<void> {
    for (let i = 0; i < 400 && this.shown.length < count; i++) await pause(5);
    expect(this.shown.length).toBeGreaterThanOrEqual(count);
  }
  answer(answer: ElicitAnswer): void {
    this.open.shift()?.resolve(answer);
  }
  fail(error: Error): void {
    this.open.shift()?.reject(error);
  }
}

const doneAnswer = (value: string): ElicitAnswer => ({ action: "accept", content: { [DONE_FIELD]: value } });

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];
const journeyRigs: JourneyRig[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const r of journeyRigs.splice(0)) await r.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The smallest thing `media` accepts as a JPEG: a start, a header with a size, an end. */
function tinyJpeg(): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.set([0xff, 0xc0, 0x00, 0x11, 0x08], 0);
  sof.writeUInt16BE(480, 5);
  sof.writeUInt16BE(640, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

describe("askDone (the dialog for a needs-a-person moment)", () => {
  it("asks one required field, Can't now first so an autofilled first choice never says Done", async () => {
    const client = new FakeDialogClient();
    const call = askDone(new Dialogs(client), "Needs a person: unlock the phone.", () => false, { pollMs: 5, ttlMs: 2000 });
    await client.shownCount(1);
    expect(client.shown[0]?.message).toBe("Needs a person: unlock the phone.");
    expect(client.shown[0]?.schema).toBe(DONE_SCHEMA);
    expect(DONE_SCHEMA.required).toEqual([DONE_FIELD]);
    expect(DONE_SCHEMA.properties[DONE_FIELD]?.enum).toEqual([CANT_NOW, DONE]);
    client.answer(doneAnswer(DONE));
    expect(await call).toBe("cleared");
  });

  it("Can't now, a decline and a cancel are all cant", async () => {
    for (const answer of [doneAnswer(CANT_NOW), { action: "decline" } as const, { action: "cancel" } as const]) {
      const client = new FakeDialogClient();
      const call = askDone(new Dialogs(client), "m", () => false, { pollMs: 5, ttlMs: 2000 });
      await client.shownCount(1);
      client.answer(answer);
      expect(await call).toBe("cant");
    }
  });

  it("an empty form or another value never says Done", async () => {
    for (const answer of [{ action: "accept", content: {} } as const, doneAnswer("done"), doneAnswer("DONE")]) {
      const client = new FakeDialogClient();
      const call = askDone(new Dialogs(client), "m", () => false, { pollMs: 5, ttlMs: 2000 });
      await client.shownCount(1);
      client.answer(answer);
      expect(await call).toBe("cant");
    }
  });

  it("closes its own dialog when the moment clears", async () => {
    const client = new FakeDialogClient();
    let clear = false;
    const call = askDone(new Dialogs(client), "m", () => clear, { pollMs: 5, ttlMs: 2000 });
    await client.shownCount(1);
    clear = true;
    expect(await call).toBe("cleared");
    expect(client.shown[0]?.signal.aborted).toBe(true);
  });

  it("an async check works too", async () => {
    const client = new FakeDialogClient();
    let polls = 0;
    const call = askDone(new Dialogs(client), "m", async () => ++polls > 2, { pollMs: 5, ttlMs: 2000 });
    expect(await call).toBe("cleared");
    expect(client.shown[0]?.signal.aborted).toBe(true);
  });

  it("a moment that is already clear opens no dialog", async () => {
    const client = new FakeDialogClient();
    expect(await askDone(new Dialogs(client), "m", () => true, { pollMs: 5, ttlMs: 2000 })).toBe("cleared");
    expect(client.shown).toHaveLength(0);
  });

  it("the limit is expired, and the dialog is closed", async () => {
    const client = new FakeDialogClient();
    expect(await askDone(new Dialogs(client), "m", () => false, { pollMs: 5, ttlMs: 60 })).toBe("expired");
    expect(client.shown[0]?.signal.aborted).toBe(true);
  });

  it("a call cancelled meanwhile is cancelled, and the dialog is closed", async () => {
    const client = new FakeDialogClient();
    const stop = new AbortController();
    const call = askDone(new Dialogs(client), "m", () => false, { pollMs: 5, ttlMs: 2000, signal: stop.signal });
    await client.shownCount(1);
    stop.abort();
    expect(await call).toBe("cancelled");
    expect(client.shown[0]?.signal.aborted).toBe(true);
  });

  it("no dialog: --no-dialog, a client without forms, no client, and a client error", async () => {
    expect(await askDone(new Dialogs(new FakeDialogClient(), { disabled: true }), "m", () => false, { pollMs: 5, ttlMs: 50 })).toBe("no_dialog");
    expect(await askDone(new Dialogs(new FakeDialogClient(false)), "m", () => false, { pollMs: 5, ttlMs: 50 })).toBe("no_dialog");
    expect(await askDone(new Dialogs(undefined), "m", () => false, { pollMs: 5, ttlMs: 50 })).toBe("no_dialog");
    const client = new FakeDialogClient();
    const call = askDone(new Dialogs(client), "m", () => false, { pollMs: 5, ttlMs: 2000 });
    await client.shownCount(1);
    client.fail(new Error("method not found"));
    expect(await call).toBe("no_dialog");
  });
});

// ---- the tools: a call that can't go on without a person ----

const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
const SAVE = { ref: "e3", type: "Pressable", role: "button", testID: "save", text: "Save", frame: { x: 24, y: 610, width: 354, height: 48 }, actions: ["press"] };

interface World {
  /** The alerts the tree shows right now. */
  alerts: Array<{ kind: "alert"; title: string; message: string | null; buttons: Array<{ text: string; style: "default" }>; standIn: boolean }>;
  /** A press answers this error while set. */
  pressError?: { code: string; message: string };
}

const ALERT = { kind: "alert" as const, title: "Allow photos?", message: null, buttons: [{ text: "Allow", style: "default" as const }], standIn: false };

function handlerFor(world: World): (req: IncomingRequest) => Reply {
  return (req) => {
    if (req.method === "tree") return { ok: true, result: { screen: { width: 430, height: 932 }, elements: [SAVE], ...(world.alerts.length > 0 ? { alerts: world.alerts } : {}) } };
    if (req.method === "press") {
      if (world.pressError !== undefined) return { ok: false, error: world.pressError };
      return { ok: true, result: { element: SAVE, point: { x: 200, y: 630 } } };
    }
    return { ok: true, result: {} };
  };
}

interface Rig {
  tools: TaplineTools;
  host: TaplineHost;
  client: FakeDialogClient;
  world: World;
  app: () => FakeApp | undefined;
  connect: () => Promise<FakeApp>;
}

async function rigWith(options: { dialog?: boolean; app?: boolean; ttlMs?: number; pairedBefore?: boolean } = {}): Promise<Rig> {
  const { host, port } = await startHost();
  hosts.push(host);
  const world: World = { alerts: [] };
  let current: FakeApp | undefined;
  const connect = async (): Promise<FakeApp> => {
    const { app } = await FakeApp.connect(port, {}, handlerFor(world));
    apps.push(app);
    current = app;
    return app;
  };
  if (options.app !== false) await connect();
  const client = new FakeDialogClient(options.dialog !== false);
  const tools = new TaplineTools(host, {
    connect: { url: "", name: "Dev PC" },
    dialogs: new Dialogs(client, { ttlMs: options.ttlMs ?? 2000 }),
    personWaitMs: options.ttlMs ?? 2000,
    personPollMs: 5,
    personDoneGraceMs: 60,
    ...(options.pairedBefore !== undefined ? { pairedBefore: () => options.pairedBefore === true } : {}),
  });
  return { tools, host, client, world, app: () => current, connect };
}

const presses = (app: FakeApp | undefined): number => app?.requests.filter((r) => r.method === "press").length ?? 0;

async function toBackground(r: Rig): Promise<void> {
  r.app()?.send({ type: "event", event: "appState", data: { state: "background" } });
  for (let i = 0; i < 100 && r.host.current()?.appState?.state !== "background"; i++) await pause(5);
}

describe("needs a person (§11.5): the app is not there", () => {
  it("waits, the app connects, the call goes on and acts; the dialog closes itself", async () => {
    const r = await rigWith({ app: false });
    const call = r.tools.tap({ target: { id: "save" }, look: false });
    await r.client.shownCount(1);
    expect(r.client.shown[0]?.message).toBe("Needs a person: open the app on the phone (unlock it first if it's locked).");
    const app = await r.connect();
    const answer = await call;
    expect(answer.isError).not.toBe(true);
    expect(textOf(answer)).toContain('Tapped e3 button "Save" id=save');
    expect(presses(app)).toBe(1);
    expect(r.client.shown[0]?.signal.aborted).toBe(true);
  });

  it("names the app that was there before", async () => {
    const r = await rigWith();
    r.app()?.ws.terminate();
    for (let i = 0; i < 100 && r.host.current() !== undefined; i++) await pause(5);
    const call = r.tools.tap({ target: { id: "save" }, look: false });
    await r.client.shownCount(1);
    expect(r.client.shown[0]?.message).toBe("Needs a person: open Demo on the phone (unlock it first if it's locked).");
    await r.connect();
    await call;
  });

  it("a phone that never paired is asked to pair", async () => {
    const r = await rigWith({ app: false, pairedBefore: false });
    const call = r.tools.tap({ target: { id: "save" }, look: false });
    await r.client.shownCount(1);
    expect(r.client.shown[0]?.message).toBe("Needs a person: pair the phone (scan the QR code, or open the app and tap Connect).");
    await r.connect();
    expect((await call).isError).not.toBe(true);
  });

  it("Can't now gives not_connected at once and says they can't now", async () => {
    const r = await rigWith({ app: false });
    const call = r.tools.tap({ target: { id: "save" }, look: false });
    await r.client.shownCount(1);
    r.client.answer(doneAnswer(CANT_NOW));
    const answer = await call;
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error not_connected: No app is connected to Tapline\./);
    expect(textOf(answer)).toContain("They can't now. Ask your user what to do.");
  });

  it("the limit gives the usual not_connected, with no can't-now line", async () => {
    const r = await rigWith({ app: false, ttlMs: 80 });
    const answer = await r.tools.tap({ target: { id: "save" }, look: false });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error not_connected: /);
    expect(textOf(answer)).not.toContain("They can't now");
    expect(r.client.shown[0]?.signal.aborted).toBe(true);
  });

  it("Done with the app still missing: one dialog per moment per call, then the usual error", async () => {
    const r = await rigWith({ app: false });
    const call = r.tools.tap({ target: { id: "save" }, look: false });
    await r.client.shownCount(1);
    r.client.answer(doneAnswer(DONE));
    const answer = await call;
    expect(textOf(answer)).toMatch(/^Error not_connected: /);
    expect(r.client.shown).toHaveLength(1);
  });

  it("Done, and the app connects a moment later: the call goes on", async () => {
    const r = await rigWith({ app: false });
    const call = r.tools.tap({ target: { id: "save" }, look: false });
    await r.client.shownCount(1);
    r.client.answer(doneAnswer(DONE));
    await r.connect();
    expect((await call).isError).not.toBe(true);
  });

  it("a host with no dialog keeps today's answer", async () => {
    const r = await rigWith({ app: false, dialog: false });
    const answer = await r.tools.tap({ target: { id: "save" }, look: false });
    expect(textOf(answer)).toMatch(/^Error not_connected: No app is connected to Tapline\./);
    expect(r.client.shown).toHaveLength(0);
  });

  it("the app in the background: asked to open it, goes on when it is back in front", async () => {
    const r = await rigWith();
    await toBackground(r);
    const call = r.tools.tap({ target: { id: "save" }, look: false });
    await r.client.shownCount(1);
    expect(r.client.shown[0]?.message).toBe("Needs a person: open Demo on the phone (unlock it first if it's locked).");
    r.app()?.send({ type: "event", event: "appState", data: { state: "active" } });
    const answer = await call;
    expect(answer.isError).not.toBe(true);
    expect(presses(r.app())).toBe(1);
  });

  it("no dialog, in the background: today's text plus the Note", async () => {
    const r = await rigWith({ dialog: false });
    await toBackground(r);
    const answer = await r.tools.tap({ target: { id: "save" }, look: false });
    expect(textOf(answer)).toMatch(/^Error in_background: Demo is in the background/);
    expect(textOf(answer).split("\n").at(-1)).toBe("Note: needs a person: open Demo on the phone (unlock it first if it's locked).");
  });
});

describe("needs a person (§11.5): an alert, and what is not a moment", () => {
  const BEHIND = {
    code: "not_actionable",
    message: "behind_alert: An alert is open: \"Allow photos?\" [Allow]. A person would have to answer it first, and Tapline can't press OS alerts: ask the user to tap a button.",
  };

  it("an alert over the app: waits until it is gone, then acts", async () => {
    const r = await rigWith();
    r.world.alerts = [ALERT];
    r.world.pressError = BEHIND;
    const call = r.tools.tap({ target: { id: "save" }, look: false });
    await r.client.shownCount(1);
    expect(r.client.shown[0]?.message).toBe('Needs a person: tap "Allow" on the alert.');
    // The refusal came from the safety check's dry run: nothing was touched.
    expect(presses(r.app())).toBe(0);
    r.world.alerts = [];
    delete r.world.pressError;
    const answer = await call;
    expect(answer.isError).not.toBe(true);
    expect(presses(r.app())).toBe(1);
    expect(r.client.shown[0]?.signal.aborted).toBe(true);
  });

  it("an alert with several buttons names the alert, not a button", async () => {
    const r = await rigWith();
    r.world.alerts = [{ ...ALERT, title: "Delete item?", buttons: [{ text: "Cancel", style: "default" }, { text: "OK", style: "default" }] }];
    r.world.pressError = BEHIND;
    const call = r.tools.tap({ target: { id: "save" }, look: false });
    await r.client.shownCount(1);
    expect(r.client.shown[0]?.message).toBe('Needs a person: answer the alert "Delete item?" on the phone.');
    r.client.answer(doneAnswer(CANT_NOW));
    const answer = await call;
    expect(textOf(answer)).toMatch(/^Error not_actionable: behind_alert: /);
    expect(textOf(answer)).toContain("They can't now. Ask your user what to do.");
  });

  it("no dialog: today's text plus the Note", async () => {
    const r = await rigWith({ dialog: false });
    r.world.alerts = [ALERT];
    r.world.pressError = BEHIND;
    const answer = await r.tools.tap({ target: { id: "save" }, look: false });
    expect(textOf(answer)).toMatch(/^Error not_actionable: behind_alert: An alert is open/);
    expect(textOf(answer).split("\n").at(-1)).toBe('Note: needs a person: tap "Allow" on the alert.');
  });

  it("the alert a stand-in draws is an ordinary screen, not a moment", async () => {
    const r = await rigWith();
    r.world.alerts = [{ ...ALERT, standIn: true }];
    r.world.pressError = { code: "not_actionable", message: 'behind_alert: "Allow photos?" is open with [Allow]; tap one of them first.' };
    const answer = await r.tools.tap({ target: { id: "save" }, look: false });
    expect(textOf(answer)).toMatch(/^Error not_actionable: behind_alert: "Allow photos\?" is open with/);
    expect(r.client.shown).toHaveLength(0);
  });

  it("busy and paused open no dialog", async () => {
    const r = await rigWith();
    for (const code of ["busy", "paused"]) {
      r.world.pressError = { code, message: "a person is at the phone" };
      const answer = await r.tools.tap({ target: { id: "save" }, look: false });
      expect(textOf(answer)).toMatch(new RegExp(`^Error ${code}: `));
    }
    expect(r.client.shown).toHaveLength(0);
  });
});

// ---- a journey's stress moment and media use the same helper ----

describe("needs a person (§11.5): a stress moment, media and a stopped app", () => {
  it("a stress moment that needs hands: the dialog tells them, and the call goes on when the app shows it", async () => {
    const client = new FakeDialogClient();
    const r = await journeyRig({
      tools: { dialogs: new Dialogs(client, { ttlMs: 2000 }), personWaitMs: 2000, personPollMs: 5, personDoneGraceMs: 60 },
    });
    journeyRigs.push(r);
    await r.tools.journey({ start: true, goal: "log two eggs", persona: "a first-timer" });
    const call = r.tools.journey({ stress: { kind: "background" }, survives: { text: "2 eggs" } });
    await client.shownCount(1);
    expect(client.shown[0]?.message).toBe("Needs a person: switch to another app and back.");
    r.app.send({ type: "event", event: "appState", data: { state: "background" } });
    await pause(30);
    expect(client.shown[0]?.signal.aborted).toBe(false);
    r.app.send({ type: "event", event: "appState", data: { state: "active" } });
    expect(textOf(await call)).toBe('Stress: background; it survived: text "2 eggs" is still in the field.');
    expect(client.shown[0]?.signal.aborted).toBe(true);
  });

  it("Can't now ends the stress moment at once", async () => {
    const client = new FakeDialogClient();
    const r = await journeyRig({ tools: { dialogs: new Dialogs(client, { ttlMs: 2000 }), personWaitMs: 2000, personPollMs: 5, personDoneGraceMs: 60 } });
    journeyRigs.push(r);
    await r.tools.journey({ start: true, goal: "log two eggs", persona: "a first-timer" });
    const call = r.tools.journey({ stress: { kind: "rotate" } });
    await client.shownCount(1);
    expect(client.shown[0]?.message).toBe("Needs a person: turn the phone and keep it turned.");
    client.answer(doneAnswer(CANT_NOW));
    const answer = await call;
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toBe("Error not_allowed: stress rotate needs a person: turn the phone and keep it turned. They can't now. Ask your user what to do.");
    // nothing is waiting any more
    expect(textOf(await r.tools.journey({ stress: { kind: "rotate" }, done: true }))).toMatch(/^Error bad_params: no rotate moment is waiting/);
  });

  it("no dialog: the existing say-done flow stays", async () => {
    const r = await journeyRig({});
    journeyRigs.push(r);
    await r.tools.journey({ start: true, goal: "log two eggs", persona: "a first-timer" });
    const asked = textOf(await r.tools.journey({ stress: { kind: "background" } }));
    expect(asked.split("\n")[0]).toBe("Stress: background needs a person: switch to another app and back, then say done.");
  });

  it("media: a photo-access prompt waits in the dialog; Done and the picture is added", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tapline-needs-person-"));
    dirs.push(dir);
    const file = join(dir, "breakfast.jpg");
    writeFileSync(file, tinyJpeg());
    const client = new FakeDialogClient();
    const { host, port } = await startHost();
    hosts.push(host);
    let adds = 0;
    const { app } = await FakeApp.connect(port, { capabilities: ["tree", "media"], device: { platform: "ios", osVersion: "26.1", model: "x", name: "p", id: "install-1" } }, (req) => {
      if (req.method === "tree") return { ok: true, result: { screen: { width: 400, height: 800 }, elements: [] } };
      adds += 1;
      return adds === 1 ? { ok: true, result: { needsPerson: true } } : { ok: true, result: { id: "asset-1" } };
    });
    apps.push(app);
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, dialogs: new Dialogs(client, { ttlMs: 2000 }), personWaitMs: 2000, personPollMs: 5, personDoneGraceMs: 20 });
    const call = tools.media({ add: [file], confirm: true });
    await client.shownCount(1);
    expect(client.shown[0]?.message).toBe("Needs a person: allow photo access on the phone.");
    client.answer(doneAnswer(DONE));
    const answer = await call;
    expect(textOf(answer)).toMatch(/^Added 1 picture to the phone's photo library/);
    expect(adds).toBe(2);
  });

  it("media with no dialog keeps its text and Note", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tapline-needs-person-"));
    dirs.push(dir);
    const file = join(dir, "breakfast.jpg");
    writeFileSync(file, tinyJpeg());
    const { host, port } = await startHost();
    hosts.push(host);
    const { app } = await FakeApp.connect(port, { capabilities: ["tree", "media"], device: { platform: "ios", osVersion: "26.1", model: "x", name: "p", id: "install-1" } }, (req) =>
      req.method === "tree" ? { ok: true, result: { screen: { width: 400, height: 800 }, elements: [] } } : { ok: true, result: { needsPerson: true } },
    );
    apps.push(app);
    const answer = textOf(await new TaplineTools(host, { connect: { url: "", name: "Dev PC" } }).media({ add: [file], confirm: true }));
    expect(answer).toContain("A person must allow photo access on the phone first");
    expect(answer.split("\n").at(-1)).toBe("Note: needs a person: allow photo access on the phone (an OS alert Tapline can't tap).");
  });

  it("an app that stopped answering twice: the person is asked to close it and open it again", async () => {
    const { host, port } = await startHost({ requestTimeoutMs: 60 });
    hosts.push(host);
    const { app } = await FakeApp.connect(port, {}, (req) => (req.method === "press" ? "ignore" : { ok: true, result: { screen: { width: 430, height: 932 }, elements: [SAVE] } }));
    apps.push(app);
    const client = new FakeDialogClient();
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, policy: NO_POLICY, dialogs: new Dialogs(client, { ttlMs: 2000 }), personWaitMs: 2000, personPollMs: 5, personDoneGraceMs: 60 });
    // the first time is today's answer: try once more
    const first = await tools.tap({ target: { id: "save" }, look: false });
    expect(textOf(first)).toMatch(/^Error not_answering: /);
    expect(client.shown).toHaveLength(0);
    const call = tools.tap({ target: { id: "save" }, look: false });
    await client.shownCount(1);
    expect(client.shown[0]?.message).toBe("Needs a person: close Demo and open it again.");
    // the app comes back as a new session: the call goes on and the press now works
    const again = await FakeApp.connect(port, {}, handlerFor({ alerts: [] }));
    apps.push(again.app);
    expect((await call).isError).not.toBe(true);
    expect(client.shown[0]?.signal.aborted).toBe(true);
  });
});
