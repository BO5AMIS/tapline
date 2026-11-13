import { mount, unmountAll, useFrames } from './helpers';
import React from 'react';
import { ActivityIndicator, Dimensions, PixelRatio, Pressable, Text, View } from 'react-native';
import { act } from 'react-test-renderer';
import { configureActions, press } from '../src/actions';
import { resetRefs, setMeasurer } from '../src/inspect';
import { waitWhileLoading } from '../src/loading';
import { installNetworkTracking, startedRequests, uninstallNetworkTracking } from '../src/network';
import { TaplineError } from '../src/types';

// AGENT-TOOLS 1.13 §18.7 (F7): while a request the action started is in flight, or an ActivityIndicator is showing, a target that
// isn't there yet keeps being waited for, up to the settle cap, before it answers `not_found`.

type Fetch = (input: unknown, init?: unknown) => Promise<unknown>;
const okResponse = { status: 200, headers: { get: () => null } };
const later = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function makeNet(): { net: { XMLHttpRequest: unknown; fetch: Fetch }; release: () => void } {
  let release: () => void = () => {};
  const net = {
    XMLHttpRequest: class {
      open(): void {}
      send(): void {}
      abort(): void {}
    },
    fetch: ((): Promise<unknown> =>
      new Promise((resolve) => {
        release = () => resolve(okResponse);
      })) as Fetch,
  };
  return { net, release: () => release() };
}

function Screen({ ready, spinner = false, animating = true }: { ready: boolean; spinner?: boolean; animating?: boolean }) {
  return (
    <View>
      {spinner ? <ActivityIndicator animating={animating} /> : null}
      <Pressable testID="open-trip" onPress={onOpen}>
        <Text>Open trip</Text>
      </Pressable>
      {ready ? (
        <Pressable testID="trip-1" onPress={onTrip}>
          <Text>Paris trip</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
const onOpen = jest.fn();
const onTrip = jest.fn();

async function failure(promise: Promise<unknown>): Promise<TaplineError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TaplineError) return error;
    throw error;
  }
  throw new Error('expected a TaplineError');
}

beforeEach(() => {
  resetRefs();
  onOpen.mockReset();
  onTrip.mockReset();
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 400, height: 800, scale: 2, fontScale: 1 });
  jest.spyOn(PixelRatio, 'get').mockReturnValue(2);
});

afterEach(async () => {
  uninstallNetworkTracking();
  configureActions({ quietMs: 0, capMs: 0 });
  await unmountAll();
  setMeasurer(null);
  jest.restoreAllMocks();
});

describe('a missing target while loading', () => {
  test('with a request in flight it waits and then finds the target', async () => {
    const renderer = await mount(<Screen ready={false} />);
    useFrames({});
    const { net, release } = makeNet();
    installNetworkTracking({ target: net });
    configureActions({ quietMs: 0, capMs: 2000 });
    void net.fetch('https://api.example.com/trips');
    const started = Date.now();
    const pressing = press({ target: { text: 'Paris trip' } });
    await later(150);
    await act(async () => {
      release();
      renderer.update(<Screen ready />);
    });
    await pressing;
    expect(onTrip).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  test('an ActivityIndicator showing keeps the wait going until the target comes', async () => {
    const renderer = await mount(<Screen ready={false} spinner />);
    useFrames({});
    configureActions({ quietMs: 0, capMs: 2000 });
    const pressing = press({ target: { testID: 'trip-1' } });
    await later(150);
    await act(async () => {
      renderer.update(<Screen ready />);
    });
    await pressing;
    expect(onTrip).toHaveBeenCalledTimes(1);
  });

  test('a stopped ActivityIndicator is not loading: not_found at once', async () => {
    await mount(<Screen ready={false} spinner animating={false} />);
    useFrames({});
    configureActions({ quietMs: 0, capMs: 2000 });
    const started = Date.now();
    const error = await failure(press({ target: { testID: 'trip-1' } }));
    expect(error.code).toBe('not_found');
    expect(Date.now() - started).toBeLessThan(400);
  });

  test('a really missing target still answers not_found after the cap', async () => {
    await mount(<Screen ready={false} spinner />);
    useFrames({});
    configureActions({ quietMs: 0, capMs: 400 });
    const { net } = makeNet();
    installNetworkTracking({ target: net });
    void net.fetch('https://api.example.com/never');
    const started = Date.now();
    const error = await failure(press({ target: { text: 'Paris trip' } }));
    const took = Date.now() - started;
    expect(error.code).toBe('not_found');
    expect(took).toBeGreaterThanOrEqual(380);
    expect(took).toBeLessThan(1500);
  });

  test('nothing loading: not_found at once, with no wait', async () => {
    await mount(<Screen ready={false} />);
    useFrames({});
    configureActions({ quietMs: 0, capMs: 2000 });
    const started = Date.now();
    const error = await failure(press({ target: { text: 'Paris trip' } }));
    expect(error.code).toBe('not_found');
    expect(Date.now() - started).toBeLessThan(400);
  });

  test('without a settle cap nothing waits', async () => {
    await mount(<Screen ready={false} spinner />);
    useFrames({});
    configureActions({ quietMs: 0, capMs: 0 });
    const started = Date.now();
    const error = await failure(press({ target: { text: 'Paris trip' } }));
    expect(error.code).toBe('not_found');
    expect(Date.now() - started).toBeLessThan(400);
  });

  test('closest matches are unchanged by the wait', async () => {
    await mount(<Screen ready={false} spinner />);
    useFrames({});
    configureActions({ quietMs: 0, capMs: 300 });
    const waited = await failure(press({ target: { testID: 'open-trp' } }));
    configureActions({ quietMs: 0, capMs: 0 });
    const direct = await failure(press({ target: { testID: 'open-trp' } }));
    expect(waited.message).toContain('Closest:');
    expect(waited.message).toBe(direct.message);
  });

  test('a ref or a point is never waited for', async () => {
    await mount(<Screen ready={false} spinner />);
    useFrames({});
    configureActions({ quietMs: 0, capMs: 2000 });
    const started = Date.now();
    const error = await failure(press({ target: { ref: 'e999' } }));
    expect(error.code).toBe('not_found');
    expect(Date.now() - started).toBeLessThan(400);
  });
});

describe('waitWhileLoading', () => {
  test('answers at once, found false, when nothing is loading and no request began', async () => {
    const isThere = jest.fn(async () => false);
    const result = await waitWhileLoading({ requestMark: startedRequests(), capMs: 1000, isThere });
    expect(result).toEqual({ waitedMs: expect.any(Number), found: false });
    expect(result.waitedMs).toBeLessThan(50);
  });

  test('a request that began since the mark and already ended gets a short grace for the commit', async () => {
    const { net, release } = makeNet();
    installNetworkTracking({ target: net });
    const mark = startedRequests();
    const pending = net.fetch('https://api.example.com/quick');
    release();
    await pending;
    let there = false;
    setTimeout(() => {
      there = true;
    }, 60);
    const result = await waitWhileLoading({ requestMark: mark, capMs: 1000, isThere: async () => there });
    expect(result.found).toBe(true);
  });

  test('stops at the cap while a request stays open', async () => {
    const { net } = makeNet();
    installNetworkTracking({ target: net });
    void net.fetch('https://api.example.com/never');
    const result = await waitWhileLoading({ requestMark: startedRequests(), capMs: 200, isThere: async () => false });
    expect(result.found).toBe(false);
    expect(result.waitedMs).toBeGreaterThanOrEqual(190);
    expect(result.waitedMs).toBeLessThan(600);
  });
});
