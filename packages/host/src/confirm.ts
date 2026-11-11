import { randomBytes } from "node:crypto";

/**
 * AGENT-TOOLS 1.8 §11.3 / VIEWER-PROTOCOL 1.5: a person's OK for a touch the policy guards. The live view
 * is the only place a request is answered; an allow lets exactly one matching call through within 120 s.
 */

export const CONFIRM_TTL_MS = 120_000;

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
export interface ConfirmClosed {
  type: "confirm_closed";
  id: string;
  allow: boolean;
}
export type ConfirmEvent = ConfirmRequest | ConfirmClosed;

/** What a guarded call may do now. */
export type ConfirmCheck =
  | { granted: true }
  | { granted: false; request: ConfirmRequest; /** " They declined." or " Nobody answered." after a first ask. */ suffix: string };

interface Pending {
  request: ConfirmRequest;
  key: string;
  timer: ReturnType<typeof setTimeout>;
}

export class Confirmations {
  private readonly pending = new Map<string, Pending>();
  /** key → when the allow lapses */
  private readonly grants = new Map<string, number>();
  /** key → how the last ask ended without an allow */
  private readonly endings = new Map<string, "declined" | "expired">();
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
      if (grant > this.now()) return { granted: true };
    }
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

  /** A viewer's answer. The first answer wins; later ones and unknown ids are ignored. */
  answer(id: string, allow: boolean): boolean {
    const p = this.pending.get(id);
    if (p === undefined) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (p.request.expires <= this.now()) {
      this.endings.set(p.key, "expired");
      this.emit({ type: "confirm_closed", id, allow: false });
      return false;
    }
    if (allow) this.grants.set(p.key, this.now() + this.ttlMs);
    else this.endings.set(p.key, "declined");
    this.emit({ type: "confirm_closed", id, allow });
    return true;
  }

  /** Closes everything (the server stops). */
  close(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    this.grants.clear();
  }

  private lapse(id: string): void {
    const p = this.pending.get(id);
    if (p === undefined) return;
    this.pending.delete(id);
    this.endings.set(p.key, "expired");
    this.emit({ type: "confirm_closed", id, allow: false });
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
