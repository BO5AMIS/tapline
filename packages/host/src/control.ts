import { randomBytes } from "node:crypto";
import { safeEqual } from "./api.js";
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
  /** Milliseconds agent actions spent waiting for a person to be quiet, in all (`explore` does not count them toward its minutes). */
  private waitedTotal = 0;
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

  /** The time agent actions have waited for a person so far (it only grows). */
  waitedMs(): number {
    return this.waitedTotal;
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
    try {
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
    } finally {
      this.waitedTotal += this.now() - started;
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
  private holder: { owner: string; credential: string; expires: number } | null = null;
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

  /** True when `credential` is the standing lease's own (a label never is). */
  holds(credential: string | undefined): boolean {
    if (credential === undefined || this.heldBy() === null || this.holder === null) return false;
    return safeEqual(credential, this.holder.credential);
  }

  /**
   * A call that supplies a credential must hold the lease right now: one that is not the current holder's, an expired one included,
   * is refused with `lease_lost`, also when no one holds the lease. No credential is no check (an ordinary client's call).
   */
  assertCurrent(credential: string | undefined): void {
    if (credential === undefined || this.holds(credential)) return;
    throw new TaplineError("lease_lost", "the run no longer holds the phone (its lease expired, was released or belongs to another run); nothing was sent.");
  }

  /**
   * Takes the lease for `owner`, or says why not: another run holds it, another agent's action is running, or a person is
   * driving (`personActive`, from the control queue). The answer carries the lease credential (32 random bytes, hex): the
   * holder presents it on every later call, and a label alone never counts as the holder. Asking again with the credential renews.
   */
  acquire(owner: string, ttlMs: number, personActive: boolean, credential?: string): { ok: true; credential: string } | { ok: false; by: LeaseRefusal } {
    const ttl = Math.min(Math.max(ttlMs, 1000), LEASE_MAX_TTL_MS);
    if (this.heldBy() !== null && this.holder !== null) {
      if (!this.holds(credential)) return { ok: false, by: "lease" };
      this.holder.expires = this.now() + ttl;
      return { ok: true, credential: this.holder.credential };
    }
    for (const [who, count] of this.inflight) if (who !== owner && count > 0) return { ok: false, by: "agent" };
    if (personActive) return { ok: false, by: "person" };
    const fresh = randomBytes(32).toString("hex");
    this.holder = { owner, credential: fresh, expires: this.now() + ttl };
    return { ok: true, credential: fresh };
  }

  /** Renews the lease when `credential` is the holder's; false when it isn't (the lease was lost or never held). */
  renew(credential: string | undefined, ttlMs: number): boolean {
    if (!this.holds(credential) || this.holder === null) return false;
    this.holder.expires = this.now() + Math.min(Math.max(ttlMs, 1000), LEASE_MAX_TTL_MS);
    return true;
  }

  /** Releases the lease when `credential` is the holder's; false when it isn't (never another's). */
  release(credential: string | undefined): boolean {
    if (!this.holds(credential)) return false;
    this.holder = null;
    return true;
  }

  /** An agent action by `who`: waits while someone else's lease stands (the holder's own credential goes straight through), `busy` after `giveUpMs`. */
  async run<T>(who: string, fn: () => Promise<T>, credential?: string): Promise<T> {
    // A credential that isn't the standing holder's (expired, released, never issued) is never an ordinary call: the run lost the phone.
    this.assertCurrent(credential);
    const started = this.now();
    for (;;) {
      // a lease that changed hands while this call waited
      if (credential !== undefined) this.assertCurrent(credential);
      if (this.heldBy() === null || this.holds(credential)) break;
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
