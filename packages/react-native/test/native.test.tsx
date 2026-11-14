import { frame, mount, unmountAll, useFrames } from './helpers';
import React from 'react';
import { Alert, Dimensions, PixelRatio, Pressable, Text, View } from 'react-native';
import { act } from 'react-test-renderer';
import { configureActions, press, screenshot } from '../src/actions';
import { installAlertTracking, uninstallAlertTracking } from '../src/alerts';
import { forgetLastTree, resetRefs, tree } from '../src/inspect';
import { refreshCover, setNativeModule, type TaplineNativeModule } from '../src/native';
import { TaplineError } from '../src/types';

// Tapline's optional native module: frames without a forced render, and what UIKit draws over the
// app (an alert, the share sheet), which JavaScript alone can't see.

async function run<T>(fn: () => Promise<T>): Promise<T> {
  let result: T | undefined;
  await act(async () => {
    result = await fn();
  });
  return result as T;
}

function fakeNative(cover: unknown = { kind: '' }, data = 'NATIVEJPEG'): { module: TaplineNativeModule; captures: Array<[number, number, boolean]> } {
  const captures: Array<[number, number, boolean]> = [];
  return {
    captures,
    module: {
      capture: (width, quality, fresh) => {
        captures.push([width, quality, fresh]);
        return Promise.resolve(data);
      },
      cover: () => Promise.resolve(cover),
    },
  };
}

beforeAll(() => configureActions({ quietMs: 0, capMs: 0 }));

beforeEach(() => {
  resetRefs();
  forgetLastTree();
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 400, height: 800, scale: 3, fontScale: 1 });
  jest.spyOn(PixelRatio, 'get').mockReturnValue(3);
});

afterEach(async () => {
  await unmountAll();
  setNativeModule(undefined);
  uninstallAlertTracking();
  jest.restoreAllMocks();
});

describe('screenshots through the native module', () => {
  test('a look captures a fresh frame at the asked width, a viewer frame does not force one', async () => {
    const { module, captures } = fakeNative();
    setNativeModule(module);
    const shot = await screenshot({ maxWidth: 600, quality: 0.7 });
    expect(shot).toEqual({ mime: 'image/jpeg', data: 'NATIVEJPEG', width: 600, height: 1200 });
    await screenshot({ maxWidth: 400, quality: 0.5, fresh: false });
    expect(captures).toEqual([
      [600, 0.7, true],
      [400, 0.5, false],
    ]);
  });

  test('without the module, or when it draws nothing, view-shot is used as before', async () => {
    setNativeModule(null);
    await expect(screenshot({})).rejects.toMatchObject({ code: 'unsupported' });
    setNativeModule(fakeNative({ kind: '' }, '').module);
    await expect(screenshot({})).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('what UIKit draws over the app', () => {
  async function mountScreen(onSave: () => void): Promise<void> {
    await mount(
      <View>
        <Pressable testID="save" onPress={onSave}>
          <Text>Save</Text>
        </Pressable>
      </View>,
    );
    useFrames({ save: frame(16, 300, 200, 48) });
  }

  test('an alert only UIKit knows of is listed and a tap behind it is refused', async () => {
    const onSave = jest.fn();
    await mountScreen(onSave);
    setNativeModule(fakeNative({ kind: 'alert', title: 'Delete?', message: 'For good.', buttons: ['Cancel', 'Delete'], destructive: [false, true] }).module);
    const result = await run(() => tree({}));
    expect(result.alerts).toEqual([
      {
        kind: 'alert',
        title: 'Delete?',
        message: 'For good.',
        buttons: [
          { text: 'Cancel', style: 'default' },
          { text: 'Delete', style: 'destructive' },
        ],
        standIn: false,
      },
    ]);
    let error: unknown;
    try {
      await run(() => press({ target: { testID: 'save' } }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TaplineError);
    expect((error as TaplineError).message).toMatch(/^behind_alert: /);
    expect(onSave).not.toHaveBeenCalled();
  });

  test('an OS alert with no message reports message null (the host leaves it out of the Alert: line)', async () => {
    await mountScreen(jest.fn());
    setNativeModule(fakeNative({ kind: 'alert', title: 'Saved', message: '', buttons: ['OK'], destructive: [false] }).module);
    const result = await run(() => tree({}));
    expect(result.alerts?.map((alert) => [alert.title, alert.message])).toEqual([['Saved', null]]);
  });

  test('the share sheet reads as an OS alert named "Share sheet"', async () => {
    await mountScreen(jest.fn());
    setNativeModule(fakeNative({ kind: 'share', title: '', message: '', buttons: [], destructive: [] }).module);
    const result = await run(() => tree({}));
    expect(result.alerts?.map((alert) => [alert.title, alert.standIn])).toEqual([['Share sheet', false]]);
  });

  test('an Alert.alert the SDK tracks is not listed twice', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    installAlertTracking();
    await mountScreen(jest.fn());
    Alert.alert('Heads up', 'Something happened.');
    setNativeModule(fakeNative({ kind: 'alert', title: 'Heads up', message: 'Something happened.', buttons: ['OK'], destructive: [false] }).module);
    const result = await run(() => tree({}));
    expect(result.alerts?.map((alert) => alert.title)).toEqual(['Heads up']);
  });

  test('nothing in front, a module that fails, or no module: no alert', async () => {
    await mountScreen(jest.fn());
    setNativeModule(fakeNative({ kind: '' }).module);
    expect((await run(() => tree({}))).alerts).toBeUndefined();
    setNativeModule({ capture: () => Promise.resolve(''), cover: () => Promise.reject(new Error('no window')) });
    expect(await refreshCover()).toBeNull();
    setNativeModule(null);
    expect((await run(() => tree({}))).alerts).toBeUndefined();
  });
});

test('viewer frames keep their sharpness in landscape: the size follows the short side', async () => {
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 800, height: 400, scale: 3, fontScale: 1 });
  const { module, captures } = fakeNative();
  setNativeModule(module);
  const frame = await screenshot({ maxWidth: 600, quality: 0.6, fresh: false, fitShortSide: true });
  expect(frame.width).toBe(1200);
  expect(frame.height).toBe(600);
  const shot = await screenshot({ maxWidth: 600, quality: 0.6 });
  expect(shot.width).toBe(600);
  expect(captures.map((c) => c[0])).toEqual([1200, 600]);
});
