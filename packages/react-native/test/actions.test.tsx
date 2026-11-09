import { SAMPLE_FRAMES, SampleScreen, frame, makeSpies, mount, unmountAll, useFrames, type Spies } from './helpers';
import React from 'react';
import { Dimensions, DevSettings, Linking, PixelRatio, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { act } from 'react-test-renderer';
import {
  configureActions,
  describeHit,
  getLogs,
  longPress,
  onActed,
  openURL,
  press,
  reload,
  resolveTarget,
  screenshot,
  scroll,
  toggle,
  typeText,
} from '../src/actions';
import { collectNodes, resetRefs, setHitTester, setMeasurer, takeSnapshot, tree } from '../src/inspect';
import { isRecord, TaplineError, type TaplineElement } from '../src/types';
import { firstHostChild, sameFiber, type Fiber } from '../src/fiber';

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

beforeAll(() => configureActions({ quietMs: 0, capMs: 0 }));

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
      expect(error.message).toMatch(/^covered: /);
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

    test('a cover that is not a listed element is "another view", never a native type name', async () => {
      await mount(
        <View>
          <Pressable testID="settings" onPress={() => {}}>
            <Text>Settings</Text>
          </Pressable>
          <View />
        </View>,
      );
      useFrames({ settings: frame(20, 100, 100, 40) });
      const veil = collectNodes()
        .filter((n) => n.hostType === 'View' && n.fiber.child === null)
        .pop();
      if (!veil) throw new Error('no plain view');
      setHitTester(async () => veil.fiber);
      const error = await failure(run(() => press({ target: { testID: 'settings' } })));
      expect(error.message).toMatch(/^covered: e\d+ button "Settings" is covered at \(70, 120\) by another view: /);
      expect(error.message).not.toMatch(/RCT/);
    });

    test('a cover inside an open modal is "an open modal", with its nearest named element', async () => {
      await mount(
        <View>
          <Pressable testID="settings" onPress={() => {}}>
            <Text>Settings</Text>
          </Pressable>
          {React.createElement(
            'RCTModalHostView',
            null,
            <View>
              <View />
              <Pressable testID="done" onPress={() => {}}>
                <Text>Done</Text>
              </Pressable>
            </View>,
          )}
        </View>,
      );
      useFrames({ settings: frame(20, 100, 100, 40), done: frame(0, 700, 400, 50) });
      // the screen behind the modal isn't in the list while it is open, so name the cover directly
      const snapshot = takeSnapshot();
      const spacer = collectNodes().find((n) => n.hostType === 'View' && n.fiber.child === null);
      if (!spacer) throw new Error('modal view not found');
      expect(describeHit(snapshot, spacer.fiber)).toMatch(/^an open modal \(e\d+ button "Done"\)$/);
      // a cover inside the modal that the actor itself is in is just another view
      setHitTester(async () => spacer.fiber);
      const error = await failure(run(() => press({ target: { testID: 'done' } })));
      expect(error.message).toContain('by another view');
      expect(error.message).not.toMatch(/RCT/);
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
      expect(error.message).toMatch(/^off_screen: /);
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
    expect(error.message).toMatch(/^no_action: /);
    expect(error.message).not.toContain('force');
  });

  test('refuses a disabled element', async () => {
    await mountSample();
    const error = await failure(run(() => press({ target: { testID: 'disabled-button' } })));
    expect(error.code).toBe('not_actionable');
    expect(error.message).toMatch(/^disabled: /);
    expect(spies.onDisabled).not.toHaveBeenCalled();
  });

  test('refuses an element with no handler anywhere above it', async () => {
    await mountSample();
    const error = await failure(run(() => press({ target: { testID: 'state-line' } })));
    expect(error.code).toBe('not_actionable');
    expect(error.message).toMatch(/^no_action: /);
    expect(error.message).not.toContain('force');
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
    expect(error.message).toContain('button "Delete"');
    expect(spies.onDelete).not.toHaveBeenCalled();
    const [first, second] = error.refs ?? [];
    await run(() => press({ target: { ref: second } }));
    expect(spies.onDelete).toHaveBeenCalledWith(2);
    await run(() => press({ target: { ref: first } }));
    expect(spies.onDelete).toHaveBeenLastCalledWith(1);
  });

  test('ambiguous carries the candidates as elements, with role, id, actions and frame', async () => {
    await mount(
      <View>
        <Pressable testID="nutrition-tab" onPress={() => {}}>
          <Text>Nutrition</Text>
        </Pressable>
        <Text testID="nutrition-title">Nutrition</Text>
      </View>,
    );
    useFrames({ 'nutrition-tab': frame(0, 733, 200, 49), 'nutrition-title': frame(76, 100, 273, 23) });
    const error = await failure(resolveTarget({ text: 'Nutrition' }));
    expect(error.code).toBe('ambiguous');
    const candidates = error.candidates ?? [];
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.ref)).toEqual(error.refs);
    expect(candidates[0]).toMatchObject({ role: 'button', testID: 'nutrition-tab', actions: ['press'], frame: frame(0, 733, 200, 49) });
    expect(candidates[1]).toMatchObject({ role: 'text', testID: 'nutrition-title', frame: frame(76, 100, 273, 23) });
    expect(error.toWire().candidates).toEqual(candidates);
    expect(error.message).toContain('2 elements match');
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
    const empty = await failure(resolveTarget({ x: 5000, y: 5000 }));
    expect(empty.code).toBe('not_actionable');
    expect(empty.message).toMatch(/^no_action: Nothing at \(/);
    await run(() => press({ target: { x: 100, y: 410 } }));
    expect(spies.onDelete).toHaveBeenCalledWith(1);
  });

  describe('phone-check fixes', () => {
    async function mountWelcome(): Promise<void> {
      await mount(
        <ScrollView testID="welcome-scroll">
          <Text testID="title">Just Demo</Text>
          <Text testID="header" accessibilityRole="header">
            Train with a plan.
          </Text>
          <Pressable testID="continue" onPress={spies.onGo}>
            <Text>Continue</Text>
          </Pressable>
        </ScrollView>,
      );
      useFrames({
        'welcome-scroll': frame(0, 0, 400, 800),
        title: frame(16, 442, 300, 60),
        header: frame(16, 521, 300, 26),
        continue: frame(16, 700, 368, 56),
      });
    }

    test('a text target never picks a scroll container over the text inside it', async () => {
      await mountWelcome();
      const { entry } = await resolveTarget({ text: 'Demo' });
      expect(entry.info.testID).toBe('title');
      const error = await failure(run(() => press({ target: { text: 'Demo' } })));
      expect(error.code).toBe('not_actionable');
      expect(error.message).toMatch(/^no_action: /);
      expect(error.message).toContain('text "Just Demo"');
      expect(error.message).not.toMatch(/scroll/i);
    });

    test('a point on plain text inside a scroll view takes no tap', async () => {
      await mountWelcome();
      const error = await failure(run(() => press({ target: { x: 100, y: 534 } })));
      expect(error.code).toBe('not_actionable');
      expect(error.message).toMatch(/^no_action: Nothing at \(100, 534\) takes a tap\./);
      const long = await failure(run(() => longPress({ target: { x: 100, y: 534 } })));
      expect(long.message).toMatch(/^no_action: Nothing at \(100, 534\) takes a long press\./);
      const flip = await failure(run(() => toggle({ target: { x: 100, y: 534 } })));
      expect(flip.message).toMatch(/takes a toggle\./);
      const text = await failure(run(() => typeText({ target: { x: 100, y: 534 }, text: 'a' })));
      expect(text.message).toMatch(/takes a text input\./);
    });

    test('a point on a Pressable still taps it; a point on plain text scrolls the scroll view', async () => {
      await mountWelcome();
      await run(() => press({ target: { x: 100, y: 720 } }));
      expect(spies.onGo).toHaveBeenCalledTimes(1);
      hostInstance('welcome-scroll').scrollTo = jest.fn();
      const result = await run(() => scroll({ target: { x: 100, y: 534 } }));
      expect(result.element.testID).toBe('welcome-scroll');
    });

    test('without a hint a point still takes any actionable element', async () => {
      await mountWelcome();
      expect((await resolveTarget({ x: 100, y: 534 })).entry.info.testID).toBe('welcome-scroll');
    });

    test('refusals name elements like element lines', async () => {
      await mountSample();
      const notSwitch = await failure(toggle({ target: { testID: 'login-button' } }));
      expect(notSwitch.message).toMatch(/^no_action: e\d+ button "Sign in now"|^no_action: e\d+ button "Log in"/);
      expect(notSwitch.message).toContain('is not a switch');
      const noLong = await failure(longPress({ target: { testID: 'delete-1' } }));
      expect(noLong.message).toMatch(/^no_action: e\d+ button "Delete" has no long-press action/);
      const noTap = await failure(press({ target: { testID: 'state-line' } }));
      expect(noTap.message).toMatch(/^no_action: e\d+ text "name=/);
      expect(noTap.message).toContain('has no tap action');
      const disabled = await failure(press({ target: { testID: 'disabled-button' } }));
      expect(disabled.message).toMatch(/^disabled: e\d+ button "Unavailable" is disabled/);
      const notInput = await failure(typeText({ target: { testID: 'state-line' }, text: 'x' }));
      expect(notInput.message).toMatch(/^no_action: e\d+ text "name=.*" is not a text input/);
      const noValue = await failure(
        (async () => {
          await unmountAll();
          await mount(<Switch testID="bare" value={false} />);
          useFrames({});
          return toggle({ target: { testID: 'bare' } });
        })(),
      );
      expect(noValue.message).toMatch(/^no_action: e\d+ switch id=bare is not a switch/);
    });

    test('a covered element is named by role and text, and the cover by role', async () => {
      await mount(
        <View>
          <Pressable testID="save" onPress={() => undefined}>
            <Text>Continue</Text>
          </Pressable>
          <View testID="tapline-alert" />
        </View>,
      );
      useFrames({ save: frame(20, 600, 100, 40), 'tapline-alert': frame(0, 580, 400, 80) });
      const alertNode = collectNodes().find((n) => isRecord(n.fiber.memoizedProps) && n.fiber.memoizedProps.testID === 'tapline-alert');
      if (!alertNode) throw new Error('no alert node');
      setHitTester(async () => alertNode.fiber);
      try {
        const error = await failure(run(() => press({ target: { testID: 'save' } })));
        expect(error.message).toMatch(/^covered: e\d+ button "Continue" is covered at \(70, 620\) by e\d+ View id=tapline-alert/);
      } finally {
        setHitTester(null);
      }
    });

    test('not_found for an id reads id "..."', async () => {
      await mountSample();
      const error = await failure(resolveTarget({ testID: 'no-such-id' }));
      expect(error.message).toBe('No element matches id "no-such-id"');
    });
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
    const notInput = await failure(typeText({ target: { testID: 'plain' }, text: 'x' }));
    expect(notInput.code).toBe('not_actionable');
    expect(notInput.message).toMatch(/^no_action: /);
    expect(notInput.message).not.toContain('force');
    expect((await failure(typeText({ target: { testID: 'plain' } }))).code).toBe('bad_params');
    expect((await failure(typeText({ target: { testID: 'plain' }, text: 4 }))).code).toBe('bad_params');
  });

  test('a read-only input is not_actionable', async () => {
    const onChangeText = jest.fn();
    await mount(<TextInput testID="ro" editable={false} onChangeText={onChangeText} />);
    useFrames({});
    const error = await failure(typeText({ target: { testID: 'ro' }, text: 'x' }));
    expect(error.code).toBe('not_actionable');
    expect(error.message).toMatch(/^disabled: /);
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
    const notToggle = await failure(toggle({ target: { testID: 'login-button' } }));
    expect(notToggle.code).toBe('not_actionable');
    expect(notToggle.message).toMatch(/^no_action: /);
    expect(notToggle.message).not.toContain('force');
    expect((await failure(toggle({ target: { testID: 'notify-switch' }, value: 'yes' }))).code).toBe('bad_params');
  });

  test('a switch without onValueChange is no_action; a disabled one is disabled', async () => {
    await mount(
      <View>
        <Switch testID="bare" value={false} />
        <Switch testID="off" value={false} disabled onValueChange={() => undefined} />
      </View>,
    );
    useFrames({});
    const bare = await failure(toggle({ target: { testID: 'bare' } }));
    expect(bare.code).toBe('not_actionable');
    expect(bare.message).toMatch(/^no_action: /);
    expect(bare.message).not.toContain('force');
    const off = await failure(toggle({ target: { testID: 'off' } }));
    expect(off.code).toBe('not_actionable');
    expect(off.message).toMatch(/^disabled: /);
  });
});

describe('scroll', () => {
  // These tests have no content frame to measure (the sample's content container is unmeasured), so
  // the scroll falls back to Tapline's own record of the offset.
  async function mountSample(): Promise<void> {
    await mount(<SampleScreen spies={spies} />);
    useFrames(SAMPLE_FRAMES, null);
  }

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

  test('scroll by fraction moves that share of the scroll view', async () => {
    await mountSample();
    const scrollTo = jest.fn();
    hostInstance('main-scroll').scrollTo = scrollTo;
    const down = await run(() => scroll({ target: { testID: 'main-scroll' }, direction: 'down', fraction: 0.5 }));
    expect(scrollTo).toHaveBeenLastCalledWith({ x: 0, y: 400, animated: false }); // half of the 800pt height
    expect(down.offset).toEqual({ x: 0, y: 400 });
    // left / right use the width (400pt)
    await run(() => scroll({ target: { testID: 'main-scroll' }, direction: 'right', fraction: 0.25 }));
    expect(scrollTo).toHaveBeenLastCalledWith({ x: 100, y: 400, animated: false });
  });

  test('fraction must be between 0.1 and 1, and not combined with amount', async () => {
    await mountSample();
    const target = { testID: 'main-scroll' };
    expect((await failure(scroll({ target, direction: 'down', fraction: 2 }))).code).toBe('bad_params');
    expect((await failure(scroll({ target, direction: 'down', fraction: 0.05 }))).code).toBe('bad_params');
    expect((await failure(scroll({ target, direction: 'down', fraction: 'half' }))).code).toBe('bad_params');
    expect((await failure(scroll({ target, direction: 'down', fraction: 0.5, amount: 100 }))).code).toBe('bad_params');
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

  describe('from the real offset', () => {
    const SCROLL_TOP = 59; // the safe area above the scroll view
    const VISIBLE = 778;

    /**
     * A ScrollView whose content frame follows a "real" offset, the way Fabric reports it, and whose
     * scrollTo clamps to [0, max] like native does (it never reaches the automatic inset).
     */
    async function mountMeasured(contentHeight: number, restingY: number) {
      await mount(
        <ScrollView testID="real-scroll">
          <Text>content</Text>
        </ScrollView>,
      );
      const scrollFiber = collectNodes().find((n) => isRecord(n.fiber.memoizedProps) && n.fiber.memoizedProps.testID === 'real-scroll')!.fiber;
      const contentFiber = firstHostChild(scrollFiber);
      if (!contentFiber) throw new Error('no content container');
      const max = Math.max(0, contentHeight - VISIBLE);
      const real = { x: 0, y: restingY };
      const clamp = (value: number, upper: number): number => Math.min(Math.max(value, 0), upper);
      const scrollTo = jest.fn((arg: { x: number; y: number }) => {
        real.x = clamp(arg.x, 0);
        real.y = clamp(arg.y, max);
      });
      const scrollToEnd = jest.fn(() => {
        real.y = max;
      });
      const instance = hostInstance('real-scroll');
      instance.scrollTo = scrollTo;
      instance.scrollToEnd = scrollToEnd;
      setMeasurer(async (fiber) => {
        if (sameFiber(fiber, scrollFiber)) return frame(0, SCROLL_TOP, 400, VISIBLE);
        if (sameFiber(fiber, contentFiber)) return frame(-real.x, SCROLL_TOP - real.y, 400, contentHeight);
        return frame(0, 0, 10, 10);
      });
      return { real, scrollTo, scrollToEnd };
    }

    test('with a RefreshControl first, the offset and length come from the content view', async () => {
      await mount(
        React.createElement(
          'RCTScrollView',
          { testID: 'refreshing' },
          React.createElement('RCTRefreshControl', { testID: 'spinner' }),
          React.createElement('RCTScrollContentView', { testID: 'content' }, <Text>row</Text>),
        ),
      );
      const hostOf = (testID: string): Fiber => {
        const node = collectNodes().find((n) => isRecord(n.fiber.memoizedProps) && n.fiber.memoizedProps.testID === testID);
        if (!node) throw new Error(`no host ${testID}`);
        return node.fiber;
      };
      const [scrollFiber, spinnerFiber, contentFiber] = [hostOf('refreshing'), hostOf('spinner'), hostOf('content')];
      expect(firstHostChild(scrollFiber)).toBe(spinnerFiber); // the old way picked this one
      const real = { y: 120 };
      const scrollTo = jest.fn((arg: { x: number; y: number }) => {
        real.y = Math.min(Math.max(arg.y, 0), 2222);
      });
      hostInstance('refreshing').scrollTo = scrollTo;
      setMeasurer(async (fiber) => {
        if (sameFiber(fiber, scrollFiber)) return frame(0, SCROLL_TOP, 400, VISIBLE);
        if (sameFiber(fiber, spinnerFiber)) return frame(180, SCROLL_TOP - 60, 40, 40);
        if (sameFiber(fiber, contentFiber)) return frame(0, SCROLL_TOP - real.y, 400, 3000);
        return frame(0, 0, 10, 10);
      });
      const down = await run(() => scroll({ target: { testID: 'refreshing' }, direction: 'down', fraction: 0.5 }));
      expect(scrollTo).toHaveBeenLastCalledWith({ x: 0, y: 509, animated: false }); // 120 + 389
      expect(down.offset).toEqual({ x: 0, y: 509 });
      const end = await run(() => scroll({ target: { testID: 'refreshing' }, direction: 'down', amount: 9999 }));
      expect(end.offset).toEqual({ x: 0, y: 2222 }); // content 3000 - visible 778
    });

    test('without the native type name, the largest child is the content view', async () => {
      await mount(
        React.createElement(
          'RCTScrollView',
          { testID: 'plain' },
          React.createElement('Strip', { testID: 'strip' }),
          React.createElement('Body', { testID: 'body' }, <Text>row</Text>),
        ),
      );
      const hostOf = (testID: string): Fiber => {
        const node = collectNodes().find((n) => isRecord(n.fiber.memoizedProps) && n.fiber.memoizedProps.testID === testID);
        if (!node) throw new Error(`no host ${testID}`);
        return node.fiber;
      };
      const [scrollFiber, bodyFiber] = [hostOf('plain'), hostOf('body')];
      hostInstance('plain').scrollTo = jest.fn();
      setMeasurer(async (fiber) => {
        if (sameFiber(fiber, scrollFiber)) return frame(0, SCROLL_TOP, 400, VISIBLE);
        if (sameFiber(fiber, bodyFiber)) return frame(0, SCROLL_TOP - 200, 400, 3000);
        return frame(180, SCROLL_TOP - 60, 40, 40);
      });
      const result = await run(() => scroll({ target: { testID: 'plain' }, direction: 'down', amount: 10 }));
      expect(result.offset).toEqual({ x: 0, y: 200 });
    });

    test('from the resting inset of -59, down moves to 0, and a further up moves nothing', async () => {
      const { scrollTo } = await mountMeasured(VISIBLE, -59);
      const target = { testID: 'real-scroll' };
      const down = await run(() => scroll({ target, direction: 'down', fraction: 0.5 }));
      expect(scrollTo).toHaveBeenLastCalledWith({ x: 0, y: 0, animated: false }); // -59 + 389, clamped to the end
      expect(down.offset).toEqual({ x: 0, y: 0 });
      expect(down.moved).toBe(true);

      const up = await run(() => scroll({ target, direction: 'up', fraction: 0.5 }));
      expect(scrollTo).toHaveBeenLastCalledWith({ x: 0, y: 0, animated: false });
      expect(up.offset).toEqual({ x: 0, y: 0 });
      expect(up.moved).toBe(false);
    });

    test('a long list moves by the requested share and reports the real offset', async () => {
      const { scrollTo, real } = await mountMeasured(3000, 0);
      const target = { testID: 'real-scroll' };
      const first = await run(() => scroll({ target, direction: 'down', fraction: 0.5 }));
      expect(scrollTo).toHaveBeenLastCalledWith({ x: 0, y: 389, animated: false });
      expect(first.offset).toEqual({ x: 0, y: 389 });
      expect(first.moved).toBe(true);

      // a person scrolls; Tapline's own record is out of date and must not be used
      real.y = 1000;
      const second = await run(() => scroll({ target, direction: 'down', fraction: 0.5 }));
      expect(scrollTo).toHaveBeenLastCalledWith({ x: 0, y: 1389, animated: false });
      expect(second.offset).toEqual({ x: 0, y: 1389 });

      const clamped = await run(() => scroll({ target, direction: 'down', amount: 5000 }));
      expect(scrollTo).toHaveBeenLastCalledWith({ x: 0, y: 2222, animated: false }); // content - visible
      expect(clamped.offset).toEqual({ x: 0, y: 2222 });
      const atEnd = await run(() => scroll({ target, direction: 'down', fraction: 0.5 }));
      expect(atEnd.moved).toBe(false);
      expect(atEnd.offset).toEqual({ x: 0, y: 2222 });
    });

    test('to: end reports the real end offset; to: start reports 0', async () => {
      const { scrollToEnd } = await mountMeasured(3000, 0);
      const target = { testID: 'real-scroll' };
      const end = await run(() => scroll({ target, to: 'end' }));
      expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });
      expect(end.offset).toEqual({ x: 0, y: 2222 });
      expect(end.moved).toBe(true);
      expect((await run(() => scroll({ target, to: 'end' }))).moved).toBe(false);
      const start = await run(() => scroll({ target, to: 'start' }));
      expect(start.offset).toEqual({ x: 0, y: 0 });
      expect(start.moved).toBe(true);
      expect((await run(() => scroll({ target, to: 'start' }))).moved).toBe(false);
    });
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
    const notScrollable = await failure(scroll({ target: { testID: 't' } }));
    expect(notScrollable.code).toBe('not_actionable');
    expect(notScrollable.message).toMatch(/^no_action: /);
    expect(notScrollable.message).not.toContain('force');
  });
});

describe('onActed', () => {
  test('runs once the handler has run, before the settle wait is over, and the result reports settledMs', async () => {
    await mountSample();
    const seen: string[] = [];
    const stop = onActed(() => seen.push(spies.onLogin.mock.calls.length > 0 ? 'handler ran' : 'handler not yet run'));
    configureActions({ quietMs: 100, capMs: 2000 });
    jest.useFakeTimers();
    try {
      let result: { settledMs: number } | undefined;
      const pending = press({ target: { testID: 'login-button' } }).then((r) => {
        result = r;
      });
      await jest.advanceTimersByTimeAsync(0);
      // The handler ran and the listener was told, while the press still waits for the app to settle.
      expect(seen).toEqual(['handler ran']);
      expect(result).toBeUndefined();
      await jest.advanceTimersByTimeAsync(99);
      expect(result).toBeUndefined();
      await jest.advanceTimersByTimeAsync(1);
      await pending;
      expect(result?.settledMs).toBe(100);
    } finally {
      jest.useRealTimers();
      configureActions({ quietMs: 0, capMs: 0 });
      stop();
    }
    await run(() => press({ target: { testID: 'login-button' } }));
    expect(seen).toEqual(['handler ran']);
  });
});

describe('openURL / logs / reload / screenshot', () => {
  test('openURL calls Linking.openURL', async () => {
    const spy = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    await expect(openURL({ url: 'myapp://settings' })).resolves.toEqual({ settledMs: 0 });
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
