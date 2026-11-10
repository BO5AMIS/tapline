import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The skill's name: its folder, its `name` in SKILL.md, and what a user types (`/tapline`, `$tapline`). */
export const SKILL_NAME = "tapline";

/**
 * Where agents look for skills, relative to a home directory or a project:
 * - `.claude/skills` is Claude Code's;
 * - `.agents/skills` is the cross-agent place the Agent Skills format names, which Codex and
 *   other agents read.
 */
export const SKILL_ROOTS = [".claude/skills", ".agents/skills"] as const;

/** Whether a folder holds this skill: a SKILL.md whose frontmatter names it. */
export function isThisSkill(dir: string): boolean {
  try {
    const head = readFileSync(join(dir, "SKILL.md"), "utf8").slice(0, 2000);
    return new RegExp(`^name:\\s*["']?${SKILL_NAME}["']?\\s*$`, "m").test(head);
  } catch {
    return false;
  }
}

/**
 * Where the skill is. Running from a clone, that is the repository's own copy
 * (`<repo>/skills/tapline`): the one people edit, so it is never stale. In the published package
 * there is no repository around the CLI, and it is the copy the build put next to it
 * (`<package>/skills/tapline`).
 */
export function skillSource(from: string = dirname(fileURLToPath(import.meta.url))): string {
  const candidates = [resolve(from, "..", "..", "..", "skills", SKILL_NAME), resolve(from, "..", "skills", SKILL_NAME)];
  const found = candidates.find((dir) => isThisSkill(dir));
  if (found === undefined) {
    throw new Error(`The skill's files weren't found (looked in ${candidates.join(" and ")}). Build Tapline first: npm run build.`);
  }
  return found;
}

export interface InstallSkillOptions {
  /** Install into this project (its `.claude/skills` and `.agents/skills`) instead of the user's home. */
  project?: string;
  /** The user's home directory (tests). */
  home?: string;
  /** The skill folder to copy (tests). */
  source?: string;
}

/**
 * Copies the skill where Claude Code, Codex and other agents find it, and returns the folders it
 * wrote. A copy of this skill already there is replaced; a folder of that name that is something
 * else is left alone, with an error.
 */
export function installSkill(options: InstallSkillOptions = {}): { written: string[] } {
  const source = options.source ?? skillSource();
  const base = options.project !== undefined ? resolve(options.project) : (options.home ?? homedir());
  if (options.project !== undefined && !(existsSync(base) && statSync(base).isDirectory())) {
    throw new Error(`${base} is not a folder. Pass the project's folder to --project.`);
  }
  const targets = SKILL_ROOTS.map((root) => join(base, root, SKILL_NAME));
  // Check both before writing either, so a refusal leaves nothing half done.
  for (const target of targets) {
    if (existsSync(target) && !isThisSkill(target)) {
      throw new Error(`${target} exists and is not the ${SKILL_NAME} skill. Move it away first; nothing was written.`);
    }
  }
  for (const target of targets) {
    rmSync(target, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true });
  }
  return { written: targets };
}

/** What `tapline skill install` prints. */
export function formatInstalled(written: string[]): string {
  return [
    // The first lines are the same as `tapwright skill install` prints.
    `Installed the ${SKILL_NAME} skill:`,
    ...written.map((path) => `  ${path}`),
    "",
    `Claude Code reads the first (type /${SKILL_NAME}), Codex and other agents the second (in Codex: $${SKILL_NAME}).`,
    "Start a new agent session to pick it up. The skill needs Tapline's MCP server too:",
    "  Claude Code:  claude mcp add tapline -- tapline mcp",
    '  Codex:        in ~/.codex/config.toml:  [mcp_servers.tapline]  command = "tapline"  args = ["mcp"]',
    "  Others:       register the stdio command `tapline mcp` under the name tapline",
  ].join("\n");
}
