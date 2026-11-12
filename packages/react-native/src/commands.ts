import { Appearance } from 'react-native';
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

function installBuiltIns(): void {
  registry.set('appearance', appearance);
  registry.set('network', network);
}
installBuiltIns();

/** Registers (or replaces) a command; returns a function that removes it. */
export function registerTaplineCommand(name: string, command: TaplineCommand): () => void {
  if (!NAME.test(name)) {
    throw new Error(`Tapline command names are letters, digits, ".", "_" and "-", starting with a letter: "${name}"`);
  }
  if (typeof command.run !== 'function') throw new Error(`Tapline command "${name}" needs a run function`);
  registry.set(name, command);
  return () => {
    if (registry.get(name) === command) registry.delete(name);
  };
}

/** Removes the app's commands and restores the built-ins (tests). */
export function resetCommands(): void {
  registry.clear();
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
