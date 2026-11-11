// @ts-check
'use strict';

const path = require('path');

/**
 * Metro config helper: runs Tapline's `register` before the app's main module, so the app
 * doesn't need its own entry file just to import it first. Only when Tapline is on
 * (EXPO_PUBLIC_TAPLINE_ENABLED=1 by default), so store builds stay untouched.
 *
 *   // metro.config.js
 *   const { getDefaultConfig } = require('expo/metro-config');
 *   const { withTapline } = require('react-native-tapline/metro');
 *   module.exports = withTapline(getDefaultConfig(__dirname));
 *
 * The app still calls startTapline() (for example at the top of app/_layout.tsx).
 *
 * @template {{ serializer?: { getModulesRunBeforeMainModule?: (entryFilePath: string) => string[] } & Record<string, unknown> } & Record<string, unknown>} C
 * @param {C} config
 * @param {{ enabled?: boolean }} [options]
 * @returns {C}
 */
function withTapline(config, options = {}) {
  const enabled = options.enabled ?? process.env.EXPO_PUBLIC_TAPLINE_ENABLED === '1';
  if (!enabled) return config;
  // The same file the package's own index imports, so Metro has it in the bundle.
  const register = path.join(__dirname, 'dist', 'register.js');
  const serializer = config.serializer ?? {};
  const previous = serializer.getModulesRunBeforeMainModule;
  return {
    ...config,
    serializer: {
      ...serializer,
      /** @param {string} entryFilePath */
      getModulesRunBeforeMainModule: (entryFilePath) => [...(previous ? previous(entryFilePath) : []), register],
    },
  };
}

module.exports = { withTapline };
