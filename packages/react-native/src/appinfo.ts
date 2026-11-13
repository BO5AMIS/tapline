import { Platform } from 'react-native';
import { isRecord, type AppInfo, type UnknownRecord } from './types';

/**
 * What the app's own config says about it (AGENT-TOOLS 1.13 §18.9). Read from `expo-constants` when the app has it;
 * every read is guarded, so an app without Expo answers nothing and nothing throws.
 */

function expoConstants(): UnknownRecord | null {
  try {
    const loaded: unknown = require('expo-constants');
    const candidate = isRecord(loaded) && isRecord(loaded.default) ? loaded.default : loaded;
    return isRecord(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/** The app's `expoConfig` (app.json), or null. */
export function expoConfig(): UnknownRecord | null {
  const constants = expoConstants();
  return constants !== null && isRecord(constants.expoConfig) ? constants.expoConfig : null;
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function nested(config: UnknownRecord | null, key: string, field: string): unknown {
  const section = config?.[key];
  return isRecord(section) ? section[field] : undefined;
}

/** The app's URL scheme (the first one when it has several), from its config; undefined when it has none. */
export function appScheme(): string | undefined {
  const scheme = expoConfig()?.scheme;
  if (typeof scheme === 'string' && scheme !== '') return scheme;
  if (Array.isArray(scheme)) {
    const first = scheme.find((entry): entry is string => typeof entry === 'string' && entry !== '');
    if (first !== undefined) return first;
  }
  return undefined;
}

/**
 * The app's own id, version and build for the hello message. In Expo Go every app reports Expo Go's bundle id, so the
 * id comes from the app's config: `ios.bundleIdentifier ?? android.package ?? slug` (§18.9). The build is
 * `<version> (<build number>)`, the native version and build number (`CFBundleShortVersionString (CFBundleVersion)`);
 * in Expo Go, whose own build number isn't the app's, the config's version and build number stand in.
 */
export function detectedApp(): AppInfo {
  const constants = expoConstants();
  const config = expoConfig();
  if (constants === null) return {};
  const inGo = constants.executionEnvironment === 'storeClient';
  const info: AppInfo = {};
  const id = text(nested(config, 'ios', 'bundleIdentifier')) ?? text(nested(config, 'android', 'package')) ?? text(config?.slug);
  if (id !== undefined) info.id = id;
  const name = text(config?.name);
  if (name !== undefined) info.name = name;
  const configBuild = Platform.OS === 'android' ? nested(config, 'android', 'versionCode') : nested(config, 'ios', 'buildNumber');
  const version = (inGo ? undefined : text(constants.nativeAppVersion)) ?? text(config?.version);
  const buildNumber = (inGo ? undefined : text(constants.nativeBuildVersion)) ?? text(configBuild);
  if (version !== undefined) {
    info.version = version;
    info.build = buildNumber !== undefined ? `${version} (${buildNumber})` : version;
  }
  return info;
}
