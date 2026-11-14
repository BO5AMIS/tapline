import { createHash } from "node:crypto";
import { CRASH_FRAMES_MAX, FINDING_KINDS, LOG_LINES_MAX, LOG_LINE_MAX, TYPED, cutText, firstLine, type Finding, type PathStep } from "./findings.js";
import type { PlaceKey } from "./mapfile.js";

// The bug report (AGENT-TOOLS 1.16 §29): the signature (§29.5) and the page (§29.1). Pure: no files, no tools. The folder is in bugstore.ts.

/** The kinds a bug report knows: the kinds of a finding (§27.1) and `observed`, which only a bug report has (§29.3). */
export const BUG_KINDS = [...FINDING_KINDS, "observed"] as const;
export type BugKind = (typeof BUG_KINDS)[number];

/** The kinds of system sheet a finding may name, by kind only (§29.8). */
export const SYSTEM_SHEETS = ["share sheet", "permission prompt", "system alert", "purchase sheet", "other"] as const;
export type SystemSheet = (typeof SYSTEM_SHEETS)[number];

/** A §27 finding whose kind may also be `observed`. */
export type BugFinding = Omit<Finding, "kind"> & { kind: BugKind; system?: SystemSheet };

export type BugHow = "explore" | "failure" | "journey" | "now";

/** The `bug` key that `finding.json` has beside the finding (§29.2). */
export interface BugMeta {
  id: string;
  signature: string;
  place_key: PlaceKey | null;
  /** `how` is §29.2's; `file` and `line` are §29.8's (the source of the top app frame): one object holds both. */
  source: { how: BugHow; run?: string; finding?: string; file?: string; line?: number };
  seen: { first: string; last: string; count: number; builds: string[]; sources: string[] };
  reproduced: { n: number; of: number; build: string; when: string; reset: string } | { checked: false; why: string };
  picture_included: boolean;
  /** Earlier steps of the path couldn't be written down (§29.3): the page says so. */
  steps_cut?: boolean;
  /** The 0-based path steps whose text the app says others wrote (§27.2): the page quotes them as data. */
  others?: number[];
  /** What the page quotes for each step: the name of the road with the same move (§29.1). Null where there is none. */
  names?: (string | null)[];
  /** The place's route as the page shows it, `route trips › [id], tab trips`. */
  route_text?: string | null;
  /** A step that needs a person (a policy word), by index (§29.1). */
  needs_person?: number[];
}

export const KIND_WORDS: Record<BugKind, string> = {
  crash: "Crash",
  js_error: "JS error",
  dead_end: "Dead end",
  refused: "Refused touch",
  slow: "Slow screen",
  a11y: "Accessibility",
  ux: "Usability",
  unreachable: "Unreachable place",
  expect_failed: "Check failed",
  observed: "Observed",
};

/** The steps shown at most (the last ones), §29.1. */
export const STEPS_SHOWN = 15;
export const TITLE_MAX = 80;

// -- the signature (§29.5)

/** The place key as JSON with its keys sorted and no spaces; a signature key by its signature only; `null` when unknown. */
export function placeKeyJson(key: PlaceKey | null): string {
  if (key === null) return "null";
  if ("signature" in key) return JSON.stringify({ signature: key.signature });
  const out: Record<string, unknown> = {};
  if (key.layer !== undefined) out["layer"] = key.layer;
  out["route"] = key.route;
  if (key.tab !== undefined) out["tab"] = key.tab;
  return JSON.stringify(out);
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g;
const CLOCK_TIME = /\b\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?/g;
const HEX_PREFIXED = /\b0x[0-9a-f]+\b/gi;
const HEX_LONG = /\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi;
const DIGITS = /\d+(?:\.\d+)?/g;

/** The first line of `got`, normalized as §29.5 says, in this order: UUIDs, dates and times, hex numbers, digits, whitespace. */
export function normalizeGot(got: string): string {
  return firstLine(got)
    .replace(UUID, "#")
    .replace(ISO_DATE, "#")
    .replace(CLOCK_TIME, "#")
    .replace(HEX_PREFIXED, "#")
    .replace(HEX_LONG, "#")
    .replace(DIGITS, "#")
    .replace(/\s+/g, " ")
    .trim();
}

/** The exception type: the text of the reason before the first `:`, else its first word (`TypeError`, `EXC_BAD_ACCESS`). */
export function exceptionType(reason: string): string {
  const text = reason.trim();
  const colon = text.indexOf(":");
  const head = colon >= 0 ? text.slice(0, colon) : (text.split(/\s+/)[0] ?? "");
  return head.trim();
}

const UNSYMBOLICATED = "unsymbolicated";

/**
 * The symbol of a frame: `*TripDetail.tsx:48 renderDays` gives `renderDays`, and `3 Wayfare 0x0000000102a4b3c8 -[TripViewController renderDays] + 148`
 * gives `-[TripViewController renderDays]`. Addresses, offsets, file names and line numbers are dropped. A frame with no symbol or an
 * anonymous one gives `unsymbolicated`.
 */
export function frameSymbol(frame: string): string {
  const text = frame.trim().replace(/^\*/, "").trim();
  const objc = /[-+]\[[^\]]+\]/.exec(text);
  if (objc !== null) return objc[0];
  let symbol: string;
  const native = /^\d+\s+\S+\s+(?:0x[0-9a-f]+)\s*(.*)$/i.exec(text);
  if (native !== null) {
    symbol = (native[1] ?? "").replace(/(?:^|\s)\+\s*\d+\s*$/, "").trim();
  } else {
    const js = /^[^\s:]+(?::\d+)*\s+(.+)$/.exec(text);
    symbol = js === null ? "" : (js[1] ?? "").trim();
  }
  symbol = symbol.replace(/\b0x[0-9a-f]+\b/gi, "").replace(/\s+/g, " ").trim();
  if (symbol === "" || /^(?:<anonymous>|anonymous|\?+|\(anonymous\)|\(anonymous function\))$/i.test(symbol)) return UNSYMBOLICATED;
  return symbol;
}

/** The symbol of the first frame the app owns (marked `*`), or `unsymbolicated`. */
export function topAppSymbol(frames: readonly string[]): string {
  const top = frames.find((frame) => frame.trim().startsWith("*"));
  return top === undefined ? UNSYMBOLICATED : frameSymbol(top);
}

export interface SignatureInput {
  kind: BugKind;
  placeKey: PlaceKey | null;
  /** `got` after redaction (§29.6); the first line is used. */
  got: string;
  crash?: { reason: string; frames: string[] } | undefined;
}

/** The signature: the first 16 hex digits of the SHA-256 of the parts, in UTF-8, joined by `\n` (§29.5). */
export function bugSignature(input: SignatureInput): string {
  const parts = [input.kind, placeKeyJson(input.placeKey), normalizeGot(input.got)];
  if (input.kind === "crash") parts.push(exceptionType(input.crash?.reason ?? ""), topAppSymbol(input.crash?.frames ?? []));
  return createHash("sha256").update(parts.join("\n"), "utf8").digest("hex").slice(0, 16);
}

// -- text helpers

/** One line: no line break can start another section of the page. */
export const oneLine = (text: string): string => text.replace(/[\r\n\u2028\u2029]+/g, " ").trim();

/** A path in a frame or a log line is cut to its file name: no user folder, no machine name (§29.6). */
export function stripPaths(text: string): string {
  return text.replace(/(?<![\w:/.\\-])(?:[A-Za-z]:)?(?:[\\/][^\s\\/:'"()]+){2,}/g, (path) => path.split(/[\\/]/).pop() ?? path);
}

/** A title's `got`: the first line, and over 80 characters its first 45 and its last 30 with ` … ` between (§29.1). */
export function shortGot(got: string): string {
  const chars = Array.from(oneLine(firstLine(got)));
  if (chars.length <= TITLE_MAX) return chars.join("");
  return `${chars.slice(0, 45).join("")} … ${chars.slice(chars.length - 30).join("")}`;
}

export function bugTitle(finding: Pick<BugFinding, "kind" | "place" | "got">): string {
  return `${KIND_WORDS[finding.kind]} on ${finding.place ?? "an unnamed screen"}: ${shortGot(finding.got)}`;
}

const ordinal = (n: number): string => {
  const hundred = n % 100;
  if (hundred >= 11 && hundred <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10 > 3 ? 0 : n % 10] ?? "th"}`;
};

/** A link cut down for a person: the scheme and the path's plain words, never a query, a fragment or a value (§18.3). */
export function cutDownLink(url: string): string {
  const match = /^([A-Za-z][\w+.-]*:)(\/\/)?([^/?#]*)([^?#]*)/.exec(url.trim());
  if (match === null) return "(a link)";
  const segments = (match[4] ?? "").split("/").map((segment) => (segment === "" || /^[a-z][a-z-]{0,23}$/.test(segment) ? segment : "[value]"));
  const host = match[3] ?? "";
  return `${match[1] ?? ""}${match[2] ?? ""}${host === "" || /^[a-z][a-z-]{0,23}$/.test(host) ? host : "[value]"}${segments.join("/")}`;
}

/** What a step names: `"Trips" (id trips-tab)`, `id trip-row-1` or `"Save"`. */
function elementPhrase(step: PathStep, name: string | null): string {
  const target = step.target;
  const shown = name ?? target?.label ?? target?.text ?? null;
  if (shown !== null && shown !== "") return target?.id !== undefined && name !== null ? `"${oneLine(shown)}" (id ${target.id})` : `"${oneLine(shown)}"`;
  return target?.id !== undefined ? `id ${target.id}` : "the element";
}

export interface StepNotes {
  name: string | null;
  others: boolean;
  needsPerson: boolean;
}

/** One step written for a person (§29.1). The value of a typed step is never shown. */
export function stepLine(step: PathStep, notes: StepNotes): string {
  const target = step.target;
  const phrase = target?.row === true ? "" : elementPhrase(step, notes.name);
  const mark = notes.others ? " (from others)" : "";
  let line: string;
  switch (step.tool) {
    case "tap":
      line = target?.row === true ? `Tap the ${ordinal(target.index ?? 1)} row of the list.` : `Tap ${phrase}${mark}`;
      break;
    case "long_press":
      line = target?.row === true ? `Press and hold the ${ordinal(target.index ?? 1)} row of the list.` : `Press and hold ${phrase}${mark}`;
      break;
    case "toggle":
      line = target?.row === true ? `Switch the ${ordinal(target.index ?? 1)} row of the list.` : `Switch ${phrase}${mark}`;
      break;
    case "type_text":
      line = target === undefined ? "Type something" : `Type something in ${phrase}${mark}`;
      break;
    case "scroll": {
      const to = step["to"];
      const direction = typeof step["direction"] === "string" ? step["direction"] : "down";
      line = to === "end" ? "Scroll to the end" : to === "start" ? "Scroll to the start" : `Scroll ${direction}`;
      break;
    }
    case "swipe": {
      const dx = Number(step["x1"]) - Number(step["x0"]);
      const dy = Number(step["y1"]) - Number(step["y0"]);
      line = Math.abs(dy) >= Math.abs(dx) ? (dy < 0 ? "Swipe up" : "Swipe down") : dx < 0 ? "Swipe left" : "Swipe right";
      break;
    }
    case "back":
      line = "Go back";
      break;
    case "open_url":
      line = `Open the link ${cutDownLink(typeof step["url"] === "string" ? step["url"] : "")}`;
      break;
    default:
      line = `Run ${step.tool}${notes.name !== null ? ` ${notes.name}` : ""}`;
  }
  const done = oneLine(line);
  return notes.needsPerson ? `${done} (needs a person)` : done;
}

// -- the page (§29.1)

/** Everything the page is written from. `finding` is already redacted (§29.6). */
export interface PageInput {
  finding: BugFinding;
  meta: BugMeta;
  /** The picture's file name in the folder when it is there. */
  pictureFile: string | null;
}

const section = (title: string, lines: string[]): string[] => [`## ${title}`, ...lines, ""];

export function reproducedLines(meta: BugMeta, kind: BugKind): string[] {
  const r = meta.reproduced;
  if ("checked" in r) return [`not checked (${oneLine(r.why)})`];
  const runs = `${r.n} of ${r.of} runs`;
  const body = r.n === r.of ? runs : r.n === 0 ? `${runs}: not reproduced` : `${runs} (flaky)`;
  if (kind === "observed") return [`${runs} reached the same screen. A note can't be checked by the tool; look at it.`, `Script: repro.json (a version 2 script).`];
  return [`${body}. Script: repro.json (a version 2 script).`];
}

export function seenLines(meta: BugMeta): string[] {
  const s = meta.seen;
  const times = `${s.count} ${s.count === 1 ? "time" : "times"}`;
  const builds = s.builds.length === 1 ? `build ${s.builds[0]}` : `builds ${s.builds.join(", ")}`;
  return [`${times}; first ${s.first.slice(0, 10)}, last ${s.last.slice(0, 10)}; ${builds}.`];
}

export function pictureLines(finding: Pick<BugFinding, "picture">, meta: BugMeta, pictureFile: string | null): string[] {
  if (finding.picture === null) return ["There is no picture."];
  if (pictureFile !== null) return [`![The screen at the moment](${pictureFile})`];
  if (finding.picture.private) return [`A picture exists and is private. To include it: bug_report {"bug": "${meta.id}", "with_picture": true}`];
  return ["A picture was taken, but its file is gone."];
}

const SOURCE_WORDS: Record<BugHow, string> = { explore: "explore", failure: "a failed check", journey: "a journey", now: "seen while driving" };

function describePlace(finding: BugFinding, meta: BugMeta): string {
  const name = finding.place ?? "an unnamed screen";
  const key = meta.place_key;
  const route = meta.route_text ?? (key !== null && "route" in key ? `route ${key.route.join(" \u203a ")}${key.tab !== undefined ? `, tab ${key.tab}` : ""}` : null);
  if (key !== null && "signature" in key) return `${name} (signature ${key.signature})`;
  return route === null ? name : `${name} (${route})`;
}

/** The page as Markdown (§29.1): nine sections in a fixed order, about 80 lines at most. */
export function bugPageMarkdown(input: PageInput): string {
  const { finding, meta } = input;
  const out: string[] = [`# ${bugTitle(finding)}`, ""];
  const got = oneLine(finding.got.split("\n").join("; "));
  out.push(...section("What happened", [`Expected: ${oneLine(finding.expected).replace(/\.$/, "")}. Got: ${cutText(got, LOG_LINE_MAX)}`]));

  // How to see it
  const steps = finding.path;
  const how: string[] = [];
  if (finding.path_from !== null) how.push(`Start on ${finding.path_from}.`);
  else how.push(finding.kind === "observed" ? "The screen it started on isn't known." : "It doesn't start from a known screen.");
  if (meta.steps_cut === true) how.push("Earlier steps couldn't be written down.");
  if (steps.length === 0) how.push("There are no steps: it shows on the screen as it is.");
  const first = Math.max(0, steps.length - STEPS_SHOWN);
  if (first > 0) how.push(`The first ${first} steps are in repro.json.`);
  for (let i = first; i < steps.length; i++) {
    how.push(`${i - first + 1}. ${stepLine(steps[i] as PathStep, { name: meta.names?.[i] ?? null, others: meta.others?.includes(i) === true, needsPerson: meta.needs_person?.includes(i) === true })}`);
  }
  out.push(...section("How to see it", how));

  out.push(...section("Reproduced", reproducedLines(meta, finding.kind)));

  out.push(
    ...section("Environment", [
      `- App: ${finding.app} ${finding.app_version} (${finding.build})`,
      `- Device: ${finding.device.model}, ${finding.device.os}`,
      `- Tool: ${finding.tool} ${finding.tool_version}, found ${finding.when.slice(0, 10)} ${finding.when.slice(11, 19)} UTC (${SOURCE_WORDS[meta.source.how]}${meta.source.finding !== undefined ? `, finding ${meta.source.finding}` : ""})`,
      ...("checked" in meta.reproduced ? [] : [`- Reset before each run: ${meta.reproduced.reset}`]),
    ]),
  );

  const where: string[] = [`- Place: ${describePlace(finding, meta)}`];
  if (finding.crash !== undefined && finding.crash.frames.length > 0) where.push(`- Frames: ${finding.crash.frames.slice(0, CRASH_FRAMES_MAX).map((frame) => oneLine(stripPaths(frame))).join(", ")}`);
  if (finding.component_stack !== undefined && finding.component_stack.length > 0) where.push(`- Components: ${finding.component_stack.map(oneLine).join(", ")}`);
  if (meta.source.file !== undefined) where.push(`- Source: ${oneLine(stripPaths(meta.source.file))}${meta.source.line !== undefined ? ` line ${meta.source.line}` : ""}`);
  if (finding.system !== undefined) where.push(`- A system sheet was in front: ${finding.system}.`);
  out.push(...section("Where", where));

  const logs = finding.logs.slice(-LOG_LINES_MAX).map((line) => cutText(oneLine(stripPaths(line)), LOG_LINE_MAX).replace(/```/g, "'''"));
  out.push(...section("Logs", logs.length === 0 ? ["No log lines."] : ["```", ...logs, "```"]));
  out.push(...section("Picture", pictureLines(finding, meta, input.pictureFile)));
  out.push(...section("Seen before", seenLines(meta)));
  while (out[out.length - 1] === "") out.pop();
  return `${out.join("\n")}\n`;
}

/** Replaces the lines of one `## <title>` section of a page, and leaves the rest as it is. A missing section is added at the end. */
export function replaceSection(markdown: string, title: string, lines: string[]): string {
  const rows = markdown.replace(/\n+$/, "").split("\n");
  const start = rows.indexOf(`## ${title}`);
  if (start < 0) return `${rows.join("\n")}\n\n## ${title}\n${lines.join("\n")}\n`;
  let end = start + 1;
  while (end < rows.length && !(rows[end] ?? "").startsWith("## ")) end++;
  const keepBlank = end < rows.length;
  rows.splice(start + 1, end - start - 1, ...lines, ...(keepBlank ? [""] : []));
  return `${rows.join("\n")}\n`;
}

const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** `report.html`: the same page as one file, inline style, no script, no request, every text escaped (§29.1). A picture is linked by its file name. */
export function bugPageHtml(markdown: string): string {
  const rows = markdown.replace(/\n+$/, "").split("\n");
  const body: string[] = [];
  let title = "Bug report";
  let list: "ul" | "ol" | null = null;
  const closeList = (): void => {
    if (list !== null) body.push(`</${list}>`);
    list = null;
  };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as string;
    if (row.startsWith("```")) {
      closeList();
      const code: string[] = [];
      for (i++; i < rows.length && !(rows[i] as string).startsWith("```"); i++) code.push(rows[i] as string);
      body.push(`<pre>${escapeHtml(code.join("\n"))}</pre>`);
      continue;
    }
    const h1 = /^# (.*)$/.exec(row);
    const h2 = /^## (.*)$/.exec(row);
    const bullet = /^- (.*)$/.exec(row);
    const numbered = /^\d+\. (.*)$/.exec(row);
    const image = /^!\[([^\]]*)\]\(([\w.-]+)\)$/.exec(row);
    if (h1 !== null) {
      closeList();
      title = h1[1] ?? title;
      body.push(`<h1>${escapeHtml(h1[1] ?? "")}</h1>`);
    } else if (h2 !== null) {
      closeList();
      body.push(`<h2>${escapeHtml(h2[1] ?? "")}</h2>`);
    } else if (bullet !== null || numbered !== null) {
      const kind = bullet !== null ? "ul" : "ol";
      if (list !== kind) {
        closeList();
        body.push(`<${kind}>`);
        list = kind;
      }
      body.push(`<li>${escapeHtml((bullet ?? numbered)?.[1] ?? "")}</li>`);
    } else if (image !== null) {
      closeList();
      body.push(`<p><img src="${escapeHtml(image[2] ?? "")}" alt="${escapeHtml(image[1] ?? "")}"></p>`);
    } else if (row.trim() === "") {
      closeList();
    } else {
      closeList();
      body.push(`<p>${escapeHtml(row)}</p>`);
    }
  }
  closeList();
  const style = "body{font:15px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#1b1b1b;background:#fff}h1{font-size:1.4rem}h2{font-size:1.05rem;margin-top:1.4rem;border-bottom:1px solid #ddd}pre{background:#f4f4f4;padding:.6rem;overflow:auto;white-space:pre-wrap}img{max-width:20rem}";
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${style}</style></head><body>\n${body.join("\n")}\n</body></html>\n`;
}

/** The text a path step holds that a person typed is never kept (§27.1): a typed step is `${typed}`. */
export const isTypedStep = (step: PathStep): boolean => step.tool === "type_text" || step.text === TYPED;
