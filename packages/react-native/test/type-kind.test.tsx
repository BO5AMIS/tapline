import { frame, mount, unmountAll, useFrames } from './helpers';
import React from 'react';
import { Dimensions, PixelRatio, TextInput, View } from 'react-native';
import { act } from 'react-test-renderer';
import { configureActions, typeText } from '../src/actions';
import { resetRefs, setMeasurer, tree } from '../src/inspect';
import { TaplineError } from '../src/types';

// AGENT-TOOLS 1.13 §18.6: the host says what kind of field a test account's value may go into, and the
// app refuses before it types anything.

jest.mock(
  'react-native-safe-area-context',
  () => ({ initialWindowMetrics: { insets: { top: 47, bottom: 34, left: 0, right: 0 }, frame: { x: 0, y: 0, width: 400, height: 800 } } }),
  { virtual: true },
);

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

beforeEach(async () => {
  resetRefs();
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 400, height: 800, scale: 2, fontScale: 1 });
  jest.spyOn(PixelRatio, 'get').mockReturnValue(2);
  await mount(
    <View>
      <TextInput testID="email" accessibilityLabel="Email" />
      <TextInput testID="password" accessibilityLabel="Password" secureTextEntry />
    </View>,
  );
  useFrames({ email: frame(24, 100, 300, 44), password: frame(24, 160, 300, 44) });
});

afterEach(async () => {
  await unmountAll();
  setMeasurer(null);
  jest.restoreAllMocks();
});

function valueOf(elements: { testID?: string | null; value?: string | null }[], id: string): string | null | undefined {
  return elements.find((element) => element.testID === id)?.value;
}

describe('type with a kind', () => {
  test('kind "secure" refuses a plain field before typing', async () => {
    const error = await failure(run(() => typeText({ target: { testID: 'email' }, text: 'tester@example.com', kind: 'secure' })));
    expect(error.code).toBe('bad_params');
    expect(error.data).toEqual({ secure: false });
    const { elements } = await tree({});
    expect(valueOf(elements, 'email')).toBe('');
  });

  test('kind "plain" refuses a secure field before typing', async () => {
    const error = await failure(run(() => typeText({ target: { testID: 'password' }, text: 'not-a-real-password', kind: 'plain' })));
    expect(error.code).toBe('bad_params');
    expect(error.data).toEqual({ secure: true });
    expect(JSON.stringify(error.toWire())).not.toContain('not-a-real-password');
    const { elements } = await tree({});
    expect(valueOf(elements, 'password')).toBe('');
  });

  test('the matching kinds type', async () => {
    await run(() => typeText({ target: { testID: 'email' }, text: 'tester@example.com', kind: 'plain' }));
    const secure = await run(() => typeText({ target: { testID: 'password' }, text: 'fake-pass-1', kind: 'secure' }));
    expect(secure.secure).toBe(true);
    const { elements } = await tree({});
    expect(valueOf(elements, 'email')).toBe('tester@example.com');
  });

  test('no kind keeps today\'s behaviour in both kinds of field', async () => {
    await run(() => typeText({ target: { testID: 'email' }, text: 'abc' }));
    await run(() => typeText({ target: { testID: 'password' }, text: 'def' }));
    const { elements } = await tree({});
    expect(valueOf(elements, 'email')).toBe('abc');
    expect(valueOf(elements, 'password')).toBe('•••');
  });

  test('a kind that is neither is bad_params', async () => {
    const error = await failure(run(() => typeText({ target: { testID: 'email' }, text: 'x', kind: 'other' })));
    expect(error.code).toBe('bad_params');
  });
});
