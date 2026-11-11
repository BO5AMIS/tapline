import { frame, mount, unmountAll, useFrames } from './helpers';
import React from 'react';
import { Dimensions, PixelRatio, Pressable, Text, View } from 'react-native';
import { act } from 'react-test-renderer';
import { audit } from '../src/actions';
import { resetRefs, setMeasurer } from '../src/inspect';
import { setSourceFetch } from '../src/source';

// AGENT-TOOLS 1.8 §10: the accessibility audit, in the shared types.

beforeEach(() => {
  resetRefs();
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 400, height: 800, scale: 2, fontScale: 1 });
  jest.spyOn(PixelRatio, 'get').mockReturnValue(2);
  // No Metro in tests: sources are unknown, and the report still stands.
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

const noop = (): void => {};

async function run(params: unknown): Promise<Awaited<ReturnType<typeof audit>>> {
  let result: Awaited<ReturnType<typeof audit>> | undefined;
  await act(async () => {
    result = await audit(params);
  });
  if (result === undefined) throw new Error('no result');
  return result;
}

test('finds a small target, a nameless button, a pressable without a role and a shared id, each with its fix', async () => {
  await mount(
    <View>
      <Pressable testID="close" accessibilityRole="button" accessibilityLabel="Close" onPress={noop} />
      <Pressable testID="icon" accessibilityRole="button" onPress={noop} />
      <Pressable testID="plain" onPress={noop}>
        <Text>Plain</Text>
      </Pressable>
      <Pressable testID="twin" accessibilityRole="button" onPress={noop}>
        <Text>One</Text>
      </Pressable>
      <Pressable testID="twin" accessibilityRole="button" onPress={noop}>
        <Text>Two</Text>
      </Pressable>
    </View>,
  );
  useFrames(
    { close: frame(350, 40, 20, 20), icon: frame(10, 100, 60, 60), plain: frame(10, 200, 200, 48), twin: frame(10, 300, 200, 48) },
    null,
  );
  const { issues, checked } = await run({});
  expect(checked).toEqual(['contrast', 'hit_region', 'description', 'clipped_text', 'trait', 'overlap', 'duplicate_id']);
  const byType = (type: string) => issues.filter((i) => i.type === type);
  expect(byType('hit_region')[0]).toMatchObject({ problem: 'too small to tap reliably (20x20 pt)', fix: 'make it at least 44x44 pt', element: { testID: 'close' } });
  expect(byType('description')[0]).toMatchObject({ problem: 'no label, so VoiceOver says only "button"', element: { testID: 'icon' } });
  expect(byType('trait')[0]).toMatchObject({ fix: 'set accessibilityRole="button"', element: { testID: 'plain' } });
  expect(byType('duplicate_id')[0]?.problem).toMatch(/^the id "twin" is on 2 elements \(e\d+, e\d+\)$/);
  expect(issues.every((i) => i.at === undefined)).toBe(true);
});

test('checks only the types asked for', async () => {
  await mount(<Pressable testID="close" onPress={noop} />);
  useFrames({ close: frame(350, 40, 20, 20) }, null);
  const { issues, checked } = await run({ types: ['hit_region', 'dynamic_type'] });
  expect(checked).toEqual(['hit_region']);
  expect(issues.map((i) => i.type)).toEqual(['hit_region']);
});

test('a switch-like role without a state is a trait problem', async () => {
  await mount(
    <Pressable testID="wifi" accessibilityRole="switch" accessibilityLabel="Wi-Fi" onPress={noop}>
      <Text>Wi-Fi</Text>
    </Pressable>,
  );
  useFrames({ wifi: frame(10, 100, 300, 48) }, null);
  const { issues } = await run({ types: ['trait'] });
  expect(issues[0]).toMatchObject({ type: 'trait', problem: "it's a switch without a state, so VoiceOver can't say whether it's on", fix: 'set accessibilityState={{ checked }}' });
});
