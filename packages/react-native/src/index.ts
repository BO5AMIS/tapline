import { Alert, Linking } from 'react-native';
import { TaplineAgent } from './agent';
import { installLogs, originalLog, uninstallLogs } from './logs';
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
}

let agent: TaplineAgent | null = null;

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function confirmWithAlert(title: string, message: string, ok: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
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
  Alert.alert(title, message);
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
    installLogs();
    const next = new TaplineAgent(
      { app: options.app, ...(url !== '' && token !== '' ? { direct: { url, token } } : {}) },
      { storage, linking: Linking, confirm: confirmWithAlert, notify: notifyWithAlert },
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
    if (current) uninstallLogs();
  } catch {
    // ignore
  }
}

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
