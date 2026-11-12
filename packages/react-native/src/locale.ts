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

/** Names the SDK provides itself; an app cannot register over them. */
export const BUILT_IN_COMMANDS: readonly string[] = ['appearance', 'network', 'text_size'];

// --- validation ---------------------------------------------------------------------------------------------

const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const REGION_CODE = /^[A-Za-z]{2}$/;

function badParams(message: string): TaplineError {
  return new TaplineError('bad_params', message);
}

/** A BCP 47 code such as `ar` or `en-GB`. */
export function parseLanguage(args: Record<string, unknown>): string {
  const value = args.language;
  if (typeof value !== 'string' || !LANGUAGE_TAG.test(value)) {
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

export function parseTextSize(args: Record<string, unknown>): TextSize {
  const value = args.size;
  if (!isTextSize(value)) {
    throw badParams(`size must be one of ${TEXT_SIZES.join(', ')}`);
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
let helperUsed = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** The font scale to use: the one an agent set with `text_size`, else the system's. */
export function getTaplineFontScale(): number {
  return override ?? PixelRatio.getFontScale();
}

/** Calls `listener` when the override changes; returns the function that stops it. Counts as using the helper. */
export function subscribeTaplineFontScale(listener: () => void): () => void {
  helperUsed = true;
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The font scale the app should apply to its text: the size an agent set with the `text_size`
 * command, else the system's. React Native reads the system scale natively, so Tapline cannot
 * change it; an app that multiplies its font sizes by this value opts in to `text_size`.
 */
export function useTaplineFontScale(): number {
  const [scale, setScale] = useState(getTaplineFontScale);
  useEffect(() => {
    const update = (): void => setScale(getTaplineFontScale());
    const stop = subscribeTaplineFontScale(update);
    update();
    return stop;
  }, []);
  return scale;
}

/** True once the app has used the hook or the subscriber (a mounted `useTaplineFontScale`). */
export function fontScaleHelperUsed(): boolean {
  return helperUsed;
}

export function setTaplineFontScale(scale: number | null): void {
  override = scale;
  emit();
}

/** Forgets the override and that the helper was used (tests). */
export function resetFontScale(): void {
  override = null;
  helperUsed = false;
  listeners.clear();
}

/** `1.12×`, `1×`: the scale as the answer writes it. */
export function formatScale(scale: number): string {
  return `${Number(scale.toFixed(2))}×`;
}

export const TEXT_SIZE_UNSUPPORTED =
  "This app doesn't use Tapline's font-scale helper (useTaplineFontScale), and React Native reads the system text size natively. To check large text, use audit's dynamic_type check or Tapwright's open_app { text_size }.";

/** The built-in `text_size` run: validates, then sets the override. */
export function runTextSize(args: Record<string, unknown>): { size: TextSize; scale: number; say: string } {
  const size = parseTextSize(args);
  if (!helperUsed) throw new TaplineError('unsupported', TEXT_SIZE_UNSUPPORTED);
  const scale = TEXT_SIZE_SCALES[size];
  setTaplineFontScale(scale);
  return { size, scale, say: `Text size ${size} (${formatScale(scale)}).` };
}
