import { mount, unmountAll } from './helpers';
import React, { useState } from 'react';
import { AppRegistry, Animated, Dimensions, PixelRatio, ScrollView, Text, TextInput, View } from 'react-native';
import { act } from 'react-test-renderer';
import { configureActions, typeText } from '../src/actions';
import { resetAnimations, setAnimationSpeed } from '../src/anim';
import { installIdleSignals, uninstallIdleSignals } from '../src/idle';
import { collectNodes, forgetLastTree, resetRefs, setHitTester, setMeasurer } from '../src/inspect';
import { setNativeModule, type TaplineNativeModule } from '../src/native';
import { currentPlace } from '../src/place';
import { propsOf } from '../src/fiber';
import { isRecord, TaplineError } from '../src/types';

// CodeRabbit on PR 9: a secure kind is held after a scroll recycles the field, idle teardown under the fast wrappers,
// a newer fast request is not undone by an old one, and a bare Modal above a presented route is the layer.

beforeAll(() => configureActions({ quietMs: 0, capMs: 0 }));
beforeEach(() => {
  resetRefs();
  forgetLastTree();
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 400, height: 800, scale: 2, fontScale: 1 });
  jest.spyOn(PixelRatio, 'get').mockReturnValue(2);
  jest.spyOn(AppRegistry, 'setWrapperComponentProvider').mockImplementation(() => undefined);
});
afterEach(async () => {
  resetAnimations();
  uninstallIdleSignals();
  setNativeModule(undefined);
  await unmountAll();
  setMeasurer(null);
  setHitTester(null);
  jest.restoreAllMocks();
});

let recycle: (secure: boolean) => void = () => undefined;
function Field() {
  const [secure, setSecure] = useState(true);
  recycle = setSecure;
  return <TextInput testID="field" accessibilityLabel="Password" secureTextEntry={secure} />;
}

test('a field recycled from secure to plain while scrolling is refused for a secure kind', async () => {
  let offset = 0;
  await mount(
    <View>
      <ScrollView testID="list">
        <Field />
      </ScrollView>
    </View>,
  );
  const list = collectNodes().find((n) => isRecord(n.fiber.memoizedProps) && n.fiber.memoizedProps.testID === 'list')?.fiber.stateNode;
  if (!isRecord(list)) throw new Error('no list');
  list.scrollTo = (arg: Record<string, unknown>) => {
    offset = Number(arg.y);
    act(() => {
      recycle(false);
    });
  };
  setMeasurer(async (fiber) => {
    for (let up = fiber as typeof fiber | null; up; up = up.return) {
      if (up.tag === 5 && propsOf(up).testID === 'field') return { x: 0, y: 2000 - offset, width: 400, height: 44 };
    }
    if (fiber.tag === 5 && propsOf(fiber).testID === 'list') return { x: 0, y: 0, width: 400, height: 800 };
    return { x: 0, y: -offset, width: 400, height: 4000 };
  });
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  let caught: unknown;
  try {
    await typeText({ target: { testID: 'field' }, text: 'secret', kind: 'secure' });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TaplineError);
  expect((caught as TaplineError).code).toBe('bad_params');
});

describe('idle teardown under the fast wrappers', () => {
  test('once idle is switched off, its wrappers no longer track, even beneath the fast ones', async () => {
    const realStart = jest.fn();
    const animated = Animated as unknown as Record<string, unknown>;
    const realTiming = Animated.timing;
    animated.timing = () => ({ start: realStart, stop: () => undefined });
    try {
      installIdleSignals();
      await setAnimationSpeed('fast');
      uninstallIdleSignals();
      await setAnimationSpeed('normal');
      const animation = Animated.timing(new Animated.Value(0), { toValue: 1, duration: 100, useNativeDriver: false }) as unknown as { start: unknown };
      expect(animation.start).toBe(realStart);
    } finally {
      animated.timing = realTiming;
    }
  });
});

describe('overlapping fast requests', () => {
  test('an old request that lands late puts back the speed the newer one wants', async () => {
    const speeds: number[] = [];
    const resolvers: Array<() => void> = [];
    const native: TaplineNativeModule = {
      capture: () => Promise.resolve(''),
      cover: () => Promise.resolve({ kind: '' }),
      setAnimationSpeed: (speed: number) => {
        speeds.push(speed);
        return new Promise<void>((resolve) => {
          resolvers.push(resolve);
        });
      },
    };
    setNativeModule(native);
    const first = setAnimationSpeed('fast');
    resetAnimations();
    const second = setAnimationSpeed('fast');
    expect(speeds).toEqual([100, 1, 100]);
    for (const done of resolvers.splice(0)) done();
    // The old request reconciled with the newer one: fast is on, so it asks for fast again, never for 1.
    for (let turn = 0; turn < 5; turn += 1) {
      await Promise.resolve();
      for (const done of resolvers.splice(0)) done();
    }
    await Promise.all([first, second]);
    expect(speeds[speeds.length - 1]).toBe(100);
  });
});

function Screen({ children }: { route: { key: string; name: string }; navigation: unknown; children?: React.ReactNode }) {
  return <View>{children}</View>;
}
function Native({ type, children, ...props }: { type: string; children?: React.ReactNode } & Record<string, unknown>) {
  return React.createElement(type, props, children);
}
const nav = { isFocused: () => true, canGoBack: () => false, goBack: jest.fn(), navigate: jest.fn(), getState: () => ({ routes: [] }) };

describe('a bare Modal above a presented route', () => {
  test('the Modal is the layer when it opens inside the form sheet', async () => {
    await mount(
      <Screen route={{ key: 'root-1', name: 'root' }} navigation={nav}>
        <Native type="RNSScreen" stackPresentation="formSheet" activityState={2}>
          <Screen route={{ key: 'filters-2', name: 'filters' }} navigation={nav}>
            <Text>Filters</Text>
            {React.createElement('RCTModalHostView', { visible: true }, <View testID="confirm-root" />)}
          </Screen>
        </Native>
      </Screen>,
    );
    expect(currentPlace()?.layer).toBe('modal:confirm-root');
  });

  test('a form sheet inside the Modal stays the layer', async () => {
    await mount(
      <Screen route={{ key: 'root-1', name: 'root' }} navigation={nav}>
        {React.createElement(
          'RCTModalHostView',
          { visible: true },
          <Native type="RNSScreen" stackPresentation="formSheet" activityState={2}>
            <Screen route={{ key: 'filters-2', name: 'filters' }} navigation={nav}>
              <Text>Filters</Text>
            </Screen>
          </Native>,
        )}
      </Screen>,
    );
    expect(currentPlace()?.layer).toBe('sheet:filters');
  });
});
