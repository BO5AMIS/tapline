import { frame, mount, unmountAll, useFrames } from './helpers';
import React from 'react';
import { Dimensions, PixelRatio, Pressable, Text, View } from 'react-native';
import { uxCheck } from '../src/actions';
import { resetRefs, setMeasurer } from '../src/inspect';
import { setSourceFetch } from '../src/source';
import {
  BASIS_CHOICES,
  BASIS_THUMB,
  MAX_CHOICES,
  looksLikeMessage,
  sameActionDifferentName,
  uxScreen,
  type UxFinding,
  type UxKind,
} from '../src/uxcheck';

// AGENT-TOOLS 1.12 §17.3: ux_check measurements.

beforeEach(() => {
  resetRefs();
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 400, height: 800, scale: 2, fontScale: 1 });
  jest.spyOn(PixelRatio, 'get').mockReturnValue(2);
  setSourceFetch(async () => {
    throw new Error('no Metro');
  });
});
afterEach(async () => {
  await unmountAll();
  setMeasurer(null);
  setSourceFetch(null);
  jest.restoreAllMocks();
});

const noop = (): void => {};
const FILLED = { backgroundColor: '#0a4cff' };

function ofKind(findings: UxFinding[], kind: UxKind): UxFinding[] {
  return findings.filter((f) => f.kind === kind);
}

function Button({ id, label, filled = false }: { id: string; label: string; filled?: boolean }): React.ReactElement {
  return (
    <Pressable testID={id} accessibilityRole="button" onPress={noop} style={filled ? FILLED : undefined}>
      <Text>{label}</Text>
    </Pressable>
  );
}

describe('competing choices', () => {
  async function screenWith(count: number): Promise<UxFinding[]> {
    const ids = Array.from({ length: count }, (_, i) => `b${i}`);
    await mount(
      <View>
        {ids.map((id) => (
          <Button key={id} id={id} label={`Item ${id}`} />
        ))}
      </View>,
    );
    useFrames(Object.fromEntries(ids.map((id, i) => [id, frame(10, 100 + i * 50, 300, 48)])), null);
    return (await uxScreen()).findings;
  }

  test('exactly the threshold is fine', async () => {
    expect(ofKind(await screenWith(MAX_CHOICES), 'choices')).toEqual([]);
  });

  test('one more is flagged, naming the count and the rule', async () => {
    const [finding] = ofKind(await screenWith(MAX_CHOICES + 1), 'choices');
    expect(finding?.problem).toContain(`${MAX_CHOICES + 1} choices`);
    expect(finding?.basis).toBe(BASIS_CHOICES);
    expect(finding?.basis).toBe("best practice: Hick's law, more than 7 choices");
    expect(finding?.entry).toBeNull();
  });
});

describe('the main action', () => {
  test('one filled button among plain ones is clear', async () => {
    await mount(
      <View>
        <Button id="go" label="Continue" filled />
        <Button id="skip" label="Skip" />
      </View>,
    );
    useFrames({ go: frame(20, 600, 360, 52), skip: frame(20, 670, 100, 44) }, null);
    expect(ofKind((await uxScreen()).findings, 'main_action')).toEqual([]);
  });

  test('two equally filled buttons are flagged by name', async () => {
    await mount(
      <View>
        <Button id="buy" label="Subscribe" filled />
        <Button id="try" label="Try free" filled />
      </View>,
    );
    useFrames({ buy: frame(20, 600, 360, 52), try: frame(20, 670, 360, 52) }, null);
    const [finding] = ofKind((await uxScreen()).findings, 'main_action');
    expect(finding?.problem).toContain('"Subscribe"');
    expect(finding?.problem).toContain('"Try free"');
    expect(finding?.entry).not.toBeNull();
    expect(finding?.basis).toMatch(/^best practice: /);
  });

  test('plain buttons of one size have no clear main action', async () => {
    await mount(
      <View>
        <Button id="a" label="Alpha" />
        <Button id="b" label="Beta" />
      </View>,
    );
    useFrames({ a: frame(20, 600, 160, 48), b: frame(200, 600, 160, 48) }, null);
    const [finding] = ofKind((await uxScreen()).findings, 'main_action');
    expect(finding?.problem).toContain('no action stands out');
    expect(finding?.entry).toBeNull();
  });

  test('a single button is the main action', async () => {
    await mount(<Button id="only" label="Save" />);
    useFrames({ only: frame(20, 600, 160, 48) }, null);
    expect(ofKind((await uxScreen()).findings, 'main_action')).toEqual([]);
  });
});

describe('thumb reach', () => {
  test('a wide filled button in the top third of a tall screen is flagged', async () => {
    await mount(<Button id="top" label="Start" filled />);
    useFrames({ top: frame(20, 80, 360, 52) }, null);
    const [finding] = ofKind((await uxScreen()).findings, 'thumb_reach');
    expect(finding?.basis).toBe(BASIS_THUMB);
    expect(finding?.entry).not.toBeNull();
  });

  test('the same button low on the screen is fine', async () => {
    await mount(<Button id="low" label="Start" filled />);
    useFrames({ low: frame(20, 650, 360, 52) }, null);
    expect(ofKind((await uxScreen()).findings, 'thumb_reach')).toEqual([]);
  });

  test('a plain or narrow button at the top is not primary-looking', async () => {
    await mount(
      <View>
        <Button id="plain" label="Help" />
        <Button id="narrow" label="Go" filled />
      </View>,
    );
    useFrames({ plain: frame(20, 80, 360, 52), narrow: frame(20, 150, 80, 44) }, null);
    expect(ofKind((await uxScreen()).findings, 'thumb_reach')).toEqual([]);
  });

  test('a short screen has no out-of-reach zone', async () => {
    jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 400, height: 600, scale: 2, fontScale: 1 });
    await mount(<Button id="top" label="Start" filled />);
    useFrames({ top: frame(20, 40, 360, 52) }, null);
    expect(ofKind((await uxScreen()).findings, 'thumb_reach')).toEqual([]);
  });
});

describe('icon-only buttons', () => {
  test('a button with no text and no label is flagged; a labelled one is not', async () => {
    await mount(
      <View>
        <Pressable testID="bare" accessibilityRole="button" onPress={noop} />
        <Pressable testID="named" accessibilityRole="button" accessibilityLabel="Close" onPress={noop} />
      </View>,
    );
    useFrames({ bare: frame(10, 100, 48, 48), named: frame(100, 100, 48, 48) }, null);
    const found = ofKind((await uxScreen()).findings, 'icon_only');
    expect(found).toHaveLength(1);
    expect(found[0]?.entry?.info.testID).toBe('bare');
  });
});

describe("audit's findings, measured", () => {
  test('cut-off text, contrast and target size carry the basis measured', async () => {
    await mount(
      <View>
        <Pressable testID="tiny" accessibilityRole="button" accessibilityLabel="Tiny" onPress={noop} />
        <View testID="bg" style={{ backgroundColor: '#ffffff' }}>
          <Text style={{ color: '#cccccc' }}>Faint words</Text>
        </View>
        <Text testID="wide">Runs off</Text>
      </View>,
    );
    useFrames({ tiny: frame(10, 100, 20, 20), 'Faint words': frame(10, 200, 120, 20), wide: frame(300, 300, 150, 20) }, null);
    const { findings } = await uxScreen();
    for (const kind of ['target_size', 'contrast', 'cut_off_text'] as const) {
      const found = ofKind(findings, kind);
      expect(found).toHaveLength(1);
      expect(found[0]?.basis).toBe('measured');
    }
    expect(ofKind(findings, 'target_size')[0]?.problem).toContain('20x20');
  });
});

describe('naming across screens', () => {
  test('is skipped (and not reported as checked) without a journey', async () => {
    await mount(<Button id="s" label="Done" />);
    useFrames({ s: frame(10, 100, 100, 48) }, null);
    const result = await uxScreen();
    expect(result.checked).not.toContain('naming');
    expect(ofKind(result.findings, 'naming')).toEqual([]);
  });

  test('a synonym used earlier is flagged, once', async () => {
    await mount(<Button id="s" label="Done" />);
    useFrames({ s: frame(10, 100, 100, 48) }, null);
    const result = await uxScreen({ earlier: [{ label: 'Save' }, { label: 'Save' }] });
    expect(result.checked).toContain('naming');
    const [finding] = ofKind(result.findings, 'naming');
    expect(finding?.problem).toContain('"Done"');
    expect(finding?.problem).toContain('"Save"');
    expect(ofKind(result.findings, 'naming')).toHaveLength(1);
  });

  test('the same id with another label is flagged; the same label or an unrelated one is not', async () => {
    await mount(
      <View>
        <Button id="submit" label="Next step" />
        <Button id="other" label="Share" />
      </View>,
    );
    useFrames({ submit: frame(10, 100, 100, 48), other: frame(10, 200, 100, 48) }, null);
    const result = await uxScreen({ earlier: [{ label: 'Place order', id: 'submit' }, { label: 'Share' }] });
    expect(ofKind(result.findings, 'naming')).toHaveLength(1);
  });

  test('the screen hands back its named actions for the journey', async () => {
    await mount(<Button id="s" label="Done" />);
    useFrames({ s: frame(10, 100, 100, 48) }, null);
    expect((await uxScreen()).actions).toEqual([{ label: 'Done', id: 's' }]);
  });

  test('synonym table', () => {
    expect(sameActionDifferentName('Log in', 'Sign in')).toBe(true);
    expect(sameActionDifferentName('Save', 'Save')).toBe(false);
    expect(sameActionDifferentName('Save', 'Delete')).toBe(false);
    expect(sameActionDifferentName('Mystery', 'Enigma')).toBe(false);
  });
});

describe('error and empty states', () => {
  test('words that look like an error or an empty message', () => {
    for (const text of ['Something went wrong', 'Upload failed', 'No meals yet', 'Nothing here', 'The list is empty', 'Error 500']) {
      expect(looksLikeMessage(text)).toBe(true);
    }
    for (const text of ['Notes', 'Nobody', 'Welcome back', 'Save']) expect(looksLikeMessage(text)).toBe(false);
  });

  test('a message with nothing to do near it is flagged', async () => {
    await mount(
      <View>
        <Text testID="msg">No meals logged yet</Text>
        <Button id="far" label="Settings" />
      </View>,
    );
    useFrames({ msg: frame(20, 200, 300, 24), far: frame(20, 700, 100, 48) }, null);
    const [finding] = ofKind((await uxScreen()).findings, 'dead_end');
    expect(finding?.entry?.info.text).toBe('No meals logged yet');
    expect(finding?.basis).toMatch(/^best practice: /);
  });

  test('a message with an action close by is fine', async () => {
    await mount(
      <View>
        <Text testID="msg">Upload failed</Text>
        <Button id="retry" label="Try again" />
      </View>,
    );
    useFrames({ msg: frame(20, 200, 300, 24), retry: frame(20, 240, 120, 48) }, null);
    expect(ofKind((await uxScreen()).findings, 'dead_end')).toEqual([]);
  });

  test('a button whose own text says "No thanks" is not an error message', async () => {
    await mount(<Button id="no" label="No thanks" />);
    useFrames({ no: frame(20, 200, 120, 48), 'No thanks': frame(30, 210, 80, 20) }, null);
    expect(ofKind((await uxScreen()).findings, 'dead_end')).toEqual([]);
  });
});

describe('the house rule: a way back', () => {
  test('is only checked when asked', async () => {
    await mount(<Button id="x" label="Next" />);
    useFrames({ x: frame(10, 600, 100, 48) }, null);
    const result = await uxScreen();
    expect(result.checked).not.toContain('way_back');
    expect(ofKind(result.findings, 'way_back')).toEqual([]);
  });

  test('a screen without a back or close control breaks it', async () => {
    await mount(<Button id="x" label="Next" />);
    useFrames({ x: frame(10, 600, 100, 48) }, null);
    const result = await uxScreen({ wayBack: true });
    expect(result.checked).toContain('way_back');
    const [finding] = ofKind(result.findings, 'way_back');
    expect(finding?.basis).toBe('house rule: every screen has a way back');
  });

  test('a visible back button or close control satisfies it', async () => {
    await mount(
      <View>
        <Button id="x" label="Next" />
        <Pressable testID="c" accessibilityRole="button" accessibilityLabel="Close" onPress={noop} />
      </View>,
    );
    useFrames({ x: frame(10, 600, 100, 48), c: frame(340, 50, 48, 48) }, null);
    expect(ofKind((await uxScreen({ wayBack: true })).findings, 'way_back')).toEqual([]);
  });

  test('a back control that is off screen does not count', async () => {
    await mount(
      <View>
        <Button id="x" label="Next" />
        <Button id="b" label="Back" />
      </View>,
    );
    useFrames({ x: frame(10, 600, 100, 48), b: frame(10, 2000, 100, 48) }, null);
    expect(ofKind((await uxScreen({ wayBack: true })).findings, 'way_back')).toHaveLength(1);
  });
});

describe('the method', () => {
  test('answers issues with their basis, the checks run, the choices and the actions', async () => {
    await mount(<Pressable testID="bare" accessibilityRole="button" onPress={noop} />);
    useFrames({ bare: frame(10, 100, 48, 48) }, null);
    const result = await uxCheck({});
    expect(result.issues.map((i) => i.kind)).toEqual(['icon_only']);
    expect(result.issues[0]?.element?.ref).toBeDefined();
    expect(result.issues[0]?.basis).toMatch(/^best practice: /);
    expect(result.choices).toBe(1);
    expect(result.checked).toContain('choices');
  });

  test('passes way_back and earlier on, and refuses malformed ones', async () => {
    await mount(<Button id="s" label="Done" />);
    useFrames({ s: frame(10, 100, 100, 48) }, null);
    const result = await uxCheck({ wayBack: true, earlier: [{ label: 'Save' }] });
    expect(result.issues.map((i) => i.kind).sort()).toEqual(['naming', 'way_back']);
    await expect(uxCheck({ earlier: 'x' })).rejects.toThrow();
    await expect(uxCheck({ earlier: [{ id: 'x' }] })).rejects.toThrow();
    await expect(uxCheck({ wayBack: 'yes' })).rejects.toThrow();
  });
});
