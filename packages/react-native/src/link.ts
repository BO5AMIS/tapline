/**
 * Pairing links, made by the computer (`pair` tool or `tapline pair`):
 *   <scheme>://tapline/pair?url=<ws://…>&code=<one-time code>&name=<computer name>
 *   <scheme>://tapline/forget
 * For an app running in Expo Go the same links come in Expo Go's form:
 *   exp://<host>:<port>/--/tapline/pair?…   exp://<host>:<port>/--/tapline/forget
 */
export type TaplineLink = { kind: 'pair'; url: string; code: string; name: string } | { kind: 'forget' };

const LINK = /^(?:([a-z][a-z0-9+.-]*):\/\/|(exps?):\/\/[^\s/?#]+\/--\/)tapline\/(pair|forget)\/?(?:\?([^#]*))?(?:#.*)?$/i;

/**
 * True for a Tapline pairing or forget link, with or without the scheme (and in Expo Go's
 * `/--/` form). For Expo Router's `redirectSystemPath`, so the router leaves these links to Tapline.
 */
export function isTaplineLink(url: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:\/\/|exps?:\/\/[^\s/?#]+\/--\/|\/?--\/|\/)?tapline\/(?:pair|forget)(?:[/?#]|$)/i.test(url.trim());
}

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

function parseQuery(query: string): Map<string, string> {
  const params = new Map<string, string>();
  for (const part of query.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const key = decode(eq < 0 ? part : part.slice(0, eq));
    const value = decode(eq < 0 ? '' : part.slice(eq + 1));
    if (key !== null && value !== null && !params.has(key)) params.set(key, value);
  }
  return params;
}

/** Control characters and line breaks become spaces, so a name can't fake extra lines in the prompt. */
function cleanName(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const c = ch.charCodeAt(0);
    out += c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 ? ' ' : ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, 80);
}

export function parseTaplineLink(raw: string): TaplineLink | null {
  const match = LINK.exec(raw.trim());
  if (match === null) return null;
  const [, appScheme, goScheme, kind = '', query = ''] = match;
  const scheme = appScheme ?? goScheme ?? '';
  if (/^https?$/i.test(scheme)) return null;
  if (kind.toLowerCase() === 'forget') return { kind: 'forget' };
  const params = parseQuery(query);
  const url = params.get('url') ?? '';
  const code = params.get('code') ?? '';
  const authority = /^wss?:\/\/([^\s/?#]+)/i.exec(url)?.[1];
  // User info ("ws://100.64.0.1:7210@elsewhere") would hide the real host in the prompt.
  if (authority === undefined || authority.includes('@') || code === '') return null;
  const name = cleanName(params.get('name') ?? '');
  return { kind: 'pair', url, code, name: name === '' ? 'a computer' : name };
}
