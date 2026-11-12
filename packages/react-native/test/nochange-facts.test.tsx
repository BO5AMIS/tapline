import { frame, mount, unmountAll, useFrames } from './helpers';
import React from 'react';
import { Dimensions, PixelRatio, Pressable, Text, View } from 'react-native';
import { act } from 'react-test-renderer';
import { configureActions, longPress, press } from '../src/actions';
import { forgetLastTree, resetRefs, setHitTester, setMeasurer } from '../src/inspect';
import { installNetworkTracking, startedRequests, uninstallNetworkTracking } from '../src/network';

// What a tap that changes nothing needs from the app (AGENT-TOOLS 1.13 §3): whose handler took the
// touch, whether it threw, and how many requests began during the action.

async function run<T>(fn: () => Promise<T>): Promise<T> {
  let result: T | undefined;
  await act(async () => {
    result = await fn();
  });
  return result as T;
}

beforeAll(() => configureActions({ quietMs: 0, capMs: 0 }));

beforeEach(() => {
  resetRefs();
  forgetLastTree();
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 400, height: 800, scale: 2, fontScale: 1 });
  jest.spyOn(PixelRatio, 'get').mockReturnValue(2);
});

afterEach(async () => {
  await unmountAll();
  setMeasurer(null);
  setHitTester(null);
  jest.restoreAllMocks();
});

describe('press reports who handled it', () => {
  test('press reports handler own when the element has its own onPress', async () => {
    const onPress = jest.fn();
    await mount(
      <Pressable testID="save" onPress={onPress}>
        <Text>Save</Text>
      </Pressable>,
    );
    useFrames({ save: frame(0, 100, 400, 50) });
    const result = await run(() => press({ target: { testID: 'save' } }));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(result.handler).toEqual({ kind: 'own' });
    expect(result.startedRequests).toBe(0);
  });

  test('a label inside a pressable card reports handler parent with the card', async () => {
    const onPress = jest.fn();
    await mount(
      <Pressable testID="card" onPress={onPress}>
        <Text testID="title">Card title</Text>
      </Pressable>,
    );
    useFrames({ card: frame(0, 100, 400, 80), title: frame(10, 110, 200, 20) });
    const result = await run(() => press({ target: { testID: 'title' } }));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(result.handler).toMatchObject({ kind: 'parent', element: { testID: 'card' } });
  });

  test('longPress reports the same facts', async () => {
    const onLongPress = jest.fn();
    await mount(
      <Pressable testID="row" onLongPress={onLongPress}>
        <Text>Row</Text>
      </Pressable>,
    );
    useFrames({ row: frame(0, 100, 400, 50) });
    const result = await run(() => longPress({ target: { testID: 'row' } }));
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(result.handler).toEqual({ kind: 'own' });
  });

  test('a thrown onPress is reported and the action still settles', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await mount(
      <Pressable
        testID="boom"
        onPress={() => {
          throw new Error('nothing to save');
        }}
      >
        <Text>Boom</Text>
      </Pressable>,
    );
    useFrames({ boom: frame(0, 100, 400, 50) });
    const result = await run(() => press({ target: { testID: 'boom' } }));
    expect(result.handler).toEqual({ kind: 'own', threw: 'nothing to save' });
    expect(typeof result.settledMs).toBe('number');
  });

  test('a thrown onPress is written to the logs', async () => {
    const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await mount(
      <Pressable
        testID="boom"
        onPress={() => {
          throw new Error('nothing to save');
        }}
      >
        <Text>Boom</Text>
      </Pressable>,
    );
    useFrames({ boom: frame(0, 100, 400, 50) });
    await run(() => press({ target: { testID: 'boom' } }));
    expect(logged.mock.calls.some((call) => String(call[0]).includes('onPress threw'))).toBe(true);
  });

  test('a non-error throw is reported as text', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await mount(
      <Pressable
        testID="boom"
        onPress={() => {
          // eslint-disable-next-line no-throw-literal
          throw 'plain string';
        }}
      >
        <Text>Boom</Text>
      </Pressable>,
    );
    useFrames({ boom: frame(0, 100, 400, 50) });
    const result = await run(() => press({ target: { testID: 'boom' } }));
    expect(result.handler).toEqual({ kind: 'own', threw: 'plain string' });
  });

  test('a dry run reports no handler facts', async () => {
    await mount(
      <Pressable testID="save" onPress={() => undefined}>
        <Text>Save</Text>
      </Pressable>,
    );
    useFrames({ save: frame(0, 100, 400, 50) });
    const result = await run(() => press({ target: { testID: 'save' }, dryRun: true }));
    expect(result.handler).toBeUndefined();
    expect(result.startedRequests).toBeUndefined();
  });
});

describe('press counts the requests it started', () => {
  class FakeXhr {
    open(): void {}
    send(): void {}
    abort(): void {}
  }
  // A stand-in global: Tapline wraps this one's fetch, and the handler calls it.
  const target: { XMLHttpRequest: unknown; fetch: (url: string) => Promise<unknown> } = {
    XMLHttpRequest: FakeXhr,
    fetch: () => new Promise(() => undefined),
  };

  beforeEach(() => {
    installNetworkTracking({ target: target as unknown as { XMLHttpRequest?: unknown } });
    startedRequests();
  });

  afterEach(() => {
    uninstallNetworkTracking();
  });

  test('a handler that starts a request reports startedRequests 1', async () => {
    await mount(
      <Pressable
        testID="load"
        onPress={() => {
          void target.fetch('https://api.example.com/items');
        }}
      >
        <Text>Load</Text>
      </Pressable>,
    );
    useFrames({ load: frame(0, 100, 400, 50) });
    const result = await run(() => press({ target: { testID: 'load' } }));
    expect(result.startedRequests).toBe(1);
  });

  test('requests that began before the tap are not counted', async () => {
    await mount(
      <View>
        <Pressable testID="noop" onPress={() => undefined}>
          <Text>Noop</Text>
        </Pressable>
      </View>,
    );
    void target.fetch('https://api.example.com/earlier');
    useFrames({ noop: frame(0, 100, 400, 50) });
    const result = await run(() => press({ target: { testID: 'noop' } }));
    expect(result.startedRequests).toBe(0);
  });
});

describe('an input with no onPress of its own', () => {
  test('is only focused: press reports no handler', async () => {
    const { TextInput } = jest.requireActual('react-native') as typeof import('react-native');
    await mount(<TextInput testID="field" />);
    useFrames({ field: frame(0, 100, 400, 50) });
    const result = await run(() => press({ target: { testID: 'field' } }));
    expect(result.handler).toBeUndefined();
  });
});
