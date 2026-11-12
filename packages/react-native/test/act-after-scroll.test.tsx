import { mount, unmountAll } from './helpers';
import React from 'react';
import { Alert, Dimensions, PixelRatio, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { act } from 'react-test-renderer';
import { configureActions, longPress, press, toggle, typeText } from '../src/actions';
import { propsOf, type Fiber } from '../src/fiber';
import { collectNodes, forgetLastTree, resetRefs, setHitTester, setMeasurer } from '../src/inspect';
import { installAlertTracking, uninstallAlertTracking } from '../src/alerts';
import { isRecord, TaplineError, type Frame } from '../src/types';

// AGENT-TOOLS 1.12 §16.2: tap, long_press, toggle and type_text on an element that is in the tree but off
// screen scroll it into view first and then act, in one call. A small world as in scroll-to-target: the
// list has an offset, `scrollTo` changes it, the measurer answers from it.

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

function nodeWithId(testID: string): { fiber: Fiber } {
  const node = collectNodes().find((candidate) => {
    const props = candidate.fiber.memoizedProps;
    return isRecord(props) && props.testID === testID;
  });
  if (!node) throw new Error(`no node for ${testID}`);
  return node;
}

function nearestId(fiber: Fiber): { id: string; own: boolean } | null {
  for (let up: Fiber | null = fiber; up; up = up.return) {
    if (up.tag !== 5) continue;
    const id = propsOf(up).testID;
    if (typeof id === 'string') return { id, own: up === fiber };
  }
  return null;
}

const LIST_FRAME: Frame = { x: 0, y: 0, width: 400, height: 800 };

interface World {
  offset: number;
  contentHeight: number;
  calls: number[];
  /** Content positions (y) of the elements in the list, by testID. */
  at: Record<string, number>;
}

let world: World;
const onRow = jest.fn();
const onLong = jest.fn();
const onText = jest.fn();
const onSwitch = jest.fn();

async function mountWorld(overrides: Partial<World> = {}, outsideAt?: number): Promise<void> {
  world = { offset: 0, contentHeight: 4000, calls: [], at: { 'row-20': 2000, 'field': 2200, 'sw': 2400, 'row-far': 5000 }, ...overrides };
  await mount(
    <View>
      <ScrollView testID="list">
        <Pressable testID="row-20" onPress={onRow} onLongPress={onLong}>
          <Text>Row 20</Text>
        </Pressable>
        <TextInput testID="field" onChangeText={onText} />
        <Switch testID="sw" value={false} onValueChange={onSwitch} />
        <Pressable testID="row-far" onPress={onRow}>
          <Text>Row far</Text>
        </Pressable>
      </ScrollView>
      <Pressable testID="outside" onPress={onRow}>
        <Text>Outside</Text>
      </Pressable>
    </View>,
  );
  const list = nodeWithId('list').fiber.stateNode;
  if (!isRecord(list)) throw new Error('no list instance');
  list.scrollTo = (arg: Record<string, unknown>) => {
    const y = Math.min(Math.max(0, Number(arg.y)), Math.max(0, world.contentHeight - LIST_FRAME.height));
    world.offset = y;
    world.calls.push(Number(arg.y));
  };
  setMeasurer(async (fiber) => {
    const found = nearestId(fiber);
    if (!found) return null;
    if (found.id === 'outside') return { x: 0, y: outsideAt ?? 900, width: 400, height: 40 };
    if (found.id === 'list') return found.own ? LIST_FRAME : { x: 0, y: -world.offset, width: 400, height: world.contentHeight };
    const y = world.at[found.id];
    if (y === undefined) return null;
    return { x: 0, y: y - world.offset, width: 400, height: found.id === 'sw' ? 32 : 80 };
  });
}

beforeAll(() => configureActions({ quietMs: 0, capMs: 0 }));

beforeEach(() => {
  resetRefs();
  forgetLastTree();
  onRow.mockClear();
  onLong.mockClear();
  onText.mockClear();
  onSwitch.mockClear();
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 400, height: 800, scale: 2, fontScale: 1 });
  jest.spyOn(PixelRatio, 'get').mockReturnValue(2);
});

afterEach(async () => {
  await unmountAll();
  setMeasurer(null);
  setHitTester(null);
  jest.restoreAllMocks();
});

describe('scrolls to an off-screen target, then acts', () => {
  test('press: the row is scrolled up to the bottom edge, then tapped', async () => {
    await mountWorld();
    const result = await run(() => press({ target: { testID: 'row-20' } }));
    expect(world.calls).toEqual([1288]); // bottom edge at 800 - 8
    expect(onRow).toHaveBeenCalledTimes(1);
    expect(result.scrolled).toBe(true);
    expect(result.element).toMatchObject({ testID: 'row-20', frame: { y: 712 } });
  });

  test('longPress', async () => {
    await mountWorld();
    const result = await run(() => longPress({ target: { testID: 'row-20' } }));
    expect(onLong).toHaveBeenCalledTimes(1);
    expect(result.scrolled).toBe(true);
  });

  test('toggle', async () => {
    await mountWorld();
    const result = await run(() => toggle({ target: { testID: 'sw' } }));
    expect(onSwitch).toHaveBeenCalledWith(true);
    expect(result.scrolled).toBe(true);
    expect(result.value).toBe(true);
  });

  test('type_text', async () => {
    await mountWorld();
    const result = await run(() => typeText({ target: { testID: 'field' }, text: 'hi' }));
    expect(onText).toHaveBeenCalledWith('hi');
    expect(result.scrolled).toBe(true);
    expect(world.calls).toHaveLength(1);
  });

  test('a target that is on screen is not scrolled, and the answer does not say so', async () => {
    await mountWorld({ at: { 'row-20': 100, field: 200, sw: 300 } });
    const result = await run(() => press({ target: { testID: 'row-20' } }));
    expect(world.calls).toEqual([]);
    expect(result.scrolled).toBeUndefined();
    expect(onRow).toHaveBeenCalledTimes(1);
  });

  test('the touch checks still run after the scroll: a cover stays a refusal (the scroll happened)', async () => {
    await mountWorld();
    const cover = nodeWithId('outside').fiber;
    setHitTester(async () => cover);
    const error = await failure(run(() => press({ target: { testID: 'row-20' } })));
    expect(error.code).toBe('not_actionable');
    expect(error.message).toMatch(/^covered: /);
    expect(onRow).not.toHaveBeenCalled();
    expect(world.calls).toHaveLength(1);
  });
});

describe('dry run', () => {
  test('says it would scroll and where the touch lands after the scroll, touching nothing', async () => {
    await mountWorld();
    const result = await run(() => press({ target: { testID: 'row-20' }, dryRun: true }));
    expect(result).toMatchObject({ dryRun: true, scrolls: true, point: { x: 200, y: 752 } });
    expect(world.calls).toEqual([]);
    expect(onRow).not.toHaveBeenCalled();
    expect(result.element.frame).toMatchObject({ y: 2000 }); // the element is where it is now
  });

  test('toggle and type_text too', async () => {
    await mountWorld();
    const sw = await run(() => toggle({ target: { testID: 'sw' }, dryRun: true }));
    expect(sw).toMatchObject({ dryRun: true, scrolls: true, value: true });
    expect(sw.point).toEqual({ x: 200, y: 776 }); // 32 pt tall, brought to 760..792
    const typed = await run(() => typeText({ target: { testID: 'field' }, text: 'x', dryRun: true }));
    expect(typed).toMatchObject({ dryRun: true, scrolls: true });
    expect(typed.point).toBeDefined();
    expect(world.calls).toEqual([]);
    expect(onSwitch).not.toHaveBeenCalled();
    expect(onText).not.toHaveBeenCalled();
  });

  test('an element no scroll can bring on screen is refused in a dry run too', async () => {
    await mountWorld();
    const error = await failure(run(() => press({ target: { testID: 'row-far' }, dryRun: true })));
    expect(error.message).toMatch(/^off_screen: .*can't bring it on screen/);
  });
});

describe('still refused when no scroll helps', () => {
  test('not inside a scroll view', async () => {
    await mountWorld({}, 1500);
    const error = await failure(run(() => press({ target: { testID: 'outside' } })));
    expect(error.code).toBe('not_actionable');
    expect(error.message).toMatch(/^off_screen: .*isn't inside a scroll view, so no scroll can bring it on screen/);
    expect(onRow).not.toHaveBeenCalled();
  });

  test('the scroll view ends before the element is on screen', async () => {
    await mountWorld(); // content ends at 4000: the most it scrolls is 3200, row-far at 5000 stays at 1800
    const error = await failure(run(() => press({ target: { testID: 'row-far' } })));
    expect(error.code).toBe('not_actionable');
    expect(error.message).toMatch(/^off_screen: .*didn't bring it on screen/);
    expect(onRow).not.toHaveBeenCalled();
  });

  test('force acts without scrolling, as before', async () => {
    await mountWorld();
    const result = await run(() => press({ target: { testID: 'row-20' }, force: true }));
    expect(world.calls).toEqual([]);
    expect(result.forced).toBe('off_screen');
    expect(result.scrolled).toBeUndefined();
    expect(onRow).toHaveBeenCalledTimes(1);
  });
});

describe('review 1.4: partly visible targets, alert before scroll, refusal after a scroll, re-resolve fallback', () => {
  test('a row 1 pt over the bottom edge is scrolled clear first, once', async () => {
    await mountWorld({ at: { 'row-20': 721, field: 200, sw: 300 } });
    const result = await run(() => press({ target: { testID: 'row-20' } }));
    expect(world.calls).toHaveLength(1);
    expect(result.scrolled).toBe(true);
    expect(onRow).toHaveBeenCalledTimes(1);
  });

  test('a partly visible row that cannot scroll further is tapped after one attempt, not looped on', async () => {
    await mountWorld({ at: { 'row-20': 721, field: 200, sw: 300 }, contentHeight: 800 });
    const result = await run(() => press({ target: { testID: 'row-20' } }));
    expect(world.calls.length).toBeLessThanOrEqual(1);
    expect(result.scrolled).toBeUndefined();
    expect(onRow).toHaveBeenCalledTimes(1);
  });

  test('a dry run predicts the scroll for a partly visible row', async () => {
    await mountWorld({ at: { 'row-20': 721, field: 200, sw: 300 } });
    const result = await run(() => press({ target: { testID: 'row-20' }, dryRun: true }));
    expect(result).toMatchObject({ dryRun: true, scrolls: true });
    expect(world.calls).toEqual([]);
  });

  test('an open alert is answered before anything scrolls', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    installAlertTracking();
    try {
      await mountWorld();
      Alert.alert('Saved', 'Done.');
      for (const call of [
        () => press({ target: { testID: 'row-20' } }),
        () => toggle({ target: { testID: 'sw' } }),
        () => typeText({ target: { testID: 'field' }, text: 'x' }),
      ]) {
        const error = await failure(run(call));
        expect(error.message).toMatch(/^behind_alert: /);
      }
      expect(world.calls).toEqual([]);
    } finally {
      uninstallAlertTracking();
    }
  });

  test('a refusal after a scroll says so', async () => {
    await mountWorld();
    const cover = nodeWithId('outside').fiber;
    setHitTester(async () => cover);
    const error = await failure(run(() => press({ target: { testID: 'row-20' } })));
    expect(error.message).toMatch(/^covered: /);
    expect(error.message).toMatch(/\(after scrolling to it\)$/);
    // without a scroll the message is as before
    await unmountAll();
    await mountWorld({ at: { 'row-20': 100, field: 200, sw: 300 } });
    const plain = await failure(run(() => press({ target: { testID: 'row-20' } })));
    expect(plain.message).not.toContain('after scrolling');
  });
});

describe('review 1.4: a list that remounts the row while scrolling', () => {
  let rekey: (() => void) | null = null;
  let mounts = 0;

  function Counter(): null {
    React.useEffect(() => {
      mounts += 1;
    }, []);
    return null;
  }

  function Remounting(): React.ReactElement {
    const [generation, setGeneration] = React.useState(0);
    rekey = () => setGeneration((value) => value + 1);
    return (
      <Pressable key={generation} testID="row-20" onPress={onRow}>
        <Text>Row 20</Text>
        <Counter />
      </Pressable>
    );
  }

  test('press falls back to the testID when the ref no longer points at a mounted row', async () => {
    world = { offset: 0, contentHeight: 4000, calls: [], at: { 'row-20': 2000 } };
    await mount(
      <ScrollView testID="list">
        <Remounting />
      </ScrollView>,
    );
    const list = nodeWithId('list').fiber.stateNode;
    if (!isRecord(list)) throw new Error('no list instance');
    list.scrollTo = (arg: Record<string, unknown>) => {
      world.offset = Math.min(Math.max(0, Number(arg.y)), 3200);
      world.calls.push(Number(arg.y));
      act(() => rekey?.());
    };
    setMeasurer(async (fiber) => {
      const found = nearestId(fiber);
      if (!found) return null;
      if (found.id === 'list') return found.own ? LIST_FRAME : { x: 0, y: -world.offset, width: 400, height: 4000 };
      return { x: 0, y: 2000 - world.offset, width: 400, height: 80 };
    });
    // not inside an outer act, so the remount in scrollTo is committed at once
    const result = await press({ target: { testID: 'row-20' } });
    expect(mounts).toBe(2);
    expect(result.scrolled).toBe(true);
    expect(onRow).toHaveBeenCalledTimes(1);
  });
});
