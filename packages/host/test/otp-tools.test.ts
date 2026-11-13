import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { AuditEntry, AuditSink } from "../src/auditlog.js";
import { createOtpService } from "../src/otpclient.js";
import { substituteVariables } from "../src/routes.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FAKE_CODE, FAKE_TOKEN, startFakeTapwright, tapwrightHome, type FakeBehavior, type FakeDaemon } from "./fake-tapwright.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

// AGENT-TOOLS 1.14 §20.4: `${otp.<app>}` typed through type_text, run and routes, end to end against a fake Tapwright daemon.

const APP = "com.example.demo";
const CODE_FIELD = { ref: "e7", type: "TextInput", role: "textfield", testID: "code", label: "Code", text: "", value: "", frame: { x: 24, y: 400, width: 354, height: 48 }, actions: ["press", "type"] };
const SCREEN = { width: 402, height: 874, scale: 3 };

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
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  await Promise.all(daemons.splice(0).map((d) => d.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : `<${c.type}>`)).join("\n");

async function setup(behavior: Partial<FakeBehavior> = {}, daemonUp = true) {
  const daemon = await startFakeTapwright(behavior);
  if (daemonUp) daemons.push(daemon);
  else await daemon.close();
  const home = tapwrightHome({ port: daemon.port, token: FAKE_TOKEN });
  dirs.push(home.dir);
  const otp = createOtpService({ home: home.dir, settleMs: 5, timeoutMs: 3000 });
  // The host scrubs with the service's own redaction, as the runtime wires it.
  const { host, port } = await startHost({ redact: otp.codes.redact });
  hosts.push(host);
  const typed: Array<Record<string, unknown>> = [];
  let showCode = false;
  const handler = (req: IncomingRequest): Reply => {
    switch (req.method) {
      case "tree":
        return { ok: true, result: { screen: SCREEN, elements: [{ ...CODE_FIELD, value: showCode ? `last code ${FAKE_CODE}` : "" }] } };
      case "type": {
        const params = req.params as Record<string, unknown>;
        typed.push(params);
        const value = String(params["text"]);
        return { ok: true, result: { element: { ...CODE_FIELD, value }, value, settledMs: 40 } };
      }
      default:
        return { ok: true, result: {} };
    }
  };
  const { app } = await FakeApp.connect(port, { capabilities: ["tree", "press", "type", "logs", "dryRun"] }, handler);
  apps.push(app);
  const audit: AuditEntry[] = [];
  const sink: AuditSink = {
    write(entry) {
      audit.push({ t: "x", tool: "tapline", ...entry });
      return true;
    },
  };
  const logDir = tmp();
  const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, otp, audit: sink, logDir });
  return { tools, daemon, typed, audit, logDir, showCodeInTree: () => (showCode = true) };
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
    const { tools, daemon, typed } = await setup();
    const answer = await tools.typeText({ target: { id: "code" }, text: `\${otp.${APP}}`, dry_run: true });
    expect(answer.isError).not.toBe(true);
    expect(daemon.connections).toBe(0);
    // the app was asked about the field only: empty text, marked as a dry run
    expect(typed.every((p) => p["dryRun"] === true && p["text"] === "")).toBe(true);
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
