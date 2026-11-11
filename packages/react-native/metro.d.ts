import type { IncomingMessage, ServerResponse } from 'http';

export type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

export interface TaplineMetroConfig {
  serializer?: { getModulesRunBeforeMainModule?: (entryFilePath: string) => string[] } & Record<string, unknown>;
  server?: { enhanceMiddleware?: (middleware: Middleware, server: unknown) => Middleware } & Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Runs Tapline's `register` before the app's main module (only when Tapline is on:
 * EXPO_PUBLIC_TAPLINE_ENABLED=1, or `enabled`), so no custom entry file is needed. It also answers
 * `GET /tapline/offer` on Metro, so a development build finds the pairing offer a Tapline host on this
 * computer opened (zero-QR pairing).
 */
export function withTapline<C extends TaplineMetroConfig>(config: C, options?: { enabled?: boolean }): C;

/** The newest open offer in `dir` (`~/.tapline/offers`), or null. */
export function readOffer(dir: string): { code: string; name: string; port: number; file: string; claimedBy: string | undefined } | null;

/** The `/tapline/offer` middleware, reading offers from `dir`. */
export function offerMiddleware(dir: string): Middleware;

/** Private LAN, link-local or loopback. */
export function isLocalNetwork(address: string | undefined): boolean;
