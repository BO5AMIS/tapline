// @ts-check
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

/** @typedef {(req: import('http').IncomingMessage, res: import('http').ServerResponse, next: () => void) => void} Middleware */

/** Private LAN, link-local, loopback: the development offer stays on the Wi-Fi (never Tailscale or the internet). */
/** @param {string | undefined} address */
function isLocalNetwork(address) {
  if (typeof address !== 'string') return false;
  const a = address.toLowerCase().replace(/^::ffff:/, '');
  if (a === '127.0.0.1' || a === '::1') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(a);
  if (v4) {
    const x = Number(v4[1]);
    const y = Number(v4[2]);
    return x === 10 || (x === 192 && y === 168) || (x === 172 && y >= 16 && y <= 31) || (x === 169 && y === 254);
  }
  // unique-local IPv6, but not Tailscale's own range (fd7a:115c:a1e0::/48)
  return (/^f[cd][0-9a-f]{2}:/.test(a) && !a.startsWith('fd7a:115c:a1e0:')) || a.startsWith('fe80:');
}

/**
 * Claims the offer in `file` for `peer` (the first device to fetch it): false when another device has it.
 * @param {string} file @param {string} peer
 */
function claimOffer(file, peer) {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof o.claimedBy === 'string') return o.claimedBy === peer;
    o.claimedBy = peer;
    fs.writeFileSync(file, JSON.stringify(o), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * The newest open development offer a Tapline host on this computer wrote after `pair` (Tapline 1.1, zero-QR
 * pairing), or null. Files live in ~/.tapline/offers (or $TAPLINE_HOME/offers), one per host port.
 * @param {string} dir
 * @returns {{ code: string, name: string, port: number, file: string, claimedBy: string | undefined } | null}
 */
function readOffer(dir) {
  let best = null;
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      const file = path.join(dir, name);
      const o = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof o.code !== 'string' || typeof o.name !== 'string' || typeof o.port !== 'number' || typeof o.until !== 'number') continue;
      if (o.until <= Date.now()) continue;
      if (best === null || o.until > best.until) best = { ...o, file };
    } catch {
      // a file being written, or not ours
    }
  }
  return best === null ? null : { code: best.code, name: best.name, port: best.port, file: best.file, claimedBy: typeof best.claimedBy === 'string' ? best.claimedBy : undefined };
}

/**
 * Answers `GET /tapline/offer` on Metro, which the phone always reaches in development.
 * @param {string} dir
 * @returns {Middleware}
 */
function offerMiddleware(dir) {
  return (req, res, next) => {
    if (!req.url || !req.url.startsWith('/tapline/offer')) return next();
    /** @param {number} status @param {Record<string, unknown>} body */
    const answer = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    // Through a proxy (Tailscale Serve, a tunnel) the peer isn't on the Wi-Fi, whatever the socket says.
    const forwarded = req.headers['x-forwarded-for'] !== undefined || req.headers['tailscale-user-login'] !== undefined;
    // A web page could make this request (it sends an Origin, or reaches us under its own name: DNS rebinding).
    const host = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
    const byAddress = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || (host.startsWith('[') && host.endsWith(']')) || host === 'localhost' || host.endsWith('.local');
    const fromPage = req.headers.origin !== undefined || !byAddress;
    const address = req.socket && req.socket.remoteAddress;
    if (forwarded || fromPage || !isLocalNetwork(address)) return answer(403, { error: 'local network only' });
    const offer = readOffer(dir);
    const peer = (address ?? '').toLowerCase().replace(/^::ffff:/, '');
    // The first device to fetch it claims it, and only that device can pair with it.
    if (offer === null || !claimOffer(offer.file, peer)) return answer(404, { error: 'no offer open: call pair on the computer' });
    return answer(200, { code: offer.code, name: offer.name, port: offer.port });
  };
}

/**
 * Metro config helper: runs Tapline's `register` before the app's main module, so the app
 * doesn't need its own entry file just to import it first. Only when Tapline is on
 * (EXPO_PUBLIC_TAPLINE_ENABLED=1 by default), so store builds stay untouched.
 *
 *   // metro.config.js
 *   const { getDefaultConfig } = require('expo/metro-config');
 *   const { withTapline } = require('react-native-tapline/metro');
 *   module.exports = withTapline(getDefaultConfig(__dirname));
 *
 * The app still calls startTapline() (for example at the top of app/_layout.tsx).
 *
 * @template {{ serializer?: { getModulesRunBeforeMainModule?: (entryFilePath: string) => string[] } & Record<string, unknown> } & Record<string, unknown>} C
 * @param {C} config
 * @param {{ enabled?: boolean }} [options]
 * @returns {C}
 */
function withTapline(config, options = {}) {
  const enabled = options.enabled ?? process.env.EXPO_PUBLIC_TAPLINE_ENABLED === '1';
  if (!enabled) return config;
  // The same file the package's own index imports, so Metro has it in the bundle.
  const register = path.join(__dirname, 'dist', 'register.js');
  const serializer = config.serializer ?? {};
  const previous = serializer.getModulesRunBeforeMainModule;
  const server = /** @type {{ enhanceMiddleware?: (m: Middleware, s: unknown) => Middleware } & Record<string, unknown>} */ (config.server ?? {});
  const enhance = server.enhanceMiddleware;
  const home = process.env.TAPLINE_HOME && process.env.TAPLINE_HOME.length > 0 ? process.env.TAPLINE_HOME : path.join(os.homedir(), '.tapline');
  const offers = offerMiddleware(path.join(home, 'offers'));
  return {
    ...config,
    serializer: {
      ...serializer,
      /** @param {string} entryFilePath */
      getModulesRunBeforeMainModule: (entryFilePath) => [...(previous ? previous(entryFilePath) : []), register],
    },
    server: {
      ...server,
      // Zero-QR pairing: the phone asks Metro for the offer a Tapline host on this computer opened.
      /** @param {Middleware} middleware @param {unknown} metroServer @returns {Middleware} */
      enhanceMiddleware: (middleware, metroServer) => {
        const inner = enhance ? enhance(middleware, metroServer) : middleware;
        return (req, res, next) => offers(req, res, () => inner(req, res, next));
      },
    },
  };
}

module.exports = { withTapline, readOffer, offerMiddleware, isLocalNetwork };
