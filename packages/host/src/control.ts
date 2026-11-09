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
