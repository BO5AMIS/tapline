import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { vaultStore } from "../src/accounts.js";
import { AuditLog } from "../src/auditlog.js";
import { Confirmations } from "../src/confirm.js";
import { Dialogs, cutDraft, draftCaption, draftChoices, type ElicitAnswer, type ElicitClient, type ElicitSchema } from "../src/elicit.js";
import { GrantBook } from "../src/grants.js";
import { saveMap, type MapFile } from "../src/mapfile.js";
import { MapRegistry } from "../src/places.js";
import type { PolicyFile } from "../src/policy.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

// AGENT-TOOLS 1.14 §21.3: drafts only. A touch on a covered word under a draftsOnly grant, or in a route with "draftsOnly": true,
// stops before the touch and shows its draft to a person.

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
const SEND = { ref: "e2", type: "Pressable", role: "button", testID: "send", text: "Send", frame, actions: ["press"] };
const DELETE = { ref: "e3", type: "Pressable", role: "button", testID: "del", text: "Delete trip", frame, actions: ["press"] };
const APP_ID = "com.example.demo";
const NOTE = "Thanks and regards,\nJane Tester\nFake Co. Ltd., 1 Example Road";
const inDays = (days: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

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
const choose = (answer: string): ElicitAnswer => ({ action: "accept", content: { answer } });

interface Rig {
  app: FakeApp;
  state: { reply: string; sent: string[]; secure: boolean; renumbered: boolean };
  policyPath: string;
  auditDir: string;
  root: string;
  registry: MapRegistry;
  confirmations: Confirmations;
  make(options: { client?: ElicitClient; grants?: unknown[]; extra?: Partial<ConstructorParameters<typeof TaplineTools>[1]> }): TaplineTools;
}

const POLICY: PolicyFile = { version: 2, confirm: ["Send", "Delete"], block: [] };

async function setup(options: { vault?: boolean } = {}): Promise<Rig> {
  const store = options.vault === true ? vaultStore({ version: 2, vault: { reply_sig: { kind: "note", text: NOTE } } }) : null;
  const { host, port } = await startHost(store !== null ? { redact: store.redact } : {});
  hosts.push(host);
  const root = mkdtempSync(join(tmpdir(), "tapline-drafts-"));
  dirs.push(root);
  const state = { reply: "", sent: [] as string[], secure: false, renumbered: false };
  const reply = (): Record<string, unknown> => ({ ref: "e1", type: "TextInput", role: "textfield", testID: "reply", label: "Reply", text: "", value: state.reply, frame, actions: ["press", "type", "submit"] });
  const handler = (req: IncomingRequest): Reply => {
    const params = req.params as { target?: { testID?: string }; text?: string; dryRun?: boolean };
    switch (req.method) {
      case "tree":
        // After a full look refs restart: another input that holds text now has e1, and the reply field is e2.
        return { ok: true, result: { screen: { width: 430, height: 932 }, elements: state.renumbered ? [{ ...reply(), testID: "search", label: "Search", value: "pizza near me" }, { ...reply(), ref: "e2" }, SEND, DELETE] : [reply(), SEND, DELETE], route: { names: ["thread"] }, place: { route: ["thread"] } } };
      case "place":
        return { ok: true, result: { route: ["thread"], seenAt: Date.now() } };
      case "type": {
        if (params.dryRun === true) return { ok: true, result: { element: reply(), point: { x: 1, y: 1 } } };
        state.reply = params.text ?? "";
        return { ok: true, result: { element: reply(), value: state.reply, settledMs: 10 } };
      }
      case "press": {
        const id = params.target?.testID ?? "";
        if (params.dryRun !== true) state.sent.push(id);
        return { ok: true, result: { element: id === "del" ? DELETE : SEND, settledMs: 10 } };
      }
      default:
        return { ok: true, result: {} };
    }
  };
  const { app } = await FakeApp.connect(port, { capabilities: ["tree", "press", "type", "typeKind", "logs", "dryRun", "place"] }, handler);
  apps.push(app);
  const policyPath = join(root, "policy.json");
  const auditDir = join(root, "audit");
  const registry = new MapRegistry({ mapsDir: join(root, "maps"), save: (dir: string, map: MapFile, opts) => saveMap(dir, map, opts) });
  registries.push(registry);
  const confirmations = new Confirmations();
  const make: Rig["make"] = ({ client, grants, extra }) => {
    writeFileSync(policyPath, JSON.stringify({ ...POLICY, ...(grants !== undefined ? { grants } : {}) }));
    const audit = new AuditLog(auditDir);
    audit.open();
    return new TaplineTools(host, {
      connect: { url: "", name: "Dev PC" },
      confirmations,
      maps: registry,
      scriptsDir: join(root, "scripts"),
      reloadWaitMs: 50,
      policy: POLICY,
      audit,
      grants: new GrantBook({ policyPath, audit }),
      ...(store !== null ? { accounts: { store } } : {}),
      ...(client !== undefined ? { dialogs: new Dialogs(client, {}) } : {}),
      ...extra,
    });
  };
  return { app, state, policyPath, auditDir, root, registry, confirmations, make };
}

const auditLines = (dir: string): Array<Record<string, unknown>> =>
  readdirSync(dir).flatMap((name) =>
    readFileSync(join(dir, name), "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>),
  );
const GRANT = { name: "posting", app: APP_ID, words: ["Send"], perDay: 1, until: inDays(5) };
const APP_NAME_IN_CAPTION = "Demo";

/** The fake app's hello names the app; the dialog's caption says its name. */
async function appName(tools: TaplineTools): Promise<string> {
  const looked = textOf(await tools.look({ screenshot: false }));
  return /App: (.+?) \(/.exec(looked)?.[1] ?? APP_NAME_IN_CAPTION;
}

describe("a draftsOnly grant stops at the draft (§21.3, §19.3)", () => {
  it("shows the draft with the exact caption and the two choices (Don't send first, no default); Send touches with its Note and counts no use", async () => {
    const r = await setup();
    const client = new ScriptedClient(() => choose("Send"));
    const tools = r.make({ client, grants: [GRANT] });
    const name = await appName(tools);
    await tools.typeText({ target: { id: "reply" }, text: "Thanks, see you there!", look: false });
    const answer = await tools.tap({ target: { id: "send" }, look: false });
    expect(textOf(answer)).toBe('Tapped e2 button "Send" id=send.\nNote: sent by a person (in chat).');
    expect(client.asked).toHaveLength(1);
    expect(client.asked[0]?.message).toBe(`Send this in ${name}? "Thanks, see you there!"`);
    const field = client.asked[0]?.schema.properties["answer"];
    expect(field?.enum).toEqual(["Don't send", "Send"]);
    expect(field?.default).toBeUndefined();
    expect(client.asked[0]?.schema.required).toEqual(["answer"]);
    expect(r.state.sent).toEqual(["send"]);
    // not a use of the grant: no `grant` line, and the grant's one use a day is still whole
    expect(auditLines(r.auditDir).map((l) => [l["kind"], l["name"], l["detail"]])).toEqual([["approval", "Send", "draft sent"]]);
    const second = await tools.tap({ target: { id: "send" }, look: false });
    expect(textOf(second)).toBe('Tapped e2 button "Send" id=send.\nNote: sent by a person (in chat).');
    expect(client.asked).toHaveLength(2);
    expect(auditLines(r.auditDir).filter((l) => l["kind"] === "grant")).toEqual([]);
  });

  it("Don't send makes no touch and ends as the spec says", async () => {
    const r = await setup();
    const client = new ScriptedClient(() => choose("Don't send"));
    const tools = r.make({ client, grants: [GRANT] });
    await tools.typeText({ target: { id: "reply" }, text: "Hi", look: false });
    const answer = await tools.tap({ target: { id: "send" }, look: false });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toBe("Error not_allowed: needs_confirmation: the draft wasn't sent (They declined.). Ask your user what to do.");
    expect(r.state.sent).toEqual([]);
    expect(auditLines(r.auditDir).map((l) => [l["kind"], l["detail"]])).toEqual([["approval", "declined"]]);
  });

  it("a decline, a cancel and a form with no answer are all Don't send", async () => {
    for (const refusal of [{ action: "decline" }, { action: "cancel" }, { action: "accept", content: {} }] as ElicitAnswer[]) {
      const r = await setup();
      const tools = r.make({ client: new ScriptedClient(() => refusal), grants: [GRANT] });
      const answer = await tools.tap({ target: { id: "send" }, look: false });
      expect(textOf(answer)).toBe("Error not_allowed: needs_confirmation: the draft wasn't sent (They declined.). Ask your user what to do.");
      expect(r.state.sent).toEqual([]);
    }
  });

  it("the text is cut at 500 characters with (+N) and held to the OK: a longer draft is another question", async () => {
    const r = await setup();
    const client = new ScriptedClient(() => choose("Send"));
    const tools = r.make({ client, grants: [GRANT] });
    await tools.typeText({ target: { id: "reply" }, text: `${"a".repeat(499)}bcd${"e".repeat(98)}`, look: false });
    await tools.tap({ target: { id: "send" }, look: false });
    const caption = client.asked[0]?.message ?? "";
    expect(caption.endsWith(`"${"a".repeat(499)}b…(+100)"`)).toBe(true);
    expect(caption).not.toContain("cde");
  });

  it("control characters are stripped, line breaks read as spaces and a quote can't end the question", () => {
    expect(cutDraft("Line one\nLine\ttwo\u0007‮\"x")).toBe("Line one Line two'x");
    expect(draftCaption({ word: "post", app: 'In"sta\u0000gram', text: 'He said "hi"' })).toBe("Post this in In'stagram? \"He said 'hi'\"");
    expect(draftChoices("post")).toEqual({ send: "Post", dont: "Don't post" });
    expect(draftChoices("Send message")).toEqual({ send: "Send message", dont: "Don't send message" });
  });

  it("a vault value in the draft shows as its name, never its text", async () => {
    const r = await setup({ vault: true });
    const client = new ScriptedClient(() => choose("Send"));
    const tools = r.make({ client, grants: [GRANT] });
    await tools.typeText({ target: { id: "reply" }, text: "${vault.reply_sig.text}", look: false });
    const answer = await tools.tap({ target: { id: "send" }, look: false });
    const caption = client.asked[0]?.message ?? "";
    expect(caption).toMatch(/\? "<reply_sig's text>"$/);
    for (const piece of ["Jane Tester", "Fake Co", "Example Road"]) {
      expect(caption).not.toContain(piece);
      expect(textOf(answer)).not.toContain(piece);
    }
    expect(JSON.stringify(auditLines(r.auditDir))).not.toContain("Jane Tester");
  });

  it("the draft is the input last typed into, not another that holds text", async () => {
    const r = await setup();
    const client = new ScriptedClient(() => choose("Send"));
    const tools = r.make({ client, grants: [GRANT] });
    await tools.typeText({ target: { id: "reply" }, text: "first and only", look: false });
    await tools.tap({ target: { id: "send" }, look: false });
    expect(client.asked[0]?.message).toMatch(/\? "first and only"$/);
  });

  it("the draft follows the field by its id when refs were renumbered, never another input that took its ref (PR 12 CodeRabbit)", async () => {
    const r = await setup();
    const client = new ScriptedClient(() => choose("Send"));
    const tools = r.make({ client, grants: [GRANT] });
    await tools.typeText({ target: { id: "reply" }, text: "the real reply", look: false });
    r.state.renumbered = true;
    await tools.tap({ target: { id: "send" }, look: false });
    expect(client.asked[0]?.message).toMatch(/\? "the real reply"$/);
    expect(client.asked[0]?.message).not.toContain("pizza");
  });

  it("an empty field is an empty draft, still shown", async () => {
    const r = await setup();
    const client = new ScriptedClient(() => choose("Send"));
    const tools = r.make({ client, grants: [GRANT] });
    await tools.tap({ target: { id: "send" }, look: false });
    expect(client.asked[0]?.message).toMatch(/^Send this in .+\? ""$/);
  });

  it("a grant whose draftsOnly a person lifted (false) covers as before, with no draft", async () => {
    const r = await setup();
    const client = new ScriptedClient(() => choose("Send"));
    const tools = r.make({ client, grants: [{ ...GRANT, draftsOnly: false }] });
    const answer = await tools.tap({ target: { id: "send" }, look: false });
    expect(textOf(answer)).toBe('Tapped e2 button "Send" id=send.\nNote: allowed by grant "posting" (1 of 1 today).');
    expect(client.asked).toHaveLength(0);
  });

  it("another word is not a draft: a draftsOnly grant for Send leaves Delete to the ordinary OK", async () => {
    const r = await setup();
    const client = new ScriptedClient(() => ({ action: "accept", content: { answer: "Allow once" } }));
    const tools = r.make({ client, grants: [GRANT] });
    const answer = await tools.tap({ target: { id: "del" }, look: false });
    expect(textOf(answer)).toBe('Tapped e3 button "Delete trip" id=del.\nNote: allowed by a person (in chat).');
    expect(client.asked[0]?.message).toBe(`Allow: tap "Delete trip" in ${await appName(tools)}? (policy word "Delete")`);
  });

  it("a grant that ran out or ended asks as an ordinary touch, with its note, not a draft", async () => {
    const r = await setup();
    const client = new ScriptedClient(() => ({ action: "accept", content: { answer: "Allow once" } }));
    const tools = r.make({ client, grants: [{ ...GRANT, until: inDays(-1) }] });
    const answer = await tools.tap({ target: { id: "send" }, look: false });
    expect(textOf(answer)).toContain("doesn't cover this");
    expect(textOf(answer)).toContain("Note: allowed by a person (in chat).");
    expect(client.asked[0]?.message).toMatch(/^Allow: tap "Send"/);
  });

  it("a dry run says it stops at a draft and touches nothing", async () => {
    const r = await setup();
    const tools = r.make({ client: new ScriptedClient(() => choose("Send")), grants: [GRANT] });
    const dry = await tools.tap({ target: { id: "send" }, dry_run: true });
    expect(textOf(dry)).toContain('It stops at a draft first, and needs a person\'s OK (policy word "Send").');
    expect(r.state.sent).toEqual([]);
  });
});

describe("no dialog (§21.3, §11.3)", () => {
  it("answers needs_confirmation with the draft in the live view's request; the same call after the person's OK goes through", async () => {
    const r = await setup();
    const tools = r.make({ grants: [GRANT] });
    await tools.typeText({ target: { id: "reply" }, text: "Hello there", look: false });
    const first = await tools.tap({ target: { id: "send" }, look: false });
    expect(first.isError).toBe(true);
    expect(textOf(first)).toMatch(/^Error not_allowed: needs_confirmation: a draft is waiting for a person \(button "Send", policy word "Send"\)\. /);
    expect(r.state.sent).toEqual([]);
    const [request] = r.confirmations.open();
    expect(request?.caption).toMatch(/^Send this in .+\? "Hello there"$/);
    r.confirmations.answer(request?.id ?? "", true);
    const again = await tools.tap({ target: { id: "send" }, look: false });
    expect(textOf(again)).toBe('Tapped e2 button "Send" id=send.\nNote: sent by a person (in the live view).');
    expect(r.state.sent).toEqual(["send"]);
  });

  it("an OK given for one text doesn't send another", async () => {
    const r = await setup();
    const tools = r.make({ grants: [GRANT] });
    await tools.typeText({ target: { id: "reply" }, text: "Hello there", look: false });
    await tools.tap({ target: { id: "send" }, look: false });
    const [request] = r.confirmations.open();
    r.confirmations.answer(request?.id ?? "", true);
    await tools.typeText({ target: { id: "reply" }, text: "Something else entirely", look: false });
    const again = await tools.tap({ target: { id: "send" }, look: false });
    expect(again.isError).toBe(true);
    expect(r.state.sent).toEqual([]);
    expect(r.confirmations.open().map((q) => q.caption.split("? ")[1])).toContain('"Something else entirely"');
  });
});

describe("a route with draftsOnly: true (§18.5, §21.3)", () => {
  /** Records a route that taps Send under a policy that asks nothing, then marks the saved file draftsOnly. */
  async function recordRoute(r: Rig, mark: boolean): Promise<void> {
    const recorder = r.make({ extra: { policy: { version: 1, confirm: [], block: [] } } });
    await recorder.look({ screenshot: false });
    await recorder.record({ start: true, route: "reply_all" });
    await recorder.tap({ target: { id: "send" }, look: false });
    await recorder.record({ stop: true });
    r.state.sent.length = 0;
    if (!mark) return;
    const file = findRoute(r.root, "reply_all.json");
    const script = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...script, draftsOnly: true }, null, 2));
  }

  it("a drive of the route shows the draft for a word that reaches people, even with no grant", async () => {
    const r = await setup();
    await recordRoute(r, true);
    const client = new ScriptedClient(() => choose("Send"));
    const tools = r.make({ client });
    await tools.typeText({ target: { id: "reply" }, text: "Route draft", look: false });
    const driven = await tools.drive({ route: "reply_all" });
    expect(driven.isError).not.toBe(true);
    expect(client.asked).toHaveLength(1);
    expect(client.asked[0]?.message).toMatch(/^Send this in .+\? "Route draft"$/);
    expect(textOf(driven)).toContain("sent by a person (in chat).");
    expect(r.state.sent).toEqual(["send"]);
    expect(auditLines(r.auditDir).map((l) => l["detail"])).toContain("draft sent");
  });

  it("Don't send stops the drive with nothing touched", async () => {
    const r = await setup();
    await recordRoute(r, true);
    const tools = r.make({ client: new ScriptedClient(() => choose("Don't send")) });
    const driven = await tools.drive({ route: "reply_all" });
    expect(driven.isError).toBe(true);
    expect(textOf(driven)).toContain("the draft wasn't sent (They declined.)");
    expect(r.state.sent).toEqual([]);
  });

  it("a replay of the route stops at the draft too", async () => {
    const r = await setup();
    await recordRoute(r, true);
    const client = new ScriptedClient(() => choose("Send"));
    const tools = r.make({ client });
    const replayed = await tools.replay({ name: "reply_all" });
    expect(client.asked).toHaveLength(1);
    expect(client.asked[0]?.message).toMatch(/^Send this in /);
    expect(textOf(replayed)).toContain("sent by a person");
  });

  it("no dialog in a route: the draft waits in the live view and the drive stops there", async () => {
    const r = await setup();
    await recordRoute(r, true);
    const tools = r.make({});
    const driven = await tools.drive({ route: "reply_all" });
    expect(driven.isError).toBe(true);
    expect(textOf(driven)).toContain("a draft is waiting for a person");
    expect(r.state.sent).toEqual([]);
    expect(r.confirmations.open()).toHaveLength(1);
  });

  it("a route without the key, and a tap outside the route, are not drafts", async () => {
    const r = await setup();
    await recordRoute(r, false);
    const client = new ScriptedClient(() => ({ action: "accept", content: { answer: "Allow once" } }));
    const tools = r.make({ client });
    await tools.drive({ route: "reply_all" });
    expect(client.asked[0]?.message).toMatch(/^Allow: tap "Send"/);
    r.state.sent.length = 0;
    // the marked route's scope ends with the route: a tap afterwards is an ordinary OK
    const marked = await setup();
    await recordRoute(marked, true);
    const c2 = new ScriptedClient((message) => (message.startsWith("Allow: ") ? { action: "accept", content: { answer: "Allow once" } } : choose("Send")));
    const t2 = marked.make({ client: c2 });
    await t2.drive({ route: "reply_all" });
    await t2.tap({ target: { id: "send" }, look: false });
    expect(c2.asked[0]?.message).toMatch(/^Send this in /);
    expect(c2.asked[1]?.message).toMatch(/^Allow: tap "Send"/);
  });
});

function findRoute(root: string, name: string): string {
  const walk = (dir: string): string | null => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = walk(path);
        if (found !== null) return found;
      } else if (entry.name === name) return path;
    }
    return null;
  };
  const found = walk(root);
  if (found === null) throw new Error(`no route file ${name}`);
  return found;
}
