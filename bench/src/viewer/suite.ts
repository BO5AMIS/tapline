import { checkBeforeViewerTap, labAppOf, setStep } from "../guard.js";
import { isErrorAnswer } from "../lab.js";
import type { ToolSession } from "../mcp.js";
import {
  notMeasuredRow,
  speedRow,
  valueRow,
  type ResultRow,
  type SpeedRow,
} from "../scorecard.js";
import { summarize } from "../stats.js";
import type { Link } from "../targets.js";
import { ViewerClient } from "./client.js";
import { cropDiffer, decodeFrame, type Crop } from "./diff.js";
import { parseViewerLink, redactToken, type ViewerLink } from "./link.js";
import { jpegSize, type Frame } from "./mjpeg.js";

/* ---------- pure computations ---------- */

/** Frames per second: `count` frames over `seconds`. */
export function framesPerSecond(count: number, seconds: number): number {
  return seconds > 0 ? count / seconds : Number.NaN;
}

/**
 * The longest gap in seconds between consecutive arrivals (performance.now() ms) inside the window
 * [startMs, endMs]. The window's own edges count as arrivals, so a stream that goes quiet for the
 * whole window (or at its start or end) shows as a long gap, not as no data.
 */
export function maxGapSeconds(arrivalsMs: number[], startMs: number, endMs: number): number {
  const inside = arrivalsMs.filter((t) => t >= startMs && t <= endMs).sort((a, b) => a - b);
  const points = [startMs, ...inside, endMs];
  let max = 0;
  for (let i = 1; i < points.length; i++) {
    max = Math.max(max, (points[i] ?? 0) - (points[i - 1] ?? 0));
  }
  return max / 1000;
}

/** Frame ages in seconds: arrival (Date.now()) minus X-Captured-At. Frames without a capture time are skipped. */
export function frameAgesSeconds(frames: Pick<Frame, "arrivalWall" | "capturedAt">[]): number[] {
  return frames
    .filter((f): f is { arrivalWall: number; capturedAt: number } => f.capturedAt !== undefined)
    .map((f) => (f.arrivalWall - f.capturedAt) / 1000);
}

/** Sharpness: pixels of frame width per screen point. */
export function pxPerPt(widthPx: number, widthPt: number): number {
  return widthPt > 0 ? widthPx / widthPt : Number.NaN;
}

/** KB/s with 1 KB = 1000 bytes (the stricter reading of the 33 KB/s bar). */
export function kbPerSecond(bytes: number, seconds: number): number {
  return seconds > 0 ? bytes / 1000 / seconds : Number.NaN;
}

export interface LookGeometry {
  /** Screen size in points, from the header's first line. */
  screen: { w: number; h: number };
  /** The element's centre in points, when found. */
  center?: { x: number; y: number };
  /** The element's box in points, when found. */
  rect?: { x: number; y: number; w: number; h: number };
}

/** Reads `Screen 440x956 pt …` and the `id=<id> @x,y WxH` element line of a `look` answer. */
export function parseLook(text: string, id: string): LookGeometry | null {
  const s = /Screen (\d+(?:\.\d+)?)x(\d+(?:\.\d+)?) pt/.exec(text);
  if (s?.[1] === undefined || s[2] === undefined) return null;
  const geometry: LookGeometry = { screen: { w: Number(s[1]), h: Number(s[2]) } };
  const line = text.split("\n").find((l) => new RegExp(`\\bid=${escapeRe(id)}(\\s|$)`).test(l));
  const r = line
    ? /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?) (\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)/.exec(line)
    : null;
  if (r?.[1] && r[2] && r[3] && r[4]) {
    const rect = { x: Number(r[1]), y: Number(r[2]), w: Number(r[3]), h: Number(r[4]) };
    geometry.rect = rect;
    geometry.center = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
  }
  return geometry;
}

/** A box in points as a crop in fractions of the screen, clamped. */
export function cropOf(
  rect: { x: number; y: number; w: number; h: number },
  screen: { w: number; h: number },
): Crop {
  const c = (v: number): number => Math.min(1, Math.max(0, v));
  return {
    x0: c(rect.x / screen.w),
    y0: c(rect.y / screen.h),
    x1: c((rect.x + rect.w) / screen.w),
    y1: c((rect.y + rect.h) / screen.h),
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A tap point as fractions (0..1) of the frame, clamped. */
export function normalize(
  center: { x: number; y: number },
  screen: { w: number; h: number },
): { x: number; y: number } {
  const c = (v: number): number => Math.min(1, Math.max(0, v));
  return { x: c(center.x / screen.w), y: c(center.y / screen.h) };
}

/** Frame width in pixels: the JPEG header, else a full decode. */
export function frameWidthPx(frame: Pick<Frame, "bytes">): number {
  return jpegSize(frame.bytes)?.width ?? decodeFrame(frame.bytes).width;
}

/* ---------- the suite ---------- */

export interface ViewerOptions {
  samples: number;
  link: Link;
  /** Pause between V1 taps, ms (default 2500). */
  tapGapMs?: number;
  /** V1 gives up on a tap after this long, ms (default 4000). */
  giveUpMs?: number;
  /** Length of each measuring window, ms (default 10000). */
  windowMs?: number;
  /** Wait after the animation starts, ms (default 1000). */
  warmupMs?: number;
  /** Wait for 2 new frames after a quality change, ms (default 6000). */
  presetWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const PRESETS = ["sharp", "balanced", "light"] as const;

async function must(tool: ToolSession, name: string, args: Record<string, unknown>, tokenOf?: string): Promise<string> {
  const r = await tool.call(name, args);
  if (isErrorAnswer(r.text, r.isError)) {
    throw new Error(`${name} failed: ${redactToken(r.text, tokenOf).slice(0, 200)}`);
  }
  return r.text;
}

/** Gets the viewer link from the tool's `viewer` answer. */
export async function getViewerLink(tool: ToolSession): Promise<ViewerLink> {
  const r = await tool.call("viewer", {});
  const link = parseViewerLink(r.text);
  if (!link) {
    throw new Error(`viewer gave no link with a token: ${redactToken(r.text).slice(0, 200)}`);
  }
  return link;
}

async function waitForFirstFrame(client: ViewerClient, ms: number): Promise<Frame> {
  const f = await client.waitFor(() => client.frames[client.frames.length - 1], ms);
  if (!f) throw new Error(`no frame on /stream within ${ms / 1000} s${client.streamError ? `: ${client.streamError}` : ""}`);
  return f;
}

/**
 * The first frame among `after` whose `crop` differs from `before`, by binary search. Once the
 * counter has changed it stays changed until the next tap, so "differs" only turns on once.
 */
export function firstChanged(before: Frame, after: Frame[], crop: Crop): Frame | undefined {
  const last = after[after.length - 1];
  if (!last) return undefined;
  const base = decodeFrame(before.bytes);
  const differs = (f: Frame): boolean => cropDiffer(base, decodeFrame(f.bytes), crop);
  if (!differs(last)) return undefined;
  let lo = 0;
  let hi = after.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const f = after[mid];
    if (f && differs(f)) hi = mid;
    else lo = mid + 1;
  }
  return after[hi];
}

/** How long V1 waits before it first compares (no decoding while frames arrive). */
const V1_FIRST_LOOK_MS = 1500;

/**
 * V1: N taps sent on /ws; time to the first /stream frame whose counter crop differs from the last
 * frame before the tap. Frames are only stamped while they arrive; decoding (large frames take
 * 100+ ms each) waits until after the window, so it can't delay the arrival times it measures.
 */
export async function runV1(
  client: ViewerClient,
  point: { x: number; y: number },
  crop: Crop,
  n: number,
  link: Link,
  opts: Pick<ViewerOptions, "tapGapMs" | "giveUpMs" | "sleep"> & {
    /** Runs before each tap (outside the timing); false skips that tap. Throws to stop. */
    beforeTap?: () => Promise<boolean>;
  } = {},
): Promise<SpeedRow> {
  const sleep = opts.sleep ?? realSleep;
  const gap = opts.tapGapMs ?? 2500;
  const giveUp = opts.giveUpMs ?? 4000;
  const firstLook = Math.min(giveUp, V1_FIRST_LOOK_MS);
  const secs: number[] = [];
  let failures = 0;
  let skipped = 0;
  const personActions = (): number =>
    client.messages.filter((m) => m.type === "action" && m.body.by === "person").length;
  const actionsBefore = personActions();
  for (let i = 0; i < n; i++) {
    await sleep(gap);
    if (opts.beforeTap && !(await opts.beforeTap())) {
      skipped++;
      failures++;
      continue;
    }
    const beforeFrame = client.frames[client.frames.length - 1];
    if (!beforeFrame) {
      failures++;
      continue;
    }
    const t0 = performance.now();
    client.tap(point.x, point.y);
    const arrived = (): Frame[] =>
      client.frames.filter((f) => f.arrivalPerf >= t0 && f.arrivalPerf <= t0 + giveUp && f.bytes.length > 0);
    await sleep(firstLook);
    let hit = firstChanged(beforeFrame, arrived(), crop);
    if (!hit && giveUp > firstLook) {
      await sleep(Math.max(0, t0 + giveUp - performance.now()));
      hit = firstChanged(beforeFrame, arrived(), crop);
    }
    if (hit) secs.push((hit.arrivalPerf - t0) / 1000);
    else failures++;
  }
  const handled = personActions() - actionsBefore;
  return speedRow("V1", secs, link, {
    errors: failures,
    notes:
      `${handled} of ${n} taps answered with a person action message on /ws` +
      (skipped > 0 ? `; ${skipped} not sent (lab-taps had moved or was gone)` : ""),
  });
}

interface Window {
  startMs: number;
  endMs: number;
  frames: Frame[];
}

async function measureWindow(
  client: ViewerClient,
  ms: number,
  sleep: (ms: number) => Promise<void>,
  during?: () => Promise<void>,
): Promise<Window> {
  const startMs = performance.now();
  const firstIndex = client.frames.length;
  const running = during ? during() : Promise.resolve();
  await sleep(ms);
  const endMs = Math.max(performance.now(), startMs + ms);
  await running;
  const frames = client.frames.slice(firstIndex).filter((f) => f.arrivalPerf <= endMs);
  return { startMs, endMs, frames };
}

/** V5 for one preset: the width of the second new frame after the switch, over the screen's width in points. */
async function measurePreset(
  client: ViewerClient,
  preset: (typeof PRESETS)[number],
  screenWidthPt: number,
  waitMs: number,
): Promise<{ value: number; note?: string }> {
  const from = client.frames.length;
  client.send({ type: "quality", preset });
  const second = await client.waitFor(
    () => (client.frames.length >= from + 2 ? client.frames[from + 1] : undefined),
    waitMs,
  );
  if (!second) return { value: Number.NaN, note: `${preset}: fewer than 2 new frames in ${waitMs / 1000} s` };
  const widthPt = second.size?.w ?? screenWidthPt;
  return { value: pxPerPt(frameWidthPx(second), widthPt) };
}


export async function runViewer(tool: ToolSession, opts: ViewerOptions): Promise<ResultRow[]> {
  const { link, samples } = opts;
  const sleep = opts.sleep ?? realSleep;
  const windowMs = opts.windowMs ?? 10_000;
  const warmupMs = opts.warmupMs ?? 1000;
  const presetWaitMs = opts.presetWaitMs ?? 6000;
  const seconds = windowMs / 1000;
  const viewerLink = await getViewerLink(tool);
  const token = viewerLink.token;
  const rows: ResultRow[] = [];

  const look = await must(tool, "look", { screenshot: false }, token);
  const geometry = parseLook(look, "lab-taps");
  if (!geometry?.center || !geometry.rect) throw new Error("look shows no lab-taps element: is the lab screen open?");
  const point = normalize(geometry.center, geometry.screen);
  const crop = cropOf(geometry.rect, geometry.screen);
  const tapsCenter = geometry.center;

  const client = await ViewerClient.connect(viewerLink);
  let animationOn = false;
  let presetChanged = false;
  try {
    await waitForFirstFrame(client, 5000);

    // Each person tap is a real touch for some tools: check the app and lab-taps' place first.
    const labApp = labAppOf(tool);
    let v1Sample = 0;
    const beforeTap = async (): Promise<boolean> => {
      setStep(tool, `V1[${v1Sample++}]`);
      const now = await tool.call("look", { screenshot: false });
      checkBeforeViewerTap(labApp, now.text);
      const g = parseLook(now.text, "lab-taps");
      const c = g?.center;
      return c !== undefined && Math.abs(c.x - tapsCenter.x) <= 2 && Math.abs(c.y - tapsCenter.y) <= 2;
    };
    rows.push(await runV1(client, point, crop, samples, link, { ...opts, beforeTap }));

    setStep(tool, "V2 (animation on)");
    await must(tool, "toggle", { target: { id: "lab-anim-toggle" }, value: true, look: false }, token);
    animationOn = true;
    await sleep(warmupMs);

    // Window A: V2, V3, V4, V7.kbps.
    const a = await measureWindow(client, windowMs, sleep);
    rows.push(
      valueRow("V2", framesPerSecond(a.frames.length, seconds), "fps", link, {
        failed: a.frames.length === 0,
        notes: `${a.frames.length} frames in ${seconds} s with the animation on`,
      }),
    );
    rows.push(
      valueRow("V3", maxGapSeconds(a.frames.map((f) => f.arrivalPerf), a.startMs, a.endMs), "s", link, {
        notes: "longest gap between frame arrivals, window edges included",
      }),
    );

    // Window B: the same, while the tool runs `look` in a loop.
    setStep(tool, "V3.look");
    let looping = true;
    let lookErrors = 0;
    const lookLoop = async (): Promise<void> => {
      while (looping) {
        const r = await tool.call("look", { screenshot: false });
        if (isErrorAnswer(r.text, r.isError)) lookErrors++;
        await realSleep(0); // yield, so an instantly answering tool can't starve the event loop
      }
    };
    const b = await measureWindow(client, windowMs, sleep, async () => {
      const loop = lookLoop();
      await sleep(windowMs);
      looping = false;
      await loop;
    });
    rows.push(
      valueRow("V3.look", maxGapSeconds(b.frames.map((f) => f.arrivalPerf), b.startMs, b.endMs), "s", link, {
        failed: lookErrors > 0,
        notes: `while look {screenshot:false} ran in a loop${lookErrors > 0 ? `; ${lookErrors} look call(s) failed` : ""}`,
      }),
    );

    const ages = frameAgesSeconds(a.frames);
    rows.push(
      ages.length === 0
        ? notMeasuredRow("V4", "s", "not measured: frames carry no X-Captured-At")
        : valueRow("V4", summarize(ages).median, "s", link, { notes: `median of ${ages.length} frames, V2 window` }),
    );

    const bytes = a.frames.reduce((s, f) => s + f.byteLength, 0);
    rows.push(
      valueRow("V7.kbps", kbPerSecond(bytes, seconds), "KB/s", link, {
        notes: "frame bytes over the V2 window; as stated: <= 80% of the phone's upload",
      }),
    );

    setStep(tool, "V5 (animation off)");
    await must(tool, "toggle", { target: { id: "lab-anim-toggle" }, value: false, look: false }, token);
    animationOn = false;

    // V5 per preset, animation off.
    for (const preset of PRESETS) {
      presetChanged = true;
      const m = await measurePreset(client, preset, geometry.screen.w, presetWaitMs);
      rows.push(
        valueRow(`V5.${preset}`, m.value, "px/pt", link, {
          ...(m.note ? { notes: m.note } : {}),
        }),
      );
    }
    client.send({ type: "quality", preset: "balanced" });
    presetChanged = false;

    // V7.s1: the agent's taps with the stream open.
    const secs: number[] = [];
    let errors = 0;
    let firstError: string | undefined;
    let dropped = 0;
    for (let i = 0; i < samples; i++) {
      setStep(tool, `V7.s1[${i}]`);
      const r = await tool.call("tap", { target: { id: "lab-taps" } });
      if (r.interrupted !== undefined) {
        dropped++;
      } else if (isErrorAnswer(r.text, r.isError)) {
        errors++;
        firstError ??= redactToken(r.text, token).slice(0, 120);
      } else {
        secs.push(r.ms / 1000);
      }
      if (i < samples - 1) await sleep(200);
    }
    setStep(tool, undefined);
    const droppedNote = dropped > 0 ? `; ${dropped} sample(s) left out: iOS's own UI was in front` : "";
    rows.push(
      speedRow("V7.s1", secs, link, {
        errors,
        notes: (firstError ? `first error: ${firstError}` : "taps with /stream open") + droppedNote,
      }),
    );

    rows.push(
      notMeasuredRow(
        "V6",
        "",
        "not measured by the runner (V6 needs the phone's CPU via DVT; V8 needs a browser)",
      ),
      notMeasuredRow(
        "V8",
        "",
        "not measured by the runner (V6 needs the phone's CPU via DVT; V8 needs a browser)",
      ),
    );
  } finally {
    if (animationOn) {
      await tool
        .call("toggle", { target: { id: "lab-anim-toggle" }, value: false, look: false })
        .catch(() => undefined);
    }
    if (presetChanged) {
      try {
        client.send({ type: "quality", preset: "balanced" });
      } catch {
        // socket already gone
      }
    }
    await client.close();
  }
  return rows;
}
