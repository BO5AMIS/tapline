import React from 'react';
import { I18nManager, PixelRatio } from 'react-native';
import { act, create } from 'react-test-renderer';
import * as actions from '../src/actions';
import { listCommands, registerLanguageCommand, registerRegionCommand, registerTaplineCommand, resetCommands, runCommand } from '../src/commands';
import { TEXT_SIZES, TEXT_SIZE_SCALES, getTaplineFontScale, resetFontScale, resetTaplineTextSize, subscribeTaplineFontScale, useTaplineFontScale } from '../src/locale';
import { TaplineError } from '../src/types';

async function failure(promise: Promise<unknown>): Promise<TaplineError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TaplineError) return error;
    throw error;
  }
  throw new Error('expected a TaplineError');
}

interface Answer {
  name: string;
  result: { say?: string; restart?: string; language?: string; region?: string; size?: string; scale?: number } | null;
}

async function run(name: string, args: Record<string, unknown>): Promise<Answer> {
  return (await runCommand({ name, args })) as Answer;
}

const rtl = I18nManager as { isRTL: boolean };
const globals = globalThis as { __DEV__?: boolean };
const originalDev = globals.__DEV__;
const originalIsRtl = I18nManager.isRTL;

afterEach(() => {
  resetCommands();
  resetFontScale();
  rtl.isRTL = originalIsRtl;
  globals.__DEV__ = originalDev;
  jest.restoreAllMocks();
});

describe('language and region validation', () => {
  test.each(['', 'a', 'english', 'en_GB', 'en-', 'ar sa', 7, 'en-u', 'en-x-', 'en-u-', 'en-u-a', 'en-u-ca-x', 'en-x-123456789', 'en-u-ca--gregory'])('language %p is bad_params', async (language) => {
    const handler = jest.fn();
    registerLanguageCommand(handler);
    expect((await failure(runCommand({ name: 'language', args: { language } }))).code).toBe('bad_params');
    expect((await failure(runCommand({ name: 'language' }))).code).toBe('bad_params');
    expect(handler).not.toHaveBeenCalled();
  });

  test.each(['ar', 'en', 'en-GB', 'zh-Hant-TW', 'fil', 'en-US-u-ca-gregory', 'de-x-test', 'en-a-bbb-x-a-ccc'])('language %p reaches the handler', async (language) => {
    // a change of direction reloads a development build: never for real in a test (it outlives the test run)
    jest.spyOn(actions, 'reload').mockResolvedValue({});
    const handler = jest.fn();
    registerLanguageCommand(handler);
    const answer = await run('language', { language });
    expect(handler).toHaveBeenCalledWith(language);
    expect(answer.result?.language).toBe(language);
  });

  test('a long bad tag is refused at once (the check is linear)', async () => {
    const handler = jest.fn();
    registerLanguageCommand(handler);
    const started = Date.now();
    const error = await failure(runCommand({ name: 'language', args: { language: `en${'-a'.repeat(42)}!` } }));
    expect(error.code).toBe('bad_params');
    expect(Date.now() - started).toBeLessThan(500);
  });

  test.each(['', 'Q', 'QAT', '12', 'q1', 5])('region %p is bad_params', async (region) => {
    const handler = jest.fn();
    registerRegionCommand(handler);
    expect((await failure(runCommand({ name: 'region', args: { region } }))).code).toBe('bad_params');
    expect(handler).not.toHaveBeenCalled();
  });

  test('region reaches the handler in upper case and the answer says so', async () => {
    const handler = jest.fn();
    registerRegionCommand(handler);
    const answer = await run('region', { region: 'qa' });
    expect(handler).toHaveBeenCalledWith('QA');
    expect(answer.result?.say).toBe('Region QA.');
  });

  test('a plain registration under the standard names is validated too, and given the checked args', async () => {
    const own = jest.fn();
    registerTaplineCommand('language', { description: 'my own', run: own });
    expect((await failure(runCommand({ name: 'language', args: { language: 'nope!' } }))).code).toBe('bad_params');
    await run('language', { language: 'fr' });
    expect(own).toHaveBeenCalledWith({ language: 'fr' });
    expect(listCommands().find((c) => c.name === 'language')?.description).toBe('my own');
  });

  test('a handler that throws is still an internal error', async () => {
    registerRegionCommand(() => {
      throw new Error('no such region data');
    });
    expect((await failure(runCommand({ name: 'region', args: { region: 'QA' } }))).code).toBe('internal');
  });
});

describe('built-in names', () => {
  test.each(['network', 'text_size'])('%s: the app registration is ignored with a one-time warning, never a throw', (name) => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    let off: (() => void) | undefined;
    expect(() => {
      off = registerTaplineCommand(name, { description: 'mine', run: () => undefined });
    }).not.toThrow();
    expect(() => off?.()).not.toThrow();
    registerTaplineCommand(name, { description: 'mine again', run: () => undefined });
    expect(listCommands().find((c) => c.name === name)?.description).not.toMatch(/mine/);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(name);
  });

  test('appearance: the app may replace the built-in, as in 1.3', async () => {
    const run = jest.fn(() => ({ mine: true }));
    const off = registerTaplineCommand('appearance', { description: 'mine', run });
    expect(listCommands().find((c) => c.name === 'appearance')?.description).toBe('mine');
    expect((await runCommand({ name: 'appearance', args: {} })).result).toEqual({ mine: true });
    off();
    expect(listCommands().find((c) => c.name === 'appearance')).toBeUndefined();
  });
});

describe('text_size and the font-scale helper', () => {
  function Probe({ seen }: { seen: number[] }): null {
    seen.push(useTaplineFontScale());
    return null;
  }

  test('without the helper it is unsupported and names the alternatives', async () => {
    const error = await failure(runCommand({ name: 'text_size', args: { size: 'xl' } }));
    expect(error.code).toBe('unsupported');
    expect(error.message).toContain('dynamic_type');
    expect(error.message).toContain('open_app');
    expect(error.message).toContain('text_size');
  });

  test.each(['', 'huge', 'XL', 'ax6', 12, undefined])('size %p is bad_params, helper or not', async (size) => {
    expect((await failure(runCommand({ name: 'text_size', args: { size } }))).code).toBe('bad_params');
  });

  test('the scale table matches the spec', () => {
    expect(TEXT_SIZES).toEqual(['xs', 's', 'm', 'l', 'xl', 'xxl', 'xxxl', 'ax1', 'ax2', 'ax3', 'ax4', 'ax5']);
    expect(TEXT_SIZES.map((size) => TEXT_SIZE_SCALES[size])).toEqual([0.82, 0.88, 0.94, 1, 1.12, 1.24, 1.35, 1.65, 1.94, 2.35, 2.76, 3.12]);
  });

  test('with the hook mounted it sets the override, the hook follows, and the answer names size and scale', async () => {
    jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(1.5);
    const seen: number[] = [];
    let tree: ReturnType<typeof create> | undefined;
    act(() => {
      tree = create(<Probe seen={seen} />);
    });
    expect(getTaplineFontScale()).toBe(1.5);
    expect(seen[seen.length - 1]).toBe(1.5);

    let answer: Answer | undefined;
    await act(async () => {
      answer = await run('text_size', { size: 'xl' });
    });
    expect(answer?.result?.say).toBe('Text size xl (1.12×).');
    expect(answer?.result?.scale).toBe(1.12);
    expect(getTaplineFontScale()).toBe(1.12);
    expect(seen[seen.length - 1]).toBe(1.12);

    await act(async () => {
      answer = await run('text_size', { size: 'l' });
    });
    expect(answer?.result?.say).toBe('Text size l (1×).');
    expect(seen[seen.length - 1]).toBe(1);
    act(() => tree?.unmount());
  });

  test('size "system" clears the override and answers with the phone\'s own scale', async () => {
    jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(1);
    const seen: number[] = [];
    let tree: ReturnType<typeof create> | undefined;
    act(() => {
      tree = create(<Probe seen={seen} />);
    });
    await act(async () => {
      await run('text_size', { size: 'ax3' });
    });
    expect(seen[seen.length - 1]).toBe(2.35);
    let answer: Answer | undefined;
    await act(async () => {
      answer = await run('text_size', { size: 'system' });
    });
    expect(answer?.result?.say).toBe("Text size: the phone's own (1.0×).");
    expect(answer?.result?.scale).toBe(1);
    expect(seen[seen.length - 1]).toBe(1);
    jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(1.3);
    await act(async () => {
      answer = await run('text_size', { size: 'system' });
    });
    expect(answer?.result?.say).toBe("Text size: the phone's own (1.3×).");
    act(() => tree?.unmount());
  });

  test('resetTaplineTextSize (session ended) clears the override', async () => {
    jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(1);
    let tree: ReturnType<typeof create> | undefined;
    act(() => {
      tree = create(<Probe seen={[]} />);
    });
    await act(async () => {
      await run('text_size', { size: 'xl' });
    });
    expect(getTaplineFontScale()).toBe(1.12);
    act(() => resetTaplineTextSize());
    expect(getTaplineFontScale()).toBe(1);
    act(() => tree?.unmount());
  });

  test('after the hook unmounts the helper is no longer in use', async () => {
    let tree: ReturnType<typeof create> | undefined;
    act(() => {
      tree = create(<Probe seen={[]} />);
    });
    await act(async () => {
      await run('text_size', { size: 'xl' });
    });
    act(() => tree?.unmount());
    expect((await failure(runCommand({ name: 'text_size', args: { size: 'l' } }))).code).toBe('unsupported');
  });

  test('"system" clears an override also after the screens that used the helper are gone', async () => {
    jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(1.1);
    let tree: ReturnType<typeof create> | undefined;
    act(() => {
      tree = create(<Probe seen={[]} />);
    });
    await act(async () => {
      await run('text_size', { size: 'xl' });
    });
    act(() => tree?.unmount());
    const answer = await run('text_size', { size: 'system' });
    expect(answer.result?.size).toBe('system');
    expect(getTaplineFontScale()).toBe(1.1);
  });

  test('a subscriber that throws does not stop the others', async () => {
    const seen: string[] = [];
    const stopBad = subscribeTaplineFontScale(() => {
      throw new Error('broken subscriber');
    });
    const stopGood = subscribeTaplineFontScale(() => seen.push('good'));
    expect((await run('text_size', { size: 'xl' })).result?.size).toBe('xl');
    expect(seen).toEqual(['good']);
    stopBad();
    stopGood();
  });

  test('an app that only calls the getter counts as using the helper until the session ends', async () => {
    getTaplineFontScale();
    expect((await run('text_size', { size: 'xl' })).result?.size).toBe('xl');
    resetTaplineTextSize();
    expect((await failure(runCommand({ name: 'text_size', args: { size: 'l' } }))).code).toBe('unsupported');
  });

  test('without an override the getter is the system font scale', () => {
    jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(1.3);
    expect(getTaplineFontScale()).toBe(1.3);
  });
});

describe('right-to-left', () => {
  test('into a right-to-left language in a development build: the app reloads and the answer says so', async () => {
    globals.__DEV__ = true;
    rtl.isRTL = false;
    const reload = jest.spyOn(actions, 'reload').mockResolvedValue({});
    const force = jest.spyOn(I18nManager, 'forceRTL').mockImplementation(() => undefined);
    jest.spyOn(I18nManager, 'allowRTL').mockImplementation(() => undefined);
    registerLanguageCommand(() => undefined);
    const answer = await run('language', { language: 'ar-QA' });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(force).toHaveBeenCalledWith(true);
    expect(answer.result?.restart).toBe('reload');
    expect(answer.result?.say).toContain('reloading the app');
    expect(answer.result?.say).toContain('right-to-left');
  });

  test('out of a right-to-left language in another build: the answer says the app must be restarted', async () => {
    globals.__DEV__ = false;
    rtl.isRTL = true;
    const reload = jest.spyOn(actions, 'reload').mockResolvedValue({});
    const force = jest.spyOn(I18nManager, 'forceRTL').mockImplementation(() => undefined);
    jest.spyOn(I18nManager, 'allowRTL').mockImplementation(() => undefined);
    registerLanguageCommand(() => undefined);
    const answer = await run('language', { language: 'en' });
    expect(reload).not.toHaveBeenCalled();
    expect(force).toHaveBeenCalledWith(false);
    expect(answer.result?.restart).toBe('required');
    expect(answer.result?.say).toContain('must be restarted');
    expect(answer.result?.say).toContain('left-to-right');
  });

  test.each(['he', 'fa-IR', 'ur'])('%s counts as right to left', async (language) => {
    globals.__DEV__ = false;
    rtl.isRTL = false;
    jest.spyOn(I18nManager, 'forceRTL').mockImplementation(() => undefined);
    jest.spyOn(I18nManager, 'allowRTL').mockImplementation(() => undefined);
    registerLanguageCommand(() => undefined);
    expect((await run('language', { language })).result?.restart).toBe('required');
  });

  test('ar then en before any restart: the second switch undoes the first and needs no restart', async () => {
    globals.__DEV__ = false;
    rtl.isRTL = false;
    const force = jest.spyOn(I18nManager, 'forceRTL').mockImplementation(() => undefined);
    jest.spyOn(I18nManager, 'allowRTL').mockImplementation(() => undefined);
    registerLanguageCommand(() => undefined);
    expect((await run('language', { language: 'ar' })).result?.restart).toBe('required');
    expect(force).toHaveBeenLastCalledWith(true);
    const back = await run('language', { language: 'en' });
    expect(force).toHaveBeenCalledTimes(2);
    expect(force).toHaveBeenLastCalledWith(false);
    expect(back.result?.restart).toBeUndefined();
    expect(back.result?.say).toContain('no restart');
  });

  test('ar twice before a restart: the direction is set once and the answer says it waits for a restart', async () => {
    globals.__DEV__ = false;
    rtl.isRTL = false;
    const force = jest.spyOn(I18nManager, 'forceRTL').mockImplementation(() => undefined);
    jest.spyOn(I18nManager, 'allowRTL').mockImplementation(() => undefined);
    registerLanguageCommand(() => undefined);
    await run('language', { language: 'ar' });
    const again = await run('language', { language: 'ar-QA' });
    expect(force).toHaveBeenCalledTimes(1);
    expect(again.result?.restart).toBe('required');
    expect(again.result?.say).toContain('restart');
  });

  test('no change of direction: no reload and no restart', async () => {
    globals.__DEV__ = true;
    rtl.isRTL = false;
    const reload = jest.spyOn(actions, 'reload').mockResolvedValue({});
    registerLanguageCommand(() => undefined);
    const answer = await run('language', { language: 'fr' });
    expect(reload).not.toHaveBeenCalled();
    expect(answer.result?.restart).toBeUndefined();
    expect(answer.result?.say).toBe('Language fr.');
  });
});
