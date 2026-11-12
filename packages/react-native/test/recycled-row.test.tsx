import { mount, unmountAll } from './helpers';
import React, { useState } from 'react';
import { Dimensions, PixelRatio, Pressable, ScrollView, Text, View } from 'react-native';
import { configureActions, press } from '../src/actions';
import { propsOf, type Fiber } from '../src/fiber';
import { collectNodes, forgetLastTree, resetRefs, setHitTester, setMeasurer } from '../src/inspect';
import { isRecord, TaplineError } from '../src/types';

// Codex review of 1.4.0: a list that recycles its rows can hand the scrolled-to component another row's content
// ("Continue" becomes "Delete account"). The action is refused, and nothing is pressed.

function nearestId(fiber: Fiber): string | null {
  for (let up: Fiber | null = fiber; up; up = up.return) {
    if (up.tag !== 5) continue;
    const id = propsOf(up).testID;
    if (typeof id === 'string') return id;
  }
  return null;
}

let offset = 0;
let recycle: (title: string) => void = () => undefined;
const onContinue = jest.fn();

function Row({ label }: { label?: string }) {
  const [title, setTitle] = useState('Continue');
  recycle = setTitle;
  return (
    <Pressable testID="row" accessibilityLabel={label} onPress={onContinue}>
      <Text>{title}</Text>
    </Pressable>
  );
}

beforeAll(() => configureActions({ quietMs: 0, capMs: 0 }));
beforeEach(() => {
  resetRefs();
  forgetLastTree();
  onContinue.mockClear();
  offset = 0;
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 400, height: 800, scale: 2, fontScale: 1 });
  jest.spyOn(PixelRatio, 'get').mockReturnValue(2);
});
afterEach(async () => {
  await unmountAll();
  setMeasurer(null);
  setHitTester(null);
  jest.restoreAllMocks();
});

async function pressWhileRecycling(row: React.ReactElement, target: Record<string, string>): Promise<unknown> {
  await mount(
    <View>
      <ScrollView testID="list">{row}</ScrollView>
    </View>,
  );
  const list = collectNodes().find((n) => isRecord(n.fiber.memoizedProps) && n.fiber.memoizedProps.testID === 'list')?.fiber.stateNode;
  if (!isRecord(list)) throw new Error('no list');
  list.scrollTo = (arg: Record<string, unknown>) => {
    offset = Number(arg.y);
    recycle('Delete account'); // the list reuses the component for another row
  };
  setMeasurer(async (fiber) => {
    const id = nearestId(fiber);
    if (id === 'list') return fiber.tag === 5 && propsOf(fiber).testID === 'list' ? { x: 0, y: 0, width: 400, height: 800 } : { x: 0, y: -offset, width: 400, height: 4000 };
    if (id === 'row') return { x: 0, y: 2000 - offset, width: 400, height: 80 };
    return null;
  });
  // Outside act: React commits the recycled row during the scroll, as it does in an app.
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    await press({ target });
  } catch (caught) {
    return caught;
  }
  return undefined;
}

test('a row recycled into another while scrolling is refused, not pressed', async () => {
  const error = await pressWhileRecycling(<Row />, { text: 'Continue' });
  expect(error).toBeInstanceOf(TaplineError);
  expect((error as TaplineError).message).toMatch(/the element changed while the list scrolled \(it was "Continue", now "Delete account"\)/);
  expect(onContinue).not.toHaveBeenCalled();
});

test('a recycled row that keeps its id and accessibility label but changes its text is refused too', async () => {
  const error = await pressWhileRecycling(<Row label="Row action" />, { testID: 'row' });
  expect(error).toBeInstanceOf(TaplineError);
  expect((error as TaplineError).message).toMatch(/the element changed while the list scrolled \(it was "Continue", now "Delete account"\)/);
  expect(onContinue).not.toHaveBeenCalled();
});
