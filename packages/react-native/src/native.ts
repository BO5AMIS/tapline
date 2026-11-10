import { isRecord } from './types';

/**
 * Tapline's optional native module (`ios/TaplineNativeModule.swift`, an Expo module). An app built
 * with it gets frames that don't make iOS render a new one (a smoother live viewer at less cost)
 * and sees what UIKit draws over the app (alerts, the share sheet). Without it, the SDK works as
 * before: screenshots through react-native-view-shot, and only the alerts it tracks in JavaScript.
 */
export interface TaplineNativeModule {
  /** Base64 JPEG of the key window, `pixelWidth` pixels wide; "" when there is no window. */
  capture(pixelWidth: number, quality: number, fresh: boolean): Promise<string>;
  /** What UIKit presents over the app. */
  cover(): Promise<unknown>;
}

/** What UIKit shows in front of the app, as the native module reports it. */
export interface NativeCover {
  kind: 'alert' | 'actionSheet' | 'share';
  title: string;
  message: string;
  buttons: Array<{ text: string; destructive: boolean }>;
}

let override: TaplineNativeModule | null | undefined;
let lastCover: NativeCover | null = null;

/** The native module when the app was built with it, else null. */
export function nativeModule(): TaplineNativeModule | null {
  if (override !== undefined) return override;
  const modules = (globalThis as { expo?: { modules?: Record<string, unknown> } }).expo?.modules;
  const candidate = modules?.TaplineNative;
  return isRecord(candidate) && typeof candidate.capture === 'function' && typeof candidate.cover === 'function'
    ? (candidate as unknown as TaplineNativeModule)
    : null;
}

/** Replace the native module (tests); null means "not built in", undefined restores the lookup. */
export function setNativeModule(next: TaplineNativeModule | null | undefined): void {
  override = next;
  lastCover = null;
}

function parseCover(raw: unknown): NativeCover | null {
  if (!isRecord(raw)) return null;
  const kind = raw.kind;
  if (kind !== 'alert' && kind !== 'actionSheet' && kind !== 'share') return null;
  const texts = Array.isArray(raw.buttons) ? raw.buttons : [];
  const destructive = Array.isArray(raw.destructive) ? raw.destructive : [];
  return {
    kind,
    title: typeof raw.title === 'string' ? raw.title : '',
    message: typeof raw.message === 'string' ? raw.message : '',
    buttons: texts.map((text, i) => ({ text: typeof text === 'string' ? text : '', destructive: destructive[i] === true })),
  };
}

/**
 * Asks the native module what covers the app now and remembers it for `currentCover`. Called
 * before each request the host sends, so every answer and every check of that request sees it.
 * Without the module, or when it fails, nothing covers the app as far as Tapline knows.
 */
export async function refreshCover(): Promise<NativeCover | null> {
  const module = nativeModule();
  if (module === null) {
    lastCover = null;
    return null;
  }
  try {
    lastCover = parseCover(await module.cover());
  } catch {
    lastCover = null;
  }
  return lastCover;
}

/** What covered the app at the last `refreshCover`. */
export function currentCover(): NativeCover | null {
  return lastCover;
}
