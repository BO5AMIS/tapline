import { frame, mount, unmountAll, useFrames } from './helpers';
import React from 'react';
import { Dimensions, PixelRatio, Pressable, Text, View } from 'react-native';
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
  });
});

describe('overlay', () => {
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
    // refs still point where they did
    expect((await tree({ changes: true })).elements.find((e) => e.testID === 'save')?.ref).toBe(saveRef);
  });
});
