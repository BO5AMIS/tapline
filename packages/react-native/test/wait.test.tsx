import { mount, unmountAll, useFrames } from './helpers';
import React from 'react';
import { Dimensions, PixelRatio, Text, View } from 'react-native';
import { act } from 'react-test-renderer';
import { resetRefs, setMeasurer } from '../src/inspect';
import { setNetworkIdleProvider, waitFor } from '../src/wait';
import { TaplineError } from '../src/types';

function Screen({ saved, loading }: { saved: boolean; loading: boolean }) {
  return (
    <View>
      {loading ? <Text testID="spinner">Loading…</Text> : null}
      {saved ? <Text accessibilityLabel="Saved banner">Saved!</Text> : null}
    </View>
  );
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

const later = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  resetRefs();
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 400, height: 800, scale: 2, fontScale: 1 });
  jest.spyOn(PixelRatio, 'get').mockReturnValue(2);
});

afterEach(async () => {
  await unmountAll();
  setMeasurer(null);
  setNetworkIdleProvider(null);
  jest.restoreAllMocks();
});

test('waits until text appears', async () => {
  const renderer = await mount(<Screen saved={false} loading />);
  useFrames({});
  const waiting = waitFor({ text: 'saved', timeout: 3 });
  await later(300);
  await act(async () => {
    renderer.update(<Screen saved loading={false} />);
  });
  const result = await waiting;
  expect(result.met).toBe(true);
  expect(result.waitedMs).toBeGreaterThanOrEqual(250);
});

test('waits until an element is gone, by testID or label', async () => {
  const renderer = await mount(<Screen saved loading />);
  useFrames({});
  const spinnerGone = waitFor({ testID: 'spinner', gone: true, timeout: 3 });
  await later(300);
  await act(async () => {
    renderer.update(<Screen saved loading={false} />);
  });
  expect((await spinnerGone).met).toBe(true);
  expect((await waitFor({ label: 'saved banner', timeout: 1 })).met).toBe(true);
});

test('a condition already true returns at once', async () => {
  await mount(<Screen saved loading={false} />);
  useFrames({});
  const result = await waitFor({ text: 'Saved!' });
  expect(result.met).toBe(true);
  expect(result.waitedMs).toBeLessThan(250); // no poll interval went by
});

test('times out with a plain message', async () => {
  await mount(<Screen saved={false} loading />);
  useFrames({});
  const error = await failure(waitFor({ text: 'Never', timeout: 0.5 }));
  expect(error.code).toBe('timeout');
  expect(error.message).toBe('Waited 0.5 s for text "Never" to appear; it didn\'t happen.');
});

test('the timeout uses the shared words: id as the agent writes it, and "to disappear"', async () => {
  await mount(<Screen saved={false} loading />);
  useFrames({});
  const error = await failure(waitFor({ testID: 'spinner', gone: true, timeout: 0.5 }));
  expect(error.message).toMatch(/^Waited 0\.5 s for id "spinner" to disappear; it didn't happen\.$/);
});

test('waits for the network to go quiet', async () => {
  await mount(<Screen saved loading={false} />);
  useFrames({});
  let busy = 2;
  setNetworkIdleProvider(() => busy === 0);
  const waiting = waitFor({ networkIdle: true, timeout: 3 });
  await later(300);
  busy = 0;
  expect((await waiting).met).toBe(true);
});

test('needs something to wait for, and a sane timeout', async () => {
  expect((await failure(waitFor({}))).code).toBe('bad_params');
  expect((await failure(waitFor({ text: 'x', timeout: 99 }))).code).toBe('bad_params');
});
