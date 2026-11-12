import { frame, mount, unmountAll, useFrames } from './helpers';
import React, { useState } from 'react';
import { AppRegistry, Dimensions, FlatList, Linking, PixelRatio, Pressable, Text, View } from 'react-native';
import { readFileSync } from 'fs';
import { join } from 'path';
import { act } from 'react-test-renderer';
import { back, configureActions, openURL, press } from '../src/actions';
import { propsOf, type Fiber } from '../src/fiber';
import { collectNodes, resetRefs, setHitTester, setMeasurer, tree } from '../src/inspect';
import { methods } from '../src/methods';
import { move, type MoveResult } from '../src/move';
import { TaplineError } from '../src/types';

// AGENT-TOOLS 1.13 §18.4 (F7): act, then wait until the next target is on screen, steady and touchable.

async function run<T>(fn: () => Promise<T>): Promise<T> {
  let result: T | undefined;
  await act(async () => {
    result = await fn();
  });
  return result as T;
}

async function failure(promise: Promise<unknown>): Promise<TaplineError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TaplineError) return error;
    throw error;
  }
  throw new Error('expected a TaplineError');
}

function hostFiber(testID: string): Fiber {
  const node = collectNodes().find((candidate) => propsOf(candidate.fiber).testID === testID);
  if (!node) throw new Error(`no host with testID ${testID}`);
  return node.fiber;
}


beforeAll(() => configureActions({ quietMs: 0, capMs: 0 }));
beforeEach(() => {
  resetRefs();
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 400, height: 800, scale: 2, fontScale: 1 });
  jest.spyOn(PixelRatio, 'get').mockReturnValue(2);
  jest.spyOn(AppRegistry, 'setWrapperComponentProvider').mockImplementation(() => undefined);
});
afterEach(async () => {
  await unmountAll();
  setMeasurer(null);
  setHitTester(null);
  jest.restoreAllMocks();
});

function Two({ onGo }: { onGo: () => void }) {
  return (
    <View>
      <Pressable testID="go" onPress={onGo}>
        <Text>Go</Text>
      </Pressable>
      <Pressable testID="next" onPress={() => undefined}>
        <Text>Next</Text>
      </Pressable>
    </View>
  );
}

describe('move', () => {
  test('runs the plain method and returns its result unchanged', async () => {
    const onGo = jest.fn();
    await mount(<Two onGo={onGo} />);
    useFrames({ go: frame(20, 100, 200, 40), next: frame(20, 200, 200, 40) });
    const result = await run(() => move({ method: 'press', params: { target: { testID: 'go' } } }));
    expect(onGo).toHaveBeenCalledTimes(1);
    expect(result.done).toMatchObject({ element: { testID: 'go' }, settledMs: 0 });
    expect(result.next).toBeUndefined();
  });

  test('result parity with the plain press on the same fixture', async () => {
    const onGo = jest.fn();
    await mount(<Two onGo={onGo} />);
    useFrames({ go: frame(20, 100, 200, 40), next: frame(20, 200, 200, 40) });
    resetRefs();
    const plain = await run(() => press({ target: { testID: 'go' } }));
    resetRefs();
    const moved = await run(() => move({ method: 'press', params: { target: { testID: 'go' } } }));
    expect(moved.done).toEqual(plain);
  });

  test('next ready: reports the element once it is on screen, steady and touchable', async () => {
    await mount(<Two onGo={() => undefined} />);
    useFrames({ go: frame(20, 100, 200, 40), next: frame(20, 200, 200, 40) });
    const result = await run(() =>
      move({ method: 'press', params: { target: { testID: 'go' } }, next: { target: { testID: 'next' }, capMs: 1000 } }),
    );
    expect(result.next?.state).toBe('ready');
    expect(result.next?.element).toMatchObject({ testID: 'next', frame: { x: 20, y: 200, width: 200, height: 40 } });
    expect(result.next?.waitedMs).toBeLessThan(500);
  });

  test('next appears 300 ms later: waits for it', async () => {
    function App() {
      const [shown, setShown] = useState(false);
      return (
        <View>
          <Pressable testID="go" onPress={() => setTimeout(() => setShown(true), 300)}>
            <Text>Go</Text>
          </Pressable>
          {shown ? (
            <Pressable testID="later" onPress={() => undefined}>
              <Text>Later</Text>
            </Pressable>
          ) : null}
        </View>
      );
    }
    await mount(<App />);
    useFrames({ go: frame(20, 100, 200, 40), later: frame(20, 200, 200, 40) });
    // Outside act, as in a real app: inside it React would hold the timer's update until the act ends.
    const flags = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const before = flags.IS_REACT_ACT_ENVIRONMENT;
    flags.IS_REACT_ACT_ENVIRONMENT = false;
    let result: MoveResult;
    try {
      result = await move({ method: 'press', params: { target: { testID: 'go' } }, next: { target: { testID: 'later' }, capMs: 2000 } });
    } finally {
      flags.IS_REACT_ACT_ENVIRONMENT = before;
    }
    expect(result.next?.state).toBe('ready');
    expect(result.next?.waitedMs).toBeGreaterThanOrEqual(250);
    expect(result.next?.waitedMs).toBeLessThan(1500);
  });

  test('next missing at the cap: state missing, waitedMs near capMs', async () => {
    await mount(<Two onGo={() => undefined} />);
    useFrames({ go: frame(20, 100, 200, 40), next: frame(20, 200, 200, 40) });
    const result = await run(() =>
      move({ method: 'press', params: { target: { testID: 'go' } }, next: { target: { testID: 'never' }, capMs: 250 } }),
    );
    expect(result.next?.state).toBe('missing');
    expect(result.next?.element).toBeUndefined();
    expect(result.next?.waitedMs).toBeGreaterThanOrEqual(240);
    expect(result.next?.waitedMs).toBeLessThanOrEqual(250);
  });

  test('a covered target: state covered, with the element left out', async () => {
    await mount(<Two onGo={() => undefined} />);
    useFrames({ go: frame(20, 100, 200, 40), next: frame(20, 200, 200, 40) });
    setHitTester(async (x, y) => (y >= 200 ? hostFiber('go') : null));
    const result = await run(() =>
      move({ method: 'press', params: { target: { testID: 'go' } }, next: { target: { testID: 'next' }, capMs: 200 } }),
    );
    expect(result.next?.state).toBe('covered');
  });

  test('a moving target (changes frame) waits until it stops', async () => {
    await mount(<Two onGo={() => undefined} />);
    const started = Date.now();
    setMeasurer(async (fiber) => {
      const id = propsOf(fiber).testID;
      if (id === 'next') {
        // Slides for 200 ms, then rests.
        const slid = Math.min(200, Date.now() - started);
        return frame(20 + slid, 200, 200, 40);
      }
      return frame(20, 100, 200, 40);
    });
    const result = await run(() =>
      move({ method: 'press', params: { target: { testID: 'go' } }, next: { target: { testID: 'next' }, capMs: 2000 } }),
    );
    expect(result.next?.state).toBe('ready');
    expect(result.next?.element?.frame?.x).toBe(220);
  });

  test('a target that never stops moving answers moving at the cap, with the element', async () => {
    await mount(<Two onGo={() => undefined} />);
    let x = 0;
    setMeasurer(async (fiber) => (propsOf(fiber).testID === 'next' ? frame((x += 7), 200, 200, 40) : frame(20, 100, 200, 40)));
    const result = await run(() =>
      move({ method: 'press', params: { target: { testID: 'go' } }, next: { target: { testID: 'next' }, capMs: 200 } }),
    );
    expect(result.next?.state).toBe('moving');
    expect(result.next?.element?.testID).toBe('next');
  });

  test('guard mismatch refuses with stale and does nothing', async () => {
    const onGo = jest.fn();
    await mount(<Two onGo={onGo} />);
    useFrames({ go: frame(20, 100, 200, 40), next: frame(20, 200, 200, 40) });
    const error = await failure(run(() => move({ method: 'press', params: { target: { testID: 'go' } }, guard: { id: 'delete-account' } })));
    expect(error.code).toBe('stale');
    expect(onGo).not.toHaveBeenCalled();
    const text = await failure(run(() => move({ method: 'press', params: { target: { testID: 'go' } }, guard: { id: 'go', text: 'Delete' } })));
    expect(text.code).toBe('stale');
    expect(onGo).not.toHaveBeenCalled();
  });

  test('a guard on a long text compares with the text the host saw (cut at the kept-text limit)', async () => {
    const onGo = jest.fn();
    const long = 'x'.repeat(2500);
    await mount(
      <Text testID="long" onPress={onGo}>
        {long}
      </Text>,
    );
    useFrames({ long: frame(20, 100, 200, 40) });
    resetRefs();
    const seen = (await tree({})).elements.find((element) => element.testID === 'long');
    expect(seen?.text.length).toBeLessThan(2500);
    expect(seen?.textMore).toBeGreaterThan(0);
    await run(() => move({ method: 'press', params: { target: { testID: 'long' } }, guard: { text: seen?.text } }));
    expect(onGo).toHaveBeenCalledTimes(1);
    const error = await failure(run(() => move({ method: 'press', params: { target: { testID: 'long' } }, guard: { text: long } })));
    expect(error.code).toBe('stale');
    expect(onGo).toHaveBeenCalledTimes(1);
  });

  test('a target that is not there is the plain method\'s not_found, not a skipped guard', async () => {
    await mount(<Two onGo={() => undefined} />);
    useFrames({ go: frame(20, 100, 200, 40), next: frame(20, 200, 200, 40) });
    const error = await failure(run(() => move({ method: 'press', params: { target: { testID: 'gone' } }, guard: { id: 'gone' } })));
    expect(error.code).toBe('not_found');
  });

  test('a matching guard lets the move through', async () => {
    const onGo = jest.fn();
    await mount(<Two onGo={onGo} />);
    useFrames({ go: frame(20, 100, 200, 40), next: frame(20, 200, 200, 40) });
    await run(() => move({ method: 'press', params: { target: { testID: 'go' } }, guard: { id: 'go', text: 'Go' } }));
    expect(onGo).toHaveBeenCalledTimes(1);
  });

  test('dryRun passes through: nothing is pressed and nothing is waited for', async () => {
    const onGo = jest.fn();
    await mount(<Two onGo={onGo} />);
    useFrames({ go: frame(20, 100, 200, 40), next: frame(20, 200, 200, 40) });
    const result = await run(() =>
      move({ method: 'press', params: { target: { testID: 'go' }, dryRun: true }, next: { target: { testID: 'never' }, capMs: 5000 } }),
    );
    expect(onGo).not.toHaveBeenCalled();
    expect(result.done).toMatchObject({ dryRun: true });
    expect(result.next).toBeUndefined();
  });

  test('never calls navigate() or goBack() itself', async () => {
    const navigate = jest.fn();
    const goBack = jest.fn();
    const nav = { isFocused: () => true, canGoBack: () => true, goBack, navigate, getState: () => ({ routes: [] }) };
    function Screen({ children }: { route: { key: string; name: string }; navigation: typeof nav; children?: React.ReactNode }) {
      return <View>{children}</View>;
    }
    await mount(
      <Screen route={{ key: 'a-1', name: 'a' }} navigation={nav}>
        <Two onGo={() => undefined} />
      </Screen>,
    );
    useFrames({ go: frame(20, 100, 200, 40), next: frame(20, 200, 200, 40) });
    const result = await run(() =>
      move({ method: 'press', params: { target: { testID: 'go' } }, next: { target: { testID: 'next' }, capMs: 500 } }),
    );
    expect(result.place).toEqual({ route: ['a'] });
    expect(navigate).not.toHaveBeenCalled();
    expect(goBack).not.toHaveBeenCalled();
  });

  test('the result names the place after the move', async () => {
    await mount(<Two onGo={() => undefined} />);
    useFrames({ go: frame(20, 100, 200, 40), next: frame(20, 200, 200, 40) });
    const result: MoveResult = await run(() => move({ method: 'press', params: { target: { testID: 'go' } } }));
    expect(result.place).toEqual({ route: [] });
  });

  test('a switch as the next target is touchable by a toggle', async () => {
    const { Switch } = jest.requireActual<typeof import('react-native')>('react-native');
    await mount(
      <View>
        <Pressable testID="go" onPress={() => undefined}>
          <Text>Go</Text>
        </Pressable>
        <Switch testID="remind" value={false} onValueChange={() => undefined} />
      </View>,
    );
    useFrames({ go: frame(20, 100, 200, 40), remind: frame(20, 200, 60, 30) });
    const result = await run(() =>
      move({ method: 'press', params: { target: { testID: 'go' } }, next: { target: { testID: 'remind' }, capMs: 500 } }),
    );
    expect(result.next?.state).toBe('ready');
  });

  test('result parity with the plain back and openURL', async () => {
    const goBack = jest.fn();
    const nav = { isFocused: () => true, canGoBack: () => true, goBack, navigate: jest.fn(), getState: () => ({ routes: [] }) };
    function Screen({ children }: { route: { key: string; name: string }; navigation: typeof nav; children?: React.ReactNode }) {
      return <View>{children}</View>;
    }
    await mount(
      <Screen route={{ key: 'a-1', name: 'a' }} navigation={nav}>
        <Text>A</Text>
      </Screen>,
    );
    const plainBack = await run(() => back({}));
    const movedBack = await run(() => move({ method: 'back', params: {} }));
    expect(movedBack.done).toEqual(plainBack);
    expect(goBack).toHaveBeenCalledTimes(2);

    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    const plainOpen = await run(() => openURL({ url: 'myapp://settings' }));
    const movedOpen = await run(() => move({ method: 'openURL', params: { url: 'myapp://settings' } }));
    expect(movedOpen.done).toEqual(plainOpen);
    expect(open).toHaveBeenCalledTimes(2);
  });

  test('move.ts and place.ts never navigate by themselves (a source scan)', () => {
    for (const file of ['move.ts', 'place.ts']) {
      const source = readFileSync(join(__dirname, '..', 'src', file), 'utf8');
      expect(source).not.toMatch(/navigate\(/);
      expect(source).not.toMatch(/goBack\(/);
    }
  });

  test('bad shapes are bad_params', async () => {
    expect((await failure(move({ method: 'press', params: {}, guard: {} }))).code).toBe('bad_params');
    expect((await failure(move({ method: 'teleport', params: {} }))).code).toBe('bad_params');
    expect((await failure(move({ method: 'press', params: {}, next: { target: { testID: 'a' }, capMs: -1 } }))).code).toBe('bad_params');
    expect((await failure(move({ method: 'press', params: {}, next: { target: {}, capMs: 100 } }))).code).toBe('bad_params');
    expect((await failure(move({ method: 'press', params: {}, guard: { id: 5 } }))).code).toBe('bad_params');
    expect((await failure(move('press'))).code).toBe('bad_params');
  });

  test('the move request is in the method table, with place and places', () => {
    expect(Object.keys(methods)).toEqual(expect.arrayContaining(['move', 'place', 'places']));
  });
});

describe('tree.place and row', () => {
  test('tree carries the place and flags a virtualized list item as a row', async () => {
    function Screen({ children }: { route: { key: string; name: string }; navigation: unknown; children?: React.ReactNode }) {
      return <View>{children}</View>;
    }
    const nav = { isFocused: () => true, canGoBack: () => false, goBack: () => undefined, navigate: () => undefined, getState: () => ({ routes: [] }) };
    await mount(
      <Screen route={{ key: 'trips-1', name: 'trips' }} navigation={nav}>
        <Text testID="heading">Trips</Text>
        <FlatList
          data={[{ id: 'a', title: 'Chat with Sara' }, { id: 'b', title: 'Order #10432' }]}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <Text testID={`row-${item.id}`}>{item.title}</Text>}
        />
      </Screen>,
    );
    useFrames({});
    const result = await tree({});
    expect(result.place).toEqual({ route: ['trips'] });
    const byId = (id: string) => result.elements.find((element) => element.testID === id);
    expect(byId('heading')).toBeDefined();
    expect(byId('heading')?.row).toBeUndefined();
    expect(byId('row-a')?.row).toBe(true);
    expect(byId('row-b')?.row).toBe(true);
  });
});

