import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readContainedText } from "./safefile.js";
import { decodedBases, normalizedBases, variantsOf } from "./accounts.js";
import { bugPageHtml, bugPageMarkdown, bugSignature, bugTitle, pictureLines, replaceSection, reproducedLines, seenLines, type BugFinding, type BugHow, type BugMeta } from "./bug.js";
import { redactFinding } from "./findings.js";
import type { PlaceKey } from "./mapfile.js";

// The bug report's folder (AGENT-TOOLS 1.16 §29.2, §29.5, §29.6): `<base>/<app id>/<bug id>/` with `report.md`, `report.html`, `repro.json`,
// `finding.json` and, only when allowed, `picture.jpg`. One bug is one folder: a later sighting of the same signature updates it.

/** The newest bugs an app keeps (§29.2). */
export const BUGS_KEPT = 100;
/** The sources `seen.sources` keeps (§29.5). */
export const SOURCES_KEPT = 50;

/** A folder name for an app id, as the explore reports use. */
export const appFolderName = (appId: string): string => appId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_") || "unknown";

const BUG_ID = /^bug_[0-9a-f]{16}(?:_\d+)?$/;
export const isBugId = (text: string): boolean => BUG_ID.test(text);

/** A file of a bug folder holds a vault value, a code or a typed value: nothing is written (§29.6). */
export class BugGateError extends Error {
  constructor(
    readonly file: string,
    why?: string,
  ) {
    super(why ?? `a vault value was found in ${file}.`);
    this.name = "BugGateError";
  }
}

export type BugText = (text: string) => string;

/** The forms and 12-character pieces of values, for the grep gate (§20.3, §29.6). A value under 3 characters is never scrubbed, so it isn't looked for. */
export function forbiddenForms(values: readonly string[]): string[] {
  const out = new Set<string>();
  for (const value of values) {
    if ([...value].length < 3) continue;
    for (const form of variantsOf(value)) out.add(form);
    out.add(value);
    if (value.length >= 12) for (let i = 0; i + 12 <= value.length; i++) out.add(value.slice(i, i + 12));
  }
  return [...out].filter((form) => form !== "");
}

/** The values the gate greps for: a list, or a function that reads them from the live stores at the moment of the check (production). */
export type GateValues = readonly string[] | (() => readonly string[]);

/** The width of the pieces the gate looks for (§29.6, §20.3). */
const PIECE = 12;

const htmlEscaped = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** A 53-bit hash of the PIECE characters at `at`. A clash can only make the gate refuse a file, never let one through. */
function windowHash(text: string, at: number): number {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = at; i < at + PIECE; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = (Math.imul(h2 + c, 0x85ebca6b) ^ (h2 >>> 13)) >>> 0;
  }
  return h1 * 0x200000 + (h2 & 0x1fffff);
}

/**
 * Every form of a COMPLETE value that a file could hold: normalized first (whitespace collapsed, direction marks and zero-width characters stripped,
 * every combination), then its encodings and escaped markup. Nothing is cut before the forms are made, so no window of a form is lost to a boundary.
 */
function formsOfValue(value: string): string[] {
  const out = new Set<string>(variantsOf(value));
  // The value as the redactor decodes it too (a value that itself holds an escape): a text holding the decoded reading holds the value.
  for (const base of [...normalizedBases(value), ...decodedBases(value)]) {
    out.add(base);
    out.add(htmlEscaped(base));
  }
  return [...out].filter((form) => form !== "");
}

/** A text as the gate holds it: its normalized forms, whole, and the hash of every 12-character window of each. */
interface Held {
  bases: string[];
  windows: Set<number>;
}

function holdText(text: string): Held {
  // The raw readings and every decoded stage of the text, each normalized: a fragment written with escapes (`H`, `%48`, `&#72;`) is held as it reads.
  const bases = decodedBases(text);
  const windows = new Set<number>();
  for (const base of bases) for (let i = 0; i + PIECE <= base.length; i++) windows.add(windowHash(base, i));
  return { bases, windows };
}

/**
 * The index of the first text that holds a value, by any form of it, whole or by ANY 12-character window of a form (not only its start), or -1.
 * The texts' windows are collected once (each text normalized whole first) and each value's forms are streamed past them one by one, so memory
 * stays near the size of the texts and the work near the sum of the lengths, however long a value is.
 */
function firstHolding(texts: readonly string[], values: readonly string[]): number {
  if (texts.length === 0) return -1;
  const held = texts.map(holdText);
  let hit = -1;
  const found = (at: number): void => {
    if (hit === -1 || at < hit) hit = at;
  };
  for (const value of values) {
    if ([...value].length < 3) continue;
    for (const form of formsOfValue(value)) {
      // A form under 12 characters can only be found whole; a longer one by its windows (the whole of it is among them).
      if (form.length < PIECE) {
        for (let at = 0; at < (hit === -1 ? held.length : hit); at++) if (held[at]?.bases.some((base) => base.includes(form)) === true) found(at);
        if (hit === 0) return 0;
        continue;
      }
      for (let i = 0; i + PIECE <= form.length; i++) {
        const h = windowHash(form, i);
        for (let at = 0; at < (hit === -1 ? held.length : hit); at++) if (held[at]?.windows.has(h) === true) found(at);
        if (hit === 0) return 0;
      }
    }
  }
  return hit;
}

/**
 * The grep gate: every text file against the redactor (a text it would still change holds a value) and, when values are given, against every
 * form of each and every 12-character piece of each form. Answers the first file that fails, or null.
 */
export function gateFiles(files: Record<string, string>, redact: BugText, values: GateValues = []): string | null {
  const list = typeof values === "function" ? values() : values;
  const entries = Object.entries(files);
  let failed = entries.findIndex(([, text]) => redact(text) !== text);
  const upTo = failed === -1 ? entries.length : failed;
  const at = list.length > 0 ? firstHolding(entries.slice(0, upTo).map(([, text]) => text), list) : -1;
  if (at !== -1) failed = at;
  return failed === -1 ? null : (entries[failed]?.[0] ?? null);
}

export interface BugMakeInput {
  /** Already redacted (§29.6). */
  finding: BugFinding;
  placeKey: PlaceKey | null;
  source: { how: BugHow; key: string; run?: string; finding?: string; file?: string; line?: number };
  /** The finding's script (§27.1), already redacted. */
  script: Record<string, unknown>;
  /** The picture's bytes while its file exists. */
  picture: Uint8Array | null;
  withPicture: boolean;
  extras?: Pick<BugMeta, "steps_cut" | "others" | "names" | "route_text" | "needs_person">;
  /** A check's result; none: not checked, and `why` says why. */
  reproduced?: BugMeta["reproduced"];
  notChecked: string;
  redact: BugText;
  /** Values the gate also looks for by their forms (tests; the production gate is the redactor itself). */
  gateValues?: GateValues;
}

export interface BugMade {
  meta: BugMeta;
  dir: string;
  isNew: boolean;
  title: string;
  finding: BugFinding;
}

/**
 * The reproduction check (§29.4): runs the bug's script `n` times and says how many runs showed the same bug. The tools give their own (bugcheck.ts);
 * a hook replaces it (tests).
 */
export interface BugCheckOptions {
  reset: "own" | "app";
  account?: string;
  /** A value for `${typed}`, from a person at a prompt of the command line; never from a call or a file. None: the check stops at such a step (§29.4). */
  typed?: (name: string) => Promise<string | null>;
}

export type BugCheck = (bug: { app: string; id: string; dir: string; finding: BugFinding; meta: BugMeta }, n: number, options: BugCheckOptions) => Promise<BugMeta["reproduced"]>;

export interface BugListEntry {
  app: string;
  id: string;
  title: string;
  count: number;
  last: string;
  reproduced: string;
}

const reproducedWords = (r: BugMeta["reproduced"]): string => ("checked" in r ? "not checked" : `${r.n} of ${r.of}`);

interface Stored {
  finding: BugFinding;
  meta: BugMeta;
  dir: string;
}

export class BugStore {
  constructor(
    readonly base: string,
    private readonly kept: number = BUGS_KEPT,
    /** The lstat the store uses to tell an absent script from one it can't reach (tests inject a failing one). */
    private readonly lstat: (path: string) => unknown = lstatSync,
  ) {}

  appDir(app: string): string {
    return join(this.base, appFolderName(app));
  }

  bugDir(app: string, id: string): string {
    return join(this.appDir(app), id);
  }

  /** The bug's folder and what it holds, or null. */
  read(app: string, id: string): Stored | null {
    if (!isBugId(id)) return null;
    const dir = this.bugDir(app, id);
    try {
      const parsed: unknown = JSON.parse(readContainedText(dir, join(dir, "finding.json")));
      if (typeof parsed !== "object" || parsed === null || !("bug" in parsed)) return null;
      const { bug, ...finding } = parsed as { bug: BugMeta } & Record<string, unknown>;
      return { finding: finding as unknown as BugFinding, meta: bug, dir };
    } catch {
      return null;
    }
  }

  /**
   * The app a kept bug id belongs to. With `app`, that app's bug. Without, the id is searched in every app's folder, and an id that two apps hold is
   * never taken from the first: it answers null (`holders` says which apps).
   */
  locate(id: string, app?: string): { app: string; stored: Stored } | null {
    if (!isBugId(id)) return null;
    if (app !== undefined) {
      const stored = this.read(app, id);
      return stored === null ? null : { app: stored.finding.app, stored };
    }
    const all = this.found(id);
    return all.length === 1 ? (all[0] as { app: string; stored: Stored }) : null;
  }

  /**
   * `locate` with the reason when it finds nothing: no such bug, or an id that several apps hold (the person names the app). `app` is the app asked for;
   * with `prefer` it is only the first choice (the app in front), and any other app's bug is taken when it is the only one.
   */
  lookup(id: string, app?: string, prefer = false): { found: { app: string; stored: Stored } } | { ambiguous: string } | null {
    const own = app !== undefined ? this.locate(id, app) : null;
    if (own !== null) return { found: own };
    if (app === undefined || prefer) {
      const any = this.locate(id);
      if (any !== null) return { found: any };
      const holders = this.holders(id);
      if (holders.length > 1) return { ambiguous: `bug ${id} is kept for ${holders.length} apps (${holders.join(", ")}); say which one (--app <app id>, or open that app).` };
    }
    return null;
  }

  /** The apps that hold a bug with this id (two apps can: the id doesn't hold the app). */
  holders(id: string): string[] {
    return this.found(id).map((f) => f.app);
  }

  private found(id: string): Array<{ app: string; stored: Stored }> {
    if (!isBugId(id)) return [];
    const all: Array<{ app: string; stored: Stored }> = [];
    for (const name of this.appFolders()) {
      const stored = this.read(name, id);
      if (stored !== null) all.push({ app: stored.finding.app, stored });
    }
    return all;
  }

  private appFolders(): string[] {
    try {
      return readdirSync(this.base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  private bugIds(app: string): string[] {
    try {
      return readdirSync(this.appDir(app), { withFileTypes: true }).filter((e) => e.isDirectory() && BUG_ID.test(e.name)).map((e) => e.name);
    } catch {
      return [];
    }
  }

  /** Every kept bug, newest first (by `seen.last`), per app; one app when named. */
  list(app?: string): BugListEntry[] {
    const out: BugListEntry[] = [];
    for (const folder of app !== undefined ? [appFolderName(app)] : this.appFolders()) {
      for (const id of this.bugIds(folder)) {
        const stored = this.read(folder, id);
        if (stored === null) continue;
        out.push({ app: stored.finding.app, id, title: bugTitle(stored.finding), count: stored.meta.seen.count, last: stored.meta.seen.last, reproduced: reproducedWords(stored.meta.reproduced) });
      }
    }
    return out.sort((a, b) => (a.app === b.app ? (a.last < b.last ? 1 : a.last > b.last ? -1 : a.id.localeCompare(b.id)) : a.app.localeCompare(b.app)));
  }

  /** Removes an app's oldest bugs beyond the newest `kept`, with their zips; `keep` is never removed (§29.2). */
  prune(app: string, keep?: string): void {
    try {
      const rows = this.bugIds(app).flatMap((id) => {
        const stored = this.read(app, id);
        return stored === null ? [] : [{ id, last: stored.meta.seen.last }];
      });
      rows.sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : a.id.localeCompare(b.id)));
      for (const row of rows.slice(this.kept)) {
        if (row.id === keep) continue;
        rmSync(this.bugDir(app, row.id), { recursive: true, force: true });
        rmSync(join(this.appDir(app), `${row.id}.zip`), { force: true });
      }
    } catch {
      // a folder that can't be removed stays
    }
  }

  /** At start: every app's bugs beyond the newest kept are removed (§29.2). */
  pruneAll(): void {
    for (const folder of this.appFolders()) this.prune(folder);
  }

  /** The folder for a new bug, and whether it is the folder of a bug with this signature. */
  private slotFor(app: string, signature: string, placeKey: PlaceKey | null, sourceKey: string): { id: string; existing: Stored | null } {
    const first = `bug_${signature}`;
    if (placeKey !== null) return { id: first, existing: this.read(app, first) };
    // A finding with no place key is never merged into another bug (§29.5); the same source again is not a second bug.
    for (let n = 2; ; n++) {
      const id = `${first}_${n}`;
      const existing = this.read(app, id);
      if (existing === null) return { id, existing: null };
      if (existing.meta.seen.sources.includes(sourceKey)) return { id, existing };
    }
  }

  /** Makes a bug, or adds a sighting to the one with the same signature (§29.5). Nothing is written when the gate refuses. */
  make(input: BugMakeInput): BugMade {
    const { finding } = input;
    const app = finding.app;
    const signature = bugSignature({ kind: finding.kind, placeKey: input.placeKey, got: finding.got, crash: finding.crash });
    const { id, existing } = this.slotFor(app, signature, input.placeKey, input.source.key);
    return existing === null ? this.create(input, id, signature) : this.sighting(input, existing);
  }

  private create(input: BugMakeInput, id: string, signature: string): BugMade {
    const { finding } = input;
    const build = `${finding.app_version} (${finding.build})`;
    const includePicture = input.picture !== null && finding.picture !== null && (!finding.picture.private || input.withPicture);
    const meta: BugMeta = {
      id,
      signature,
      place_key: input.placeKey,
      source: { how: input.source.how, ...(input.source.run !== undefined ? { run: input.source.run } : {}), ...(input.source.finding !== undefined ? { finding: input.source.finding } : {}), ...(input.source.file !== undefined ? { file: input.source.file } : {}), ...(input.source.line !== undefined ? { line: input.source.line } : {}) },
      seen: { first: finding.when, last: finding.when, count: Math.max(1, finding.count), builds: [build], sources: [input.source.key] },
      reproduced: input.reproduced ?? { checked: false, why: input.notChecked },
      picture_included: includePicture,
      ...(includePicture && input.picture !== null && finding.picture !== null ? { picture_file: pictureRecord(input.picture, finding.picture.private, input.withPicture) } : {}),
      ...(input.extras?.steps_cut === true ? { steps_cut: true } : {}),
      ...(input.extras?.others !== undefined && input.extras.others.length > 0 ? { others: input.extras.others } : {}),
      ...(input.extras?.names !== undefined ? { names: input.extras.names } : {}),
      ...(input.extras?.route_text !== undefined ? { route_text: input.extras.route_text } : {}),
      ...(input.extras?.needs_person !== undefined && input.extras.needs_person.length > 0 ? { needs_person: input.extras.needs_person } : {}),
    };
    const md = bugPageMarkdown({ finding, meta, pictureFile: includePicture ? "picture.jpg" : null });
    const files = this.finish(input, md, { "repro.json": `${JSON.stringify(input.script, null, 2)}\n`, "finding.json": `${JSON.stringify({ ...finding, bug: meta }, null, 2)}\n` });
    const dir = this.bugDir(finding.app, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text, { mode: 0o600 });
    if (includePicture && input.picture !== null) writeFileSync(join(dir, "picture.jpg"), input.picture, { mode: 0o600 });
    this.prune(finding.app, id);
    return { meta, dir, isNew: true, title: bugTitle(finding), finding };
  }

  /** A later sighting: the count, the last time, the builds and the sources grow; the first finding, picture and script stay (§29.5). */
  private sighting(input: BugMakeInput, existing: Stored): BugMade {
    const { finding: seenNow } = input;
    const stored = existing.finding;
    const meta: BugMeta = structuredClone(existing.meta);
    const known = meta.seen.sources.includes(input.source.key);
    if (!known) {
      meta.seen.count += Math.max(1, seenNow.count);
      if (seenNow.when > meta.seen.last) meta.seen.last = seenNow.when;
      const build = `${seenNow.app_version} (${seenNow.build})`;
      if (!meta.seen.builds.includes(build)) meta.seen.builds.push(build);
      meta.seen.sources = [...meta.seen.sources, input.source.key].slice(-SOURCES_KEPT);
    }
    // Only a check that ran replaces `reproduced`.
    if (input.reproduced !== undefined && !("checked" in input.reproduced)) meta.reproduced = input.reproduced;
    let picture: Uint8Array | null = null;
    const hadPicture = meta.picture_included;
    // The first finding keeps its picture and its source (§29.5). A later sighting fills in the missing bytes only when they are of the same privacy
    // as that picture: never a private picture under a public one's flag (or the other way). The privacy and the consent go with the bytes.
    if (!hadPicture && input.picture !== null && stored.picture !== null && seenNow.picture !== null && seenNow.picture.private === stored.picture.private && (!stored.picture.private || input.withPicture)) {
      picture = input.picture;
      meta.picture_included = true;
      meta.picture_file = pictureRecord(input.picture, seenNow.picture.private, input.withPicture);
    }
    const dir = existing.dir;
    const old = readOrEmpty(join(dir, "report.md"));
    let md = old === "" ? bugPageMarkdown({ finding: stored, meta, pictureFile: meta.picture_included ? "picture.jpg" : null }) : old;
    if (old !== "") {
      md = replaceSection(md, "Reproduced", reproducedLines(meta, stored.kind));
      md = replaceSection(md, "Seen before", seenLines(meta));
      if (picture !== null) md = replaceSection(md, "Picture", pictureLines(stored, meta, "picture.jpg"));
    }
    // finding.json is redacted again when the bug is touched: a value added to the vault since counts (§29.6).
    const first = redactFinding(stored, input.redact);
    const files = this.finish(input, md, { "finding.json": `${JSON.stringify({ ...first, bug: meta }, null, 2)}\n` }, this.retained(dir));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text, { mode: 0o600 });
    if (picture !== null) writeFileSync(join(dir, "picture.jpg"), picture, { mode: 0o600 });
    this.prune(seenNow.app, meta.id);
    return { meta, dir, isNew: false, title: bugTitle(stored), finding: stored };
  }

  /** A later check replaces `reproduced` and its lines of the page, and keeps the first finding (§29.4). The page is written again from the finding and its `bug` key. */
  recordCheck(app: string, id: string, reproduced: BugMeta["reproduced"], redact: BugText, gateValues?: GateValues): BugMeta | null {
    const stored = this.read(app, id);
    if (stored === null) return null;
    const meta: BugMeta = { ...stored.meta, reproduced };
    const md = bugPageMarkdown({ finding: stored.finding, meta, pictureFile: meta.picture_included ? "picture.jpg" : null });
    const files = this.finish({ redact, ...(gateValues !== undefined ? { gateValues } : {}) }, md, { "finding.json": `${JSON.stringify({ ...stored.finding, bug: meta }, null, 2)}\n` }, this.retained(stored.dir));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(stored.dir, name), text, { mode: 0o600 });
    return meta;
  }

  /** Adds a private picture to a kept bug, because a person asked (§29.2). False when there is no bug, it has one already, or the source is gone. */
  addPicture(app: string, id: string, bytes: Uint8Array | null, redact: BugText, gateValues?: GateValues): "added" | "has" | "gone" | "none" {
    const stored = this.read(app, id);
    if (stored === null) return "none";
    if (stored.meta.picture_included) return "has";
    if (bytes === null || stored.finding.picture === null) return "gone";
    // The bytes are the first finding's own (the explore report's file); a person asked for them, so the record says so.
    const meta: BugMeta = { ...stored.meta, picture_included: true, picture_file: pictureRecord(bytes, stored.finding.picture.private, true) };
    const md = replaceSection(readOrEmpty(join(stored.dir, "report.md")), "Picture", pictureLines(stored.finding, meta, "picture.jpg"));
    const files = this.finish({ redact, ...(gateValues !== undefined ? { gateValues } : {}) }, md, { "finding.json": `${JSON.stringify({ ...stored.finding, bug: meta }, null, 2)}\n` }, this.retained(stored.dir));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(stored.dir, name), text, { mode: 0o600 });
    writeFileSync(join(stored.dir, "picture.jpg"), bytes, { mode: 0o600 });
    return "added";
  }

  /**
   * The gate (§29.6): every text of the folder as it will be written. A page the redactor would still change is redacted once more; any text that
   * still fails refuses, and nothing is written. `report.html` is made from the page that passed.
   */
  private finish(input: Pick<BugMakeInput, "redact" | "gateValues">, md: string, others: Record<string, string>, retained: Record<string, string> = {}): Record<string, string> {
    let page = md;
    if (gateFiles({ "report.md": page }, input.redact, input.gateValues) !== null) page = input.redact(page);
    const files: Record<string, string> = { "report.md": page, "report.html": bugPageHtml(page), ...others };
    // A text of the folder that this write keeps as it is (the script) is checked too: a value that reached the vault since the bug was made can't
    // stay in a folder that is being updated. The script isn't rewritten, so the update is refused and nothing is written.
    const failed = gateFiles({ ...files, ...retained }, input.redact, input.gateValues);
    if (failed !== null) throw new BugGateError(failed);
    return files;
  }

  /** The texts of a bug's folder that an update keeps unchanged. */
  private retained(dir: string): Record<string, string> {
    const path = join(dir, "repro.json");
    // Only a plain "absent" (ENOENT, or ENOTDIR above it) means no script; a link whose target can't be reached, or any other error, refuses the update.
    try {
      this.lstat(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return {};
      throw new BugGateError("repro.json", "repro.json can't be reached, so it can't be checked.");
    }
    try {
      return { "repro.json": readContainedText(dir, path) };
    } catch {
      // A script that exists and can't be read can't be checked, so the update is refused (never taken for an empty one).
      throw new BugGateError("repro.json", "repro.json can't be read, so it can't be checked.");
    }
  }

  exists(app: string, id: string): boolean {
    return existsSync(this.bugDir(app, id));
  }
}

/** What a stored picture file says about itself: the privacy it was admitted under, whether a person asked, and its hash. */
export function pictureRecord(bytes: Uint8Array, isPrivate: boolean, consent: boolean): NonNullable<BugMeta["picture_file"]> {
  return { private: isPrivate, consent, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function readOrEmpty(path: string): string {
  try {
    return readContainedText(dirname(path), path);
  } catch {
    return "";
  }
}
