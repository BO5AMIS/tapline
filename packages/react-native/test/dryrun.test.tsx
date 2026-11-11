import { frame, mount, unmountAll, useFrames } from './helpers';
import React from 'react';
import { Dimensions, PixelRatio, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { act } from 'react-test-renderer';
import { back, configureActions, press, scroll, swipe, toggle, typeText } from '../src/actions';
import { resetRefs, setMeasurer } from '../src/inspect';
import { TaplineError } from '../src/types';

// AGENT-TOOLS 1.8 §11.4: a dry run resolves the target and runs every check, then touches nothing.

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
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 400, height: 800, scale: 2, fontScale: 1 });
  jest.spyOn(PixelRatio, 'get').mockReturnValue(2);
});
afterEach(async () => {
  await unmountAll();
  setMeasurer(null);
  jest.restoreAllMocks();
});

test('a dry tap calls nothing and says where the finger would land', async () => {
  const onPress = jest.fn();
  await mount(
    <Pressable testID="delete" onPress={onPress}>
      <Text>Delete trip</Text>
    </Pressable>,
  );
  useFrames({ delete: frame(20, 600, 200, 40) });
  const result = await run(() => press({ target: { testID: 'delete' }, dryRun: true }));
  expect(onPress).not.toHaveBeenCalled();
  expect(result).toMatchObject({ dryRun: true, point: { x: 120, y: 620 }, element: { testID: 'delete' } });
});

test('a dry run still refuses what a person couldn’t do', async () => {
  const onPress = jest.fn();
  await mount(
    <Pressable testID="off" disabled onPress={onPress}>
      <Text>Off</Text>
    </Pressable>,
  );
  useFrames({ off: frame(20, 600, 200, 40) });
  let error: unknown;
  try {
    await run(() => press({ target: { testID: 'off' }, dryRun: true }));
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(TaplineError);
  expect((error as TaplineError).message).toMatch(/^disabled: /);
});

test('a dry type and a dry toggle change nothing', async () => {
  const onChangeText = jest.fn();
  const onValueChange = jest.fn();
  await mount(
    <View>
      <TextInput testID="email" accessibilityLabel="Email" onChangeText={onChangeText} />
      <Switch testID="remind" value={false} onValueChange={onValueChange} />
    </View>,
  );
  useFrames({ email: frame(20, 100, 300, 44), remind: frame(320, 200, 60, 30) });
  const typed = await run(() => typeText({ target: { testID: 'email' }, text: 'a@b.co', dryRun: true }));
  expect(typed).toMatchObject({ dryRun: true, value: '' });
  expect(onChangeText).not.toHaveBeenCalled();
  const toggled = await run(() => toggle({ target: { testID: 'remind' }, dryRun: true }));
  expect(toggled).toMatchObject({ dryRun: true, value: true });
  expect(onValueChange).not.toHaveBeenCalled();
});

test('a dry scroll names the scroll view and moves nothing; a dry swipe names what lies under the start', async () => {
  const onScroll = jest.fn();
  await mount(
    <ScrollView testID="list" onScroll={onScroll}>
      <Text>Row</Text>
    </ScrollView>,
  );
  useFrames({ list: frame(0, 0, 400, 800) });
  const scrolled = await run(() => scroll({ direction: 'down', dryRun: true }));
  expect(scrolled).toMatchObject({ dryRun: true, moved: false, element: { testID: 'list' } });
  expect(onScroll).not.toHaveBeenCalled();
  const swiped = await run(() => swipe({ x0: 200, y0: 600, x1: 200, y1: 200, dryRun: true }));
  expect(swiped).toMatchObject({ dryRun: true, from: { x: 200, y: 600 }, to: { x: 200, y: 200 } });
});

test('a dry back says there is nothing to go back to, as the real one would', async () => {
  await mount(<Text>Home</Text>);
  let error: unknown;
  try {
    await run(() => back({ dryRun: true }));
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(TaplineError);
});
