import { setStep } from "./guard.js";
import { closeKeyboard, isErrorAnswer, resetLab } from "./lab.js";
import type { CallResult, ToolSession } from "./mcp.js";
import { speedRow, type SpeedRow } from "./scorecard.js";
import type { Link } from "./targets.js";

export interface SpeedOptions {
  samples: number;
  link: Link;
  /** Pause between actions, ms (default 200). */
  pauseMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Run {
  secs: number[];
  errors: number;
  answers: CallResult[];
  firstError?: string;
  /** Samples left out because their answer named iOS's own UI (a banner over the lab). */
  dropped: number;
}

async function sample(
  tool: ToolSession,
  label: string,
  n: number,
  opts: SpeedOptions,
  step: (i: number) => Promise<CallResult>,
  pause: boolean,
): Promise<Run> {
  const sleep = opts.sleep ?? realSleep;
  const pauseMs = opts.pauseMs ?? 200;
  const run: Run = { secs: [], errors: 0, answers: [], dropped: 0 };
  for (let i = 0; i < n; i++) {
    setStep(tool, `${label}[${i}]`);
    const r = await step(i);
    if (r.interrupted !== undefined) {
      run.dropped++;
    } else if (isErrorAnswer(r.text, r.isError)) {
      run.errors++;
      run.firstError ??= r.text.slice(0, 120);
    } else {
      run.secs.push(r.ms / 1000);
      run.answers.push(r);
    }
    if (pause && pauseMs > 0 && i < n - 1) await sleep(pauseMs);
  }
  setStep(tool, undefined);
  return run;
}

function optNote(n: string | undefined): { notes?: string } {
  return n ? { notes: n } : {};
}

const errorNote = (run: Run): string | undefined => {
  const parts: string[] = [];
  if (run.firstError) parts.push(`first error: ${run.firstError}`);
  if (run.dropped > 0) parts.push(`${run.dropped} sample(s) left out: iOS's own UI was in front`);
  return parts.length > 0 ? parts.join("; ") : undefined;
};

/** Parses "Settled in 0.13 s." from an action answer, in seconds. */
export function parseSettled(text: string): number | undefined {
  const m = /Settled in (\d+(?:\.\d+)?) s/.exec(text);
  return m?.[1] === undefined ? undefined : Number(m[1]);
}

/** S5: spawn to the first successful look, retrying every 250 ms up to 30 s. */
export async function measureStartToReady(
  tool: ToolSession,
  spawnedAt: number,
  link: Link,
  opts: {
    retryMs?: number;
    limitMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<SpeedRow> {
  const now = opts.now ?? ((): number => performance.now());
  const sleep = opts.sleep ?? realSleep;
  const retryMs = opts.retryMs ?? 250;
  const limitMs = opts.limitMs ?? 30_000;
  let lastError = "";
  while (now() - spawnedAt <= limitMs) {
    try {
      const r = await tool.call("look", { screenshot: false });
      if (!isErrorAnswer(r.text, r.isError)) {
        return speedRow("S5", [(now() - spawnedAt) / 1000], link);
      }
      lastError = r.text.slice(0, 120);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    await sleep(retryMs);
  }
  return speedRow("S5", [], link, {
    notes: `not ready within ${limitMs / 1000} s; last: ${lastError}`,
  });
}

/** S1-S3 on the lab screen. Assumes the lab is open. */
export async function runSpeed(tool: ToolSession, opts: SpeedOptions): Promise<SpeedRow[]> {
  const n = opts.samples;
  const { link } = opts;
  const rows: SpeedRow[] = [];
  const scroll = { id: "lab-scroll" };

  await resetLab(tool);

  const s2 = await sample(tool, "S2", n, opts, () => tool.call("look", { screenshot: false }), false);
  rows.push(speedRow("S2", s2.secs, link, { errors: s2.errors, ...optNote(errorNote(s2)) }));

  const s3 = await sample(tool, "S3", n, opts, () => tool.call("look", {}), false);
  const noImage = s3.answers.filter((a) => a.images === 0).length;
  rows.push(
    speedRow("S3", s3.secs, link, {
      errors: s3.errors + noImage,
      ...optNote(noImage > 0 ? `${noImage} answer(s) had no image` : errorNote(s3)),
    }),
  );

  const tap = await sample(tool, "S1", n, opts, () => tool.call("tap", { target: { id: "lab-taps" } }), true);
  rows.push(speedRow("S1", tap.secs, link, { errors: tap.errors, ...optNote(errorNote(tap)) }));

  const settled = tap.answers
    .map((a) => parseSettled(a.text))
    .filter((x): x is number => x !== undefined);
  rows.push(
    speedRow("S1.settle", settled, link, {
      errors: tap.answers.length - settled.length,
      notes: "from the tap answers Settled in line; part of the S1 round trip",
    }),
  );

  const type = await sample(
    tool,
    "S1.type",
    n,
    opts,
    (i) => tool.call("type_text", { target: { id: "lab-input" }, text: `w${i}` }),
    true,
  );
  rows.push(speedRow("S1.type", type.secs, link, { errors: type.errors, ...optNote(errorNote(type)) }));
  // Scroll and toggle are measured with the keyboard closed, as a person would have it.
  await closeKeyboard(tool);

  const sc = await sample(
    tool,
    "S1.scroll",
    n,
    opts,
    (i) =>
      tool.call(
        "scroll",
        i % 2 === 0
          ? { target: scroll, amount: 0.5 }
          : { target: scroll, direction: "up", amount: 0.5 },
      ),
    true,
  );
  rows.push(speedRow("S1.scroll", sc.secs, link, { errors: sc.errors, ...optNote(errorNote(sc)) }));

  const tg = await sample(tool, "S1.toggle", n, opts, () => tool.call("toggle", { target: { id: "lab-switch" } }), true);
  rows.push(speedRow("S1.toggle", tg.secs, link, { errors: tg.errors, ...optNote(errorNote(tg)) }));

  await resetLab(tool);
  return rows;
}
