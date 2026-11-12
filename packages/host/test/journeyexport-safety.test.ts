import { mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportReport, inert, type Runner } from "../src/journeyexport.js";
import { isReportPicture } from "../src/journeyreport.js";

// 1.5 review, findings 7 and 12: what app text can do to an export, and a cleanup that can't fail a done export.

describe("the report's own pictures only", () => {
  it("takes plain relative picture paths, nothing else", () => {
    expect(isReportPicture("journey.gif")).toBe(true);
    expect(isReportPicture("frames/f001.jpg")).toBe(true);
    expect(isReportPicture("keys/end.png")).toBe(true);
    expect(isReportPicture("../../.tapline/token")).toBe(false);
    expect(isReportPicture("frames/../../token.png")).toBe(false);
    expect(isReportPicture("/etc/passwd.png")).toBe(false);
    expect(isReportPicture("C:/Users/x.png")).toBe(false);
    expect(isReportPicture("report.md")).toBe(false);
  });
});

describe("app text in a GitHub comment", () => {
  it("can't ping, add a picture or link, or write HTML", () => {
    const out = inert('Hi @owner ![x](https://evil.example/p.png) <img src=x> [link](http://a.b) *bold*');
    expect(out).not.toMatch(/@owner/);
    // every markdown or HTML character comes escaped with a backslash
    expect(out).not.toMatch(/(?<!\\)!/);
    expect(out).not.toMatch(/(?<!\\)\[/);
    expect(out).not.toMatch(/(?<!\\)<img/);
    expect(out).not.toMatch(/https?:\/\//);
    expect(out).toContain("\\*bold\\*");
  });

  it("can't add a link with a bare www. address either", () => {
    const out = inert("visit www.evil.example now, or (WWW.Evil.example)");
    expect(out).not.toMatch(/www\./i);
    expect(out).toContain("www​.evil.example");
  });
});

describe("export refuses a file outside the report folder", () => {
  it("answers a failure and copies nothing when the list names ../", async () => {
    const folder = mkdtempSync(join(tmpdir(), "tapline-report-"));
    writeFileSync(join(folder, "report.md"), "# r");
    const calls: string[] = [];
    const run: Runner = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "gh" && args[0] === "auth") return { code: 0, stdout: "", stderr: "" };
      if (command === "gh" && args[0] === "repo") return { code: 0, stdout: JSON.stringify({ visibility: "PRIVATE" }), stderr: "" };
      if (command === "git" && args.includes("ls-remote")) return { code: 2, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const tmp = mkdtempSync(join(tmpdir(), "tapline-export-test-"));
    mkdirSync(join(tmp, "repo"), { recursive: true });
    const outcome = await exportReport(
      {
        target: { to: "issue", repo: "owner/name", confirm: true },
        folder,
        name: "r1",
        goal: "g",
        summary: "s",
        findingsLine: "f",
        findings: [],
        files: ["report.md", "../../.tapline/token"],
        headline: undefined,
      },
      run,
      () => tmp,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toMatch(/outside its folder/);
  });

  it("writes nothing through a link the repository holds where the report goes (Codex review of 1.5.0)", async () => {
    const folder = mkdtempSync(join(tmpdir(), "tapline-report-"));
    writeFileSync(join(folder, "report.md"), "# r");
    const outside = mkdtempSync(join(tmpdir(), "tapline-outside-"));
    const run: Runner = async (command, args) => {
      if (command === "gh" && args[0] === "repo") return { code: 0, stdout: JSON.stringify({ visibility: "PRIVATE" }), stderr: "" };
      if (command === "git" && args.includes("ls-remote")) return { code: 2, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const tmp = mkdtempSync(join(tmpdir(), "tapline-export-test-"));
    mkdirSync(join(tmp, "repo"), { recursive: true });
    // a checkout that made the repository's `reports` link real ("junction" works without admin on Windows)
    symlinkSync(outside, join(tmp, "repo", "reports"), "junction");
    const outcome = await exportReport(
      { target: { to: "issue", repo: "owner/name", confirm: true }, folder, name: "r1", goal: "g", summary: "s", findingsLine: "f", findings: [], files: ["report.md"], headline: undefined },
      run,
      () => tmp,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toMatch(/link/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("refuses repo names with .. or a leading dash", async () => {
    const run: Runner = async () => ({ code: 0, stdout: "", stderr: "" });
    for (const repo of ["../x", "-owner/name", "owner/..", "owner/.git"]) {
      const outcome = await exportReport(
        { target: { to: "issue", repo, confirm: true }, folder: tmpdir(), name: "r", goal: "g", summary: "s", findingsLine: "f", findings: [], files: [], headline: undefined },
        run,
      );
      expect(outcome.ok).toBe(false);
    }
  });
});
