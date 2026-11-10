import { frame, mount, unmountAll, useFrames } from './helpers';
import React from 'react';
import { Dimensions, PixelRatio, Text, TextInput, View } from 'react-native';
import { setKeyboardReader, type KeyboardState } from '../src/keyboard';
import { forgetLastTree, resetRefs, tree } from '../src/inspect';

// AGENT-TOOLS §3.1/§3.2: `Keyboard: shown` in the header while the keyboard is up, and
// `Keyboard: shown` / `Keyboard: hidden` in a change block when it came or went.

let state: KeyboardState | undefined = { shown: false, top: null };

beforeEach(async () => {
  resetRefs();
  forgetLastTree();
  state = { shown: false, top: null };
  setKeyboardReader(() => state);
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 400, height: 800, scale: 2, fontScale: 1 });
  jest.spyOn(PixelRatio, 'get').mockReturnValue(2);
  await mount(
    <View>
      <Text>Form</Text>
      <TextInput testID="name" />
    </View>,
  );
  useFrames({ Form: frame(20, 60, 200, 22), name: frame(20, 100, 300, 40) });
});

afterEach(async () => {
  await unmountAll();
  setKeyboardReader(null);
  jest.restoreAllMocks();
});

test('a list says the keyboard is up, and says nothing while it is down', async () => {
  expect((await tree({})).keyboard).toBeUndefined();
  state = { shown: true, top: 500 };
  expect((await tree({})).keyboard).toBe(true);
});

test('a change block says when it came and when it went, once each', async () => {
  await tree({});
  state = { shown: true, top: 500 };
  expect((await tree({ changes: true })).changes?.keyboard).toBe('shown');
  expect((await tree({ changes: true })).changes?.keyboard).toBeUndefined();
  state = { shown: false, top: null };
  expect((await tree({ changes: true })).changes?.keyboard).toBe('hidden');
});

test('when React Native can\'t say, nothing is claimed', async () => {
  state = undefined;
  await tree({});
  state = { shown: true, top: 500 };
  const result = await tree({ changes: true });
  expect(result.keyboard).toBe(true);
  expect(result.changes?.keyboard).toBeUndefined();
});

test('a peek leaves the baseline alone', async () => {
  await tree({});
  state = { shown: true, top: 500 };
  await tree({ peek: true });
  expect((await tree({ changes: true })).changes?.keyboard).toBe('shown');
});
