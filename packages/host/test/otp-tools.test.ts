import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { AuditEntry, AuditSink } from "../src/auditlog.js";
import { ControlQueue, PhoneLease } from "../src/control.js";
import { callTool } from "../src/dispatch.js";
import { DONE, DONE_FIELD, Dialogs, type ElicitAnswer, type ElicitClient, type ElicitSchema } from "../src/elicit.js";
import { createOtpService } from "../src/otpclient.js";
import { MapRegistry } from "../src/places.js";
import { substituteVariables } from "../src/routes.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools, type ToolsOptions } from "../src/tools.js";
import { FAKE_CODE, FAKE_TOKEN, startFakeTapwright, tapwrightHome, type FakeBehavior, type FakeDaemon } from "./fake-tapwright.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

// AGENT-TOOLS 1.14 §20.4: `${otp.<app>}` typed through type_text, run and routes, end to end against a fake Tapwright daemon.

const APP = "com.example.demo";
const CODE_FIELD = { ref: "e7", type: "TextInput", role: "textfield", testID: "code", label: "Code", text: "", value: "", frame: { x: 24, y: 400, width: 354, height: 48 }, actions: ["press", "type"] };
const SCREEN = { width: 402, height: 874, scale: 3 };

/** Runs right after a code was fetched (a test makes something happen then). */
let afterFetch: (() => Promise<void>) | undefined;
const dirs: string[] = [];
const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const daemons: FakeDaemon[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "tapline-otp-tools-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  afterFetch = undefined;
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  await Promise.all(daemons.splice(0).map((d) => d.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : `<${c.type}>`)).join("\n");

/** What the fake app answers to a `type`: `dry` refuses the check, `real` refuses only the real type (after the code was fetched). */
interface TypeRefusal {
  dry?: { code: string; message: string };
  real?: { code: string; message: string };
  /** Runs while the dry run is being answered (to change the app the host has selected, say). */
  duringDry?: () => void;
  /** Runs while the real type is being answered (to send the app to the background, say). */
  duringReal?: () => void;
  /** A dialog covers the field until its "Not now" button is pressed. */
  dialog?: boolean;
}

const DIALOG = [
  { ref: "e20", type: "Text", role: "text", text: "Rate this app", frame: { x: 24, y: 100, width: 354, height: 30 }, actions: [] },
  { ref: "e21", type: "Pressable", role: "button", testID: "not-now", label: "Not now", text: "Not now", frame: { x: 24, y: 140, width: 354, height: 48 }, actions: ["press"] },
];

const CAPABILITIES = ["tree", "press", "type", "logs", "dryRun"];

async function setup(behavior: Partial<FakeBehavior> = {}, daemonUp = true, refusal: TypeRefusal = {}, capabilities: string[] = CAPABILITIES, extra: Partial<ToolsOptions> = {}) {
  const daemon = await startFakeTapwright(behavior);
  if (daemonUp) daemons.push(daemon);
  else await daemon.close();
  const home = tapwrightHome({ port: daemon.port, token: FAKE_TOKEN });
  dirs.push(home.dir);
  const otp = createOtpService({ home: home.dir, settleMs: 5, timeoutMs: 3000 });
  // The host scrubs with the service's own redaction, as the runtime wires it.
  const { host, port } = await startHost({ redact: otp.codes.redact });
  hosts.push(host);
  let theApp: FakeApp | undefined;
  const typed: Array<Record<string, unknown>> = [];
  const checked: Array<Record<string, unknown>> = [];
  let showCode = false;
  const handler = (req: IncomingRequest): Reply => {
    switch (req.method) {
      case "tree":
        return {
          ok: true,
          result: { screen: SCREEN, elements: [{ ...CODE_FIELD, value: showCode ? `last code ${FAKE_CODE}` : "" }, ...(refusal.dialog === true ? DIALOG : [])] },
        };
      case "press": {
        const params = req.params as Record<string, unknown>;
        if (params["dryRun"] !== true) refusal.dialog = false;
        return { ok: true, result: { element: DIALOG[1], settledMs: 10 } };
      }
      case "type": {
        const params = req.params as Record<string, unknown>;
        if (refusal.dialog === true) return { ok: false, error: { code: "not_actionable", message: "covered: a dialog is over the field" } };
        (params["dryRun"] === true ? checked : typed).push(params);
        if (params["dryRun"] === true) refusal.duringDry?.();
        else refusal.duringReal?.();
        const refused = params["dryRun"] === true ? refusal.dry : refusal.real;
        if (refused !== undefined) return { ok: false, error: refused };
        const value = String(params["text"]);
        return { ok: true, result: { element: { ...CODE_FIELD, value }, value, settledMs: 40 } };
      }
      default:
        return { ok: true, result: {} };
    }
  };
  const { app } = await FakeApp.connect(port, { capabilities }, handler);
  apps.push(app);
  theApp = app;
  const audit: AuditEntry[] = [];
  const sink: AuditSink = {
    write(entry) {
      audit.push({ t: "x", tool: "tapline", ...entry });
      return true;
    },
  };
  const logDir = tmp();
  const tools = new TaplineTools(host, {
    connect: { url: "", name: "Dev PC" },
    otp: {
      codes: otp.codes,
      fetch: async (name: string) => {
        const got = await otp.fetch(name);
        await afterFetch?.();
        return got;
      },
    },
    audit: sink,
    logDir,
    ...extra,
  });
  return { tools, app: () => theApp, daemon, typed, checked, audit, logDir, host, port, showCodeInTree: () => (showCode = true) };
}

function everythingIn(dir: string): string {
  return readdirSync(dir)
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .join("\n");
}

describe("type_text with ${otp.<app>}", () => {
  it("types the code, shows only the placeholder, and audits the app and the source", async () => {
    const { tools, daemon, typed, audit, logDir } = await setup();
    const answer = await tools.typeText({ target: { id: "code" }, text: `\${otp.${APP}}` });
    const said = textOf(answer);
    expect(answer.isError).not.toBe(true);
    expect(typed).toHaveLength(1);
    expect(typed[0]).toMatchObject({ text: FAKE_CODE });
    expect(said).toContain("Typed into");
    expect(said).not.toContain(FAKE_CODE);
    expect(said).toContain("<one-time code>");
    // proof, then the code, on one connection
    expect(daemon.connections).toBe(1);
    expect(daemon.requests.map((r) => r.url)).toEqual(["/api/prove", "/otp"]);
    expect(JSON.parse(daemon.requests[1]?.body ?? "{}")).toEqual({ app: APP });
    // the audit line
    expect(audit).toEqual([{ t: "x", tool: "tapline", kind: "otp", app: APP, detail: "from com.apple.MobileSMS" }]);
    expect(JSON.stringify(audit)).not.toContain(FAKE_CODE);
    // the action log
    expect(everythingIn(logDir)).not.toContain(FAKE_CODE);
    expect(everythingIn(logDir)).not.toContain(FAKE_TOKEN);
  });

  it("the code stays scrubbed for the rest of the session, also in what the app shows later", async () => {
    const { tools, showCodeInTree } = await setup();
    await tools.typeText({ target: { id: "code" }, text: `\${otp.${APP}}` });
    showCodeInTree();
    const looked = textOf(await tools.look({ screenshot: false }));
    expect(looked).toContain("last code <one-time code>");
    expect(looked).not.toContain(FAKE_CODE);
  });

  it("an audit line names Tapwright when the daemon gave no source", async () => {
    const { tools, audit } = await setup({ otp: { status: 200, body: { code: FAKE_CODE, expires: Date.now() + 60_000 } } });
    await tools.typeText({ target: { id: "code" }, text: `\${otp.${APP}}` });
    expect(audit[0]?.detail).toBe("from Tapwright");
  });

  it("another app's id is refused before anything is asked of the daemon", async () => {
    const { tools, daemon, typed, audit } = await setup();
    const answer = await tools.typeText({ target: { id: "code" }, text: "${otp.com.other.app}" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error bad_params: \$\{otp\.com\.other\.app\} names another app than the connected one/);
    expect(textOf(answer)).toContain(`\${otp.${APP}}`);
    expect(daemon.connections).toBe(0);
    expect(typed).toHaveLength(0);
    expect(audit).toHaveLength(0);
  });

  it("joined text and an account name are refused, and ask nothing", async () => {
    const { tools, daemon, typed } = await setup();
    const joined = await tools.typeText({ target: { id: "code" }, text: `code \${otp.${APP}}` });
    expect(textOf(joined)).toBe("Error bad_params: a one-time code is the whole text of a step, not part of one.");
    const named = await tools.typeText({ target: { id: "code" }, text: `\${otp.${APP}}`, account: "tester2" });
    expect(textOf(named)).toMatch(/^Error bad_params: a one-time code takes no account/);
    expect(daemon.connections).toBe(0);
    expect(typed).toHaveLength(0);
  });

  it("404 fails the step with no code typed and no audit line", async () => {
    const { tools, typed, audit } = await setup({ otp: { status: 404 } });
    const answer = await tools.typeText({ target: { id: "code" }, text: `\${otp.${APP}}` });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error not_found: no one-time code for com\.example\.demo/);
    expect(typed).toHaveLength(0);
    expect(audit).toHaveLength(0);
  });

  it("a wrong proof fails the step, and the token is never sent", async () => {
    const { tools, daemon, typed } = await setup({ proofText: "f".repeat(64) });
    const answer = await tools.typeText({ target: { id: "code" }, text: `\${otp.${APP}}` });
    expect(textOf(answer)).toMatch(/^Error unsupported: Whatever answers on Tapwright's daemon port didn't prove/);
    expect(typed).toHaveLength(0);
    expect(daemon.everything()).not.toContain(FAKE_TOKEN);
  });

  it("a daemon that is down fails the step", async () => {
    const { tools, typed } = await setup({}, false);
    const answer = await tools.typeText({ target: { id: "code" }, text: `\${otp.${APP}}` });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error unsupported: Tapwright's daemon didn't answer/);
    expect(typed).toHaveLength(0);
  });

  it("a dry run checks the field and asks for nothing", async () => {
    const { tools, daemon, typed, checked } = await setup();
    const answer = await tools.typeText({ target: { id: "code" }, text: `\${otp.${APP}}`, dry_run: true });
    expect(answer.isError).not.toBe(true);
    expect(daemon.connections).toBe(0);
    // the app was asked about the field only: empty text, marked as a dry run
    expect(typed).toHaveLength(0);
    expect(checked.length).toBeGreaterThan(0);
    expect(checked.every((p) => p["text"] === "")).toBe(true);
    expect(textOf(answer)).not.toContain(FAKE_CODE);
  });

  it("no app connected is not_connected, and nothing is asked", async () => {
    const otp = createOtpService({ home: tmp(), settleMs: 0 });
    const { host } = await startHost({ redact: otp.codes.redact });
    hosts.push(host);
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, otp });
    const answer = await tools.typeText({ target: { id: "code" }, text: `\${otp.${APP}}` });
    expect(textOf(answer)).toMatch(/^Error not_connected/);
  });
});

describe("the code is asked for only right before typing (AGENT-TOOLS 1.16.2 §18.11)", () => {
  const text = `\${otp.${APP}}`;
  const realTypes = (typed: Array<Record<string, unknown>>) => typed;
  const alert = { code: "not_actionable", message: "behind_alert: an alert is showing" };

  it("a type refused behind_alert asks the daemon for nothing", async () => {
    const { tools, daemon, typed, audit } = await setup({}, true, { dry: alert });
    const answer = await tools.typeText({ target: { id: "code" }, text });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toContain("behind_alert");
    expect(daemon.requests).toHaveLength(0);
    expect(daemon.connections).toBe(0);
    expect(realTypes(typed)).toHaveLength(0);
    expect(audit).toHaveLength(0);
  });

  it("an app that can't check a step ahead (no dryRun) is refused, and the daemon is asked nothing", async () => {
    const { tools, daemon, typed } = await setup({}, true, {}, CAPABILITIES.filter((c) => c !== "dryRun"));
    const answer = await tools.typeText({ target: { id: "code" }, text });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error unsupported: /);
    expect(daemon.requests).toHaveLength(0);
    expect(daemon.connections).toBe(0);
    expect(realTypes(typed)).toHaveLength(0);
  });

  it("another app selected during the check: no code is asked for, nothing is typed", async () => {
    const refusal: TypeRefusal = {};
    const { tools, daemon, typed, host, port } = await setup({}, true, refusal);
    const { app: other } = await FakeApp.connect(port, { capabilities: CAPABILITIES, app: { name: "Other", id: "com.example.other", version: "1.0.0", build: "1" } }, () => ({ ok: true, result: {} }));
    apps.push(other);
    const first = host.sessions().find((s) => s.app.id === APP);
    const second = host.sessions().find((s) => s.app.id === "com.example.other");
    if (first === undefined || second === undefined) throw new Error("two apps should be connected");
    host.select(first.id);
    refusal.duringDry = () => {
      host.select(second.id);
    };
    const answer = await tools.typeText({ target: { id: "code" }, text });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error not_connected: the app changed/);
    expect(daemon.requests).toHaveLength(0);
    expect(daemon.connections).toBe(0);
    expect(realTypes(typed)).toHaveLength(0);
  });

  it("a target that is not found asks the daemon for nothing", async () => {
    const { tools, daemon, typed } = await setup({}, true, { dry: { code: "not_found", message: "nothing on screen matches that target." } });
    const answer = await tools.typeText({ target: { id: "code" }, text });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toContain("not_found");
    expect(daemon.requests).toHaveLength(0);
    expect(realTypes(typed)).toHaveLength(0);
  });

  it("when every check passes there is exactly one /otp request, then the type; no answer holds the digits", async () => {
    const { tools, daemon, typed, checked, logDir } = await setup();
    const answer = await tools.typeText({ target: { id: "code" }, text });
    expect(answer.isError).not.toBe(true);
    expect(daemon.requests.map((r) => r.url)).toEqual(["/api/prove", "/otp"]);
    expect(realTypes(typed)).toHaveLength(1);
    expect(realTypes(typed)[0]).toMatchObject({ text: FAKE_CODE });
    expect(checked.length).toBeGreaterThan(0);
    expect(checked.every((p) => p["text"] === "")).toBe(true);
    expect(textOf(answer)).not.toContain(FAKE_CODE);
    expect(everythingIn(logDir)).not.toContain(FAKE_CODE);
  });

  it("a real type that fails after the fetch drops the code: one /otp request, no retry, no digits", async () => {
    const { tools, daemon, typed } = await setup({}, true, { real: { code: "not_actionable", message: `behind_alert: an alert came up (${FAKE_CODE})` } });
    const answer = await tools.typeText({ target: { id: "code" }, text });
    expect(answer.isError).toBe(true);
    expect(daemon.requests.filter((r) => r.url === "/otp")).toHaveLength(1);
    expect(realTypes(typed)).toHaveLength(1);
    expect(textOf(answer)).not.toContain(FAKE_CODE);
  });

  it("run: a refused step asks for nothing; a passing step fetches once", async () => {
    const refused = await setup({}, true, { dry: alert });
    const bad = await refused.tools.run({ steps: [{ tool: "type_text", target: { id: "code" }, text }], look: false });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain("behind_alert");
    expect(refused.daemon.requests).toHaveLength(0);
    const ok = await setup();
    const done = await ok.tools.run({ steps: [{ tool: "type_text", target: { id: "code" }, text }], look: false });
    expect(done.isError).not.toBe(true);
    expect(ok.daemon.requests.filter((r) => r.url === "/otp")).toHaveLength(1);
    expect(textOf(done)).not.toContain(FAKE_CODE);
  });

  it("run: a real type that fails after the fetch is not retried", async () => {
    const { tools, daemon, typed } = await setup({}, true, { real: { code: "internal", message: "the field went away" } });
    const answer = await tools.run({ steps: [{ tool: "type_text", target: { id: "code" }, text }], look: false });
    expect(answer.isError).toBe(true);
    expect(daemon.requests.filter((r) => r.url === "/otp")).toHaveLength(1);
    expect(realTypes(typed)).toHaveLength(1);
    expect(textOf(answer)).not.toContain(FAKE_CODE);
  });
});

/** A dialog client that answers Done at once, after running `before` (the person brings the app back). */
class DoneClient implements ElicitClient {
  shown = 0;
  constructor(private readonly before: () => void) {}
  canShowForm(): boolean {
    return true;
  }
  elicit(_message: string, _schema: ElicitSchema, _signal: AbortSignal): Promise<ElicitAnswer> {
    this.shown += 1;
    this.before();
    return Promise.resolve({ action: "accept", content: { [DONE_FIELD]: DONE } });
  }
}

describe("the code is asked for only after the host's own gates (PR T186C findings)", () => {
  const text = `\${otp.${APP}}`;
  const fetches = (daemon: FakeDaemon): number => daemon.requests.filter((r) => r.url === "/otp").length;

  it("a lease that runs out during the last dry run: no code is asked for (PR 15 Codex cycle 3)", async () => {
    let now = 1000;
    const lease = new PhoneLease({ now: () => now });
    const acquired = lease.acquire("review", 1000, false);
    if (!acquired.ok) throw new Error("no lease");
    const refusal: TypeRefusal = {};
    const { tools, daemon, typed, checked } = await setup({}, true, refusal, CAPABILITIES, { lease });
    refusal.duringDry = () => {
      if (checked.length === 2) now = 2001;
    };
    const answer = await tools.withCall(undefined, () => callTool(tools, "type_text", { target: { id: "code" }, text }), acquired.credential);
    expect(textOf(answer)).toContain("lease_lost");
    expect(checked).toHaveLength(2);
    expect(typed).toHaveLength(0);
    expect(fetches(daemon)).toBe(0);
  });

  for (const change of ["person", "background", "disconnect"] as const) {
    it(`${change} during the last dry run: no code is asked for, nothing is typed`, async () => {
      const control = new ControlQueue();
      const refusal: TypeRefusal = {};
      const { tools, daemon, typed, checked, app } = await setup({}, true, refusal, CAPABILITIES, { control });
      refusal.duringDry = () => {
        if (checked.length !== 2) return;
        if (change === "person") void control.runPerson(async () => undefined);
        if (change === "background") app()?.send({ type: "event", event: "appState", data: { state: "background" } });
        if (change === "disconnect") app()?.ws.close();
      };
      const answer = await callTool(tools, "type_text", { target: { id: "code" }, text });
      expect(answer.isError).toBe(true);
      expect(typed).toHaveLength(0);
      expect(fetches(daemon)).toBe(0);
    });
  }

  it("a person's input during the fetch drops the code: one /otp request, nothing typed, no digits", async () => {
    const control = new ControlQueue();
    const { tools, daemon, typed, logDir } = await setup({}, true, {}, CAPABILITIES, { control });
    let person: Promise<void> | undefined;
    afterFetch = async () => {
      afterFetch = undefined;
      person = control.runPerson(async () => undefined);
    };
    const answer = await callTool(tools, "type_text", { target: { id: "code" }, text });
    await person;
    expect(answer.isError).toBe(true);
    expect(fetches(daemon)).toBe(1);
    expect(typed).toHaveLength(0);
    expect(textOf(answer)).not.toContain(FAKE_CODE);
    expect(everythingIn(logDir)).not.toContain(FAKE_CODE);
  });

  it("a paused queue refuses the type before any code is asked for", async () => {
    const control = new ControlQueue();
    control.setPaused(true);
    const { tools, daemon, typed, audit } = await setup({}, true, {}, CAPABILITIES, { control });
    const answer = await tools.typeText({ target: { id: "code" }, text });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/paused/);
    expect(fetches(daemon)).toBe(0);
    expect(typed).toHaveLength(0);
    expect(audit).toHaveLength(0);
  });

  it("an app sent to the background right after the fetch: the code is dropped, never asked for again, even once the person is done", async () => {
    let back: () => void = () => undefined;
    const client = new DoneClient(() => back());
    const { tools, daemon, typed, app, host, audit } = await setup({}, true, {}, CAPABILITIES, {
      dialogs: new Dialogs(client, { ttlMs: 2000 }),
      personWaitMs: 2000,
      personPollMs: 5,
      personDoneGraceMs: 60,
    });
    back = () => app()?.send({ type: "event", event: "appState", data: { state: "active" } });
    afterFetch = async () => {
      afterFetch = undefined;
      app()?.send({ type: "event", event: "appState", data: { state: "background" } });
      for (let i = 0; i < 200 && host.current()?.appState?.state !== "background"; i++) await new Promise((r) => setTimeout(r, 5));
    };
    const answer = await callTool(tools, "type_text", { target: { id: "code" }, text });
    expect(answer.isError).toBe(true);
    expect(fetches(daemon)).toBe(1);
    expect(typed).toHaveLength(0);
    // No dialog: nothing could be run again, so a person is not asked to bring the app back for it.
    expect(client.shown).toBe(0);
    expect(textOf(answer)).toContain("not run again");
    expect(textOf(answer)).not.toContain(FAKE_CODE);
    expect(audit).toHaveLength(0);
  });

  it("the same in run: a batch is not resumed at the step whose code was dropped", async () => {
    let back: () => void = () => undefined;
    const client = new DoneClient(() => back());
    const { tools, daemon, typed, app, host, audit } = await setup({}, true, {}, CAPABILITIES, {
      dialogs: new Dialogs(client, { ttlMs: 2000 }),
      personWaitMs: 2000,
      personPollMs: 5,
      personDoneGraceMs: 60,
    });
    back = () => app()?.send({ type: "event", event: "appState", data: { state: "active" } });
    afterFetch = async () => {
      afterFetch = undefined;
      app()?.send({ type: "event", event: "appState", data: { state: "background" } });
      for (let i = 0; i < 200 && host.current()?.appState?.state !== "background"; i++) await new Promise((r) => setTimeout(r, 5));
    };
    const answer = await callTool(tools, "run", { steps: [{ tool: "type_text", target: { id: "code" }, text }], look: false });
    expect(answer.isError).toBe(true);
    expect(fetches(daemon)).toBe(1);
    expect(typed).toHaveLength(0);
    expect(client.shown).toBe(0);
    expect(textOf(answer)).toContain("not run again");
    expect(textOf(answer)).not.toContain(FAKE_CODE);
    expect(audit).toHaveLength(0);
  });
});

describe("the checks are made again inside the queue turn, right before the fetch (PR 15 Codex cycle 2)", () => {
  const text = `\${otp.${APP}}`;
  const fetches = (daemon: FakeDaemon): number => daemon.requests.filter((r) => r.url === "/otp").length;
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  /** Holds the agent queue, starts the call, and returns once its early dry run is done and the real type waits in the queue. */
  async function queued(extra: { control: ControlQueue }, refusal: TypeRefusal = {}) {
    const s = await setup({}, true, refusal, CAPABILITIES, extra);
    let release: () => void = () => undefined;
    const held = extra.control.runAgent(() => new Promise<void>((resolve) => (release = resolve)));
    const call = s.tools.typeText({ target: { id: "code" }, text });
    for (let i = 0; i < 200 && s.checked.length < 1; i++) await wait(5);
    await wait(30);
    expect(s.checked.length).toBeGreaterThan(0);
    const finish = async (): Promise<CallToolResult> => {
      release();
      await held;
      return call;
    };
    return { ...s, finish };
  }

  it("paused while it waited: no code is asked for, nothing is typed", async () => {
    const control = new ControlQueue();
    const s = await queued({ control });
    control.setPaused(true);
    const answer = await s.finish();
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/paused/);
    expect(fetches(s.daemon)).toBe(0);
    expect(s.typed).toHaveLength(0);
    expect(s.audit).toHaveLength(0);
  });

  it("another app selected while it waited: no code is asked for, nothing reaches the first app", async () => {
    const control = new ControlQueue();
    const s = await queued({ control });
    const { app: other } = await FakeApp.connect(s.port, { capabilities: CAPABILITIES, app: { name: "Other", id: "com.example.other", version: "1.0.0", build: "1" } }, () => ({ ok: true, result: {} }));
    apps.push(other);
    const second = s.host.sessions().find((x) => x.app.id === "com.example.other");
    if (second === undefined) throw new Error("the second app should be connected");
    s.host.select(second.id);
    const answer = await s.finish();
    expect(answer.isError).toBe(true);
    expect(fetches(s.daemon)).toBe(0);
    expect(s.typed).toHaveLength(0);
  });

  it("the field got covered while it waited: the fresh dry run refuses, no code is asked for", async () => {
    const control = new ControlQueue();
    const refusal: TypeRefusal = {};
    const s = await queued({ control }, refusal);
    refusal.dry = { code: "not_actionable", message: "covered: a sheet is over the field" };
    const answer = await s.finish();
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toContain("covered");
    expect(fetches(s.daemon)).toBe(0);
    expect(s.typed).toHaveLength(0);
  });

  it("paused while the fetch waits: the code is dropped, nothing is typed, no digits in the answer", async () => {
    const control = new ControlQueue();
    const s = await setup({}, true, {}, CAPABILITIES, { control });
    afterFetch = async () => {
      afterFetch = undefined;
      control.setPaused(true);
    };
    const answer = await s.tools.typeText({ target: { id: "code" }, text });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/paused/);
    expect(fetches(s.daemon)).toBe(1);
    expect(s.typed).toHaveLength(0);
    expect(s.audit).toHaveLength(0);
    expect(textOf(answer)).not.toContain(FAKE_CODE);
  });

  it("a reflex that closes a dialog over the field gets its turn before the check is made again, then one fetch and one type", async () => {
    const mapsDir = tmp();
    mkdirSync(join(mapsDir, APP), { recursive: true });
    const map = {
      format: "agent-tools-map",
      version: 1,
      app: APP,
      places: {},
      roads: [],
      routes: {},
      reflexes: [{ name: "rate", when: { text: "Rate this app" }, do: { tool: "tap", target: { text: "Not now" } }, max: 2 }],
    };
    writeFileSync(join(mapsDir, APP, "map.json"), JSON.stringify(map));
    const registry = new MapRegistry({ mapsDir });
    const s = await setup({}, true, { dialog: true }, CAPABILITIES, { maps: registry });
    const answer = await callTool(s.tools, "type_text", { target: { id: "code" }, text });
    await registry.flushAll();
    expect(textOf(answer)).not.toContain("Error");
    expect(fetches(s.daemon)).toBe(1);
    expect(s.typed).toHaveLength(1);
    expect(textOf(answer)).not.toContain(FAKE_CODE);
  });

  it("the app went to the background as its first dry run was answered: no code is asked for", async () => {
    const refusal: TypeRefusal = {};
    const s = await setup({}, true, refusal);
    refusal.duringDry = () => {
      refusal.duringDry = undefined;
      s.app()?.send({ type: "event", event: "appState", data: { state: "background" } });
    };
    const answer = await s.tools.typeText({ target: { id: "code" }, text });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/in_background/);
    expect(fetches(s.daemon)).toBe(0);
    expect(s.typed).toHaveLength(0);
    expect(s.audit).toHaveLength(0);
  });
});

describe("in run, drive and routes", () => {
  it("run types the code as a step, and checks the app of every step before any step runs", async () => {
    const { tools, daemon, typed } = await setup();
    const wrong = await tools.run({
      steps: [
        { tool: "type_text", target: { id: "code" }, text: "plain" },
        { tool: "type_text", target: { id: "code" }, text: "${otp.com.other.app}" },
      ],
    });
    expect(textOf(wrong)).toMatch(/^Error bad_params: step 2 .*names another app than the connected one/);
    expect(typed).toHaveLength(0);
    expect(daemon.connections).toBe(0);
    const ok = await tools.run({ steps: [{ tool: "type_text", target: { id: "code" }, text: `\${otp.${APP}}` }], look: false });
    expect(ok.isError).not.toBe(true);
    expect(typed).toHaveLength(1);
    expect(typed[0]).toMatchObject({ text: FAKE_CODE });
    expect(textOf(ok)).not.toContain(FAKE_CODE);
  });

  it("a route keeps `${otp.<app>}` whole as its step's text, with dots in the app id", () => {
    const step = { tool: "type_text", target: { id: "code" }, text: `\${otp.${APP}}` };
    const filled = substituteVariables(step, {}, undefined, []);
    expect(filled).toEqual({ ok: true, step });
    const joined = substituteVariables({ ...step, text: `x \${otp.${APP}}` }, {}, undefined, []);
    expect(joined.ok).toBe(false);
    // a value for a variable may not carry one either
    const smuggled = substituteVariables({ tool: "type_text", text: "${v}" }, { v: `\${otp.${APP}}` }, undefined, ["v"]);
    expect(smuggled.ok).toBe(false);
  });
});
