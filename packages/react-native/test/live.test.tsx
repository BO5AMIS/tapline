import { frame, mount, unmountAll, useFrames } from './helpers';
import React from 'react';
import { Dimensions, Image, PixelRatio, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { setEventSink } from '../src/events';
import { overlay, resetRefs, setMeasurer, tree } from '../src/inspect';
import { configureLiveFeed, feedMethod, frameAfterAction, stopLiveFeed } from '../src/live';
import { TaplineError } from '../src/types';

const sent: Array<[string, unknown]> = [];
let captures = 0;

beforeEach(() => {
  resetRefs();
  sent.length = 0;
  captures = 0;
  setEventSink((event, data) => sent.push([event, data]));
  configureLiveFeed({
    capture: async () => {
      captures += 1;
      return { mime: 'image/jpeg', data: 'QUJD', width: 400, height: 800 };
    },
    requestAnimationFrame: undefined,
  });
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 400, height: 800, scale: 2, fontScale: 1 });
  jest.spyOn(PixelRatio, 'get').mockReturnValue(2);
});

afterEach(async () => {
  stopLiveFeed();
  setEventSink(null);
  configureLiveFeed({});
  await unmountAll();
  setMeasurer(null);
  jest.restoreAllMocks();
});

const later = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('the live feed', () => {
  test('starts on request, sends frames to the host as "frame" events, and stops', async () => {
    const started = await feedMethod({ on: true, quality: 'light' });
    expect(started).toMatchObject({ on: true, quality: 'light' });
    await later(20);
    const frames = sent.filter(([event]) => event === 'frame');
    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(frames[0]?.[1]).toMatchObject({ seq: 1, mime: 'image/jpeg', data: 'QUJD', width: 400 });
    const stopped = await feedMethod({ on: false });
    expect(stopped.on).toBe(false);
    expect(stopped.stats?.frames).toBeGreaterThanOrEqual(1);
    const count = captures;
    frameAfterAction();
    await later(400);
    expect(captures).toBe(count); // stopped: nothing more
  });

  test('captures again soon after an action', async () => {
    await feedMethod({ on: true });
    await later(400);
    const before = captures;
    frameAfterAction();
    await later(450);
    expect(captures).toBeGreaterThan(before);
  });

  test('validates its params', async () => {
    await expect(feedMethod({ on: 'yes' })).rejects.toBeInstanceOf(TaplineError);
    await expect(feedMethod({ on: true, quality: 'ultra' })).rejects.toBeInstanceOf(TaplineError);
    await expect(feedMethod({ on: true, gapMs: 10 })).rejects.toBeInstanceOf(TaplineError);
    await expect(feedMethod({ on: true, gapMs: '100' })).rejects.toBeInstanceOf(TaplineError);
    await expect(feedMethod({ on: true, gapMs: Number.NaN })).rejects.toBeInstanceOf(TaplineError);
  });

  test('a different gapMs restarts the feed; the same one keeps it', async () => {
    await feedMethod({ on: true, gapMs: 200 });
    await later(20);
    const same = await feedMethod({ on: true, gapMs: 200, quality: 'sharp' });
    expect(same.stats?.frames).toBeGreaterThanOrEqual(1); // still the first feed
    const restarted = await feedMethod({ on: true, gapMs: 100 });
    expect(restarted.stats?.frames).toBe(0); // a new feed
    const back = await feedMethod({ on: true });
    expect(back.stats?.frames).toBe(0); // back to the live pace: new again
  });
});

describe('overlay', () => {
  test('boxes carry the shared role: other for a plain container, scroll, input, image', async () => {
    await mount(
      <View testID="box" accessibilityLabel="Box">
        <ScrollView testID="list" />
        <TextInput testID="field" />
        <Image testID="pic" />
      </View>,
    );
    useFrames({ box: frame(0, 0, 100, 100), list: frame(0, 0, 100, 50), field: frame(0, 50, 100, 20), pic: frame(0, 70, 20, 20) });
    const types = Object.fromEntries((await overlay()).elements.map((e) => [e.id, e.type]));
    expect(types).toEqual({ box: 'other', list: 'scroll', field: 'input', pic: 'image' });
  });

  test('lists the elements with their frames and the revision, without changing refs', async () => {
    await mount(
      <View>
        <Pressable testID="save" accessibilityLabel="Save" onPress={() => undefined}>
          <Text>Save</Text>
        </Pressable>
        <Text testID="note">Saved 2 minutes ago</Text>
      </View>,
    );
    useFrames({ save: frame(20, 40, 100, 44), note: frame(20, 100, 200, 20) });
    const listed = await tree({});
    const saveRef = listed.elements.find((e) => e.testID === 'save')?.ref;
    const result = await overlay();
    expect(result.screen).toEqual({ width: 400, height: 800, scale: 2 });
    expect(typeof result.rev).toBe('number');
    expect(result.elements).toContainEqual({ ref: saveRef, type: 'button', label: 'Save', id: 'save', frame: { x: 20, y: 40, width: 100, height: 44 } });
    expect(result.elements.some((e) => e.id === 'note' && e.label === 'Saved 2 minutes ago')).toBe(true);
    // the viewer names things by the shared role, like the agent's lines: never a component name
    expect(result.elements.find((e) => e.id === 'note')?.type).toBe('text');
    // refs still point where they did
    expect((await tree({ changes: true })).elements.find((e) => e.testID === 'save')?.ref).toBe(saveRef);
  });
});

describe('adaptive quality (nextQuality)', () => {
  const { nextQuality } = jest.requireActual<typeof import('../src/live')>('../src/live');
  const link = (latencyMs: number, sinceChangeMs = 5000, framesLastSecond = 0) => ({ latencyMs, sinceChangeMs, framesLastSecond });

  test('a slow link steps down one preset at a time, never below light', () => {
    expect(nextQuality('sharp', 'sharp', link(300))).toBe('balanced');
    expect(nextQuality('balanced', 'sharp', link(300))).toBe('light');
    expect(nextQuality('light', 'sharp', link(300))).toBe('light');
  });

  test('a quick link steps back up only when the screen is nearly still, and not past the choice', () => {
    expect(nextQuality('light', 'balanced', link(30, 5000, 15))).toBe('light');
    expect(nextQuality('light', 'balanced', link(30, 5000, 2))).toBe('balanced');
    expect(nextQuality('balanced', 'balanced', link(30, 5000, 0))).toBe('balanced');
  });

  test('it waits after a change before stepping up, and a lower choice wins at once', () => {
    expect(nextQuality('light', 'sharp', link(30, 500, 0))).toBe('light');
    expect(nextQuality('sharp', 'light', link(30))).toBe('light');
    expect(nextQuality('balanced', 'balanced', link(100))).toBe('balanced');
  });
});

describe('adaptive quality on a still screen', () => {
  const { nextQuality } = jest.requireActual<typeof import('../src/live')>('../src/live');
  test('the latest quick answer steps up, though the smoothed time is still high', () => {
    expect(nextQuality('light', 'balanced', { latencyMs: 180, lastMs: 30, sinceChangeMs: 5000, framesLastSecond: 1 })).toBe('balanced');
    expect(nextQuality('light', 'balanced', { latencyMs: 180, lastMs: 120, sinceChangeMs: 5000, framesLastSecond: 1 })).toBe('light');
  });
});

test('right after stepping up, a lagging smoothed time with a quick latest answer does not step down again', () => {
  const { nextQuality } = jest.requireActual<typeof import('../src/live')>('../src/live');
  expect(nextQuality('balanced', 'balanced', { latencyMs: 170, lastMs: 25, sinceChangeMs: 100, framesLastSecond: 1 })).toBe('balanced');
  expect(nextQuality('balanced', 'balanced', { latencyMs: 170, lastMs: 220, sinceChangeMs: 100, framesLastSecond: 12 })).toBe('light');
});
