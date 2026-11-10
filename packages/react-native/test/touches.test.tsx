import { SAMPLE_FRAMES, SampleScreen, frame, keyOf, makeSpies, mount, unmountAll, useFrames, type Spies } from './helpers';
import React from 'react';
import { AppRegistry, Dimensions, PixelRatio, View } from 'react-native';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { configureActions, press } from '../src/actions';
import { installAlertTracking, uninstallAlertTracking } from '../src/alerts';
import { TaplineClient, type ClientDeps, type WebSocketLike } from '../src/client';
import { setEventSink } from '../src/events';
import { propsOf } from '../src/fiber';
import { resetRefs, setMeasurer, tree } from '../src/inspect';
import { TOUCH_THROTTLE_MS, noteRealTouch, onRealTouch, resetTouches } from '../src/touches';
import type { DeviceInfo } from '../src/types';

type WrapperComponent = React.ComponentType<{ children?: React.ReactNode }>;

afterEach(() => {
  resetTouches();
});

describe('noteRealTouch (the throttle and the subscription)', () => {
  test('passes a touch to every listener with its time, and says so', () => {
    const a = jest.fn();
    const b = jest.fn();
    onRealTouch(a);
    onRealTouch(b);
    expect(noteRealTouch(1000)).toBe(true);
    expect(a).toHaveBeenCalledWith(1000);
    expect(b).toHaveBeenCalledWith(1000);
  });

  test('does nothing while nobody listens, and does not start a throttle window', () => {
    expect(noteRealTouch(1000)).toBe(false);
    const listener = jest.fn();
    onRealTouch(listener);
    expect(noteRealTouch(1001)).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('passes at most one touch per 500 ms, counted from the last one passed on', () => {
    const listener = jest.fn();
    onRealTouch(listener);
    expect(noteRealTouch(1000)).toBe(true);
    expect(noteRealTouch(1100)).toBe(false);
    expect(noteRealTouch(1000 + TOUCH_THROTTLE_MS - 1)).toBe(false);
    expect(noteRealTouch(1000 + TOUCH_THROTTLE_MS)).toBe(true);
    expect(noteRealTouch(1000 + TOUCH_THROTTLE_MS + 10)).toBe(false);
    expect(listener.mock.calls).toEqual([[1000], [1500]]);
  });

  test('a clock that goes backwards does not silence touches', () => {
    const listener = jest.fn();
    onRealTouch(listener);
    noteRealTouch(100_000);
    expect(noteRealTouch(5_000)).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  test('unsubscribing stops the calls', () => {
    const listener = jest.fn();
    const stop = onRealTouch(listener);
    stop();
    expect(noteRealTouch(1000)).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  test('a listener that throws neither reaches the caller nor blocks the others', () => {
    const after = jest.fn();
    onRealTouch(() => {
      throw new Error('boom');
    });
    onRealTouch(after);
    expect(() => noteRealTouch(1000)).not.toThrow();
    expect(after).toHaveBeenCalledWith(1000);
  });
});

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
    // nothing
  }

  events(name: string): Array<Record<string, unknown>> {
    return this.sent
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((message) => message.type === 'event' && message.event === name);
  }
}

const DEVICE: DeviceInfo = { platform: 'ios', osVersion: '26.1', model: 'iPhone18,2', name: 'My iPhone' };

function makeClient(): TaplineClient {
  const deps: ClientDeps = {
    WebSocketCtor: MockSocket,
    device: DEVICE,
    capabilities: ['tree', 'press'],
    log: () => undefined,
    methods: {},
    appState: { addEventListener: () => ({ remove: () => undefined }) },
    keepAwake: () => undefined,
  };
  return new TaplineClient({ url: 'ws://100.64.0.7:7210', token: 'secret-token', app: { name: 'Demo' } }, deps);
}

function connect(client: TaplineClient): MockSocket {
  client.start();
  const socket = MockSocket.instances[MockSocket.instances.length - 1];
  if (!socket) throw new Error('no socket');
  socket.onopen?.({});
  socket.onmessage?.({ data: JSON.stringify({ type: 'welcome', protocol: 1, session: 's-1' }) });
  return socket;
}

function touchCapture(root: ReactTestInstance): (event: unknown) => unknown {
  const found = root.findAll((node) => typeof node.props.onStartShouldSetResponderCapture === 'function');
  const handler: unknown = found[0]?.props.onStartShouldSetResponderCapture;
  if (typeof handler !== 'function') throw new Error('the wrapper has no touch capture');
  return (event: unknown) => (handler as (e: unknown) => unknown)(event);
}

describe('the wrapper around the app (real touches)', () => {
  let spies: Spies;
  let wrapperSpy: jest.SpyInstance;
  let now = 10_000;

  beforeAll(() => configureActions({ quietMs: 0, capMs: 0 }));

  beforeEach(() => {
    MockSocket.instances = [];
    resetRefs();
    spies = makeSpies();
    now = 10_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 400, height: 800, scale: 2, fontScale: 1 });
    jest.spyOn(PixelRatio, 'get').mockReturnValue(2);
    wrapperSpy = jest.spyOn(AppRegistry, 'setWrapperComponentProvider').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await unmountAll();
    setMeasurer(null);
    setEventSink(null);
    uninstallAlertTracking();
    jest.restoreAllMocks();
  });

  function wrapper(): WrapperComponent {
    const provider = wrapperSpy.mock.calls[0]?.[0] as (() => WrapperComponent) | undefined;
    if (!provider) throw new Error('no wrapper provider registered');
    return provider();
  }

  test('there is exactly one provider, in record mode and in stand-in mode', () => {
    installAlertTracking();
    installAlertTracking();
    expect(wrapperSpy).toHaveBeenCalledTimes(1);
    uninstallAlertTracking();
    wrapperSpy.mockClear();
    installAlertTracking({ standIn: true });
    installAlertTracking({ standIn: true });
    expect(wrapperSpy).toHaveBeenCalledTimes(1);
  });

  test('the capture handler returns false, so the app still gets the touch', async () => {
    installAlertTracking();
    const Wrapper = wrapper();
    const renderer = await mount(
      <Wrapper>
        <View testID="app-content" />
      </Wrapper>,
    );
    const capture = touchCapture(renderer.root);
    expect(capture({})).toBe(false);
    // and still false with nobody listening or after a stop
    uninstallAlertTracking();
    expect(capture({})).toBe(false);
  });

  test('a burst of touches sends one `touch` event; the next burst 500 ms later sends another', async () => {
    installAlertTracking();
    const client = makeClient();
    const socket = connect(client);
    const Wrapper = wrapper();
    const renderer = await mount(
      <Wrapper>
        <View testID="app-content" />
      </Wrapper>,
    );
    const capture = touchCapture(renderer.root);
    capture({});
    now += 100;
    capture({});
    now += 100;
    capture({});
    expect(socket.events('touch')).toEqual([{ type: 'event', event: 'touch', data: { at: 10_000 } }]);
    now += TOUCH_THROTTLE_MS;
    capture({});
    expect(socket.events('touch')).toHaveLength(2);
    expect(socket.events('touch')[1]).toMatchObject({ data: { at: 10_000 + 200 + TOUCH_THROTTLE_MS } });
    client.stop();
  });

  test('stand-in mode watches touches too, also on the alert host it draws', async () => {
    installAlertTracking({ standIn: true });
    const client = makeClient();
    const socket = connect(client);
    const Wrapper = wrapper();
    const renderer = await mount(
      <Wrapper>
        <View testID="app-content" />
      </Wrapper>,
    );
    expect(touchCapture(renderer.root)({})).toBe(false);
    expect(socket.events('touch')).toHaveLength(1);
    client.stop();
  });

  test('nothing is sent after the client is stopped, or before it is connected', async () => {
    installAlertTracking();
    const client = makeClient();
    const Wrapper = wrapper();
    const renderer = await mount(
      <Wrapper>
        <View testID="app-content" />
      </Wrapper>,
    );
    const capture = touchCapture(renderer.root);
    client.start(); // the socket has not opened yet: no host is connected
    const socket = MockSocket.instances[MockSocket.instances.length - 1];
    if (!socket) throw new Error('no socket');
    capture({});
    expect(socket.events('touch')).toEqual([]);
    client.stop();
    capture({});
    expect(socket.events('touch')).toEqual([]);
  });

  test('nothing is sent when the SDK is stopped', async () => {
    installAlertTracking();
    const client = makeClient();
    const socket = connect(client);
    const Wrapper = wrapper();
    const renderer = await mount(
      <Wrapper>
        <View testID="app-content" />
      </Wrapper>,
    );
    const capture = touchCapture(renderer.root);
    client.stop();
    uninstallAlertTracking();
    now += 5000;
    capture({});
    expect(socket.events('touch')).toEqual([]);
  });

  test('the tree is the same with and without the wrapper, and it is not reported as an element', async () => {
    installAlertTracking();
    const Wrapper = wrapper();
    await mount(
      <Wrapper>
        <SampleScreen spies={spies} />
      </Wrapper>,
    );
    useFramesWithWrapperFullScreen();
    const wrapped = await tree({});
    await unmountAll();
    resetRefs();
    await mount(<SampleScreen spies={spies} />);
    useFrames(SAMPLE_FRAMES);
    const bare = await tree({});
    expect(wrapped.elements.length).toBeGreaterThan(5);
    expect(wrapped.elements).toEqual(bare.elements);
    expect(JSON.stringify(wrapped)).not.toContain('onStartShouldSetResponderCapture');
  });

  test('a full-screen wrapper does not cover the app: a tap at a point still reaches the button under it', async () => {
    installAlertTracking();
    const Wrapper = wrapper();
    await mount(
      <Wrapper>
        <SampleScreen spies={spies} />
      </Wrapper>,
    );
    useFramesWithWrapperFullScreen();
    await act(async () => {
      await press({ target: { x: 100, y: 410 } });
    });
    expect(spies.onDelete).toHaveBeenCalledWith(1);
    await act(async () => {
      await press({ target: { testID: 'login-button' } });
    });
    expect(spies.onLogin).toHaveBeenCalledTimes(1);
  });

  test('the wrapper has no testID and no accessibility props', async () => {
    installAlertTracking();
    const Wrapper = wrapper();
    const renderer = await mount(
      <Wrapper>
        <View testID="app-content" />
      </Wrapper>,
    );
    const view = renderer.root.findAll((node) => typeof node.props.onStartShouldSetResponderCapture === 'function')[0];
    expect(view).toBeDefined();
    const props = view?.props as Record<string, unknown>;
    expect(Object.keys(props).filter((key) => key === 'testID' || key.startsWith('accessib') || key === 'nativeID')).toEqual([]);
  });
});

/** The helpers' frames, plus a full-screen frame for the wrapper (a plain view with the touch capture). */
function useFramesWithWrapperFullScreen(): void {
  setMeasurer(async (fiber) => {
    if (typeof propsOf(fiber).onStartShouldSetResponderCapture === 'function') return frame(0, 0, 400, 800);
    const key = keyOf(fiber);
    if (key !== null && key in SAMPLE_FRAMES) return SAMPLE_FRAMES[key] ?? null;
    return frame(0, 0, 10, 10);
  });
}
