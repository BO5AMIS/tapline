import type { TaplineHost } from "./server.js";

/**
 * Fast-forwarded animations on the host side (PLAN-1.6 F4, AGENT-TOOLS 1.13 18.12). The app does the work (its
 * `animations` command and its three layers); the host remembers which sessions it switched on, so that it can
 * put them back for a measurement and when the session ends. State is kept per host, not per tools object, because
 * several agents' tools share one app.
 */

/** The line every answer carries while fast animations are on (the shape of the network line). */
export const ANIMATIONS_LINE = "Animations: fast (Tapline).";
/** What a call that ran with animations paused says at its end. */
export const ANIMATIONS_PAUSED_NOTE = "Note: animations were normal during this call.";

const on = new WeakMap<TaplineHost, Set<string>>();
/** Sessions whose animations a measurement has put to normal for now. */
const paused = new WeakMap<TaplineHost, Set<string>>();

function setOf(map: WeakMap<TaplineHost, Set<string>>, host: TaplineHost): Set<string> {
  const known = map.get(host);
  if (known !== undefined) return known;
  const made = new Set<string>();
  map.set(host, made);
  return made;
}

/** Whether the host switched fast animations on for this session and they are meant to be on. */
export function animationsOn(host: TaplineHost, sessionId: string): boolean {
  return setOf(on, host).has(sessionId);
}

/** Records what the app's `animations` command was last set to. */
export function noteAnimations(host: TaplineHost, sessionId: string, speed: "fast" | "normal"): void {
  const sessions = setOf(on, host);
  if (speed === "fast") sessions.add(sessionId);
  else sessions.delete(sessionId);
}

async function send(host: TaplineHost, sessionId: string, speed: "fast" | "normal"): Promise<boolean> {
  try {
    await host.request("command", { name: "animations", args: { speed } }, { sessionId });
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs `run` with animations normal when they are on for the session, and puts them back after, whatever `run` does.
 * `paused` is true when they were paused (the caller says so). A pause inside a pause only runs.
 */
export async function withNormalAnimations<T>(host: TaplineHost, sessionId: string | undefined, run: () => Promise<T>): Promise<{ value: T; paused: boolean }> {
  if (sessionId === undefined || !animationsOn(host, sessionId) || setOf(paused, host).has(sessionId)) return { value: await run(), paused: false };
  const pausedNow = setOf(paused, host);
  pausedNow.add(sessionId);
  await send(host, sessionId, "normal");
  try {
    return { value: await run(), paused: true };
  } finally {
    // A switch made during the call wins: only put fast back when it is still meant to be on.
    pausedNow.delete(sessionId);
    if (animationsOn(host, sessionId)) await send(host, sessionId, "fast");
  }
}

/** Puts one session back to normal for good (a journey in a user's eyes starts). False when they were not on. */
export async function endAnimations(host: TaplineHost, sessionId: string): Promise<boolean> {
  if (!setOf(on, host).delete(sessionId)) return false;
  await send(host, sessionId, "normal");
  return true;
}

/** The session ends: every session this host switched to fast goes back to normal. A session that is gone is skipped. */
export async function restoreAnimations(host: TaplineHost): Promise<void> {
  const sessions = setOf(on, host);
  const ids = [...sessions];
  sessions.clear();
  await Promise.all(ids.map((id) => send(host, id, "normal")));
}

/** Forgets a session that ended (the app restores itself on a disconnect). */
export function forgetAnimations(host: TaplineHost, sessionId: string): void {
  setOf(on, host).delete(sessionId);
  setOf(paused, host).delete(sessionId);
}
