import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunResult, Runner } from "../src/journeyexport.js";
import type { JourneyExport } from "../src/journey.js";
import { rig, textOf, type Rig } from "./journeyhelpers.js";

// AGENT-TOOLS 1.12 §17.5: export to a pull request or an issue, through an injected gh and git. Nothing here runs a real one.

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
});

interface Call {
  command: string;
  args: string[];
  cwd: string | undefined;
  /** For `git add`: the files in the clone then. For a body-file: its text. */
  files?: string[];
  body?: string;
}

const PR_VIEW = { headRefName: "feat/eggs", headRepository: { name: "r" }, headRepositoryOwner: { login: "o" }, isCrossRepository: false, url: "https://github.com/o/r/pull/310" };

function walkFiles(root: string, rel = ""): string[] {
  return readdirSync(join(root, rel), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walkFiles(root, rel === "" ? d.name : `${rel}/${d.name}`) : [rel === "" ? d.name : `${rel}/${d.name}`]));
}

/** A gh and git that only write down what they were asked, and answer from `answer` (else success). */
function fake(answer: (call: Call) => Partial<RunResult> | undefined = () => undefined): { run: Runner; calls: Call[]; words: () => string[] } {
  const calls: Call[] = [];
  const run: Runner = async (command, args, options) => {
    const call: Call = { command, args, cwd: options?.cwd };
    calls.push(call);
    const bodyFile = args[args.indexOf("--body-file") + 1];
    if (args.includes("--body-file") && bodyFile !== undefined) call.body = readFileSync(bodyFile, "utf8");
    if (command === "git" && args[0] === "add" && options?.cwd !== undefined) call.files = walkFiles(options.cwd).filter((f) => !f.startsWith(".git/"));
    if (command === "gh" && args[0] === "repo" && args[1] === "clone") mkdirSync(args[3] ?? "", { recursive: true });
    const custom = answer(call);
    if (custom !== undefined) return { code: 0, stdout: "", stderr: "", ...custom };
    if (command === "gh" && args[0] === "pr" && args[1] === "view") return { code: 0, stdout: JSON.stringify(PR_VIEW), stderr: "" };
    if (command === "gh" && args[0] === "repo" && args[1] === "view") return { code: 0, stdout: JSON.stringify({ visibility: "PRIVATE" }), stderr: "" };
    if (command === "gh" && args[0] === "issue") return { code: 0, stdout: "https://github.com/o/r/issues/7\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  /** Every command in full, the temporary clone and folder named `<clone>` and `<tmp>`. */
  const words = (): string[] => {
    const clone = calls.find((c) => c.args[0] === "repo" && c.args[1] === "clone")?.args[3] ?? "\u0000";
    const tmp = clone.replace(/[\\/]repo$/, "");
    return calls.map((c) => [c.command, ...c.args].join(" ").split(clone).join("<clone>").split(tmp).join("<tmp>").replace(/\\/g, "/"));
  };
  return { run, calls, words };
}

const make = async (run: Runner | undefined): Promise<Rig> => {
  const r = await rig({ tools: run !== undefined ? { exportRunner: run } : {} });
  rigs.push(r);
  return r;
};

/** Home, Settings, back home: three frames, two screens. */
async function journeyAndStop(r: Rig, exportTo: JourneyExport | undefined): Promise<{ said: string; running: boolean }> {
  await r.tools.journey({ start: true, goal: "change the settings", persona: "a first-timer" });
  r.advance(500);
  await r.tools.tap({ target: { text: "Settings" } });
  r.advance(500);
  await r.tools.back({});
  const answer = await r.tools.journey({ stop: true, reached: true, ...(exportTo !== undefined ? { export: exportTo } : {}) });
  return { said: textOf(answer), running: r.tools.currentJourney() !== undefined };
}

const PR: JourneyExport = { to: "pr", repo: "o/r", pr: 310, confirm: true };
const ISSUE: JourneyExport = { to: "issue", repo: "o/r", confirm: true };
const NAME = "2026-11-12-1530-change-the-settings";

describe("export to a pull request", () => {
  it("clones the PR's branch in a temporary folder, commits the report there, pushes, and comments", async () => {
    const gh = fake();
    const r = await make(gh.run);
    const { said } = await journeyAndStop(r, PR);
    expect(gh.words()).toEqual([
      "gh repo view o/r --json visibility", // asked before the journey ends
      "gh auth status",
      "gh pr view 310 --repo o/r --json headRefName,headRepository,headRepositoryOwner,isCrossRepository,url",
      "gh repo view o/r --json visibility",
      "gh repo clone o/r <clone> -- --branch feat/eggs --single-branch --depth 1",
      `git add -f -- .tapline/reports/${NAME}`,
      "git commit -m QA journey report: change the settings",
      "git push origin HEAD:refs/heads/feat/eggs",
      "gh pr comment 310 --repo o/r --body-file <tmp>/comment.md",
    ]);
    const clone = gh.calls[4]?.args[3] ?? "";
    // never the user's working tree: every git command ran inside the temporary clone
    for (const git of gh.calls.filter((c) => c.command === "git")) expect(git.cwd).toBe(clone);
    expect(clone.startsWith(r.dir)).toBe(false);
    expect(existsSync(clone)).toBe(false); // and it is cleaned up
    expect(said).toContain(`Exported: committed 6 files of the report to .tapline/reports/${NAME}/ on branch feat/eggs of o/r, and commented on https://github.com/o/r/pull/310.`);
  });

  it("uploads the report, the GIF and the pictures it uses, not every raw frame, in one commit", async () => {
    const gh = fake();
    const r = await make(gh.run);
    await journeyAndStop(r, PR);
    const added = gh.calls.find((c) => c.command === "git" && c.args[0] === "add")?.files ?? [];
    const base = `.tapline/reports/${NAME}`;
    // the report, the GIF, one picture for each screen of the path, and the finding's picture
    expect([...added].sort()).toEqual(
      [`${base}/report.md`, `${base}/report.html`, `${base}/journey.gif`, `${base}/frames/001.jpg`, `${base}/frames/002.jpg`, `${base}/findings/01-wrong_turn.jpg`].sort(),
    );
    expect(added).not.toContain(`${base}/frames/003.jpg`); // a second visit to a screen: a raw frame the report does not use
    expect(added.some((f) => f.includes("key-"))).toBe(false);
    expect(gh.calls.filter((c) => c.command === "git" && c.args[0] === "commit")).toHaveLength(1);
  });

  it("comments with the summary, the findings and the pictures linked on the branch", async () => {
    const gh = fake();
    const r = await make(gh.run);
    await journeyAndStop(r, PR);
    const comment = gh.calls.find((c) => c.args[0] === "pr" && c.args[1] === "comment");
    expect(comment?.args.slice(0, 5)).toEqual(["pr", "comment", "310", "--repo", "o/r"]);
    const body = comment?.body ?? "";
    expect(body).toContain('Journey "change the settings" as a first-timer: reached in 1 tap');
    expect(body).toContain("Findings: 1 medium.");
    expect(body).toContain(`![The journey](https://github.com/o/r/raw/feat/eggs/.tapline/reports/${NAME}/journey.gif)`);
    expect(body).toContain(`[report.md](https://github.com/o/r/raw/feat/eggs/.tapline/reports/${NAME}/report.md)`);
    expect(body).toContain("wrong_turn");
  });
});

describe("export to an issue", () => {
  it("makes the qa-reports branch as an orphan when it is missing, pushes the report there, and opens an issue", async () => {
    const gh = fake((c) => (c.args[0] === "api" ? { code: 1, stderr: "gh: Not Found (HTTP 404)" } : undefined));
    const r = await make(gh.run);
    const { said } = await journeyAndStop(r, ISSUE);
    const clone = gh.calls.find((c) => c.args[1] === "clone")?.args[3] ?? "";
    expect(gh.words()).toEqual([
      "gh repo view o/r --json visibility", // asked before the journey ends
      "gh auth status",
      "gh repo view o/r --json visibility",
      "gh api repos/o/r/branches/qa-reports --silent",
      "gh repo clone o/r <clone> -- --depth 1 --no-checkout",
      "git checkout --orphan qa-reports",
      "git rm -rf -q --ignore-unmatch .",
      `git add -f -- reports/${NAME}`,
      "git commit -m QA journey report: change the settings",
      "git push origin HEAD:refs/heads/qa-reports",
      "gh issue create --repo o/r --title QA journey: change the settings --body-file <tmp>/issue.md",
    ]);
    for (const git of gh.calls.filter((c) => c.command === "git")) expect(git.cwd).toBe(clone);
    const issue = gh.calls[10];
    expect(issue?.body).toContain("Findings: 1 medium.");
    expect(issue?.body).toContain(`https://github.com/o/r/raw/qa-reports/reports/${NAME}/findings/`);
    expect(said).toContain(`Exported: pushed 6 files of the report to reports/${NAME}/ on branch qa-reports of o/r (made it), and opened an issue: https://github.com/o/r/issues/7`);
  });

  it("uses the branch as it is when it exists", async () => {
    const gh = fake();
    const r = await make(gh.run);
    const { said } = await journeyAndStop(r, ISSUE);
    expect(gh.calls.some((c) => c.args[0] === "checkout")).toBe(false);
    expect(gh.words()[4]).toBe("gh repo clone o/r <clone> -- --branch qa-reports --single-branch --depth 1");
    expect(said).not.toContain("(made it)");
  });
});

describe("the gate", () => {
  it("needs confirm: true inside export, refuses without ending the journey, and runs nothing", async () => {
    const gh = fake();
    const r = await make(gh.run);
    await r.tools.journey({ start: true, goal: "g" });
    const refused = await r.tools.journey({ stop: true, reached: true, export: { to: "issue", repo: "o/r" } });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/^Error bad_params: export writes to your user's GitHub, so it needs confirm: true inside export/);
    expect(r.tools.currentJourney()).toBeDefined();
    expect(gh.calls).toHaveLength(0);
    // with it, the same call goes through
    expect(textOf(await r.tools.journey({ stop: true, reached: true, export: ISSUE }))).toContain("Exported:");
  });

  it("refuses a public repository unless public: true", async () => {
    const gh = fake((c) => (c.args[0] === "repo" && c.args[1] === "view" ? { stdout: JSON.stringify({ visibility: "PUBLIC" }) } : undefined));
    const r = await make(gh.run);
    const { said, running } = await journeyAndStop(r, ISSUE);
    expect(said).toMatch(/^Error not_allowed: o\/r is a public repository, so the report .* would be visible to everyone; export again with public: true if your user wants that\. The journey is still running/);
    // refused before the journey ended: it can be stopped again, with the option, and nothing was written meanwhile
    expect(running).toBe(true);
    expect(gh.calls.some((c) => c.command === "git")).toBe(false);
    const again = textOf(await r.tools.journey({ stop: true, reached: true, export: { ...ISSUE, public: true } }));
    expect(again).toContain("Exported:");
    expect(r.tools.currentJourney()).toBeUndefined();
  });

  it("will not write when it cannot tell whether the repository is public", async () => {
    const gh = fake((c) => (c.args[0] === "repo" && c.args[1] === "view" ? { stdout: "{}" } : undefined));
    const r = await make(gh.run);
    expect((await journeyAndStop(r, ISSUE)).said).toContain("couldn't tell whether o/r is public, so it wrote nothing");
  });

  it("refuses a pull request whose branch lives in a fork unless fork: true, and names where it would write", async () => {
    const forked = { ...PR_VIEW, headRepository: { name: "r-fork" }, headRepositoryOwner: { login: "someone" }, isCrossRepository: true };
    const answers = (c: Call): Partial<RunResult> | undefined => (c.args[0] === "pr" && c.args[1] === "view" ? { stdout: JSON.stringify(forked) } : undefined);
    const gh = fake(answers);
    const r = await make(gh.run);
    const { said } = await journeyAndStop(r, PR);
    expect(said).toContain("the pull request's branch lives in someone/r-fork, not o/r, so the report would be written there; export again with fork: true");
    expect(gh.calls.some((c) => c.command === "git")).toBe(false);
    const ok = fake(answers);
    const r2 = await make(ok.run);
    const done = (await journeyAndStop(r2, { ...PR, fork: true })).said;
    expect(ok.calls.find((c) => c.args[1] === "clone")?.args[2]).toBe("someone/r-fork");
    expect(ok.calls.find((c) => c.args[1] === "comment")?.args.slice(0, 5)).toEqual(["pr", "comment", "310", "--repo", "o/r"]);
    expect(done).toContain("on branch feat/eggs of someone/r-fork, and commented on");
  });

  it("a fork's own visibility is checked too", async () => {
    const forked = { ...PR_VIEW, headRepository: { name: "r-fork" }, headRepositoryOwner: { login: "someone" }, isCrossRepository: true };
    const gh = fake((c) => {
      if (c.args[0] === "pr" && c.args[1] === "view") return { stdout: JSON.stringify(forked) };
      if (c.args[0] === "repo" && c.args[1] === "view" && c.args[2] === "someone/r-fork") return { stdout: JSON.stringify({ visibility: "PUBLIC" }) };
      return undefined;
    });
    const r = await make(gh.run);
    expect((await journeyAndStop(r, { ...PR, fork: true })).said).toContain("someone/r-fork is a public repository");
  });
});

describe("when something goes wrong the report stays local and the stop still answers", () => {
  const stays = (said: string) => {
    expect(said).toMatch(/^Journey "change the settings"/);
    const folder = /The report stays local: (.+)$/m.exec(said)?.[1] ?? "";
    expect(existsSync(join(folder, "report.md"))).toBe(true);
  };

  it("gh is not installed", async () => {
    const r = await make(fake((c) => (c.command === "gh" ? { code: null, missing: true, stderr: "spawn gh ENOENT" } : undefined)).run);
    const { said } = await journeyAndStop(r, ISSUE);
    expect(said).toContain("Export failed: the GitHub CLI (gh) isn't installed or isn't on the PATH; install it from https://cli.github.com and sign in with `gh auth login`.");
    stays(said);
  });

  it("gh is not signed in", async () => {
    const r = await make(fake((c) => (c.args[0] === "auth" ? { code: 1, stderr: "You are not logged in to any GitHub hosts. To log in, run: gh auth login" } : undefined)).run);
    const { said } = await journeyAndStop(r, PR);
    expect(said).toContain("Export failed: gh isn't signed in; run `gh auth login`, then export again.");
    stays(said);
  });

  it("no access to the repository or the pull request", async () => {
    const r = await make(fake((c) => (c.args[0] === "pr" ? { code: 1, stderr: "GraphQL: Could not resolve to a PullRequest with the number of 310. (repository.pullRequest)" } : undefined)).run);
    const { said } = await journeyAndStop(r, PR);
    expect(said).toContain("Export failed: GitHub says o/r (or that pull request) wasn't found, or you have no access to it.");
    stays(said);
  });

  it("a push that is refused", async () => {
    const r = await make(fake((c) => (c.args[0] === "push" ? { code: 1, stderr: "remote: Permission to o/r.git denied to someone.\nfatal: unable to access" } : undefined)).run);
    const { said } = await journeyAndStop(r, PR);
    expect(said).toContain("Export failed: git push was refused: you may have no write access to o/r, or the branch is protected.");
    stays(said);
  });

  it("a comment that fails after the push says what was already pushed", async () => {
    const r = await make(fake((c) => (c.args[0] === "pr" && c.args[1] === "comment" ? { code: 1, stderr: "HTTP 502" } : undefined)).run);
    const { said } = await journeyAndStop(r, PR);
    expect(said).toMatch(/Export failed: gh pr comment failed: HTTP 502 \(the report was already pushed to \.tapline\/reports\/.* on feat\/eggs of o\/r\)\./);
    stays(said);
  });

  it("a runner that throws", async () => {
    const r = await make(async () => {
      throw new Error("the runner broke");
    });
    const { said, running } = await journeyAndStop(r, ISSUE);
    expect(said).toContain("Export failed: the runner broke.");
    expect(running).toBe(false);
    stays(said);
  });

  it("tokens never reach a message", async () => {
    const r = await make(fake((c) => (c.args[0] === "commit" ? { code: 1, stderr: "fatal: could not read from https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/o/r.git" } : undefined)).run);
    const { said } = await journeyAndStop(r, PR);
    expect(said).not.toContain("ghp_");
    expect(said).not.toContain("x-access-token");
  });

  it("a repo that is not owner/name", async () => {
    const gh = fake();
    const r = await make(gh.run);
    const { said } = await journeyAndStop(r, { to: "issue", repo: "not a repo", confirm: true });
    expect(said).toContain('Export failed: export repo "not a repo" isn\'t owner/name.');
    expect(gh.calls).toHaveLength(0);
  });

  it("a host with no gh runner says so", async () => {
    const r = await make(undefined);
    const { said } = await journeyAndStop(r, ISSUE);
    expect(said).toMatch(/Export isn't available here \(this host has no gh runner\); the report stays local: /);
  });
});
