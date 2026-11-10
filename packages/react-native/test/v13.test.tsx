import { frame, mount, unmountAll, useFrames } from './helpers';
import React from 'react';
import { Dimensions, PixelRatio, Pressable, Text, TextInput, View } from 'react-native';
import { act } from 'react-test-renderer';
import { configureActions, press, resolveTarget, settleOutcome, typeText } from '../src/actions';
import { collectNodes, resetRefs, setHitTester, setMeasurer, tree } from '../src/inspect';
import { isRecord, TaplineError, type TaplineElement } from '../src/types';
import type { Fiber } from '../src/fiber';

// The home-indicator inset the app's safe-area library reports (an optional peer, not installed here).
jest.mock(
  'react-native-safe-area-context',
  () => ({ initialWindowMetrics: { insets: { top: 47, bottom: 34, left: 0, right: 0 }, frame: { x: 0, y: 0, width: 400, height: 800 } } }),
  { virtual: true },
);

// AGENT-TOOLS v1.3 in the SDK: duplicates, direction marks, input taps, the visible part, the cap, ambiguous.

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

function hostNode(testID: string): { fiber: Fiber } {
  const node = collectNodes().find((candidate) => {
    const props = candidate.fiber.memoizedProps;
    return isRecord(props) && props.testID === testID;
  });
  if (!node) throw new Error(`no host for ${testID}`);
  return node;
}

function byTestID(elements: TaplineElement[], testID: string): TaplineElement | undefined {
  return elements.find((element) => element.testID === testID);
}

beforeAll(() => configureActions({ quietMs: 0, capMs: 0 }));

beforeEach(() => {
  resetRefs();
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 400, height: 800, scale: 2, fontScale: 1 });
  jest.spyOn(PixelRatio, 'get').mockReturnValue(2);
});

afterEach(async () => {
  await unmountAll();
  setMeasurer(null);
  setHitTester(null);
  jest.restoreAllMocks();
});

describe('duplicates fold', () => {
  const same = frame(20, 100, 300, 44);

  test('a labelled wrapper around an input lists only the input, with a stable ref', async () => {
    await mount(
      <View testID="wrap" accessible accessibilityLabel="Email">
        <TextInput testID="email" accessibilityLabel="Email" />
      </View>,
    );
    useFrames({ wrap: same, email: { ...same, y: same.y + 0.5 } });
    const first = await tree({});
    expect(byTestID(first.elements, 'wrap')).toBeUndefined();
    const input = byTestID(first.elements, 'email');
    expect(input?.actions).toEqual(['press', 'type', 'submit']);
    const second = await tree({ changes: true });
    expect(byTestID(second.elements, 'email')?.ref).toBe(input?.ref);
  });

  test('neither acts: the ancestor stays', async () => {
    await mount(
      <View testID="outer" accessibilityLabel="Card">
        <View testID="inner" accessibilityLabel="Card" />
      </View>,
    );
    useFrames({ outer: same, inner: same });
    const { elements } = await tree({});
    expect(byTestID(elements, 'outer')).toBeDefined();
    expect(byTestID(elements, 'inner')).toBeUndefined();
  });

  test('both act: the ancestor stays', async () => {
    await mount(
      <Pressable testID="outer" accessibilityLabel="Go" onPress={() => undefined}>
        <Pressable testID="inner" accessibilityLabel="Go" onPress={() => undefined} />
      </Pressable>,
    );
    useFrames({ outer: same, inner: same });
    const { elements } = await tree({});
    expect(byTestID(elements, 'outer')).toBeDefined();
    expect(byTestID(elements, 'inner')).toBeUndefined();
  });

  test('the one that acts stays even when it is the ancestor of nothing acting', async () => {
    await mount(
      <View testID="outer" accessibilityLabel="Go">
        <Pressable testID="inner" accessibilityLabel="Go" onPress={() => undefined} />
      </View>,
    );
    useFrames({ outer: same, inner: same });
    const { elements } = await tree({});
    expect(byTestID(elements, 'outer')).toBeUndefined();
    expect(byTestID(elements, 'inner')).toBeDefined();
  });

  test('a different rect (more than 1 pt) or different text lists both', async () => {
    await mount(
      <View>
        <View testID="a" accessibilityLabel="Card">
          <View testID="b" accessibilityLabel="Card" />
        </View>
        <View testID="c" accessibilityLabel="Other">
          <View testID="d" accessibilityLabel="Another" />
        </View>
      </View>,
    );
    useFrames({ a: same, b: { ...same, width: same.width - 3 }, c: same, d: same });
    const { elements } = await tree({});
    for (const id of ['a', 'b', 'c', 'd']) expect(byTestID(elements, id)).toBeDefined();
  });
});

describe('invisible direction marks', () => {
  test('are removed from text, label and value, and from the agent target', async () => {
    await mount(
      <View>
        <Pressable testID="go" accessibilityLabel={'‏Start‎'} onPress={() => undefined}>
          <Text>{'⁦Start⁩ ‪day‬'}</Text>
        </Pressable>
        <TextInput testID="field" value={'‎abc‏'} onChangeText={() => undefined} />
      </View>,
    );
    useFrames({ go: frame(0, 0, 100, 40), field: frame(0, 50, 100, 40) });
    const { elements } = await tree({});
    const go = byTestID(elements, 'go');
    expect(go?.text).toBe('Start day');
    expect(go?.label).toBe('Start');
    expect(byTestID(elements, 'field')?.value).toBe('abc');
    for (const target of [{ text: '‎Start day' }, { text: 'start⁦ day' }, { label: '‏Start' }]) {
      const { entry } = await resolveTarget(target);
      expect(entry.info.testID).toBe('go');
    }
  });

  test('typing into a field with marks keeps the real value but reports it clean', async () => {
    await mount(<TextInput testID="field" value={'‎abc'} onChangeText={() => undefined} />);
    useFrames({ field: frame(0, 0, 100, 40) });
    const result = await run(() => typeText({ target: { testID: 'field' }, text: 'x', replace: false }));
    expect(result.value).toBe('abcx');
  });
});

describe('a tap on an input', () => {
  test('lists tap then type', async () => {
    await mount(<TextInput testID="field" />);
    useFrames({ field: frame(0, 0, 100, 40) });
    const { elements } = await tree({});
    expect(byTestID(elements, 'field')?.actions).toEqual(['press', 'type', 'submit']);
  });

  test('focuses the native input through its host instance', async () => {
    await mount(<TextInput testID="field" />);
    useFrames({ field: frame(0, 0, 100, 40) });
    const focus = jest.fn();
    const state = hostNode('field').fiber.stateNode;
    if (!isRecord(state)) throw new Error('no host instance');
    state.focus = focus;
    const result = await run(() => press({ target: { testID: 'field' } }));
    expect(focus).toHaveBeenCalledTimes(1);
    expect(result.element.testID).toBe('field');
  });

  test('focuses through the Fabric canonical instance too', async () => {
    await mount(<TextInput testID="field" />);
    useFrames({ field: frame(0, 0, 100, 40) });
    const focus = jest.fn();
    const state = hostNode('field').fiber.stateNode;
    if (!isRecord(state)) throw new Error('no host instance');
    const previous = state.canonical;
    state.canonical = { focus };
    try {
      await run(() => press({ target: { testID: 'field' } }));
      expect(focus).toHaveBeenCalledTimes(1);
    } finally {
      state.canonical = previous;
    }
  });

  test('without a way to focus it falls back to onPressIn / onFocus and never answers no_action', async () => {
    const onPressIn = jest.fn();
    const onFocus = jest.fn();
    // A bare host input: no public instance with focus() and no TextInput component above it.
    await mount(React.createElement('TextInput', { testID: 'field', onPressIn, onFocus }));
    useFrames({ field: frame(0, 0, 100, 40) });
    const input = TextInput as unknown as { State?: unknown };
    const original = input.State;
    input.State = {};
    try {
      await run(() => press({ target: { testID: 'field' } }));
    } finally {
      input.State = original;
    }
    expect(onPressIn).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  test('a tap with nothing to call still succeeds', async () => {
    await mount(<TextInput testID="field" />);
    useFrames({ field: frame(0, 0, 100, 40) });
    await expect(run(() => press({ target: { testID: 'field' } }))).resolves.toBeDefined();
  });
});

describe('touch the visible part', () => {
  // The screen is 400x800: the tab bar is y 717 to 800 (49 pt above the 34 pt inset).
  async function mountTabsOver(content: React.ReactNode): Promise<void> {
    await mount(
      <View>
        {React.createElement(
          'RNSTabsHostIOS',
          null,
          React.createElement('RNSTabsScreenIOS', { title: 'Today', screenKey: 'today-a', pointerEvents: 'box-none' }, content),
          React.createElement('RNSTabsScreenIOS', { title: 'Steps', screenKey: 'steps-b', pointerEvents: 'none' }),
        )}
      </View>,
    );
  }

  test('a card mostly under the tab bar is touched at the centre of what shows', async () => {
    const onCard = jest.fn();
    await mountTabsOver(
      <Pressable testID="card" onPress={onCard}>
        <Text>Card</Text>
      </Pressable>,
    );
    useFrames({ card: frame(0, 700, 400, 90) }); // y 700 to 790; visible 700 to 717
    const asked: Array<[number, number]> = [];
    setHitTester(async (x, y) => {
      asked.push([x, y]);
      return hostNode('card').fiber;
    });
    await run(() => press({ target: { testID: 'card' } }));
    expect(asked).toEqual([[200, 709]]);
    expect(onCard).toHaveBeenCalledTimes(1);
  });

  test('less than 10 pt showing is refused as under_tab_bar, as before', async () => {
    const onCard = jest.fn();
    await mountTabsOver(
      <Pressable testID="card" onPress={onCard}>
        <Text>Card</Text>
      </Pressable>,
    );
    useFrames({ card: frame(0, 709, 400, 80) }); // 8 pt above the bar
    const error = await failure(press({ target: { testID: 'card' } }));
    expect(error.message).toMatch(/^under_tab_bar: /);
    expect(onCard).not.toHaveBeenCalled();
    await run(() => press({ target: { testID: 'card' }, force: true }));
    expect(onCard).toHaveBeenCalledTimes(1);
  });

  test('a cover over the middle is cut away and the strip that is left is touched', async () => {
    const onSave = jest.fn();
    await mount(
      <View>
        <Pressable testID="save" onPress={onSave}>
          <Text>Save</Text>
        </Pressable>
        <View testID="toast" />
      </View>,
    );
    // The toast covers the lower part of the button: y 120 to 160. The upper strip, y 100 to 120, remains.
    useFrames({ save: frame(0, 100, 200, 60), toast: frame(0, 120, 200, 60) });
    const asked: Array<[number, number]> = [];
    setHitTester(async (x, y) => {
      asked.push([x, y]);
      return y >= 120 ? hostNode('toast').fiber : hostNode('save').fiber;
    });
    await run(() => press({ target: { testID: 'save' } }));
    expect(asked).toEqual([
      [100, 130],
      [100, 110],
    ]);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  test('a cover that leaves less than 10 pt still refuses as covered', async () => {
    const onSave = jest.fn();
    await mount(
      <View>
        <Pressable testID="save" onPress={onSave}>
          <Text>Save</Text>
        </Pressable>
        <View testID="toast" />
      </View>,
    );
    useFrames({ save: frame(0, 100, 200, 60), toast: frame(0, 105, 200, 80) });
    setHitTester(async (_x, y) => (y >= 105 ? hostNode('toast').fiber : hostNode('save').fiber));
    const error = await failure(press({ target: { testID: 'save' } }));
    expect(error.message).toMatch(/^covered: /);
    expect(onSave).not.toHaveBeenCalled();
  });
});

/** Re-renders every 10 ms, so the app never goes quiet. */
function Ticker(): React.ReactElement {
  const [n, setN] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setN((value) => value + 1), 10);
    return () => clearInterval(id);
  }, []);
  return <Text>{n}</Text>;
}

describe('the settle cap', () => {
  afterEach(() => configureActions({ quietMs: 0, capMs: 0 }));

  test('a screen that keeps changing ends at the cap and says so', async () => {
    configureActions({ quietMs: 50, capMs: 120 });
    await mount(<Ticker />);
    const outcome = await settleOutcome();
    expect(outcome.settleCapMs).toBe(120);
    // A timer may fire a millisecond early against Date.now().
    expect(outcome.settledMs).toBeGreaterThanOrEqual(118);
    expect(outcome.settledMs).toBeLessThanOrEqual(120);
  });

  test('a quiet screen leaves the field out', async () => {
    configureActions({ quietMs: 20, capMs: 500 });
    await mount(<Text>still</Text>);
    const outcome = await settleOutcome();
    expect(outcome).not.toHaveProperty('settleCapMs');
    expect(outcome.settledMs).toBeLessThan(500);
  });

  test('an action carries it in its result, next to settledMs', async () => {
    configureActions({ quietMs: 50, capMs: 120 });
    await mount(
      <View>
        <Ticker />
        <Pressable testID="go" onPress={() => undefined}>
          <Text>Go</Text>
        </Pressable>
      </View>,
    );
    useFrames({ go: frame(0, 0, 100, 40) });
    const result = await press({ target: { testID: 'go' } });
    expect(result).toMatchObject({ settledMs: 120, settleCapMs: 120 });
  });
});

describe('ambiguous wording', () => {
  test('names the count and the target, with no inline list and a full stop', async () => {
    await mount(
      <View>
        <Text testID="one">Nutrition</Text>
        <Pressable onPress={() => undefined}>
          <Text>Nutrition</Text>
        </Pressable>
        <Text testID="three">Nutrition</Text>
      </View>,
    );
    useFrames({});
    const error = await failure(resolveTarget({ text: 'Nutrition' }));
    expect(error.code).toBe('ambiguous');
    expect(error.message).toMatch(/^\d+ elements match text "Nutrition"\.$/);
    expect((error.refs ?? []).length).toBeGreaterThan(1);
    expect((error.candidates ?? []).length).toBeGreaterThan(1);
  });

  test('typing without a target and several inputs has the same form', async () => {
    await mount(
      <View>
        <TextInput testID="a" />
        <TextInput testID="b" />
      </View>,
    );
    useFrames({});
    const error = await failure(typeText({ text: 'x' }));
    expect(error.code).toBe('ambiguous');
    expect(error.message).toBe('2 inputs on screen; pass a target to pick one:');
  });
});
