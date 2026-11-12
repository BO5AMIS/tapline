import { isCompositeTag, isFiber, fiberName, type Fiber } from './fiber';
import { onCommitRoot } from './register';
import { TaplineError, isRecord } from './types';

/**
 * AGENT-TOOLS §15.3 `performance`, Tapline's side: the JavaScript thread's frames, the Hermes heap and (in a
 * development build) the slowest component renders, measured between `perfStart` and `perfStop`.
 *
 * Frames come from a requestAnimationFrame loop: each callback is one frame, the gap to the one before is the
 * frame interval. A gap over 50 ms is a drop; the longest gap is how long the JS thread was busy at most.
 * This is the JavaScript thread's view, not the screen's: native animations that don't need JS don't show.
 */

/** A frame interval longer than this is a drop (§15.3). */
export const DROP_MS = 50;
/** How often the heap is read while measuring. */
export const HEAP_SAMPLE_MS = 250;
/** A measurement nobody stopped (the host went away) ends by itself after this long. */
export const MAX_WINDOW_MS = 40_000;
/** Renders shorter than this don't make the list. */
export const MIN_RENDER_MS = 1;
/** At most this many components are reported. */
export const MAX_RENDERS = 5;
/** Fibers visited per commit at most (a bound on the cost of measuring). */
const MAX_FIBERS_PER_COMMIT = 20_000;
/** React's `PerformedWork` flag: this fiber's component rendered in the commit. */
const PERFORMED_WORK = 1;

export interface RenderTime {
  name: string;
  /** The longest this component took in one render in the window (its own time, without its children), in ms. */
  ms: number;
  /** How many times it rendered in the window. */
  count: number;
}

export interface PerfResult {
  /** The length of the window in seconds. */
  seconds: number;
  frames: number;
  /** Average frames per second over the window. */
  fps: number;
  /** The lowest one-second sample (the whole window's average when it is shorter than a second). */
  fpsLowest: number;
  /** Frame intervals over 50 ms. */
  drops: number;
  /** The longest frame interval: the JS thread's longest stall. */
  busyMs: number;
  /** The Hermes heap now and at its peak, in MB; absent without Hermes. */
  heapMb?: number;
  heapPeakMb?: number;
  /** The slowest components, longest first; absent outside a development build or when React gave no timing. */
  renders?: RenderTime[];
}

export interface PerfDeps {
  now: () => number;
  requestFrame: (fn: () => void) => unknown;
  cancelFrame: (handle: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  /** The Hermes heap in MB, or null when it can't be read. */
  heapMb: () => number | null;
  /** A development build: React times its renders. */
  dev: boolean;
  onCommitRoot: (listener: (root: unknown) => void) => () => void;
}

/** The Hermes heap in MB (live allocated bytes, else the heap's size); null without Hermes. */
export function hermesHeapMb(): number | null {
  const hermes = (globalThis as { HermesInternal?: unknown }).HermesInternal;
  if (!isRecord(hermes) || typeof hermes.getInstrumentedStats !== 'function') return null;
  try {
    const read = hermes.getInstrumentedStats as () => unknown;
    const stats = read.call(hermes);
    if (!isRecord(stats)) return null;
    const bytes = typeof stats.js_allocatedBytes === 'number' ? stats.js_allocatedBytes : stats.js_heapSize;
    return typeof bytes === 'number' && Number.isFinite(bytes) ? bytes / (1024 * 1024) : null;
  } catch {
    return null;
  }
}

function defaultDeps(): PerfDeps {
  const g = globalThis as {
    requestAnimationFrame?: (fn: () => void) => unknown;
    cancelAnimationFrame?: (handle: unknown) => void;
  };
  return {
    now: () => Date.now(),
    requestFrame: (fn) => (typeof g.requestAnimationFrame === 'function' ? g.requestAnimationFrame(fn) : setTimeout(fn, 16)),
    cancelFrame: (handle) => {
      if (typeof g.cancelAnimationFrame === 'function') g.cancelAnimationFrame(handle);
      else clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    heapMb: hermesHeapMb,
    dev: typeof __DEV__ !== 'undefined' && __DEV__,
    onCommitRoot,
  };
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** The numbers of one measurement window. */
export class PerfSampler {
  private readonly deps: PerfDeps;
  private running = false;
  private startedAt = 0;
  private lastFrame = 0;
  private frames = 0;
  private drops = 0;
  private busy = 0;
  /** Frames per one-second slot of the window. */
  private slots: number[] = [];
  private heap: number | null = null;
  private heapPeak: number | null = null;
  private frameHandle: unknown = null;
  private heapTimer: unknown = null;
  private stopCommits: (() => void) | null = null;
  private readonly renders = new Map<string, { ms: number; count: number }>();
  /** React gave no timing for a render that did work (a build without the profiler). */
  private timingMissing = false;

  constructor(deps: Partial<PerfDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  get active(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const { deps } = this;
    this.startedAt = deps.now();
    this.lastFrame = this.startedAt;
    this.sampleHeap();
    this.frameHandle = deps.requestFrame(this.onFrame);
    this.heapTimer = deps.setInterval(() => this.sampleHeap(), HEAP_SAMPLE_MS);
    if (deps.dev) this.stopCommits = deps.onCommitRoot((root) => this.onCommit(root));
  }

  /** Ends the window without a result (the host went away). */
  abort(): void {
    if (!this.running) return;
    this.running = false;
    this.release();
  }

  stop(): PerfResult {
    if (!this.running) throw new TaplineError('bad_params', 'no performance measurement is running; start one first');
    const end = this.deps.now();
    this.sampleHeap();
    this.running = false;
    this.release();
    // A stall that is still going on counts: no frame has ended it yet, so it lasted at least this long.
    const tail = end - this.lastFrame;
    if (tail > DROP_MS) {
      this.drops += 1;
      if (tail > this.busy) this.busy = tail;
    }
    const elapsedMs = Math.max(1, end - this.startedAt);
    const fps = this.frames / (elapsedMs / 1000);
    const whole = Math.floor(elapsedMs / 1000);
    let lowest = fps;
    if (whole > 0) {
      lowest = Infinity;
      for (let i = 0; i < whole; i++) lowest = Math.min(lowest, this.slots[i] ?? 0);
    }
    const result: PerfResult = {
      seconds: round1(elapsedMs / 1000),
      frames: this.frames,
      fps: round1(fps),
      fpsLowest: round1(lowest),
      drops: this.drops,
      busyMs: Math.round(this.busy),
    };
    if (this.heap !== null && this.heapPeak !== null) {
      result.heapMb = round1(this.heap);
      result.heapPeakMb = round1(this.heapPeak);
    }
    if (this.deps.dev && !this.timingMissing) {
      result.renders = [...this.renders.entries()]
        .map(([name, r]): RenderTime => ({ name, ms: round1(r.ms), count: r.count }))
        .filter((r) => r.ms >= MIN_RENDER_MS)
        .sort((a, b) => b.ms - a.ms)
        .slice(0, MAX_RENDERS);
    }
    return result;
  }

  private release(): void {
    if (this.frameHandle !== null) this.deps.cancelFrame(this.frameHandle);
    if (this.heapTimer !== null) this.deps.clearInterval(this.heapTimer);
    this.frameHandle = null;
    this.heapTimer = null;
    const stopCommits = this.stopCommits;
    this.stopCommits = null;
    if (stopCommits !== null) stopCommits();
  }

  private readonly onFrame = (): void => {
    if (!this.running) return;
    const t = this.deps.now();
    const gap = t - this.lastFrame;
    this.lastFrame = t;
    this.frames += 1;
    if (gap > DROP_MS) this.drops += 1;
    if (gap > this.busy) this.busy = gap;
    const slot = Math.floor((t - this.startedAt) / 1000);
    this.slots[slot] = (this.slots[slot] ?? 0) + 1;
    this.frameHandle = this.deps.requestFrame(this.onFrame);
  };

  private sampleHeap(): void {
    const mb = this.deps.heapMb();
    if (mb === null) return;
    this.heap = mb;
    if (this.heapPeak === null || mb > this.heapPeak) this.heapPeak = mb;
  }

  /**
   * One commit's renders (development builds): every component that did work in this commit has an
   * `actualDuration` (its time and its children's); its own time is that less what its children took.
   * A subtree that did no work is skipped when React says so (`subtreeFlags`), which keeps this cheap.
   */
  private onCommit(root: unknown): void {
    if (!isRecord(root) || !isFiber(root.current)) return;
    const stack: Fiber[] = [root.current];
    let visited = 0;
    while (stack.length > 0 && visited < MAX_FIBERS_PER_COMMIT) {
      const fiber = stack.pop() as Fiber;
      visited += 1;
      const raw = fiber as unknown as Record<string, unknown>;
      const flags = typeof raw.flags === 'number' ? raw.flags : 0;
      if (isCompositeTag(fiber.tag) && (flags & PERFORMED_WORK) !== 0) this.noteRender(fiber);
      const subtree = raw.subtreeFlags;
      if (typeof subtree === 'number' && (subtree & PERFORMED_WORK) === 0) continue;
      for (let child = fiber.child; child; child = child.sibling) stack.push(child);
    }
  }

  private noteRender(fiber: Fiber): void {
    const own = actualDuration(fiber);
    if (own === null) {
      this.timingMissing = true;
      return;
    }
    let children = 0;
    for (let child = fiber.child; child; child = child.sibling) {
      const flags = (child as unknown as { flags?: unknown }).flags;
      const worked = !isCompositeTag(child.tag) || (typeof flags === 'number' && (flags & PERFORMED_WORK) !== 0);
      const d = worked ? actualDuration(child) : null;
      if (d !== null) children += d;
    }
    const name = fiberName(fiber);
    if (name === null) return;
    const ms = Math.max(0, own - children);
    const seen = this.renders.get(name);
    if (seen === undefined) this.renders.set(name, { ms, count: 1 });
    else {
      seen.count += 1;
      if (ms > seen.ms) seen.ms = ms;
    }
  }
}

function actualDuration(fiber: Fiber): number | null {
  const d = (fiber as unknown as { actualDuration?: unknown }).actualDuration;
  return typeof d === 'number' && Number.isFinite(d) ? d : null;
}

/* -------------------------------------------------------------------------- */
/* The one measurement the host runs                                           */
/* -------------------------------------------------------------------------- */

let current: PerfSampler | null = null;
let guard: ReturnType<typeof setTimeout> | null = null;

/** Ends any measurement without a result: the host is gone, so nobody will ask for it. */
export function stopPerf(): void {
  if (guard !== null) clearTimeout(guard);
  guard = null;
  const sampler = current;
  current = null;
  if (sampler !== null) sampler.abort();
}

/** `perfStart`: begins a window (a measurement already running is dropped). */
export async function perfStart(): Promise<{ started: true; dev: boolean; heap: boolean }> {
  stopPerf();
  const sampler = new PerfSampler();
  current = sampler;
  sampler.start();
  guard = setTimeout(stopPerf, MAX_WINDOW_MS);
  return { started: true, dev: typeof __DEV__ !== 'undefined' && __DEV__, heap: hermesHeapMb() !== null };
}

/** `perfStop`: ends the window and answers its numbers. */
export async function perfStop(): Promise<PerfResult> {
  const sampler = current;
  if (sampler === null || !sampler.active) {
    throw new TaplineError('bad_params', 'no performance measurement is running; start one first');
  }
  if (guard !== null) clearTimeout(guard);
  guard = null;
  current = null;
  return sampler.stop();
}
