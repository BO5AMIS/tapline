import { SAMPLE_FRAMES, SampleScreen, frame, makeSpies, mount, unmountAll, useFrames } from './helpers';
import React from 'react';
import { Dimensions, PixelRatio, Pressable, Text, View } from 'react-native';
import { act } from 'react-test-renderer';
import { resolveTarget } from '../src/actions';
import { nativeTabBar, resetRefs, setMeasurer, takeSnapshot, tree, defaultMeasurer, defaultHitTester, publicInstancesOf } from '../src/inspect';
import { getRoots } from '../src/register';
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
    expect(controlled).toMatchObject({ type: 'TextInput', actions: ['press', 'type', 'submit'], value: '', text: '' });
    const uncontrolled = byTestID(elements, 'notes-input');
    expect(uncontrolled.value).toBe('seed');

    const toggle = byTestID(elements, 'notify-switch');
    expect(toggle).toMatchObject({ type: 'Switch', role: 'switch', actions: ['toggle'], checked: false });

    expect(byTestID(elements, 'main-scroll')).toMatchObject({ type: 'ScrollView', actions: ['scroll'] });
    expect(byTestID(elements, 'feed')).toMatchObject({ type: 'FlatList', actions: ['scroll'] });

    // nested components: the Card's Text is its own element; the card is a plain container, so it
    // quotes none of its children's text (own text only, AGENT-TOOLS §3.3)
    const title = elements.find((element) => element.text === 'Account' && element.type === 'Text');
    expect(title).toBeDefined();
    expect(byTestID(elements, 'account-card').text).toBe('');
    expect(byTestID(elements, 'main-scroll').text).toBe('');

    // the Text inside a Pressable is folded into the Pressable
    expect(elements.filter((element) => element.type === 'Text' && element.text === 'Log in')).toHaveLength(0);
    // FlatList rows are listed
    expect(elements.some((element) => element.type === 'Text' && element.text === 'item one')).toBe(true);
  });

  test('own text only: an accessible element carries its inner text, a plain container quotes only its label', async () => {
    await mount(
      <View testID="plain" accessibilityLabel="Card">
        <View testID="bare">
          <Text testID="inner">Hello there</Text>
        </View>
        <Pressable testID="wrapper" onPress={() => {}}>
          <View>
            <Text>Log</Text>
            <Text> in</Text>
          </View>
        </Pressable>
        <View testID="marked" accessible>
          <Text>Marked text</Text>
        </View>
        <View testID="pressless" accessible={false}>
          <Text>Not read as one</Text>
        </View>
      </View>,
    );
    useFrames({});
    const { elements } = await tree({ all: true });
    expect(byTestID(elements, 'plain')).toMatchObject({ text: '', label: 'Card' });
    expect(byTestID(elements, 'bare').text).toBe('');
    expect(byTestID(elements, 'inner').text).toBe('Hello there');
    expect(byTestID(elements, 'wrapper')).toMatchObject({ text: 'Log in', role: 'button' });
    expect(byTestID(elements, 'marked').text).toBe('Marked text');
    expect(byTestID(elements, 'pressless').text).toBe('');
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

describe('defaultHitTester', () => {
  type Shadow = { id: string };

  /** Gives every host fiber with a testID a fake Fabric shadow node; returns them by testID. */
  function giveShadowNodes(): Record<string, { fiber: Fiber; node: Shadow }> {
    const found: Record<string, { fiber: Fiber; node: Shadow }> = {};
    const visit = (fiber: Fiber | null): void => {
      for (let f = fiber; f; f = f.sibling) {
        const props = f.memoizedProps as { testID?: unknown } | null;
        if (f.tag === 5 && typeof f.stateNode === 'object' && f.stateNode !== null) {
          const id = typeof props?.testID === 'string' ? props.testID : String(f.type);
          const node = { id };
          (f.stateNode as { node?: Shadow }).node = node;
          found[id] = { fiber: f, node };
        }
        visit(f.child);
      }
    };
    for (const root of getRoots()) visit(root.current.child);
    return found;
  }

  function fakeHitTest(answer: (node: Shadow) => Fiber | null): Shadow[] {
    const asked: Shadow[] = [];
    (globalThis as { nativeFabricUIManager?: unknown }).nativeFabricUIManager = {
      findNodeAtPoint: (node: Shadow, _x: number, _y: number, callback: (hit: unknown) => void) => {
        asked.push(node);
        callback(answer(node));
      },
    };
    return asked;
  }

  afterEach(() => {
    delete (globalThis as { nativeFabricUIManager?: unknown }).nativeFabricUIManager;
  });

  test("asks an open modal's content first: a modal is its own window over the screen", async () => {
    await mount(
      <View testID="screen">
        <View testID="chip" />
        <Native type="RCTModalHostView">
          <View testID="modal-content">
            <View testID="close" />
          </View>
        </Native>
        <View testID="after-modal" />
      </View>,
    );
    const nodes = giveShadowNodes();
    const asked = fakeHitTest((node) => (node.id === 'modal-content' ? nodes.close!.fiber : nodes.chip!.fiber));
    await expect(defaultHitTester(402, 289)).resolves.toBe(nodes.close!.fiber);
    expect(asked[0]).toBe(nodes['modal-content']!.node);
  });

  test('without a modal, asks the screen', async () => {
    await mount(
      <View testID="screen">
        <View testID="chip" />
      </View>,
    );
    const nodes = giveShadowNodes();
    const asked = fakeHitTest(() => nodes.chip!.fiber);
    await expect(defaultHitTester(10, 10)).resolves.toBe(nodes.chip!.fiber);
    expect(asked).toEqual([nodes.screen!.node]);
  });
});

describe('behind an open modal', () => {
  function Screen({ modals }: { modals: 'none' | 'one' | 'two' }) {
    return (
      <Native type="RNSTabsHostIOS">
        <Native type="RNSTabsScreenIOS" title="Today" screenKey="today-abc" pointerEvents="box-none">
          <View>
            <Pressable testID="behind" onPress={() => {}}>
              <Text>Behind</Text>
            </Pressable>
            {modals !== 'none' && (
              <Native type="RCTModalHostView">
                <View>
                  <Pressable testID="done" onPress={() => {}}>
                    <Text>Done</Text>
                  </Pressable>
                  {modals === 'two' && (
                    <Native type="RCTModalHostView">
                      <Pressable testID="top-close" onPress={() => {}}>
                        <Text>Close top</Text>
                      </Pressable>
                    </Native>
                  )}
                </View>
              </Native>
            )}
          </View>
        </Native>
        <Native type="RNSTabsScreenIOS" title="Nutrition" screenKey="nutrition-def" pointerEvents="none" />
      </Native>
    );
  }

  const ids = (elements: TaplineElement[]): Array<string | null> => elements.filter((e) => e.testID !== null).map((e) => e.testID);

  test('only the modal is listed, no tabs, and what is behind it is not a target; closing brings it all back', async () => {
    const renderer = await mount(<Screen modals="one" />);
    useFrames({});
    const open = await tree({});
    expect(ids(open.elements)).toEqual(['done']);
    expect(open.elements.some((e) => e.role === 'tab')).toBe(false);
    expect(open.elements.some((e) => e.text === 'Behind')).toBe(false);
    // v1.4: hidden only by the open sheet, so it is covered, not missing
    await expect(resolveTarget({ text: 'Behind' })).rejects.toMatchObject({ code: 'not_actionable', message: expect.stringMatching(/^covered: .* "Behind" .*is behind /) });
    await expect(resolveTarget({ text: 'Nothing like it' })).rejects.toMatchObject({ code: 'not_found' });
    expect((await resolveTarget({ text: 'Done' })).entry.info.testID).toBe('done');
    expect(nativeTabBar(takeSnapshot())).toBeNull();

    await act(async () => {
      renderer.update(<Screen modals="none" />);
    });
    const closed = await tree({});
    expect(ids(closed.elements)).toEqual(['behind']);
    expect(closed.elements.filter((e) => e.role === 'tab').map((e) => e.text)).toEqual(['Today', 'Nutrition']);
    expect((await resolveTarget({ text: 'Behind' })).entry.info.testID).toBe('behind');
    expect(nativeTabBar(takeSnapshot())).not.toBeNull();
  });

  test('with two modals open, only the topmost one is listed', async () => {
    await mount(<Screen modals="two" />);
    useFrames({});
    const { elements } = await tree({});
    expect(ids(elements)).toEqual(['top-close']);
  });
});
