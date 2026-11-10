import { Keyboard } from 'react-native';
import { isRecord } from './types';

/** What is known of the software keyboard: whether it is up, and its top edge in window points. */
export interface KeyboardState {
  shown: boolean;
  /** The keyboard's top edge, or null when it is down or its frame isn't known. */
  top: number | null;
}

let seen: KeyboardState | null = null;
let listening = false;
let reader: (() => KeyboardState | undefined) | null = null;

function topOf(event: unknown): number | null {
  const end = isRecord(event) && isRecord(event.endCoordinates) ? event.endCoordinates : null;
  return end !== null && typeof end.screenY === 'number' ? end.screenY : null;
}

/**
 * Follows the keyboard from the first read on. iOS says where the keyboard goes as it starts to
 * move (`keyboardWill…`), so an answer given while it animates in already knows it is coming;
 * Android only says so once it has moved (`keyboardDid…`).
 */
function listen(): void {
  if (listening) return;
  listening = true;
  const follow = (name: string, shown: boolean): void => {
    (Keyboard.addListener as (event: string, handler: (event: unknown) => void) => unknown)(name, (event) => {
      seen = { shown, top: shown ? topOf(event) : null };
    });
  };
  try {
    follow('keyboardWillShow', true);
    follow('keyboardDidShow', true);
    follow('keyboardWillHide', false);
    follow('keyboardDidHide', false);
  } catch {
    // React Native can't say; reads fall back to Keyboard.isVisible().
  }
}

/** Until the first keyboard event, what React Native itself knows (`Keyboard.isVisible`, `Keyboard.metrics`). */
function fromReactNative(): KeyboardState | undefined {
  try {
    const keyboard = Keyboard as unknown as { isVisible?: () => unknown; metrics?: () => unknown };
    if (typeof keyboard.isVisible !== 'function') return undefined;
    const shown = keyboard.isVisible.call(Keyboard) === true;
    const metrics = shown && typeof keyboard.metrics === 'function' ? keyboard.metrics.call(Keyboard) : undefined;
    return { shown, top: isRecord(metrics) && typeof metrics.screenY === 'number' ? metrics.screenY : null };
  } catch {
    return undefined;
  }
}

/** The keyboard now, or undefined when React Native can't say. */
export function keyboardState(): KeyboardState | undefined {
  if (reader !== null) return reader();
  listen();
  return seen ?? fromReactNative();
}

/** Replace where the keyboard's state comes from (tests); null restores React Native. */
export function setKeyboardReader(next: (() => KeyboardState | undefined) | null): void {
  reader = next;
}
