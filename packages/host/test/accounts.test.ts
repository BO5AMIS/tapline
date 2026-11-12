import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { accountStore, accountsFileSchema, loadAccounts, redactValue, substituteAccount, type AccountsFile, type AccountsLoad, type GitProbe } from "../src/accounts.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

// AGENT-TOOLS 1.13 §18.6: test accounts. Every value below is fake.

const USER = "tester2@example.com";
const PASS = "fake-pass-9137";
const APP = "com.example.demo";

const FILE: AccountsFile = {
  version: 1,
  accounts: {
    tester2: { username: USER, password: PASS, apps: [APP] },
    other: { username: "other@example.com", password: "fake-other-2468", apps: ["com.example.elsewhere"] },
    phone: { passcode: "135790" },
  },
};
const store = accountStore(FILE);

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "tapline-accounts-"));
  dirs.push(dir);
  return dir;
}
const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : `<${c.type}>`)).join("\n");

describe("the accounts file", () => {
  it("the schema accepts the spec's example file", () => {
    const parsed = accountsFileSchema.safeParse({
      version: 1,
      accounts: { tester2: { username: "tester2@example.com", password: "x", apps: ["com.example.wayfare"] }, phone: { passcode: "1234" } },
    });
    expect(parsed.success).toBe(true);
  });

  it("a file inside a git work tree that isn't ignored loads nothing and says why", async () => {
    const dir = tmp();
    const file = join(dir, "accounts.json");
    writeFileSync(file, JSON.stringify(FILE));
    const probe: GitProbe = { insideWorkTree: async () => true, ignored: async () => false };
    const loaded = await loadAccounts(file, probe);
    expect(loaded.store).toBeNull();
    expect("blocked" in loaded && loaded.blocked).toBe(`accounts file is inside the git repo at ${file} and not ignored; move it or add it to .gitignore.`);
  });

  it("an ignored file, or one outside any work tree, loads", async () => {
    const dir = tmp();
    const file = join(dir, "accounts.json");
    writeFileSync(file, JSON.stringify(FILE));
    const ignored = await loadAccounts(file, { insideWorkTree: async () => true, ignored: async () => true });
    expect(ignored.store?.names()).toEqual(["tester2", "other", "phone"]);
    const outside = await loadAccounts(file, { insideWorkTree: async () => false, ignored: async () => false });
    expect(outside.store?.names()).toEqual(["tester2", "other", "phone"]);
  });

  it("a blocked file is never read, and a bad file's error never quotes it", async () => {
    const dir = tmp();
    const file = join(dir, "accounts.json");
    writeFileSync(file, `{"version": 1, "accounts": {"a": {"password": "${PASS}" `);
    // not read when blocked: no error even though the text isn't JSON
    const blocked = await loadAccounts(file, { insideWorkTree: async () => true, ignored: async () => false });
    expect(blocked.store).toBeNull();
    const clear: GitProbe = { insideWorkTree: async () => false, ignored: async () => false };
    const error = await loadAccounts(file, clear).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain(PASS);
    writeFileSync(file, JSON.stringify({ version: 1, accounts: { a: { password: 5 } } }));
    const wrong = await loadAccounts(file, clear).catch((e: unknown) => e);
    expect(String((wrong as Error).message)).toContain("isn't the right format");
    expect(String((wrong as Error).message)).not.toContain("5");
  });

  it("the real git probe finds a work tree and honours .gitignore", async () => {
    const dir = tmp();
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, ".gitignore"), "secret/\n");
    mkdirSync(join(dir, "secret"));
    writeFileSync(join(dir, "accounts.json"), JSON.stringify(FILE));
    writeFileSync(join(dir, "secret", "accounts.json"), JSON.stringify(FILE));
    expect((await loadAccounts(join(dir, "accounts.json"))).store).toBeNull();
    expect((await loadAccounts(join(dir, "secret", "accounts.json"))).store).not.toBeNull();
  });

  it("names() lists names only", () => {
    expect(store.names()).toEqual(["tester2", "other", "phone"]);
    expect(JSON.stringify(store.names())).not.toContain(PASS);
  });
});

describe("resolving an account", () => {
  it("respects apps", () => {
    expect(store.resolve("tester2", "username", APP)).toEqual({ ok: true, value: USER });
    const wrong = store.resolve("tester2", "password", "com.example.other");
    expect(wrong.ok).toBe(false);
    expect(JSON.stringify(wrong)).not.toContain(PASS);
    // absent apps: any app
    expect(accountStore({ version: 1, accounts: { free: { username: "free@example.com" } } }).resolve("free", "username", "anything").ok).toBe(true);
  });

  it("an unknown account is not_found with the names that exist", () => {
    const result = store.resolve("nobody", "username", APP);
    expect(result).toEqual({ ok: false, code: "not_found", message: 'no account "nobody"; the accounts are tester2, other, phone.' });
  });

  it("the whole-text rule: a placeholder alone works, joined text is bad_params", () => {
    expect(substituteAccount("${account.username}", store, "tester2", APP)).toEqual({ ok: true, text: USER, field: "username" });
    expect(substituteAccount("${account.password}", store, "tester2", APP)).toEqual({ ok: true, text: PASS, field: "password" });
    expect(substituteAccount("hi ${account.password}", store, "tester2", APP)).toEqual({
      ok: false,
      code: "bad_params",
      message: "an account value is the whole text of a step, not part of one.",
    });
    expect(substituteAccount("${account.password}!", store, "tester2", APP).ok).toBe(false);
    expect(substituteAccount("plain", store, undefined, APP)).toEqual({ ok: true, text: "plain", field: null });
  });

  it("a passcode is never typed, and an unknown value is bad_params", () => {
    const passcode = substituteAccount("${account.passcode}", store, "phone", APP);
    expect(passcode.ok).toBe(false);
    expect(JSON.stringify(passcode)).not.toContain("135790");
    expect(substituteAccount("${account.nope}", store, "tester2", APP).ok).toBe(false);
    // the file with a passcode loads without complaint
    expect(accountsFileSchema.safeParse(FILE).success).toBe(true);
  });

  it("without a name, it says to name one", () => {
    const said = substituteAccount("${account.username}", store, undefined, APP);
    expect(said.ok).toBe(false);
    expect(!said.ok && said.message).toContain("name the account");
  });

  it("redact turns usernames into <name's username> and scrubs passwords", () => {
    expect(store.redact(`value=${JSON.stringify(USER)}`)).toBe(`value="<tester2's username>"`);
    expect(store.redact(`typed ${PASS} here`)).toBe("typed <tester2's password> here");
    expect(store.redact("nothing to hide")).toBe("nothing to hide");
    expect(redactValue({ a: [USER, 3, { b: PASS }], c: null }, store.redact)).toEqual({ a: ["<tester2's username>", 3, { b: "<tester2's password>" }], c: null });
  });
});

// ---- through TaplineTools, with a fake app ----------------------------------------------------------

const EMAIL = { ref: "e14", type: "TextInput", role: "textfield", testID: "email", label: "Email", text: "", value: "", frame: { x: 24, y: 400, width: 354, height: 48 }, actions: ["press", "type"] };
const SECRET = { ref: "e15", type: "TextInput", role: "textfield", testID: "password", label: "Password", text: "", value: "", frame: { x: 24, y: 460, width: 354, height: 48 }, actions: ["press", "type"] };
const SAVE = { ref: "e3", type: "Pressable", role: "button", testID: "save", text: "Save", frame: { x: 24, y: 610, width: 354, height: 48 }, actions: ["press"] };
const SCREEN = { width: 402, height: 874, scale: 3 };

interface Setup {
  capabilities?: string[];
  accounts?: AccountsLoad;
  options?: Partial<ConstructorParameters<typeof TaplineTools>[1]>;
  /** What the email field shows in the tree. */
  emailValue?: string;
}

async function setup(config: Setup = {}) {
  const active = config.accounts ?? { store };
  const { host, port } = await startHost(active.store !== null ? { redact: active.store.redact } : {});
  hosts.push(host);
  const typed: Array<Record<string, unknown>> = [];
  const handler = (req: IncomingRequest): Reply => {
    switch (req.method) {
      case "tree":
        return { ok: true, result: { screen: SCREEN, elements: [{ ...EMAIL, value: config.emailValue ?? "" }, SECRET, SAVE] } };
      case "type": {
        const params = req.params as Record<string, unknown>;
        typed.push(params);
        const target = params["target"] as { testID?: string } | undefined;
        const secure = target?.testID === "password";
        const kind = params["kind"];
        if (kind !== undefined && (kind === "secure") !== secure) {
          return { ok: false, error: { code: "bad_params", message: `${secure ? "e15" : "e14"} input "x" is a field of the other kind`, data: { secure } } };
        }
        const element = secure ? SECRET : EMAIL;
        const value = secure ? "•".repeat(String(params["text"]).length) : String(params["text"]);
        return { ok: true, result: { element: { ...element, value }, value, ...(secure ? { secure: true } : {}), settledMs: 40 } };
      }
      default:
        return { ok: true, result: {} };
    }
  };
  const hello = { capabilities: config.capabilities ?? ["tree", "press", "type", "typeKind", "logs", "dryRun"] };
  const { app } = await FakeApp.connect(port, hello, handler);
  apps.push(app);
  const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, accounts: active, ...config.options });
  return { tools, app, typed };
}

describe("typing an account", () => {
  it("the password goes into a secure field, and never into an answer", async () => {
    const { tools, app, typed } = await setup();
    const answer = textOf(await tools.typeText({ target: { id: "password" }, text: "${account.password}", account: "tester2" }));
    expect(answer).toContain("The value is hidden (secure field).");
    expect(answer).not.toContain(PASS);
    expect(typed).toHaveLength(1);
    expect(typed[0]).toMatchObject({ text: PASS, kind: "secure" });
    expect(JSON.stringify(app.requests.filter((r) => r.method !== "type"))).not.toContain(PASS);
  });

  it("the username goes into a plain field and reads <tester2's username>", async () => {
    const { tools, typed } = await setup();
    const answer = textOf(await tools.typeText({ target: { id: "email" }, text: "${account.username}", account: "tester2" }));
    expect(typed[0]).toMatchObject({ text: USER, kind: "plain" });
    expect(answer).toContain(`Value is now "<tester2's username>".`);
    expect(answer).not.toContain(USER);
  });

  it("a password into a text field is bad_params with the ref", async () => {
    const { tools } = await setup();
    const answer = await tools.typeText({ target: { id: "email" }, text: "${account.password}", account: "tester2" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toBe("Error bad_params: an account's password goes only into a password field; e14 is a text field.");
  });

  it("a username into a secure field is bad_params with the ref", async () => {
    const { tools } = await setup();
    const answer = await tools.typeText({ target: { id: "password" }, text: "${account.username}", account: "tester2" });
    expect(textOf(answer)).toBe("Error bad_params: an account's username goes only into a text field; e15 is a password field.");
  });

  it("joined text is bad_params and nothing reaches the app", async () => {
    const { tools, typed } = await setup();
    const answer = await tools.typeText({ target: { id: "password" }, text: "hi ${account.password}", account: "tester2" });
    expect(textOf(answer)).toBe("Error bad_params: an account value is the whole text of a step, not part of one.");
    expect(typed).toHaveLength(0);
  });

  it("an account for another app is refused, an unknown one is not_found, a passcode is bad_params", async () => {
    const { tools, typed } = await setup();
    const other = textOf(await tools.typeText({ target: { id: "email" }, text: "${account.username}", account: "other" }));
    expect(other).toMatch(/^Error bad_params: account "other" isn't for this app/);
    expect(other).not.toContain("other@example.com");
    const nobody = textOf(await tools.typeText({ target: { id: "email" }, text: "${account.username}", account: "nobody" }));
    expect(nobody).toBe('Error not_found: no account "nobody"; the accounts are tester2, other, phone.');
    const passcode = textOf(await tools.typeText({ target: { id: "email" }, text: "${account.passcode}", account: "phone" }));
    expect(passcode).toMatch(/^Error bad_params: an account's passcode/);
    expect(passcode).not.toContain("135790");
    expect(typed).toHaveLength(0);
  });

  it("an account without a placeholder, or a placeholder without an account, is bad_params", async () => {
    const { tools, typed } = await setup();
    expect(textOf(await tools.typeText({ target: { id: "email" }, text: "plain", account: "tester2" }))).toMatch(/^Error bad_params: account "tester2" is named but the text/);
    expect(textOf(await tools.typeText({ target: { id: "email" }, text: "${account.username}" }))).toMatch(/^Error bad_params: name the account/);
    expect(typed).toHaveLength(0);
  });

  it("without accounts loaded it says so", async () => {
    const { host, port } = await startHost();
    hosts.push(host);
    const { app } = await FakeApp.connect(port, { capabilities: ["tree", "type", "typeKind"] }, () => ({ ok: true, result: { screen: SCREEN, elements: [EMAIL] } }));
    apps.push(app);
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" } });
    expect(textOf(await tools.typeText({ target: { id: "email" }, text: "${account.username}", account: "tester2" }))).toMatch(/^Error bad_params: no accounts are loaded; start Tapline with --accounts FILE/);
  });

  it("an app that doesn't know field kinds is refused, since it would type into any field", async () => {
    const { tools, typed } = await setup({ capabilities: ["tree", "type", "dryRun"] });
    const answer = await tools.typeText({ target: { id: "email" }, text: "${account.username}", account: "tester2" });
    expect(textOf(answer)).toBe("Error unsupported: this app's Tapline is too old to type an account's value safely; update react-native-tapline.");
    expect(typed).toHaveLength(0);
  });

  it("a dry run checks the field and sends no value", async () => {
    const { tools, app } = await setup();
    const answer = await tools.typeText({ target: { id: "email" }, text: "${account.password}", account: "tester2", dry_run: true });
    expect(textOf(answer)).toBe("Error bad_params: an account's password goes only into a password field; e14 is a text field.");
    const ok = await tools.typeText({ target: { id: "password" }, text: "${account.password}", account: "tester2", dry_run: true });
    expect(textOf(ok)).toMatch(/^Would type into/);
    expect(JSON.stringify([...app.requests, ...app.dryRuns])).not.toContain(PASS);
  });
});

describe("a blocked accounts file", () => {
  const BLOCKED = "accounts file is inside the git repo at /work/accounts.json and not ignored; move it or add it to .gitignore.";

  it("every use answers the message, and the first answer carries it as a note, once", async () => {
    const { tools, typed } = await setup({ accounts: { store: null, blocked: BLOCKED } });
    const use = await tools.typeText({ target: { id: "email" }, text: "${account.username}", account: "tester2" });
    expect(textOf(use)).toBe(`Error bad_params: ${BLOCKED}`);
    const again = await tools.typeText({ target: { id: "email" }, text: "${account.username}", account: "tester2" });
    expect(textOf(again)).toBe(`Error bad_params: ${BLOCKED}`);
    expect(typed).toHaveLength(0);
  });

  it("the first answer of the session says it, once", async () => {
    const { tools } = await setup({ accounts: { store: null, blocked: BLOCKED } });
    const first = textOf(await tools.look({ screenshot: false }));
    expect(first).toContain(`Note: ${BLOCKED}`);
    const second = textOf(await tools.look({ screenshot: false }));
    expect(second).not.toContain("Note: accounts file");
  });
});

describe("values never reach what is written or shown", () => {
  it("the recorded script keeps the placeholder and the account's name, never a value", async () => {
    const dir = tmp();
    const { tools } = await setup({ options: { scriptsDir: dir } });
    await tools.record({ start: true, name: "sign-in" });
    await tools.typeText({ target: { id: "email" }, text: "${account.username}", account: "tester2", look: false });
    await tools.typeText({ target: { id: "password" }, text: "${account.password}", account: "tester2", look: false });
    const stopped = textOf(await tools.record({ stop: true }));
    const saved = readFileSync(join(dir, "sign-in.json"), "utf8");
    expect(saved).not.toContain(PASS);
    expect(saved).not.toContain(USER);
    const script = JSON.parse(saved) as { steps: Array<Record<string, unknown>> };
    expect(script.steps[0]).toMatchObject({ tool: "type_text", text: "${account.username}", account: "tester2" });
    expect(script.steps[1]).toMatchObject({ tool: "type_text", text: "${account.password}", account: "tester2" });
    expect(script.steps[0]).not.toHaveProperty("kind");
    // nothing was blanked, so there is nothing to put back before replaying, and nothing to keep private
    expect(stopped).not.toContain("isn't saved");
    expect(stopped).not.toContain("keep it private");
  });

  it("a replay of that script types the account's values again", async () => {
    const dir = tmp();
    const { tools, typed } = await setup({ options: { scriptsDir: dir } });
    await tools.record({ start: true, name: "sign-in" });
    await tools.typeText({ target: { id: "email" }, text: "${account.username}", account: "tester2", look: false });
    await tools.typeText({ target: { id: "password" }, text: "${account.password}", account: "tester2", look: false });
    await tools.record({ stop: true });
    // The fake app can't reload, so the script starts on the screen as it is.
    const path = join(dir, "sign-in.json");
    writeFileSync(path, JSON.stringify({ ...(JSON.parse(readFileSync(path, "utf8")) as object), fresh: false }));
    typed.length = 0;
    const answer = textOf(await tools.replay({ name: "sign-in" }));
    expect(typed.map((t) => t["text"])).toEqual([USER, PASS]);
    expect(answer).not.toContain(PASS);
    expect(answer).not.toContain(USER);
  });

  it("the action log and the session report hold no value", async () => {
    const logDir = tmp();
    const { tools } = await setup({ options: { logDir } });
    await tools.typeText({ target: { id: "email" }, text: "${account.username}", account: "tester2" });
    await tools.typeText({ target: { id: "password" }, text: "${account.password}", account: "tester2" });
    await tools.typeText({ target: { id: "email" }, text: "${account.password}", account: "tester2" });
    const report = textOf(tools.sessionReport({}));
    expect(report).not.toContain(PASS);
    expect(report).not.toContain(USER);
    const all = readdirSync(logDir).map((name) => readFileSync(join(logDir, name), "utf8")).join("\n");
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain(PASS);
    expect(all).not.toContain(USER);
  });

  it("a field that holds exactly an account's username reads <tester2's username> in look answers", async () => {
    const { tools } = await setup({ emailValue: USER });
    const looked = textOf(await tools.look({ screenshot: false }));
    expect(looked).toContain(`value="<tester2's username>"`);
    expect(looked).not.toContain(USER);
  });

  it("logs from the app never show a value", async () => {
    const { host, port } = await startHost({ redact: store.redact });
    hosts.push(host);
    const { app } = await FakeApp.connect(port, { capabilities: ["tree", "logs"] }, () => ({ ok: true, result: { screen: SCREEN, elements: [] } }));
    apps.push(app);
    app.send({ type: "event", event: "log", data: { level: "info", message: `signing in as ${USER} with ${PASS}`, ts: Date.now() } });
    await new Promise((r) => setTimeout(r, 100));
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, accounts: { store } });
    const shown = textOf(await tools.logs({}));
    expect(shown).toContain("signing in as");
    expect(shown).not.toContain(USER);
    expect(shown).not.toContain(PASS);
  });

  it("an app's error message never shows a value either", async () => {
    const { host, port } = await startHost({ redact: store.redact });
    hosts.push(host);
    const { app } = await FakeApp.connect(port, { capabilities: ["tree", "type", "typeKind"] }, (req) =>
      req.method === "type" ? { ok: false, error: { code: "internal", message: `could not sign in ${USER} / ${PASS}` } } : { ok: true, result: { screen: SCREEN, elements: [EMAIL] } },
    );
    apps.push(app);
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, accounts: { store } });
    const said = textOf(await tools.typeText({ target: { id: "email" }, text: "${account.username}", account: "tester2" }));
    expect(said).toContain("could not sign in");
    expect(said).not.toContain(USER);
    expect(said).not.toContain(PASS);
  });
});

describe("run with an account", () => {
  it("a step's placeholder is typed for the batch's account", async () => {
    const { tools, typed } = await setup();
    const answer = textOf(
      await tools.run({
        account: "tester2",
        steps: [
          { tool: "type_text", target: { id: "email" }, text: "${account.username}" },
          { tool: "type_text", target: { id: "password" }, text: "${account.password}" },
        ],
      }),
    );
    expect(typed.map((t) => t["text"])).toEqual([USER, PASS]);
    expect(answer).toMatch(/^Ran 2 of 2 steps/);
    expect(answer).not.toContain(PASS);
    expect(answer).not.toContain(USER);
  });

  it("a step can name its own account", async () => {
    const { tools, typed } = await setup();
    await tools.run({ steps: [{ tool: "type_text", target: { id: "email" }, text: "${account.username}", account: "tester2" }] });
    expect(typed.map((t) => t["text"])).toEqual([USER]);
  });

  it("a bad account use is refused before any step runs, naming the step", async () => {
    const { tools, typed } = await setup();
    const answer = await tools.run({
      account: "tester2",
      steps: [
        { tool: "type_text", target: { id: "email" }, text: "${account.username}" },
        { tool: "type_text", target: { id: "password" }, text: "hi ${account.password}" },
      ],
    });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toBe("Error bad_params: step 2 (type_text id=password): an account value is the whole text of a step, not part of one.");
    expect(typed).toHaveLength(0);
  });

  it("a wrong kind of field stops the batch with the refusal, and no value shows", async () => {
    const { tools } = await setup();
    const answer = textOf(
      await tools.run({ account: "tester2", steps: [{ tool: "type_text", target: { id: "email" }, text: "${account.password}" }] }),
    );
    expect(answer).toContain("an account's password goes only into a password field; e14 is a text field.");
    expect(answer).not.toContain(PASS);
  });

  it("an unknown account is refused before any step runs", async () => {
    const { tools, typed } = await setup();
    const answer = textOf(await tools.run({ account: "nobody", steps: [{ tool: "type_text", target: { id: "email" }, text: "${account.username}" }] }));
    expect(answer).toMatch(/^Error not_found: step 1 \(type_text id=email\): no account "nobody"/);
    expect(typed).toHaveLength(0);
  });
});
