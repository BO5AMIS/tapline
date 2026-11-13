import { Appearance, I18nManager } from 'react-native';
import { reload } from './actions';
import { animationsSaid, setAnimationSpeed } from './anim';
import { setKnowIdle } from './idle';
import { originalWarn } from './logs';
import {
  RESERVED_COMMANDS,
  SYSTEM_TEXT_SIZE,
  TEXT_SIZES,
  isRtlLanguage,
  parseLanguage,
  parseRegion,
  runTextSize,
} from './locale';
import { NETWORK_MODES, setNetworkCondition, type NetworkMode } from './network';
import { TaplineError, isRecord, type Json } from './types';

/**
 * App test commands: things an agent can ask the app to do that no screen offers quickly,
 * such as switching the language, signing in as a test user or loading sample data. The app
 * registers them (development and test builds); the agent lists and runs them by name.
 */
export interface TaplineCommand {
  /** One line for the agent: what it does and which args it takes. */
  description: string;
  run: (args: Record<string, unknown>) => unknown;
}

const NAME = /^[A-Za-z][\w.-]{0,40}$/;
const COMMAND_TIMEOUT_MS = 15_000;
const MAX_RESULT_CHARS = 4000;

const registry = new Map<string, TaplineCommand>();
/** The direction we last asked React Native for; it only shows in `I18nManager.isRTL` after a restart. */
let forcedRtl: boolean | null = null;
const warnedReserved = new Set<string>();

/** Built in: light or dark appearance, for checking both. */
const appearance: TaplineCommand = {
  description: 'Switch the app between light and dark appearance (args: { scheme: "light" | "dark" | "system" })',
  run: (args) => {
    const scheme = args.scheme;
    if (scheme !== 'light' && scheme !== 'dark' && scheme !== 'system') {
      throw new Error('scheme must be "light", "dark" or "system"');
    }
    Appearance.setColorScheme(scheme === 'system' ? 'unspecified' : scheme);
    return { scheme };
  },
};

/** The one sentence the answer gives about what the conditions reach and what they leave out. */
export const NETWORK_COVERAGE =
  "It covers the app's own fetch and XMLHttpRequest requests; WebSockets, images the native side loads and native SDKs are not affected.";

/** Built in: slow, flaky or no network for the app's own requests; back to normal by itself when the session ends. */
const network: TaplineCommand = {
  description:
    'Make the app\'s own network requests slow, flaky or fail (args: { mode: "offline" | "3g" | "lossy" | "normal" }); back to normal when the session ends',
  run: (args) => {
    const mode = args.mode;
    if (typeof mode !== 'string' || !NETWORK_MODES.includes(mode as NetworkMode)) {
      throw new Error('mode must be "offline", "3g", "lossy" or "normal"');
    }
    setNetworkCondition(mode as NetworkMode);
    return mode === 'normal' ? { mode } : { mode, covers: NETWORK_COVERAGE };
  },
};

/** Built in: the text size, through Tapline's font-scale helper (the app must use it; see locale.ts). */
const textSize: TaplineCommand = {
  description: `Set the text size the app shows (args: { size: ${[...TEXT_SIZES, SYSTEM_TEXT_SIZE].map((s) => `"${s}"`).join(' | ')} }; "system" restores the phone's own size); needs the app to use useTaplineFontScale; back to normal when the session ends`,
  run: runTextSize,
};

/** Built in: back to the 100 ms quiet window for this session. "know" comes only from `knowIdle` in `startTapline`. */
const settleMode: TaplineCommand = {
  description:
    "Make actions wait the 100 ms quiet window for this session (args: { mode: \"quiet\" }); the app's own setting (knowIdle) comes back when the session ends",
  run: (args) => {
    if (args.mode !== 'quiet') throw new Error('mode must be "quiet": know-don\'t-watch is switched on only by the app (knowIdle)');
    setKnowIdle(false);
    return { mode: 'quiet' };
  },
};

/**
 * Built in: fast-forwarded animations (PLAN-1.6 F4), in three layers. Off unless an agent asks; every answer says
 * while it is on (the host reads `tree.animations`); back to normal by itself when the session ends.
 */
const animations: TaplineCommand = {
  description:
    'Fast-forward animations: the native window, Animated and LayoutAnimation, Reanimated when present; timers are not touched (args: { speed: "fast" | "normal" }); back to normal when the session ends',
  run: async (args) => {
    const speed = args.speed;
    if (speed !== 'fast' && speed !== 'normal') throw new Error('speed must be "fast" or "normal"');
    const on = await setAnimationSpeed(speed);
    return { speed, layers: { ...on }, say: animationsSaid(speed) };
  },
};

function installBuiltIns(): void {
  registry.set('animations', animations);
  registry.set('settle', settleMode);
  registry.set('appearance', appearance);
  registry.set('network', network);
  registry.set('text_size', textSize);
}

function isDevelopmentBuild(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__;
}

/**
 * The standard `language` command (args: { language }): checks the code, runs the app's handler, and when
 * the switch changes the layout direction (to or from ar, he, fa, ur) reloads a development build or says
 * the app must be restarted, because React Native only reads the direction at start.
 */
function languageCommand(command: TaplineCommand): TaplineCommand {
  return {
    description: command.description,
    run: async (args) => {
      const language = parseLanguage(args);
      await command.run({ ...args, language });
      const rtl = isRtlLanguage(language);
      const direction = rtl ? 'right-to-left' : 'left-to-right';
      const running = I18nManager.isRTL;
      // What the next start will use: our last request if we made one, else what is running now.
      const pending = forcedRtl ?? running;
      if (rtl === pending) {
        if (rtl === running) return { language, say: `Language ${language}.` };
        // asked for earlier and still waiting for the restart
        return {
          language,
          restart: 'required',
          say: `Language ${language}. The ${direction} layout is already set and takes effect when the app restarts (close it and open it again).`,
        };
      }
      I18nManager.allowRTL(true);
      I18nManager.forceRTL(rtl);
      forcedRtl = rtl;
      if (rtl === running) {
        // the running layout is already right: undoing an earlier request needs no restart
        return {
          language,
          say: `Language ${language}. The layout stays ${direction}, as it is running now; the earlier change is undone and no restart is needed.`,
        };
      }
      if (isDevelopmentBuild()) {
        await reload();
        return {
          language,
          restart: 'reload',
          say: `Language ${language}. The layout is now ${direction}, which React Native only reads at start, so Tapline is reloading the app. Wait for it to reconnect.`,
        };
      }
      return {
        language,
        restart: 'required',
        say: `Language ${language}. The layout is now ${direction}, which React Native only reads at start: the app must be restarted (close it and open it again).`,
      };
    },
  };
}

/** The standard `region` command (args: { region }): checks the country code, then runs the app's handler. */
function regionCommand(command: TaplineCommand): TaplineCommand {
  return {
    description: command.description,
    run: async (args) => {
      const region = parseRegion(args);
      await command.run({ ...args, region });
      return { region, say: `Region ${region}.` };
    },
  };
}

function standardCommand(name: string, command: TaplineCommand): TaplineCommand {
  if (name === 'language') return languageCommand(command);
  if (name === 'region') return regionCommand(command);
  return command;
}
installBuiltIns();

/** Registers (or replaces) a command; returns a function that removes it. */
export function registerTaplineCommand(name: string, command: TaplineCommand): () => void {
  if (!NAME.test(name)) {
    throw new Error(`Tapline command names are letters, digits, ".", "_" and "-", starting with a letter: "${name}"`);
  }
  if (typeof command.run !== 'function') throw new Error(`Tapline command "${name}" needs a run function`);
  if (RESERVED_COMMANDS.includes(name)) {
    // Never throw into the app (an app that registered this name under an older version must still start).
    if (!warnedReserved.has(name)) {
      warnedReserved.add(name);
      originalWarn(`[tapline] "${name}" is a built-in Tapline command; your registration of it is ignored.`);
    }
    return () => undefined;
  }
  // `language` and `region` are standard names: their arguments are checked here, wherever the app registers them.
  const registered = standardCommand(name, command);
  registry.set(name, registered);
  return () => {
    if (registry.get(name) === registered) registry.delete(name);
  };
}

/**
 * Registers the standard `language` command: `handler` receives a checked BCP 47 code (`ar`, `en-GB`) and
 * switches the app's language. A switch to or from a right-to-left language reloads a development build.
 */
export function registerLanguageCommand(handler: (language: string) => unknown): () => void {
  return registerTaplineCommand('language', {
    description: 'Switch the app language (args: { language: BCP 47 code such as "ar" or "en-GB" })',
    run: (args) => handler(String(args.language)),
  });
}

/** Registers the standard `region` command: `handler` receives a checked ISO 3166 country code (`QA`). */
export function registerRegionCommand(handler: (region: string) => unknown): () => void {
  return registerTaplineCommand('region', {
    description: 'Switch the app region (args: { region: ISO 3166 country code such as "QA" })',
    run: (args) => handler(String(args.region)),
  });
}

/** Removes the app's commands and restores the built-ins (tests). */
export function resetCommands(): void {
  registry.clear();
  forcedRtl = null;
  warnedReserved.clear();
  installBuiltIns();
}

export function listCommands(): Array<{ name: string; description: string }> {
  return [...registry.entries()]
    .map(([name, command]) => ({ name, description: String(command.description) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A JSON-safe copy: no functions, dates as ISO strings, cycles and deep nesting cut. */
function toJson(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): Json | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value !== 'object' || depth > 6) return undefined;
  if (seen.has(value)) return '[cycle]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => toJson(item, depth + 1, seen) ?? null);
  const out: { [key: string]: Json } = {};
  for (const [key, item] of Object.entries(value)) {
    const json = toJson(item, depth + 1, seen);
    if (json !== undefined) out[key] = json;
  }
  return out;
}

/** `command`: runs a registered command with `args`. */
export async function runCommand(params: unknown): Promise<{ name: string; result: Json | null }> {
  if (!isRecord(params) || typeof params.name !== 'string' || params.name === '') {
    throw new TaplineError('bad_params', 'command needs { name, args? }');
  }
  if (params.args !== undefined && !isRecord(params.args)) {
    throw new TaplineError('bad_params', 'args must be an object');
  }
  const { name } = params;
  const command = registry.get(name);
  if (!command) {
    const known = listCommands().map((c) => c.name).join(', ');
    throw new TaplineError('not_found', `No command "${name}". This app has: ${known}.`);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new TaplineError('timeout', `Command "${name}" did not finish in ${COMMAND_TIMEOUT_MS / 1000} s`)),
        COMMAND_TIMEOUT_MS,
      );
    });
    const value = await Promise.race([Promise.resolve().then(() => command.run(isRecord(params.args) ? params.args : {})), timeout]);
    let result = toJson(value) ?? null;
    const text = JSON.stringify(result);
    if (text.length > MAX_RESULT_CHARS) result = { truncated: true, preview: text.slice(0, MAX_RESULT_CHARS) };
    return { name, result };
  } catch (error) {
    if (error instanceof TaplineError) throw error;
    throw new TaplineError('internal', `Command "${name}" failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
