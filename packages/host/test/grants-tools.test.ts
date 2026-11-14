import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { ActionLogEntry } from "../src/actionlog.js";
import { AuditLog } from "../src/auditlog.js";
import { Confirmations } from "../src/confirm.js";
import { ControlQueue } from "../src/control.js";
import { Dialogs, OK_ALLOW, OK_FIELD, type ElicitAnswer, type ElicitClient, type ElicitSchema } from "../src/elicit.js";
import { GrantBook } from "../src/grants.js";
import { saveMap, type MapFile } from "../src/mapfile.js";
import { MapRegistry } from "../src/places.js";
import type { PolicyFile } from "../src/policy.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

// AGENT-TOOLS 1.14 §19.3: a grant through the tools. A covered touch goes through without a dialog, with the exact note.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];
const registries: MapRegistry[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  await Promise.all(registries.splice(0).map((r) => r.flushAll().catch(() => undefined)));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
const frame = { x: 20, y: 100, width: 300, height: 44 };
const POST = { ref: "e1", type: "Pressable", role: "button", testID: "post", text: "Post", frame, actions: ["press"] };
const PAY = { ref: "e2", type: "Pressable", role: "button", testID: "pay", text: "Pay now", frame, actions: ["press"] };
const HOME = { ref: "e6", type: "Text", role: "text", text: "Home", frame, actions: [] };
const APP_ID = "com.example.demo";
const TODAY = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const inDays = (days: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

class FakeDialogClient implements ElicitClient {
  shown = 0;
  canShowForm(): boolean {
    return true;
  }
  elicit(): Promise<ElicitAnswer> {
    this.shown++;
    return Promise.resolve({ action: "accept", content: { [OK_FIELD]: OK_ALLOW } });
  }
}

type ToolsExtra = Partial<ConstructorParameters<typeof TaplineTools>[1]>;

interface Rig {
  tools: TaplineTools;
  app: FakeApp;
  dialog: FakeDialogClient;
  state: { screen: "welcome" | "home"; failPress: boolean; pressError: string | null; treeDown: boolean; treeDownAfterPress: boolean; handlerThrew: boolean };
  policyPath: string;
  logDir: string;
  auditDir: string;
  put(grants: unknown[]): void;
  makeTools(grants: GrantBook | undefined, policy: PolicyFile, dialog?: boolean, extra?: ToolsExtra): TaplineTools;
  registry: MapRegistry;
  scriptsDir: string;
}

async function setup(grants: unknown[] | null): Promise<Rig> {
  const { host, port } = await startHost();
  hosts.push(host);
  const root = mkdtempSync(join(tmpdir(), "tapline-grants-tools-"));
  dirs.push(root);
  const state = { screen: "welcome" as "welcome" | "home", failPress: false, pressError: null as string | null, treeDown: false, treeDownAfterPress: false, handlerThrew: false };
  const handler = (req: IncomingRequest): Reply => {
    switch (req.method) {
      case "tree":
        if (state.treeDown) return { ok: false, error: { code: "internal", message: "the read failed" } };
        return { ok: true, result: { screen: { width: 430, height: 932 }, elements: state.screen === "welcome" ? [POST, PAY] : [HOME], route: { names: [state.screen] }, place: { route: [state.screen] } } };
      case "place":
        return { ok: true, result: { route: [state.screen], seenAt: Date.now() } };
      case "press": {
        if (state.failPress) return { ok: false, error: { code: "not_actionable", message: "disabled" } };
        const dry = (req.params as { dryRun?: unknown }).dryRun === true;
        if (state.pressError !== null && !dry) return { ok: false, error: { code: state.pressError, message: "the press failed" } };
        const target = (req.params as { target?: { testID?: string } }).target;
        if (target?.testID === "post") state.screen = "home";
        if (state.treeDownAfterPress && !dry) state.treeDown = true;
        return { ok: true, result: { element: target?.testID === "pay" ? PAY : POST, settledMs: 10, ...(state.handlerThrew ? { handler: { kind: "own", threw: "boom" } } : {}) } };
      }
      default:
        return { ok: true, result: {} };
    }
  };
  const { app } = await FakeApp.connect(port, { capabilities: ["tree", "press", "logs", "dryRun", "place"] }, handler);
  apps.push(app);
  const policyPath = join(root, "policy.json");
  const put = (list: unknown[]): void => writeFileSync(policyPath, JSON.stringify({ version: 2, confirm: ["Post", "Pay"], block: [], grants: list }));
  if (grants !== null) put(grants);
  const logDir = join(root, "log");
  const auditDir = join(root, "audit");
  const audit = new AuditLog(auditDir);
  audit.open();
  const registry = new MapRegistry({ mapsDir: join(root, "maps"), save: (dir: string, map: MapFile, opts) => saveMap(dir, map, opts) });
  registries.push(registry);
  const scriptsDir = join(root, "scripts");
  const dialog = new FakeDialogClient();
  const makeTools = (book: GrantBook | undefined, policy: PolicyFile, withDialog = true, extra: ToolsExtra = {}): TaplineTools =>
    new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, confirmations: new Confirmations(), logDir, maps: registry, scriptsDir, reloadWaitMs: 50, ...(withDialog ? { dialogs: new Dialogs(dialog, {}) } : {}), policy, ...(book !== undefined ? { grants: book } : {}), ...extra });
  const book = grants === null ? undefined : new GrantBook({ policyPath, audit });
  const tools = makeTools(book, { version: 2, confirm: ["Post", "Pay"], block: [] });
  return { tools, app, dialog, state, policyPath, logDir, auditDir, put, makeTools, registry, scriptsDir };
}

const GRANT = { name: "posting", app: APP_ID, words: ["Post"], perDay: 2, until: inDays(5), draftsOnly: false };
const presses = (app: FakeApp): number => app.requests.filter((r) => r.method === "press").length;
const logLines = (dir: string): ActionLogEntry[] =>
  readdirSync(dir)
    .flatMap((name) => readFileSync(join(dir, name), "utf8").split("\n").filter((l) => l !== ""))
    .map((l) => JSON.parse(l) as ActionLogEntry);
const auditLines = (dir: string): Array<Record<string, unknown>> =>
  readdirSync(dir)
    .flatMap((name) => readFileSync(join(dir, name), "utf8").split("\n").filter((l) => l !== ""))
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("a grant stands in for a person's OK (§19.3)", () => {
  it("a covered tap goes through with no dialog, the exact note, the audit line and the action log's grant field", async () => {
    const r = await setup([GRANT]);
    const answer = await r.tools.tap({ target: { id: "post" }, look: false });
    expect(answer.isError).not.toBe(true);
    expect(textOf(answer)).toBe('Tapped e1 button "Post" id=post.\nNote: allowed by grant "posting" (1 of 2 today).');
    expect(r.dialog.shown).toBe(0);
    expect(presses(r.app)).toBe(1);
    expect(auditLines(r.auditDir)).toEqual([{ t: expect.any(String), tool: "tapline", kind: "grant", app: APP_ID, name: "posting", detail: 'tap "Post" (1 of 2 today)' }]);
    const entry = logLines(r.logDir).find((e) => e.tool === "tap");
    expect(entry).toMatchObject({ ok: true, grant: "posting" });
    expect(entry?.confirmed).toBeUndefined();
  });

  it("past the day's limit it asks a person as today, with the note before the person's OK note", async () => {
    const r = await setup([{ ...GRANT, perDay: 1 }]);
    await r.tools.tap({ target: { id: "post" }, look: false });
    r.state.screen = "welcome";
    const second = await r.tools.tap({ target: { id: "post" }, look: false });
    expect(r.dialog.shown).toBe(1);
    expect(textOf(second)).toBe(
      'Tapped e1 button "Post" id=post.\nNote: grant "posting" doesn\'t cover this (1 of 1 today); asking a person.\nNote: allowed by a person (in chat).',
    );
    expect(logLines(r.logDir).filter((e) => e.tool === "tap").map((e) => [e.grant, e.confirmed])).toEqual([["posting", undefined], [undefined, true]]);
  });

  it("without a dialog, an uncovered touch answers needs_confirmation with the note", async () => {
    const r = await setup([{ ...GRANT, revoked: TODAY() }]);
    const plain = r.makeTools(new GrantBook({ policyPath: r.policyPath, audit: new AuditLog(r.auditDir) }), { version: 2, confirm: ["Post"], block: [] }, false);
    const answer = await plain.tap({ target: { id: "post" }, look: false });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error not_allowed: needs_confirmation: button "Post" needs a person's OK \(policy word "Post"\)\./);
    expect(textOf(answer)).toContain(`Note: grant "posting" doesn't cover this (it was revoked on ${TODAY()}); asking a person.`);
    expect(presses(r.app)).toBe(0);
  });

  it("a payment is never covered, even when a hand-made grant names another word on it", async () => {
    const r = await setup([{ ...GRANT, words: ["Post", "Pay"] }, { ...GRANT, name: "ok", words: ["Post"] }]);
    const answer = await r.tools.tap({ target: { id: "pay" }, look: false });
    expect(r.dialog.shown).toBe(1);
    // the grant that names "Pay" is refused at load, and the first answer says so; the other grant is for "Post"
    expect(textOf(answer)).toBe('Tapped e2 button "Pay now" id=pay.\nNote: allowed by a person (in chat).\nNote: grant "posting" is refused: payments and purchases are never grantable ("Pay").');
    expect(auditLines(r.auditDir)).toEqual([]);
  });

  it("a dry run says it is allowed by the grant and counts nothing", async () => {
    const r = await setup([{ ...GRANT, perDay: 1 }]);
    const dry = await r.tools.tap({ target: { id: "post" }, dry_run: true });
    expect(textOf(dry)).toContain('It is allowed by grant "posting" (1 of 1 today).');
    expect(textOf(dry)).not.toContain("needs a person's OK");
    const real = await r.tools.tap({ target: { id: "post" }, look: false });
    expect(textOf(real)).toContain('(1 of 1 today)');
  });

  it("there is no lock file at all, before, during or after the touch (§19.4, 1.14.1)", async () => {
    const r = await setup([GRANT]);
    const lock = `${r.policyPath}.state.lock`;
    const heldDuringPress: boolean[] = [];
    const original = r.app.handler;
    r.app.handler = (req) => {
      if (req.method === "press") heldDuringPress.push(existsSync(lock));
      return original(req);
    };
    const answer = await r.tools.tap({ target: { id: "post" }, look: false });
    expect(textOf(answer)).toContain('allowed by grant "posting"');
    expect(heldDuringPress.length).toBeGreaterThan(0); // the dry run and the touch
    expect(heldDuringPress.every((held) => !held)).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  it("a touch the app refused gives its use back", async () => {
    const r = await setup([{ ...GRANT, perDay: 1 }]);
    r.state.failPress = true;
    const failed = await r.tools.tap({ target: { id: "post" }, look: false });
    expect(failed.isError).toBe(true);
    r.state.failPress = false;
    const again = await r.tools.tap({ target: { id: "post" }, look: false });
    expect(textOf(again)).toContain('allowed by grant "posting" (1 of 1 today)');
  });

  it("a revoke by hand is seen at the very next touch", async () => {
    const r = await setup([GRANT]);
    expect(textOf(await r.tools.tap({ target: { id: "post" }, look: false }))).toContain("allowed by grant");
    r.put([{ ...GRANT, revoked: TODAY() }]);
    r.state.screen = "welcome";
    const next = await r.tools.tap({ target: { id: "post" }, look: false });
    expect(textOf(next)).toContain("was revoked on");
    expect(r.dialog.shown).toBe(1);
  });

  it("a failed audit line means the grant doesn't cover the touch, and a person is asked through the dialog as usual (A2 loose end)", async () => {
    const r = await setup([GRANT]);
    // the audit folder is replaced by a file, so no line can be written
    rmSync(r.auditDir, { recursive: true, force: true });
    writeFileSync(r.auditDir, "a file");
    const answer = await r.tools.tap({ target: { id: "post" }, look: false });
    expect(answer.isError).not.toBe(true);
    expect(textOf(answer)).toContain("Note: allowed by a person (in chat).");
    expect(textOf(answer)).not.toContain("allowed by grant");
    expect(r.dialog.shown).toBeGreaterThanOrEqual(1);
    expect(presses(r.app)).toBe(1);
  });

  it("a failed audit line with no dialog answers needs_confirmation, the live-view answer", async () => {
    const r = await setup([GRANT]);
    rmSync(r.auditDir, { recursive: true, force: true });
    writeFileSync(r.auditDir, "a file");
    const tools = r.makeTools(new GrantBook({ policyPath: r.policyPath, audit: new AuditLog(r.auditDir) }), { version: 2, confirm: ["Post", "Pay"], block: [] }, false);
    const answer = await tools.tap({ target: { id: "post" }, look: false });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error not_allowed: needs_confirmation: button "Post" needs a person's OK/);
    expect(presses(r.app)).toBe(0);
  });

  it("the first answer says which grant is refused, once", async () => {
    const r = await setup([GRANT, { ...GRANT, name: "shop", words: ["Pay"] }]);
    const first = await r.tools.look({ screenshot: false });
    expect(textOf(first)).toContain('Note: grant "shop" is refused: payments and purchases are never grantable ("Pay").');
    expect(textOf(await r.tools.look({ screenshot: false }))).not.toContain("is refused");
  });

  it("the route condition: covered only while that saved route runs (replay and drive)", async () => {
    const r = await setup(null);
    // Record the route with a policy that asks nothing, then run it under a policy that asks and a grant for the route.
    const recorder = r.makeTools(undefined, { version: 1, confirm: [], block: [] });
    await recorder.look({ screenshot: false });
    await recorder.record({ start: true, route: "post_update" });
    await recorder.tap({ target: { id: "post" }, look: false });
    await recorder.record({ stop: true });
    r.put([{ ...GRANT, route: "post_update", perDay: 5 }]);
    const audit = new AuditLog(r.auditDir);
    const tools = r.makeTools(new GrantBook({ policyPath: r.policyPath, audit }), { version: 2, confirm: ["Post"], block: [] });
    // outside the route, the same grant doesn't apply and asks (no note: a route mismatch isn't noted)
    r.state.screen = "welcome";
    const outside = await tools.tap({ target: { id: "post" }, look: false });
    expect(textOf(outside)).toBe('Tapped e1 button "Post" id=post.\nNote: allowed by a person (in chat).');
    // inside, by drive
    r.state.screen = "welcome";
    const driven = await tools.drive({ route: "post_update" });
    expect(driven.isError).not.toBe(true);
    expect(textOf(driven)).toContain('allowed by grant "posting" (1 of 5 today).');
    // and by replay
    r.state.screen = "welcome";
    const shownBefore = r.dialog.shown;
    const replayed = await tools.replay({ name: "post_update" });
    expect(textOf(replayed)).toContain('allowed by grant "posting" (2 of 5 today)');
    expect(r.dialog.shown).toBe(shownBefore);
  });
});

// -- A2: pause, revoke-all, the dialog that creates a grant, the report line (AGENT-TOOLS 1.14 §19.5 to §19.7, §23)

/** A host dialog that answers each question as a script says, and keeps what it was asked. */
class ScriptedClient implements ElicitClient {
  asked: Array<{ message: string; schema: ElicitSchema }> = [];
  constructor(private readonly answer: (message: string, schema: ElicitSchema) => ElicitAnswer) {}
  canShowForm(): boolean {
    return true;
  }
  elicit(message: string, schema: ElicitSchema): Promise<ElicitAnswer> {
    this.asked.push({ message, schema });
    return Promise.resolve(this.answer(message, schema));
  }
}

const accept = (answer: string): ElicitAnswer => ({ action: "accept", content: { answer } });
const policyOf = (): PolicyFile => ({ version: 2, confirm: ["Post", "Pay"], block: [] });
const policyGrants = (path: string): Array<Record<string, unknown>> => (JSON.parse(readFileSync(path, "utf8")) as { grants: Array<Record<string, unknown>> }).grants;
const isGrantQuestion = (schema: ElicitSchema): boolean => schema.properties["answer"]?.enum.includes("Allow") === true;

describe("pause is not the kill switch (§19.5)", () => {
  it("a paused agent touches nothing and counts nothing; resuming restores the grant's cover", async () => {
    const r = await setup([GRANT]);
    const control = new ControlQueue();
    const tools = r.makeTools(new GrantBook({ policyPath: r.policyPath, audit: new AuditLog(r.auditDir) }), policyOf(), false, { control });
    control.setPaused(true);
    const paused = await tools.tap({ target: { id: "post" }, look: false });
    expect(paused.isError).toBe(true);
    expect(textOf(paused)).toMatch(/^Error paused:/);
    expect(presses(r.app)).toBe(0);
    expect(readdirSync(r.auditDir)).toEqual([]);
    control.setPaused(false);
    const resumed = await tools.tap({ target: { id: "post" }, look: false });
    expect(textOf(resumed)).toBe('Tapped e1 button "Post" id=post.\nNote: allowed by grant "posting" (1 of 2 today).');
    expect(auditLines(r.auditDir)).toHaveLength(1);
  });

  it("with a dialog, a pause before the touch gives the use back", async () => {
    const r = await setup([GRANT]);
    const control = new ControlQueue();
    const tools = r.makeTools(new GrantBook({ policyPath: r.policyPath, audit: new AuditLog(r.auditDir) }), policyOf(), true, { control });
    control.setPaused(true);
    expect(textOf(await tools.tap({ target: { id: "post" }, look: false }))).toMatch(/^Error paused:/);
    control.setPaused(false);
    // the use taken before the dialog stage was given back: both of the grant's two uses are still there
    expect(textOf(await tools.tap({ target: { id: "post" }, look: false }))).toContain("(1 of 2 today)");
    r.state.screen = "welcome";
    expect(textOf(await tools.tap({ target: { id: "post" }, look: false }))).toContain("(2 of 2 today)");
  });
});

describe("revoke-all stops a covered touch at the next move (§19.5)", () => {
  it("a second host instance sharing the policy file revokes; the first stops, asking a person", async () => {
    const r = await setup([GRANT]);
    expect(textOf(await r.tools.tap({ target: { id: "post" }, look: false }))).toContain("allowed by grant");
    // another host (the tool's other process, here a second GrantBook) revokes everything
    const other = new GrantBook({ policyPath: r.policyPath, audit: new AuditLog(r.auditDir) });
    expect(await other.revokeAll()).toEqual({ revoked: ["posting"], already: [] });
    r.state.screen = "welcome";
    const next = await r.tools.tap({ target: { id: "post" }, look: false });
    expect(textOf(next)).toContain(`Note: grant "posting" doesn't cover this (it was revoked on ${TODAY()}); asking a person.`);
    expect(r.dialog.shown).toBe(1);
    expect(policyGrants(r.policyPath)[0]?.["revoked"]).toBe(TODAY());
    expect(auditLines(r.auditDir).filter((l) => l["kind"] === "revoke")).toEqual([expect.objectContaining({ name: "posting", detail: "grants --revoke-all" })]);
  });

  it("with no dialog the touch after a revoke-all answers needs_confirmation", async () => {
    const r = await setup([GRANT]);
    const tools = r.makeTools(new GrantBook({ policyPath: r.policyPath, audit: new AuditLog(r.auditDir) }), policyOf(), false);
    expect(textOf(await tools.tap({ target: { id: "post" }, look: false }))).toContain("allowed by grant");
    await new GrantBook({ policyPath: r.policyPath, audit: null }).revokeAll();
    r.state.screen = "welcome";
    const next = await tools.tap({ target: { id: "post" }, look: false });
    expect(next.isError).toBe(true);
    expect(textOf(next)).toMatch(/needs_confirmation/);
  });
});

describe("a grant is made only by the person's answer (§19.6)", () => {
  const setupOffer = async (answer: (message: string, schema: ElicitSchema) => ElicitAnswer): Promise<{ r: Rig; client: ScriptedClient; tools: TaplineTools }> => {
    const r = await setup([]);
    const client = new ScriptedClient(answer);
    const audit = new AuditLog(r.auditDir);
    const tools = r.makeTools(new GrantBook({ policyPath: r.policyPath, audit }), policyOf(), true, { dialogs: new Dialogs(client, {}), audit });
    return { r, client, tools };
  };
  const person = (grant: string, drafts: string) => (message: string, schema: ElicitSchema): ElicitAnswer => {
    if (message.startsWith("Allow: ")) return accept(OK_ALLOW);
    if (isGrantQuestion(schema)) return accept(grant);
    return accept(drafts);
  };

  it("after Allow once, asks the grant with the exact text; Allow and the default No write the grant with drafts on", async () => {
    const { r, client, tools } = await setupOffer(person("Allow", "No"));
    const answer = await tools.tap({ target: { id: "post" }, look: false });
    expect(textOf(answer)).toContain("Note: allowed by a person (in chat).");
    const questions = client.asked.map((a) => a.message);
    expect(questions[0]).toBe('Allow: tap "Post" in Demo? (policy word "Post")');
    expect(questions[1]).toMatch(/^Allow tapping "Post" in Demo up to 3 times a day, until \d{1,2} [A-Z][a-z]{2} \(drafts shown to you first\)\?$/);
    expect(questions[2]).toBe("Send these without showing you each one first?");
    expect(client.asked[2]?.schema.properties["answer"]?.default).toBe("No");
    expect(client.asked[1]?.schema.properties["answer"]?.default).toBeUndefined();
    const grants = policyGrants(r.policyPath);
    expect(grants).toEqual([{ name: "demo_post", app: APP_ID, words: ["Post"], perDay: 3, until: inDays(7) }]);
    expect(grants[0]).not.toHaveProperty("draftsOnly");
    expect(auditLines(r.auditDir).map((l) => [l["kind"], l["name"], l["detail"]])).toEqual([
      ["approval", "Post", "grant created"],
      ["approval", "Post", "allowed by a person (in chat)"],
    ]);
  });

  it("Yes to the separate second question writes draftsOnly false, and that grant then covers", async () => {
    const { r, tools } = await setupOffer(person("Allow", "Yes"));
    await tools.tap({ target: { id: "post" }, look: false });
    expect(policyGrants(r.policyPath)[0]?.["draftsOnly"]).toBe(false);
    r.state.screen = "welcome";
    const next = await tools.tap({ target: { id: "post" }, look: false });
    expect(textOf(next)).toBe('Tapped e1 button "Post" id=post.\nNote: allowed by grant "demo_post" (1 of 3 today).');
  });

  it("Don't allow, a decline or a cancel writes nothing; the person isn't asked again in the session", async () => {
    const refusals: ElicitAnswer[] = [accept("Don't allow"), { action: "decline" }, { action: "cancel" }];
    for (const refuse of refusals) {
      const { r, client, tools } = await setupOffer((message) => (message.startsWith("Allow: ") ? accept(OK_ALLOW) : refuse));
      await tools.tap({ target: { id: "post" }, look: false });
      expect(policyGrants(r.policyPath)).toEqual([]);
      r.state.screen = "welcome";
      await tools.tap({ target: { id: "post" }, look: false });
      expect(client.asked.filter((a) => isGrantQuestion(a.schema))).toHaveLength(1);
    }
  });

  it("a person who declines the touch is not offered a grant, and the refusal is in the audit log", async () => {
    const { r, client, tools } = await setupOffer(() => accept("Don't allow"));
    const answer = await tools.tap({ target: { id: "post" }, look: false });
    expect(answer.isError).toBe(true);
    expect(client.asked).toHaveLength(1);
    expect(policyGrants(r.policyPath)).toEqual([]);
    expect(auditLines(r.auditDir)).toEqual([expect.objectContaining({ kind: "approval", name: "Post", detail: "declined" })]);
  });

  it("never offers a grant for a payment", async () => {
    const { r, client, tools } = await setupOffer(person("Allow", "No"));
    await tools.tap({ target: { id: "pay" }, look: false });
    expect(client.asked.map((a) => a.message)).toEqual(['Allow: tap "Pay now" in Demo? (policy word "Pay")']);
    expect(policyGrants(r.policyPath)).toEqual([]);
  });

  it("a grant is not made from an answer that isn't an accepted Allow", async () => {
    const { r, tools } = await setupOffer((message, schema) => (message.startsWith("Allow: ") ? accept(OK_ALLOW) : isGrantQuestion(schema) ? accept("Allow once") : accept("Yes")));
    await tools.tap({ target: { id: "post" }, look: false });
    expect(policyGrants(r.policyPath)).toEqual([]);
  });
});

describe("the report's Grants line and the action log (§19.7)", () => {
  it("session_report names the uses and the times a person was asked", async () => {
    const r = await setup([{ ...GRANT, perDay: 2 }]);
    for (let i = 0; i < 3; i++) {
      r.state.screen = "welcome";
      await r.tools.tap({ target: { id: "post" }, look: false });
    }
    const report = textOf(r.tools.sessionReport({}));
    expect(report).toContain("Grants: posting 2 uses (2 of 2 today); asked a person 1 time (limit reached).");
    expect(report.split("\n").findIndex((l) => l.startsWith("Grants:"))).toBeGreaterThan(0);
  });

  it("is left out when no grant was involved", async () => {
    const r = await setup([GRANT]);
    await r.tools.look({ screenshot: false });
    expect(textOf(r.tools.sessionReport({}))).not.toContain("Grants:");
  });
});

// -- R1 (PR 12 review): a reserved grant is checked again right before the touch, and a delivered touch keeps its use (§19.3, §19.4)

describe("a grant reserved before the wait for control is checked again before the touch", () => {
  /** A control queue whose wait for a person to be idle runs `during` once, deterministically, with an injected clock. */
  const waiting = (clock: { t: number }, during: () => void): ControlQueue => {
    let done = false;
    return new ControlQueue({
      idleMs: 1000,
      giveUpMs: 600_000,
      now: () => clock.t,
      sleep: () => {
        if (!done) {
          done = true;
          during();
        }
        clock.t += 1500;
        return Promise.resolve();
      },
    });
  };
  const usageToday = async (r: Rig, name: string): Promise<number> => {
    const { usage } = await new GrantBook({ policyPath: r.policyPath, audit: null }).listing();
    return usage.get(name)?.today ?? 0;
  };
  const at = (hour: number, minute: number): Date => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute, 0);
  };

  /** Taps Post while `during` happens in the wait for control. */
  const tapDuring = async (r: Rig, book: GrantBook, during: () => void): Promise<CallToolResult> => {
    const control = waiting({ t: Date.now() }, during);
    const tools = r.makeTools(book, policyOf(), true, { control });
    await control.runPerson(() => Promise.resolve());
    return tools.tap({ target: { id: "post" }, look: false });
  };
  const bookOf = (r: Rig, now?: () => Date): GrantBook => new GrantBook({ policyPath: r.policyPath, audit: new AuditLog(r.auditDir), ...(now !== undefined ? { now } : {}) });

  it("a revoke during the wait means no touch without a person, and the use is given back", async () => {
    const r = await setup([GRANT]);
    const answer = await tapDuring(r, bookOf(r), () => r.put([{ ...GRANT, revoked: TODAY() }]));
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/needs_confirmation/);
    expect(presses(r.app)).toBe(0);
    expect(await usageToday(r, "posting")).toBe(0);
  });

  it("a draftsOnly change during the wait gives the draft path, not a touch", async () => {
    const r = await setup([GRANT]);
    const answer = await tapDuring(r, bookOf(r), () => r.put([{ ...GRANT, draftsOnly: true }]));
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/a draft is waiting for a person/);
    expect(presses(r.app)).toBe(0);
    expect(await usageToday(r, "posting")).toBe(0);
  });

  it("crossing into quiet hours during the wait means no touch", async () => {
    const start = at(10, 0);
    const r = await setup([{ ...GRANT, quiet: { from: "10:30", to: "11:00" } }]);
    const grantClock = { t: start.getTime() };
    const answer = await tapDuring(r, bookOf(r, () => new Date(grantClock.t)), () => {
      grantClock.t = start.getTime() + 45 * 60_000;
    });
    expect(answer.isError).toBe(true);
    expect(presses(r.app)).toBe(0);
    expect(await usageToday(r, "posting")).toBe(0);
  });

  it("an `until` that ends during the wait means no touch", async () => {
    const start = at(23, 30);
    const r = await setup([{ ...GRANT, until: TODAY() }]);
    const grantClock = { t: start.getTime() };
    const answer = await tapDuring(r, bookOf(r, () => new Date(grantClock.t)), () => {
      grantClock.t = start.getTime() + 60 * 60_000;
    });
    expect(answer.isError).toBe(true);
    expect(presses(r.app)).toBe(0);
    expect(await usageToday(r, "posting")).toBe(0);
  });

  it("a grant that still covers goes through with its one use", async () => {
    const r = await setup([{ ...GRANT, perDay: 1 }]);
    const answer = await tapDuring(r, bookOf(r), () => undefined);
    expect(textOf(answer)).toBe('Tapped e1 button "Post" id=post.\nNote: allowed by grant "posting" (1 of 1 today).');
    expect(await usageToday(r, "posting")).toBe(1);
  });
});

describe("a use is given back only when the touch surely wasn't made", () => {
  const nextTap = async (r: Rig): Promise<string> => {
    r.state.screen = "welcome";
    return textOf(await r.tools.tap({ target: { id: "post" }, look: false }));
  };

  it("a delivered touch followed by a failed screen read keeps the count", async () => {
    const r = await setup([{ ...GRANT, perDay: 1 }]);
    r.state.treeDownAfterPress = true;
    const first = await r.tools.tap({ target: { id: "post" } });
    expect(presses(r.app)).toBe(1);
    expect(first.isError).toBe(true);
    r.state.treeDown = false;
    r.state.treeDownAfterPress = false;
    expect(await nextTap(r)).toContain(`grant "posting" doesn't cover this (1 of 1 today)`);
    expect(r.dialog.shown).toBe(1);
  });

  it("a handler that sends and then throws keeps the count (a step of run fails)", async () => {
    const r = await setup([{ ...GRANT, perDay: 1 }]);
    r.state.handlerThrew = true;
    const first = await r.tools.run({ steps: [{ tool: "tap", target: { id: "post" } }] });
    expect(first.isError).toBe(true);
    expect(presses(r.app)).toBe(1);
    r.state.handlerThrew = false;
    expect(await nextTap(r)).toContain(`doesn't cover this (1 of 1 today)`);
  });

  it("an app error after dispatch (internal) keeps the count", async () => {
    const r = await setup([{ ...GRANT, perDay: 1 }]);
    r.state.pressError = "internal";
    expect((await r.tools.tap({ target: { id: "post" }, look: false })).isError).toBe(true);
    r.state.pressError = null;
    expect(await nextTap(r)).toContain(`doesn't cover this (1 of 1 today)`);
  });

  it("not_found before the touch gives the use back", async () => {
    const r = await setup([{ ...GRANT, perDay: 1 }]);
    r.state.pressError = "not_found";
    expect((await r.tools.tap({ target: { id: "post" }, look: false })).isError).toBe(true);
    r.state.pressError = null;
    expect(await nextTap(r)).toContain('allowed by grant "posting" (1 of 1 today)');
  });
});
