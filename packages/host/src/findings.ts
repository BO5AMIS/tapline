import { redactContent } from "./accounts.js";

// Findings (AGENT-TOOLS 1.15 §27): one shape for what a test or an explore found, whichever tool found it.

export const FINDING_KINDS = ["crash", "js_error", "dead_end", "refused", "slow", "a11y", "ux", "unreachable", "expect_failed"] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

/** A step of a finding's path: the steps `run` takes (§9.1), targeted as a road is (§18.2): never by ref. */
export type PathStep = { tool: string; target?: { id?: string; label?: string; text?: string; row?: true; index?: number }; text?: string; [key: string]: unknown };

export interface Finding {
  id: string;
  kind: FindingKind;
  app: string;
  app_version: string;
  build: string;
  tool: "tapline";
  tool_version: string;
  when: string;
  device: { model: string; os: string };
  place: string | null;
  path_from: string | null;
  path: PathStep[];
  expected: string;
  got: string;
  picture: { file: string; private: boolean } | null;
  logs: string[];
  crash?: { reason: string; frames: string[] };
  component_stack?: string[];
  repro: string | null;
  count: number;
}

export const LOG_LINE_MAX = 300;
export const LOG_LINES_MAX = 20;
export const A11Y_LINES_MAX = 10;
export const CRASH_FRAMES_MAX = 8;

/** The step text of a typed step; the value is never kept (§25.6, §27.1). */
export const TYPED = "${typed}";

/** A text cut at `max` characters with what is missing said, as the log lines are (§15.1). */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…(+${text.length - max})`;
}

/** The first line of a text. */
export const firstLine = (text: string): string => text.split("\n")[0] ?? "";

/**
 * Every text of a finding goes through the redaction of §20.3 first (`got`, `expected`, `path`, `logs`, `crash`, `component_stack`),
 * and is cut only after that. `${…}` pieces (the typed placeholder) are syntax and stay.
 */
export function redactFinding<T>(value: T, redact: (text: string) => string): T {
  // A finding's texts are app content, not validated syntax: only the typed placeholder is kept, any other `${…}` is checked like any text.
  return redactContent(value, redact, (piece) => piece === TYPED) as T;
}

/** What a finding is before it has its id: the rest of the shape, as the engine knows it. */
export type FindingDraft = Omit<Finding, "id" | "count" | "repro" | "picture"> & { picture?: Finding["picture"]; repro?: string | null };

/**
 * The run's findings. The same finding (the same kind, place and first line of `got`) is reported once with a `count` (§25.10).
 * `add` answers the finding and whether it is new (a new one gets its picture and repro written by the caller).
 */
export class FindingBook {
  private readonly list: Finding[] = [];
  private readonly byKey = new Map<string, Finding>();

  add(draft: FindingDraft): { finding: Finding; isNew: boolean } {
    const key = `${draft.kind}\u0000${draft.place ?? ""}\u0000${firstLine(draft.got)}`;
    const known = this.byKey.get(key);
    if (known !== undefined) {
      known.count += 1;
      return { finding: known, isNew: false };
    }
    const finding: Finding = { ...draft, id: `f${this.list.length + 1}`, picture: draft.picture ?? null, repro: draft.repro ?? null, count: 1 };
    this.list.push(finding);
    this.byKey.set(key, finding);
    return { finding, isNew: true };
  }

  all(): Finding[] {
    return this.list;
  }

  /** `1 crash, 2 js_error, 1 a11y`: counts of findings by kind, in the order of FINDING_KINDS; empty when none. */
  summary(): string {
    const parts: string[] = [];
    for (const kind of FINDING_KINDS) {
      const n = this.list.filter((finding) => finding.kind === kind).length;
      if (n > 0) parts.push(`${n} ${kind}`);
    }
    return parts.join(", ");
  }
}

/** The repro script of a finding (§27.1): a version 2 script that starts at `path_from` and runs `path`; a typed step lists `typed` as a variable. */
export function reproScript(finding: Pick<Finding, "id" | "app" | "path_from" | "path">): Record<string, unknown> {
  const typed = finding.path.some((step) => step.text === TYPED);
  return {
    format: "agent-tools-script",
    version: 2,
    name: `explore-${finding.id}`,
    app: finding.app,
    fresh: false,
    ...(finding.path_from !== null ? { start: finding.path_from } : {}),
    ...(typed ? { variables: ["typed"] } : {}),
    steps: finding.path,
  };
}
