import { AppState, Linking, NativeModules } from 'react-native';
import { TaplineAgent, type DevOffer, type OfferSource } from './agent';
import { installAlertTracking, nativeAlert, uninstallAlertTracking } from './alerts';
import { configureCrash } from './crash';
import { addLog, installLogs, originalLog, uninstallLogs } from './logs';
import { configureKnowIdle } from './idle';
import { inFlight, installNetworkTracking, onNetworkFailure, uninstallNetworkTracking } from './network';
import { setNetworkIdleProvider } from './wait';
import { memoryStorage, secureStoreStorage, type TaplineStorage } from './storage';
import type { AppInfo } from './types';

export interface TaplineOptions {
  /**
   * The on switch: Tapline does nothing at all unless this is true. Turn it on in development
   * and test builds only, e.g. `enabled: process.env.EXPO_PUBLIC_TAPLINE_ENABLED === '1'`.
   * The build carries no address or token: a phone connects by scanning a pairing code.
   */
  enabled: boolean;
  app?: AppInfo;
  /**
   * Where the paired computer is remembered. Default: expo-secure-store when the app has it,
   * else memory (pair again after each restart).
   */
  storage?: TaplineStorage;
  /** Connect straight to this host instead of pairing (e.g. a simulator on the same computer). Needs `token`. */
  url?: string;
  /** The host's token, for `url` (`tapline token`). Keep it out of source files. */
  token?: string;
  /**
   * Alerts (Alert.alert / Alert.prompt): 'record' (default) shows them as usual and tells the
   * agent what is open; 'stand-in' shows Tapline's own in-app version instead, whose buttons an
   * agent can press. Tapline's own prompts always stay native.
   */
  alerts?: 'record' | 'stand-in';
  /**
   * Know, don't watch (1.6, off by default): an action answers as soon as the animations, interactions and
   * requests Tapline can see are idle, a frame or two later, instead of after 100 ms without a commit.
   * What it can't see (Reanimated, a sheet, native work) keeps the 100 ms window.
   */
  knowIdle?: boolean;
}

let agent: TaplineAgent | null = null;
let stopNetworkLog: (() => void) | null = null;

/** Failed requests go into the app's logs, so `logs` explains a broken screen. */
/** Zero-QR pairing's polls are Tapline's own: they never count as the app's requests. */
const OFFER_PATH = '/tapline/offer';

/** Development builds only: offers from the computer Metro serves this app's code from. */
function devOffers(): OfferSource | undefined {
  if (typeof __DEV__ === 'undefined' || !__DEV__) return undefined;
  return {
    devServer() {
      try {
        const source = NativeModules.SourceCode as { getConstants?: () => { scriptURL?: unknown }; scriptURL?: unknown } | undefined;
        const url = source?.getConstants?.().scriptURL ?? source?.scriptURL;
        if (typeof url !== 'string') return null;
        const m = /^(https?):\/\/(\[[^\]]+\]|[^/:?#]+)(?::(\d+))?/i.exec(url);
        if (!m || m[2] === undefined) return null;
        const port = m[3] !== undefined ? Number(m[3]) : m[1]?.toLowerCase() === 'https' ? 443 : 80;
        return { host: m[2], port };
      } catch {
        return null;
      }
    },
    async fetchOffer(host, port, timeoutMs): Promise<DevOffer | null> {
      const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
      const timer = setTimeout(() => controller?.abort(), timeoutMs);
      try {
        const res = await fetch(`http://${host}:${port}${OFFER_PATH}`, controller ? { signal: controller.signal } : {});
        if (res.status !== 200) return null;
        const body: unknown = await res.json();
        if (typeof body !== 'object' || body === null) return null;
        const { code, name, port: hostPort } = body as { code?: unknown; name?: unknown; port?: unknown };
        if (typeof code !== 'string' || typeof name !== 'string') return null;
        return typeof hostPort === 'number' ? { code, name, port: hostPort } : { code, name };
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
    active: () => AppState.currentState === 'active',
  };
}

function watchNetwork(): void {
  installNetworkTracking({ ignore: (url) => url.includes(OFFER_PATH) });
  setNetworkIdleProvider(() => inFlight() === 0);
  stopNetworkLog?.();
  stopNetworkLog = onNetworkFailure((failure) => {
    const outcome = failure.status ?? failure.error ?? 'failed';
    const level = failure.status !== null && failure.status < 500 ? 'warn' : 'error';
    addLog(level, `[network] ${failure.method} ${failure.url} → ${outcome}`);
  });
}

function unwatchNetwork(): void {
  stopNetworkLog?.();
  stopNetworkLog = null;
  setNetworkIdleProvider(null);
  uninstallNetworkTracking();
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function confirmWithAlert(title: string, message: string, ok: string): Promise<boolean> {
  return new Promise((resolve) => {
    nativeAlert(
      title,
      message,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: ok, onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

function notifyWithAlert(title: string, message: string): void {
  nativeAlert(title, message);
}

/**
 * Start the in-app agent: it reconnects to the computer this app was paired with, and pairs
 * when a Tapline pairing link opens the app. Safe to call more than once; never throws.
 */
export function startTapline(options: TaplineOptions): void {
  if (options?.enabled !== true) return;
  try {
    stopTapline();
    const url = trimmed(options.url);
    const token = trimmed(options.token);
    if ((url === '') !== (token === '')) {
      originalLog(`[tapline] url and token go together; ignoring the ${url ? 'url' : 'token'} and waiting for a pairing link`);
    }
    let storage = options.storage ?? secureStoreStorage();
    if (storage === null) {
      originalLog('[tapline] expo-secure-store is not installed, so a pairing lasts until the app restarts (or pass `storage`)');
      storage = memoryStorage();
    }
    configureCrash(storage);
    installLogs();
    installAlertTracking({ standIn: options.alerts === 'stand-in' });
    watchNetwork();
    configureKnowIdle(options.knowIdle === true);
    const next = new TaplineAgent(
      { app: options.app, ...(url !== '' && token !== '' ? { direct: { url, token } } : {}) },
      { storage, linking: Linking, confirm: confirmWithAlert, notify: notifyWithAlert, offers: devOffers() },
    );
    agent = next;
    void next.start();
  } catch {
    // never throw into the app
  }
}

export function stopTapline(): void {
  const current = agent;
  agent = null;
  try {
    current?.stop();
    if (current) {
      uninstallLogs();
      configureCrash(null);
      uninstallAlertTracking();
      unwatchNetwork();
      configureKnowIdle(false);
    }
  } catch {
    // ignore
  }
}

export { registerTaplineCommand, registerLanguageCommand, registerRegionCommand } from './commands';
export { useTaplineFontScale, getTaplineFontScale, subscribeTaplineFontScale, TEXT_SIZES } from './locale';
export type { TextSize } from './locale';
export type { TaplineCommand } from './commands';
export { TaplineFromOthers } from './fromothers';
export { isTaplineLink, parseTaplineLink } from './link';
export type { TaplineLink } from './link';
export { memoryStorage, secureStoreStorage } from './storage';
export type { TaplineStorage } from './storage';
export { TaplineAgent } from './agent';
export type { AgentDeps, AgentOptions, LinkingLike, Pairing } from './agent';
export { TaplineClient, collectDeviceInfo, defaultCapabilities, backoffDelay } from './client';
export type { ClientOptions, ClientDeps, WebSocketLike } from './client';
export { methods } from './methods';
export {
  press,
  longPress,
  typeText,
  scroll,
  toggle,
  openURL,
  getLogs,
  reload,
  screenshot,
  resolveTarget,
  configureActions,
} from './actions';
export { tree, setMeasurer, defaultMeasurer } from './inspect';
export type { Measurer } from './inspect';
export { getRoots } from './register';
export { getLogEntries, installLogs, uninstallLogs } from './logs';
export { registerTaplinePickerHook } from './media';
export type { TaplinePickerHook, TaplinePickerPicture } from './media';
export { TaplineError, PROTOCOL_VERSION } from './types';
export type {
  Action,
  AppInfo,
  DeviceInfo,
  ErrorCode,
  Frame,
  LogEntry,
  ScreenInfo,
  Target,
  TaplineElement,
  TreeResult,
} from './types';
