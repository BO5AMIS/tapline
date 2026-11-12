import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportReport, type RunResult, type Runner } from "../src/journeyexport.js";

// 1.5 review, finding 12: the issue export against real git. A local bare repository stands in for GitHub; `gh` is
// faked, and its `repo clone` runs a real `git clone` of the bare repository. The qa-reports branch is made as an
// orphan the first time (none of the project's files on it) and gets the next report on top the second time.

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Tapline test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Tapline test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
}

function realRun(command: string, args: string[], cwd?: string): RunResult {
  try {
    const stdout = execFileSync(command, args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
  }
}

function report(root: string, name: string): string {
  const folder = join(root, name);
  mkdirSync(join(folder, "frames"), { recursive: true });
  writeFileSync(join(folder, "report.md"), `# ${name}\n![The journey](frames/001.jpg)\n`);
  writeFileSync(join(folder, "report.html"), `<h1>${name}</h1>`);
  writeFileSync(join(folder, "frames", "001.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  return folder;
}

describe("export to an issue, against real git", () => {
  it("makes qa-reports as an orphan the first time, then adds the next report on top", async () => {
    const root = mkdtempSync(join(tmpdir(), "tapline-export-git-"));
    const remote = join(root, "remote.git");
    git(["init", "--bare", "-q", "-b", "main", remote]);
    // The project's own history on main, which must never reach the qa-reports branch.
    const seed = join(root, "seed");
    git(["clone", "-q", remote, seed]);
    writeFileSync(join(seed, "app.ts"), "export {};\n");
    git(["add", "app.ts"], seed);
    git(["commit", "-q", "-m", "the app"], seed);
    git(["push", "-q", "origin", "HEAD:refs/heads/main"], seed);

    const issues: string[] = [];
    const run: Runner = async (command, args, options) => {
      if (command === "git") return realRun("git", args, options?.cwd);
      if (args[0] === "auth") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "repo" && args[1] === "view") return { code: 0, stdout: JSON.stringify({ visibility: "PRIVATE" }), stderr: "" };
      if (args[0] === "api") {
        const has = realRun("git", ["--git-dir", remote, "rev-parse", "--verify", "-q", "refs/heads/qa-reports"]);
        return has.code === 0 ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "HTTP 404: Branch not found" };
      }
      if (args[0] === "repo" && args[1] === "clone") {
        // gh repo clone <repo> <dir> -- <git clone flags>
        const dir = args[3] ?? "";
        const extra = args.slice(args.indexOf("--") + 1);
        return realRun("git", ["clone", "-q", ...extra, `file://${remote.replace(/\\/g, "/")}`, dir]);
      }
      if (args[0] === "issue") {
        issues.push(args.join(" "));
        return { code: 0, stdout: `https://github.com/owner/name/issues/${issues.length}\n`, stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
    };
    let temp = 0;
    const makeTemp = (): string => mkdtempSync(join(root, `work-${++temp}-`));
    const input = (name: string) => ({
      target: { to: "issue" as const, repo: "owner/name", confirm: true },
      folder: report(join(root, "reports"), name),
      name,
      goal: `goal ${name}`,
      summary: "s",
      findingsLine: "Findings: none.",
      findings: [],
      files: ["frames/001.jpg", "report.html", "report.md"],
      headline: "frames/001.jpg",
    });

    const first = await exportReport(input("r1"), run, makeTemp);
    expect(first).toMatchObject({ ok: true });
    if (first.ok) expect(first.lines[0]).toMatch(/to reports\/r1\/ on branch qa-reports of owner\/name \(made it\), and opened an issue: https:\/\/github\.com\/owner\/name\/issues\/1/);
    const second = await exportReport(input("r2"), run, makeTemp);
    expect(second).toMatchObject({ ok: true });

    const files = git(["--git-dir", remote, "ls-tree", "-r", "--name-only", "qa-reports"]).trim().split(/\r?\n/).sort();
    expect(files).toEqual([
      "reports/r1/frames/001.jpg",
      "reports/r1/report.html",
      "reports/r1/report.md",
      "reports/r2/frames/001.jpg",
      "reports/r2/report.html",
      "reports/r2/report.md",
    ]);
    // an orphan: none of main's history, two commits of its own
    expect(git(["--git-dir", remote, "rev-list", "--count", "qa-reports"]).trim()).toBe("2");
    expect(git(["--git-dir", remote, "ls-tree", "-r", "--name-only", "main"]).trim()).toBe("app.ts");
    expect(issues).toHaveLength(2);
  }, 60_000);
});
