import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  accountStore,
  loadAccounts,
  redactContent,
  substituteAccount,
  vaultFileSchema,
  vaultStore,
  type AccountStore,
  type AccountsLoad,
  type GitProbe,
  type VaultFile,
} from "../src/accounts.js";
import type { AuditEntry } from "../src/auditlog.js";
import { main, parseCli, runtimeOptionsOf } from "../src/cli.js";
import { runDoctor, type DoctorDeps } from "../src/doctor.js";
import { createRuntime } from "../src/runtime.js";
import { Dialogs, OK_ALLOW, OK_FIELD, type ElicitAnswer, type ElicitClient } from "../src/elicit.js";
import { substituteSteps } from "../src/routes.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import {
  DPAPI_ENTROPY,
  KEYCHAIN_SERVICE,
  plainWarning,
  powershellDpapi,
  protectVaultFile,
  securityKeychain,
  type Dpapi,
  type Keychain,
  type ProcRunner,
  type VaultDeps,
} from "../src/vault.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

// AGENT-TOOLS 1.14 §20.1 to §20.3: the vault. Every value below is made up.

const APP = "com.example.demo";
const VALUES = {
  username: "tester2@example.com",
  password: "fake-pass-9137",
  street: "14 Fake Street, Apt 5",
  city: "Faketown",
  postcode: "FK1 2AB",
  country: "QA",
  name: "Jane Q. Tester",
  phone: "+1 555 010 0199",
  email: "jane.tester@example.com",
  birthday: "1990-01-31",
  number: "4111 1111 1111 1111",
  expiry: "12/29",
  cvc: "737",
  note: "Thanks and regards,\nJane  Tester\nFake Co. Ltd., 1 Example Road",
  passcode: "246810",
};

const FILE: VaultFile = {
  version: 2,
  vault: {
    tester2: { kind: "account", username: VALUES.username, password: VALUES.password, apps: [APP] },
    other: { kind: "account", username: "other@example.com", password: "fake-other-2468", apps: ["com.example.elsewhere"] },
    home: { kind: "address", street: VALUES.street, city: VALUES.city, postcode: VALUES.postcode, country: VALUES.country },
    me: { kind: "identity", name: VALUES.name, phone: VALUES.phone, email: VALUES.email, birthday: VALUES.birthday },
    visa: { kind: "card", number: VALUES.number, expiry: VALUES.expiry, cvc: VALUES.cvc },
    reply_sig: { kind: "note", text: VALUES.note },
    phone: { kind: "phone", passcode: VALUES.passcode },
  },
};
const store = vaultStore(FILE);

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "tapline-vault-"));
  dirs.push(dir);
  return dir;
}
const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : `<${c.type}>`)).join("\n");
const OUTSIDE: GitProbe = { insideWorkTree: async () => false, ignored: async () => false };
const INSIDE: GitProbe = { insideWorkTree: async () => true, ignored: async () => false };

// ---- the file ------------------------------------------------------------------------------------------

describe("the vault file", () => {
  it("version 2 loads with every kind, and a top-level otp key is ignored", async () => {
    const file = join(tmp(), "vault.json");
    writeFileSync(file, JSON.stringify({ ...FILE, otp: { sources: ["com.apple.MobileSMS"] } }));
    const loaded = await loadAccounts(file, OUTSIDE);
    expect(loaded.store?.names()).toEqual(["tester2", "other", "home", "me", "visa", "reply_sig", "phone"]);
    expect(["tester2", "home", "me", "visa", "reply_sig", "phone"].map((n) => loaded.store?.kindOf(n))).toEqual(["account", "address", "identity", "card", "note", "phone"]);
    expect(loaded.store?.kindOf("nobody")).toBeUndefined();
  });

  it("version 1 still loads: each entry is an account, and phone keeps its place", () => {
    const v1 = accountStore({ version: 1, accounts: { tester2: { username: VALUES.username, password: VALUES.password }, phone: { passcode: VALUES.passcode } } });
    expect(v1.kindOf("tester2")).toBe("account");
    expect(v1.kindOf("phone")).toBe("phone");
    // a v1 entry is reachable by ${vault.tester2.username} too
    expect(substituteAccount("${vault.tester2.username}", v1, undefined, APP)).toMatchObject({ ok: true, text: VALUES.username });
  });

  it("entry names are ASCII letters, digits and underscore; a short secret is refused without quoting it", () => {
    expect(vaultFileSchema.safeParse({ version: 2, vault: { "home-1": { kind: "note", text: "abc" } } }).success).toBe(false);
    expect(vaultFileSchema.safeParse({ version: 2, vault: { home_1: { kind: "note", text: "abc" } } }).success).toBe(true);
    const short = vaultFileSchema.safeParse({ version: 2, vault: { v: { kind: "card", number: "12", expiry: "1", cvc: "1" } } });
    expect(short.success).toBe(false);
    expect(JSON.stringify(short.success ? {} : short.error.issues)).not.toContain('"12"');
    expect(vaultFileSchema.safeParse({ version: 2, vault: { v: { kind: "spaceship" } } }).success).toBe(false);
  });

  it("a plain file loads with the spec's warning, and a bad file's error never quotes it", async () => {
    const file = join(tmp(), "vault.json");
    writeFileSync(file, JSON.stringify(FILE));
    const loaded = await loadAccounts(file, OUTSIDE);
    expect("note" in loaded && loaded.note).toBe(`Note: the vault file ${file} is not encrypted; keep test data in it only.`);
    expect(plainWarning(file)).toBe("note" in loaded ? (loaded.note ?? "") : "");
    writeFileSync(file, '{"version": 2, "vault": {"a": {"kind": "note", "text": "fake-pass-9137" ');
    const error = await loadAccounts(file, OUTSIDE).catch((e: unknown) => e);
    expect(String((error as Error).message)).toContain("isn't valid JSON");
    expect(String((error as Error).message)).not.toContain("fake-pass-9137");
  });

  it("a plain file in a git work tree that isn't ignored loads nothing, as §18.6 says", async () => {
    const file = join(tmp(), "vault.json");
    writeFileSync(file, JSON.stringify(FILE));
    const loaded = await loadAccounts(file, INSIDE);
    expect(loaded.store).toBeNull();
    expect("blocked" in loaded && loaded.blocked).toBe(`accounts file is inside the git repo at ${file} and not ignored; move it or add it to .gitignore.`);
  });
});

// ---- references and field rules ------------------------------------------------------------------------

describe("references", () => {
  it("${vault.name.field} is the whole text of a step; joined text is bad_params", () => {
    expect(substituteAccount("${vault.home.street}", store, undefined, APP)).toEqual({
      ok: true,
      text: VALUES.street,
      field: "street",
      use: { name: "home", kind: "address", field: "street" },
    });
    expect(substituteAccount("hi ${vault.home.street}", store, undefined, APP)).toEqual({ ok: false, code: "bad_params", message: "a vault value is the whole text of a step, not part of one." });
    expect(substituteAccount("${vault.home}", store, undefined, APP)).toMatchObject({ ok: false, code: "bad_params" });
  });

  it("an unknown entry is not_found with the names; a field the kind lacks is bad_params with its fields", () => {
    const missing = substituteAccount("${vault.nobody.text}", store, undefined, APP);
    expect(missing).toEqual({ ok: false, code: "not_found", message: 'no vault entry "nobody"; the entries are tester2, other, home, me, visa, reply_sig, phone.' });
    const wrong = substituteAccount("${vault.visa.street}", store, undefined, APP);
    expect(wrong).toEqual({ ok: false, code: "bad_params", message: 'vault entry "visa" is a card; its fields are number, expiry, cvc.' });
  });

  it("apps limits every field of an entry; absent means any app", () => {
    const elsewhere = substituteAccount("${vault.other.username}", store, undefined, APP);
    expect(elsewhere).toMatchObject({ ok: false, code: "bad_params" });
    expect(JSON.stringify(elsewhere)).not.toContain("other@example.com");
    expect((elsewhere as { message: string }).message).toBe(`vault entry "other" isn't for this app (${APP}); it is for com.example.elsewhere.`);
    expect(substituteAccount("${vault.home.city}", store, undefined, "any.app.at.all").ok).toBe(true);
  });

  it("the phone kind is held and never typed", () => {
    const passcode = substituteAccount("${vault.phone.passcode}", store, undefined, APP);
    expect(passcode).toMatchObject({ ok: false, code: "bad_params" });
    expect(JSON.stringify(passcode)).not.toContain(VALUES.passcode);
  });

  it("${account.username} names the entry by the call's account, and account entries only", () => {
    expect(substituteAccount("${account.username}", store, "tester2", APP)).toEqual({ ok: true, text: VALUES.username, field: "username" });
    const address = substituteAccount("${account.username}", store, "home", APP);
    expect(address).toMatchObject({ ok: false, code: "bad_params" });
    expect((address as { message: string }).message).toContain("account entries only");
  });

  it("a route keeps a vault reference whole and refuses joined text", () => {
    const typed = (text: string) => [{ tool: "type_text", target: { id: "street" }, text }];
    expect(substituteSteps(typed("${vault.home.street}"), {}, store, [])).toMatchObject({ ok: true });
    const joined = substituteSteps(typed("at ${vault.home.street}"), {}, store, []);
    expect(joined.ok).toBe(false);
    const smuggled = substituteSteps(typed("${city}"), { city: "${vault.home.street}" }, store, ["city"]);
    expect(smuggled.ok).toBe(false);
  });
});

// ---- through TaplineTools, with a fake app -------------------------------------------------------------

const field = (ref: string, testID: string, label: string, extra: Record<string, unknown> = {}) => ({
  ref,
  type: "TextInput",
  role: "textfield",
  testID,
  label,
  text: "",
  value: "",
  frame: { x: 24, y: 400, width: 354, height: 48 },
  actions: ["press", "type"],
  ...extra,
});
const EMAIL = field("e14", "email", "Email");
const SECRET = field("e15", "password", "Password");
const STREET = field("e16", "street", "Street");
const CARD = field("e17", "card-number", "Card number");
const ELEMENTS = [EMAIL, SECRET, STREET, CARD];
const SCREEN = { width: 402, height: 874, scale: 3 };

/** A dialog client: answers at once (allow or decline), and keeps what it was asked. */
function person(answer: "allow" | "decline"): { client: ElicitClient; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    client: {
      canShowForm: () => true,
      elicit: (message): Promise<ElicitAnswer> => {
        asked.push(message);
        return Promise.resolve(answer === "allow" ? { action: "accept", content: { [OK_FIELD]: OK_ALLOW } } : { action: "decline" });
      },
    },
  };
}

interface Setup {
  accounts?: AccountsLoad;
  options?: Partial<ConstructorParameters<typeof TaplineTools>[1]>;
  /** What the street field shows in the tree. */
  streetValue?: string;
  /** Answers `type` with this error message instead of typing. */
  typeError?: string;
}

async function setup(config: Setup = {}) {
  const active = config.accounts ?? { store };
  const { host, port } = await startHost(active.store !== null ? { redact: active.store.redact } : {});
  hosts.push(host);
  const typed: Array<Record<string, unknown>> = [];
  const audit: Array<Omit<AuditEntry, "t" | "tool">> = [];
  const byId = (id: string | undefined) => ELEMENTS.find((e) => e.testID === id) ?? EMAIL;
  const handler = (req: IncomingRequest): Reply => {
    switch (req.method) {
      case "tree":
        return { ok: true, result: { screen: SCREEN, elements: ELEMENTS.map((e) => (e.testID === "street" ? { ...e, value: config.streetValue ?? "" } : e)) } };
      case "type": {
        const params = req.params as Record<string, unknown>;
        const target = params["target"] as { testID?: string } | undefined;
        const element = byId(target?.testID);
        if (params["dryRun"] === true) return { ok: true, result: { element, point: { x: 200, y: 424 } } };
        typed.push(params);
        if (config.typeError !== undefined) return { ok: false, error: { code: "internal", message: config.typeError } };
        const secure = target?.testID === "password";
        const kind = params["kind"];
        if (kind !== undefined && (kind === "secure") !== secure) {
          return { ok: false, error: { code: "bad_params", message: `${secure ? "e15" : "e14"} input "x" is a field of the other kind`, data: { secure } } };
        }
        const value = secure ? "•".repeat(String(params["text"]).length) : String(params["text"]);
        return { ok: true, result: { element: { ...element, value }, value, ...(secure ? { secure: true } : {}), settledMs: 40 } };
      }
      case "logs":
        return { ok: true, result: { entries: [{ t: 1, level: "log", message: `profile saved for ${VALUES.name} at ${VALUES.street}` }] } };
      default:
        return { ok: true, result: {} };
    }
  };
  const { app } = await FakeApp.connect(port, { capabilities: ["tree", "press", "type", "typeKind", "logs", "dryRun"] }, handler);
  apps.push(app);
  const tools = new TaplineTools(host, {
    connect: { url: "", name: "Dev PC" },
    accounts: active,
    audit: { write: (entry) => (audit.push(entry), true) },
    ...config.options,
  });
  return { tools, app, typed, audit };
}

describe("typing a vault value", () => {
  it("a password goes only into a secure field, with §18.6's words", async () => {
    const { tools, typed } = await setup();
    const answer = await tools.typeText({ target: { id: "email" }, text: "${vault.tester2.password}" });
    expect(textOf(answer)).toBe("Error bad_params: an account's password goes only into a password field; e14 is a text field.");
    const ok = textOf(await tools.typeText({ target: { id: "password" }, text: "${vault.tester2.password}" }));
    expect(ok).toContain("The value is hidden (secure field).");
    expect(typed).toHaveLength(2);
    expect(typed[1]).toMatchObject({ text: VALUES.password, kind: "secure" });
  });

  it("a username goes only into a text field", async () => {
    const { tools } = await setup();
    expect(textOf(await tools.typeText({ target: { id: "password" }, text: "${vault.tester2.username}" }))).toBe(
      "Error bad_params: an account's username goes only into a text field; e15 is a password field.",
    );
  });

  it("an address field is typed by name, and answers read value=<home's street>", async () => {
    const { tools, typed } = await setup();
    const answer = textOf(await tools.typeText({ target: { id: "street" }, text: "${vault.home.street}" }));
    expect(typed[0]).toMatchObject({ text: VALUES.street });
    expect(typed[0]).not.toHaveProperty("kind");
    expect(answer).toContain(`Value is now "<home's street>".`);
    expect(answer).not.toContain(VALUES.street);
  });

  it("an identity, a note and a card come out by name too; the account alias works beside them", async () => {
    const { tools, typed } = await setup({ options: { dialogs: new Dialogs(person("allow").client, {}) } });
    await tools.typeText({ target: { id: "email" }, text: "${vault.me.email}", look: false });
    await tools.typeText({ target: { id: "street" }, text: "${vault.reply_sig.text}", look: false });
    await tools.typeText({ target: { id: "card-number" }, text: "${vault.visa.number}", look: false });
    await tools.typeText({ target: { id: "email" }, text: "${account.username}", account: "tester2", look: false });
    expect(typed.map((t) => t["text"])).toEqual([VALUES.email, VALUES.note, VALUES.number, VALUES.username]);
  });

  it("an entry limited to another app, an unknown entry and a phone entry are refused before anything is typed", async () => {
    const { tools, typed } = await setup();
    const other = textOf(await tools.typeText({ target: { id: "email" }, text: "${vault.other.username}" }));
    expect(other).toMatch(/^Error bad_params: vault entry "other" isn't for this app/);
    expect(other).not.toContain("other@example.com");
    expect(textOf(await tools.typeText({ target: { id: "email" }, text: "${vault.nobody.text}" }))).toMatch(/^Error not_found: no vault entry "nobody"/);
    const phone = textOf(await tools.typeText({ target: { id: "email" }, text: "${vault.phone.passcode}" }));
    expect(phone).toMatch(/^Error bad_params: an account's passcode/);
    expect(phone).not.toContain(VALUES.passcode);
    expect(textOf(await tools.typeText({ target: { id: "email" }, text: "x ${vault.home.city}" }))).toBe("Error bad_params: a vault value is the whole text of a step, not part of one.");
    expect(typed).toHaveLength(0);
  });

  it("run types vault values, checked before any step runs", async () => {
    const { tools, typed } = await setup();
    const ok = await tools.run({
      steps: [
        { tool: "type_text", target: { id: "email" }, text: "${vault.me.email}" },
        { tool: "type_text", target: { id: "street" }, text: "${vault.home.street}" },
      ],
    });
    expect(ok.isError).not.toBe(true);
    expect(typed.map((t) => t["text"])).toEqual([VALUES.email, VALUES.street]);
    expect(textOf(ok)).not.toContain(VALUES.email);
    typed.length = 0;
    const bad = await tools.run({
      steps: [
        { tool: "type_text", target: { id: "email" }, text: "${vault.me.email}" },
        { tool: "type_text", target: { id: "street" }, text: "${vault.visa.street}" },
      ],
    });
    expect(textOf(bad)).toMatch(/^Error bad_params: step 2 /);
    expect(typed).toHaveLength(0);
  });

  it("a recorded script keeps the reference, never the value, and a replay types the value again", async () => {
    const dir = tmp();
    const { tools, typed } = await setup({ options: { scriptsDir: dir } });
    await tools.record({ start: true, name: "address" });
    await tools.typeText({ target: { id: "street" }, text: "${vault.home.street}", look: false });
    await tools.record({ stop: true });
    const path = join(dir, "address.json");
    const saved = readFileSync(path, "utf8");
    expect(saved).not.toContain(VALUES.street);
    expect(saved).toContain("${vault.home.street}");
    writeFileSync(path, JSON.stringify({ ...(JSON.parse(saved) as object), fresh: false }));
    typed.length = 0;
    const answer = textOf(await tools.replay({ name: "address" }));
    expect(typed.map((t) => t["text"])).toEqual([VALUES.street]);
    expect(answer).not.toContain(VALUES.street);
  });
});

describe("a card", () => {
  it("is typed only with a person's OK, every time, in words that name the entry and the field", async () => {
    const asked = person("allow");
    const { tools, typed, audit } = await setup({ options: { dialogs: new Dialogs(asked.client, {}) } });
    const first = await tools.typeText({ target: { id: "card-number" }, text: "${vault.visa.number}", look: false });
    expect(first.isError).not.toBe(true);
    expect(asked.asked).toEqual(['Allow: type card "visa" number into "Card number" in Demo?']);
    expect(typed).toHaveLength(1);
    // The OK was used up: the same field asks again.
    await tools.typeText({ target: { id: "card-number" }, text: "${vault.visa.number}", look: false });
    expect(asked.asked).toHaveLength(2);
    expect(typed).toHaveLength(2);
    expect(JSON.stringify(asked.asked)).not.toContain(VALUES.number);
    // The audit log has the person's OK and the use, never the value.
    expect(audit.filter((l) => l.kind === "approval")).toHaveLength(2);
    expect(audit.filter((l) => l.kind === "vault")).toEqual([{ kind: "vault", app: APP, name: "visa", detail: "number into text field" }, { kind: "vault", app: APP, name: "visa", detail: "number into text field" }]);
    expect(JSON.stringify(audit)).not.toContain(VALUES.number);
  });

  it("a person who declines types nothing, and the audit log says declined", async () => {
    const { tools, typed, audit } = await setup({ options: { dialogs: new Dialogs(person("decline").client, {}) } });
    const answer = await tools.typeText({ target: { id: "card-number" }, text: "${vault.visa.cvc}", look: false });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toContain("They declined. Ask your user what to do.");
    expect(typed).toHaveLength(0);
    expect(audit).toContainEqual({ kind: "approval", app: APP, name: "card", detail: "declined" });
    expect(audit.some((l) => l.kind === "vault")).toBe(false);
  });

  it("with nobody to ask it answers not_allowed: needs_confirmation, and no grant stands in", async () => {
    const { tools, typed } = await setup();
    const answer = await tools.typeText({ target: { id: "card-number" }, text: "${vault.visa.number}", look: false });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error not_allowed: needs_confirmation: typing card "visa" number needs a person's OK, every time \(no grant covers a card\)\./);
    expect(typed).toHaveLength(0);
  });

  it("a card's other fields ask too, and run asks inside the batch", async () => {
    const asked = person("allow");
    const { tools, typed } = await setup({ options: { dialogs: new Dialogs(asked.client, {}) } });
    await tools.run({ steps: [{ tool: "type_text", target: { id: "card-number" }, text: "${vault.visa.expiry}" }, { tool: "type_text", target: { id: "card-number" }, text: "${vault.visa.cvc}" }] });
    expect(asked.asked).toEqual(['Allow: type card "visa" expiry into "Card number" in Demo?', 'Allow: type card "visa" cvc into "Card number" in Demo?']);
    expect(typed.map((t) => t["text"])).toEqual([VALUES.expiry, VALUES.cvc]);
  });
});

describe("audit lines", () => {
  it("every use is a vault line with the entry and the field, never the value", async () => {
    const { tools, audit } = await setup();
    await tools.typeText({ target: { id: "password" }, text: "${vault.tester2.password}", look: false });
    await tools.typeText({ target: { id: "email" }, text: "${account.username}", account: "tester2", look: false });
    await tools.typeText({ target: { id: "street" }, text: "${vault.home.street}", look: false });
    await tools.typeText({ target: { id: "email" }, text: "${vault.tester2.password}", look: false });
    expect(audit).toEqual([
      { kind: "vault", app: APP, name: "tester2", detail: "password into secure field" },
      { kind: "vault", app: APP, name: "tester2", detail: "username into text field" },
      { kind: "vault", app: APP, name: "home", detail: "street into text field" },
    ]);
    expect(JSON.stringify(audit)).not.toContain(VALUES.password);
    expect(JSON.stringify(audit)).not.toContain(VALUES.street);
  });

  it("a dry run writes none", async () => {
    const { tools, audit } = await setup();
    await tools.typeText({ target: { id: "street" }, text: "${vault.home.street}", dry_run: true });
    expect(audit).toEqual([]);
  });
});

// ---- redaction (§20.3) ---------------------------------------------------------------------------------

/** Every form the gate looks for, built here and not by the code under test. */
function gateForms(value: string): string[] {
  const collapsed = value.replace(/\s+/g, " ").trim();
  const zeroWidth = [...value].join("​");
  const marks = `‎${value}‏`;
  const forms: string[] = [value, collapsed, zeroWidth, marks, JSON.stringify(value).slice(1, -1), JSON.stringify(collapsed).slice(1, -1)];
  for (const base of [value, collapsed]) {
    forms.push(encodeURIComponent(base), encodeURIComponent(base).replace(/%20/g, "+"), new URLSearchParams({ k: base }).toString().slice(2));
    forms.push(JSON.stringify(JSON.stringify(base)).slice(1, -1), encodeURIComponent(JSON.stringify(base).slice(1, -1)));
  }
  return [...new Set(forms)];
}

/** Every 12-character piece of a value. */
function pieces(value: string): string[] {
  const out: string[] = [];
  for (const base of new Set([value, value.replace(/\s+/g, " ").trim()])) for (let i = 0; i + 12 <= base.length; i++) out.push(base.slice(i, i + 12));
  return out;
}

const SCRUBBED = Object.entries(VALUES).filter(([key]) => key !== "country");

describe("no value is ever shown (§20.3)", () => {
  it("the gate: no form of any value, nor any 12-character piece, survives the redactor", () => {
    for (const [key, value] of SCRUBBED) {
      for (const form of gateForms(value)) {
        for (const wrap of [(f: string) => f, (f: string) => `value="${f}" ok`, (f: string) => `{"a":"${f}"}`, (f: string) => `?q=${f}&x=1`]) {
          const out = store.redact(wrap(form));
          expect(out, `${key} as ${JSON.stringify(form)}`).not.toContain(form);
          for (const piece of pieces(value)) expect(out, `${key} piece ${JSON.stringify(piece)}`).not.toContain(piece);
        }
      }
    }
  });

  it("the placeholder is the entry's name, 's and the field", () => {
    expect(store.redact(`value=${VALUES.street}`)).toBe("value=<home's street>");
    expect(store.redact(`${VALUES.username} / ${VALUES.password}`)).toBe("<tester2's username> / <tester2's password>");
    expect(store.redact(VALUES.number)).toBe("<visa's number>");
    expect(store.redact(`> ${VALUES.note} <`)).toBe("> <reply_sig's text> <");
  });

  it("a value cut by the app at 200 characters leaves nothing of its first 200", () => {
    const long = Array.from({ length: 30 }, (_, i) => `sentence number ${i} of a long note.`).join(" ");
    const longStore = vaultStore({ version: 2, vault: { diary: { kind: "note", text: long } } });
    const cut = `${long.slice(0, 200)}…(+${long.length - 200})`;
    const out = longStore.redact(cut);
    for (const piece of pieces(long.slice(0, 200))) expect(out).not.toContain(piece);
  });

  it("a placeholder is never scrubbed again, and a value that holds another is scrubbed whole", () => {
    const tricky = vaultStore({ version: 2, vault: { a: { kind: "note", text: "secret-phrase-one" }, b: { kind: "note", text: "secret-phrase-one-and-more" }, c: { kind: "note", text: "text" } } });
    expect(tricky.redact("x secret-phrase-one-and-more y")).toBe("x <b's text> y");
    // "text" is a value, and it is also a word inside every placeholder: one pass leaves the placeholders alone
    expect(tricky.redact("secret-phrase-one then text")).toBe("<a's text> then <c's text>");
  });

  it("a short value (a country code) is held and typed but not scrubbed, since it would garble unrelated text", () => {
    expect(store.redact("QATAR and QA")).toBe("QATAR and QA");
  });

  it("the content backstop scrubs values but never keys, tool names or ${…} syntax", () => {
    const script = { format: "agent-tools-script", steps: [{ tool: "type_text", text: "${vault.home.street}", label: `at ${VALUES.street}` }] };
    const tricky = vaultStore({ version: 2, vault: { n: { kind: "note", text: "vault" }, t: { kind: "note", text: "type_text" } } });
    expect(redactContent(script, store.redact)).toEqual({ format: "agent-tools-script", steps: [{ tool: "type_text", text: "${vault.home.street}", label: "at <home's street>" }] });
    expect(redactContent(script, tricky.redact)).toEqual(script);
  });

  it("every sink the host writes or answers is scrubbed: look, errors, logs, the action log, scripts, the report, dialogs and audit", async () => {
    const logDir = tmp();
    const scriptsDir = tmp();
    const asked = person("allow");
    const { tools, audit } = await setup({
      streetValue: VALUES.street,
      options: { logDir, scriptsDir, dialogs: new Dialogs(asked.client, {}) },
    });
    const seen: string[] = [];
    seen.push(textOf(await tools.look({ screenshot: false })));
    seen.push(textOf(await tools.logs({})));
    await tools.record({ start: true, name: "flow" });
    seen.push(textOf(await tools.typeText({ target: { id: "street" }, text: "${vault.home.street}" })));
    seen.push(textOf(await tools.typeText({ target: { id: "card-number" }, text: "${vault.visa.number}" })));
    seen.push(textOf(await tools.typeText({ target: { id: "password" }, text: "${vault.tester2.password}" })));
    seen.push(textOf(await tools.record({ stop: true })));
    seen.push(textOf(tools.sessionReport({})));
    seen.push(...asked.asked, JSON.stringify(audit));
    const files = (dir: string): string[] => readdirSync(dir).map((n) => (statSync(join(dir, n)).isDirectory() ? "" : readFileSync(join(dir, n), "utf8")));
    seen.push(...files(logDir), ...files(scriptsDir));
    const everything = seen.join("\n");
    for (const [key, value] of SCRUBBED) {
      for (const piece of [value, ...pieces(value)]) expect(everything, `${key} leaked as ${JSON.stringify(piece)}`).not.toContain(piece);
    }
    expect(seen[0]).toContain("<home's street>");
    expect(seen[1]).toContain("<me's name>");
  });

  it("an app's error that quotes a value is scrubbed", async () => {
    const { tools } = await setup({ typeError: `could not save ${VALUES.street} for ${VALUES.name}` });
    const answer = textOf(await tools.typeText({ target: { id: "street" }, text: "${vault.home.street}" }));
    expect(answer).toContain("<home's street>");
    expect(answer).toContain("<me's name>");
    expect(answer).not.toContain(VALUES.street);
  });

  it("a policy word that collides with a value still triggers: a button called Delete still asks", async () => {
    const deleteStore = vaultStore({ version: 2, vault: { word: { kind: "note", text: "Delete" } } });
    const { host, port } = await startHost({ redact: deleteStore.redact });
    hosts.push(host);
    const button = { ref: "e1", type: "Pressable", role: "button", testID: "del", text: "Delete", frame: { x: 0, y: 0, width: 100, height: 40 }, actions: ["press"] };
    const { app } = await FakeApp.connect(port, { capabilities: ["tree", "press", "type", "typeKind", "dryRun"] }, (req) => {
      if (req.method === "tree") return { ok: true, result: { screen: SCREEN, elements: [button, EMAIL] } };
      if (req.method === "type") return { ok: true, result: { element: EMAIL, value: "Delete" } };
      return { ok: true, result: { element: button, point: { x: 50, y: 20 } } };
    });
    apps.push(app);
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, accounts: { store: deleteStore } });
    // typing the value "Delete" into a field is not a Delete touch
    const typed = await tools.typeText({ target: { id: "email" }, text: "${vault.word.text}", look: false });
    expect(typed.isError).not.toBe(true);
    // but the button labelled Delete still needs a person
    const tapped = await tools.tap({ target: { id: "del" }, look: false });
    expect(tapped.isError).toBe(true);
    expect(textOf(tapped)).toContain("needs_confirmation");
    expect(app.requests.filter((r) => r.method === "press")).toHaveLength(0);
  });
});

// ---- storage (§20.2) -----------------------------------------------------------------------------------

/** A protector that "encrypts" by reversing and records what it was given: the byte layout is what is under test. */
function fakeDpapi(): Dpapi & { calls: Array<{ mode: string; data: Buffer; entropy: Buffer }> } {
  const calls: Array<{ mode: string; data: Buffer; entropy: Buffer }> = [];
  return {
    calls,
    async protect(data, entropy) {
      calls.push({ mode: "protect", data, entropy });
      return Buffer.from([...data].reverse());
    },
    async unprotect(blob, entropy) {
      calls.push({ mode: "unprotect", data: blob, entropy });
      return Buffer.from([...blob].reverse());
    },
  };
}
function fakeKeychain(): Keychain & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    async read(account) {
      return entries.get(account) ?? null;
    },
    async write(account, json) {
      entries.set(account, json);
    },
  };
}
const deps = (platform: NodeJS.Platform, dpapi: Dpapi = fakeDpapi(), keychain: Keychain = fakeKeychain()): VaultDeps => ({ platform, dpapi, keychain });

describe("storage: Windows DPAPI", () => {
  it("the protected file is {version 2, protected dpapi-user, data}: the blob of the UTF-8 JSON with the fixed entropy", async () => {
    const file = join(tmp(), "vault.json");
    writeFileSync(file, JSON.stringify(FILE));
    const dpapi = fakeDpapi();
    const done = await protectVaultFile(file, deps("win32", dpapi));
    expect(done).toEqual({ ok: true, how: "dpapi-user" });
    const written = JSON.parse(readFileSync(file, "utf8")) as { version: number; protected: string; data: string };
    expect(Object.keys(written).sort()).toEqual(["data", "protected", "version"]);
    expect(written).toMatchObject({ version: 2, protected: "dpapi-user" });
    expect(dpapi.calls).toHaveLength(1);
    expect(dpapi.calls[0]?.entropy.toString("utf8")).toBe("tapline-tapwright-vault-v2");
    expect(DPAPI_ENTROPY.toString("utf8")).toBe("tapline-tapwright-vault-v2");
    // what was protected is the UTF-8 JSON {"version": 2, "vault": {...}}, and the data is the blob's base64
    expect(JSON.parse((dpapi.calls[0]?.data ?? Buffer.alloc(0)).toString("utf8"))).toEqual(FILE);
    expect(Buffer.from(written.data, "base64")).toEqual(Buffer.from([...(dpapi.calls[0]?.data ?? Buffer.alloc(0))].reverse()));
    // the file holds no value
    for (const [, value] of SCRUBBED) expect(readFileSync(file, "utf8")).not.toContain(value);
  });

  it("a protected file loads (and the git rule doesn't apply: it holds no value) with no plain warning", async () => {
    const file = join(tmp(), "vault.json");
    writeFileSync(file, JSON.stringify(FILE));
    const dpapi = fakeDpapi();
    await protectVaultFile(file, deps("win32", dpapi));
    const loaded = await loadAccounts(file, INSIDE, deps("win32", dpapi));
    expect(loaded.store?.names()).toContain("visa");
    expect("note" in loaded).toBe(false);
    expect(dpapi.calls.map((c) => c.mode)).toEqual(["protect", "unprotect"]);
    expect(dpapi.calls[1]?.entropy.toString("utf8")).toBe("tapline-tapwright-vault-v2");
  });

  it("a protected file that can't be opened loads no vault and says why, without a value", async () => {
    const file = join(tmp(), "vault.json");
    writeFileSync(file, JSON.stringify(FILE));
    await protectVaultFile(file, deps("win32"));
    const broken: Dpapi = { protect: async () => Buffer.alloc(0), unprotect: async () => Promise.reject(new Error("Windows couldn't decrypt it (it was protected for another user or another computer)")) };
    const loaded = await loadAccounts(file, OUTSIDE, deps("win32", broken));
    expect(loaded.store).toBeNull();
    expect("blocked" in loaded && loaded.blocked).toBe("the vault file can't be opened: Windows couldn't decrypt it (it was protected for another user or another computer).");
    const elsewhere = await loadAccounts(file, OUTSIDE, deps("linux"));
    expect("blocked" in elsewhere && elsewhere.blocked).toMatch(/^the vault file can't be opened: the file is protected with Windows DPAPI/);
  });

  it("every use of an unopenable vault answers Error bad_params: the vault file can't be opened: <why>.", async () => {
    const blocked = "the vault file can't be opened: Windows couldn't decrypt it.";
    const { tools, typed } = await setup({ accounts: { store: null, blocked } });
    const answer = await tools.typeText({ target: { id: "street" }, text: "${vault.home.street}" });
    expect(textOf(answer).split("\n")[0]).toBe(`Error bad_params: ${blocked}`);
    expect(typed).toHaveLength(0);
  });

  it("the PowerShell call keeps the data and the entropy off the command line and on stdin", async () => {
    const calls: Array<{ command: string; args: string[]; input: string }> = [];
    const run: ProcRunner = async (command, args, input) => {
      calls.push({ command, args, input });
      return { code: 0, stdout: `${Buffer.from("blob").toString("base64")}\n`, stderr: "" };
    };
    const blob = await powershellDpapi(run).protect(Buffer.from("secret json"), DPAPI_ENTROPY);
    expect(blob.toString("utf8")).toBe("blob");
    expect(calls[0]?.command).toBe("powershell.exe");
    expect(calls[0]?.input).toBe(`protect\n${Buffer.from("secret json").toString("base64")}\n${DPAPI_ENTROPY.toString("base64")}\n`);
    const line = calls[0]?.args.join(" ") ?? "";
    expect(line).not.toContain(Buffer.from("secret json").toString("base64"));
    expect(line).not.toContain(DPAPI_ENTROPY.toString("base64"));
    expect(line).toContain("System.Security.Cryptography.ProtectedData");
    expect(line).toContain("CurrentUser");
    const failing: ProcRunner = async () => ({ code: 1, stdout: "", stderr: "secret json" });
    const error = await powershellDpapi(failing).unprotect(Buffer.from("x"), DPAPI_ENTROPY).catch((e: unknown) => e);
    expect(String((error as Error).message)).not.toContain("secret json");
  });

  it.runIf(process.platform === "win32")("round trip with the real DPAPI: protect, then load", async () => {
    const file = join(tmp(), "vault.json");
    writeFileSync(file, JSON.stringify(FILE));
    const real = deps("win32", powershellDpapi());
    expect(await protectVaultFile(file, real)).toEqual({ ok: true, how: "dpapi-user" });
    const text = readFileSync(file, "utf8");
    expect(JSON.parse(text)).toMatchObject({ version: 2, protected: "dpapi-user" });
    for (const [, value] of SCRUBBED) expect(text).not.toContain(value);
    const loaded = await loadAccounts(file, OUTSIDE, real);
    expect(loaded.store?.names()).toEqual(Object.keys(FILE.vault));
    expect(substituteAccount("${vault.home.street}", loaded.store as AccountStore, undefined, APP)).toMatchObject({ ok: true, text: VALUES.street });
  }, 60_000);
});

describe("storage: the macOS keychain", () => {
  it("the file holds {version 2, protected keychain} and the keychain the UTF-8 JSON, under the file's real path", async () => {
    const file = join(tmp(), "vault.json");
    writeFileSync(file, JSON.stringify(FILE));
    const keychain = fakeKeychain();
    expect(await protectVaultFile(file, deps("darwin", fakeDpapi(), keychain))).toEqual({ ok: true, how: "keychain" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 2, protected: "keychain" });
    expect(keychain.entries.size).toBe(1);
    const [account, json] = [...keychain.entries][0] ?? ["", ""];
    expect(account.endsWith("vault.json")).toBe(true);
    expect(JSON.parse(json)).toEqual(FILE);
    const loaded = await loadAccounts(file, INSIDE, deps("darwin", fakeDpapi(), keychain));
    expect(loaded.store?.kindOf("visa")).toBe("card");
  });

  it("a moved file has a new real path, and its keychain entry is no longer found", async () => {
    const dir = tmp();
    const file = join(dir, "vault.json");
    writeFileSync(file, JSON.stringify(FILE));
    const keychain = fakeKeychain();
    await protectVaultFile(file, deps("darwin", fakeDpapi(), keychain));
    mkdirSync(join(dir, "moved"));
    const moved = join(dir, "moved", "vault.json");
    writeFileSync(moved, readFileSync(file, "utf8"));
    const loaded = await loadAccounts(moved, OUTSIDE, deps("darwin", fakeDpapi(), keychain));
    expect(loaded.store).toBeNull();
    expect("blocked" in loaded && loaded.blocked).toMatch(/^the vault file can't be opened: the keychain has no entry for this file's path/);
  });

  it("the security CLI is called with the spec's service, the data on stdin and not in the arguments", async () => {
    const stored = new Map<string, string>();
    const calls: Array<{ args: string[]; input: string }> = [];
    const run: ProcRunner = async (_command, args, input) => {
      calls.push({ args, input });
      if (args[0] === "-i") {
        const hex = /-X ([0-9a-f]+)/.exec(input)?.[1] ?? "";
        const account = /-a "((?:[^"\\]|\\.)*)"/.exec(input)?.[1] ?? "";
        stored.set(account.replace(/\\(.)/g, "$1"), Buffer.from(hex, "hex").toString("utf8"));
        return { code: 0, stdout: "", stderr: "" };
      }
      const account = args[args.indexOf("-a") + 1] ?? "";
      const found = stored.get(account);
      return found === undefined ? { code: 44, stdout: "", stderr: "not found" } : { code: 0, stdout: `${found}\n`, stderr: "" };
    };
    const keychain = securityKeychain(run);
    await keychain.write('/Users/me/my "vault".json', '{"version":2,"vault":{}}');
    expect(await keychain.read('/Users/me/my "vault".json')).toBe('{"version":2,"vault":{}}');
    expect(await keychain.read("/elsewhere")).toBeNull();
    const write = calls.find((c) => c.args[0] === "-i");
    expect(write?.input).toContain(`-s "${KEYCHAIN_SERVICE}"`);
    expect(calls.flatMap((c) => c.args).join(" ")).not.toContain(Buffer.from('{"version":2').toString("hex"));
    expect(calls.find((c) => c.args[0] === "find-generic-password")?.args).toContain(KEYCHAIN_SERVICE);
  });
});

describe("storage: plain files and vault protect", () => {
  it("a system with no protection leaves the file plain and says so", async () => {
    const file = join(tmp(), "vault.json");
    writeFileSync(file, JSON.stringify(FILE));
    const done = await protectVaultFile(file, deps("linux"));
    expect(done.ok).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(FILE);
  });

  it("a version 1 file is protected as version 2, other top-level keys travel inside, and a protected file isn't protected twice", async () => {
    const file = join(tmp(), "accounts.json");
    writeFileSync(file, JSON.stringify({ version: 1, accounts: { tester2: { username: VALUES.username, password: VALUES.password }, phone: { passcode: VALUES.passcode } }, otp: { sources: ["x"] } }));
    const dpapi = fakeDpapi();
    expect((await protectVaultFile(file, deps("win32", dpapi))).ok).toBe(true);
    expect(JSON.parse((dpapi.calls[0]?.data ?? Buffer.alloc(0)).toString("utf8"))).toEqual({
      version: 2,
      vault: { tester2: { kind: "account", username: VALUES.username, password: VALUES.password }, phone: { kind: "phone", passcode: VALUES.passcode } },
      otp: { sources: ["x"] },
    });
    const again = await protectVaultFile(file, deps("win32", dpapi));
    expect(again).toMatchObject({ ok: false });
    expect((again as { message: string }).message).toContain("already protected");
    expect(dpapi.calls).toHaveLength(1);
  });

  it("a missing or invalid file is refused without quoting it", async () => {
    expect((await protectVaultFile(join(tmp(), "nope.json"), deps("win32"))).ok).toBe(false);
    const file = join(tmp(), "vault.json");
    writeFileSync(file, `{"version": 2, "vault": {"a": "${VALUES.password}" `);
    const bad = await protectVaultFile(file, deps("win32"));
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).not.toContain(VALUES.password);
  });
});

// ---- start, doctor and the command -----------------------------------------------------------------------

describe("the warning, doctor and the command", () => {
  const BASE: Partial<DoctorDeps> = {
    run: async () => ({ code: -1, stdout: "", stderr: "" }),
    platform: "linux",
    nodeVersion: "20.11.0",
    env: { TAPLINE_HOME: "/fake/.tapline" },
    fileExists: () => true,
    portFree: async () => true,
    lanIps: () => ["192.168.1.20"],
    hostDir: null,
    gitStatus: async () => null,
  };

  it("doctor lists entries with their kinds and says a plain file is not encrypted", async () => {
    const file = join(tmp(), "vault.json");
    writeFileSync(file, JSON.stringify(FILE));
    const check = (await runDoctor({ ...BASE, accountsFile: file, gitProbe: OUTSIDE })).find((r) => r.name === "Test accounts");
    expect(check?.status).toBe("pass");
    expect(check?.detail).toContain("7 entries: tester2 (account), other (account), home (address)");
    expect(check?.detail).toContain(`Note: the vault file ${file} is not encrypted; keep test data in it only.`);
    for (const [, value] of SCRUBBED) expect(JSON.stringify(check)).not.toContain(value);
  });

  it("start logs the warning and the session's first answer carries it, once", async () => {
    const file = join(tmp(), "vault.json");
    writeFileSync(file, JSON.stringify(FILE));
    const lines: string[] = [];
    const runtime = await createRuntime({ port: 0, host: "127.0.0.1", viewer: "off", env: { TAPLINE_HOME: tmp() }, log: (m) => lines.push(m), accounts: file, gitProbe: OUTSIDE });
    try {
      const note = `Note: the vault file ${file} is not encrypted; keep test data in it only.`;
      expect(lines).toContain(note);
      const tools = runtime.toolsFor(undefined);
      const first = textOf(await tools.typeText({ text: "${vault.home.street}" }));
      expect(first).toContain(note);
      expect(textOf(await tools.typeText({ text: "${vault.home.street}" }))).not.toContain(note);
    } finally {
      await runtime.close();
    }
  });

  it("--accounts takes a version 2 file, and the command is `vault protect FILE`", async () => {
    expect(runtimeOptionsOf(parseCli(["mcp", "--accounts", "/x/vault.json"]).values, {}).accounts).toBe("/x/vault.json");
    expect(parseCli(["vault", "protect", "/x/vault.json"]).positionals).toEqual(["vault", "protect", "/x/vault.json"]);
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      expect(await main(["vault"])).toBe(2);
      expect(await main(["vault", "protect"])).toBe(2);
    } finally {
      process.stderr.write = original;
    }
  });

  it.runIf(process.platform === "win32")("`tapline vault protect FILE` protects a plain file for real on Windows", async () => {
    const file = join(tmp(), "vault.json");
    writeFileSync(file, JSON.stringify(FILE));
    const original = process.stdout.write.bind(process.stdout);
    let said = "";
    process.stdout.write = ((chunk: string | Uint8Array) => ((said += String(chunk)), true)) as typeof process.stdout.write;
    try {
      expect(await main(["vault", "protect", file])).toBe(0);
    } finally {
      process.stdout.write = original;
    }
    expect(said).toContain("Protected");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 2, protected: "dpapi-user" });
    expect(readFileSync(file, "utf8")).not.toContain(VALUES.password);
    expect((await loadAccounts(file, INSIDE)).store?.kindOf("visa")).toBe("card");
  }, 60_000);
});
