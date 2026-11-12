import { mount, unmountAll, useFrames } from './helpers';
import React from 'react';
import { Dimensions, PixelRatio, ScrollView, Text, View } from 'react-native';
import { resetRefs, setMeasurer } from '../src/inspect';
import { setNetworkIdleProvider, waitFor } from '../src/wait';
import { TaplineError } from '../src/types';

// AGENT-TOOLS 1.13 §9.1: `if` and `optional` look once. `once: true` is that one look: no poll, no timeout.

function Screen({ spinner }: { spinner: boolean }) {
  return (
    <View>
      {spinner ? <Text testID="spinner">Loading…</Text> : null}
      <Text accessibilityLabel="Saved banner">Saved!</Text>
      <Text>{'Order 4411 is on its way to the warehouse in the north of the city and will arrive on Friday morning'}</Text>
    </View>
  );
}

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

test('once answers found true or false at once, without waiting', async () => {
  await mount(<Screen spinner={false} />);
  useFrames({});
  const started = Date.now();
  expect(await waitFor({ text: 'saved', once: true })).toEqual({ found: true });
  expect(await waitFor({ text: 'Not now', once: true })).toEqual({ found: false });
  expect(await waitFor({ testID: 'spinner', once: true })).toEqual({ found: false });
  expect(await waitFor({ label: 'saved banner', once: true })).toEqual({ found: true });
  // The polling path would take its 250 ms step at least once for the misses; one read does not.
  expect(Date.now() - started).toBeLessThan(200);
});

test('once with gone says found when the element is gone', async () => {
  await mount(<Screen spinner={false} />);
  useFrames({});
  expect(await waitFor({ testID: 'spinner', gone: true, once: true })).toEqual({ found: true });
  expect(await waitFor({ text: 'Saved', gone: true, once: true })).toEqual({ found: false });
});

test('once needs no timeout, and a bad one is still refused', async () => {
  await mount(<Screen spinner={false} />);
  useFrames({});
  await expect(waitFor({ text: 'Saved', once: true, timeout: 99 })).rejects.toBeInstanceOf(TaplineError);
  await expect(waitFor({ once: true })).rejects.toMatchObject({ code: 'bad_params' });
});

test('once matches what the polling path matches, including a long text read whole', async () => {
  await mount(<Screen spinner />);
  useFrames({});
  for (const probe of [
    { text: 'arrive on friday morning' },
    { text: 'warehouse' },
    { text: 'order 4411' },
    { testID: 'spinner' },
    { label: 'SAVED BANNER' },
    { text: 'nothing like it' },
    { testID: 'nope' },
    { testID: 'spinner', gone: true },
  ]) {
    const once = await waitFor({ ...probe, once: true });
    let polled: boolean;
    try {
      polled = (await waitFor({ ...probe, timeout: 0.5 })).met;
    } catch {
      polled = false;
    }
    expect({ probe, found: once.found }).toEqual({ probe, found: polled });
  }
});

test('an element below the fold counts as there, as it does for the polling path (AGENT-TOOLS 1.13 §9.1)', async () => {
  await mount(
    <ScrollView>
      <View style={{ height: 5000 }} />
      <Text testID="footer">Terms and conditions</Text>
    </ScrollView>,
  );
  useFrames({});
  expect(await waitFor({ text: 'Terms and conditions', once: true })).toEqual({ found: true });
  expect(await waitFor({ testID: 'footer', once: true })).toEqual({ found: true });
  expect((await waitFor({ testID: 'footer', timeout: 0.5 })).met).toBe(true);
});
