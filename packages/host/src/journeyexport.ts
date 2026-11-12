import { execFile } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Finding } from "./journeyreport.js";
import type { JourneyExport } from "./journey.js";

/**
 * Export of a journey report to GitHub (AGENT-TOOLS 1.12 §17.5), only when `stop` carries `export` with `confirm`.
 * It runs through the user's own `gh` and git, by a runner that tests replace. It works in a temporary clone, never
 * the user's working tree, writes one commit holding only the report's files (not every raw frame), and the report
 * stays local when anything fails.
 */

export interface RunResult {
  /** The exit code; null when the program couldn't start. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** The program isn't installed (or not on the PATH). */
  missing?: boolean;
}

export type Runner = (command: string, args: string[], options?: { cwd?: string }) => Promise<RunResult>;

/** The real runner: the user's own `gh` and `git`. Only the host's `mcp` command builds one; tests never do. */
export const realRunner: Runner = (command, args, options) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}), timeout: 120_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" } },
      (error, stdout, stderr) => {
        if (error === null) return resolve({ code: 0, stdout, stderr });
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return resolve({ code: null, stdout, stderr: error.message, missing: true });
        resolve({ code: typeof code === "number" ? code : 1, stdout, stderr: stderr !== "" ? stderr : error.message });
      },
    );
  });

export interface ExportInput {
  target: JourneyExport;
  /** The report folder on this computer, and its name. */
  folder: string;
  name: string;
  goal: string;
  summary: string;
  findingsLine: string;
  findings: readonly Finding[];
  /** The files to upload, relative to the folder: the report, its GIF and the pictures it uses; never every raw frame. */
  files: readonly string[];
  /** What the comment shows first: the GIF, else the first picture of the path. */
  headline: string | undefined;
}

export type ExportOutcome = { ok: true; lines: string[] } | { ok: false; message: string };

/** owner/name as GitHub allows them: no leading dash or dot, no `..` (1.5 review, finding 7). */
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const QA_BRANCH = "qa-reports";

/** Tokens never reach a message. */
function plain(text: string): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "") ?? "";
  return line.replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "***").replace(/(https?:\/\/)[^/@\s]+@/g, "$1").slice(0, 240);
}

function explain(result: RunResult, what: string, repo: string): string {
  if (result.missing === true) {
    return "the GitHub CLI (gh) isn't installed or isn't on the PATH; install it from https://cli.github.com and sign in with `gh auth login`";
  }
  const said = `${result.stderr}\n${result.stdout}`;
  if (/not logged in|gh auth login|authentication required|bad credentials|requires authentication/i.test(said)) {
    return "gh isn't signed in; run `gh auth login`, then export again";
  }
  if (what.startsWith("git push") && /permission|403|denied|protected branch|not allowed|forbidden/i.test(said)) {
    return `${what} was refused: you may have no write access to ${repo}, or the branch is protected`;
  }
  if (/could not resolve|404|not found|no such/i.test(said)) {
    return `GitHub says ${repo} (or that pull request) wasn't found, or you have no access to it`;
  }
  if (/permission|403|forbidden/i.test(said)) return `you have no access to ${repo} (${plain(said)})`;
  const reason = plain(said);
  return `${what} failed${reason !== "" ? `: ${reason}` : ""}`;
}

/** `https://github.com/owner/name/raw/branch/path`: opens for people signed in to GitHub, private repositories too. */
function rawUrl(repo: string, branch: string, path: string): string {
  const encode = (value: string): string => value.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${repo}/raw/${encode(branch)}/${encode(path)}`;
}

/**
 * App text made inert in a GitHub comment: no @mention that pings, no picture, link or HTML it can add (finding 7).
 * Markdown's own escapes, a zero-width space after `@`, and links broken so they don't render.
 */
export function inert(text: string): string {
  return text
    .replace(/[\\`*_[\]<>|!]/g, (c) => `\\${c}`)
    .replace(/@/g, "@\u200b")
    .replace(/(https?):\/\//gi, "$1\u200b://");
}

function bodyOf(input: ExportInput, pictureUrl: (relative: string) => string, reportUrl: string, all: boolean): string {
  const lines: string[] = [inert(input.summary), "", input.findingsLine, ""];
  if (input.headline !== undefined) lines.push(`![The journey](${pictureUrl(input.headline)})`, "");
  const shown = all ? input.findings : input.findings.slice(0, 8);
  shown.forEach((f, i) => {
    lines.push(`${i + 1}. **${f.severity}** ${f.kind}: ${inert(f.title)}`);
    if (all && f.shot !== undefined) lines.push("", `![Finding ${i + 1}](${pictureUrl(f.shot)})`, "");
  });
  if (!all && input.findings.length > shown.length) lines.push(`(+${input.findings.length - shown.length} more in the report.)`);
  lines.push("", `Full report: [report.md](${reportUrl}) (also report.html in the same folder).`, "", "Written by Tapline.");
  return lines.join("\n");
}

function validTarget(target: JourneyExport): string | null {
  if (!REPO.test(target.repo) || target.repo.includes("..")) return `export repo ${JSON.stringify(target.repo)} isn't owner/name`;
  if (target.to === "pr" && (target.pr === undefined || !Number.isInteger(target.pr) || target.pr < 1)) return "export to a pull request needs its number";
  return null;
}

function safeBranch(branch: string): boolean {
  return branch !== "" && !branch.startsWith("-") && !/[\s~^:?*[\\]|\.\.|@\{/.test(branch);
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}

/**
 * Makes the folders from `base` down to `dir` one at a time, refusing any that is a link (a symlink or a junction):
 * a repository can hold a `reports` link that points out of the clone (Codex review of 1.5.0).
 */
function makeFoldersInside(base: string, dir: string): void {
  const steps = relative(base, dir).split(sep).filter((step) => step !== "");
  let at = base;
  for (const step of steps) {
    at = join(at, step);
    if (existsSync(at) || isLink(at)) {
      if (isLink(at) || !lstatSync(at).isDirectory()) throw new Error(`the repository has a link or a file where the report goes (${step}); nothing was exported`);
    } else {
      mkdirSync(at);
    }
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The files, and only them, into `into` (made if need be), keeping their folders. Both ends are checked: a source is
 * a plain file inside the report folder, and every folder and file written is inside the clone, with no link on the way.
 */
function copyReport(folder: string, clone: string, into: string, files: readonly string[]): void {
  const root = realpathSync(resolve(folder));
  const cloneRoot = realpathSync(resolve(clone));
  const target = resolve(into);
  if (!inside(resolve(clone), target)) throw new Error("the report would go outside the clone; nothing was exported");
  for (const file of files) {
    // Never outside the report folder, whatever a list holds (1.5 review, finding 7).
    const from = resolve(root, file);
    if (isAbsolute(file) || file.split(/[\\/]/).includes("..") || !inside(root, from)) {
      throw new Error(`the report lists a file outside its folder (${JSON.stringify(file)}); nothing was exported`);
    }
    if (isLink(from) || !inside(root, realpathSync(from))) {
      throw new Error(`the report lists a link (${JSON.stringify(file)}); nothing was exported`);
    }
    const to = join(target, file);
    makeFoldersInside(resolve(clone), dirname(to));
    if (!inside(cloneRoot, realpathSync(dirname(to)))) throw new Error("the report would go outside the clone; nothing was exported");
    if (isLink(to)) throw new Error(`the repository has a link where a report file goes (${JSON.stringify(file)}); nothing was exported`);
    copyFileSync(from, to);
  }
}

/** A public repository is refused unless the agent said `public: true`; what can't be read is refused too. */
async function visibilityRefusal(run: Runner, repo: string, allowed: boolean): Promise<string | null> {
  const seen = await run("gh", ["repo", "view", repo, "--json", "visibility"]);
  if (seen.code !== 0) return explain(seen, "gh repo view", repo);
  let visibility = "";
  try {
    const parsed: unknown = JSON.parse(seen.stdout);
    if (typeof parsed === "object" && parsed !== null && "visibility" in parsed && typeof parsed.visibility === "string") visibility = parsed.visibility.toUpperCase();
  } catch {
    // refused below
  }
  if (visibility === "") return `Tapline couldn't tell whether ${repo} is public, so it wrote nothing`;
  if (visibility === "PUBLIC" && !allowed) {
    return `${repo} is a public repository, so the report (screenshots of the app included) would be visible to everyone; export again with public: true if your user wants that`;
  }
  return null;
}

/**
 * Puts the report on GitHub. `{to: "pr"}`: into the pull request's own branch under `.tapline/reports/<name>/`, with a
 * comment. `{to: "issue"}`: to the `qa-reports` branch (made as an orphan when missing), with an issue linking it.
 */
export async function exportReport(input: ExportInput, run: Runner, makeTemp: () => string = () => mkdtempSync(join(tmpdir(), "tapline-export-"))): Promise<ExportOutcome> {
  if (input.target.confirm !== true) return { ok: false, message: "export needs confirm: true (your user asked for it)" };
  const bad = validTarget(input.target);
  if (bad !== null) return { ok: false, message: bad };
  const repo = input.target.repo;
  const tmp = makeTemp();
  const clone = join(tmp, "repo");
  try {
    const auth = await run("gh", ["auth", "status"]);
    if (auth.code !== 0) return { ok: false, message: explain(auth, "gh auth status", repo) };
    return input.target.to === "pr" ? await toPullRequest(input, run, repo, input.target.pr ?? 0, tmp, clone) : await toIssue(input, run, repo, tmp, clone);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    // A temporary folder that won't go away must not turn a done export into a failure (finding 12).
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // left for the system to clean up
    }
  }
}

async function toPullRequest(input: ExportInput, run: Runner, repo: string, pr: number, tmp: string, clone: string): Promise<ExportOutcome> {
  const view = await run("gh", ["pr", "view", String(pr), "--repo", repo, "--json", "headRefName,headRepository,headRepositoryOwner,isCrossRepository,url"]);
  if (view.code !== 0) return { ok: false, message: explain(view, "gh pr view", repo) };
  let head = "";
  let url = `https://github.com/${repo}/pull/${pr}`;
  let headRepo = repo;
  try {
    const parsed: unknown = JSON.parse(view.stdout);
    if (typeof parsed === "object" && parsed !== null) {
      const o = parsed as Record<string, unknown>;
      if (typeof o["headRefName"] === "string") head = o["headRefName"];
      if (typeof o["url"] === "string") url = o["url"];
      const owner = typeof o["headRepositoryOwner"] === "object" && o["headRepositoryOwner"] !== null ? (o["headRepositoryOwner"] as Record<string, unknown>)["login"] : undefined;
      const name = typeof o["headRepository"] === "object" && o["headRepository"] !== null ? (o["headRepository"] as Record<string, unknown>)["name"] : undefined;
      if (typeof owner === "string" && typeof name === "string") headRepo = `${owner}/${name}`;
      else if (o["isCrossRepository"] === true) headRepo = "";
    }
  } catch {
    return { ok: false, message: "gh pr view answered something Tapline couldn't read" };
  }
  if (!safeBranch(head)) return { ok: false, message: "the pull request's branch name isn't one Tapline will push to" };
  if (headRepo === "") return { ok: false, message: "the pull request's head repository couldn't be told, so nothing was written" };
  const fork = headRepo.toLowerCase() !== repo.toLowerCase();
  if (fork && input.target.fork !== true) {
    return { ok: false, message: `the pull request's branch lives in ${headRepo}, not ${repo}, so the report would be written there; export again with fork: true if your user wants that, or export to an issue` };
  }
  const refusedComment = await visibilityRefusal(run, repo, input.target.public === true);
  if (refusedComment !== null) return { ok: false, message: refusedComment };
  if (fork) {
    const refusedFork = await visibilityRefusal(run, headRepo, input.target.public === true);
    if (refusedFork !== null) return { ok: false, message: refusedFork };
  }
  const cloned = await run("gh", ["repo", "clone", headRepo, clone, "--", "--branch", head, "--single-branch", "--depth", "1"]);
  if (cloned.code !== 0) return { ok: false, message: explain(cloned, "gh repo clone", headRepo) };
  const where = `.tapline/reports/${input.name}`;
  copyReport(input.folder, clone, join(clone, where), input.files);
  const git = async (args: string[], what: string): Promise<string | null> => {
    const done = await run("git", args, { cwd: clone });
    return done.code === 0 ? null : explain(done, what, headRepo);
  };
  const failure =
    (await git(["add", "-f", "--", where], "git add")) ??
    (await git(["commit", "-m", `QA journey report: ${input.goal}`.slice(0, 120)], "git commit")) ??
    (await git(["push", "origin", `HEAD:refs/heads/${head}`], "git push"));
  if (failure !== null) return { ok: false, message: failure };
  const comment = join(tmp, "comment.md");
  writeFileSync(comment, bodyOf(input, (p) => rawUrl(headRepo, head, `${where}/${p}`), rawUrl(headRepo, head, `${where}/report.md`), false), "utf8");
  const posted = await run("gh", ["pr", "comment", String(pr), "--repo", repo, "--body-file", comment]);
  if (posted.code !== 0) return { ok: false, message: `${explain(posted, "gh pr comment", repo)} (the report was already pushed to ${where}/ on ${head} of ${headRepo})` };
  return { ok: true, lines: [`Exported: committed ${input.files.length} files of the report to ${where}/ on branch ${head} of ${headRepo}, and commented on ${url}.`] };
}

async function toIssue(input: ExportInput, run: Runner, repo: string, tmp: string, clone: string): Promise<ExportOutcome> {
  const refused = await visibilityRefusal(run, repo, input.target.public === true);
  if (refused !== null) return { ok: false, message: refused };
  const branch = await run("gh", ["api", `repos/${repo}/branches/${QA_BRANCH}`, "--silent"]);
  const exists = branch.code === 0;
  if (!exists && !/404|not found/i.test(`${branch.stderr}${branch.stdout}`)) return { ok: false, message: explain(branch, "gh api", repo) };
  const cloned = exists
    ? await run("gh", ["repo", "clone", repo, clone, "--", "--branch", QA_BRANCH, "--single-branch", "--depth", "1"])
    : await run("gh", ["repo", "clone", repo, clone, "--", "--depth", "1", "--no-checkout"]);
  if (cloned.code !== 0) return { ok: false, message: explain(cloned, "gh repo clone", repo) };
  const git = async (args: string[], what: string): Promise<string | null> => {
    const done = await run("git", args, { cwd: clone });
    return done.code === 0 ? null : explain(done, what, repo);
  };
  if (!exists) {
    const orphan = (await git(["checkout", "--orphan", QA_BRANCH], "git checkout --orphan")) ?? (await git(["rm", "-rf", "-q", "--ignore-unmatch", "."], "git rm"));
    if (orphan !== null) return { ok: false, message: orphan };
  }
  const where = `reports/${input.name}`;
  copyReport(input.folder, clone, join(clone, where), input.files);
  const failure =
    (await git(["add", "-f", "--", where], "git add")) ??
    (await git(["commit", "-m", `QA journey report: ${input.goal}`.slice(0, 120)], "git commit")) ??
    (await git(["push", "origin", `HEAD:refs/heads/${QA_BRANCH}`], "git push"));
  if (failure !== null) return { ok: false, message: failure };
  const body = join(tmp, "issue.md");
  writeFileSync(body, bodyOf(input, (p) => rawUrl(repo, QA_BRANCH, `${where}/${p}`), rawUrl(repo, QA_BRANCH, `${where}/report.md`), true), "utf8");
  const title = `QA journey: ${input.goal}`.slice(0, 120);
  const created = await run("gh", ["issue", "create", "--repo", repo, "--title", title, "--body-file", body]);
  if (created.code !== 0) return { ok: false, message: `${explain(created, "gh issue create", repo)} (the report was already pushed to ${where}/ on ${QA_BRANCH})` };
  const url = created.stdout.trim().split(/\s+/).find((w) => w.startsWith("https://")) ?? "";
  return { ok: true, lines: [`Exported: pushed ${input.files.length} files of the report to ${where}/ on branch ${QA_BRANCH} of ${repo}${exists ? "" : " (made it)"}, and opened an issue${url !== "" ? `: ${url}` : "."}`] };
}
