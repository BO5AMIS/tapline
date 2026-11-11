import { frame, mount, unmountAll, useFrames } from './helpers';
import React, { useState } from 'react';
import { Alert, Dimensions, PixelRatio, Pressable, Switch, Text, TextInput, View } from 'react-native';
import { act } from 'react-test-renderer';
import { back, configureActions, longPress, press, setKeyboardControl, toggle, typeText, type KeyboardControl } from '../src/actions';
import { installAlertTracking, uninstallAlertTracking } from '../src/alerts';
import { collectNodes, forgetLastTree, resetRefs, setHitTester, setMeasurer, tree } from '../src/inspect';
import { isRecord, TaplineError } from '../src/types';

// AGENT-TOOLS v1.4 in the SDK: the keyboard closes first, a target behind a sheet is `covered`,
// `back` closes a sheet, and refs keep counting through an action's answers.

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

beforeAll(() => configureActions({ quietMs: 0, capMs: 0 }));

beforeEach(() => {
  resetRefs();
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

describe('the keyboard closes first', () => {
  /** A keyboard with the given input focused; records what the SDK asked of it. */
  function fakeKeyboard(
    focused: unknown,
    options: { visible?: boolean; dismissBlurs?: boolean; top?: number; focusTakes?: boolean } = {},
  ): { calls: string[]; control: KeyboardControl } {
    const calls: string[] = [];
    let current = focused;
    const control: KeyboardControl = {
      focusedInput: () => current,
      visible: () => options.visible !== false,
      dismiss: () => {
        calls.push('dismiss');
        if (options.dismissBlurs !== false) current = null;
      },
      blur: () => {
        calls.push('blur');
        current = null;
      },
      ...(options.top !== undefined
        ? {
            top: () => options.top ?? null,
            focus: (instances: unknown[]) => {
              calls.push('focus');
              if (options.focusTakes !== false) current = instances[0];
            },
          }
        : {}),
    };
    return { calls, control };
  }

  async function mountForm(spies: { go: jest.Mock; flip: jest.Mock; long: jest.Mock }): Promise<void> {
    await mount(
      <View>
        <TextInput testID="first" />
        <TextInput testID="second" />
        <Pressable testID="go" onPress={spies.go} onLongPress={spies.long}>
          <Text>Go</Text>
        </Pressable>
        <Pressable testID="off" disabled onPress={() => undefined}>
          <Text>Off</Text>
        </Pressable>
        <Switch testID="flip" value={false} onValueChange={spies.flip} />
      </View>,
    );
    useFrames({
      first: frame(20, 100, 300, 40),
      second: frame(20, 150, 300, 40),
      go: frame(20, 200, 100, 40),
      off: frame(20, 250, 100, 40),
      flip: frame(20, 300, 60, 32),
    });
  }

  function makeSpies(): { go: jest.Mock; flip: jest.Mock; long: jest.Mock } {
    return { go: jest.fn(), flip: jest.fn(), long: jest.fn() };
  }

  test('a tap on another control closes the keyboard first and says so', async () => {
    const spies = makeSpies();
    await mountForm(spies);
    const { calls, control } = fakeKeyboard(hostInstance('first'));
    setKeyboardControl(control);
    spies.go.mockImplementation(() => calls.push('handler'));
    const result = await run(() => press({ target: { testID: 'go' } }));
    expect(calls).toEqual(['dismiss', 'handler']);
    expect(result.closedKeyboard).toBe(true);
  });

  test('long press and toggle close it too', async () => {
    const spies = makeSpies();
    await mountForm(spies);
    const first = fakeKeyboard(hostInstance('first'));
    setKeyboardControl(first.control);
    const pressed = await run(() => longPress({ target: { testID: 'go' } }));
    expect(first.calls).toEqual(['dismiss']);
    expect(pressed.closedKeyboard).toBe(true);
    expect(spies.long).toHaveBeenCalledTimes(1);

    const second = fakeKeyboard(hostInstance('first'));
    setKeyboardControl(second.control);
    const flipped = await run(() => toggle({ target: { testID: 'flip' } }));
    expect(second.calls).toEqual(['dismiss']);
    expect(flipped.closedKeyboard).toBe(true);
    expect(spies.flip).toHaveBeenCalledWith(true);
  });

  test('typing into the input that is focused never closes it', async () => {
    const spies = makeSpies();
    await mountForm(spies);
    const { calls, control } = fakeKeyboard(hostInstance('first'));
    setKeyboardControl(control);
    const result = await run(() => typeText({ target: { testID: 'first' }, text: 'abc' }));
    expect(calls).toEqual([]);
    expect(result).not.toHaveProperty('closedKeyboard');
    const noTarget = await run(() => typeText({ text: 'abcd' }));
    expect(calls).toEqual([]);
    expect(noTarget).not.toHaveProperty('closedKeyboard');
  });

  test('a tap on the focused input itself leaves the keyboard up', async () => {
    const spies = makeSpies();
    await mountForm(spies);
    const { calls, control } = fakeKeyboard(hostInstance('first'));
    setKeyboardControl(control);
    const result = await run(() => press({ target: { testID: 'first' } }));
    expect(calls).toEqual([]);
    expect(result).not.toHaveProperty('closedKeyboard');
  });

  test('typing into another input above the keyboard moves the focus there and leaves the keyboard up (v1.6)', async () => {
    const spies = makeSpies();
    await mountForm(spies);
    // The keyboard's top edge at y 400: "second" (150 to 190) shows above it.
    const { calls, control } = fakeKeyboard(hostInstance('first'), { top: 400 });
    setKeyboardControl(control);
    const result = await run(() => typeText({ target: { testID: 'second' }, text: 'hi' }));
    expect(calls).toEqual(['focus']);
    expect(control.focusedInput()).toBe(hostInstance('second'));
    expect(result).not.toHaveProperty('closedKeyboard');
    expect(result.value).toBe('hi');
  });

  test('another input with less than 10 pt above the keyboard closes the keyboard first', async () => {
    const spies = makeSpies();
    await mountForm(spies);
    // second: 150 to 190; the keyboard's top at 158 leaves 8 pt of it showing.
    const { calls, control } = fakeKeyboard(hostInstance('first'), { top: 158 });
    setKeyboardControl(control);
    const result = await run(() => typeText({ target: { testID: 'second' }, text: 'hi' }));
    expect(calls).toEqual(['dismiss']);
    expect(result.closedKeyboard).toBe(true);
  });

  test('one with at least 10 pt above the keyboard, partly under it, takes the focus: a finger reaches the part that shows', async () => {
    const spies = makeSpies();
    await mountForm(spies);
    const { calls, control } = fakeKeyboard(hostInstance('first'), { top: 167 });
    setKeyboardControl(control);
    const result = await run(() => typeText({ target: { testID: 'second' }, text: 'hi' }));
    expect(calls).toEqual(['focus']);
    expect(result).not.toHaveProperty('closedKeyboard');
  });

  test('when the focus does not move, the keyboard is closed the old way', async () => {
    const spies = makeSpies();
    await mountForm(spies);
    const { calls, control } = fakeKeyboard(hostInstance('first'), { top: 400, focusTakes: false });
    setKeyboardControl(control);
    const result = await run(() => typeText({ target: { testID: 'second' }, text: 'hi' }));
    expect(calls).toEqual(['focus', 'dismiss']);
    expect(result.closedKeyboard).toBe(true);
    expect(result.value).toBe('hi');
  });

  test('a tap on another input still closes the keyboard: only typing moves the focus', async () => {
    const spies = makeSpies();
    await mountForm(spies);
    const { calls, control } = fakeKeyboard(hostInstance('first'), { top: 400 });
    setKeyboardControl(control);
    const result = await run(() => press({ target: { testID: 'second' } }));
    expect(calls).toEqual(['dismiss']);
    expect(result.closedKeyboard).toBe(true);
  });

  test('typing into another input closes the keyboard first when it is not known where the keyboard is', async () => {
    const spies = makeSpies();
    await mountForm(spies);
    const { calls, control } = fakeKeyboard(hostInstance('first'));
    setKeyboardControl(control);
    const result = await run(() => typeText({ target: { testID: 'second' }, text: 'hi' }));
    expect(calls).toEqual(['dismiss']);
    expect(result.closedKeyboard).toBe(true);
    expect(result.value).toBe('hi');
  });

  test('when dismiss leaves the input focused, it is blurred', async () => {
    const spies = makeSpies();
    await mountForm(spies);
    const { calls, control } = fakeKeyboard(hostInstance('first'), { dismissBlurs: false });
    setKeyboardControl(control);
    const result = await run(() => press({ target: { testID: 'go' } }));
    expect(calls).toEqual(['dismiss', 'blur']);
    expect(result.closedKeyboard).toBe(true);
  });

  test('no focused input, or no keyboard on screen: nothing is closed', async () => {
    const spies = makeSpies();
    await mountForm(spies);
    const none = fakeKeyboard(null);
    setKeyboardControl(none.control);
    expect(await run(() => press({ target: { testID: 'go' } }))).not.toHaveProperty('closedKeyboard');
    const hidden = fakeKeyboard(hostInstance('first'), { visible: false });
    setKeyboardControl(hidden.control);
    expect(await run(() => press({ target: { testID: 'go' } }))).not.toHaveProperty('closedKeyboard');
    expect(none.calls).toEqual([]);
    expect(hidden.calls).toEqual([]);
  });

  test('a refused action leaves the keyboard alone', async () => {
    const spies = makeSpies();
    await mountForm(spies);
    const { calls, control } = fakeKeyboard(hostInstance('first'));
    setKeyboardControl(control);
    // disabled
    expect((await failure(run(() => press({ target: { testID: 'off' } })))).message).toMatch(/^disabled: /);
    // not found
    expect((await failure(run(() => press({ target: { testID: 'nope' } })))).code).toBe('not_found');
    // covered
    const veil = collectNodes().filter((n) => n.hostType === 'View').pop();
    if (!veil) throw new Error('no view');
    setHitTester(async () => veil.fiber);
    expect((await failure(run(() => press({ target: { testID: 'go' } })))).message).toMatch(/^covered: /);
    // typing into an input that does not exist
    expect((await failure(run(() => typeText({ target: { testID: 'missing' }, text: 'x' })))).code).toBe('not_found');
    expect(calls).toEqual([]);
    expect(spies.go).not.toHaveBeenCalled();
  });

  test('ambiguous targets are refused before the keyboard closes', async () => {
    await mount(
      <View>
        <TextInput testID="first" />
        <Pressable onPress={() => undefined}>
          <Text>Same</Text>
        </Pressable>
        <Pressable onPress={() => undefined}>
          <Text>Same</Text>
        </Pressable>
      </View>,
    );
    useFrames({ first: frame(20, 100, 300, 40) });
    const { calls, control } = fakeKeyboard(hostInstance('first'));
    setKeyboardControl(control);
    expect((await failure(run(() => press({ target: { text: 'Same' } })))).code).toBe('ambiguous');
    expect(calls).toEqual([]);
  });
});

describe('a target behind an open sheet is covered', () => {
  const onSave = jest.fn();
  const onClose = jest.fn();
  const onRequestClose = jest.fn();

  async function mountScreen(options: { modal?: boolean; withRequestClose?: boolean } = {}): Promise<void> {
    await mount(
      <View>
        <Pressable testID="save" onPress={onSave}>
          <Text>Save</Text>
        </Pressable>
        <Pressable testID="again" accessibilityLabel="Again" onPress={() => undefined}>
          <Text>Again</Text>
        </Pressable>
        <Pressable accessibilityLabel="Twin" onPress={() => undefined} />
        <Pressable accessibilityLabel="Twin" onPress={() => undefined} />
        <TextInput testID="behind-input" />
        <Switch testID="behind-switch" value={false} onValueChange={() => undefined} />
        {options.modal === false
          ? null
          : React.createElement(
              'RCTModalHostView',
              options.withRequestClose === false ? { visible: true } : { visible: true, onRequestClose },
              <View>
                <Text>Lab sheet</Text>
                <Pressable testID="close" onPress={onClose}>
                  <Text>Close</Text>
                </Pressable>
              </View>,
            )}
      </View>,
    );
    useFrames({
      save: frame(16, 300, 193, 48),
      again: frame(16, 360, 100, 40),
      'Lab sheet': frame(20, 620, 390, 22),
      close: frame(20, 660, 100, 40),
    });
  }

  beforeEach(() => {
    onSave.mockClear();
    onClose.mockClear();
    onRequestClose.mockClear();
  });

  test('the answer names the hidden element and what is in front, with its ref', async () => {
    await mountScreen();
    // a look first: the ref in the answer is the ref that look gave the element in front
    const front = (await tree({})).elements.find((element) => element.text === 'Lab sheet');
    const error = await failure(run(() => press({ target: { testID: 'save' } })));
    expect(error.code).toBe('not_actionable');
    expect(error.message).toBe(`covered: button "Save" id=save @16,300 193x48 is behind ${front?.ref} text "Lab sheet" @20,620 390x22; close that first.`);
    expect(front?.ref).toBe('e1');
    expect(onSave).not.toHaveBeenCalled();
  });

  test('by text and by label, for every action', async () => {
    await mountScreen();
    expect((await failure(run(() => press({ target: { text: 'Save' } })))).message).toMatch(/^covered: button "Save" id=save @16,300 193x48 is behind e\d+ text "Lab sheet"/);
    expect((await failure(run(() => longPress({ target: { label: 'Again' } })))).message).toMatch(/^covered: button "Again" id=again @16,360 100x40 is behind /);
    expect((await failure(run(() => toggle({ target: { testID: 'behind-switch' } })))).message).toMatch(/^covered: switch id=behind-switch .*is behind /);
    expect((await failure(run(() => typeText({ target: { testID: 'behind-input' }, text: 'x' })))).message).toMatch(/^covered: input id=behind-input .*is behind /);
  });

  test('force: true does not help: the hidden element is not on the list', async () => {
    await mountScreen();
    const plain = await failure(run(() => press({ target: { testID: 'save' } })));
    const forced = await failure(run(() => press({ target: { testID: 'save' }, force: true })));
    expect(forced.message).toBe(plain.message);
    expect(onSave).not.toHaveBeenCalled();
  });

  test('without a measurable frame the position is left out', async () => {
    await mountScreen();
    setMeasurer(async () => null);
    const error = await failure(run(() => press({ target: { testID: 'save' } })));
    expect(error.message).toBe('covered: button "Save" id=save is behind e1 text "Lab sheet"; close that first.');
  });

  test('several hidden matches: the same covered answer for the first, no ambiguous block', async () => {
    await mountScreen();
    const error = await failure(run(() => press({ target: { label: 'Twin' } })));
    expect(error.code).toBe('not_actionable');
    expect(error.message).toMatch(/^covered: button "Twin" /);
    expect(error.refs).toBeUndefined();
  });

  test('a ref target keeps today\'s answer; an unknown target is still not_found', async () => {
    await mountScreen();
    await tree({});
    expect((await failure(run(() => press({ target: { ref: 'e99' } })))).code).toBe('not_found');
    expect((await failure(run(() => press({ target: { testID: 'nothing-here' } })))).code).toBe('not_found');
  });

  test('what the sheet lists is still reachable', async () => {
    await mountScreen();
    await run(() => press({ target: { testID: 'close' } }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('no sheet open: a missing target is not_found as before, a present one works', async () => {
    await mountScreen({ modal: false });
    await run(() => press({ target: { testID: 'save' } }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect((await failure(run(() => press({ target: { testID: 'close' } })))).code).toBe('not_found');
  });

  test('an OS alert still answers behind_alert first', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    installAlertTracking();
    await mountScreen();
    Alert.alert('Heads up', 'Something happened.');
    const error = await failure(run(() => press({ target: { testID: 'save' } })));
    expect(error.message).toMatch(/^behind_alert: /);
  });

  test('a sheet with no text or id to name falls back to "the open sheet"', async () => {
    await mount(
      <View>
        <Pressable testID="save" onPress={onSave}>
          <Text>Save</Text>
        </Pressable>
        {React.createElement('RCTModalHostView', { visible: true }, <View />)}
      </View>,
    );
    useFrames({ save: frame(16, 300, 193, 48) });
    const error = await failure(run(() => press({ target: { testID: 'save' } })));
    expect(error.message).toBe('covered: button "Save" id=save @16,300 193x48 is behind the open sheet; close that first.');
  });

  describe('back closes the open sheet', () => {
    test('calls the Modal\'s onRequestClose and says it closed a sheet', async () => {
      await mountScreen();
      const result = await run(() => back({}));
      expect(onRequestClose).toHaveBeenCalledTimes(1);
      expect(result.closed).toBe('sheet');
      expect(result.settledMs).toBe(0);
    });

    test('a Modal without onRequestClose: no_action naming the sheet by what it shows, nothing is called', async () => {
      await mountScreen({ withRequestClose: false });
      const error = await failure(run(() => back({})));
      expect(error.code).toBe('not_actionable');
      expect(error.message).toBe(
        'no_action: the open sheet (in front: e1 text "Lab sheet" @20,620 390x22) has nothing for back to call (its Modal has no onRequestClose); tap its close control.',
      );
      expect(onClose).not.toHaveBeenCalled();
    });

    test('a sheet that closes on a tap on its backdrop: back taps the backdrop', async () => {
      const onBackdrop = jest.fn();
      await mount(
        <View>
          <Text>behind</Text>
          {React.createElement(
            'RCTModalHostView',
            { visible: true },
            <View>
              <Pressable testID="backdrop" accessible={false} onPress={onBackdrop} />
              <View testID="panel">
                <Text>Backdrop sheet</Text>
                <Pressable testID="inside" onPress={onClose}>
                  <Text>Inside</Text>
                </Pressable>
              </View>
            </View>,
          )}
        </View>,
      );
      useFrames({ backdrop: frame(0, 0, 400, 800), panel: frame(0, 560, 400, 240), inside: frame(20, 640, 360, 48) });
      const result = await run(() => back({}));
      expect(onBackdrop).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
      expect(result.closed).toBe('sheet');
    });

    test('a full-screen control with a text of its own is no backdrop', async () => {
      const onContinue = jest.fn();
      await mount(
        <View>
          {React.createElement(
            'RCTModalHostView',
            { visible: true },
            <Pressable testID="whole" onPress={onContinue}>
              <Text>Tap to continue</Text>
            </Pressable>,
          )}
        </View>,
      );
      useFrames({ whole: frame(0, 0, 400, 800) });
      expect((await failure(run(() => back({})))).message).toMatch(/^no_action: /);
      expect(onContinue).not.toHaveBeenCalled();
    });

    test('a pressable that does not cover the screen is no backdrop: no_action', async () => {
      const onSmall = jest.fn();
      await mount(
        <View>
          {React.createElement(
            'RCTModalHostView',
            { visible: true },
            <View>
              <Text>Lab sheet</Text>
              <Pressable testID="small" onPress={onSmall}>
                <Text>Small</Text>
              </Pressable>
            </View>,
          )}
        </View>,
      );
      useFrames({ 'Lab sheet': frame(20, 620, 390, 22), small: frame(20, 660, 100, 40) });
      const error = await failure(run(() => back({})));
      expect(error.message).toMatch(/^no_action: the open sheet \(in front: /);
      expect(onSmall).not.toHaveBeenCalled();
    });

    test('a sheet with nothing to name it by: the same answer without the brackets', async () => {
      await mount(<View>{React.createElement('RCTModalHostView', { visible: true }, <View />)}</View>);
      const error = await failure(run(() => back({})));
      expect(error.message).toBe(
        'no_action: the open sheet has nothing for back to call (its Modal has no onRequestClose); tap its close control.',
      );
    });

    test('with no sheet, back behaves as before', async () => {
      await mountScreen({ modal: false });
      const error = await failure(run(() => back({})));
      expect(error.code).toBe('unsupported');
    });

    test('a sheet that is already closing is not closed again', async () => {
      await mount(
        <View>
          <Text>behind</Text>
          {React.createElement('RCTModalHostView', { visible: false, onRequestClose }, <Text>sheet</Text>)}
        </View>,
      );
      const error = await failure(run(() => back({})));
      expect(error.code).toBe('unsupported');
      expect(onRequestClose).not.toHaveBeenCalled();
    });
  });
});

describe('refs keep counting through an action answer', () => {
  /** Two screens that share nothing; a button swaps them. */
  async function mountSwapper(): Promise<void> {
    function Swapper(): React.ReactElement {
      const [second, setSecond] = useState(false);
      return second ? (
        <View key="b">
          <Text testID="b-title">Second screen</Text>
          <Pressable testID="b-go" onPress={() => undefined}>
            <Text>Next</Text>
          </Pressable>
        </View>
      ) : (
        <View key="a">
          <Text testID="a-title">First screen</Text>
          <Pressable testID="a-swap" onPress={() => setSecond(true)}>
            <Text>Swap</Text>
          </Pressable>
          <Pressable testID="a-other" onPress={() => undefined}>
            <Text>Other</Text>
          </Pressable>
        </View>
      );
    }
    await mount(<Swapper />);
    useFrames({});
  }

  const refNumber = (ref: string): number => Number(ref.slice(1));

  test('a look starts at e1 again, every time', async () => {
    await mountSwapper();
    const first = await tree({});
    const second = await tree({});
    expect(first.elements[0]?.ref).toBe('e1');
    expect(second.elements[0]?.ref).toBe('e1');
  });

  test('after the screen changes completely, new elements count on from the highest ref given', async () => {
    await mountSwapper();
    const look = await tree({});
    const earlier = look.elements.map((element) => element.ref);
    const swapRef = look.elements.find((element) => element.testID === 'a-swap')?.ref;
    if (swapRef === undefined) throw new Error('no swap button');
    await run(() => press({ target: { ref: swapRef } }));
    // what the host asks for in an action's answer
    const after = await tree({ changes: true });
    expect(after.elements.map((element) => element.testID)).toEqual(['b-title', 'b-go'].map((id) => id));
    const highest = Math.max(...earlier.map(refNumber));
    for (const element of after.elements) expect(refNumber(element.ref)).toBeGreaterThan(highest);
    // an old ref never lands on another element
    expect((await failure(run(() => press({ target: { ref: swapRef } })))).code).toBe('not_found');
    const otherRef = earlier.find((ref) => ref !== swapRef);
    if (otherRef === undefined) throw new Error('no other ref');
    expect((await failure(run(() => press({ target: { ref: otherRef } })))).code).toBe('not_found');
  });

  test('what stayed on screen keeps its ref', async () => {
    await mountSwapper();
    const look = await tree({});
    const other = look.elements.find((element) => element.testID === 'a-other');
    await run(() => press({ target: { testID: 'a-other' } }));
    const after = await tree({ changes: true });
    expect(after.elements.find((element) => element.testID === 'a-other')?.ref).toBe(other?.ref);
  });

  test('a new host session (no previous list) numbers from e1', async () => {
    await mountSwapper();
    await tree({});
    await tree({ changes: true });
    forgetLastTree();
    const fresh = await tree({ changes: true });
    expect(fresh.elements[0]?.ref).toBe('e1');
  });
});
