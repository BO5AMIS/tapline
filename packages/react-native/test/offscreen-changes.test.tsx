import { frame, mount, unmountAll, useFrames } from './helpers';
import React from 'react';
import { Dimensions, PixelRatio, Pressable, ScrollView, Switch, Text } from 'react-native';
import { act } from 'react-test-renderer';
import type { ReactTestRenderer } from 'react-test-renderer';
import { forgetLastTree, resetRefs, setHitTester, setMeasurer, tree } from '../src/inspect';
import type { Frame } from '../src/types';

// AGENT-TOOLS v1.6: a change to an element that is off screen is reported, so a tap whose effect
// is scrolled out of view doesn't answer "No visible change.".

async function run<T>(fn: () => Promise<T>): Promise<T> {
  let result: T | undefined;
  await act(async () => {
    result = await fn();
  });
  return result as T;
}

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

function Screen({ state, on = false, counters = 0 }: { state: string; on?: boolean; counters?: number }) {
  return (
    <ScrollView testID="list">
      <Text testID="state">{state}</Text>
      <Switch testID="sw" value={on} onValueChange={() => undefined} />
      <Pressable testID="row" onPress={() => undefined}>
        <Text>Row 30</Text>
      </Pressable>
      {Array.from({ length: 7 }, (_, i) => (
        <Text key={i} testID={`count-${i}`}>{`count ${i}: ${counters}`}</Text>
      ))}
    </ScrollView>
  );
}

/** The list is scrolled down: the state line and the switch are above the screen, the row is on it. */
const SCROLLED: Record<string, Frame | null> = {
  list: frame(0, 0, 400, 800),
  state: frame(16, -900, 368, 60),
  sw: frame(16, -820, 60, 32),
  row: frame(16, 300, 368, 48),
  ...Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`count-${i}`, frame(16, 1000 + i * 40, 368, 30)])),
};

async function mountScrolled(): Promise<ReactTestRenderer> {
  const renderer = await mount(<Screen state="taps=0 row=-" />);
  useFrames(SCROLLED);
  await run(() => tree());
  return renderer;
}

describe('changes off screen', () => {
  test('a text that changed above the screen comes with the element as it is now, without a ref', async () => {
    const renderer = await mountScrolled();
    await act(async () => {
      renderer.update(<Screen state="taps=0 row=30" />);
    });
    const { changes } = await run(() => tree({ changes: true }));
    expect(changes?.changed).toEqual([]);
    expect(changes?.offScreen).toHaveLength(1);
    expect(changes?.offScreen?.[0]).toMatchObject({
      element: { ref: '', testID: 'state', text: 'taps=0 row=30', frame: { x: 16, y: -900, width: 368, height: 60 } },
      was: { text: 'taps=0 row=-' },
    });
    expect(changes?.offScreenMore).toBeUndefined();
  });

  test('a switch that changed state off screen is reported too', async () => {
    const renderer = await mountScrolled();
    await act(async () => {
      renderer.update(<Screen state="taps=0 row=-" on />);
    });
    const { changes } = await run(() => tree({ changes: true }));
    expect(changes?.offScreen).toEqual([expect.objectContaining({ was: { checked: false }, element: expect.objectContaining({ testID: 'sw', checked: true }) })]);
  });

  test('nothing changed: the fields are left out', async () => {
    await mountScrolled();
    const { changes } = await run(() => tree({ changes: true }));
    expect(changes?.offScreen).toBeUndefined();
    expect(changes?.offScreenMore).toBeUndefined();
  });

  test('more than five: five are listed and the rest counted', async () => {
    const renderer = await mountScrolled();
    await act(async () => {
      renderer.update(<Screen state="taps=0 row=-" counters={1} />);
    });
    const { changes } = await run(() => tree({ changes: true }));
    expect(changes?.offScreen).toHaveLength(5);
    expect(changes?.offScreenMore).toBe(2);
  });

  test('a scroll alone reports nothing off screen, and an element that came onto the screen is new, not changed', async () => {
    const renderer = await mountScrolled();
    // scrolled back up: the state line is on screen now, with a new text
    useFrames({ ...SCROLLED, state: frame(16, 100, 368, 60), sw: frame(16, 180, 60, 32), row: frame(16, 1300, 368, 48) });
    await act(async () => {
      renderer.update(<Screen state="taps=5 row=-" />);
    });
    const { changes, elements } = await run(() => tree({ changes: true }));
    expect(changes?.offScreen).toBeUndefined();
    const state = elements.find((element) => element.testID === 'state');
    expect(changes?.added).toContain(state?.ref);
  });

  test('the baseline moves on: the same change is reported once', async () => {
    const renderer = await mountScrolled();
    await act(async () => {
      renderer.update(<Screen state="taps=1 row=-" />);
    });
    expect((await run(() => tree({ changes: true }))).changes?.offScreen).toHaveLength(1);
    expect((await run(() => tree({ changes: true }))).changes?.offScreen).toBeUndefined();
  });
});
