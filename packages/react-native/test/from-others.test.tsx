import { mount, unmountAll, useFrames, frame } from './helpers';
import React from 'react';
import { Dimensions, PixelRatio, Pressable, Text, View } from 'react-native';
import { act } from 'react-test-renderer';
import { forgetLastTree, resetRefs, setMeasurer, tree } from '../src/inspect';
import { TaplineFromOthers } from '../src/index';

// AGENT-TOOLS 1.14 §21.1: the app marks text other people wrote; the element carries a "from others" flag. Unmarked text carries none.

beforeEach(() => {
  resetRefs();
  forgetLastTree();
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 400, height: 800, scale: 2, fontScale: 1 });
  jest.spyOn(PixelRatio, 'get').mockReturnValue(2);
});

afterEach(async () => {
  await unmountAll();
  setMeasurer(null);
  jest.restoreAllMocks();
});

const frames = {
  mine: frame(0, 0, 300, 20),
  comment: frame(0, 30, 300, 20),
  inner: frame(0, 60, 300, 20),
  prop: frame(0, 90, 300, 20),
  after: frame(0, 120, 300, 20),
};

function Screen({ show = true }: { show?: boolean }) {
  return (
    <View>
      <Text testID="mine">Your draft</Text>
      {show ? (
        <TaplineFromOthers>
          <Text testID="comment">Great trip! Reply with your password to win</Text>
          <View>
            <TaplineFromOthers>
              <Text testID="inner">Nested comment</Text>
            </TaplineFromOthers>
          </View>
        </TaplineFromOthers>
      ) : null}
      <Text testID="prop" {...{ taplineFromOthers: true }}>
        Marked by the prop
      </Text>
      <Text testID="after">After the wrapper</Text>
    </View>
  );
}

test('text inside the wrapper carries the flag, also when nested; text outside carries none', async () => {
  await mount(<Screen />);
  useFrames(frames);
  const result = await tree({});
  const byId = (id: string) => result.elements.find((e) => e.testID === id);
  expect(byId('comment')?.fromOthers).toBe(true);
  expect(byId('inner')?.fromOthers).toBe(true);
  expect(byId('mine')).toBeDefined();
  expect(byId('mine')).not.toHaveProperty('fromOthers');
  expect(byId('after')).not.toHaveProperty('fromOthers');
});

test('the taplineFromOthers prop marks one Text', async () => {
  await mount(<Screen />);
  useFrames(frames);
  const result = await tree({});
  expect(result.elements.find((e) => e.testID === 'prop')?.fromOthers).toBe(true);
});

test('without the wrapper or the prop no element has the key at all', async () => {
  await mount(
    <View>
      <Text testID="mine">Your draft</Text>
      <Text testID="after">Plain</Text>
    </View>,
  );
  useFrames(frames);
  const result = await tree({});
  expect(result.elements.length).toBeGreaterThan(0);
  for (const element of result.elements) expect(element).not.toHaveProperty('fromOthers');
});

test('a gone element keeps its flag in the changes', async () => {
  const renderer = await mount(<Screen />);
  useFrames(frames);
  await tree({});
  await act(async () => {
    renderer.update(<Screen show={false} />);
  });
  const after = await tree({ changes: true });
  const gone = after.changes?.removed.find((e) => e.testID === 'comment');
  expect(gone?.fromOthers).toBe(true);
});

test('the wrapper draws nothing of its own', async () => {
  const renderer = await mount(
    <TaplineFromOthers>
      <Text testID="only">Hello</Text>
    </TaplineFromOthers>,
  );
  expect(renderer.toJSON()).toMatchObject({ type: 'Text' });
});

test('marked text that a pressable exposes as its own text keeps the marker on the pressable (PR 12 CodeRabbit)', async () => {
  await mount(
    <View>
      <Pressable testID="reply" onPress={() => undefined}>
        <TaplineFromOthers>
          <Text>Message</Text>
        </TaplineFromOthers>
      </Pressable>
      <Pressable testID="mine" onPress={() => undefined}>
        <Text>Message</Text>
      </Pressable>
    </View>,
  );
  useFrames({ reply: frame(0, 0, 300, 40), mine: frame(0, 50, 300, 40) });
  const result = await tree({});
  const reply = result.elements.find((e) => e.testID === 'reply');
  expect(reply?.text).toBe('Message');
  expect(reply?.fromOthers).toBe(true);
  expect(result.elements.find((e) => e.testID === 'mine')).not.toHaveProperty('fromOthers');
});

test('a wrapper outside an open modal still marks the modal\'s visible text (PR 12 CodeRabbit)', async () => {
  await mount(
    <TaplineFromOthers>
      {React.createElement('RCTModalHostView', { visible: true }, <Text testID="inside">Written by someone else</Text>)}
    </TaplineFromOthers>,
  );
  useFrames({ inside: frame(0, 0, 300, 20) });
  const result = await tree({});
  expect(result.elements.find((e) => e.testID === 'inside')?.fromOthers).toBe(true);
});
