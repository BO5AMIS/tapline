import { frame, mount, unmountAll, useFrames } from './helpers';
import React from 'react';
import { Dimensions, PixelRatio, Pressable, Text, View } from 'react-native';
import { act } from 'react-test-renderer';
import { forgetLastTree, resetRefs, setMeasurer, tree } from '../src/inspect';

function Shop({ total, coupon, banner }: { total: string; coupon: boolean; banner: boolean }) {
  return (
    <View>
      <Text testID="title">Basket</Text>
      <Text testID="total">{total}</Text>
      {coupon ? (
        <Pressable testID="coupon" onPress={() => undefined}>
          <Text>Use coupon</Text>
        </Pressable>
      ) : null}
      {banner ? <Text testID="banner">Free delivery today</Text> : null}
      <Pressable testID="pay" onPress={() => undefined}>
        <Text>Pay</Text>
      </Pressable>
    </View>
  );
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
  jest.restoreAllMocks();
});

const frames = {
  title: frame(0, 0, 200, 30),
  total: frame(0, 40, 200, 30),
  coupon: frame(0, 80, 200, 40),
  banner: frame(0, 130, 200, 30),
  pay: frame(0, 700, 200, 48),
};

test('a plain tree has no changes and starts refs at e1', async () => {
  await mount(<Shop total="$10" coupon banner={false} />);
  useFrames(frames);
  const first = await tree({ changes: true });
  expect(first.changes).toBeUndefined();
  expect(first.elements[0]?.ref).toBe('e1');
  const second = await tree({});
  expect(second.changes).toBeUndefined();
});

test('changes lists added, removed, changed and moved elements, and keeps refs stable', async () => {
  const renderer = await mount(<Shop total="$10" coupon banner={false} />);
  useFrames(frames);
  const before = await tree({});
  const refOf = (elements: typeof before.elements, testID: string): string | undefined =>
    elements.find((e) => e.testID === testID)?.ref;

  await act(async () => {
    renderer.update(<Shop total="$8" coupon={false} banner />);
  });
  useFrames({ ...frames, pay: frame(0, 650, 200, 48) });
  const after = await tree({ changes: true });

  expect(refOf(after.elements, 'title')).toBe(refOf(before.elements, 'title'));
  expect(refOf(after.elements, 'total')).toBe(refOf(before.elements, 'total'));
  expect(refOf(after.elements, 'pay')).toBe(refOf(before.elements, 'pay'));
  const bannerRef = refOf(after.elements, 'banner');
  expect(bannerRef).toBeDefined();
  expect(before.elements.some((e) => e.ref === bannerRef)).toBe(false);

  expect(after.changes?.sameRoute).toBe(true);
  expect(after.changes?.added).toEqual([bannerRef]);
  expect(after.changes?.removed.map((e) => e.testID)).toEqual(['coupon']);
  expect(after.changes?.changed).toEqual([{ ref: refOf(before.elements, 'total'), was: { text: '$10' } }]);
  expect(after.changes?.moved).toEqual([refOf(before.elements, 'pay')]);
});

test('no visible change gives empty lists', async () => {
  await mount(<Shop total="$10" coupon banner={false} />);
  useFrames(frames);
  await tree({});
  const again = await tree({ changes: true });
  expect(again.changes).toEqual({ sameRoute: true, added: [], removed: [], changed: [], moved: [] });
});
