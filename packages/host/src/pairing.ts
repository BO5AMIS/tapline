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

function normalizeScheme(scheme: string): string {
  const bare = scheme.trim().replace(/:(\/\/)?$/, "");
  if (!/^[a-z][a-z0-9+.-]*$/i.test(bare) || /^https?$/i.test(bare)) {
    throw new Error(`"${scheme}" is not the app's URL scheme (like "myapp", from "scheme" in app.json).`);
  }
  return bare;
}

export interface PairingLinkParts {
  /** The app's URL scheme, e.g. "myapp". */
  scheme: string;
  /** Where the app should connect, e.g. ws://100.64.0.1:7210/ */
  url: string;
  code: string;
  /** This computer's name, shown to the user before they connect. */
  name: string;
}

/** `<scheme>://tapline/pair?url=…&code=…&name=…`, opened on the phone by scanning its QR code. */
export function pairingLink(parts: PairingLinkParts): string {
  const scheme = normalizeScheme(parts.scheme);
  const query = [
    `url=${encodeURIComponent(parts.url)}`,
    `code=${encodeURIComponent(parts.code)}`,
    `name=${encodeURIComponent(parts.name)}`,
  ].join("&");
  return `${scheme}://tapline/pair?${query}`;
}

/** `<scheme>://tapline/forget`: the app forgets the computer it was paired with. */
export function forgetLink(scheme: string): string {
  return `${normalizeScheme(scheme)}://tapline/forget`;
}
