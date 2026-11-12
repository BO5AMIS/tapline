import { frame, mount, unmountAll, useFrames } from './helpers';
import React, { useState } from 'react';
import { Dimensions, PixelRatio, Pressable, Text } from 'react-native';
import { act } from 'react-test-renderer';
import { configureActions, press } from '../src/actions';
import { forgetLastTree, resetRefs, setHitTester, setMeasurer } from '../src/inspect';
import { TaplineError } from '../src/types';

// A stress double tap (AGENT-TOOLS 1.12 §17.4) in the SDK: `again` taps a second time that many ms after the first,
// in the same request, on whatever is there by then. The app's own guard against a double submit is respected.

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

const times: number[] = [];

function Counter({ guard }: { guard: boolean }) {
  const [count, setCount] = useState(0);
  return (
    <Pressable
      testID="add"
      disabled={guard && count > 0}
      onPress={() => {
        times.push(Date.now());
        setCount((n) => n + 1);
      }}
    >
      <Text>{`Added ${count}`}</Text>
    </Pressable>
  );
}

describe('press with again', () => {
  beforeEach(() => {
    times.length = 0;
  });

  test('both taps reach the handler, about 80 ms apart, in one request', async () => {
    await mount(<Counter guard={false} />);
    useFrames({ add: frame(0, 100, 400, 50) });
    const result = await run(() => press({ target: { testID: 'add' }, again: 80 }));
    expect(times).toHaveLength(2);
    const gap = (times[1] ?? 0) - (times[0] ?? 0);
    expect(gap).toBeGreaterThanOrEqual(70);
    expect(gap).toBeLessThan(400);
    expect(result.second).toEqual({ done: true, afterMs: expect.any(Number) });
  });

  test('a control the app disabled after the first tap takes no second one, and that is not an error', async () => {
    await mount(<Counter guard />);
    useFrames({ add: frame(0, 100, 400, 50) });
    // Outside act: React commits the first tap's update during the 80 ms, as it does in an app.
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await press({ target: { testID: 'add' }, again: 80 });
    expect(times).toHaveLength(1);
    expect(result.second).toEqual({ done: false, reason: 'disabled', afterMs: expect.any(Number) });
  });

  test('again outside 20..1000 ms is bad_params, before anything is touched', async () => {
    await mount(<Counter guard={false} />);
    useFrames({ add: frame(0, 100, 400, 50) });
    await expect(run(() => press({ target: { testID: 'add' }, again: 5 }))).rejects.toBeInstanceOf(TaplineError);
    expect(times).toHaveLength(0);
  });
});
