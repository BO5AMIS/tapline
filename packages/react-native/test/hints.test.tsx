import { frame, mount, unmountAll, useFrames } from './helpers';
import React from 'react';
import { Alert, Dimensions, PixelRatio, Pressable, Switch, Text, View } from 'react-native';
import { act } from 'react-test-renderer';
import { configureActions, press, toggle } from '../src/actions';
import { installAlertTracking, TaplineAlertHost, uninstallAlertTracking } from '../src/alerts';
import { forgetLastTree, resetRefs, setMeasurer, tree } from '../src/inspect';
import { TaplineError } from '../src/types';

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
  uninstallAlertTracking();
  setMeasurer(null);
  jest.restoreAllMocks();
});

describe("behind Tapline's own in-app alert (the stand-in)", () => {
  async function mountWithAlert(onSave: () => void): Promise<void> {
    installAlertTracking({ standIn: true });
    await mount(
      <View style={{ flex: 1 }}>
        <Pressable testID="save" onPress={onSave}>
          <Text>Save</Text>
        </Pressable>
        <TaplineAlertHost />
      </View>,
    );
    useFrames({ save: frame(20, 100, 100, 40) });
    await act(async () => {
      Alert.alert('Delete item?', 'It will be gone', [{ text: 'Cancel', style: 'cancel' }, { text: 'OK' }]);
    });
  }

  test('a tap on something behind it is behind_alert, naming the alert and its buttons', async () => {
    const onSave = jest.fn();
    await mountWithAlert(onSave);
    const error = await failure(run(() => press({ target: { testID: 'save' } })));
    expect(error.code).toBe('not_actionable');
    expect(error.message).toBe('behind_alert: "Delete item?" is open with [Cancel] [OK]; tap one of them first.');
    expect(onSave).not.toHaveBeenCalled();
  });

  test('force acts anyway, as for every other reason that force can skip', async () => {
    const onSave = jest.fn();
    await mountWithAlert(onSave);
    await run(() => press({ target: { testID: 'save' }, force: true }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  test("the alert's own buttons stay tappable and answer it", async () => {
    const onSave = jest.fn();
    installAlertTracking({ standIn: true });
    await mount(
      <View style={{ flex: 1 }}>
        <Pressable testID="save" onPress={onSave}>
          <Text>Save</Text>
        </Pressable>
        <TaplineAlertHost />
      </View>,
    );
    useFrames({ save: frame(20, 100, 100, 40) });
    const onCancel = jest.fn();
    await act(async () => {
      Alert.alert('Delete item?', undefined, [{ text: 'Cancel', style: 'cancel', onPress: onCancel }, { text: 'OK' }]);
    });
    const result = await run(() => press({ target: { testID: 'tapline-alert-button-0' } }));
    expect(result.element.testID).toBe('tapline-alert-button-0');
    expect(onCancel).toHaveBeenCalledTimes(1);
    // Answered: the screen behind is reachable again.
    await run(() => press({ target: { testID: 'save' } }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  test('a toggle behind it is refused the same way', async () => {
    const onChange = jest.fn();
    installAlertTracking({ standIn: true });
    await mount(
      <View style={{ flex: 1 }}>
        <Switch testID="sw" value={false} onValueChange={onChange} />
        <TaplineAlertHost />
      </View>,
    );
    useFrames({ sw: frame(20, 100, 60, 30) });
    await act(async () => {
      Alert.alert('Heads up');
    });
    const error = await failure(run(() => toggle({ target: { testID: 'sw' } })));
    expect(error.message).toBe('behind_alert: "Heads up" is open with [OK]; tap one of them first.');
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('what a disabled refusal says to do next', () => {
  test('press and toggle say the app has to enable it, and force really does not apply', async () => {
    const onPress = jest.fn();
    await mount(
      <View>
        <Pressable testID="off" disabled onPress={onPress}>
          <Text>Disabled</Text>
        </Pressable>
      </View>,
    );
    useFrames({ off: frame(0, 0, 100, 40) });
    const expected = /^disabled: e\d+ button "Disabled" is disabled; the app has to enable it first \(force doesn't apply\)\.$/;
    expect((await failure(run(() => press({ target: { testID: 'off' } })))).message).toMatch(expected);
    // `force: true` is not an answer to `disabled`: the handler still isn't called.
    expect((await failure(run(() => press({ target: { testID: 'off' }, force: true })))).message).toMatch(expected);
    expect(onPress).not.toHaveBeenCalled();
  });

  test('a disabled switch says the same', async () => {
    await mount(<Switch testID="sw" value={false} disabled onValueChange={() => undefined} />);
    useFrames({ sw: frame(0, 0, 60, 30) });
    const error = await failure(run(() => toggle({ target: { testID: 'sw' } })));
    expect(error.message).toMatch(/^disabled: e\d+ switch id=sw is disabled; the app has to enable it first \(force doesn't apply\)\.$/);
  });
});

describe('a change to a label that only repeats the text is one changed field', () => {
  function Counter({ n, label }: { n: string; label?: string }) {
    return (
      <View>
        <Text testID="count" accessibilityLabel={label ?? n}>
          {n}
        </Text>
      </View>
    );
  }

  test('text and an identical label change together: only text is reported', async () => {
    const renderer = await mount(<Counter n="2 items" />);
    useFrames({ count: frame(0, 0, 100, 20) });
    const before = await tree({});
    const found = before.elements.find((e) => e.testID === 'count');
    expect(found).toMatchObject({ text: '2 items', label: '2 items' });
    await act(async () => {
      renderer.update(<Counter n="3 items" />);
    });
    const after = await tree({ changes: true });
    expect(after.changes?.changed).toEqual([{ ref: found?.ref, was: { text: '2 items' } }]);
  });

  test('a label that differs from the text and changes still counts', async () => {
    const renderer = await mount(<Counter n="2" label="2 items in basket" />);
    useFrames({ count: frame(0, 0, 100, 20) });
    const before = await tree({});
    const ref = before.elements.find((e) => e.testID === 'count')?.ref;
    await act(async () => {
      renderer.update(<Counter n="3" label="3 items in basket" />);
    });
    const after = await tree({ changes: true });
    expect(after.changes?.changed).toEqual([{ ref, was: { text: '2', label: '2 items in basket' } }]);
  });

  test('a label that becomes shown or hidden counts: the line changes', async () => {
    const renderer = await mount(<Counter n="2" label="2" />);
    useFrames({ count: frame(0, 0, 100, 20) });
    const before = await tree({});
    const ref = before.elements.find((e) => e.testID === 'count')?.ref;
    await act(async () => {
      renderer.update(<Counter n="2" label="two" />);
    });
    const after = await tree({ changes: true });
    expect(after.changes?.changed).toEqual([{ ref, was: { label: '2' } }]);
  });

  test('a label change that the line never shows is no change', async () => {
    const renderer = await mount(<Counter n="Basket" label="Basket" />);
    useFrames({ count: frame(0, 0, 100, 20) });
    await tree({});
    await act(async () => {
      renderer.update(<Counter n="Basket" label="BASKET" />);
    });
    const after = await tree({ changes: true });
    expect(after.changes?.changed).toEqual([]);
  });
});
