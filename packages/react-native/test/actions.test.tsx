import { SAMPLE_FRAMES, SampleScreen, frame, makeSpies, mount, unmountAll, useFrames, type Spies } from './helpers';
import React from 'react';
import { Dimensions, DevSettings, Linking, PixelRatio, Pressable, Text, TextInput, View } from 'react-native';
import { act } from 'react-test-renderer';
import {
  configureActions,
  getLogs,
  longPress,
  openURL,
  press,
  reload,
  resolveTarget,
  screenshot,
  scroll,
  toggle,
  typeText,
} from '../src/actions';
import { collectNodes, resetRefs, setHitTester, setMeasurer, tree } from '../src/inspect';
import { isRecord, TaplineError, type TaplineElement } from '../src/types';
import type { Fiber } from '../src/fiber';

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

function byTestID(elements: TaplineElement[], testID: string): TaplineElement {
  const found = elements.find((element) => element.testID === testID);
  if (!found) throw new Error(`no element with testID ${testID}`);
  return found;
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

let spies: Spies;

beforeAll(() => configureActions({ settleMs: 0 }));

beforeEach(async () => {
  resetRefs();
  spies = makeSpies();
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 400, height: 800, scale: 2, fontScale: 1 });
  jest.spyOn(PixelRatio, 'get').mockReturnValue(2);
});

afterEach(async () => {
  await unmountAll();
  setMeasurer(null);
  jest.restoreAllMocks();
});

async function mountSample(): Promise<void> {
  await mount(<SampleScreen spies={spies} />);
  useFrames(SAMPLE_FRAMES);
}

describe('press / longPress', () => {
  test('press by text ignores the same button on a hidden tab', async () => {
    const onVisible = jest.fn();
    const onHidden = jest.fn();
    await mount(
      <View>
        {React.createElement(
          'RNSTabsScreenIOS',
          { pointerEvents: 'none' },
          <Pressable onPress={onHidden}>
            <Text>Start workout</Text>
          </Pressable>,
        )}
        {React.createElement(
          'RNSTabsScreenIOS',
          { pointerEvents: 'box-none' },
          <Pressable onPress={onVisible}>
            <Text>Start workout</Text>
          </Pressable>,
        )}
      </View>,
    );
    useFrames({});
    await run(() => press({ target: { text: 'Start workout' } }));
    expect(onVisible).toHaveBeenCalledTimes(1);
    expect(onHidden).not.toHaveBeenCalled();
  });

  describe('real-touch check', () => {
    /** The host fiber with this testID, as a hit test would return it. */
    function hostFiber(testID: string): Fiber {
      const node = collectNodes().find((candidate) => {
        const props = candidate.fiber.memoizedProps;
        return isRecord(props) && props.testID === testID;
      });
      if (!node) throw new Error(`no host for ${testID}`);
      return node.fiber;
    }

    async function mountCovered(): Promise<{ onSave: jest.Mock; onToast: jest.Mock }> {
      const onSave = jest.fn();
      const onToast = jest.fn();
      await mount(
        <View>
          <Pressable testID="save" onPress={onSave}>
            <Text testID="save-label">Save</Text>
          </Pressable>
          <Pressable testID="toast" onPress={onToast}>
            <Text>Saved!</Text>
          </Pressable>
        </View>,
      );
      useFrames({ save: frame(20, 600, 100, 40), toast: frame(0, 580, 400, 80) });
      return { onSave, onToast };
    }

    afterEach(() => setHitTester(null));

    test('refuses a press when another element is on top at its centre', async () => {
      const { onSave } = await mountCovered();
      const asked: Array<[number, number]> = [];
      setHitTester(async (x, y) => {
        asked.push([x, y]);
        return hostFiber('toast');
      });
      const error = await failure(run(() => press({ target: { testID: 'save' } })));
      expect(error.code).toBe('not_actionable');
      expect(error.message).toMatch(/covered/);
      expect(error.message).toContain('Saved!');
      expect(error.message).toContain('force');
      expect(asked).toEqual([[70, 620]]);
      expect(onSave).not.toHaveBeenCalled();
    });

    test('force presses anyway', async () => {
      const { onSave } = await mountCovered();
      setHitTester(async () => hostFiber('toast'));
      await run(() => press({ target: { testID: 'save' }, force: true }));
      expect(onSave).toHaveBeenCalledTimes(1);
    });

    test('a hit on something inside the element counts as the element', async () => {
      const { onSave } = await mountCovered();
      setHitTester(async () => hostFiber('save-label'));
      await run(() => press({ target: { testID: 'save' } }));
      expect(onSave).toHaveBeenCalledTimes(1);
    });

    test('presses when the hit test is unavailable or finds nothing', async () => {
      const { onSave } = await mountCovered();
      setHitTester(async () => undefined);
      await run(() => press({ target: { testID: 'save' } }));
      setHitTester(async () => null);
      await run(() => press({ target: { testID: 'save' } }));
      expect(onSave).toHaveBeenCalledTimes(2);
    });

    test('refuses an element that is off screen, suggesting a scroll', async () => {
      const onFar = jest.fn();
      await mount(
        <Pressable testID="far" onPress={onFar}>
          <Text>Far away</Text>
        </Pressable>,
      );
      useFrames({ far: frame(20, 1200, 100, 40) });
      const error = await failure(run(() => press({ target: { testID: 'far' }, look: false })));
      expect(error.code).toBe('not_actionable');
      expect(error.message).toMatch(/off screen/);
      expect(error.message).toMatch(/scroll/i);
      expect(onFar).not.toHaveBeenCalled();
      await run(() => press({ target: { testID: 'far' }, force: true }));
      expect(onFar).toHaveBeenCalledTimes(1);
    });

    test('a partly visible element is aimed at its visible part', async () => {
      const onEdge = jest.fn();
      await mount(
        <Pressable testID="edge" onPress={onEdge}>
          <Text>Edge</Text>
        </Pressable>,
      );
      useFrames({ edge: frame(20, 760, 100, 80) });
      const asked: Array<[number, number]> = [];
      setHitTester(async (x, y) => {
        asked.push([x, y]);
        return hostFiber('edge');
      });
      await run(() => press({ target: { testID: 'edge' } }));
      expect(asked).toEqual([[70, 780]]);
      expect(onEdge).toHaveBeenCalledTimes(1);
    });
  });

  test('press calls onPress with a synthetic press event', async () => {
    await mountSample();
    const result = await run(() => press({ target: { testID: 'login-button' } }));
    expect(spies.onLogin).toHaveBeenCalledTimes(1);
    const event = spies.onLogin.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(event.nativeEvent).toMatchObject({ locationX: 176, locationY: 24, pageX: 200, pageY: 84 });
    expect(typeof (event.nativeEvent as { timestamp: unknown }).timestamp).toBe('number');
    expect(() => {
      (event.persist as () => void)();
      (event.preventDefault as () => void)();
      (event.stopPropagation as () => void)();
    }).not.toThrow();
    expect(result.element).toMatchObject({ testID: 'login-button', type: 'Pressable' });
  });

  test('longPress calls onLongPress, not onPress', async () => {
    await mountSample();
    await run(() => longPress({ target: { testID: 'login-button' } }));
    expect(spies.onLongLogin).toHaveBeenCalledTimes(1);
    expect(spies.onLogin).not.toHaveBeenCalled();
  });

  test('longPress on an element without onLongPress is not_actionable', async () => {
    await mountSample();
    const error = await failure(run(() => longPress({ target: { testID: 'delete-1' } })));
    expect(error.code).toBe('not_actionable');
  });

  test('refuses a disabled element', async () => {
    await mountSample();
    const error = await failure(run(() => press({ target: { testID: 'disabled-button' } })));
    expect(error.code).toBe('not_actionable');
    expect(error.message).toMatch(/disabled/);
    expect(spies.onDisabled).not.toHaveBeenCalled();
  });

  test('refuses an element with no handler anywhere above it', async () => {
    await mountSample();
    const error = await failure(run(() => press({ target: { testID: 'state-line' } })));
    expect(error.code).toBe('not_actionable');
  });

  test('pressing the Text inside a Pressable presses the Pressable', async () => {
    await mountSample();
    await run(() => press({ target: { text: 'Log in' } }));
    expect(spies.onLogin).toHaveBeenCalledTimes(1);
  });

  test('a throwing handler becomes an internal error', async () => {
    spies.onLogin.mockImplementation(() => {
      throw new Error('boom');
    });
    await mountSample();
    const error = await failure(run(() => press({ target: { testID: 'login-button' } })));
    expect(error.code).toBe('internal');
    expect(error.message).toContain('boom');
  });

  test('an async handler rejection is logged, not thrown', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    spies.onLogin.mockRejectedValue(new Error('later'));
    await mountSample();
    await run(() => press({ target: { testID: 'login-button' } }));
    await act(async () => {});
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('target resolution', () => {
  test('testID is exact', async () => {
    await mountSample();
    const { entry } = await resolveTarget({ testID: 'delete-2' });
    expect(entry.info.testID).toBe('delete-2');
    expect((await failure(resolveTarget({ testID: 'delete' }))).code).toBe('not_found');
  });

  test('label is case-insensitive exact', async () => {
    await mountSample();
    const { entry } = await resolveTarget({ label: 'SIGN IN NOW' });
    expect(entry.info.testID).toBe('login-button');
    expect((await failure(resolveTarget({ label: 'Sign in' }))).code).toBe('not_found');
  });

  test('text: exact match beats substring, substring is the fallback', async () => {
    await mount(
      <View>
        <Pressable testID="save" onPress={() => {}}>
          <Text>Save</Text>
        </Pressable>
        <Pressable testID="save-draft" onPress={() => {}}>
          <Text>Save as draft</Text>
        </Pressable>
        <Pressable testID="discard" onPress={() => {}}>
          <Text>Discard changes</Text>
        </Pressable>
      </View>,
    );
    useFrames({});
    expect((await resolveTarget({ text: 'save' })).entry.info.testID).toBe('save');
    expect((await resolveTarget({ text: 'as DRAFT' })).entry.info.testID).toBe('save-draft');
    const ambiguous = await failure(resolveTarget({ text: 'sav' }));
    expect(ambiguous.code).toBe('ambiguous');
    expect(ambiguous.refs).toHaveLength(2);
    expect((await resolveTarget({ text: 'sav', index: 1 })).entry.info.testID).toBe('save-draft');
    expect((await failure(resolveTarget({ text: 'nothing like it' }))).code).toBe('not_found');
  });

  test('index picks the nth match in tree order; out of range is not_found', async () => {
    await mountSample();
    await run(() => press({ target: { text: 'Delete', index: 1 } }));
    expect(spies.onDelete).toHaveBeenCalledWith(2);
    await run(() => press({ target: { text: 'Delete', index: 0 } }));
    expect(spies.onDelete).toHaveBeenLastCalledWith(1);
    expect((await failure(resolveTarget({ text: 'Delete', index: 5 }))).code).toBe('not_found');
  });

  test('ambiguous lists up to 5 candidate refs that can be used afterwards', async () => {
    await mountSample();
    const error = await failure(run(() => press({ target: { text: 'Delete' } })));
    expect(error.code).toBe('ambiguous');
    expect(error.refs).toHaveLength(2);
    expect(error.message).toContain('delete-1');
    expect(spies.onDelete).not.toHaveBeenCalled();
    const [first, second] = error.refs ?? [];
    await run(() => press({ target: { ref: second } }));
    expect(spies.onDelete).toHaveBeenCalledWith(2);
    await run(() => press({ target: { ref: first } }));
    expect(spies.onDelete).toHaveBeenLastCalledWith(1);
  });

  test('ambiguous caps the candidate list at 5', async () => {
    await mount(
      <View>
        {Array.from({ length: 8 }, (_, i) => (
          <Pressable key={i} testID={`row-${i}`} onPress={() => {}}>
            <Text>Row</Text>
          </Pressable>
        ))}
      </View>,
    );
    useFrames({});
    const error = await failure(resolveTarget({ text: 'Row' }));
    expect(error.refs).toHaveLength(5);
  });

  test('ref comes from the latest tree call and survives re-renders', async () => {
    await mountSample();
    const { elements } = await tree({});
    const login = byTestID(elements, 'login-button');
    const input = byTestID(elements, 'name-input');
    await run(() => typeText({ target: { ref: input.ref }, text: 'Mo' })); // re-renders the whole screen
    await run(() => press({ target: { ref: login.ref } }));
    expect(spies.onLogin).toHaveBeenCalledTimes(1);
  });

  test('an unknown or stale ref is not_found', async () => {
    await mountSample();
    await tree({});
    expect((await failure(resolveTarget({ ref: 'e999' }))).code).toBe('not_found');
  });

  test('x/y picks the frontmost actionable element containing the point', async () => {
    await mountSample();
    // inside both the scroll view and the login button; the button is later in tree order
    expect((await resolveTarget({ x: 100, y: 80 })).entry.info.testID).toBe('login-button');
    // inside the scroll view and the FlatList (a later scroll view in front)
    expect((await resolveTarget({ x: 300, y: 700 })).entry.info.testID).toBe('feed');
    // only the main scroll view
    expect((await resolveTarget({ x: 390, y: 20 })).entry.info.testID).toBe('main-scroll');
    expect((await failure(resolveTarget({ x: 5000, y: 5000 }))).code).toBe('not_found');
    await run(() => press({ target: { x: 100, y: 410 } }));
    expect(spies.onDelete).toHaveBeenCalledWith(1);
  });

  test('rejects malformed targets', async () => {
    await mountSample();
    expect((await failure(resolveTarget(undefined))).code).toBe('bad_params');
    expect((await failure(resolveTarget({}))).code).toBe('bad_params');
    expect((await failure(resolveTarget({ testID: 'a', text: 'b' }))).code).toBe('bad_params');
    expect((await failure(resolveTarget({ x: 1 }))).code).toBe('bad_params');
    expect((await failure(resolveTarget({ testID: 3 }))).code).toBe('bad_params');
    expect((await failure(resolveTarget({ testID: 'a', index: -1 }))).code).toBe('bad_params');
  });

  test('not_found names the target', async () => {
    await mountSample();
    const error = await failure(resolveTarget({ testID: 'ghost' }));
    expect(error.code).toBe('not_found');
    expect(error.message).toContain('ghost');
  });
});

describe('type', () => {
  test('updates a controlled input: onChangeText fires and the re-render shows the value', async () => {
    await mountSample();
    const result = await run(() => typeText({ target: { testID: 'name-input' }, text: 'Mo' }));
    expect(result.value).toBe('Mo');
    expect(result.element.value).toBe('Mo');
    expect(spies.onControlledChange).toHaveBeenCalledWith('Mo');
    const { elements } = await tree({});
    expect(byTestID(elements, 'name-input').value).toBe('Mo');
    expect(byTestID(elements, 'state-line').text).toBe('name=Mo on=false');
  });

  test('replace (default) overwrites, replace:false appends', async () => {
    await mountSample();
    await run(() => typeText({ target: { testID: 'name-input' }, text: 'Mo' }));
    const appended = await run(() => typeText({ target: { testID: 'name-input' }, text: 'hamed', replace: false }));
    expect(appended.value).toBe('Mohamed');
    const replaced = await run(() => typeText({ target: { testID: 'name-input' }, text: 'Z' }));
    expect(replaced.value).toBe('Z');
    expect(spies.onControlledChange.mock.calls.map((call) => call[0])).toEqual(['Mo', 'Mohamed', 'Z']);
  });

  test('uncontrolled input: calls onChange + onChangeText, updates the native text, remembers it', async () => {
    await mountSample();
    const setNativeProps = jest.fn();
    hostInstance('notes-input').setNativeProps = setNativeProps;

    const result = await run(() => typeText({ target: { testID: 'notes-input' }, text: 'hello' }));
    expect(result.value).toBe('hello');
    expect(setNativeProps).toHaveBeenCalledWith({ text: 'hello' });
    expect(spies.onUncontrolledChangeText).toHaveBeenCalledWith('hello');
    expect(spies.onUncontrolledChange).toHaveBeenCalledWith(expect.objectContaining({ nativeEvent: expect.objectContaining({ text: 'hello' }) }));

    const appended = await run(() => typeText({ target: { testID: 'notes-input' }, text: '!', replace: false }));
    expect(appended.value).toBe('hello!');
    const { elements } = await tree({});
    expect(byTestID(elements, 'notes-input').value).toBe('hello!');
  });

  test('backspace deletes characters from the end (an emoji counts as one), then appends any text', async () => {
    await mountSample();
    await run(() => typeText({ target: { testID: 'name-input' }, text: 'Mo😀' }));
    const deleted = await run(() => typeText({ target: { testID: 'name-input' }, backspace: 1 }));
    expect(deleted.value).toBe('Mo');
    const replacedEnd = await run(() => typeText({ target: { testID: 'name-input' }, backspace: 1, text: 'e', replace: false }));
    expect(replacedEnd.value).toBe('Me');
    expect(spies.onControlledChange.mock.calls.map((call) => call[0])).toEqual(['Mo😀', 'Mo', 'Me']);
    expect((await failure(run(() => typeText({ target: { testID: 'name-input' }, backspace: -1 })))).code).toBe('bad_params');
  });

  test('appending to an untouched uncontrolled input starts from defaultValue', async () => {
    await mountSample();
    const result = await run(() => typeText({ target: { testID: 'notes-input' }, text: '-more', replace: false }));
    expect(result.value).toBe('seed-more');
  });

  test('submit calls onSubmitEditing after the change', async () => {
    await mountSample();
    await run(() => typeText({ target: { testID: 'name-input' }, text: 'Mo', submit: true }));
    expect(spies.onSubmit).toHaveBeenCalledTimes(1);
    expect(spies.onSubmit.mock.calls[0]?.[0]).toMatchObject({ nativeEvent: { text: 'Mo' } });
    expect(spies.onControlledChange.mock.invocationCallOrder[0]).toBeLessThan(spies.onSubmit.mock.invocationCallOrder[0] ?? 0);
  });

  test('submit alone, without text, only submits', async () => {
    await mountSample();
    await run(() => typeText({ target: { testID: 'notes-input' }, submit: true }));
    expect(spies.onUncontrolledSubmit).toHaveBeenCalledTimes(1);
    expect(spies.onUncontrolledChangeText).not.toHaveBeenCalled();
  });

  test('submit also fires onEndEditing', async () => {
    const onEnd = jest.fn();
    await mount(<TextInput testID="solo" onEndEditing={onEnd} />);
    useFrames({});
    await run(() => typeText({ text: 'x', submit: true }));
    expect(onEnd).toHaveBeenCalledWith({ nativeEvent: { text: 'x', target: expect.any(Number) } });
  });

  test('without a target: the only TextInput on screen', async () => {
    const onChangeText = jest.fn();
    await mount(
      <View>
        <Text>Name</Text>
        <TextInput testID="solo" onChangeText={onChangeText} />
      </View>,
    );
    useFrames({});
    const result = await run(() => typeText({ text: 'solo!' }));
    expect(result.value).toBe('solo!');
    expect(onChangeText).toHaveBeenCalledWith('solo!');
  });

  test('without a target: the focused TextInput wins over others', async () => {
    await mountSample();
    const notes = hostInstance('notes-input');
    const state = TextInput as unknown as { State?: unknown };
    const original = state.State;
    state.State = { currentlyFocusedInput: () => notes };
    try {
      const result = await run(() => typeText({ text: 'focused' }));
      expect(result.element.testID).toBe('notes-input');
      expect(spies.onUncontrolledChangeText).toHaveBeenCalledWith('focused');
      expect(spies.onControlledChange).not.toHaveBeenCalled();
    } finally {
      state.State = original;
    }
  });

  test('without a target and two unfocused inputs: ambiguous with refs', async () => {
    await mountSample();
    const error = await failure(run(() => typeText({ text: 'x' })));
    expect(error.code).toBe('ambiguous');
    expect(error.refs).toHaveLength(2);
  });

  test('no inputs on screen: not_found; non-input target: not_actionable; bad text: bad_params', async () => {
    await mount(<Text testID="plain">hi</Text>);
    useFrames({});
    expect((await failure(typeText({ text: 'x' }))).code).toBe('not_found');
    expect((await failure(typeText({ target: { testID: 'plain' }, text: 'x' }))).code).toBe('not_actionable');
    expect((await failure(typeText({ target: { testID: 'plain' } }))).code).toBe('bad_params');
    expect((await failure(typeText({ target: { testID: 'plain' }, text: 4 }))).code).toBe('bad_params');
  });

  test('a read-only input is not_actionable', async () => {
    const onChangeText = jest.fn();
    await mount(<TextInput testID="ro" editable={false} onChangeText={onChangeText} />);
    useFrames({});
    expect((await failure(typeText({ target: { testID: 'ro' }, text: 'x' }))).code).toBe('not_actionable');
    expect(onChangeText).not.toHaveBeenCalled();
  });
});

describe('toggle', () => {
  test('flips a Switch and the re-render shows it', async () => {
    await mountSample();
    const first = await run(() => toggle({ target: { testID: 'notify-switch' } }));
    expect(first.value).toBe(true);
    expect(spies.onSwitch).toHaveBeenLastCalledWith(true);
    let { elements } = await tree({});
    expect(byTestID(elements, 'notify-switch').checked).toBe(true);
    expect(byTestID(elements, 'state-line').text).toBe('name= on=true');
    const second = await run(() => toggle({ target: { testID: 'notify-switch' } }));
    expect(second.value).toBe(false);
    ({ elements } = await tree({}));
    expect(byTestID(elements, 'notify-switch').checked).toBe(false);
  });

  test('an explicit value is honoured even if it equals the current one', async () => {
    await mountSample();
    const result = await run(() => toggle({ target: { testID: 'notify-switch' }, value: false }));
    expect(result.value).toBe(false);
    expect(spies.onSwitch).toHaveBeenCalledWith(false);
  });

  test('non-toggles are not_actionable; bad value is bad_params', async () => {
    await mountSample();
    expect((await failure(toggle({ target: { testID: 'login-button' } }))).code).toBe('not_actionable');
    expect((await failure(toggle({ target: { testID: 'notify-switch' }, value: 'yes' }))).code).toBe('bad_params');
  });
});

describe('scroll', () => {
  test('scrolls down by 80% of the view height and tracks the offset', async () => {
    await mountSample();
    const scrollTo = jest.fn();
    hostInstance('main-scroll').scrollTo = scrollTo;

    const first = await run(() => scroll({ target: { testID: 'main-scroll' }, direction: 'down' }));
    expect(scrollTo).toHaveBeenLastCalledWith({ x: 0, y: 640, animated: false });
    expect(first.offset).toEqual({ x: 0, y: 640 });
    expect(first.element.testID).toBe('main-scroll');

    const second = await run(() => scroll({ target: { testID: 'main-scroll' }, direction: 'down', amount: 100 }));
    expect(scrollTo).toHaveBeenLastCalledWith({ x: 0, y: 740, animated: false });
    expect(second.offset).toEqual({ x: 0, y: 740 });

    await run(() => scroll({ target: { testID: 'main-scroll' }, direction: 'up', amount: 1000 }));
    expect(scrollTo).toHaveBeenLastCalledWith({ x: 0, y: 0, animated: false });
  });

  test('left / right move x', async () => {
    await mountSample();
    const scrollTo = jest.fn();
    hostInstance('main-scroll').scrollTo = scrollTo;
    await run(() => scroll({ target: { testID: 'main-scroll' }, direction: 'right', amount: 50 }));
    expect(scrollTo).toHaveBeenLastCalledWith({ x: 50, y: 0, animated: false });
    await run(() => scroll({ target: { testID: 'main-scroll' }, direction: 'left', amount: 20 }));
    expect(scrollTo).toHaveBeenLastCalledWith({ x: 30, y: 0, animated: false });
  });

  test('to: end uses scrollToEnd, to: start goes back to 0', async () => {
    await mountSample();
    const instance = hostInstance('main-scroll');
    instance.scrollTo = jest.fn();
    instance.scrollToEnd = jest.fn();
    await run(() => scroll({ target: { testID: 'main-scroll' }, to: 'end' }));
    expect(instance.scrollToEnd).toHaveBeenCalledWith({ animated: false });
    const start = await run(() => scroll({ target: { testID: 'main-scroll' }, to: 'start' }));
    expect(instance.scrollTo).toHaveBeenLastCalledWith({ x: 0, y: 0, animated: false });
    expect(start.offset).toEqual({ x: 0, y: 0 });
  });

  test('without a target: the largest scroll view on screen', async () => {
    await mountSample();
    const main = jest.fn();
    const feed = jest.fn();
    hostInstance('main-scroll').scrollTo = main;
    hostInstance('feed').scrollTo = feed;
    const result = await run(() => scroll({ direction: 'down', amount: 10 }));
    expect(result.element.testID).toBe('main-scroll');
    expect(main).toHaveBeenCalledWith({ x: 0, y: 10, animated: false });
    expect(feed).not.toHaveBeenCalled();
  });

  test('targeting something inside a scroll view scrolls the nearest one', async () => {
    await mountSample();
    const feed = jest.fn();
    hostInstance('feed').scrollTo = feed;
    const result = await run(() => scroll({ target: { text: 'item one' }, direction: 'down', amount: 25 }));
    expect(result.element.testID).toBe('feed');
    expect(feed).toHaveBeenCalledWith({ x: 0, y: 25, animated: false });
  });

  /** Everything Tapline may call scroll methods on for `testID`: the host instance and its owners' instances. */
  function scrollObjects(testID: string): Record<string, unknown>[] {
    const node = collectNodes().find((candidate) => {
      const props = candidate.fiber.memoizedProps;
      return isRecord(props) && props.testID === testID && /ScrollView/.test(candidate.hostType);
    });
    if (!node) throw new Error(`no scroll host for ${testID}`);
    return [node.fiber.stateNode, ...node.owners.map((owner) => owner.stateNode)].filter(isRecord);
  }

  function removeScrollMethods(objects: Record<string, unknown>[]): void {
    for (const object of objects) {
      for (const name of ['scrollTo', 'scrollToOffset', 'scrollToEnd', 'getScrollResponder']) object[name] = undefined;
    }
  }

  test('reads _scrollMetrics for the current offset and clamps to the content end', async () => {
    await mountSample();
    const objects = scrollObjects('feed');
    const scrollTo = jest.fn();
    removeScrollMethods(objects);
    objects[0]!.scrollTo = scrollTo;
    for (const object of objects) object._scrollMetrics = { offset: 100, visibleLength: 300, contentLength: 1000 };

    const first = await run(() => scroll({ target: { testID: 'feed' }, direction: 'down' }));
    expect(scrollTo).toHaveBeenLastCalledWith({ x: 0, y: 340, animated: false }); // 100 + 80% of 300
    expect(first.offset).toEqual({ x: 0, y: 340 });
    await run(() => scroll({ target: { testID: 'feed' }, direction: 'down', amount: 5000 }));
    expect(scrollTo).toHaveBeenLastCalledWith({ x: 0, y: 700, animated: false }); // content - visible
  });

  test('falls back to scrollToOffset on a list instance when there is no scrollTo', async () => {
    await mountSample();
    const objects = scrollObjects('feed');
    removeScrollMethods(objects);
    const scrollToOffset = jest.fn();
    objects[objects.length - 1]!.scrollToOffset = scrollToOffset;
    const result = await run(() => scroll({ target: { testID: 'feed' }, direction: 'down' }));
    expect(scrollToOffset).toHaveBeenCalledWith({ offset: 240, animated: false }); // 80% of the 300pt frame
    expect(result.offset).toEqual({ x: 0, y: 240 });
  });

  test('scrollTo on a ScrollView responder is used when the host has none', async () => {
    await mountSample();
    const objects = scrollObjects('main-scroll');
    removeScrollMethods(objects);
    const responderScrollTo = jest.fn();
    objects[0]!.getScrollResponder = () => ({ scrollTo: responderScrollTo });
    await run(() => scroll({ target: { testID: 'main-scroll' }, direction: 'down', amount: 7 }));
    expect(responderScrollTo).toHaveBeenCalledWith({ x: 0, y: 7, animated: false });
  });

  test('a scroll view with no scroll methods is unsupported', async () => {
    await mountSample();
    removeScrollMethods(scrollObjects('main-scroll'));
    expect((await failure(scroll({ target: { testID: 'main-scroll' } }))).code).toBe('unsupported');
    expect((await failure(scroll({ target: { testID: 'main-scroll' }, to: 'end' }))).code).toBe('unsupported');
  });

  test('validates params; no scroll view is not_found; non-scrollable target is not_actionable', async () => {
    await mountSample();
    expect((await failure(scroll({ target: { testID: 'main-scroll' }, direction: 'sideways' }))).code).toBe('bad_params');
    expect((await failure(scroll({ target: { testID: 'main-scroll' }, to: 'middle' }))).code).toBe('bad_params');
    expect((await failure(scroll({ target: { testID: 'main-scroll' }, amount: -3 }))).code).toBe('bad_params');
    await unmountAll();
    await mount(<Text testID="t">x</Text>);
    useFrames({});
    expect((await failure(scroll({}))).code).toBe('not_found');
    expect((await failure(scroll({ target: { testID: 't' } }))).code).toBe('not_actionable');
  });
});

describe('openURL / logs / reload / screenshot', () => {
  test('openURL calls Linking.openURL', async () => {
    const spy = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    await expect(openURL({ url: 'myapp://settings' })).resolves.toEqual({});
    expect(spy).toHaveBeenCalledWith('myapp://settings');
  });

  test('openURL validates and reports failures', async () => {
    expect((await failure(openURL({}))).code).toBe('bad_params');
    jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('no handler'));
    const error = await failure(openURL({ url: 'nope://x' }));
    expect(error.code).toBe('internal');
    expect(error.message).toContain('no handler');
  });

  test('openURL times out if the OS never answers', async () => {
    jest.useFakeTimers();
    try {
      jest.spyOn(Linking, 'openURL').mockReturnValue(new Promise(() => {}));
      const pending = failure(openURL({ url: 'myapp://slow' }));
      await jest.advanceTimersByTimeAsync(6000);
      expect((await pending).code).toBe('timeout');
    } finally {
      jest.useRealTimers();
    }
  });

  test('logs validates since', async () => {
    expect((await failure(getLogs({ since: 'yesterday' }))).code).toBe('bad_params');
    await expect(getLogs({})).resolves.toEqual({ entries: expect.any(Array) });
  });

  test('reload calls DevSettings.reload in dev builds, after replying', async () => {
    jest.useFakeTimers();
    try {
      // real DevSettings builds a NativeEventEmitter and warns under Jest; this is only about the call
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      const spy = jest.spyOn(DevSettings, 'reload').mockImplementation(() => {});
      await expect(reload()).resolves.toEqual({});
      expect(spy).not.toHaveBeenCalled();
      jest.advanceTimersByTime(150);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('reload is unsupported outside __DEV__', async () => {
    const holder = globalThis as { __DEV__?: boolean };
    const previous = holder.__DEV__;
    holder.__DEV__ = false;
    try {
      expect((await failure(reload())).code).toBe('unsupported');
    } finally {
      holder.__DEV__ = previous;
    }
  });

  test('screenshot is unsupported without react-native-view-shot', async () => {
    const error = await failure(screenshot({}));
    expect(error.code).toBe('unsupported');
    expect(error.message).toContain('react-native-view-shot');
  });
});

describe('frames used for results', () => {
  test('the element returned by press carries its frame', async () => {
    await mountSample();
    setMeasurer(async () => frame(1, 2, 3, 4));
    const result = await run(() => press({ target: { testID: 'login-button' } }));
    expect(result.element.frame).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });
});
