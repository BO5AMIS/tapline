import { createHmac, timingSafeEqual } from "node:crypto";

/** How long a pairing code stays valid. */
export const PAIR_CODE_TTL_MS = 10 * 60 * 1000;

const MAC_LENGTH = 20;

function mac(token: string, expiry: string): string {
  return createHmac("sha256", token).update(`tapline-pair:${expiry}`).digest("hex").slice(0, MAC_LENGTH);
}

/**
 * A short-lived pairing code: `<expiry in base 36>-<20 hex chars of HMAC(token, expiry)>`.
 * Any host holding the same token can check it, so `tapline pair` works without talking to
 * the running host. The host also refuses a code it has already accepted once.
 */
export function createPairCode(token: string, now: number = Date.now()): string {
  const expiry = (now + PAIR_CODE_TTL_MS).toString(36);
  return `${expiry}-${mac(token, expiry)}`;
}

export function verifyPairCode(token: string, code: string, now: number = Date.now()): boolean {
  const match = /^([0-9a-z]{1,12})-([0-9a-f]+)$/.exec(code);
  if (match === null) return false;
  const [, expiry = "", given = ""] = match;
  const expiresAt = parseInt(expiry, 36);
  if (!Number.isFinite(expiresAt) || now > expiresAt || expiresAt - now > PAIR_CODE_TTL_MS) return false;
  const expected = Buffer.from(mac(token, expiry), "utf8");
  const actual = Buffer.from(given, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** The code's expiry time (epoch ms), or null when it is not a code. */
export function pairCodeExpiry(code: string): number | null {
  const match = /^([0-9a-z]{1,12})-/.exec(code);
  if (match === null) return null;
  const expiresAt = parseInt(match[1] ?? "", 36);
  return Number.isFinite(expiresAt) ? expiresAt : null;
}

/** Expo Go's address for a project, as Expo prints it: exp://<host>:<port>, optionally with /-- after it. */
const EXPO_GO = /^(exps?:\/\/[^\s/?#@]+)\/?(?:--\/?)?$/i;

/**
 * What a Tapline link starts with: `<scheme>://` for an app with its own scheme, or Expo Go's
 * `exp://<host>:<port>/--/` for an app running in Expo Go (`scheme` is then the address Expo prints).
 */
function linkBase(scheme: string): string {
  const trimmed = scheme.trim();
  const go = EXPO_GO.exec(trimmed);
  if (go !== null) return `${go[1]}/--/`;
  const bare = trimmed.replace(/:(\/\/)?$/, "");
  if (/^exps?$/i.test(bare)) {
    throw new Error(`"${scheme}": for an app in Expo Go, give the scheme as the address Expo prints, exp://<host>:<port>.`);
  }
  if (!/^[a-z][a-z0-9+.-]*$/i.test(bare) || /^https?$/i.test(bare)) {
    throw new Error(
      `"${scheme}" is not the app's URL scheme (like "myapp", from "scheme" in app.json, or Expo Go's exp://<host>:<port>).`,
    );
  }
  return `${bare}://`;
}

export interface PairingLinkParts {
  /** The app's URL scheme, e.g. "myapp", or for an app in Expo Go the address Expo prints (exp://<host>:<port>). */
  scheme: string;
  /** Where the app should connect, e.g. ws://100.64.0.1:7210/ */
  url: string;
  code: string;
  /** This computer's name, shown to the user before they connect. */
  name: string;
}

/** `<scheme>://tapline/pair?url=…&code=…&name=…`, opened on the phone by scanning its QR code. */
export function pairingLink(parts: PairingLinkParts): string {
  const base = linkBase(parts.scheme);
  const query = [
    `url=${encodeURIComponent(parts.url)}`,
    `code=${encodeURIComponent(parts.code)}`,
    `name=${encodeURIComponent(parts.name)}`,
  ].join("&");
  return `${base}tapline/pair?${query}`;
}

/** `<scheme>://tapline/forget`: the app forgets the computer it was paired with. */
export function forgetLink(scheme: string): string {
  return `${linkBase(scheme)}tapline/forget`;
}
