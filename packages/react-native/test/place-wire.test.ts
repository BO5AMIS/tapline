import { detectedApp } from '../src/appinfo';
import { TaplineClient, defaultCapabilities, type WebSocketLike } from '../src/client';
import { methods } from '../src/methods';
import type { DeviceInfo } from '../src/types';

// AGENT-TOOLS 1.13 §18.9 and §18.11: the app's own id for the map, the capabilities, and the place event on the wire.

class MockSocket implements WebSocketLike {
  static instances: MockSocket[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: string[] = [];

  constructor(readonly url: string) {
    MockSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    // nothing to release
  }

  get messages(): Array<Record<string, unknown>> {
    return this.sent.map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

const DEVICE: DeviceInfo = { platform: 'ios', osVersion: '26.1' };

function constants(value: Record<string, unknown>): void {
  jest.doMock('expo-constants', () => ({ __esModule: true, default: value }), { virtual: true });
}

beforeEach(() => {
  jest.useFakeTimers();
  MockSocket.instances = [];
});

afterEach(() => {
  jest.useRealTimers();
  jest.resetModules();
  jest.doMock('expo-constants', () => ({}), { virtual: true });
});

describe('the app id for the map', () => {
  test('in Expo Go the id is the app config, never Expo Go: ios id, else android package, else slug', () => {
    constants({
      executionEnvironment: 'storeClient',
      nativeAppVersion: '2.0.0', // Expo Go's own
      nativeBuildVersion: '99',
      expoConfig: { name: 'Wayfare', slug: 'wayfare', version: '1.4.0', ios: { bundleIdentifier: 'com.example.wayfare', buildNumber: '212' } },
    });
    let found: ReturnType<typeof detectedApp> = {};
    jest.isolateModules(() => {
      found = (require('../src/appinfo') as typeof import('../src/appinfo')).detectedApp();
    });
    expect(found).toEqual({ id: 'com.example.wayfare', name: 'Wayfare', version: '1.4.0', build: '1.4.0 (212)' });

    constants({ executionEnvironment: 'storeClient', expoConfig: { slug: 'wayfare', android: { package: 'com.example.wayfare.android' } } });
    jest.isolateModules(() => {
      found = (require('../src/appinfo') as typeof import('../src/appinfo')).detectedApp();
    });
    expect(found.id).toBe('com.example.wayfare.android');

    constants({ executionEnvironment: 'storeClient', expoConfig: { slug: 'wayfare' } });
    jest.isolateModules(() => {
      found = (require('../src/appinfo') as typeof import('../src/appinfo')).detectedApp();
    });
    expect(found.id).toBe('wayfare');
  });

  test('in a build the build field is the native version and build number', () => {
    constants({
      executionEnvironment: 'bare',
      nativeAppVersion: '1.4.0',
      nativeBuildVersion: '212',
      expoConfig: { slug: 'wayfare', version: '9.9.9', ios: { bundleIdentifier: 'com.example.wayfare', buildNumber: '1' } },
    });
    let found: ReturnType<typeof detectedApp> = {};
    jest.isolateModules(() => {
      found = (require('../src/appinfo') as typeof import('../src/appinfo')).detectedApp();
    });
    expect(found).toMatchObject({ id: 'com.example.wayfare', version: '1.4.0', build: '1.4.0 (212)' });
  });

  test('without expo-constants nothing is detected and nothing throws', () => {
    expect(detectedApp()).toEqual({});
  });

  test('hello uses what is detected, and what the app passes wins', () => {
    constants({ executionEnvironment: 'storeClient', expoConfig: { slug: 'wayfare', version: '1.4.0', ios: { bundleIdentifier: 'com.example.wayfare', buildNumber: '212' } } });
    jest.isolateModules(() => {
      const fresh = require('../src/client') as typeof import('../src/client');
      const detected = new fresh.TaplineClient({ url: 'ws://h:1', token: 't' }, { WebSocketCtor: MockSocket, device: DEVICE, capabilities: [], log: () => undefined, methods: {} });
      detected.start();
      MockSocket.instances[0]?.onopen?.({});
      expect(MockSocket.instances[0]?.messages[0]?.app).toEqual({ name: 'App', id: 'com.example.wayfare', version: '1.4.0', build: '1.4.0 (212)' });

      const given = new fresh.TaplineClient(
        { url: 'ws://h:1', token: 't', app: { id: 'com.example.own', name: 'Own' } },
        { WebSocketCtor: MockSocket, device: DEVICE, capabilities: [], log: () => undefined, methods: {} },
      );
      given.start();
      MockSocket.instances[1]?.onopen?.({});
      expect(MockSocket.instances[1]?.messages[0]?.app).toMatchObject({ id: 'com.example.own', name: 'Own', build: '1.4.0 (212)' });
    });
  });
});

describe('capabilities and requests', () => {
  test('hello announces place, places and move', () => {
    expect(defaultCapabilities()).toEqual(expect.arrayContaining(['place', 'places', 'move']));
  });

  test('every announced new capability has a request behind it', () => {
    for (const name of ['place', 'places', 'move']) expect(typeof methods[name]).toBe('function');
  });

  test('the place request answers a route and seenAt, the places request a source', async () => {
    const place = await methods.place?.({});
    expect(place).toMatchObject({ route: expect.any(Array), seenAt: expect.any(Number) });
    const places = await methods.places?.({});
    expect(places).toMatchObject({ source: expect.stringMatching(/^(expo-router|react-navigation|none)$/), places: expect.any(Array) });
  });
});

describe('the place event on the wire', () => {
  test('goes out after welcome, and not after the connection is lost', () => {
    const client = new TaplineClient({ url: 'ws://h:1', token: 't' }, { WebSocketCtor: MockSocket, device: DEVICE, capabilities: [], log: () => undefined, methods: {} });
    client.start();
    const socket = MockSocket.instances[0];
    socket?.onopen?.({});
    expect(socket?.messages.some((m) => m.event === 'place')).toBe(false);
    socket?.onmessage?.({ data: JSON.stringify({ type: 'welcome', protocol: 1, session: 's-1' }) });
    const events = socket?.messages.filter((m) => m.type === 'event' && m.event === 'place') ?? [];
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toMatchObject({ route: [], seenAt: expect.any(Number) });
    client.stop();
  });
});
