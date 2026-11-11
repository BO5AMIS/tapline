import { frame, mount, unmountAll, useFrames } from './helpers';
import React from 'react';
import { Dimensions, PixelRatio, Pressable, Text, View } from 'react-native';
import { act } from 'react-test-renderer';
import { audit } from '../src/actions';
import { resetRefs, setMeasurer } from '../src/inspect';
import { setSourceFetch } from '../src/source';

// A library's button that sets its role on a wrapper (React Navigation's tab: role passed down through
// a PlatformPressable) has a role: the trait check must not flag it.

beforeEach(() => {
  resetRefs();
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 400, height: 800, scale: 2, fontScale: 1 });
  jest.spyOn(PixelRatio, 'get').mockReturnValue(2);
  setSourceFetch(async () => {
    throw new Error('no Metro');
  });
});
afterEach(async () => {
  await unmountAll();
  setMeasurer(null);
  setSourceFetch(null);
  jest.restoreAllMocks();
});

function LibraryButton(props: { role: 'button'; testID: string; onPress: () => void; children: React.ReactNode }): React.JSX.Element {
  const { children, ...rest } = props;
  return (
    <Pressable {...rest}>
      <View testID={props.testID}>{children}</View>
    </Pressable>
  );
}

test('a role set on the pressable above the element counts', async () => {
  await mount(
    <LibraryButton role="button" testID="tab-a" onPress={() => undefined}>
      <Text>Explore</Text>
    </LibraryButton>,
  );
  useFrames({ 'tab-a': frame(0, 700, 140, 49) }, null);
  let result: Awaited<ReturnType<typeof audit>> | undefined;
  await act(async () => {
    result = await audit({ types: ['trait', 'duplicate_id'] });
  });
  expect(result?.issues).toEqual([]);
});

test("iOS's own switch at its system size is no small target; content scrolling under a bar is no overlap", async () => {
  const { ScrollView, Switch } = jest.requireActual<typeof import('react-native')>('react-native');
  await mount(
    <View>
      <ScrollView testID="list">
        <Pressable testID="card" accessibilityRole="button" onPress={() => undefined}>
          <Text>Card</Text>
        </Pressable>
      </ScrollView>
      <Pressable testID="tab" accessibilityRole="button" onPress={() => undefined}>
        <Text>Tab</Text>
      </Pressable>
      <Switch testID="sw" accessibilityLabel="Ratings" value={false} onValueChange={() => undefined} />
    </View>,
  );
  useFrames({ list: frame(0, 0, 400, 700), card: frame(20, 600, 360, 200), tab: frame(0, 700, 400, 49), sw: frame(330, 230, 63, 28) }, null);
  let result: Awaited<ReturnType<typeof audit>> | undefined;
  await act(async () => {
    result = await audit({ types: ['hit_region', 'overlap'] });
  });
  expect(result?.issues).toEqual([]);
});

test('a button floating over the visible part of a list overlaps it', async () => {
  const { ScrollView } = jest.requireActual<typeof import('react-native')>('react-native');
  await mount(
    <View>
      <ScrollView testID="list2">
        <Text testID="status">taps=0 pressed=-</Text>
      </ScrollView>
      <Pressable testID="corner" accessibilityRole="button" accessibilityLabel="TL" onPress={() => undefined} />
    </View>,
  );
  useFrames({ list2: frame(0, 0, 400, 700), status: frame(16, 100, 398, 68), corner: frame(16, 100, 60, 60) }, null);
  let result: Awaited<ReturnType<typeof audit>> | undefined;
  await act(async () => {
    result = await audit({ types: ['overlap'] });
  });
  expect(result?.issues.map((i) => i.type)).toEqual(['overlap']);
});
