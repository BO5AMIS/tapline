import { mount, unmountAll, useFrames, frame } from './helpers';
import React from 'react';
import { Dimensions, PixelRatio, Pressable, Text, TextInput, View } from 'react-native';
import { forgetLastTree, resetRefs, setMeasurer, tree } from '../src/inspect';
import type { TaplineExploreProps } from '../src/index';

// AGENT-TOOLS 1.15 §25.5 and §25.6: the app marks what the explorer never touches and what it may fill.

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
  plain: frame(0, 0, 300, 40),
  skipped: frame(0, 50, 300, 40),
  inside: frame(0, 100, 300, 40),
  deeper: frame(0, 150, 300, 40),
  fake: frame(0, 200, 300, 40),
  vault: frame(0, 250, 300, 40),
  fixture: frame(0, 300, 300, 40),
  nested: frame(0, 350, 300, 40),
  after: frame(0, 400, 300, 40),
  badmark: frame(0, 450, 300, 40),
  falsy: frame(0, 500, 300, 40),
};

const mark = (props: TaplineExploreProps): TaplineExploreProps => props;

function Wrapper({ children, ...rest }: TaplineExploreProps & { children?: React.ReactNode }) {
  return <View>{children}</View>;
}

function Screen() {
  return (
    <View>
      <Pressable testID="plain" accessibilityRole="button">
        <Text>Open</Text>
      </Pressable>
      <Pressable testID="skipped" accessibilityRole="button" {...mark({ taplineExploreSkip: true })}>
        <Text>Danger</Text>
      </Pressable>
      <View {...mark({ taplineExploreSkip: true })}>
        <Pressable testID="inside" accessibilityRole="button">
          <Text>Inside</Text>
        </Pressable>
        <View>
          <Pressable testID="deeper" accessibilityRole="button">
            <Text>Deeper</Text>
          </Pressable>
        </View>
      </View>
      <TextInput testID="fake" {...mark({ taplineExploreFill: true })} />
      <TextInput testID="vault" {...mark({ taplineExploreFill: 'vault:identity.email' })} />
      <TextInput testID="fixture" {...mark({ taplineExploreFill: 'fixture:address' })} />
      <Wrapper {...mark({ taplineExploreSkip: true })}>
        <Pressable testID="nested" accessibilityRole="button">
          <Text>Through a component</Text>
        </Pressable>
      </Wrapper>
      <Pressable testID="after" accessibilityRole="button">
        <Text>After</Text>
      </Pressable>
      <TextInput testID="badmark" {...({ taplineExploreFill: 'anything' } as Record<string, unknown>)} />
      <Pressable testID="falsy" accessibilityRole="button" {...mark({ taplineExploreSkip: false })}>
        <Text>Not skipped</Text>
      </Pressable>
    </View>
  );
}

async function elements() {
  await mount(<Screen />);
  useFrames(frames);
  const result = await tree({});
  return (id: string) => result.elements.find((e) => e.testID === id);
}

test('no flag by default, and false is no flag', async () => {
  const byId = await elements();
  for (const id of ['plain', 'after', 'falsy']) {
    expect(byId(id)).toBeDefined();
    expect(byId(id)).not.toHaveProperty('exploreSkip');
    expect(byId(id)).not.toHaveProperty('exploreFill');
  }
});

test('taplineExploreSkip marks the element and everything inside it, through a component too', async () => {
  const byId = await elements();
  expect(byId('skipped')?.exploreSkip).toBe(true);
  expect(byId('inside')?.exploreSkip).toBe(true);
  expect(byId('deeper')?.exploreSkip).toBe(true);
  expect(byId('nested')?.exploreSkip).toBe(true);
});

test('taplineExploreFill reaches the input as true, a vault reference or a fixture', async () => {
  const byId = await elements();
  expect(byId('fake')?.exploreFill).toBe(true);
  expect(byId('vault')?.exploreFill).toBe('vault:identity.email');
  expect(byId('fixture')?.exploreFill).toBe('fixture:address');
  expect(byId('fake')).not.toHaveProperty('exploreSkip');
});

test('a fill value that is not true, vault: or fixture: is ignored', async () => {
  const byId = await elements();
  expect(byId('badmark')).toBeDefined();
  expect(byId('badmark')).not.toHaveProperty('exploreFill');
});

test('the marks of a wrapper outside an open modal stay on what the modal shows', async () => {
  await unmountAll();
  await mount(
    <View>
      <Wrapper {...mark({ taplineExploreSkip: true })}>
        {React.createElement(
          'RCTModalHostView',
          { visible: true },
          <View>
            <Pressable testID="in-modal" accessibilityRole="button">
              <Text>Inside the modal</Text>
            </Pressable>
          </View>,
        )}
      </Wrapper>
      <Wrapper {...mark({ taplineExploreFill: true })}>
        {React.createElement('RCTModalHostView', { visible: true }, <TextInput testID="modal-input" />)}
      </Wrapper>
    </View>,
  );
  useFrames({ 'in-modal': frame(0, 0, 300, 40), 'modal-input': frame(0, 50, 300, 40) });
  const result = await tree({});
  const byId = (id: string) => result.elements.find((e) => e.testID === id);
  // Only the topmost modal is listed: the second one, with the fill mark.
  expect(byId('modal-input')?.exploreFill).toBe(true);
  await unmountAll();
  await mount(
    <Wrapper {...mark({ taplineExploreSkip: true })}>
      {React.createElement(
        'RCTModalHostView',
        { visible: true },
        <View>
          <Pressable testID="in-modal" accessibilityRole="button">
            <Text>Inside the modal</Text>
          </Pressable>
        </View>,
      )}
    </Wrapper>,
  );
  useFrames({ 'in-modal': frame(0, 0, 300, 40) });
  const only = await tree({});
  expect(only.elements.find((e) => e.testID === 'in-modal')?.exploreSkip).toBe(true);
});
