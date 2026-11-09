import { frame, mount, unmountAll, useFrames } from './helpers';
import React from 'react';
import {
  Dimensions,
  PixelRatio,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
  type ColorValue,
} from 'react-native';
import { checkLayout, type Finding, type FindingKind } from '../src/checks';
import { resetRefs, setMeasurer, tree } from '../src/inspect';

beforeEach(() => {
  resetRefs();
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 400, height: 800, scale: 2, fontScale: 1 });
  jest.spyOn(PixelRatio, 'get').mockReturnValue(2);
});

afterEach(async () => {
  await unmountAll();
  setMeasurer(null);
  jest.restoreAllMocks();
});

const noop = (): void => {};

/** Frames for the listed testIDs; anything else is unmeasurable and therefore ignored. */
function frames(known: Record<string, ReturnType<typeof frame>>): void {
  useFrames(known, null);
}

async function run(kind: FindingKind): Promise<Finding[]> {
  const { findings } = await checkLayout({});
  return findings.filter((finding) => finding.kind === kind);
}

describe('small_target', () => {
  test('flags a 30x30 Pressable', async () => {
    await mount(
      <Pressable testID="tiny" onPress={noop}>
        <Text>Go</Text>
      </Pressable>,
    );
    frames({ tiny: frame(10, 10, 30, 30) });
    const found = await run('small_target');
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toBe('tap area 30x30 pt is smaller than 44x44');
    expect(found[0]?.ref).toMatch(/^e\d+$/);
  });

  test('reports the real size when only one side is short', async () => {
    await mount(
      <Pressable testID="wide" onPress={noop}>
        <Text>Go</Text>
      </Pressable>,
    );
    frames({ wide: frame(10, 10, 200, 28.5) });
    const found = await run('small_target');
    expect(found.map((f) => f.message)).toEqual(['tap area 200x28.5 pt is smaller than 44x44']);
  });

  test('accepts 44x44', async () => {
    await mount(
      <Pressable testID="ok" onPress={noop}>
        <Text>Go</Text>
      </Pressable>,
    );
    frames({ ok: frame(10, 10, 44, 44) });
    expect(await run('small_target')).toHaveLength(0);
  });

  test('accepts 30x30 with hitSlop 10', async () => {
    await mount(
      <Pressable testID="slop" hitSlop={10} onPress={noop}>
        <Text>Go</Text>
      </Pressable>,
    );
    frames({ slop: frame(10, 10, 30, 30) });
    expect(await run('small_target')).toHaveLength(0);
  });

  test('uses each side of an object hitSlop', async () => {
    await mount(
      <View>
        <Pressable testID="full" hitSlop={{ top: 7, bottom: 7, left: 7, right: 7 }} onPress={noop}>
          <Text>A</Text>
        </Pressable>
        <Pressable testID="partial" hitSlop={{ top: 2 }} onPress={noop}>
          <Text>B</Text>
        </Pressable>
      </View>,
    );
    frames({ full: frame(10, 10, 30, 30), partial: frame(100, 10, 30, 30) });
    const found = await run('small_target');
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('30x30');
  });

  test('flags a small Switch (toggle) and ignores small non-interactive views', async () => {
    await mount(
      <View>
        <Switch testID="sw" value={false} onValueChange={noop} />
        <View testID="dot" />
      </View>,
    );
    frames({ sw: frame(10, 10, 30, 20), dot: frame(100, 10, 8, 8) });
    const found = await run('small_target');
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toBe('tap area 30x20 pt is smaller than 44x44');
  });

  test('flags a small long-press target', async () => {
    await mount(
      <Pressable testID="long" onLongPress={noop}>
        <Text>Hold</Text>
      </Pressable>,
    );
    frames({ long: frame(10, 10, 40, 40) });
    expect(await run('small_target')).toHaveLength(1);
  });
});

describe('cut_off', () => {
  test('flags an element past the left edge', async () => {
    await mount(<View testID="box" />);
    frames({ box: frame(-20, 100, 100, 40) });
    const found = await run('cut_off');
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toBe('runs 20 pt past the left edge of the screen');
  });

  test('flags an element past the right edge', async () => {
    await mount(<View testID="box" />);
    frames({ box: frame(350, 100, 100, 40) });
    const found = await run('cut_off');
    expect(found.map((f) => f.message)).toEqual(['runs 50 pt past the right edge of the screen']);
  });

  test('accepts full-width, 1 pt of slack and vertical overflow', async () => {
    await mount(
      <View>
        <View testID="full" />
        <View testID="slack" />
        <View testID="low" />
      </View>,
    );
    frames({ full: frame(0, 0, 400, 40), slack: frame(-1, 100, 402, 40), low: frame(10, 750, 100, 100) });
    expect(await run('cut_off')).toHaveLength(0);
  });
});

describe('overlap', () => {
  test('flags two siblings on top of each other, once, in tree order', async () => {
    await mount(
      <View>
        <Pressable testID="a" onPress={noop}>
          <Text>First</Text>
        </Pressable>
        <Pressable testID="b" onPress={noop}>
          <Text>Second</Text>
        </Pressable>
      </View>,
    );
    frames({ a: frame(10, 10, 100, 50), b: frame(20, 20, 100, 50) });
    const { elements } = await tree({});
    const found = await run('overlap');
    expect(found).toHaveLength(1);
    const [first] = found;
    expect(first?.other).toMatch(/^e\d+$/);
    expect(first?.ref).not.toBe(first?.other);

    const refs = elements.filter((e) => e.testID === 'a' || e.testID === 'b').map((e) => e.ref);
    expect([first?.ref, first?.other]).toEqual(refs);
  });

  test('ignores separate, barely touching and nested elements', async () => {
    await mount(
      <View>
        <Pressable testID="a" onPress={noop}>
          <Text>First</Text>
        </Pressable>
        <Pressable testID="far" onPress={noop}>
          <Text>Far</Text>
        </Pressable>
        <Pressable testID="edge" onPress={noop}>
          <Text>Edge</Text>
        </Pressable>
        <View testID="card">
          <Pressable testID="inner" onPress={noop}>
            <Text>Inner</Text>
          </Pressable>
        </View>
      </View>,
    );
    frames({
      a: frame(10, 10, 100, 50),
      far: frame(10, 100, 100, 50),
      // 10 of 100 pt wide overlap: 10% of the smaller frame
      edge: frame(100, 10, 100, 50),
      card: frame(10, 200, 200, 100),
      inner: frame(20, 210, 100, 50),
    });
    expect(await run('overlap')).toHaveLength(0);
  });

  test('ignores scroll views and text inputs', async () => {
    await mount(
      <View>
        <Pressable testID="btn" onPress={noop}>
          <Text>Button</Text>
        </Pressable>
        <TextInput testID="field" defaultValue="hello" />
        <ScrollView testID="scroller">
          <Text>Inside</Text>
        </ScrollView>
      </View>,
    );
    frames({ btn: frame(10, 10, 100, 50), field: frame(10, 10, 100, 50), scroller: frame(0, 0, 400, 800) });
    expect(await run('overlap')).toHaveLength(0);
  });
});

describe('low_contrast', () => {
  function grayOnWhite(color: ColorValue | undefined, background: ColorValue | undefined, extra = {}): React.ReactElement {
    return (
      <View style={background === undefined ? undefined : { backgroundColor: background }}>
        <Text testID="label" style={{ color, ...extra }}>
          Hello
        </Text>
      </View>
    );
  }

  test('flags grey on white', async () => {
    await mount(grayOnWhite('#999999', '#ffffff'));
    frames({ label: frame(10, 10, 100, 20) });
    const found = await run('low_contrast');
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toBe('contrast 2.8:1 is below 4.5:1 (#999999 on #ffffff)');
  });

  test('accepts black on white', async () => {
    await mount(grayOnWhite('#000000', '#ffffff'));
    frames({ label: frame(10, 10, 100, 20) });
    expect(await run('low_contrast')).toHaveLength(0);
  });

  test.each([
    ['#999', '#fff'],
    ['#999f', '#ffff'],
    ['#999999ff', '#ffffffff'],
    ['rgb(153,153,153)', 'rgb(255, 255, 255)'],
    ['rgba(153, 153, 153, 1)', 'rgba(255,255,255,1)'],
    [0xff999999 as unknown as ColorValue, 0xffffffff as unknown as ColorValue],
    ['#999999', 'white'],
  ])('reads the colour %s on %s', async (color, background) => {
    await mount(grayOnWhite(color, background));
    frames({ label: frame(10, 10, 100, 20) });
    const found = await run('low_contrast');
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('#999999 on #ffffff');
  });

  test('knows the named colours', async () => {
    await mount(grayOnWhite('white', 'black'));
    frames({ label: frame(10, 10, 100, 20) });
    expect(await run('low_contrast')).toHaveLength(0);
    await unmountAll();
    await mount(grayOnWhite('gray', 'grey'));
    frames({ label: frame(10, 10, 100, 20) });
    const found = await run('low_contrast');
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('contrast 1:1');
  });

  test('uses the lower threshold for large text', async () => {
    // #888888 on white is 3.5:1
    await mount(grayOnWhite('#888888', '#ffffff', { fontSize: 20 }));
    frames({ label: frame(10, 10, 100, 20) });
    expect(await run('low_contrast')).toHaveLength(0);
    await unmountAll();

    await mount(grayOnWhite('#888888', '#ffffff', { fontSize: 14, fontWeight: 'bold' }));
    frames({ label: frame(10, 10, 100, 20) });
    expect(await run('low_contrast')).toHaveLength(0);
    await unmountAll();

    await mount(grayOnWhite('#888888', '#ffffff', { fontSize: 14, fontWeight: '400' }));
    frames({ label: frame(10, 10, 100, 20) });
    expect(await run('low_contrast')).toHaveLength(1);
    await unmountAll();

    await mount(grayOnWhite('#999999', '#ffffff', { fontSize: 20 }));
    frames({ label: frame(10, 10, 100, 20) });
    const found = await run('low_contrast');
    expect(found.map((f) => f.message)).toEqual(['contrast 2.8:1 is below 3:1 (#999999 on #ffffff)']);
  });

  test('inherits the colour from an enclosing Text', async () => {
    await mount(
      <View style={{ backgroundColor: '#ffffff' }}>
        <Text testID="outer" style={{ color: '#999999' }}>
          <Text testID="inner">nested</Text>
        </Text>
      </View>,
    );
    frames({ inner: frame(10, 10, 100, 20) });
    const found = await run('low_contrast');
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('#999999 on #ffffff');
  });

  test('uses the nearest opaque background above', async () => {
    await mount(
      <View style={{ backgroundColor: '#000000' }}>
        <View style={{ backgroundColor: '#ffffff' }}>
          <View>
            <Text testID="label" style={{ color: '#999999' }}>
              Hello
            </Text>
          </View>
        </View>
      </View>,
    );
    frames({ label: frame(10, 10, 100, 20) });
    expect((await run('low_contrast'))[0]?.message).toContain('on #ffffff');
  });

  test('skips what it cannot know: no colour, no background, translucent, platform colours', async () => {
    const platform = { semantic: ['label'] } as unknown as ColorValue;
    await mount(grayOnWhite(undefined, '#ffffff'));
    frames({ label: frame(10, 10, 100, 20) });
    expect(await run('low_contrast')).toHaveLength(0);
    await unmountAll();

    await mount(grayOnWhite('#999999', undefined));
    frames({ label: frame(10, 10, 100, 20) });
    expect(await run('low_contrast')).toHaveLength(0);
    await unmountAll();

    await mount(grayOnWhite('#999999', 'rgba(255,255,255,0.5)'));
    frames({ label: frame(10, 10, 100, 20) });
    expect(await run('low_contrast')).toHaveLength(0);
    await unmountAll();

    await mount(grayOnWhite('#999999', 'transparent'));
    frames({ label: frame(10, 10, 100, 20) });
    expect(await run('low_contrast')).toHaveLength(0);
    await unmountAll();

    await mount(grayOnWhite(platform, '#ffffff'));
    frames({ label: frame(10, 10, 100, 20) });
    expect(await run('low_contrast')).toHaveLength(0);
    await unmountAll();

    await mount(grayOnWhite('#999999', platform));
    frames({ label: frame(10, 10, 100, 20) });
    expect(await run('low_contrast')).toHaveLength(0);
    await unmountAll();

    await mount(grayOnWhite('chartreuse-ish', '#ffffff'));
    frames({ label: frame(10, 10, 100, 20) });
    expect(await run('low_contrast')).toHaveLength(0);
  });
});

describe('no_name', () => {
  test('flags a pressable with neither text nor label, testID does not count', async () => {
    await mount(
      <Pressable testID="icon" onPress={noop}>
        <View />
      </Pressable>,
    );
    frames({ icon: frame(10, 10, 44, 44) });
    const found = await run('no_name');
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toBe('button has no text or accessibility label; VoiceOver would read nothing');
  });

  test('accepts text, accessibilityLabel and aria-label', async () => {
    await mount(
      <View>
        <Pressable testID="t" onPress={noop}>
          <Text>Save</Text>
        </Pressable>
        <Pressable testID="l" accessibilityLabel="Close" onPress={noop}>
          <View />
        </Pressable>
        <Pressable testID="a" aria-label="Back" onPress={noop}>
          <View />
        </Pressable>
      </View>,
    );
    frames({ t: frame(10, 10, 44, 44), l: frame(100, 10, 44, 44), a: frame(200, 10, 44, 44) });
    expect(await run('no_name')).toHaveLength(0);
  });

  test('ignores views without a press handler', async () => {
    await mount(<View testID="plain" />);
    frames({ plain: frame(10, 10, 44, 44) });
    expect(await run('no_name')).toHaveLength(0);
  });
});

describe('maybe_truncated', () => {
  const sentence = 'x'.repeat(40); // about 280 pt at 14 pt

  test('flags text that cannot fit its numberOfLines', async () => {
    await mount(
      <Text testID="t" numberOfLines={1}>
        {sentence}
      </Text>,
    );
    frames({ t: frame(10, 10, 100, 20) });
    const found = await run('maybe_truncated');
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('may be cut off');
  });

  test('accepts text that fits', async () => {
    await mount(
      <View>
        <Text testID="wide" numberOfLines={1}>
          {sentence}
        </Text>
        <Text testID="lines" numberOfLines={3}>
          {sentence}
        </Text>
        <Text testID="free">{sentence}</Text>
      </View>,
    );
    frames({ wide: frame(10, 10, 300, 20), lines: frame(10, 40, 100, 60), free: frame(10, 120, 100, 20) });
    expect(await run('maybe_truncated')).toHaveLength(0);
  });

  test('takes the font size into account', async () => {
    await mount(
      <Text testID="t" numberOfLines={3} style={{ fontSize: 20 }}>
        {sentence}
      </Text>,
    );
    frames({ t: frame(10, 10, 100, 60) });
    expect(await run('maybe_truncated')).toHaveLength(1);
  });
});

describe('checkLayout', () => {
  test('finds nothing wrong on a tidy screen', async () => {
    await mount(
      <View>
        <Pressable testID="ok" onPress={noop}>
          <Text>Fine</Text>
        </Pressable>
        <Text testID="title" style={{ color: '#000000' }}>
          Title
        </Text>
      </View>,
    );
    frames({ ok: frame(10, 10, 100, 48), title: frame(10, 100, 100, 20) });
    expect(await checkLayout()).toEqual({ findings: [] });
  });

  test('ignores unmeasurable and off-screen elements', async () => {
    await mount(
      <View>
        <Pressable testID="gone" onPress={noop}>
          <Text>Gone</Text>
        </Pressable>
        <Pressable testID="below" onPress={noop}>
          <Text>Below</Text>
        </Pressable>
        <Pressable testID="empty" onPress={noop}>
          <Text>Empty</Text>
        </Pressable>
      </View>,
    );
    frames({ below: frame(10, 900, 20, 20), empty: frame(10, 10, 0, 0) });
    expect((await checkLayout()).findings).toEqual([]);
  });

  test('refs match those of a preceding tree call', async () => {
    await mount(
      <View>
        <Text>Heading</Text>
        <Pressable testID="ok" onPress={noop}>
          <Text>Fine</Text>
        </Pressable>
        <Pressable testID="tiny" onPress={noop}>
          <Text>Tiny</Text>
        </Pressable>
        <View testID="spill" />
      </View>,
    );
    frames({
      Heading: frame(10, 5, 100, 20),
      ok: frame(10, 40, 100, 48),
      tiny: frame(10, 100, 30, 30),
      spill: frame(-10, 200, 100, 40),
    });
    const { elements } = await tree({});
    const refOf = (testID: string): string | undefined => elements.find((e) => e.testID === testID)?.ref;

    const { findings } = await checkLayout({});
    const small = findings.find((f) => f.kind === 'small_target');
    const cut = findings.find((f) => f.kind === 'cut_off');
    expect(small?.ref).toBe(refOf('tiny'));
    expect(cut?.ref).toBe(refOf('spill'));
    expect(small?.ref).not.toBe(cut?.ref);

    // a second call keeps the same refs, and the tree's refs are untouched
    const again = await checkLayout();
    expect(again.findings.map((f) => f.ref)).toEqual(findings.map((f) => f.ref));
    expect((await tree({})).elements.map((e) => e.ref)).toEqual(elements.map((e) => e.ref));
  });

  test('sorts findings by tree order', async () => {
    await mount(
      <View>
        <View testID="spill" />
        <Pressable testID="tiny" onPress={noop}>
          <Text>Tiny</Text>
        </Pressable>
      </View>,
    );
    frames({ spill: frame(-10, 200, 100, 40), tiny: frame(10, 100, 30, 30) });
    const { elements } = await tree({});
    const order = elements.map((e) => e.ref);
    const { findings } = await checkLayout();
    const positions = findings.map((f) => order.indexOf(f.ref));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(findings.map((f) => f.kind)).toEqual(['cut_off', 'small_target']);
  });
});
