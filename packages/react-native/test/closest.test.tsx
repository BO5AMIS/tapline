import { mount, unmountAll } from './helpers';
import React from 'react';
import { Dimensions, PixelRatio, Pressable, Text, View } from 'react-native';
import { act } from 'react-test-renderer';
import { press } from '../src/actions';
import { closeness, closestMatches, editDistance, wordsOf } from '../src/closest';
import { propsOf, type Fiber } from '../src/fiber';
import { forgetLastTree, resetRefs, setMeasurer } from '../src/inspect';
import { TaplineError } from '../src/types';

// AGENT-TOOLS 1.12 §16.2: a not_found lists up to 3 closest matches.

describe('what is close', () => {
  test('the same words in another case or order', () => {
    expect(closeness('save draft', 'Save Draft')).toBe('same-words');
    expect(closeness('Draft save', 'save draft')).toBe('same-words');
    expect(closeness('save-draft', 'Save draft')).toBe('same-words');
  });

  test('one contained in the other', () => {
    expect(closeness('Save', 'Save draft')).toBe('contained');
    expect(closeness('Save draft now', 'draft')).toBe('contained');
    expect(closeness('Save', 'Saved')).toBe('contained');
  });

  test('a small edit distance: 2 up to 10 characters, 3 above', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(closeness('Settings', 'Setings')).toBe('edit-distance'); // 1
    expect(closeness('Profile', 'Prfoile')).toBe('edit-distance'); // 2 (a swap)
    expect(closeness('Profile', 'Prfiole')).toBe('edit-distance');
    expect(closeness('Cancel', 'Cansul')).toBe('edit-distance'); // 2
    expect(closeness('Cancel', 'Cxnsxl')).toBeNull(); // 3 in 6 characters: no
    // 11 characters: 3 are allowed, 4 are not
    expect(closeness('notification', 'notificatoin')).toBe('edit-distance'); // 2
    expect(closeness('preferences', 'prefarunkes')).toBe('edit-distance'); // 3
    expect(closeness('preferences', 'prefarunkxs')).toBeNull(); // 4
  });

  test('a match on only a common word does not count', () => {
    for (const stop of ['the', 'a', 'of', 'to', 'and', 'in']) {
      expect(closeness(stop, `${stop} home`)).toBeNull();
      expect(closeness(`Go ${stop}`, stop)).toBeNull();
    }
    expect(closeness('The', 'Skip the tour')).toBeNull();
    // a common word beside a real one still counts
    expect(closeness('Back to home', 'home')).toBe('contained');
  });

  test('texts with nothing in common, and empty ones, are not close', () => {
    expect(closeness('Save', 'Delete account')).toBeNull();
    expect(closeness('', 'Save')).toBeNull();
    expect(closeness('Save', '  ')).toBeNull();
    expect(wordsOf('Save-draft_2!')).toEqual(['save', 'draft', '2']);
  });

  test('the closest come first, at most 3, and each kind of target looks at its own strings', () => {
    const candidates = [
      { testID: 'save-draft', label: null, text: 'Save draft' },
      { testID: null, label: 'Saved', text: 'Saved' },
      { testID: null, label: null, text: 'Delete' },
      { testID: 'save', label: 'Save', text: 'Save' },
      { testID: 'save-now', label: null, text: 'Save now' },
      { testID: 'sav', label: null, text: 'Sav' },
    ];
    expect(closestMatches('text', 'Save', candidates)).toEqual([3, 1, 5]); // the same words, then contained, the shorter gap first
    expect(closestMatches('testID', 'save', candidates)).toEqual([3, 5, 4]);
    expect(closestMatches('label', 'Saved', candidates)).toEqual([1, 3, 5]);
    expect(closestMatches('text', 'Zebra', candidates)).toEqual([]);
    // an id is not compared with texts
    expect(closestMatches('testID', 'delete', candidates)).toEqual([]);
  });
});

describe('the not_found answer', () => {
  function nearestId(fiber: Fiber): string | null {
    for (let up: Fiber | null = fiber; up; up = up.return) {
      if (up.tag !== 5) continue;
      const id = propsOf(up).testID;
      if (typeof id === 'string') return id;
    }
    return null;
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

  beforeEach(() => {
    resetRefs();
    forgetLastTree();
    jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 400, height: 800, scale: 2, fontScale: 1 });
    jest.spyOn(PixelRatio, 'get').mockReturnValue(2);
  });

  afterEach(async () => {
    await unmountAll();
    setMeasurer(null);
    jest.restoreAllMocks();
  });

  async function mountScreen(): Promise<void> {
    await mount(
      <View>
        <Pressable testID="save-draft" onPress={() => undefined}>
          <Text>Save draft</Text>
        </Pressable>
        <Pressable testID="saved" onPress={() => undefined}>
          <Text>Saved</Text>
        </Pressable>
        <Pressable testID="later" onPress={() => undefined}>
          <Text>Later</Text>
        </Pressable>
      </View>,
    );
    const frames: Record<string, { x: number; y: number; width: number; height: number }> = {
      'save-draft': { x: 0, y: 100, width: 400, height: 40 },
      saved: { x: 0, y: 1500, width: 400, height: 40 }, // below the screen
      later: { x: 0, y: 200, width: 400, height: 40 },
    };
    setMeasurer(async (fiber) => {
      const id = nearestId(fiber);
      return id !== null ? (frames[id] ?? null) : null;
    });
  }

  test('lists the closest, with the position of an off-screen one, in the shape of an element line', async () => {
    await act(async () => {
      await mountScreen();
    });
    const error = await failure(act(async () => { await press({ target: { label: 'Save' } }); }));
    // both rows contain "save": the whole-word one is closer than the longer one
    expect(error.code).toBe('not_found');
    expect(error.message).toMatch(
      /^nothing on screen has label "Save"; use {text} for a partial match, or look. Closest: e\d+ (button|text) "Saved" id=saved \(off screen, below\), e\d+ (button|text) "Save draft" id=save-draft\.$/,
    );
  });

  test('an id is compared with ids', async () => {
    await act(async () => {
      await mountScreen();
    });
    const error = await failure(act(async () => { await press({ target: { testID: 'save-draf' } }); }));
    expect(error.message).toMatch(/^nothing on screen has id "save-draf"; look, then pick another target\. Closest: e\d+ \w+ "Save draft" id=save-draft/);
    expect(error.message).not.toContain('(off screen');
  });

  test('with nothing close there is no Closest part', async () => {
    await act(async () => {
      await mountScreen();
    });
    const error = await failure(act(async () => { await press({ target: { text: 'Zebra crossing' } }); }));
    expect(error.message).toBe('nothing on screen shows "Zebra crossing"; look, then pick another target.');
  });

  test('a ref that is gone has no closest part', async () => {
    await act(async () => {
      await mountScreen();
    });
    const error = await failure(act(async () => { await press({ target: { ref: 'e999' } }); }));
    expect(error.message).not.toContain('Closest');
  });

  test('the refs given are usable', async () => {
    await act(async () => {
      await mountScreen();
    });
    const error = await failure(act(async () => { await press({ target: { text: 'Savd' } }); }));
    const ref = /Closest: (e\d+) /.exec(error.message)?.[1];
    expect(ref).toBeDefined();
    const second = await failure(act(async () => { await press({ target: { ref: ref ?? '' }, dryRun: true }); }));
    expect(second.message).not.toMatch(/^e\d+ isn't on screen/);
  });
});
