import { frame, mount, unmountAll, useFrames } from './helpers';
import React from 'react';
import { Alert, Dimensions, PixelRatio, Pressable, Text } from 'react-native';
import { act } from 'react-test-renderer';
import { configureActions, press } from '../src/actions';
import { installAlertTracking, nativeAlert, uninstallAlertTracking } from '../src/alerts';
import { forgetLastTree, resetRefs, setMeasurer, tree } from '../src/inspect';
import { installNetworkTracking, uninstallNetworkTracking } from '../src/network';
import { TaplineError } from '../src/types';

/** A tiny XMLHttpRequest stand-in: requests stay in flight until `finish`. */
class FakeXhr {
  static open: FakeXhr[] = [];
  status = 0;
  readyState = 0;
  private listeners = new Map<string, Array<() => void>>();
  open(): void {}
  send(): void {
    FakeXhr.open.push(this);
  }
  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  finish(status: number): void {
    this.status = status;
    this.readyState = 4;
    for (const listener of this.listeners.get('loadend') ?? []) listener();
  }
}

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
  FakeXhr.open = [];
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 400, height: 800, scale: 2, fontScale: 1 });
  jest.spyOn(PixelRatio, 'get').mockReturnValue(2);
});

afterEach(async () => {
  uninstallAlertTracking();
  uninstallNetworkTracking();
  await unmountAll();
  setMeasurer(null);
  jest.restoreAllMocks();
});

test('tree reports an open alert with its buttons, and requests in flight', async () => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  installAlertTracking();
  installNetworkTracking({ target: { XMLHttpRequest: FakeXhr } });
  await mount(<Text>Workout</Text>);
  useFrames({});
  Alert.alert('Delete workout?', "This can't be undone.", [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive' },
  ]);
  const xhr = new FakeXhr();
  xhr.open();
  xhr.send();
  const result = await tree({});
  expect(result.alerts).toEqual([
    {
      kind: 'alert',
      title: 'Delete workout?',
      message: "This can't be undone.",
      buttons: [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive' },
      ],
      standIn: false,
    },
  ]);
  expect(result.network).toEqual({ inFlight: 1 });
  xhr.finish(200);
  const after = await tree({});
  expect(after.network).toBeUndefined();
});

test('a press is refused while an iOS alert is open, unless forced', async () => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  installAlertTracking();
  const onSave = jest.fn();
  await mount(
    <Pressable testID="save" onPress={onSave}>
      <Text>Save</Text>
    </Pressable>,
  );
  useFrames({ save: frame(20, 100, 100, 40) });
  Alert.alert('Saved', 'Your workout was saved.');
  const error = await failure(run(() => press({ target: { testID: 'save' } })));
  expect(error.code).toBe('not_actionable');
  expect(error.message).toMatch(/^behind_alert: /);
  expect(error.message).toContain('"Saved"');
  expect(error.message).toContain('stand-in');
  expect(onSave).not.toHaveBeenCalled();
  await run(() => press({ target: { testID: 'save' }, force: true }));
  expect(onSave).toHaveBeenCalledTimes(1);
});

test("Tapline's own prompts stay native: listed as a real alert, never a stand-in, and taps behind them are refused", async () => {
  const spy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  installAlertTracking({ standIn: true });
  const onSave = jest.fn();
  await mount(
    <Pressable testID="save" onPress={onSave}>
      <Text>Save</Text>
    </Pressable>,
  );
  useFrames({ save: frame(20, 100, 100, 40) });
  nativeAlert('Connect for testing?', 'My PC (100.64.0.7:7210)', [{ text: 'Connect' }]);
  expect(spy).toHaveBeenCalledWith('Connect for testing?', 'My PC (100.64.0.7:7210)', [expect.objectContaining({ text: 'Connect' })], expect.anything());
  expect((await tree({})).alerts).toEqual([expect.objectContaining({ title: 'Connect for testing?', standIn: false })]);
  const error = await failure(run(() => press({ target: { testID: 'save' } })));
  expect(error.message).toMatch(/^behind_alert: /);
  expect(onSave).not.toHaveBeenCalled();
});
