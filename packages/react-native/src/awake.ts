import { isRecord } from './types';

/** Keeps the phone's screen on while an agent is connected, so auto-lock doesn't cut the run. */

const TAG = 'tapline';

interface KeepAwakeModule {
  activateKeepAwakeAsync?: (tag?: string) => Promise<void>;
  activateKeepAwake?: (tag?: string) => void;
  deactivateKeepAwake: (tag?: string) => unknown;
}

function isKeepAwake(value: unknown): value is KeepAwakeModule {
  return (
    isRecord(value) &&
    typeof value.deactivateKeepAwake === 'function' &&
    (typeof value.activateKeepAwakeAsync === 'function' || typeof value.activateKeepAwake === 'function')
  );
}

let loaded: KeepAwakeModule | null | undefined;
let awake = false;

/** expo-keep-awake when the app has it, else null (then this does nothing). */
function keepAwakeModule(): KeepAwakeModule | null {
  if (loaded !== undefined) return loaded;
  try {
    const mod: unknown = require('expo-keep-awake');
    loaded = isKeepAwake(mod) ? mod : isRecord(mod) && isKeepAwake(mod.default) ? mod.default : null;
  } catch {
    loaded = null;
  }
  return loaded;
}

/** Turns keeping the screen on on or off; repeated calls with the same value do nothing. Never throws. */
export function keepAwake(on: boolean): void {
  if (on === awake) return;
  awake = on;
  const mod = keepAwakeModule();
  if (!mod) return;
  try {
    if (on) {
      if (mod.activateKeepAwakeAsync) void mod.activateKeepAwakeAsync(TAG).catch(() => undefined);
      else mod.activateKeepAwake?.(TAG);
    } else {
      const result = mod.deactivateKeepAwake(TAG);
      if (isRecord(result) && typeof result.catch === 'function') {
        (result as unknown as Promise<unknown>).catch(() => undefined);
      }
    }
  } catch {
    // never throw into the app
  }
}
