import { TaplineError } from "./server.js";

/**
 * One action at a time on the phone, for the agent and people watching in the live viewer.
 * A person goes first: an agent action waits until the person has been idle for a moment
 * and gives up with `busy` if they keep going. While paused, agent actions are refused.
 */

export interface ControlOptions {
  /** How long a person must be idle before the agent acts again. Default 3000 ms. */
  idleMs?: number;
  /** How long an agent action waits for that before giving up. Default 30 000 ms. */
  giveUpMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type Driver = "agent" | "person" | null;

const POLL_MS = 200;

export class ControlQueue {
  private readonly idleMs: number;
  private readonly giveUpMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  private lastPersonAt = Number.NEGATIVE_INFINITY;
  /** Whose action is running now, if any. */
  private running: Driver = null;
  /** The driver listeners last heard about. */
  private reported: Driver = null;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private isPaused = false;
  private readonly listeners = new Set<() => void>();

  constructor(options: ControlOptions = {}) {
    this.idleMs = options.idleMs ?? 3000;
    this.giveUpMs = options.giveUpMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Who is driving: the agent while its action runs; a person while they act and until they've been idle. */
  driver(): Driver {
    if (this.running !== null) return this.running;
    return this.now() - this.lastPersonAt < this.idleMs ? "person" : null;
  }

  paused(): boolean {
    return this.isPaused;
  }

  setPaused(on: boolean): void {
    if (this.isPaused === on) return;
    this.isPaused = on;
    this.changed();
  }

  /** Called when the driver or the pause changes; returns a function that stops it. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** A person's input: runs as soon as the queue is free, and keeps the agent waiting a moment after. */
  runPerson<T>(fn: () => Promise<T>): Promise<T> {
    this.lastPersonAt = this.now();
    return this.serial(async () => {
      this.lastPersonAt = this.now();
      this.running = "person";
      this.report();
      try {
        return await fn();
      } finally {
        this.lastPersonAt = this.now();
        this.running = null;
        this.report();
        // Tell listeners when the person has gone idle.
        if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
          this.idleTimer = undefined;
          this.report();
        }, this.idleMs + 10);
        this.idleTimer.unref?.();
      }
    });
  }

  /** An agent action: refused while paused; waits for the person to be idle; then runs in turn. */
  async runAgent<T>(fn: () => Promise<T>): Promise<T> {
    if (this.isPaused) throw new TaplineError("paused", "The user paused the agent in the live viewer. Wait until they resume it.");
    const started = this.now();
    while (this.now() - this.lastPersonAt < this.idleMs) {
      if (this.now() - started >= this.giveUpMs) {
        throw new TaplineError(
          "busy",
          "A person is using the app in the live viewer. Try again when they stop, or ask them.",
        );
      }
      await this.sleep(POLL_MS);
      if (this.isPaused) throw new TaplineError("paused", "The user paused the agent in the live viewer. Wait until they resume it.");
    }
    return this.serial(async () => {
      this.running = "agent";
      this.report();
      try {
        return await fn();
      } finally {
        this.running = null;
        this.report();
      }
    });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Tells listeners when the driver differs from what they last heard. */
  private report(): void {
    const driver = this.driver();
    if (this.reported === driver) return;
    this.reported = driver;
    this.changed();
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // a listener's bug must not stop the queue
      }
    }
  }
}

/** Longest a lease may be asked for or kept without a renewal. */
export const LEASE_MAX_TTL_MS = 120_000;

export type LeaseRefusal = "lease" | "agent" | "person";

/**
 * AGENT-TOOLS 1.14 §22.3: a scheduled run holds the phone for its whole run. While it holds this lease, every other
 * agent's action waits (and answers `busy` after a while, as a person's input does); the run's own actions go straight
 * through. The control queue serializes single actions only, so without this a run's steps could interleave with
 * another agent's route. A lease that isn't renewed expires, so a run that died never holds the phone for good.
 */
export class PhoneLease {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly giveUpMs: number;
  private readonly pollMs: number;
  private holder: { owner: string; expires: number } | null = null;
  /** Agent actions running now, by who started them. */
  private readonly inflight = new Map<string, number>();

  constructor(options: { now?: () => number; sleep?: (ms: number) => Promise<void>; giveUpMs?: number; pollMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.giveUpMs = options.giveUpMs ?? 30_000;
    this.pollMs = options.pollMs ?? 200;
  }

  /** Who holds the lease now, or null (an expired lease counts as none). */
  heldBy(): string | null {
    if (this.holder !== null && this.holder.expires <= this.now()) this.holder = null;
    return this.holder?.owner ?? null;
  }

  /**
   * Takes the lease for `owner`, or says why not: another run holds it, another agent's action is running, or a person is
   * driving (`personActive`, from the control queue). Asking again as the holder renews it.
   */
  acquire(owner: string, ttlMs: number, personActive: boolean): { ok: true } | { ok: false; by: LeaseRefusal } {
    const holder = this.heldBy();
    if (holder !== null && holder !== owner) return { ok: false, by: "lease" };
    if (holder === null) {
      for (const [who, count] of this.inflight) if (who !== owner && count > 0) return { ok: false, by: "agent" };
      if (personActive) return { ok: false, by: "person" };
    }
    this.holder = { owner, expires: this.now() + Math.min(Math.max(ttlMs, 1000), LEASE_MAX_TTL_MS) };
    return { ok: true };
  }

  /** Releases the lease when `owner` holds it; false when it doesn't (never another's). */
  release(owner: string): boolean {
    if (this.heldBy() !== owner) return false;
    this.holder = null;
    return true;
  }

  /** An agent action by `who`: waits while someone else's lease stands, `busy` after `giveUpMs`. */
  async run<T>(who: string, fn: () => Promise<T>): Promise<T> {
    const started = this.now();
    for (;;) {
      const holder = this.heldBy();
      if (holder === null || holder === who) break;
      if (this.now() - started >= this.giveUpMs) {
        throw new TaplineError("busy", "A scheduled run is using the phone. Try again when it has finished, or ask your user.");
      }
      await this.sleep(this.pollMs);
    }
    this.inflight.set(who, (this.inflight.get(who) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      const left = (this.inflight.get(who) ?? 1) - 1;
      if (left <= 0) this.inflight.delete(who);
      else this.inflight.set(who, left);
    }
  }
}
