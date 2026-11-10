import { mount, unmountAll } from './helpers';
import React from 'react';
import { Dimensions, PixelRatio, Pressable, ScrollView, Text, View } from 'react-native';
import { act } from 'react-test-renderer';
import { configureActions, scroll } from '../src/actions';
import { propsOf, type Fiber } from '../src/fiber';
import { collectNodes, forgetLastTree, resetRefs, setHitTester, setMeasurer } from '../src/inspect';
import { isRecord, TaplineError, type Frame } from '../src/types';

// `scroll` with `to: "target"` (AGENT-TOOLS v1.6): one call brings an element onto the screen. The
// tests keep a small world: each scroll view has an offset, `scrollTo` changes it, and the measurer
// answers from it, as the native side would.

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

function hostInstance(testID: string): Record<string, unknown> {
  const node = collectNodes().find((candidate) => {
    const props = candidate.fiber.memoizedProps;
    return isRecord(props) && props.testID === testID;
  });
  const state = node?.fiber.stateNode;
  if (!isRecord(state)) throw new Error(`no host instance for ${testID}`);
  return state;
}

/** The testID of the fiber itself, or of its nearest ancestor that has one (with `own` false). */
function nearestId(fiber: Fiber): { id: string; own: boolean } | null {
  for (let up: Fiber | null = fiber; up; up = up.return) {
    if (up.tag !== 5) continue; // host components only
    const id = propsOf(up).testID;
    if (typeof id === 'string') return { id, own: up === fiber };
  }
  return null;
}

/** A scroll view of the world: where it is, how long its content is, and how far it is scrolled. */
interface Scroller {
  frame: () => Frame;
  content: { width: number; height: number };
  offset: { x: number; y: number };
  calls: Array<{ x: number; y: number }>;
}

function wire(id: string, scroller: Scroller): void {
  hostInstance(id).scrollTo = (arg: Record<string, unknown>) => {
    const frame = scroller.frame();
    const x = Math.min(Math.max(0, Number(arg.x)), Math.max(0, scroller.content.width - frame.width));
    const y = Math.min(Math.max(0, Number(arg.y)), Math.max(0, scroller.content.height - frame.height));
    scroller.offset = { x, y };
    scroller.calls.push({ x: Number(arg.x), y: Number(arg.y) });
  };
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

describe('one list', () => {
  const ROW = 100;
  let list: Scroller;

  /** 40 rows of 80 pt, 100 pt apart, in a list that fills the screen; `contentHeight` 4000 unless given. */
  async function mountList(startOffset = 0, contentHeight = 4000): Promise<void> {
    list = {
      frame: () => ({ x: 0, y: 0, width: 400, height: 800 }),
      content: { width: 400, height: contentHeight },
      offset: { x: 0, y: startOffset },
      calls: [],
    };
    await mount(
      <View>
        <ScrollView testID="list">
          {Array.from({ length: 40 }, (_, i) => (
            <Pressable key={i} testID={`row-${i}`} onPress={() => undefined}>
              <Text>{`Row ${i}`}</Text>
            </Pressable>
          ))}
        </ScrollView>
        <Pressable testID="outside" onPress={() => undefined}>
          <Text>Outside</Text>
        </Pressable>
      </View>,
    );
    wire('list', list);
    setMeasurer(async (fiber) => {
      const found = nearestId(fiber);
      if (!found) return null;
      if (found.id === 'outside') return { x: 0, y: 900, width: 400, height: 40 };
      if (found.id === 'list') {
        // the list itself, or (no testID of its own) its content container
        return found.own ? list.frame() : { x: 0, y: -list.offset.y, width: 400, height: list.content.height };
      }
      const row = /^row-(\d+)$/.exec(found.id);
      if (row) return { x: 0, y: Number(row[1]) * ROW - list.offset.y, width: 400, height: 80 };
      return null;
    });
  }

  test('a row below the screen comes up to the bottom edge, with a margin', async () => {
    await mountList();
    const result = await run(() => scroll({ to: 'target', target: { testID: 'row-20' } }));
    // row 20 spans 2000..2080 in the content; its bottom goes to 800 - 8
    expect(list.calls).toEqual([{ x: 0, y: 1288 }]);
    expect(result).toMatchObject({ moved: true, reached: true, offset: { x: 0, y: 1288 } });
    expect(result.element.testID).toBe('list');
    expect(result.target).toMatchObject({ testID: 'row-20', frame: { x: 0, y: 712, width: 400, height: 80 } });
    expect(result.unchanged).toBeUndefined();
  });

  test('a row above the screen comes down to the top edge, with a margin', async () => {
    await mountList(2000);
    const result = await run(() => scroll({ to: 'target', target: { testID: 'row-3' } }));
    expect(list.calls).toEqual([{ x: 0, y: 292 }]);
    expect(result).toMatchObject({ moved: true, reached: true });
    expect(result.target?.frame).toMatchObject({ y: 8 });
  });

  test('a row partly cut by the edge is brought in whole', async () => {
    await mountList(50); // row 0 spans -50..30
    const result = await run(() => scroll({ to: 'target', target: { text: 'Row 0' } }));
    expect(list.calls).toEqual([{ x: 0, y: 0 }]); // the margin would need -8; the start is as far as it goes
    expect(list.offset.y).toBe(0);
    expect(result).toMatchObject({ moved: true, reached: true });
  });

  test('an element that is clear already: nothing is scrolled, and the answer says so', async () => {
    await mountList();
    const result = await run(() => scroll({ to: 'target', target: { testID: 'row-2' } }));
    expect(list.calls).toEqual([]);
    expect(result).toMatchObject({ moved: false, reached: true, unchanged: true });
    expect(result.target?.testID).toBe('row-2');
  });

  test('the scroll view ends before the element is clear: it goes as far as it can and says it is not reached', async () => {
    await mountList(0, 3900); // the last row sticks out past the end of the content
    const result = await run(() => scroll({ to: 'target', target: { testID: 'row-39' } }));
    expect(list.offset.y).toBe(3100);
    expect(result).toMatchObject({ moved: true, reached: false });
    const again = await run(() => scroll({ to: 'target', target: { testID: 'row-39' } }));
    expect(again).toMatchObject({ moved: false, reached: false });
    expect(again.unchanged).toBeUndefined();
  });

  test('an element outside every scroll view that is off screen: no_action', async () => {
    await mountList();
    const error = await failure(run(() => scroll({ to: 'target', target: { testID: 'outside' } })));
    expect(error.code).toBe('not_actionable');
    expect(error.message).toBe('no_action: e1 button "Outside" is not inside a scroll view');
  });

  test('needs an element as its target, and takes no direction', async () => {
    await mountList();
    expect((await failure(run(() => scroll({ to: 'target' })))).code).toBe('bad_params');
    expect((await failure(run(() => scroll({ to: 'target', target: { x: 10, y: 10 } })))).code).toBe('bad_params');
    expect((await failure(run(() => scroll({ to: 'target', target: { testID: 'row-20' }, direction: 'down' })))).code).toBe('bad_params');
    expect((await failure(run(() => scroll({ to: 'middle' })))).message).toBe('to must be "start", "end" or "target"');
    expect(list.calls).toEqual([]);
  });

  test('a target that matches nothing is not_found', async () => {
    await mountList();
    expect((await failure(run(() => scroll({ to: 'target', target: { testID: 'row-99' } })))).code).toBe('not_found');
  });
});

describe('a strip inside a page', () => {
  test('both scroll views move: the strip sideways, the page down', async () => {
    const page: Scroller = {
      frame: () => ({ x: 0, y: 0, width: 400, height: 800 }),
      content: { width: 400, height: 3000 },
      offset: { x: 0, y: 0 },
      calls: [],
    };
    const strip: Scroller = {
      frame: () => ({ x: 0, y: 1500 - page.offset.y, width: 400, height: 100 }),
      content: { width: 2000, height: 100 },
      offset: { x: 0, y: 0 },
      calls: [],
    };
    await mount(
      <ScrollView testID="page">
        <ScrollView testID="strip" horizontal>
          <Pressable testID="card-9" onPress={() => undefined}>
            <Text>Card 9</Text>
          </Pressable>
        </ScrollView>
      </ScrollView>,
    );
    wire('page', page);
    wire('strip', strip);
    setMeasurer(async (fiber) => {
      const found = nearestId(fiber);
      if (!found) return null;
      if (found.id === 'page') return found.own ? page.frame() : { x: 0, y: -page.offset.y, width: 400, height: 3000 };
      if (found.id === 'strip') {
        const frame = strip.frame();
        return found.own ? frame : { x: -strip.offset.x, y: frame.y, width: 2000, height: 100 };
      }
      if (found.id === 'card-9') return { x: 1800 - strip.offset.x, y: 1510 - page.offset.y, width: 180, height: 80 };
      return null;
    });
    const result = await run(() => scroll({ to: 'target', target: { testID: 'card-9' } }));
    expect(strip.calls).toEqual([{ x: 1588, y: 0 }]);
    expect(page.calls).toEqual([{ x: 0, y: 798 }]);
    expect(result).toMatchObject({ moved: true, reached: true, offset: { x: 1588, y: 0 } });
    // the answer names the innermost scroll view that moved
    expect(result.element.testID).toBe('strip');
    expect(result.target?.frame).toMatchObject({ x: 212, y: 712 });
  });
});
