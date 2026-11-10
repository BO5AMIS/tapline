import { frame, mount, unmountAll, useFrames } from './helpers';
import React from 'react';
import { Alert, Dimensions, PixelRatio, Pressable, ScrollView, Text, View } from 'react-native';
import { act } from 'react-test-renderer';
import { configureActions, press } from '../src/actions';
import { installAlertTracking, openAlerts, TaplineAlertHost, uninstallAlertTracking } from '../src/alerts';
import { cutText, forgetLastTree, MAX_KEPT_TEXT, resetRefs, setHitTester, setMeasurer, tree } from '../src/inspect';
import { TaplineError } from '../src/types';
import { waitFor } from '../src/wait';

// AGENT-TOOLS v1.5 in the SDK: `look` counts what lies above and below the screen, text is kept
// long enough to read and to match, and a target that also matches behind an alert means the alert's.

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
  uninstallAlertTracking();
  jest.restoreAllMocks();
});

describe('what lies off screen is counted', () => {
  function Rows() {
    return (
      <ScrollView testID="list">
        {['up-1', 'up-2', 'row-1', 'row-2', 'down-1', 'down-2', 'down-3', 'side'].map((id) => (
          <Pressable key={id} testID={id} onPress={() => undefined}>
            <Text>{id}</Text>
          </Pressable>
        ))}
      </ScrollView>
    );
  }

  test('above and below, each once; left and right are not counted', async () => {
    await mount(<Rows />);
    useFrames({
      list: frame(0, 0, 400, 800),
      'up-1': frame(0, -200, 400, 50),
      'up-2': frame(0, -50, 400, 50), // its bottom edge is the screen's top: wholly above
      'row-1': frame(0, 100, 400, 50),
      'row-2': frame(0, 780, 400, 50), // partly on screen: listed
      'down-1': frame(0, 800, 400, 50),
      'down-2': frame(0, 900, 400, 50),
      'down-3': frame(0, 1000, 400, 50),
      side: frame(500, 100, 400, 50),
    });
    const result = await run(() => tree());
    expect(result.elements.map((element) => element.testID)).toEqual(['list', 'row-1', 'row-2']);
    // The button and the text inside it have the same rect and text: one element, counted once.
    expect(result.offScreen).toEqual({ above: 2, below: 3 });
  });

  test('nothing off screen: the field is left out', async () => {
    await mount(<Rows />);
    useFrames({ list: frame(0, 0, 400, 800) }, frame(0, 100, 400, 50));
    const result = await run(() => tree());
    expect(result.offScreen).toBeUndefined();
  });

  test('an element without a size is not counted', async () => {
    await mount(<Rows />);
    useFrames({ list: frame(0, 0, 400, 800), 'down-1': frame(0, 900, 0, 0) }, frame(0, 100, 400, 50));
    const result = await run(() => tree());
    expect(result.offScreen).toBeUndefined();
  });
});

describe('long text', () => {
  const long = (length: number, tail: string): string => `${'word '.repeat(Math.ceil(length / 5)).slice(0, length - tail.length)}${tail}`;

  test('a text of 250 characters arrives whole', async () => {
    const text = long(250, 'the-end');
    await mount(<Text testID="state">{text}</Text>);
    useFrames({ state: frame(0, 100, 400, 60) });
    const [element] = (await run(() => tree())).elements;
    expect(element?.text).toBe(text);
    expect(element?.textMore).toBeUndefined();
  });

  test('past 2000 characters the element carries the first 2000 and how many are missing', async () => {
    const text = long(2500, 'the-end');
    await mount(<Text testID="state">{text}</Text>);
    useFrames({ state: frame(0, 100, 400, 60) });
    const [element] = (await run(() => tree())).elements;
    expect(element?.text).toBe(text.slice(0, MAX_KEPT_TEXT));
    expect(element?.textMore).toBe(500);
  });

  test('wait_for and a {text} target check all of a text, also the part no line shows', async () => {
    const onPress = jest.fn();
    await mount(
      <Pressable testID="card" onPress={onPress}>
        <Text>{long(2500, 'the-end')}</Text>
      </Pressable>,
    );
    useFrames({ card: frame(0, 100, 400, 300) }, frame(0, 100, 400, 300));
    await expect(run(() => waitFor({ text: 'the-end', timeout: 0.5 }))).resolves.toMatchObject({ met: true });
    await run(() => press({ target: { text: 'the-end' } }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  test('a change in the part past 2000 characters still counts as a change', async () => {
    function Grows({ extra }: { extra: string }) {
      return <Text testID="state">{`${long(2000, 'x')}${extra}`}</Text>;
    }
    const renderer = await mount(<Grows extra="" />);
    useFrames({ state: frame(0, 100, 400, 60) });
    await run(() => tree());
    await act(async () => {
      renderer.update(<Grows extra=" and more" />);
    });
    const result = await run(() => tree({ changes: true }));
    expect(result.changes?.changed.map((change) => change.ref)).toEqual(['e1']);
  });

  test('a cut says how much is missing', () => {
    expect(cutText('short')).toBe('short');
    expect(cutText(`  two\n lines `)).toBe('two lines');
    expect(cutText('a'.repeat(200))).toBe('a'.repeat(200));
    expect(cutText('a'.repeat(257))).toBe(`${'a'.repeat(200)}…(+57)`);
    expect(cutText('a'.repeat(257), 500)).toBe(`${'a'.repeat(200)}…(+557)`);
    expect(cutText('a'.repeat(50), 0, 40)).toBe(`${'a'.repeat(40)}…(+10)`);
  });

  test('a refusal names the element by the same line the list shows', async () => {
    const text = long(257, 'the-end');
    await mount(
      <Pressable testID="far" onPress={() => undefined}>
        <Text>{text}</Text>
      </Pressable>,
    );
    useFrames({ far: frame(0, 2000, 400, 50) }, frame(0, 2000, 400, 50));
    const error = await failure(run(() => press({ target: { testID: 'far' } })));
    expect(error.message).toMatch(/^off_screen: /);
    expect(error.message).toContain(`"${text.slice(0, 200)}…(+57)"`);
  });
});

describe('a target that also matches behind the alert', () => {
  async function mountWithAlert(onBehind: jest.Mock): Promise<void> {
    installAlertTracking({ standIn: true });
    await mount(
      <View style={{ flex: 1 }}>
        <Pressable testID="form-cancel" onPress={onBehind}>
          <Text>Cancel</Text>
        </Pressable>
        <Pressable testID="row-a" onPress={onBehind}>
          <Text>Edit</Text>
        </Pressable>
        <Pressable testID="row-b" onPress={onBehind}>
          <Text>Edit</Text>
        </Pressable>
        <TaplineAlertHost />
      </View>,
    );
    useFrames({ 'form-cancel': frame(20, 100, 100, 40), 'row-a': frame(20, 200, 100, 40), 'row-b': frame(20, 300, 100, 40) });
    await act(async () => {
      Alert.alert('Delete item?', 'It will be gone', [{ text: 'Cancel', style: 'cancel' }, { text: 'OK' }]);
    });
  }

  test("{text} means the alert's button: no ambiguous, the alert closes", async () => {
    const onBehind = jest.fn();
    await mountWithAlert(onBehind);
    expect(openAlerts()).toHaveLength(1);
    const result = await run(() => press({ target: { text: 'Cancel' } }));
    expect(result.element.testID).toBe('tapline-alert-button-0');
    expect(openAlerts()).toHaveLength(0);
    expect(onBehind).not.toHaveBeenCalled();
  });

  test('with an index, the candidates are the ones in the alert', async () => {
    const onBehind = jest.fn();
    await mountWithAlert(onBehind);
    const result = await run(() => press({ target: { text: 'Cancel', index: 0 } }));
    expect(result.element.testID).toBe('tapline-alert-button-0');
    const error = await failure(run(() => press({ target: { text: 'OK', index: 1 } })));
    expect(error.code).toBe('not_found');
    expect(onBehind).not.toHaveBeenCalled();
  });

  test('several matches, none in the alert: still ambiguous, as without the alert', async () => {
    const onBehind = jest.fn();
    await mountWithAlert(onBehind);
    const error = await failure(run(() => press({ target: { text: 'Edit' } })));
    expect(error.code).toBe('ambiguous');
    expect(onBehind).not.toHaveBeenCalled();
  });

  test('one match, behind the alert: behind_alert, as before', async () => {
    const onBehind = jest.fn();
    await mountWithAlert(onBehind);
    const error = await failure(run(() => press({ target: { testID: 'form-cancel' } })));
    expect(error.message).toBe('behind_alert: "Delete item?" is open with [Cancel] [OK]; tap one of them first.');
    expect(onBehind).not.toHaveBeenCalled();
  });

  test('without an alert, two matches stay ambiguous', async () => {
    const onBehind = jest.fn();
    await mount(
      <View>
        <Pressable testID="a" onPress={onBehind}>
          <Text>Cancel</Text>
        </Pressable>
        <Pressable testID="b" onPress={onBehind}>
          <Text>Cancel</Text>
        </Pressable>
      </View>,
    );
    useFrames({ a: frame(20, 100, 100, 40), b: frame(20, 200, 100, 40) });
    const error = await failure(run(() => press({ target: { text: 'Cancel' } })));
    expect(error.code).toBe('ambiguous');
  });
});
