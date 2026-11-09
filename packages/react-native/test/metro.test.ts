import path from 'path';
import { withTapline } from '../metro';

const REGISTER = path.join(__dirname, '..', 'dist', 'register.js');

type Config = Parameters<typeof withTapline>[0];

const emptyConfig = (): Config => ({});

test('runs register before the main module, after what was already there', () => {
  const previous = jest.fn((entry: string) => [`${entry}:InitializeCore`]);
  const config: Config = { serializer: { getModulesRunBeforeMainModule: previous }, resolver: { sourceExts: ['ts'] } };
  const next = withTapline(config, { enabled: true });
  expect(next.serializer?.getModulesRunBeforeMainModule?.('/app/index.js')).toEqual(['/app/index.js:InitializeCore', REGISTER]);
  expect(previous).toHaveBeenCalledWith('/app/index.js');
  expect(next.resolver).toBe(config.resolver);
});

test('works without an existing list', () => {
  const next = withTapline(emptyConfig(), { enabled: true });
  expect(next.serializer?.getModulesRunBeforeMainModule?.('/app/index.js')).toEqual([REGISTER]);
});

test('leaves the config alone when Tapline is off (the store build)', () => {
  const config: Config = { serializer: {} };
  expect(withTapline(config, { enabled: false })).toBe(config);
});

test('reads EXPO_PUBLIC_TAPLINE_ENABLED by default', () => {
  const saved = process.env.EXPO_PUBLIC_TAPLINE_ENABLED;
  try {
    process.env.EXPO_PUBLIC_TAPLINE_ENABLED = '1';
    expect(withTapline(emptyConfig()).serializer?.getModulesRunBeforeMainModule).toBeDefined();
    process.env.EXPO_PUBLIC_TAPLINE_ENABLED = '0';
    const config: Config = {};
    expect(withTapline(config)).toBe(config);
  } finally {
    if (saved === undefined) delete process.env.EXPO_PUBLIC_TAPLINE_ENABLED;
    else process.env.EXPO_PUBLIC_TAPLINE_ENABLED = saved;
  }
});

test('adds the same register file the package index imports (dist/register.js)', () => {
  const next = withTapline(emptyConfig(), { enabled: true });
  const [added] = next.serializer?.getModulesRunBeforeMainModule?.('/x') ?? [];
  expect(added).toBe(REGISTER);
});
