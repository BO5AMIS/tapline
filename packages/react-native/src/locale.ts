import { useEffect, useState } from 'react';
import { PixelRatio } from 'react-native';
import { TaplineError } from './types';

/**
 * Language, region and text size as `app_command` names (AGENT-TOOLS 16.3). The names and their
 * values are shared with Tapwright, so an agent gets the same `bad_params` wherever the app registers them.
 */

/** Text sizes and the font scale each means (the number React Native reports as `fontScale`). */
export const TEXT_SIZE_SCALES = {
  xs: 0.82,
  s: 0.88,
  m: 0.94,
  l: 1.0,
  xl: 1.12,
  xxl: 1.24,
  xxxl: 1.35,
  ax1: 1.65,
  ax2: 1.94,
  ax3: 2.35,
  ax4: 2.76,
  ax5: 3.12,
} as const;

export type TextSize = keyof typeof TEXT_SIZE_SCALES;

export const TEXT_SIZES = Object.keys(TEXT_SIZE_SCALES) as TextSize[];

export function isTextSize(value: unknown): value is TextSize {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TEXT_SIZE_SCALES, value);
}

/** Names the SDK provides itself that an app cannot replace (`appearance` can be replaced, as in 1.3). */
export const RESERVED_COMMANDS: readonly string[] = ['network', 'text_size'];

// --- validation ---------------------------------------------------------------------------------------------

const LANGUAGE = /^[A-Za-z]{2,3}$/;
const SUBTAG = /^[A-Za-z0-9]{2,8}$/;
const PRIVATE_SUBTAG = /^[A-Za-z0-9]{1,8}$/;
const SINGLETON = /^[A-Za-z0-9]$/;
const MAX_LANGUAGE_TAG = 128;

/**
 * BCP 47, read subtag by subtag (linear: a regex with nested repeats can take seconds on a long bad tag): a language
 * of 2-3 letters, then subtags of 2-8. A singleton starts an extension (`u-ca-gregory`), which needs one or more
 * subtags of 2-8; `x` starts the private-use part (`x-a`), which needs one or more of 1-8 and runs to the end.
 */
function isLanguageTag(value: string): boolean {
  if (value.length > MAX_LANGUAGE_TAG) return false;
  const parts = value.split('-');
  if (!LANGUAGE.test(parts[0] ?? '')) return false;
  let i = 1;
  while (i < parts.length) {
    const part = parts[i] as string;
    if (!SINGLETON.test(part)) {
      if (!SUBTAG.test(part)) return false;
      i++;
      continue;
    }
    const privateUse = part.toLowerCase() === 'x';
    const fits = privateUse ? PRIVATE_SUBTAG : SUBTAG;
    let n = 0;
    i++;
    while (i < parts.length && (privateUse || !SINGLETON.test(parts[i] as string))) {
      if (!fits.test(parts[i] as string)) return false;
      n++;
      i++;
    }
    if (n === 0) return false;
  }
  return true;
}
const REGION_CODE = /^[A-Za-z]{2}$/;

function badParams(message: string): TaplineError {
  return new TaplineError('bad_params', message);
}

/** A BCP 47 code such as `ar` or `en-GB`. */
export function parseLanguage(args: Record<string, unknown>): string {
  const value = args.language;
  if (typeof value !== 'string' || !isLanguageTag(value)) {
    throw badParams('language must be a BCP 47 code such as "ar" or "en-GB"');
  }
  return value;
}

/** An ISO 3166 alpha-2 country code such as `QA` (returned in upper case). */
export function parseRegion(args: Record<string, unknown>): string {
  const value = args.region;
  if (typeof value !== 'string' || !REGION_CODE.test(value)) {
    throw badParams('region must be an ISO 3166 country code such as "QA"');
  }
  return value.toUpperCase();
}

/** `system` clears the override and goes back to the phone's own text size. */
export const SYSTEM_TEXT_SIZE = 'system';

export function parseTextSize(args: Record<string, unknown>): TextSize | typeof SYSTEM_TEXT_SIZE {
  const value = args.size;
  if (value === SYSTEM_TEXT_SIZE) return value;
  if (!isTextSize(value)) {
    throw badParams(`size must be one of ${TEXT_SIZES.join(', ')}, or "system" for the phone's own`);
  }
  return value;
}

// --- right-to-left ------------------------------------------------------------------------------------------

const RTL_LANGUAGES: ReadonlySet<string> = new Set(['ar', 'he', 'fa', 'ur']);

/** True for a language written right to left (ar, he, fa, ur). */
export function isRtlLanguage(language: string): boolean {
  const primary = language.split('-')[0]?.toLowerCase() ?? '';
  return RTL_LANGUAGES.has(primary);
}

// --- font scale override ------------------------------------------------------------------------------------

let override: number | null = null;
let getterUsed = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // one failing subscriber must not stop the others, or the session reset
    }
  }
}

function currentScale(): number {
  return override ?? PixelRatio.getFontScale();
}

/**
 * The font scale to use: the one an agent set with `text_size`, else the system's. Calling it counts as using the helper.
 * It already holds the system's scale, so text sized with it sets `allowFontScaling={false}` (else the system scale
 * applies twice).
 */
export function getTaplineFontScale(): number {
  getterUsed = true;
  return currentScale();
}

/** Calls `listener` when the override changes; returns the function that stops it. A live subscriber counts as using the helper. */
export function subscribeTaplineFontScale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The font scale the app should apply to its text: the size an agent set with the `text_size`
 * command, else the system's. React Native reads the system scale natively, so Tapline cannot
 * change it; an app that multiplies its font sizes by this value opts in to `text_size`. The value already
 * holds the system's scale: that text sets `allowFontScaling={false}`, so the system scale applies once.
 *
 *     const scale = useTaplineFontScale();
 *     <Text allowFontScaling={false} style={{ fontSize: 16 * scale }}>…</Text>
 */
export function useTaplineFontScale(): number {
  const [scale, setScale] = useState(currentScale);
  useEffect(() => {
    const update = (): void => setScale(currentScale());
    const stop = subscribeTaplineFontScale(update);
    update();
    return stop;
  }, []);
  return scale;
}

/** True while a hook or subscriber is live (a mounted `useTaplineFontScale`), or the app has called the getter this session. */
export function fontScaleHelperUsed(): boolean {
  return listeners.size > 0 || getterUsed;
}

export function setTaplineFontScale(scale: number | null): void {
  override = scale;
  emit();
}

/** The session ended (host gone, Tapline stopped): the phone's own text size again, and the getter no longer counts as used. */
export function resetTaplineTextSize(): void {
  const changed = override !== null;
  override = null;
  getterUsed = false;
  if (changed) emit();
}

/** Forgets the override and that the helper was used (tests). */
export function resetFontScale(): void {
  override = null;
  getterUsed = false;
  listeners.clear();
}

/** `1.0×`, `1.3×`: the phone's own scale as the answer writes it (always one decimal at least). */
function formatSystemScale(scale: number): string {
  const text = String(Number(scale.toFixed(2)));
  return `${text.includes('.') ? text : `${text}.0`}×`;
}

/** `1.12×`, `1×`: the scale as the answer writes it. */
export function formatScale(scale: number): string {
  return `${Number(scale.toFixed(2))}×`;
}

export const TEXT_SIZE_UNSUPPORTED =
  "This app doesn't use Tapline's font-scale helper (useTaplineFontScale), and React Native reads the system text size natively. To check large text, use audit's dynamic_type check or Tapwright's open_app { text_size }.";

/** The built-in `text_size` run: validates, then sets the override. */
export function runTextSize(args: Record<string, unknown>): { size: TextSize | typeof SYSTEM_TEXT_SIZE; scale: number; say: string } {
  const size = parseTextSize(args);
  // "system" always clears an override, also once the screens that used the helper are gone
  if (size !== SYSTEM_TEXT_SIZE && !fontScaleHelperUsed()) throw new TaplineError('unsupported', TEXT_SIZE_UNSUPPORTED);
  if (size === SYSTEM_TEXT_SIZE) {
    setTaplineFontScale(null);
    const scale = PixelRatio.getFontScale();
    return { size, scale, say: `Text size: the phone's own (${formatSystemScale(scale)}).` };
  }
  const scale = TEXT_SIZE_SCALES[size];
  setTaplineFontScale(scale);
  return { size, scale, say: `Text size ${size} (${formatScale(scale)}).` };
}
