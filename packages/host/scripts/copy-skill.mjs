// Copies the agent skill (skills/tapline at the repository root) next to the built CLI, so the
// published package carries it and `tapline skill install` finds it. The copy is generated: edit
// the one at the repository root.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "..", "..", "..", "skills", "tapline");
const target = resolve(here, "..", "skills", "tapline");

if (!existsSync(resolve(source, "SKILL.md"))) {
  throw new Error(`No skill at ${source}`);
}
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
console.log(`copied the skill to ${target}`);
