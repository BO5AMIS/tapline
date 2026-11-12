import { frame, mount, unmountAll, useFrames } from './helpers';
import React from 'react';
import { Alert, Dimensions, PixelRatio, Pressable, Text, TextInput, View } from 'react-native';
import { act } from 'react-test-renderer';
import { configureActions, press, setKeyboardControl, typeText, type KeyboardControl } from '../src/actions';
import { installAlertTracking, TaplineAlertHost, uninstallAlertTracking } from '../src/alerts';
import { collectNodes, forgetLastTree, resetRefs, setHitTester, setMeasurer } from '../src/inspect';
import { isRecord, TaplineError } from '../src/types';

// Typing is a tap that focuses the input, then keys: type_text refuses what a person couldn't reach,
// with a tap's reasons, messages, order and `force` (quality bar R3).

// The safe-area insets the app's library reports: the navigation bar reaches y 91, the tab bar starts at y 717.
jest.mock(
  'react-native-safe-area-context',
  () => ({ initialWindowMetrics: { insets: { top: 47, bottom: 34, left: 0, right: 0 }, frame: { x: 0, y: 0, width: 400, height: 800 } } }),
  { virtual: true },
);

async function run<T>(fn: () => Promise<T>): Promise<T> {
  let result: T | undefined;
  await act(async () => {
    result = await fn();
  });
  return result as T;
}

async function failure(promise: Promise<unknown>): Promise<TaplineError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TaplineError) return error;
    throw error;
  }
  throw new Error('expected a TaplineError');
}

/** The mutable object React keeps for a host element (a test-renderer instance here). */
function hostInstance(testID: string): Record<string, unknown> {
  const node = collectNodes().find((candidate) => {
    const props = candidate.fiber.memoizedProps;
    return isRecord(props) && props.testID === testID;
  });
  const state = node?.fiber.stateNode;
  if (!isRecord(state)) throw new Error(`no host instance for ${testID}`);
  return state;
}

function fakeKeyboard(focused: unknown): { calls: string[]; control: KeyboardControl } {
  const calls: string[] = [];
  let current = focused;
  const control: KeyboardControl = {
    focusedInput: () => current,
    visible: () => true,
    dismiss: () => {
      calls.push('dismiss');
      current = null;
    },
    blur: () => {
      calls.push('blur');
      current = null;
    },
  };
  return { calls, control };
}

function Native({ type, children, ...props }: { type: string; children?: React.ReactNode } & Record<string, unknown>) {
  return React.createElement(type, props, children);
}

beforeAll(() => configureActions({ quietMs: 0, capMs: 0 }));

beforeEach(() => {
  resetRefs();
  forgetLastTree();
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 400, height: 800, scale: 2, fontScale: 1 });
  jest.spyOn(PixelRatio, 'get').mockReturnValue(2);
});

afterEach(async () => {
  await unmountAll();
  setMeasurer(null);
  setHitTester(null);
  setKeyboardControl(null);
  uninstallAlertTracking();
  jest.restoreAllMocks();
});

/** A refused typing leaves the input as it was and the keyboard alone. */
function expectUntouched(onChangeText: jest.Mock, calls: string[]): void {
  expect(onChangeText).not.toHaveBeenCalled();
  expect(calls).toEqual([]);
}

describe('behind an alert', () => {
  async function mountWithStandIn(onChangeText: jest.Mock): Promise<void> {
    installAlertTracking({ standIn: true });
    await mount(
      <View style={{ flex: 1 }}>
        <TextInput testID="field" onChangeText={onChangeText} />
        <Pressable testID="other" onPress={() => undefined}>
          <Text>Other</Text>
        </Pressable>
        <TaplineAlertHost />
      </View>,
    );
    useFrames({ field: frame(20, 100, 300, 40), other: frame(20, 200, 100, 40) });
    await act(async () => {
      Alert.alert('Delete item?', 'It will be gone', [{ text: 'Cancel', style: 'cancel' }, { text: 'OK' }]);
    });
  }

  test("Tapline's in-app alert: behind_alert, the same line a tap gets, nothing changes", async () => {
    const onChangeText = jest.fn();
    await mountWithStandIn(onChangeText);
    // another input holds focus: the keyboard must stay as it is
    const { calls, control } = fakeKeyboard({});
    setKeyboardControl(control);
    const error = await failure(run(() => typeText({ target: { testID: 'field' }, text: 'x' })));
    expect(error.code).toBe('not_actionable');
    expect(error.message).toBe('behind_alert: "Delete item?" is open with [Cancel] [OK]; tap one of them first.');
    const tap = await failure(run(() => press({ target: { testID: 'other' } })));
    expect(tap.message).toBe(error.message);
    expectUntouched(onChangeText, calls);
  });

  test('also with no target, when the only input is not the focused one', async () => {
    const onChangeText = jest.fn();
    await mountWithStandIn(onChangeText);
    const error = await failure(run(() => typeText({ text: 'x' })));
    expect(error.message).toMatch(/^behind_alert: /);
    expect(onChangeText).not.toHaveBeenCalled();
  });

  test('the alert also blocks typing into the input that has focus', async () => {
    const onChangeText = jest.fn();
    await mountWithStandIn(onChangeText);
    const { calls, control } = fakeKeyboard(hostInstance('field'));
    setKeyboardControl(control);
    const error = await failure(run(() => typeText({ target: { testID: 'field' }, text: 'x' })));
    expect(error.message).toBe('behind_alert: "Delete item?" is open with [Cancel] [OK]; tap one of them first.');
    expectUntouched(onChangeText, calls);
  });

  test('force: true types anyway, as it taps anyway', async () => {
    const onChangeText = jest.fn();
    await mountWithStandIn(onChangeText);
    const result = await run(() => typeText({ target: { testID: 'field' }, text: 'x', force: true }));
    expect(result.value).toBe('x');
    expect(onChangeText).toHaveBeenCalledWith('x');
  });

  test('an OS alert (record mode) is behind_alert too', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    installAlertTracking();
    const onChangeText = jest.fn();
    await mount(<TextInput testID="field" onChangeText={onChangeText} />);
    useFrames({ field: frame(20, 100, 300, 40) });
    Alert.alert('Heads up', 'Something happened.', [{ text: 'OK' }]);
    const error = await failure(run(() => typeText({ target: { testID: 'field' }, text: 'x' })));
    expect(error.message).toMatch(/^behind_alert: An alert is open: "Heads up" \[OK\]/);
    expect(onChangeText).not.toHaveBeenCalled();
    await run(() => typeText({ target: { testID: 'field' }, text: 'x', force: true }));
    expect(onChangeText).toHaveBeenCalledWith('x');
  });
});

describe('covered by an overlay', () => {
  async function mountCovered(onChangeText: jest.Mock): Promise<{ veil: () => ReturnType<typeof collectNodes>[number] }> {
    await mount(
      <View>
        <TextInput testID="field" onChangeText={onChangeText} />
        <View testID="veil" />
      </View>,
    );
    useFrames({ field: frame(20, 100, 300, 40), veil: frame(0, 90, 400, 100) });
    const veil = (): ReturnType<typeof collectNodes>[number] => {
      const node = collectNodes().find((candidate) => isRecord(candidate.fiber.memoizedProps) && candidate.fiber.memoizedProps.testID === 'veil');
      if (!node) throw new Error('no veil');
      return node;
    };
    setHitTester(async () => veil().fiber);
    return { veil };
  }

  test('covered, with the tap\'s wording; nothing changes', async () => {
    const onChangeText = jest.fn();
    await mountCovered(onChangeText);
    const { calls, control } = fakeKeyboard({});
    setKeyboardControl(control);
    const error = await failure(run(() => typeText({ target: { testID: 'field' }, text: 'x' })));
    expect(error.code).toBe('not_actionable');
    expect(error.message).toMatch(/^covered: e\d+ input id=field is covered at \(170, 120\) by /);
    expect(error.message).toContain('a real tap would land there instead.');
    expect(error.message).toContain('or pass force: true to call the handler anyway.');
    expectUntouched(onChangeText, calls);
  });

  test('force: true types anyway', async () => {
    const onChangeText = jest.fn();
    await mountCovered(onChangeText);
    const result = await run(() => typeText({ target: { testID: 'field' }, text: 'x', force: true }));
    expect(result.value).toBe('x');
    expect(onChangeText).toHaveBeenCalledWith('x');
  });
});

describe('under the bars iOS draws', () => {
  test('under the navigation bar: covered, with the bar wording; force types', async () => {
    const onChangeText = jest.fn();
    await mount(
      <Native type="RNSScreenStack">
        <Native type="RNSScreen">
          <Native type="RNSScreenStackHeaderConfig" translucent title="Lab" />
          <View>
            <TextInput testID="field" onChangeText={onChangeText} />
          </View>
        </Native>
      </Native>,
    );
    // The bar reaches y 91; 6 pt of the field show below it: too little to touch.
    useFrames({ field: frame(20, 57, 360, 40) });
    const { calls, control } = fakeKeyboard({});
    setKeyboardControl(control);
    const error = await failure(run(() => typeText({ target: { testID: 'field' }, text: 'x' })));
    expect(error.code).toBe('not_actionable');
    expect(error.message).toMatch(/^covered: /);
    expect(error.message).toContain('is under the navigation bar iOS draws, at (200, 77): a real tap would hit the bar instead.');
    expect(error.message).toContain('Scroll it clear of the bar (scroll with this target and to: "target"), or pass force: true to call its handler anyway.');
    expectUntouched(onChangeText, calls);
    await run(() => typeText({ target: { testID: 'field' }, text: 'x', force: true }));
    expect(onChangeText).toHaveBeenCalledWith('x');
  });

  test('under the tab bar: under_tab_bar, with the bar wording; force types', async () => {
    const onChangeText = jest.fn();
    await mount(
      <View>
        {React.createElement(
          'RNSTabsHostIOS',
          null,
          React.createElement(
            'RNSTabsScreenIOS',
            { title: 'Today', screenKey: 'today-a', pointerEvents: 'box-none' },
            <TextInput testID="field" onChangeText={onChangeText} />,
          ),
          React.createElement('RNSTabsScreenIOS', { title: 'Steps', screenKey: 'steps-b', pointerEvents: 'none' }),
        )}
      </View>,
    );
    // The bar starts at y 717; 8 pt of the field show above it.
    useFrames({ field: frame(0, 709, 400, 80) });
    const { calls, control } = fakeKeyboard({});
    setKeyboardControl(control);
    const error = await failure(run(() => typeText({ target: { testID: 'field' }, text: 'x' })));
    expect(error.code).toBe('not_actionable');
    expect(error.message).toMatch(/^under_tab_bar: /);
    expect(error.message).toContain('is under the tab bar iOS draws, at (200, 749): a real tap would switch tabs instead.');
    expect(error.message).toContain('Scroll it clear of the bar (scroll with this target and to: "target"), or pass force: true to call its handler anyway.');
    expectUntouched(onChangeText, calls);
    await run(() => typeText({ target: { testID: 'field' }, text: 'x', force: true }));
    expect(onChangeText).toHaveBeenCalledWith('x');
  });

  test('mostly under the tab bar, but enough shows: it is typed into, as a tap would reach it', async () => {
    const onChangeText = jest.fn();
    await mount(
      <View>
        {React.createElement(
          'RNSTabsHostIOS',
          null,
          React.createElement(
            'RNSTabsScreenIOS',
            { title: 'Today', screenKey: 'today-a', pointerEvents: 'box-none' },
            <TextInput testID="field" onChangeText={onChangeText} />,
          ),
          React.createElement('RNSTabsScreenIOS', { title: 'Steps', screenKey: 'steps-b', pointerEvents: 'none' }),
        )}
      </View>,
    );
    useFrames({ field: frame(0, 700, 400, 90) }); // visible 700 to 717
    await run(() => typeText({ target: { testID: 'field' }, text: 'x' }));
    expect(onChangeText).toHaveBeenCalledWith('x');
  });
});

describe('off screen', () => {
  test('off_screen with the tap\'s wording; force types', async () => {
    const onChangeText = jest.fn();
    await mount(<TextInput testID="field" onChangeText={onChangeText} />);
    useFrames({ field: frame(20, 900, 300, 40) });
    const { calls, control } = fakeKeyboard({});
    setKeyboardControl(control);
    const error = await failure(run(() => typeText({ target: { testID: 'field' }, text: 'x' })));
    expect(error.code).toBe('not_actionable');
    expect(error.message).toMatch(/^off_screen: e\d+ input id=field is off screen \(at 20,900; the screen is 400x800\)\. /);
    // Not inside a scroll view (AGENT-TOOLS 1.12 §16.2): the refusal says why no scroll helps.
    expect(error.message).toContain("It isn't inside a scroll view, so no scroll can bring it on screen; pass force: true to call its handler anyway.");
    expectUntouched(onChangeText, calls);
    await run(() => typeText({ target: { testID: 'field' }, text: 'x', force: true }));
    expect(onChangeText).toHaveBeenCalledWith('x');
  });

  test('an unmeasurable input is let through, as for a tap', async () => {
    const onChangeText = jest.fn();
    await mount(<TextInput testID="field" onChangeText={onChangeText} />);
    setMeasurer(async () => null);
    await run(() => typeText({ target: { testID: 'field' }, text: 'x' }));
    expect(onChangeText).toHaveBeenCalledWith('x');
  });
});

describe('behind an open Modal', () => {
  test('the v1.4 covered answer, force does not help, nothing changes', async () => {
    const onChangeText = jest.fn();
    await mount(
      <View>
        <TextInput testID="behind-input" onChangeText={onChangeText} />
        {React.createElement(
          'RCTModalHostView',
          { visible: true },
          <View>
            <Text>Lab sheet</Text>
          </View>,
        )}
      </View>,
    );
    useFrames({ 'behind-input': frame(20, 100, 300, 40), 'Lab sheet': frame(20, 620, 390, 22) });
    const { calls, control } = fakeKeyboard({});
    setKeyboardControl(control);
    const error = await failure(run(() => typeText({ target: { testID: 'behind-input' }, text: 'x' })));
    expect(error.code).toBe('not_actionable');
    expect(error.message).toMatch(/^covered: input id=behind-input @20,100 300x40 is behind e\d+ text "Lab sheet" @20,620 390x22; close that first\.$/);
    const forced = await failure(run(() => typeText({ target: { testID: 'behind-input' }, text: 'x', force: true })));
    expect(forced.message).toBe(error.message);
    expectUntouched(onChangeText, calls);
  });
});

describe('disabled', () => {
  test('disabled comes first and force never helps; no alert order change', async () => {
    const onChangeText = jest.fn();
    await mount(<TextInput testID="ro" editable={false} onChangeText={onChangeText} />);
    useFrames({ ro: frame(20, 900, 300, 40) }); // off screen too: disabled still wins, as for a tap
    const { calls, control } = fakeKeyboard({});
    setKeyboardControl(control);
    const error = await failure(run(() => typeText({ target: { testID: 'ro' }, text: 'x' })));
    expect(error.message).toMatch(/^disabled: e\d+ input id=ro is not editable; the app has to enable it first \(force doesn't apply\)\.$/);
    const forced = await failure(run(() => typeText({ target: { testID: 'ro' }, text: 'x', force: true })));
    expect(forced.message).toBe(error.message);
    expectUntouched(onChangeText, calls);
  });
});

describe('what a person can do stays allowed', () => {
  test('no target, with an input in focus: types, even behind an overlay or off screen', async () => {
    const onChangeText = jest.fn();
    await mount(
      <View>
        <TextInput testID="first" onChangeText={onChangeText} />
        <TextInput testID="second" />
        <View testID="veil" />
      </View>,
    );
    useFrames({ first: frame(20, 900, 300, 40), second: frame(20, 150, 300, 40), veil: frame(0, 0, 400, 800) });
    const veil = collectNodes().find((candidate) => isRecord(candidate.fiber.memoizedProps) && candidate.fiber.memoizedProps.testID === 'veil');
    if (!veil) throw new Error('no veil');
    setHitTester(async () => veil.fiber);
    const { calls, control } = fakeKeyboard(hostInstance('first'));
    setKeyboardControl(control);
    const result = await run(() => typeText({ text: 'hello' }));
    expect(result.value).toBe('hello');
    expect(onChangeText).toHaveBeenCalledWith('hello');
    expect(calls).toEqual([]);
    expect(result).not.toHaveProperty('closedKeyboard');
  });

  test('the targeted input is the focused one: types without a reachability check, leaves the keyboard up', async () => {
    const onChangeText = jest.fn();
    await mount(
      <View>
        <TextInput testID="field" onChangeText={onChangeText} />
        <View testID="veil" />
      </View>,
    );
    // under the keyboard's area and under a veil: Tapline can't see the keyboard, and a person is typing
    useFrames({ field: frame(20, 760, 300, 40), veil: frame(0, 700, 400, 100) });
    const veil = collectNodes().find((candidate) => isRecord(candidate.fiber.memoizedProps) && candidate.fiber.memoizedProps.testID === 'veil');
    if (!veil) throw new Error('no veil');
    setHitTester(async () => veil.fiber);
    const { calls, control } = fakeKeyboard(hostInstance('field'));
    setKeyboardControl(control);
    const result = await run(() => typeText({ target: { testID: 'field' }, text: 'abc' }));
    expect(result.value).toBe('abc');
    expect(onChangeText).toHaveBeenCalledWith('abc');
    expect(calls).toEqual([]);
    expect(result).not.toHaveProperty('closedKeyboard');
    // a tap on that same input is still checked: only typing has the exception
    const tap = await failure(run(() => press({ target: { testID: 'field' } })));
    expect(tap.message).toMatch(/^covered: /);
  });

  test('a reachable input that is not focused is typed into, and the keyboard closes first', async () => {
    const onChangeText = jest.fn();
    await mount(
      <View>
        <TextInput testID="first" />
        <TextInput testID="second" onChangeText={onChangeText} />
      </View>,
    );
    useFrames({ first: frame(20, 100, 300, 40), second: frame(20, 150, 300, 40) });
    setHitTester(async () => hostInstanceFiber('second'));
    const { calls, control } = fakeKeyboard(hostInstance('first'));
    setKeyboardControl(control);
    const result = await run(() => typeText({ target: { testID: 'second' }, text: 'hi' }));
    expect(result.closedKeyboard).toBe(true);
    expect(calls).toEqual(['dismiss']);
    expect(onChangeText).toHaveBeenCalledWith('hi');
  });

  test('submit and replace behave as before once the checks pass', async () => {
    const onChangeText = jest.fn();
    const onSubmit = jest.fn();
    await mount(<TextInput testID="field" defaultValue="seed" onChangeText={onChangeText} onSubmitEditing={onSubmit} />);
    useFrames({ field: frame(20, 100, 300, 40) });
    const appended = await run(() => typeText({ target: { testID: 'field' }, text: '+', replace: false, submit: true }));
    expect(appended.value).toBe('seed+');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const replaced = await run(() => typeText({ target: { testID: 'field' }, text: 'new' }));
    expect(replaced.value).toBe('new');
  });

  test('a refusal before the keyboard closes: the focused keyboard is left up and nothing is submitted', async () => {
    const onSubmit = jest.fn();
    const onChangeText = jest.fn();
    await mount(
      <View>
        <TextInput testID="first" />
        <TextInput testID="second" onChangeText={onChangeText} onSubmitEditing={onSubmit} />
      </View>,
    );
    useFrames({ first: frame(20, 100, 300, 40), second: frame(20, 900, 300, 40) });
    const { calls, control } = fakeKeyboard(hostInstance('first'));
    setKeyboardControl(control);
    const error = await failure(run(() => typeText({ target: { testID: 'second' }, text: 'x', submit: true })));
    expect(error.message).toMatch(/^off_screen: /);
    expect(onSubmit).not.toHaveBeenCalled();
    expectUntouched(onChangeText, calls);
  });
});

function hostInstanceFiber(testID: string): NonNullable<ReturnType<typeof collectNodes>[number]>['fiber'] {
  const node = collectNodes().find((candidate) => isRecord(candidate.fiber.memoizedProps) && candidate.fiber.memoizedProps.testID === testID);
  if (!node) throw new Error(`no host for ${testID}`);
  return node.fiber;
}
