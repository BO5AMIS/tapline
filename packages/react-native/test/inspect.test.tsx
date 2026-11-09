import { SAMPLE_FRAMES, SampleScreen, frame, makeSpies, mount, unmountAll, useFrames } from './helpers';
import React from 'react';
import { Dimensions, PixelRatio, Text, View } from 'react-native';
import { resetRefs, setMeasurer, tree, defaultMeasurer, publicInstancesOf } from '../src/inspect';
import type { TaplineElement } from '../src/types';
import type { Fiber } from '../src/fiber';

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

/** A native component by name (React Native Screens' tab and stack screens); a host element here. */
function Native({ type, children, ...props }: { type: string; children?: React.ReactNode } & Record<string, unknown>) {
  return React.createElement(type, props, children);
}

function byTestID(elements: TaplineElement[], testID: string): TaplineElement {
  const found = elements.find((element) => element.testID === testID);
  if (!found) throw new Error(`no element with testID ${testID}`);
  return found;
}

describe('tree', () => {
  test('describes the sample screen as elements with injected frames', async () => {
    await mount(<SampleScreen spies={makeSpies()} />);
    useFrames(SAMPLE_FRAMES);
    const result = await tree({});

    expect(result.screen).toEqual({ width: 400, height: 800, scale: 2 });
    const { elements } = result;

    const login = byTestID(elements, 'login-button');
    expect(login).toMatchObject({
      type: 'Pressable',
      role: 'button',
      label: 'Sign in now',
      text: 'Log in',
      frame: { x: 24, y: 60, width: 352, height: 48 },
      actions: ['press', 'longPress'],
      disabled: false,
      selected: false,
      checked: null,
      value: null,
    });

    const go = elements.find((element) => element.type === 'Button');
    expect(go).toMatchObject({ text: 'Go', actions: ['press'], role: 'button' });

    const disabled = byTestID(elements, 'disabled-button');
    expect(disabled.disabled).toBe(true);

    const controlled = byTestID(elements, 'name-input');
    expect(controlled).toMatchObject({ type: 'TextInput', actions: ['type', 'submit'], value: '', text: '' });
    const uncontrolled = byTestID(elements, 'notes-input');
    expect(uncontrolled.value).toBe('seed');

    const toggle = byTestID(elements, 'notify-switch');
    expect(toggle).toMatchObject({ type: 'Switch', role: 'switch', actions: ['toggle'], checked: false });

    expect(byTestID(elements, 'main-scroll')).toMatchObject({ type: 'ScrollView', actions: ['scroll'] });
    expect(byTestID(elements, 'feed')).toMatchObject({ type: 'FlatList', actions: ['scroll'] });

    // nested components: the Card's Text is its own element, the card carries both the label text and its children
    const title = elements.find((element) => element.text === 'Account' && element.type === 'Text');
    expect(title).toBeDefined();
    expect(byTestID(elements, 'account-card').text).toContain('Account');
    expect(byTestID(elements, 'account-card').text).toContain('Log in');

    // the Text inside a Pressable is folded into the Pressable
    expect(elements.filter((element) => element.type === 'Text' && element.text === 'Log in')).toHaveLength(0);
    // FlatList rows are listed
    expect(elements.some((element) => element.type === 'Text' && element.text === 'item one')).toBe(true);
  });

  test('elements come in tree order with refs e1, e2, ...', async () => {
    await mount(<SampleScreen spies={makeSpies()} />);
    useFrames(SAMPLE_FRAMES);
    const { elements } = await tree({});
    expect(elements.map((element) => element.ref)).toEqual(elements.map((_, i) => `e${i + 1}`));
    expect(elements[0]?.testID).toBe('main-scroll');
    const order = ['login-button', 'disabled-button', 'name-input', 'notes-input', 'notify-switch', 'delete-1', 'delete-2', 'feed'];
    const positions = order.map((id) => elements.findIndex((element) => element.testID === id));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  test('refs are stable within a snapshot and restart on the next tree call', async () => {
    await mount(<SampleScreen spies={makeSpies()} />);
    useFrames(SAMPLE_FRAMES);
    const first = await tree({});
    expect(new Set(first.elements.map((e) => e.ref)).size).toBe(first.elements.length);
    const second = await tree({});
    expect(second.elements.map((e) => [e.ref, e.testID])).toEqual(first.elements.map((e) => [e.ref, e.testID]));
  });

  test('omits zero-size and off-screen elements unless all is set', async () => {
    await mount(<SampleScreen spies={makeSpies()} />);
    useFrames({
      ...SAMPLE_FRAMES,
      'delete-1': frame(24, 400, 0, 0),
      'delete-2': frame(24, 900, 100, 40),
      'feed': frame(-500, 0, 100, 40),
    });
    const trimmed = await tree({});
    expect(trimmed.elements.some((e) => e.testID === 'delete-1')).toBe(false);
    expect(trimmed.elements.some((e) => e.testID === 'delete-2')).toBe(false);
    expect(trimmed.elements.some((e) => e.testID === 'feed')).toBe(false);
    expect(trimmed.elements.some((e) => e.testID === 'login-button')).toBe(true);

    const everything = await tree({ all: true });
    expect(everything.elements.some((e) => e.testID === 'delete-1')).toBe(true);
    expect(everything.elements.length).toBeGreaterThan(trimmed.elements.length);
  });

  test('all includes elements without text, label, testID or action', async () => {
    await mount(
      <View testID="outer">
        <View />
        <Text>hello</Text>
      </View>,
    );
    useFrames({});
    const normal = await tree({});
    const all = await tree({ all: true });
    expect(normal.elements.map((e) => e.type)).toEqual(['View', 'Text']);
    expect(all.elements.length).toBeGreaterThan(normal.elements.length);
  });

  test('keeps an unmeasurable element with a null frame', async () => {
    await mount(<Text>lonely</Text>);
    setMeasurer(async () => null);
    const { elements } = await tree({});
    expect(elements).toHaveLength(1);
    expect(elements[0]?.frame).toBeNull();
  });

  test('reads disabled / selected / checked from accessibilityState and aria props', async () => {
    await mount(
      <View>
        <View testID="a" accessibilityState={{ disabled: true, selected: true, checked: 'mixed' }} />
        <View testID="b" aria-disabled aria-selected aria-checked aria-label="Bee" />
      </View>,
    );
    useFrames({});
    const { elements } = await tree({});
    expect(byTestID(elements, 'a')).toMatchObject({ disabled: true, selected: true, checked: 'mixed' });
    expect(byTestID(elements, 'b')).toMatchObject({ disabled: true, selected: true, checked: true, label: 'Bee' });
  });

  test('truncates text to 200 characters', async () => {
    await mount(<Text testID="long">{'x'.repeat(500)}</Text>);
    useFrames({});
    const { elements } = await tree({});
    expect(byTestID(elements, 'long').text).toHaveLength(200);
  });

  test('skips content hidden from accessibility or display', async () => {
    await mount(
      <View>
        <View aria-hidden>
          <Text>behind aria-hidden</Text>
        </View>
        <View accessibilityElementsHidden>
          <Text>behind elements-hidden</Text>
        </View>
        <View importantForAccessibility="no-hide-descendants">
          <Text>behind no-hide-descendants</Text>
        </View>
        <View style={{ display: 'none' }}>
          <Text>behind display-none</Text>
        </View>
        <View aria-hidden={false}>
          <Text>shown aria-false</Text>
        </View>
        <View importantForAccessibility="no">
          <Text>shown importance-no</Text>
        </View>
        <View pointerEvents="none">
          <Text>shown overlay</Text>
        </View>
      </View>,
    );
    useFrames({});
    for (const all of [false, true]) {
      const { elements } = await tree({ all });
      expect(elements.some((e) => e.text.includes('behind'))).toBe(false);
      for (const text of ['shown aria-false', 'shown importance-no', 'shown overlay']) {
        expect(elements.some((e) => e.text === text)).toBe(true);
      }
    }
  });

  test('skips tab screens that are not selected', async () => {
    await mount(
      <Native type="RNSTabsHostIOS">
        <Native type="RNSTabsScreenIOS" pointerEvents="box-none">
          <Text>today tab</Text>
        </Native>
        <Native type="RNSTabsScreenIOS" pointerEvents="none">
          <Text>nutrition tab</Text>
        </Native>
        <Native type="RNSTabsScreenAndroid" pointerEvents="none">
          <Text>android tab</Text>
        </Native>
        <Native type="RNSBottomTabsScreen" isFocused={false}>
          <Text>older tab</Text>
        </Native>
      </Native>,
    );
    useFrames({});
    const { elements } = await tree({});
    expect(elements.map((e) => e.text).filter((text) => text.endsWith('tab'))).toEqual(['today tab']);
  });

  test('skips inactive screens and screens covered by another', async () => {
    await mount(
      <Native type="RNSScreenStack">
        <Native type="RNSScreen" activityState={2} aria-hidden>
          <Text>covered screen</Text>
        </Native>
        <Native type="RNSScreen" activityState={0}>
          <Text>inactive screen</Text>
        </Native>
        <Native type="RNSScreen" activityState={2} aria-hidden={false}>
          <Text>top screen</Text>
        </Native>
      </Native>,
    );
    useFrames({});
    const { elements } = await tree({});
    expect(elements.map((e) => e.text).filter((text) => text.endsWith('screen'))).toEqual(['top screen']);
  });

  test('errors with a hint when nothing was recorded', async () => {
    await expect(tree({})).rejects.toMatchObject({ code: 'internal', message: expect.stringContaining('register') });
  });
});

describe('default measurer', () => {
  function hostFiber(stateNode: unknown): Fiber {
    return { tag: 5, type: 'View', elementType: 'View', memoizedProps: {}, stateNode, child: null, sibling: null, return: null };
  }

  test('uses measureInWindow on the host instance (old architecture)', async () => {
    const measureInWindow = jest.fn((cb: (x: number, y: number, w: number, h: number) => void) => cb(1, 2, 3, 4));
    await expect(defaultMeasurer(hostFiber({ measureInWindow }))).resolves.toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });

  test('uses canonical.publicInstance.measureInWindow (Fabric)', async () => {
    const measureInWindow = jest.fn((cb: (x: number, y: number, w: number, h: number) => void) => cb(5, 6, 7, 8));
    const fiber = hostFiber({ node: {}, canonical: { nativeTag: 3, publicInstance: { measureInWindow } } });
    await expect(defaultMeasurer(fiber)).resolves.toEqual({ x: 5, y: 6, width: 7, height: 8 });
    expect(publicInstancesOf(fiber)).toHaveLength(3);
  });

  test('falls back to nativeFabricUIManager.measureInWindow with the shadow node', async () => {
    const node = { shadow: true };
    const measureInWindow = jest.fn((n: unknown, cb: (x: number, y: number, w: number, h: number) => void) => {
      expect(n).toBe(node);
      cb(9, 10, 11, 12);
    });
    (globalThis as { nativeFabricUIManager?: unknown }).nativeFabricUIManager = { measureInWindow };
    try {
      const fiber = hostFiber({ node, canonical: { nativeTag: 3, publicInstance: null } });
      await expect(defaultMeasurer(fiber)).resolves.toEqual({ x: 9, y: 10, width: 11, height: 12 });
    } finally {
      delete (globalThis as { nativeFabricUIManager?: unknown }).nativeFabricUIManager;
    }
  });

  test('returns null when nothing can measure', async () => {
    await expect(defaultMeasurer(hostFiber({}))).resolves.toBeNull();
    await expect(defaultMeasurer(hostFiber(null))).resolves.toBeNull();
  });

  test('times out when the callback never fires', async () => {
    jest.useFakeTimers();
    try {
      const pending = defaultMeasurer(hostFiber({ measureInWindow: () => {} }));
      await jest.advanceTimersByTimeAsync(600);
      await expect(pending).resolves.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test('returns null when measureInWindow throws', async () => {
    const throwing = hostFiber({
      measureInWindow: () => {
        throw new Error('detached');
      },
    });
    await expect(defaultMeasurer(throwing)).resolves.toBeNull();
  });
});
