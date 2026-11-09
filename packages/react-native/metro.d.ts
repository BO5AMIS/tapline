export interface TaplineMetroConfig {
  serializer?: { getModulesRunBeforeMainModule?: (entryFilePath: string) => string[] } & Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Runs Tapline's `register` before the app's main module (only when Tapline is on:
 * EXPO_PUBLIC_TAPLINE_ENABLED=1, or `enabled`), so no custom entry file is needed.
 */
export function withTapline<C extends TaplineMetroConfig>(config: C, options?: { enabled?: boolean }): C;
