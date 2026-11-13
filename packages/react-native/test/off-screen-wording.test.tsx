import { frame, mount, unmountAll, useFrames } from './helpers';
import React from 'react';
import { Dimensions, PixelRatio, Pressable, Text } from 'react-native';
import { act } from 'react-test-renderer';
import { configureActions, press } from '../src/actions';
import { forgetLastTree, resetRefs, setHitTester, setMeasurer } from '../src/inspect';
import { TaplineError, type Frame } from '../src/types';

// AGENT-TOOLS 1.13.1 item 3: off_screen means no scroll can bring the element on screen, and the message
// says so. Tap, long press, toggle and type_text scroll an off-screen target into view themselves, so the
// message never tells the agent to scroll.

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

describe('the off_screen message', () => {
  test('has no scroll advice, and says nothing scrolls there', async () => {
    await mount(
      <Pressable testID="far" onPress={() => undefined}>
        <Text>Far away</Text>
      </Pressable>,
    );
    // Seen on screen by the scroll step, off screen when the touch is checked: the touch check's own refusal.
    let calls = 0;
    setMeasurer(async (): Promise<Frame | null> => {
      calls += 1;
      return calls === 1 ? frame(20, 100, 100, 40) : frame(20, 1200, 100, 40);
    });
    const error = await failure(run(() => press({ target: { testID: 'far' } })));
    expect(error.code).toBe('not_actionable');
    expect(error.message).toMatch(/^off_screen: /);
    expect(error.message).toContain('lies in a part of the screen that nothing scrolls (behind a fixed bar, or outside every list); look at the screen, then target something else or report it.');
    expect(error.message).not.toContain('to: "target"');
    expect(error.message).not.toMatch(/Scroll to it first/);
  });

  test('the refusal for an element outside every scroll view has no scroll advice either', async () => {
    await mount(
      <Pressable testID="far" onPress={() => undefined}>
        <Text>Far away</Text>
      </Pressable>,
    );
    useFrames({ far: frame(20, 1200, 100, 40) });
    const error = await failure(run(() => press({ target: { testID: 'far' } })));
    expect(error.message).toMatch(/^off_screen: /);
    expect(error.message).not.toContain('to: "target"');
    expect(error.message).not.toMatch(/Scroll to it first/);
  });
});
