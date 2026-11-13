import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { ActionLogEntry } from "../src/actionlog.js";
import { AuditLog } from "../src/auditlog.js";
import { Confirmations } from "../src/confirm.js";
import { Dialogs, OK_ALLOW, OK_FIELD, type ElicitAnswer, type ElicitClient } from "../src/elicit.js";
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

interface Rig {
  tools: TaplineTools;
  app: FakeApp;
  dialog: FakeDialogClient;
  state: { screen: "welcome" | "home"; failPress: boolean };
  policyPath: string;
  logDir: string;
  auditDir: string;
  put(grants: unknown[]): void;
  makeTools(grants: GrantBook | undefined, policy: PolicyFile, dialog?: boolean): TaplineTools;
  registry: MapRegistry;
  scriptsDir: string;
}

async function setup(grants: unknown[] | null): Promise<Rig> {
  const { host, port } = await startHost();
  hosts.push(host);
  const root = mkdtempSync(join(tmpdir(), "tapline-grants-tools-"));
  dirs.push(root);
  const state = { screen: "welcome" as "welcome" | "home", failPress: false };
  const handler = (req: IncomingRequest): Reply => {
    switch (req.method) {
      case "tree":
        return { ok: true, result: { screen: { width: 430, height: 932 }, elements: state.screen === "welcome" ? [POST, PAY] : [HOME], route: { names: [state.screen] }, place: { route: [state.screen] } } };
      case "place":
        return { ok: true, result: { route: [state.screen], seenAt: Date.now() } };
      case "press": {
        if (state.failPress) return { ok: false, error: { code: "not_actionable", message: "disabled" } };
        const target = (req.params as { target?: { testID?: string } }).target;
        if (target?.testID === "post") state.screen = "home";
        return { ok: true, result: { element: target?.testID === "pay" ? PAY : POST, settledMs: 10 } };
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
  const makeTools = (book: GrantBook | undefined, policy: PolicyFile, withDialog = true): TaplineTools =>
    new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, confirmations: new Confirmations(), logDir, maps: registry, scriptsDir, reloadWaitMs: 50, ...(withDialog ? { dialogs: new Dialogs(dialog, {}) } : {}), policy, ...(book !== undefined ? { grants: book } : {}) });
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

  it("a failed audit line means the grant doesn't cover the touch", async () => {
    const r = await setup([GRANT]);
    // the audit folder is replaced by a file, so no line can be written
    rmSync(r.auditDir, { recursive: true, force: true });
    writeFileSync(r.auditDir, "a file");
    const answer = await r.tools.tap({ target: { id: "post" }, look: false });
    // the touch asks as without the grant (here the live-view answer: the dialog's turn had passed when the line failed)
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
