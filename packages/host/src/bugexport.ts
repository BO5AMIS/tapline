import { readContained, readContainedText } from "./safefile.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import type { AuditSink } from "./auditlog.js";
import { bugTitle, type BugMeta } from "./bug.js";
import { shownPath } from "./bugreport.js";
import { gateFiles, type BugStore, type BugText, type GateValues } from "./bugstore.js";
import { QA_BRANCH, REPO, copyReport, explain, rawUrl, type Runner } from "./journeyexport.js";

// Export of a bug report (AGENT-TOOLS 1.16 §29.7): to a GitHub issue through the user's own `gh`, as a journey's export is (§17.5), or as a local
// `.zip`. An export leaves the tool's folder, so it happens only when the user asked, every file it sends is checked again (E1) and each one,
// a refused one too, leaves a line in the audit log (§23) before anything is sent.

export interface BugExportTarget {
  to: "issue" | "zip";
  repo?: string;
  confirm?: boolean;
  public?: boolean;
  with_picture?: boolean;
  /** A zip's path: from the command line only (a call's path must stay in the bugs folder). */
  path?: string;
}

export interface BugExportDeps {
  store: BugStore;
  /** The single-pass redactor (§29.6). */
  redact: BugText;
  /** Values the gate also looks for by their forms (tests; the production gate is the redactor itself). */
  gateValues?: GateValues;
  /** The audit log. None: nothing is sent (§23: a line that can't be written means nothing is sent). */
  audit: AuditSink | undefined;
  /** The user's own gh and git. None: an issue can't be opened. */
  run: Runner | undefined;
  /** The command line may name any path for a zip; a call's path must be inside the bugs folder. */
  anyPath?: boolean;
  makeTemp?: () => string;
}

export type BugExportCode = "not_allowed" | "bad_params" | "not_found" | "unsupported" | "internal";
export type BugExportResult = { ok: true; lines: string[] } | { ok: false; code: BugExportCode; message: string };

const refuse = (code: BugExportCode, message: string): BugExportResult => ({ ok: false, code, message });

// -- the zip: a small writer with no dependency

const CRC_TABLE: number[] = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 1980-01-01 00:00:00: a fixed time, so an entry carries no time of the machine (§29.7). */
const DOS_DATE = 0x0021;

/**
 * A `.zip` of the files, in the order given, with a fixed time, UTF-8 names, no extra fields, no comment, and no user or machine in it (§29.7).
 * Entries are deflated; the same files give the same bytes.
 */
export function zipOf(entries: ReadonlyArray<{ name: string; data: Uint8Array }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.from(entry.data);
    const packed = deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// -- what is sent

const TEXT_FILES = ["report.md", "report.html", "repro.json", "finding.json"] as const;

/** `@name` in app text pings someone on GitHub: a zero-width space after the `@` keeps the text and drops the ping. */
const noPing = (text: string): string => text.replace(/@(?=\w)/g, "@​");

interface Parcel {
  files: Record<string, string>;
  picture: Buffer | null;
  /** The picture is in the folder but private and not asked for: left out. */
  withheld: boolean;
}

/** The folder's files as they go out: every text file, and the picture only when it isn't private or the export itself asked (§29.2, §29.7). */
function parcelOf(dir: string, record: BugMeta["picture_file"], withPicture: boolean, names: readonly string[]): Parcel {
  const files: Record<string, string> = {};
  for (const name of names) {
    try {
      files[name] = readContainedText(dir, join(dir, name));
    } catch {
      // a file that isn't there isn't sent
    }
  }
  const has = existsSync(join(dir, "picture.jpg"));
  if (!has) return { files, picture: null, withheld: false };
  // The privacy of the picture is the record of these exact bytes: bytes that have no record, or don't match it, count as private (§29.2).
  let bytes: Buffer;
  try {
    bytes = readContained(dir, join(dir, "picture.jpg"));
  } catch {
    // a picture that lies outside the folder (a link), or can't be read, is not sent
    return { files, picture: null, withheld: false };
  }
  const verified = record !== undefined && record.sha256 === createHash("sha256").update(bytes).digest("hex");
  const privatePicture = verified ? record.private : true;
  const send = !privatePicture || withPicture;
  return { files, picture: send ? bytes : null, withheld: !send };
}

const audited = (deps: BugExportDeps, app: string, detail: string): boolean => deps.audit?.write({ kind: "export", app, name: "bug_report", detail }) === true;

type Visibility = "public" | "private" | "unknown" | { error: string };

async function visibilityOf(run: Runner, repo: string): Promise<Visibility> {
  const seen = await run("gh", ["repo", "view", repo, "--json", "visibility"]);
  if (seen.code !== 0) return { error: explain(seen, "gh repo view", repo) };
  try {
    const parsed: unknown = JSON.parse(seen.stdout);
    if (typeof parsed === "object" && parsed !== null && "visibility" in parsed && typeof parsed.visibility === "string") {
      const v = parsed.visibility.toUpperCase();
      if (v === "PUBLIC") return "public";
      if (v === "PRIVATE" || v === "INTERNAL") return "private";
    }
  } catch {
    // counted as unknown
  }
  return "unknown";
}

/** Exports a kept bug (§29.7). Nothing is sent when anything is refused; each export, a refused one too, has its line in the audit log. */
export async function exportBug(deps: BugExportDeps, app: string, id: string, target: BugExportTarget): Promise<BugExportResult> {
  const stored = deps.store.read(app, id);
  if (stored === null) return refuse("not_found", `no bug ${id}; the bugs kept are in ${shownPath(deps.store.base)}.`);
  const dir = stored.dir;
  const withPicture = target.with_picture === true;
  const label = target.to === "issue" ? `issue ${target.repo ?? ""}` : "zip";
  const zipPath = target.to === "zip" ? resolve(target.path ?? join(deps.store.appDir(app), `${id}.zip`)) : "";
  if (target.to === "zip") {
    const base = resolve(deps.store.base);
    if (deps.anyPath !== true && target.path !== undefined && !(zipPath.startsWith(base + sep) && zipPath.toLowerCase().endsWith(".zip"))) {
      return refuse("bad_params", "a zip goes next to the bug's folder; a path of your own is for the command line.");
    }
  } else if (target.repo === undefined || !REPO.test(target.repo) || target.repo.includes("..")) {
    return refuse("bad_params", `export to an issue needs repo as owner/name, not ${JSON.stringify(target.repo ?? "")}.`);
  }
  const shown = target.to === "zip" ? shownPath(zipPath) : (target.repo as string);
  const detailOf = (picture: boolean, tail = ""): string => `${target.to === "zip" ? `zip ${shown}` : label}: ${id}, ${tail !== "" ? tail : picture ? "picture sent" : "picture not sent"}`;
  const refused = (code: BugExportCode, why: string, tail: string): BugExportResult => {
    audited(deps, stored.finding.app, detailOf(false, `refused (${tail})`));
    return refuse(code, why);
  };

  if (target.to === "issue" && target.confirm !== true) return refused("not_allowed", "needs_confirmation: an export to a GitHub issue needs confirm: true (your user asked for it).", "needs confirmation");

  const parcel = parcelOf(dir, stored.meta.picture_file, withPicture, target.to === "zip" ? TEXT_FILES : ["report.md", "repro.json"]);
  // E1: every file about to be sent is read again, against every vault value, code and typed value in every form (§29.6).
  const failed = gateFiles(parcel.files, deps.redact, deps.gateValues ?? []);
  if (failed !== null) return refused("not_allowed", `export refused: a vault value was found in ${failed}.`, "redaction check");

  if (target.to === "zip") {
    if (!audited(deps, stored.finding.app, detailOf(parcel.picture !== null))) return refuse("not_allowed", "export refused: the audit log can't be written. Nothing was written.");
    const entries = [
      ...Object.entries(parcel.files).map(([name, text]) => ({ name: `${id}/${name}`, data: Buffer.from(text, "utf8") })),
      ...(parcel.picture !== null ? [{ name: `${id}/picture.jpg`, data: parcel.picture }] : []),
    ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    try {
      mkdirSync(dirname(zipPath), { recursive: true });
      // A name nobody chose, made exclusively: a file or link already at `<zip>.part` is never written through.
      const temp = `${zipPath}.${randomBytes(6).toString("hex")}.part`;
      try {
        writeFileSync(temp, zipOf(entries), { mode: 0o600, flag: "wx" });
        renameSync(temp, zipPath);
      } catch (error) {
        rmSync(temp, { force: true });
        throw error;
      }
    } catch (error) {
      return refuse("internal", `the zip couldn't be written: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { ok: true, lines: [`Exported: wrote ${entries.length} files of ${id} to ${shown}${parcel.picture !== null ? " (the picture is in it)" : parcel.withheld ? " (the private picture is left out)" : ""}. No network was used.`] };
  }
  return exportIssue(deps, stored, id, target.repo as string, target.public === true, parcel);
}

async function exportIssue(deps: BugExportDeps, stored: NonNullable<ReturnType<BugStore["read"]>>, id: string, repo: string, allowPublic: boolean, parcel: Parcel): Promise<BugExportResult> {
  const run = deps.run;
  const app = stored.finding.app;
  if (run === undefined) return refuse("unsupported", "export isn't available here: this server has no GitHub runner (gh).");
  const sent = parcel.picture !== null;
  const line = (tail = ""): string => `issue ${repo}: ${id}, ${tail !== "" ? tail : sent ? "picture sent" : "picture not sent"}`;
  const auth = await run("gh", ["auth", "status"]);
  if (auth.code !== 0) return refuse("not_allowed", `export refused: ${explain(auth, "gh auth status", repo)}`);
  const visibility = await visibilityOf(run, repo);
  if (typeof visibility === "object") return refuse("not_allowed", `export refused: ${visibility.error}`);
  // A repository that can't be told apart counts as public (§29.7).
  const isPublic = visibility !== "private";
  if (isPublic && !allowPublic) {
    audited(deps, app, line("refused (public repository)"));
    return refuse("not_allowed", `export refused: ${visibility === "unknown" ? `Tapline couldn't tell whether ${repo} is public, so it counts as public` : `${repo} is a public repository`}, so the report would be visible to everyone; export again with public: true if your user wants that. Nothing was sent.`);
  }
  const title = deps.redact(bugTitle(stored.finding));
  const where = `.tapline/bugs/${id}`;
  // The page's picture is a file of the folder: in an issue it is the one on the branch, or it isn't there at all (§29.7).
  const shot = "![The screen at the moment](picture.jpg)";
  const md = (parcel.files["report.md"] ?? "").replace(shot, sent ? `![The screen at the moment](${rawUrl(repo, QA_BRANCH, `${where}/picture.jpg`)})` : "(The picture isn't part of this issue.)");
  const links = [`- [repro.json](${rawUrl(repo, QA_BRANCH, `${where}/repro.json`)})`, ...(sent ? [`- [picture.jpg](${rawUrl(repo, QA_BRANCH, `${where}/picture.jpg`)})`] : [])];
  const body = `${noPing(md.trimEnd())}\n\n## Files\n${links.join("\n")}\n\nWritten by Tapline.\n`;
  // The title and the body are sent too: they pass the same check.
  const late = gateFiles({ "the issue title": title, "the issue body": body }, deps.redact, deps.gateValues ?? []);
  if (late !== null) {
    audited(deps, app, line("refused (redaction check)"));
    return refuse("not_allowed", `export refused: a vault value was found in ${late}.`);
  }
  if (!audited(deps, app, line(isPublic ? `${sent ? "picture sent" : "picture not sent"} (public)` : ""))) return refuse("not_allowed", "export refused: the audit log can't be written. Nothing was sent.");
  const tmp = (deps.makeTemp ?? (() => mkdtempSync(join(tmpdir(), "tapline-bugexport-"))))();
  const clone = join(tmp, "repo");
  try {
    const branch = await run("gh", ["api", `repos/${repo}/branches/${QA_BRANCH}`, "--silent"]);
    const exists = branch.code === 0;
    if (!exists && !/404|not found/i.test(`${branch.stderr}${branch.stdout}`)) return refuse("internal", explain(branch, "gh api", repo));
    const cloned = exists
      ? await run("gh", ["repo", "clone", repo, clone, "--", "--branch", QA_BRANCH, "--single-branch", "--depth", "1"])
      : await run("gh", ["repo", "clone", repo, clone, "--", "--depth", "1", "--no-checkout"]);
    if (cloned.code !== 0) return refuse("internal", explain(cloned, "gh repo clone", repo));
    const git = async (args: string[], what: string): Promise<string | null> => {
      const done = await run("git", args, { cwd: clone });
      return done.code === 0 ? null : explain(done, what, repo);
    };
    if (!exists) {
      const orphan = (await git(["checkout", "--orphan", QA_BRANCH], "git checkout --orphan")) ?? (await git(["rm", "-rf", "-q", "--ignore-unmatch", "."], "git rm"));
      if (orphan !== null) return refuse("internal", orphan);
    }
    // Only the script and an allowed picture go to the branch; the page is the issue's body (§29.7).
    const staged = join(tmp, "stage");
    mkdirSync(staged, { recursive: true });
    writeFileSync(join(staged, "repro.json"), parcel.files["repro.json"] ?? "", "utf8");
    if (parcel.picture !== null) writeFileSync(join(staged, "picture.jpg"), parcel.picture);
    const names = ["repro.json", ...(parcel.picture !== null ? ["picture.jpg"] : [])];
    copyReport(staged, clone, join(clone, where), names);
    // Files that are on the branch already (a retry after a failed `gh issue create`, or the same bug again) stage no change, and git refuses an empty
    // commit. When the commit fails and the index holds nothing, there is nothing to push: the export goes on to the issue.
    let failure = await git(["add", "-f", "--", where], "git add");
    if (failure === null) {
      const committed = await git(["commit", "-m", `QA bug report: ${id}`], "git commit");
      if (committed === null) failure = await git(["push", "origin", `HEAD:refs/heads/${QA_BRANCH}`], "git push");
      else if ((await run("git", ["diff", "--cached", "--quiet"], { cwd: clone })).code !== 0) failure = committed;
    }
    if (failure !== null) return refuse("internal", failure);
    const bodyFile = join(tmp, "issue.md");
    writeFileSync(bodyFile, body, "utf8");
    const created = await run("gh", ["issue", "create", "--repo", repo, "--title", title, "--body-file", bodyFile]);
    if (created.code !== 0) return refuse("internal", `${explain(created, "gh issue create", repo)} (the script was already pushed to ${where}/ on ${QA_BRANCH})`);
    const url = created.stdout.trim().split(/\s+/).find((w) => w.startsWith("https://")) ?? "";
    return {
      ok: true,
      lines: [`Exported: wrote ${names.join(" and ")} to ${where}/ on branch ${QA_BRANCH} of ${repo}${exists ? "" : " (made it)"}, and opened an issue${url !== "" ? `: ${url}` : "."}${isPublic ? " (public)" : ""}${parcel.withheld ? " The private picture was left out." : ""}`],
    };
  } catch (error) {
    return refuse("internal", error instanceof Error ? error.message : String(error));
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // left for the system to clean up
    }
  }
}
