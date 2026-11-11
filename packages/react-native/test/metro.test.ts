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

describe('the development offer on Metro (zero-QR pairing)', () => {
  const fs = jest.requireActual<typeof import('fs')>('fs');
  const os = jest.requireActual<typeof import('os')>('os');
  const { readOffer, offerMiddleware, isLocalNetwork } = jest.requireActual<typeof import('../metro')>('../metro');

  function tempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'tapline-offers-'));
  }

  test('serves the newest open offer and skips expired ones', () => {
    const dir = tempDir();
    const now = Date.now();
    fs.writeFileSync(path.join(dir, '7210.json'), JSON.stringify({ code: 'old', name: 'PC', port: 7210, until: now - 1 }));
    fs.writeFileSync(path.join(dir, '19001.json'), JSON.stringify({ code: 'c-9', name: 'Dev PC', port: 19001, until: now + 60_000 }));
    expect(readOffer(dir)).toEqual({ code: 'c-9', name: 'Dev PC', port: 19001 });
    fs.rmSync(dir, { recursive: true, force: true });
    expect(readOffer(dir)).toBeNull();
  });

  test('answers /tapline/offer to the local network only and passes everything else on', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, '7210.json'), JSON.stringify({ code: 'c-1', name: 'Dev PC', port: 7210, until: Date.now() + 60_000 }));
    const handler = offerMiddleware(dir);
    const call = (url: string, remoteAddress: string) => {
      const out: { status?: number; body?: string; next: boolean } = { next: false };
      const req = { url, socket: { remoteAddress } } as unknown as import('http').IncomingMessage;
      const res = {
        writeHead: (status: number) => {
          out.status = status;
        },
        end: (body: string) => {
          out.body = body;
        },
      } as unknown as import('http').ServerResponse;
      handler(req, res, () => {
        out.next = true;
      });
      return out;
    };
    expect(call('/tapline/offer', '192.168.1.30')).toMatchObject({ status: 200, body: JSON.stringify({ code: 'c-1', name: 'Dev PC', port: 7210 }) });
    expect(call('/tapline/offer', '100.101.102.104')).toMatchObject({ status: 403 });
    expect(call('/index.bundle?platform=ios', '192.168.1.30')).toMatchObject({ next: true });
    expect(isLocalNetwork('::ffff:10.1.2.3')).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('chains an existing enhanceMiddleware', () => {
    const seen: string[] = [];
    const config: Config = {
      server: {
        enhanceMiddleware: (middleware) => (req, res, next) => {
          seen.push(`app:${req.url ?? ''}`);
          middleware(req, res, next);
        },
      },
    };
    const next = withTapline(config, { enabled: true });
    const base = jest.fn();
    const enhanced = next.server?.enhanceMiddleware?.(base, {});
    enhanced?.({ url: '/status', socket: {} } as unknown as import('http').IncomingMessage, {} as import('http').ServerResponse, () => undefined);
    expect(seen).toEqual(['app:/status']);
    expect(base).toHaveBeenCalled();
  });
});
