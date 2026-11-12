import { mount, unmountAll } from './helpers';
import React from 'react';
import { Dimensions, PixelRatio, Pressable, ScrollView, Text, View } from 'react-native';
import { act } from 'react-test-renderer';
import { configureActions, press } from '../src/actions';
import { glassTree } from '../src/glass';
import { methods } from '../src/methods';
import { propsOf, type Fiber } from '../src/fiber';
import { collectNodes, forgetLastTree, resetRefs, setHitTester, setMeasurer } from '../src/inspect';
import { setKeyboardReader } from '../src/keyboard';
import { waitFor } from '../src/wait';
import { isRecord, TaplineError, type Frame } from '../src/types';

// AGENT-TOOLS 1.12 §17.1 in the SDK: `tree` with `glass: true` lists only what shows on the glass (cut to the
// scroll view around it and to the part above the keyboard) and says whether a view can really scroll further;
// `noScroll` stops an action scrolling by itself; `wait_for` with `glass` matches what shows.

jest.setTimeout(30000);

async function run<T>(fn: () => Promise<T>): Promise<T> {
  let result: T | undefined;
  await act(async () => {
    result = await fn();
  });
  return result as T;
}

function nearestId(fiber: Fiber): { id: string; own: boolean } | null {
  for (let up: Fiber | null = fiber; up; up = up.return) {
    if (up.tag !== 5) continue;
    const id = propsOf(up).testID;
    if (typeof id === 'string') return { id, own: up === fiber };
  }
  return null;
}

function scrollInstance(): Record<string, unknown> {
  const node = collectNodes().find((candidate) => {
    const props = candidate.fiber.memoizedProps;
    return isRecord(props) && props.testID === 'list';
  });
  const state = node?.fiber.stateNode;
  if (!isRecord(state)) throw new Error('no list');
  return state;
}

const treeMethod = (params: unknown): Promise<unknown> => {
  const method = methods['tree'];
  if (!method) throw new Error('no tree method');
  return method(params);
};

const CONTENT_HEIGHT = 1500;
/** The list occupies y 100..600; its rows sit at these content y (the content starts at the list's top). */
const ROWS: Record<string, number> = { 'row-a': 20, 'row-b': 460, 'row-c': 540, 'row-d': 1400 };

let offset = 0;
let scrolled: number[] = [];

async function mountWorld(startOffset = 0): Promise<void> {
  offset = startOffset;
  scrolled = [];
  await mount(
    <View>
      <ScrollView testID="list">
        {Object.keys(ROWS).map((id) => (
          <Pressable key={id} testID={id} onPress={() => undefined}>
            <Text>{`Item ${id.slice(4)}`}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <Pressable testID="footer" onPress={() => undefined}>
        <Text>Footer</Text>
      </Pressable>
    </View>,
  );
  scrollInstance().scrollTo = (arg: Record<string, unknown>) => {
    scrolled.push(Number(arg.y));
    offset = Math.min(Math.max(0, Number(arg.y)), CONTENT_HEIGHT - 500);
  };
  setMeasurer(async (fiber) => {
    const found = nearestId(fiber);
    if (!found) return null;
    if (found.id === 'list') {
      return found.own ? { x: 0, y: 100, width: 400, height: 500 } : { x: 0, y: 100 - offset, width: 400, height: CONTENT_HEIGHT };
    }
    if (found.id === 'footer') return { x: 0, y: 700, width: 400, height: 40 };
    const at = ROWS[found.id];
    return at === undefined ? null : ({ x: 0, y: 100 + at - offset, width: 400, height: 60 } satisfies Frame);
  });
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
  setKeyboardReader(null);
  jest.restoreAllMocks();
});

const itemTexts = (elements: Array<{ text: string }>): string[] => elements.map((e) => e.text).filter((t) => t.startsWith('Item') || t === 'Footer');

describe('tree with glass', () => {
  test('lists what shows, cut to the scroll view: a row below the list but on the screen is left out', async () => {
    await mountWorld();
    const result = await run(() => glassTree({ glass: true }));
    // row-c (y 640..700) is on the screen but below the list's bottom edge (600): not on the glass
    expect(itemTexts(result.elements)).toEqual(['Item a', 'Item b', 'Footer']);
    // the plain tree lists it
    const plain = await run(() => treeMethod({}) as Promise<{ elements: Array<{ text: string }> }>);
    expect(itemTexts(plain.elements)).toContain('Item c');
  });

  test('says more below only where the view can really scroll, and gives no counts', async () => {
    await mountWorld(0);
    const top = await run(() => glassTree({ glass: true }));
    expect(top.glass).toEqual({ moreAbove: false, moreBelow: true });
    expect(top.offScreen).toBeUndefined();
    await unmountAll();
    await mountWorld(1000);
    const end = await run(() => glassTree({ glass: true }));
    expect(end.glass).toEqual({ moreAbove: true, moreBelow: false });
    await unmountAll();
    await mountWorld(300);
    const middle = await run(() => glassTree({ glass: true }));
    expect(middle.glass).toEqual({ moreAbove: true, moreBelow: true });
  });

  test('elements under the keyboard are left out', async () => {
    await mountWorld();
    setKeyboardReader(() => ({ shown: true, top: 650 }));
    const result = await run(() => glassTree({ glass: true }));
    expect(itemTexts(result.elements)).toEqual(['Item a', 'Item b']);
    expect(result.keyboard).toBe(true);
  });

  test('the tree method takes glass: true from the wire', async () => {
    await mountWorld();
    const result = await run(() => treeMethod({ glass: true }) as Promise<{ glass?: unknown }>);
    expect(result.glass).toEqual({ moreAbove: false, moreBelow: true });
  });
});

describe('noScroll', () => {
  test('an element wholly off screen is refused, and nothing scrolls', async () => {
    await mountWorld();
    let error: unknown;
    await run(async () => {
      try {
        await press({ target: { testID: 'row-d' }, noScroll: true });
      } catch (caught) {
        error = caught;
      }
    });
    expect(error).toBeInstanceOf(TaplineError);
    expect((error as TaplineError).code).toBe('not_actionable');
    expect((error as TaplineError).message).toMatch(/nothing scrolls by itself/);
    expect(scrolled).toEqual([]);
  });

  test('without it the same press scrolls first', async () => {
    await mountWorld();
    const result = await run(() => press({ target: { testID: 'row-d' } }));
    expect(scrolled.length).toBeGreaterThan(0);
    expect(result).toMatchObject({ scrolled: true });
  });

  test('an element that shows is pressed as ever', async () => {
    await mountWorld();
    const result = await run(() => press({ target: { testID: 'row-a' }, noScroll: true }));
    expect(result.element.testID).toBe('row-a');
    expect(scrolled).toEqual([]);
  });

  test('an element on the screen but clipped by its scroll view is refused, not pressed (1.5 review, finding 11)', async () => {
    await mountWorld();
    // row-c (y 640..700) is on the screen, below the list's bottom edge (600): a person can't see it
    let error: unknown;
    await run(async () => {
      try {
        await press({ target: { testID: 'row-c' }, noScroll: true });
      } catch (caught) {
        error = caught;
      }
    });
    expect((error as TaplineError).code).toBe('not_actionable');
    expect(scrolled).toEqual([]);
  });

  test('visible text matches only what shows on the glass', async () => {
    await mountWorld();
    setKeyboardReader(() => ({ shown: true, top: 650 }));
    // "Footer" (y 700..740) is under the keyboard: in a user's eyes there is no such text to tap
    let error: unknown;
    await run(async () => {
      try {
        await press({ target: { text: 'Footer' }, noScroll: true });
      } catch (caught) {
        error = caught;
      }
    });
    expect((error as TaplineError).code).toBe('not_found');
    // outside a journey the same text is found
    const result = await run(() => press({ target: { text: 'Footer' }, force: true }));
    expect(result.element.testID).toBe('footer');
  });
});

describe('wait_for with glass', () => {
  test('matches only what shows on the glass', async () => {
    await mountWorld();
    await expect(run(() => waitFor({ text: 'Item a', glass: true, timeout: 1 }))).resolves.toMatchObject({ met: true });
    // clipped by the list: there in the tree, not on the glass
    await expect(run(() => waitFor({ text: 'Item c', glass: true, timeout: 0.5 }))).rejects.toMatchObject({ code: 'timeout' });
    await expect(run(() => waitFor({ text: 'Item c', timeout: 0.5 }))).resolves.toMatchObject({ met: true });
  });

  test('gone: true is met by an element that is only clipped away', async () => {
    await mountWorld();
    await expect(run(() => waitFor({ text: 'Item c', glass: true, gone: true, timeout: 1 }))).resolves.toMatchObject({ met: true });
  });
});
