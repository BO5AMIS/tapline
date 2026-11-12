import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { auditTitle, formatAudit, type AuditResult } from "../src/audit.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, startHost } from "./helpers.js";

// AGENT-TOOLS 1.8 §10: one report format for both tools.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});
const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

const ALL = ["contrast", "hit_region", "description", "clipped_text", "trait", "overlap", "duplicate_id"];
const RESULT: AuditResult = {
  checked: ALL,
  issues: [
    {
      type: "contrast",
      element: { ref: "e12", role: "text", text: "Already have an account?", frame: { x: 16, y: 700, width: 220, height: 18 } },
      problem: "the text is hard to read against its background (2.8:1, #9b9b9b on #ffffff)",
      fix: "raise the contrast to at least 4.5:1",
      at: { file: "/work/app/src/screens/SignUpScreen.tsx", line: 112, direct: true },
    },
    {
      type: "hit_region",
      element: { ref: "e15", role: "button", label: "×", frame: { x: 390, y: 60, width: 20, height: 20 } },
      problem: "too small to tap reliably (20x20 pt)",
      fix: "make it at least 44x44 pt",
    },
  ],
};

describe("the audit report", () => {
  it("has the shared header, numbered issues with fixes, the source line on its own line, and what was checked", () => {
    expect(formatAudit("Sign up", RESULT, undefined, (f) => f.replace("/work/app/", ""))).toBe(
      [
        'Audit of "Sign up": 2 issues (contrast 1, hit_region 1).',
        '1. contrast: e12 text "Already have an account?" @16,700 220x18: the text is hard to read against its background (2.8:1, #9b9b9b on #ffffff). Fix: raise the contrast to at least 4.5:1.',
        "   at src/screens/SignUpScreen.tsx:112",
        '2. hit_region: e15 button "×" @390,60 20x20: too small to tap reliably (20x20 pt). Fix: make it at least 44x44 pt.',
        "Checked: contrast, hit_region, description, clipped_text, trait, overlap, duplicate_id. Not checked here: dynamic_type, element_detection.",
      ].join("\n"),
    );
  });

  it("says no issues found, and lists only the asked types", () => {
    expect(formatAudit("Sign up", { checked: ["hit_region"], issues: [] }, ["hit_region", "dynamic_type"])).toBe(
      'Audit of "Sign up": no issues found.\nChecked: hit_region. Not checked here: dynamic_type.',
    );
  });

  it("stops at 30 issues", () => {
    const many: AuditResult = { checked: ALL, issues: Array.from({ length: 33 }, () => ({ type: "trait", element: null, problem: "p", fix: "f" })) };
    const out = formatAudit("X", many, undefined);
    expect(out).toContain("30. trait: the screen: p. Fix: f.");
    expect(out).not.toContain("31. ");
    expect(out).toContain("(+3 more issues; pass types to narrow it.)");
  });

  it("names what is known of an issue without an element, and says the screen only when nothing is", () => {
    const issue = (where?: NonNullable<AuditResult["issues"][number]["where"]>): AuditResult => ({
      checked: ALL,
      issues: [{ type: "hit_region", element: null, ...(where !== undefined ? { where } : {}), problem: "p", fix: "f" }],
    });
    const line = (r: AuditResult): string => formatAudit("X", r, undefined).split("\n")[1] ?? "";
    expect(line(issue({ frame: { x: 350.4, y: 40.2, width: 20, height: 19.6 }, label: "Close", text: "x" }))).toBe(
      '1. hit_region: an element at @350,40 20x20 "Close": p. Fix: f.',
    );
    expect(line(issue({ frame: { x: 1, y: 2, width: 3, height: 4 }, text: "Hi" }))).toBe('1. hit_region: an element at @1,2 3x4 "Hi": p. Fix: f.');
    expect(line(issue({ frame: { x: 1, y: 2, width: 3, height: 4 } }))).toBe("1. hit_region: an element at @1,2 3x4: p. Fix: f.");
    expect(line(issue({ label: "Close" }))).toBe('1. hit_region: an element "Close": p. Fix: f.');
    expect(line(issue({}))).toBe("1. hit_region: the screen: p. Fix: f.");
    expect(line(issue())).toBe("1. hit_region: the screen: p. Fix: f.");
  });

  it("names the screen by its route, else the app", () => {
    expect(auditTitle(["Root", "Explore"], "Wayfare")).toBe("Explore");
    expect(auditTitle(["__root", "(tabs)", "index"], "Wayfare")).toBe("Wayfare");
    expect(auditTitle(null, "Wayfare")).toBe("Wayfare");
  });
});

describe("the audit tool", () => {
  it("asks the app and answers the report; an app without audit is told to update", async () => {
    const { host, port } = await startHost();
    hosts.push(host);
    const { app } = await FakeApp.connect(port, { capabilities: ["tree", "audit"] }, (req) => {
      if (req.method === "audit") return { ok: true, result: { checked: ALL, issues: [] } };
      if (req.method === "tree") return { ok: true, result: { screen: { width: 400, height: 800 }, elements: [], route: { names: ["Root", "Profile"] } } };
      return { ok: true, result: {} };
    });
    apps.push(app);
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" } });
    const out = await tools.audit({ types: ["contrast"] });
    expect(textOf(out)).toBe('Audit of "Profile": no issues found.\nChecked: contrast.');
    expect(app.requests.find((r) => r.method === "audit")?.params).toEqual({ types: ["contrast"] });
  });

  it("refuses kindly on an older app", async () => {
    const { host, port } = await startHost();
    hosts.push(host);
    const { app } = await FakeApp.connect(port, { capabilities: ["tree"] });
    apps.push(app);
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" } });
    expect(textOf(await tools.audit({}))).toMatch(/^Error unsupported: this app's Tapline is too old for audit/);
  });
});
