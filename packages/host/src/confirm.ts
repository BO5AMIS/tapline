import { randomBytes } from "node:crypto";

/**
 * AGENT-TOOLS 1.8 §11.3 / VIEWER-PROTOCOL 1.5: a person's OK for a touch the policy guards. The live view
 * is the only place a request is answered; an allow lets exactly one matching call through within 120 s.
 */

export const CONFIRM_TTL_MS = 120_000;
/** After a person says no, the same touch asks no one for this long (AGENT-TOOLS 1.8 §11.3). */
export const DECLINE_HOLD_MS = 60_000;

export interface ConfirmRequest {
  type: "confirm";
  id: string;
  by: "agent";
  kind: string;
  caption: string;
  word: string;
  /** When the request lapses, ms since the epoch. */
  expires: number;
}
/** Where a person's OK was given: the host's dialog, or the live view (AGENT-TOOLS 1.13 §11.3). */
export type OkVia = "chat" | "live view";

export interface ConfirmClosed {
  type: "confirm_closed";
  id: string;
  allow: boolean;
  /** Set when the host's dialog answered, so the live view can say so. Absent for an answer in the live view. */
  by?: "chat";
}
export type ConfirmEvent = ConfirmRequest | ConfirmClosed;

/** How a request ended, for a call that waited on it. */
export interface Settled {
  allow: boolean;
  via: OkVia;
  /** Nobody answered in time (or the server stopped). */
  expired: boolean;
}

/** What a guarded call may do now. */
export type ConfirmCheck =
  | { granted: true; via: OkVia }
  /** A person said no a moment ago: nobody is asked again yet. */
  | { granted: false; held: true }
  | { granted: false; request: ConfirmRequest; /** " They declined." or " Nobody answered." after a first ask. */ suffix: string };

interface Pending {
  request: ConfirmRequest;
  key: string;
  timer: ReturnType<typeof setTimeout>;
}

export class Confirmations {
  private readonly pending = new Map<string, Pending>();
  /** key → when the allow lapses */
  private readonly grants = new Map<string, { until: number; via: OkVia }>();
  /** request id → calls waiting for its end */
  private readonly waiters = new Map<string, Array<(settled: Settled) => void>>();
  /** key → how the last ask ended without an allow */
  private readonly endings = new Map<string, "declined" | "expired">();
  /** key → when a person last declined it */
  private readonly declinedAt = new Map<string, number>();
  private readonly listeners = new Set<(event: ConfirmEvent) => void>();
  private next = 1;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs: number = CONFIRM_TTL_MS,
  ) {}

  /** The viewer hub listens here; returns the unsubscribe. */
  onEvent(listener: (event: ConfirmEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Requests still open, for a viewer that joins later. */
  open(): ConfirmRequest[] {
    return [...this.pending.values()].map((p) => p.request).filter((r) => r.expires > this.now());
  }

  /**
   * A guarded call on `key` (the tool and the element). Uses up an allow when there is one; otherwise
   * keeps the open request for that key or opens a new one.
   */
  check(key: string, ask: { kind: string; caption: string; word: string }): ConfirmCheck {
    const grant = this.grants.get(key);
    if (grant !== undefined) {
      this.grants.delete(key);
      if (grant.until > this.now()) return { granted: true, via: grant.via };
    }
    // A person said no a moment ago: asking again at once would only wear them down.
    const declined = this.declinedAt.get(key);
    if (declined !== undefined && this.now() - declined < DECLINE_HOLD_MS) return { granted: false, held: true };
    this.declinedAt.delete(key);
    const ending = this.endings.get(key);
    this.endings.delete(key);
    const suffix = ending === "declined" ? " They declined." : ending === "expired" ? " Nobody answered." : "";
    for (const p of this.pending.values()) {
      if (p.key === key && p.request.expires > this.now()) return { granted: false, request: p.request, suffix };
    }
    const request: ConfirmRequest = {
      type: "confirm",
      // Not guessable: an answer must name a request the page was shown.
      id: `c${this.next++}-${randomBytes(6).toString("hex")}`,
      by: "agent",
      kind: ask.kind,
      caption: ask.caption,
      word: ask.word,
      expires: this.now() + this.ttlMs,
    };
    const timer = setTimeout(() => this.lapse(request.id), this.ttlMs);
    timer.unref?.();
    this.pending.set(request.id, { request, key, timer });
    this.emit(request);
    return { granted: false, request, suffix };
  }

  /** Resolves when the request ends: an answer from either place, its expiry, or the server stopping. */
  wait(id: string): Promise<Settled> {
    return new Promise((resolve) => {
      if (!this.pending.has(id)) {
        resolve({ allow: false, via: "live view", expired: true });
        return;
      }
      this.waiters.set(id, [...(this.waiters.get(id) ?? []), resolve]);
    });
  }

  /** The first answer wins; later ones and unknown ids are ignored. `via` is the host's dialog or a viewer. */
  answer(id: string, allow: boolean, via: OkVia = "live view"): boolean {
    const p = this.pending.get(id);
    if (p === undefined) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (p.request.expires <= this.now()) {
      this.endings.set(p.key, "expired");
      this.emit({ type: "confirm_closed", id, allow: false });
      this.settle(id, { allow: false, via, expired: true });
      return false;
    }
    if (allow) this.grants.set(p.key, { until: this.now() + this.ttlMs, via });
    else {
      this.endings.set(p.key, "declined");
      this.declinedAt.set(p.key, this.now());
    }
    this.emit({ type: "confirm_closed", id, allow, ...(via === "chat" ? { by: "chat" as const } : {}) });
    this.settle(id, { allow, via, expired: false });
    return true;
  }

  /** Closes everything (the server stops). */
  close(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    for (const id of this.pending.keys()) this.settle(id, { allow: false, via: "live view", expired: true });
    this.pending.clear();
    this.grants.clear();
  }

  private lapse(id: string): void {
    const p = this.pending.get(id);
    if (p === undefined) return;
    this.pending.delete(id);
    this.endings.set(p.key, "expired");
    this.emit({ type: "confirm_closed", id, allow: false });
    this.settle(id, { allow: false, via: "live view", expired: true });
  }

  private settle(id: string, settled: Settled): void {
    const list = this.waiters.get(id);
    this.waiters.delete(id);
    for (const resolve of list ?? []) resolve(settled);
  }

  private emit(event: ConfirmEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a viewer's trouble must not fail the agent's call
      }
    }
  }
}
