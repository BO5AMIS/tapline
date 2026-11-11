import { frame, mount, unmountAll, useFrames } from './helpers';
import React, { useMemo } from 'react';
import { Dimensions, PanResponder, PixelRatio, Pressable, ScrollView, Text, View, type PanResponderGestureState } from 'react-native';
import { act } from 'react-test-renderer';
import { configureActions, swipe } from '../src/actions';
import { resetRefs } from '../src/inspect';
import { TaplineError } from '../src/types';

// `swipe` through React Native's own touch system: the views under the start point negotiate for
// the touch as they would for a finger, and the winner gets the moves and the release.

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

function SwipeSheet({ onRelease, onInside }: { onRelease: (gesture: PanResponderGestureState) => void; onInside?: () => void }) {
  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) => gesture.dy > 8 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderRelease: (_event, gesture) => onRelease({ ...gesture }),
      }),
    [onRelease],
  );
  return (
    <View testID="sheet" {...pan.panHandlers}>
      <Text>Backdrop sheet</Text>
      {onInside ? (
        <Pressable testID="inside" onPress={onInside}>
          <Text>Inside</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

beforeAll(() => configureActions({ quietMs: 0, capMs: 0 }));

beforeEach(() => {
  resetRefs();
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 400, height: 800, scale: 2, fontScale: 1 });
  jest.spyOn(PixelRatio, 'get').mockReturnValue(2);
});

afterEach(async () => {
  await unmountAll();
  jest.restoreAllMocks();
});

test('a pan view gets the drag, with the distance and a downward speed, and the answer names it', async () => {
  const releases: PanResponderGestureState[] = [];
  await mount(<SwipeSheet onRelease={(gesture) => releases.push(gesture)} />);
  useFrames({ sheet: frame(0, 500, 400, 300), 'Backdrop sheet': frame(20, 520, 300, 22) });
  const result = await run(() => swipe({ x0: 200, y0: 560, x1: 200, y1: 760, seconds: 0.2 }));
  expect(releases).toHaveLength(1);
  // PanResponder measures from where it took the touch over (its first move past 8 pt), as on a phone.
  expect(releases[0]?.dy ?? 0).toBeGreaterThan(170);
  expect(releases[0]?.dy ?? 0).toBeLessThanOrEqual(200);
  expect(releases[0]?.dx).toBeCloseTo(0, 0);
  expect(releases[0]?.vy ?? 0).toBeGreaterThan(0);
  expect(result.from).toEqual({ x: 200, y: 560 });
  expect(result.to).toEqual({ x: 200, y: 760 });
});

test('a drag that starts on a button takes over from it once it moves, as a finger does: no press', async () => {
  const releases: PanResponderGestureState[] = [];
  const onInside = jest.fn();
  await mount(<SwipeSheet onRelease={(gesture) => releases.push(gesture)} onInside={onInside} />);
  useFrames({ sheet: frame(0, 500, 400, 300), inside: frame(20, 560, 200, 48), 'Backdrop sheet': frame(20, 520, 300, 22) });
  await run(() => swipe({ x0: 100, y0: 580, x1: 100, y1: 780, seconds: 0.2 }));
  expect(releases).toHaveLength(1);
  expect(onInside).not.toHaveBeenCalled();
});

test('a sideways drag the pan refuses is nobody\'s: no_action, naming Tapwright\'s swipe', async () => {
  await mount(<SwipeSheet onRelease={() => undefined} />);
  useFrames({ sheet: frame(0, 500, 400, 300), 'Backdrop sheet': frame(20, 520, 300, 22) });
  const error = await failure(run(() => swipe({ x0: 50, y0: 600, x1: 350, y1: 600, seconds: 0.1 })));
  expect(error.code).toBe('not_actionable');
  expect(error.message).toMatch(/^no_action: Nothing took the swipe from \(50, 600\)/);
  expect(error.message).toContain("Tapwright's swipe");
});

test('points off the screen or missing are bad_params', async () => {
  await mount(<View testID="plain" />);
  await expect(swipe({ x0: 10, y0: 10, x1: 10 })).rejects.toMatchObject({ code: 'bad_params' });
  await expect(swipe({ x0: 10, y0: 10, x1: 10, y1: 900 })).rejects.toMatchObject({ code: 'bad_params' });
});

test('a drag along a scroll view is the scroll view\'s (it moves natively): no_action pointing to scroll, and no press', async () => {
  const onRow = jest.fn();
  await mount(
    <ScrollView testID="list">
      <Pressable testID="row" onPress={onRow}>
        <Text>Row</Text>
      </Pressable>
    </ScrollView>,
  );
  useFrames({ list: frame(0, 0, 400, 800), row: frame(0, 300, 400, 60), Row: frame(10, 310, 100, 22) });
  const error = await failure(run(() => swipe({ x0: 200, y0: 330, x1: 200, y1: 100, seconds: 0.1 })));
  expect(error.message).toMatch(/^no_action: Nothing took the swipe from \(200, 330\): it starts on a scroll view, which moves natively: use scroll/);
  expect(onRow).not.toHaveBeenCalled();
});

describe('inside a Modal, as on a phone', () => {
  function ModalSheet({ claimOnStart, onRelease }: { claimOnStart: boolean; onRelease: () => void }) {
    const pan = useMemo(
      () =>
        PanResponder.create({
          ...(claimOnStart ? { onStartShouldSetPanResponder: () => true } : {}),
          onMoveShouldSetPanResponder: (_event, gesture) => gesture.dy > 8,
          onPanResponderRelease: () => onRelease(),
        }),
      [claimOnStart, onRelease],
    );
    // The Modal's own window takes any touch nobody inside it takes.
    return React.createElement(
      'RCTModalHostView',
      { visible: true, onStartShouldSetResponder: () => true },
      <View testID="panel" {...pan.panHandlers}>
        <Text>Panel</Text>
      </View>,
    );
  }

  test('a panel that only claims on a move never gets it: the Modal holds the touch, and the answer says so', async () => {
    const onRelease = jest.fn();
    await mount(<ModalSheet claimOnStart={false} onRelease={onRelease} />);
    useFrames({ panel: frame(0, 500, 400, 300), Panel: frame(20, 520, 300, 22) });
    const error = await failure(run(() => swipe({ x0: 200, y0: 530, x1: 200, y1: 730, seconds: 0.1 })));
    expect(error.message).toMatch(/only the open sheet's own window took it/);
    expect(onRelease).not.toHaveBeenCalled();
  });

  test('a panel that claims on start gets the drag', async () => {
    const onRelease = jest.fn();
    await mount(<ModalSheet claimOnStart onRelease={onRelease} />);
    useFrames({ panel: frame(0, 500, 400, 300), Panel: frame(20, 520, 300, 22) });
    await run(() => swipe({ x0: 200, y0: 530, x1: 200, y1: 730, seconds: 0.1 }));
    expect(onRelease).toHaveBeenCalledTimes(1);
  });
});
