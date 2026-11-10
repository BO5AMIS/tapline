import { frame, mount, unmountAll, useFrames } from './helpers';
import React from 'react';
import { Alert, Dimensions, PixelRatio, Pressable, ScrollView, Text, View } from 'react-native';
import { act } from 'react-test-renderer';
import type { ReactTestRenderer } from 'react-test-renderer';
import { configureActions, press, scroll } from '../src/actions';
import { installAlertTracking, TaplineAlertHost, uninstallAlertTracking } from '../src/alerts';
import { propsOf, type Fiber } from '../src/fiber';
import { collectNodes, cutText, forgetLastTree, resetRefs, setHitTester, setMeasurer, sliceWhole, tree } from '../src/inspect';
import { isRecord, TaplineError, type Frame } from '../src/types';
import { waitFor } from '../src/wait';

// What a review of 2026-11-10's changes found, each pinned by a test: scroll-to-target with a list
// further down the page, a list resting on a system inset and an upside-down list; a recycled list
// cell is not "a change off screen"; a cut never splits an emoji; a list the host takes for itself
// leaves the agent's refs alone; `label` matches a button that only shows its text.

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
    if (up.tag !== 5) continue;
    const id = propsOf(up).testID;
    if (typeof id === 'string') return { id, own: up === fiber };
  }
  return null;
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
  uninstallAlertTracking();
  jest.restoreAllMocks();
});

describe('scroll to a target: a list further down the page', () => {
  test('an element already inside the inner list leaves that list alone; only the page scrolls', async () => {
    const page = { offset: 0, calls: [] as number[] };
    const inner = { offset: 0, calls: [] as number[] };
    await mount(
      <ScrollView testID="page">
        <ScrollView testID="inner">
          <Pressable testID="item" onPress={() => undefined}>
            <Text>Item</Text>
          </Pressable>
        </ScrollView>
      </ScrollView>,
    );
    hostInstance('page').scrollTo = (arg: Record<string, unknown>) => {
      page.offset = Math.min(Math.max(0, Number(arg.y)), 3000 - 800);
      page.calls.push(Number(arg.y));
    };
    hostInstance('inner').scrollTo = (arg: Record<string, unknown>) => {
      inner.offset = Math.min(Math.max(0, Number(arg.y)), 900 - 300);
      inner.calls.push(Number(arg.y));
    };
    // The inner list spans 1200..1500 of the page's content: below the fold of an 800-high screen.
    setMeasurer(async (fiber) => {
      const found = nearestId(fiber);
      if (!found) return null;
      if (found.id === 'page') return found.own ? { x: 0, y: 0, width: 400, height: 800 } : { x: 0, y: -page.offset, width: 400, height: 3000 };
      if (found.id === 'inner') {
        const y = 1200 - page.offset;
        return found.own ? { x: 0, y, width: 400, height: 300 } : { x: 0, y: y - inner.offset, width: 400, height: 900 };
      }
      if (found.id === 'item') return { x: 0, y: 1300 - page.offset - inner.offset, width: 400, height: 60 };
      return null;
    });
    const result = await run(() => scroll({ to: 'target', target: { testID: 'item' } }));
    expect(inner.calls).toEqual([]);
    expect(page.calls).toEqual([568]); // the item's bottom (1360) goes to 800 - 8
    expect(result).toMatchObject({ moved: true, reached: true });
    expect(result.element.testID).toBe('page');
  });
});

describe('scroll to a target: a list that rests on a system inset', () => {
  /** A list whose resting offset is -96 (iOS adds the inset under a large title). */
  async function mountInset(startOffset: number): Promise<{ list: { offset: number; calls: number[] } }> {
    const list = { offset: startOffset, calls: [] as number[] };
    await mount(
      <ScrollView testID="list">
        <Pressable testID="first" onPress={() => undefined}>
          <Text>First</Text>
        </Pressable>
        <Pressable testID="far" onPress={() => undefined}>
          <Text>Far</Text>
        </Pressable>
      </ScrollView>,
    );
    hostInstance('list').scrollTo = (arg: Record<string, unknown>) => {
      list.offset = Math.min(Math.max(-96, Number(arg.y)), 2000);
      list.calls.push(Number(arg.y));
    };
    setMeasurer(async (fiber) => {
      const found = nearestId(fiber);
      if (!found) return null;
      if (found.id === 'list') return found.own ? { x: 0, y: 0, width: 400, height: 800 } : { x: 0, y: -list.offset, width: 400, height: 2800 };
      // "first" is 150 pt above the content's start line, so even at rest it sticks out above the screen
      if (found.id === 'first') return { x: 0, y: -150 - list.offset, width: 400, height: 40 };
      if (found.id === 'far') return { x: 0, y: 1500 - list.offset, width: 400, height: 40 };
      return null;
    });
    return { list };
  }

  test('it never scrolls forward to reach an element that is above', async () => {
    const { list } = await mountInset(-96);
    const result = await run(() => scroll({ to: 'target', target: { testID: 'first' } }));
    expect(list.calls).toEqual([]);
    expect(list.offset).toBe(-96);
    expect(result).toMatchObject({ moved: false, reached: false });
  });

  test('forward from the resting offset works as usual', async () => {
    const { list } = await mountInset(-96);
    const result = await run(() => scroll({ to: 'target', target: { testID: 'far' } }));
    expect(list.calls).toEqual([748]); // far's bottom (1540) goes to 800 - 8
    expect(result).toMatchObject({ moved: true, reached: true });
  });
});

describe('scroll to a target: a list drawn upside down', () => {
  test('the first move goes the wrong way, is seen, and the next one is turned round', async () => {
    const list = { offset: 1000, calls: [] as number[] };
    await mount(
      <ScrollView testID="chat">
        <Pressable testID="old" onPress={() => undefined}>
          <Text>Old message</Text>
        </Pressable>
      </ScrollView>,
    );
    hostInstance('chat').scrollTo = (arg: Record<string, unknown>) => {
      list.offset = Math.min(Math.max(0, Number(arg.y)), 3000);
      list.calls.push(Number(arg.y));
    };
    // Inverted: a larger offset moves the content DOWN the screen. The message is 500 pt above the top.
    setMeasurer(async (fiber) => {
      const found = nearestId(fiber);
      if (!found) return null;
      if (found.id === 'chat') return found.own ? { x: 0, y: 0, width: 400, height: 800 } : { x: 0, y: -list.offset, width: 400, height: 3800 };
      if (found.id === 'old') return { x: 0, y: -1500 + list.offset, width: 400, height: 60 };
      return null;
    });
    const result = await run(() => scroll({ to: 'target', target: { testID: 'old' } }));
    expect(list.calls.length).toBeGreaterThanOrEqual(2);
    expect(result).toMatchObject({ moved: true, reached: true });
    expect(result.target?.frame).toMatchObject({ y: 8 });
  });
});

describe('changes off screen: the same element, or a recycled cell', () => {
  function Rows({ a, b }: { a: { id: string; text: string }; b: { id: string | undefined; text: string } }) {
    return (
      <ScrollView testID="list">
        <Text testID="shown">On screen</Text>
        <Text testID={a.id}>{a.text}</Text>
        <Text testID={b.id}>{b.text}</Text>
      </ScrollView>
    );
  }
  const base: Record<string, Frame | null> = { list: frame(0, 0, 400, 800), shown: frame(0, 100, 400, 40) };

  async function start(frames: Record<string, Frame | null>, b: { id: string | undefined; text: string }): Promise<ReactTestRenderer> {
    const renderer = await mount(<Rows a={{ id: 'state', text: 'taps=0' }} b={b} />);
    useFrames({ ...base, ...frames });
    await run(() => tree());
    return renderer;
  }

  test('a cell handed to another row (another id, another place) is not reported', async () => {
    const renderer = await start({ state: frame(0, -500, 400, 40), 'row-5': frame(0, 900, 400, 40) }, { id: 'row-5', text: 'Row 5' });
    useFrames({ ...base, state: frame(0, -500, 400, 40), 'row-17': frame(0, 2100, 400, 40) });
    await act(async () => {
      renderer.update(<Rows a={{ id: 'state', text: 'taps=0' }} b={{ id: 'row-17', text: 'Row 17' }} />);
    });
    expect((await run(() => tree({ changes: true }))).changes?.offScreen).toBeUndefined();
  });

  test('an element with the same identifier is reported even after it moved (a scroll came between)', async () => {
    const renderer = await start({ state: frame(0, -500, 400, 40), 'row-5': frame(0, 900, 400, 40) }, { id: 'row-5', text: 'Row 5' });
    useFrames({ ...base, state: frame(0, -900, 400, 40), 'row-5': frame(0, 1300, 400, 40) });
    await act(async () => {
      renderer.update(<Rows a={{ id: 'state', text: 'taps=1' }} b={{ id: 'row-5', text: 'Row 5' }} />);
    });
    const changes = (await run(() => tree({ changes: true }))).changes;
    expect(changes?.offScreen).toHaveLength(1);
    expect(changes?.offScreen?.[0]).toMatchObject({ element: { testID: 'state', text: 'taps=1' }, was: { text: 'taps=0' } });
  });

  test('an element that was on the list and is off screen now (a scroll answered without a list came between) is reported too', async () => {
    const renderer = await start({ state: frame(0, 200, 400, 40), 'row-5': frame(0, 900, 400, 40) }, { id: 'row-5', text: 'Row 5' });
    // scrolled down by 700: the state line left the screen, and then a tap changed it
    useFrames({ list: frame(0, 0, 400, 800), shown: frame(0, -600, 400, 40), state: frame(0, -500, 400, 40), 'row-5': frame(0, 200, 400, 40) });
    await act(async () => {
      renderer.update(<Rows a={{ id: 'state', text: 'taps=1' }} b={{ id: 'row-5', text: 'Row 5' }} />);
    });
    const changes = (await run(() => tree({ changes: true }))).changes;
    expect(changes?.offScreen).toEqual([expect.objectContaining({ was: { text: 'taps=0' }, element: expect.objectContaining({ testID: 'state', ref: '' }) })]);
  });

  test('without an identifier it must be in the same place', async () => {
    const renderer = await start({ state: frame(0, -500, 400, 40), 'Row 5': frame(0, 900, 400, 40) }, { id: undefined, text: 'Row 5' });
    // same place, new text: a change
    useFrames({ ...base, state: frame(0, -500, 400, 40), 'Row 5!': frame(0, 900, 400, 40) });
    await act(async () => {
      renderer.update(<Rows a={{ id: 'state', text: 'taps=0' }} b={{ id: undefined, text: 'Row 5!' }} />);
    });
    expect((await run(() => tree({ changes: true }))).changes?.offScreen).toHaveLength(1);
    // another place, new text: a recycled cell
    useFrames({ ...base, state: frame(0, -500, 400, 40), 'Row 9': frame(0, 1700, 400, 40) });
    await act(async () => {
      renderer.update(<Rows a={{ id: 'state', text: 'taps=0' }} b={{ id: undefined, text: 'Row 9' }} />);
    });
    expect((await run(() => tree({ changes: true }))).changes?.offScreen).toBeUndefined();
  });
});

describe('a cut never splits a character', () => {
  test('an emoji across the 200th place is left out whole, and counted', () => {
    const text = `${'a'.repeat(199)}😀${'b'.repeat(10)}`; // the emoji takes places 200 and 201
    expect(cutText(text)).toBe(`${'a'.repeat(199)}…(+12)`);
    expect(sliceWhole(text, 200)).toBe('a'.repeat(199));
    expect(sliceWhole(text, 201)).toBe(`${'a'.repeat(199)}😀`);
    expect(cutText(`${'a'.repeat(198)}😀`)).toBe(`${'a'.repeat(198)}😀`);
  });

  test('the 2000-character cut of what goes over the wire too', async () => {
    const text = `${'a'.repeat(1999)}😀tail`;
    await mount(<Text testID="long">{text}</Text>);
    useFrames({ long: frame(0, 100, 400, 60) });
    const [element] = (await run(() => tree())).elements;
    expect(element?.text).toBe('a'.repeat(1999));
    expect(element?.textMore).toBe(6);
  });
});

describe("a list the host takes for itself (`peek`) leaves the agent's list alone", () => {
  function Two({ label }: { label: string }) {
    return (
      <View>
        <Pressable testID="a" onPress={() => undefined}>
          <Text>{label}</Text>
        </Pressable>
        <Pressable testID="b" onPress={() => undefined}>
          <Text>Second</Text>
        </Pressable>
      </View>
    );
  }

  test('refs keep their numbers, new elements get none, and the next changes are still measured from the agent\'s list', async () => {
    const renderer = await mount(<Two label="First" />);
    useFrames({ a: frame(0, 100, 200, 40), b: frame(0, 200, 200, 40) });
    const looked = await run(() => tree());
    const refs = Object.fromEntries(looked.elements.map((element) => [element.testID, element.ref]));
    await act(async () => {
      renderer.update(<Two label="First!" />);
    });
    const peeked = await run(() => tree({ peek: true }));
    expect(Object.fromEntries(peeked.elements.map((element) => [element.testID, element.ref]))).toEqual(refs);
    expect(peeked.changes).toBeUndefined();
    // The agent's next answer still shows the change: the peek did not swallow it.
    const after = await run(() => tree({ changes: true }));
    expect(after.changes?.changed.map((change) => change.ref)).toEqual([refs.a]);
    expect(after.elements.find((element) => element.testID === 'b')?.ref).toBe(refs.b);
  });
});

describe('`label` matches as iOS forms the label', () => {
  test('a button that only shows its text is found by {label}', async () => {
    const onOk = jest.fn();
    await mount(
      <View>
        <Pressable testID="ok" onPress={onOk}>
          <Text>OK</Text>
        </Pressable>
        <Pressable testID="named" accessibilityLabel="Close dialog" onPress={() => undefined}>
          <Text>X</Text>
        </Pressable>
      </View>,
    );
    useFrames({ ok: frame(20, 100, 100, 40), named: frame(20, 200, 100, 40) });
    const result = await run(() => press({ target: { label: 'ok' } }));
    expect(result.element.testID).toBe('ok');
    expect(onOk).toHaveBeenCalledTimes(1);
    // an element with a label of its own is matched by that label, not by its text
    expect((await run(() => press({ target: { label: 'Close dialog' } }))).element.testID).toBe('named');
    expect((await failure(run(() => press({ target: { label: 'X' } })))).code).toBe('not_found');
    // exact, as before: no partial match, and an empty label matches nothing
    expect((await failure(run(() => press({ target: { label: 'O' } })))).code).toBe('not_found');
    expect((await failure(run(() => press({ target: { label: ' ' } })))).code).toBe('not_found');
  });

  test("the in-app alert's buttons, which have no label of their own", async () => {
    installAlertTracking({ standIn: true });
    await mount(
      <View style={{ flex: 1 }}>
        <TaplineAlertHost />
      </View>,
    );
    useFrames({});
    await act(async () => {
      Alert.alert('Delete item?', 'It will be gone', [{ text: 'Cancel', style: 'cancel' }, { text: 'OK' }]);
    });
    const result = await run(() => press({ target: { label: 'OK' } }));
    expect(result.element.testID).toBe('tapline-alert-button-1');
  });

  test('wait_for with a label sees it too', async () => {
    await mount(
      <Pressable testID="ok" onPress={() => undefined}>
        <Text>Saved</Text>
      </Pressable>,
    );
    useFrames({ ok: frame(20, 100, 100, 40) });
    await expect(run(() => waitFor({ label: 'saved', timeout: 0.5 }))).resolves.toMatchObject({ met: true });
  });
});
