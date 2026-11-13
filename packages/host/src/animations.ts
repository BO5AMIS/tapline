import type { TaplineHost } from "./server.js";

/**
 * Fast-forwarded animations on the host side (PLAN-1.6 F4, AGENT-TOOLS 1.13 18.12). The app does the work (its
 * `animations` command and its three layers); the host remembers which sessions it switched on, so that it can
 * put them back for a measurement and when the session ends. State is kept per host, not per tools object, because
 * several agents' tools share one app.
 */

/** The line every answer carries while fast animations are on (the shape of the network line). */
export const ANIMATIONS_LINE = "Animations: fast (Tapline).";
/** What a call says when it could not be run with animations normal. */
export const ANIMATIONS_NOT_PAUSED_NOTE = "Note: animations could not be set to normal for this call; it ran with fast animations.";
/** What a call that ran with animations paused says at its end. */
export const ANIMATIONS_PAUSED_NOTE = "Note: animations were normal during this call.";

const on = new WeakMap<TaplineHost, Set<string>>();
/** The pauses running now per session: how many, and whether the switch to normal was accepted. */
interface Pause {
  count: number;
  ready: Promise<boolean>;
}
const pauses = new WeakMap<TaplineHost, Map<string, Pause>>();

function pausesOf(host: TaplineHost): Map<string, Pause> {
  const known = pauses.get(host);
  if (known !== undefined) return known;
  const made = new Map<string, Pause>();
  pauses.set(host, made);
  return made;
}

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
 * `paused` is true when they were on and are normal for this call; `failed` when the switch to normal did not go through
 * (the call then ran fast, and says so). Pauses overlapping in one session are counted: normal is sent by the first and
 * fast comes back when the last one ends.
 */
export async function withNormalAnimations<T>(
  host: TaplineHost,
  sessionId: string | undefined,
  run: () => Promise<T>,
): Promise<{ value: T; paused: boolean; failed: boolean }> {
  if (sessionId === undefined || !animationsOn(host, sessionId)) return { value: await run(), paused: false, failed: false };
  const all = pausesOf(host);
  let pause = all.get(sessionId);
  if (pause === undefined) {
    pause = { count: 0, ready: send(host, sessionId, "normal") };
    all.set(sessionId, pause);
  }
  pause.count += 1;
  const mine = pause;
  const accepted = await mine.ready;
  try {
    return { value: await run(), paused: accepted, failed: !accepted };
  } finally {
    mine.count -= 1;
    if (mine.count === 0) {
      if (all.get(sessionId) === mine) all.delete(sessionId);
      // A switch made during the call wins: only put fast back when it is still meant to be on.
      if (animationsOn(host, sessionId)) await send(host, sessionId, "fast");
    }
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
  pausesOf(host).delete(sessionId);
}
