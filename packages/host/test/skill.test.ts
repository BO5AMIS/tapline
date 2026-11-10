import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { formatInstalled, installSkill, isThisSkill, SKILL_NAME, skillSource } from "../src/skill.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoSkill = resolve(here, "..", "..", "..", "skills", SKILL_NAME);
const temps: string[] = [];

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "tapline-skill-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the skill in the repository (Agent Skills format)", () => {
  const text = readFileSync(join(repoSkill, "SKILL.md"), "utf8").replace(/\r\n/g, "\n");
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
  const field = (name: string): string => new RegExp(`^${name}:\\s*(.*)$`, "m").exec(frontmatter)?.[1]?.trim() ?? "";

  it("is named as its folder, in lowercase", () => {
    expect(field("name")).toBe(SKILL_NAME);
    expect(SKILL_NAME).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(isThisSkill(repoSkill)).toBe(true);
  });

  it("has a description of at most 1024 characters that says when to use it", () => {
    const description = field("description");
    expect(description.length).toBeGreaterThan(80);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).toMatch(/Use when/);
  });

  it("stays under 500 lines, and every file it points to exists", () => {
    expect(text.split("\n").length).toBeLessThan(500);
    const links = [...text.matchAll(/\]\((references\/[^)#]+)/g)].map((match) => match[1] ?? "");
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(existsSync(join(repoSkill, link)), link).toBe(true);
  });

  it("carries no token, address or name of a person or app of the owner's", () => {
    const all = [text, ...readdirSync(join(repoSkill, "references")).map((file) => readFileSync(join(repoSkill, "references", file), "utf8"))].join("\n");
    expect(all).not.toMatch(/100\.\d+\.\d+\.\d+|192\.168\.|C:\\Users\\/);
  });

  it("is found from the built CLI's folder", () => {
    // dist sits at packages/host/dist: the build's copy is next to it, the repository's three levels up.
    const found = skillSource(resolve(here, "..", "dist"));
    expect(isThisSkill(found)).toBe(true);
    expect(readFileSync(join(found, "SKILL.md"), "utf8").replace(/\r\n/g, "\n")).toBe(text);
  });
});

describe("tapline skill install", () => {
  it("writes the skill for Claude Code and for other agents, under the user's home", () => {
    const home = temp();
    const { written } = installSkill({ home, source: repoSkill });
    expect(written).toEqual([join(home, ".claude", "skills", SKILL_NAME), join(home, ".agents", "skills", SKILL_NAME)]);
    for (const dir of written) {
      expect(isThisSkill(dir)).toBe(true);
      expect(existsSync(join(dir, "references", "setup.md"))).toBe(true);
    }
  });

  it("with a project, writes into the project and nothing into the home", () => {
    const home = temp();
    const project = temp();
    const { written } = installSkill({ home, project, source: repoSkill });
    expect(written).toEqual([join(project, ".claude", "skills", SKILL_NAME), join(project, ".agents", "skills", SKILL_NAME)]);
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });

  it("replaces an older copy of itself, files that are gone included", () => {
    const home = temp();
    installSkill({ home, source: repoSkill });
    const stale = join(home, ".claude", "skills", SKILL_NAME, "references", "old.md");
    writeFileSync(stale, "from an older version");
    installSkill({ home, source: repoSkill });
    expect(existsSync(stale)).toBe(false);
  });

  it("leaves a folder of that name that is something else alone, and writes nothing", () => {
    const home = temp();
    const other = join(home, ".agents", "skills", SKILL_NAME);
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "SKILL.md"), "---\nname: something-else\ndescription: not ours\n---\n");
    expect(() => installSkill({ home, source: repoSkill })).toThrow(/is not the tapline skill/);
    expect(readFileSync(join(other, "SKILL.md"), "utf8")).toContain("something-else");
    expect(existsSync(join(home, ".claude", "skills", SKILL_NAME))).toBe(false);
  });

  it("refuses a project that isn't a folder", () => {
    expect(() => installSkill({ home: temp(), project: join(temp(), "missing"), source: repoSkill })).toThrow(/is not a folder/);
  });

  it("prints where it wrote and how each agent calls it", () => {
    const text = formatInstalled(["A", "B"], false);
    expect(text).toContain("  A\n  B");
    expect(text).toContain("/tapline");
    expect(text).toContain("$tapline");
    expect(formatInstalled(["A"], true)).toContain("in this project");
  });
});
