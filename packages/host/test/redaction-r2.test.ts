import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaplineTools } from "../src/tools.js";
import type { TaplineHost } from "../src/server.js";
import { FakeApp, startHost } from "./helpers.js";
import { vaultFileSchema, vaultStore } from "../src/accounts.js";
import { formatInspect, type FileAccess, type InspectResult } from "../src/inspect.js";
import { OtpCodes } from "../src/otpclient.js";

// PR 12 review, round 2 (AGENT-TOOLS 1.14 §20.3): redaction leaks in diagnostics. Every value is made up.

const LONG = "Zq7-fake-long-passphrase-for-tests-0123456789-abcdefghijklmnop"; // 62 characters
const LONG_STORE = vaultStore({ version: 2, vault: { tester9: { kind: "account", username: "tester9@example.com", password: LONG } } });

/** Every 12-character piece of a value. */
function pieces(value: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 12 <= value.length; i++) out.push(value.slice(i, i + 12));
  return out;
}
const leaks = (text: string, value: string): string[] => pieces(value).filter((piece) => text.includes(piece));

const ELEMENT = { ref: "e3", type: "TextInput", role: "textfield", testID: "pw", label: "Password", text: "", frame: { x: 0, y: 0, width: 100, height: 40 }, actions: ["press", "type"] };
function inspected(props: Record<string, string>): InspectResult {
  return {
    element: ELEMENT,
    source: { components: ["LoginScreen"], location: { file: "/dev/app/src/Login.tsx", line: 2, column: 5, component: "LoginScreen", direct: true }, props },
  } as unknown as InspectResult;
}
const files: FileAccess = {
  exists: () => true,
  read: () => ["import x from 'y';", `  <TextInput testID="pw" defaultValue="${LONG}" secureTextEntry />`].join("\n"),
};

describe("inspect and source diagnostics redact before they cut (finding 1a)", () => {
  it("a 60-character password in a prop and in the code line leaves no fragment of 12 characters", () => {
    const text = formatInspect(inspected({ defaultValue: JSON.stringify(LONG), testID: '"pw"' }), files, LONG_STORE.redact);
    expect(text).toContain("<tester9's password>");
    expect(leaks(text, LONG)).toEqual([]);
  });

  it("the prop is cut for display only after it is redacted, to 40 characters", () => {
    const text = formatInspect(inspected({ title: JSON.stringify(`${"x".repeat(60)}`) }), files, LONG_STORE.redact);
    expect(text).toContain(`title="${"x".repeat(40)}…"`);
  });

  it("an older app that already cut the prop at 40 characters is scrubbed too (a prefix at a cut)", () => {
    const text = formatInspect(inspected({ defaultValue: JSON.stringify(`${LONG.slice(0, 40)}…`) }), files, LONG_STORE.redact);
    expect(leaks(text, LONG)).toEqual([]);
  });

  it("a value straddling every cut point leaves no fragment of 12 or more characters", () => {
    for (let k = 12; k < LONG.length; k++) {
      const fragment = LONG.slice(0, k);
      for (const text of [`${fragment}…`, fragment, JSON.stringify(`${fragment}…`), `value=${fragment}…(+${LONG.length - k})`, `"${fragment}"`]) {
        const out = LONG_STORE.redact(text);
        expect(leaks(out, LONG), `cut at ${k}: ${JSON.stringify(text)} became ${JSON.stringify(out)}`).toEqual([]);
        expect(out, `cut at ${k}`).not.toContain(fragment);
      }
    }
  });

  it("ordinary text that merely resembles a value's start in under 12 characters is left alone", () => {
    expect(LONG_STORE.redact(`${LONG.slice(0, 8)}…`)).toBe(`${LONG.slice(0, 8)}…`);
  });
});

describe("short secrets are refused at load, never quoting a value (finding 1b)", () => {
  const cases: Array<[string, Record<string, string>]> = [
    ["account", { username: "ab" }],
    ["account", { password: "ab" }],
    ["card", { number: "12" }],
    ["card", { expiry: "1/" }],
    ["card", { cvc: "73" }],
    ["note", { text: "Zq" }],
    ["identity", { phone: "55" }],
    ["identity", { email: "a@" }],
    ["identity", { birthday: "19" }],
  ];
  for (const [kind, fields] of cases) {
    const [field, value] = Object.entries(fields)[0] as [string, string];
    it(`a 2-character ${kind} ${field} is refused with a reason that quotes no value`, () => {
      const parsed = vaultFileSchema.safeParse({ version: 2, vault: { v: { kind, ...fields } } });
      expect(parsed.success).toBe(false);
      const message = JSON.stringify(parsed.success ? {} : parsed.error.issues);
      expect(message).toContain("at least 3");
      expect(message).not.toContain(`"${value}"`);
    });
  }

  it("a 3-character secret loads, and a short address country stays typeable", () => {
    expect(vaultFileSchema.safeParse({ version: 2, vault: { v: { kind: "note", text: "Zq7" } } }).success).toBe(true);
    expect(vaultFileSchema.safeParse({ version: 2, vault: { h: { kind: "address", country: "QA" } } }).success).toBe(true);
  });
});

describe("equivalent escape forms are scrubbed (finding 1c)", () => {
  const VALUE = "Café-Zürich pässword 9137 @ex.com";
  const store = vaultStore({ version: 2, vault: { t: { kind: "note", text: VALUE } } });
  const hex = (code: number, width: number, upper: boolean): string => (upper ? code.toString(16).toUpperCase() : code.toString(16)).padStart(width, "0");
  const forms: Record<string, string> = {
    "json lower": [...VALUE].map((c) => (c.charCodeAt(0) > 127 ? `\\u${hex(c.charCodeAt(0), 4, false)}` : c)).join(""),
    "json upper": [...VALUE].map((c) => (c.charCodeAt(0) > 127 ? `\\u${hex(c.charCodeAt(0), 4, true)}` : c)).join(""),
    "json every char lower": [...VALUE].map((c) => `\\u${hex(c.charCodeAt(0), 4, false)}`).join(""),
    "json every char upper": [...VALUE].map((c) => `\\u${hex(c.charCodeAt(0), 4, true)}`).join(""),
    "json some letters": VALUE.replace(/[aeiou]/g, (c) => `\\u${hex(c.charCodeAt(0), 4, true)}`),
    "percent upper": encodeURIComponent(VALUE),
    "percent lower": encodeURIComponent(VALUE).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()),
    "percent every char upper": [...Buffer.from(VALUE, "utf8")].map((b) => `%${hex(b, 2, true)}`).join(""),
    "percent every char lower": [...Buffer.from(VALUE, "utf8")].map((b) => `%${hex(b, 2, false)}`).join(""),
    "percent letters only": VALUE.replace(/[a-z]/g, (c) => `%${hex(c.charCodeAt(0), 2, true)}`),
    "html hex upper": [...VALUE].map((c) => (c.charCodeAt(0) > 127 ? `&#x${hex(c.charCodeAt(0), 1, true)};` : c)).join(""),
    "html hex lower": [...VALUE].map((c) => (c.charCodeAt(0) > 127 ? `&#x${hex(c.charCodeAt(0), 1, false)};` : c)).join(""),
    "html decimal": [...VALUE].map((c) => (c.charCodeAt(0) > 127 ? `&#${c.charCodeAt(0)};` : c)).join(""),
    "html decimal every char": [...VALUE].map((c) => `&#${c.charCodeAt(0)};`).join(""),
    "json doubled": JSON.stringify(JSON.stringify(VALUE)).slice(1, -1).replace(/\\\\u00([0-9a-f]{2})/g, (_m, h: string) => `\\\\u00${h.toUpperCase()}`),
  };
  for (const [name, form] of Object.entries(forms)) {
    it(`${name}`, () => {
      for (const wrap of [(f: string) => f, (f: string) => `{"a":"${f}"}`, (f: string) => `?q=${f}&x=1`, (f: string) => `see ${f}.`]) {
        const out = store.redact(wrap(form));
        expect(out, name).toContain("<t's text>");
        expect(out, name).not.toContain(form);
      }
    });
  }
});

describe("one-time codes are never forgotten (finding 8)", () => {
  it("25 distinct codes registered: the first is still scrubbed", () => {
    const codes = new OtpCodes();
    const all = Array.from({ length: 25 }, (_, i) => String(100000 + i * 7919));
    for (const code of all) expect(codes.register(code)).toBe(true);
    for (const code of all) expect(codes.redact(`typed ${code}`), code).toBe("typed <one-time code>");
  });

  it("past a large cap a new code is refused, and the old ones stay scrubbed", () => {
    const codes = new OtpCodes();
    const first = "480213";
    expect(codes.register(first)).toBe(true);
    let refused = 0;
    for (let i = 0; i < 1100; i++) if (!codes.register(String(500000 + i))) refused++;
    expect(refused).toBeGreaterThan(0);
    expect(codes.redact(`x${first}y`)).toBe("x<one-time code>y");
  });
});

describe("inspect through the tools (finding 1a, end to end)", () => {
  const hosts: TaplineHost[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((h) => h.close()));
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("a 60-character vault password in a prop and in the source line leaves no 12-character fragment in the answer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tapline-r2-"));
    dirs.push(dir);
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "package.json"), "{}");
    const file = join(dir, "src", "Login.tsx");
    writeFileSync(file, `a\n  <TextInput testID="pw" defaultValue="${LONG}" />\n`);
    const { host, port } = await startHost({ redact: LONG_STORE.redact });
    hosts.push(host);
    const { app } = await FakeApp.connect(port, { capabilities: ["tree", "inspect"] }, (req) =>
      req.method === "inspect"
        ? { ok: true, result: { element: ELEMENT, source: { components: ["Login"], location: { file, line: 2, column: 3, component: "Login", direct: true }, props: { defaultValue: JSON.stringify(LONG), testID: '"pw"' } } } }
        : { ok: true, result: {} },
    );
    try {
      const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, accounts: { store: LONG_STORE } });
      const answer = await tools.inspect({ target: { id: "pw" } });
      const shown = answer.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
      expect(shown).toContain("<tester9's password>");
      expect(leaks(shown, LONG)).toEqual([]);
    } finally {
      app.ws.terminate();
    }
  });
});
